import { hostname } from 'node:os';
import * as dgram from 'node:dgram';
import * as net from 'node:net';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  formatSyslog,
  frameTcp,
  severityForAlert,
  severityForOutcome,
  type SyslogSeverity,
} from './syslog-format';

/**
 * Ships alerts and sync activity to a remote syslog collector.
 *
 * ## What it is, and is not
 *
 * This forwards the Activity page's content — structured events, as JSON in
 * RFC 5424 messages — so an operator's log pipeline sees what the inbox sees.
 * It is **not** an application log shipper: container stdout already has a
 * zero-code path to syslog through Docker's own logging driver, and
 * duplicating that here would be a second copy of every line.
 *
 * ## Never in the way
 *
 * Every emission is fire-and-forget. A collector being down must not fail the
 * alert or the sync write it describes — the same rule `SyncEventService`
 * applies to its own audit writes. UDP cannot fail visibly at all; TCP
 * failures are logged locally at most once a minute, so a dead collector does
 * not turn the hub's own log into a flood.
 *
 * ## Settings
 *
 * Stored in the `Setting` table under `notify.syslog.*` (the
 * `AuthSettingsService` precedent), cached with the same short TTL and
 * refreshed on write. No secrets are involved, so nothing touches the
 * credential store.
 */

const PREFIX = 'notify.syslog.';
const REFRESH_MS = 10_000;
/** How often a TCP delivery failure is worth a local log line. */
const WARN_INTERVAL_MS = 60_000;
const TCP_TIMEOUT_MS = 3_000;

export interface SyslogSettings {
  enabled: boolean;
  host: string;
  port: number;
  protocol: 'udp' | 'tcp';
}

export interface SyslogSettingsPatch {
  enabled?: boolean;
  host?: string;
  port?: number;
  protocol?: 'udp' | 'tcp';
}

const DEFAULTS: SyslogSettings = { enabled: false, host: '', port: 514, protocol: 'udp' };

@Injectable()
export class SyslogService {
  private readonly logger = new Logger(SyslogService.name);

  private settings: SyslogSettings = { ...DEFAULTS };
  private loadedAt = 0;
  private lastWarnAt = 0;
  private udpSocket?: dgram.Socket;

  constructor(private readonly prisma: PrismaService) {}

  /** The stored settings, for the admin form. Nothing here is secret. */
  async view(): Promise<SyslogSettings> {
    await this.load(true);
    return { ...this.settings };
  }

  async update(patch: SyslogSettingsPatch): Promise<SyslogSettings> {
    await this.load(true);
    const next: SyslogSettings = { ...this.settings };

    if (patch.enabled !== undefined) next.enabled = patch.enabled;
    if (patch.host !== undefined) next.host = patch.host.trim();
    if (patch.port !== undefined) {
      if (!Number.isInteger(patch.port) || patch.port < 1 || patch.port > 65535) {
        throw new BadRequestException('Port must be between 1 and 65535.');
      }
      next.port = patch.port;
    }
    if (patch.protocol !== undefined) next.protocol = patch.protocol;

    if (next.enabled && next.host === '') {
      throw new BadRequestException('A collector address is required to enable syslog.');
    }

    for (const [field, value] of Object.entries({
      enabled: String(next.enabled),
      host: next.host,
      port: String(next.port),
      protocol: next.protocol,
    })) {
      await this.prisma.setting.upsert({
        where: { key: PREFIX + field },
        create: { key: PREFIX + field, value },
        update: { value },
      });
    }

    this.settings = next;
    this.loadedAt = Date.now();
    return { ...next };
  }

  /**
   * Send one test message and report delivery honestly: TCP proves the
   * collector accepted a connection; UDP is connectionless, so "sent" is all
   * a datagram can ever truthfully claim.
   */
  async test(): Promise<{ ok: boolean; detail: string }> {
    await this.load(true);
    const { host, port, protocol } = this.settings;
    if (!host) return { ok: false, detail: 'No collector address is configured.' };

    const line = formatSyslog({
      severity: 'notice',
      timestamp: new Date(),
      hostname: hostname(),
      msgId: 'test',
      message: JSON.stringify({ event: 'test', detail: 'Inventory hub syslog test message.' }),
    });

    if (protocol === 'tcp') {
      try {
        await this.sendTcp(line, host, port);
        return { ok: true, detail: `Delivered over TCP to ${host}:${port}.` };
      } catch (error) {
        return { ok: false, detail: `TCP delivery failed: ${(error as Error).message}` };
      }
    }

    this.sendUdp(line, host, port);
    return {
      ok: true,
      detail: `Datagram sent to ${host}:${port}. UDP cannot confirm receipt — check the collector.`,
    };
  }

