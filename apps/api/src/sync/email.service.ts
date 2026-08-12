import { BadRequestException, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import { PrismaService } from '../prisma/prisma.service';
import { CredentialStore } from '../connectors/credential-store.service';
import { rankOf, type AlertSeverity } from './alerts.service';

/**
 * Emails alerts to the operator.
 *
 * ## What gets a message, and what never does
 *
 * A **new** alert at or above the configured severity threshold, and a flag
 * whose severity **escalates** while open. A flag being refreshed at the same
 * severity — occurrence forty-seven of the same unmapped listing — is
 * deliberately silent: an inbox that gets a copy of every occurrence trains
 * its owner to filter the sender, which is the alerting failure mode this
 * codebase keeps writing down. Resolutions are silent too; the email's job is
 * "go look", not to mirror the inbox state machine. (Syslog ships everything,
 * by design — dedup is a log collector's job, and an email inbox is not one.)
 *
 * ## Never in the way
 *
 * Fire-and-forget, exactly like `SyslogService`: SMTP being down must not
 * fail the alert write it describes. Failures are logged locally, throttled.
 *
 * ## Settings
 *
 * Stored under `notify.email.*` in the `Setting` table; the SMTP password
 * lives in the encrypted `CredentialStore` under its own ref, the same
 * arrangement the OIDC client secret uses — it is never returned by the API.
 */

const PREFIX = 'notify.email.';
const REFRESH_MS = 10_000;
const WARN_INTERVAL_MS = 60_000;

/** Where the SMTP password lives, beside `auth:oidc` and `catalog:*`. */
export const EMAIL_CREDENTIAL_REF = 'notify:email';

/** Injection token for the transport factory, so tests can capture mail. */
export const MAIL_TRANSPORT_FACTORY = 'MAIL_TRANSPORT_FACTORY';

export type MailTransportFactory = (options: {
  host: string;
  port: number;
  secure: boolean;
  auth?: { user: string; pass: string };
}) => Pick<Transporter, 'sendMail'>;

export interface EmailSettings {
  enabled: boolean;
  host: string;
  port: number;
  /** Implicit TLS (usually 465). Off means STARTTLS is attempted on 587/25. */
  secure: boolean;
  username: string;
  from: string;
  /** Comma-separated recipients. */
  to: string;
  /** Least-urgent severity that still emails. */
  threshold: AlertSeverity;
}

export interface EmailSettingsView extends EmailSettings {
  /** Whether a password is stored — never the password. */
  passwordSet: boolean;
}

export interface EmailSettingsPatch {
  enabled?: boolean;
  host?: string;
  port?: number;
  secure?: boolean;
  username?: string;
  /** Omit to keep the stored one; empty string clears it. */
  password?: string;
  from?: string;
  to?: string;
  threshold?: AlertSeverity;
}

const DEFAULTS: EmailSettings = {
  enabled: false,
  host: '',
  port: 587,
  secure: false,
  username: '',
  from: '',
  to: '',
  threshold: 'warning',
};

const THRESHOLDS: readonly AlertSeverity[] = ['critical', 'warning', 'info'];

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  private settings: EmailSettings = { ...DEFAULTS };
  private password = '';
  private loadedAt = 0;
  private lastWarnAt = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly credentials: CredentialStore,
    @Optional()
    @Inject(MAIL_TRANSPORT_FACTORY)
    private readonly transportFactory?: MailTransportFactory,
  ) {}

  /** The stored settings, password omitted, for the admin form. */
  async view(): Promise<EmailSettingsView> {
    await this.load(true);
    return { ...this.settings, passwordSet: this.password !== '' };
  }

  async update(patch: EmailSettingsPatch): Promise<EmailSettingsView> {
    await this.load(true);
    const next: EmailSettings = { ...this.settings };

    if (patch.enabled !== undefined) next.enabled = patch.enabled;
    if (patch.host !== undefined) next.host = patch.host.trim();
    if (patch.port !== undefined) {
      if (!Number.isInteger(patch.port) || patch.port < 1 || patch.port > 65535) {
        throw new BadRequestException('Port must be between 1 and 65535.');
      }
      next.port = patch.port;
    }
    if (patch.secure !== undefined) next.secure = patch.secure;
    if (patch.username !== undefined) next.username = patch.username.trim();
    if (patch.from !== undefined) next.from = patch.from.trim();
    if (patch.to !== undefined) next.to = patch.to.trim();
    if (patch.threshold !== undefined) {
      if (!THRESHOLDS.includes(patch.threshold)) {
        throw new BadRequestException('Threshold must be critical, warning or info.');
      }
      next.threshold = patch.threshold;
    }

    if (next.enabled && (next.host === '' || next.from === '' || next.to === '')) {
      throw new BadRequestException(
        'A server, a from address and at least one recipient are required to enable email.',
      );
    }

    for (const [field, value] of Object.entries({
      enabled: String(next.enabled),
      host: next.host,
      port: String(next.port),
      secure: String(next.secure),
      username: next.username,
      from: next.from,
      to: next.to,
      threshold: next.threshold,
    })) {
      await this.prisma.setting.upsert({
        where: { key: PREFIX + field },
        create: { key: PREFIX + field, value },
        update: { value },
      });
    }

    if (patch.password !== undefined) {
      if (patch.password === '') {
        await this.credentials.delete(EMAIL_CREDENTIAL_REF);
        this.password = '';
      } else {
        await this.credentials.put(EMAIL_CREDENTIAL_REF, { password: patch.password });
        this.password = patch.password;
      }
    }

    this.settings = next;
    this.loadedAt = Date.now();
    return { ...next, passwordSet: this.password !== '' };
  }

  /** Send one test message with the saved settings and report what SMTP said. */
  async test(): Promise<{ ok: boolean; detail: string }> {
    await this.load(true);
    if (!this.settings.host || !this.settings.from || !this.settings.to) {
      return { ok: false, detail: 'Server, from address and recipient are all required first.' };
    }
    try {
      await this.send(
        '[Inventory Hub] Test message',
        'This is a test from the hub’s email alerting. If you are reading it, delivery works.',
      );
      return { ok: true, detail: `Accepted by ${this.settings.host} for ${this.settings.to}.` };
    } catch (error) {
      return { ok: false, detail: `Delivery failed: ${(error as Error).message}` };
    }
  }

  /**
   * A new alert was raised, or an open flag escalated. Fire-and-forget; the
   * caller must never wait on SMTP.
   */
  notifyAlert(input: {
    severity: string;
    kind: string;
    title: string;
    detail?: string | null;
    channelInstanceId?: string | null;
    escalatedFrom?: string;
  }): void {
    void this.load(false)
      .then(async () => {
        const { enabled, threshold } = this.settings;
        if (!enabled) return;
        // rankOf ascends by urgency (critical 0), so "at or above threshold"
        // is a <= on ranks.
        if (rankOf(input.severity) > rankOf(threshold)) return;

        // Resolved here rather than passed in, so the one caller that has a
        // name and the three that do not need not each solve it.
        const channelName = input.channelInstanceId
          ? (
              await this.prisma.channelInstance.findUnique({
                where: { id: input.channelInstanceId },
                select: { displayName: true },
              })
            )?.displayName
          : undefined;

        const subject =
          `[Inventory Hub] ${input.severity.toUpperCase()}: ${input.title}` +
          (input.escalatedFrom ? ` (was ${input.escalatedFrom})` : '');
        const lines = [
          input.title,
          '',
          ...(input.detail ? [input.detail, ''] : []),
          `Kind: ${input.kind.replace(/_/g, ' ')}`,
          ...(channelName ? [`Channel: ${channelName}`] : []),
          '',
          'Open the hub’s Activity page for the full inbox.',
        ];
        return this.send(subject, lines.join('\n'));
      })
      .catch((error: Error) => {
        this.warnThrottled(`Alert email failed: ${error.message}`);
      });
  }

  // -------------------------------------------------------------------------

  private async send(subject: string, text: string): Promise<void> {
    const { host, port, secure, username, from, to } = this.settings;
    const factory: MailTransportFactory = this.transportFactory ?? createTransport;
    const transporter = factory({
      host,
      port,
      secure,
      ...(username !== '' ? { auth: { user: username, pass: this.password } } : {}),
    });
    await transporter.sendMail({ from, to, subject, text });
  }

  private async load(force: boolean): Promise<void> {
    if (!force && Date.now() - this.loadedAt < REFRESH_MS) return;

    const rows = await this.prisma.setting.findMany({
      where: { key: { startsWith: PREFIX } },
    });
    const byField = new Map(rows.map((row) => [row.key.slice(PREFIX.length), row.value]));

    const port = Number(byField.get('port'));
    const threshold = byField.get('threshold') as AlertSeverity | undefined;
    this.settings = {
      enabled: byField.get('enabled') === 'true',
      host: byField.get('host') ?? DEFAULTS.host,
      port: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : DEFAULTS.port,
      secure: byField.get('secure') === 'true',
      username: byField.get('username') ?? DEFAULTS.username,
      from: byField.get('from') ?? DEFAULTS.from,
      to: byField.get('to') ?? DEFAULTS.to,
      threshold: threshold && THRESHOLDS.includes(threshold) ? threshold : DEFAULTS.threshold,
    };

    const bundle = (await this.credentials.has(EMAIL_CREDENTIAL_REF))
      ? await this.credentials.get(EMAIL_CREDENTIAL_REF)
      : {};
    this.password = typeof bundle.password === 'string' ? bundle.password : '';

    this.loadedAt = Date.now();
  }

  private warnThrottled(message: string): void {
    const now = Date.now();
    if (now - this.lastWarnAt < WARN_INTERVAL_MS) return;
    this.lastWarnAt = now;
    this.logger.warn(message);
  }
}