  /** An alert was raised, refreshed or resolved. Fire-and-forget. */
  emitAlert(input: {
    event: 'raised' | 'refreshed' | 'resolved';
    kind: string;
    severity: string;
    title: string;
    detail?: string | null;
    channelInstanceId?: string | null;
    occurrences?: number;
  }): void {
    const severity: SyslogSeverity =
      input.event === 'resolved' ? 'notice' : severityForAlert(input.severity);
    this.emit('alert', severity, {
      event: input.event,
      kind: input.kind,
      severity: input.severity,
      title: input.title,
      ...(input.detail ? { detail: input.detail } : {}),
      ...(input.channelInstanceId ? { channelInstanceId: input.channelInstanceId } : {}),
      ...(input.occurrences !== undefined ? { occurrences: input.occurrences } : {}),
    });
  }

  /** A sync attempt completed. Fire-and-forget. */
  emitSyncEvent(row: {
    direction: string;
    entityType: string;
    entityId: string | null;
    operation: string | null;
    outcome: string;
    detail: string | null;
    channelInstanceId: string | null;
    durationMs: number | null;
  }): void {
    this.emit('sync', severityForOutcome(row.outcome), {
      direction: row.direction,
      entityType: row.entityType,
      ...(row.entityId ? { entityId: row.entityId } : {}),
      ...(row.operation ? { operation: row.operation } : {}),
      outcome: row.outcome,
      ...(row.detail ? { detail: row.detail } : {}),
      ...(row.channelInstanceId ? { channelInstanceId: row.channelInstanceId } : {}),
      ...(row.durationMs !== null ? { durationMs: row.durationMs } : {}),
    });
  }

  // -------------------------------------------------------------------------

  private emit(msgId: string, severity: SyslogSeverity, body: Record<string, unknown>): void {
    // Deliberately not awaited by callers: shipping a copy of an event must
    // never delay or fail the event itself.
    void this.load(false)
      .then(() => {
        const { enabled, host, port, protocol } = this.settings;
        if (!enabled || !host) return;

        const line = formatSyslog({
          severity,
          timestamp: new Date(),
          hostname: hostname(),
          msgId,
          message: JSON.stringify(body),
        });

        if (protocol === 'tcp') {
          return this.sendTcp(line, host, port).catch((error: Error) => {
            this.warnThrottled(`Syslog TCP delivery to ${host}:${port} failed: ${error.message}`);
          });
        }
        this.sendUdp(line, host, port);
      })
      .catch((error: Error) => {
        this.warnThrottled(`Syslog emission failed: ${error.message}`);
      });
  }

  private sendUdp(line: string, host: string, port: number): void {
    if (!this.udpSocket) {
      this.udpSocket = dgram.createSocket('udp4');
      // A background socket must not hold the process open on shutdown.
      this.udpSocket.unref();
      this.udpSocket.on('error', (error) => {
        this.warnThrottled(`Syslog UDP socket error: ${error.message}`);
      });
    }
    this.udpSocket.send(Buffer.from(line, 'utf8'), port, host, (error) => {
      if (error) this.warnThrottled(`Syslog UDP send to ${host}:${port} failed: ${error.message}`);
    });
  }

  private sendTcp(line: string, host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host, port, timeout: TCP_TIMEOUT_MS });
      socket.unref();
      socket.on('connect', () => {
        socket.end(frameTcp(line), 'utf8', () => resolve());
      });
      socket.on('timeout', () => {
        socket.destroy();
        reject(new Error('connection timed out'));
      });
      socket.on('error', (error) => {
        socket.destroy();
        reject(error);
      });
    });
  }

  private async load(force: boolean): Promise<void> {
    if (!force && Date.now() - this.loadedAt < REFRESH_MS) return;

    const rows = await this.prisma.setting.findMany({
      where: { key: { startsWith: PREFIX } },
    });
    const byField = new Map(rows.map((row) => [row.key.slice(PREFIX.length), row.value]));

    const port = Number(byField.get('port'));
    this.settings = {
      enabled: byField.get('enabled') === 'true',
      host: byField.get('host') ?? DEFAULTS.host,
      port: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : DEFAULTS.port,
      protocol: byField.get('protocol') === 'tcp' ? 'tcp' : 'udp',
    };
    this.loadedAt = Date.now();
  }

  private warnThrottled(message: string): void {
    const now = Date.now();
    if (now - this.lastWarnAt < WARN_INTERVAL_MS) return;
    this.lastWarnAt = now;
    this.logger.warn(message);
  }
}
