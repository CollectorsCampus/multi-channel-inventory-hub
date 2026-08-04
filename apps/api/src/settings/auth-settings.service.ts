import { Injectable, Logger, Optional, type OnModuleInit } from '@nestjs/common';
import type { UserRole } from '@hub/db';
import { PrismaService } from '../prisma/prisma.service';
import { CredentialStore } from '../connectors/credential-store.service';
import { declaredEnv } from '../config/env';

/**
 * OIDC configuration that can be set after first-run, from the browser.
 *
 * ## Why this exists, given the settings screen was deliberately read-only
 *
 * It was, and the reasoning still holds where it applied: values read from the
 * environment at boot must not be presented in a form, because the form would
 * either lie about what is in effect or imply a restart nobody expects.
 *
 * What that argument does *not* justify is having no way to configure SSO at
 * all short of editing a compose file and recreating the container. This
 * software is installed by the person who runs it, usually from a published
 * image, and "add an identity provider" is a thing they do once, after the
 * first local admin exists — precisely when they are least likely to be holding
 * a shell.
 *
 * So the resolution keeps the original property rather than discarding it:
 * **the environment still wins, and a field it sets is shown locked.** The form
 * can therefore never lie — what it renders editable is what it actually
 * controls — and a deployment that pins OIDC in compose, Kubernetes secrets or
 * any other declarative place keeps behaving exactly as it does today. Only the
 * fields nobody has declared become editable.
 *
 * ## Why a cached snapshot rather than reading per call
 *
 * `AuthProvider.supportsDirectLogin` is a synchronous property on the seam in
 * `auth-provider.interface.ts`, and that seam is deliberately stable — making
 * it async to accommodate a database read would push `await` into the guard and
 * the status endpoint for the sake of a value that changes about once in the
 * life of an instance.
 *
 * So the stored half is loaded at boot, refreshed on write, and re-read on a
 * short TTL. The staleness that buys is bounded by {@link REFRESH_MS} and only
 * matters to a multi-replica deployment, where one replica may keep the old
 * configuration for a few seconds after another writes it. Sessions already
 * issued are unaffected either way, because the guard resolves them from the
 * database rather than from this.
 */

/** How long a loaded snapshot is trusted before the database is re-read. */
export const REFRESH_MS = 10_000;

/** `Setting.key` prefix. Namespaced so nothing else collides with it. */
const PREFIX = 'auth.oidc.';

/** Where the client secret lives, in the same encrypted store channels use. */
export const OIDC_CREDENTIAL_REF = 'auth:oidc';

/**
 * Editable fields, and the environment variable that overrides each.
 *
 * The pairing is the whole contract: one place says which variable owns which
 * field, so "is this locked" and "what is its value" cannot disagree.
 */
export const OIDC_FIELDS = {
  enabled: 'AUTH_PROVIDER',
  issuer: 'OIDC_ISSUER_URL',
  clientId: 'OIDC_CLIENT_ID',
  clientSecret: 'OIDC_CLIENT_SECRET',
  scopes: 'OIDC_SCOPES',
  roleClaim: 'OIDC_ROLE_CLAIM',
  roleMap: 'OIDC_ROLE_MAP',
  defaultRole: 'OIDC_DEFAULT_ROLE',
  allowLocalLogin: 'OIDC_ALLOW_LOCAL_LOGIN',
  allowedEndpointOrigins: 'OIDC_ALLOWED_ENDPOINT_ORIGINS',
} as const;

export type OidcField = keyof typeof OIDC_FIELDS;

export const OIDC_FIELD_NAMES = Object.keys(OIDC_FIELDS) as OidcField[];

/** What a caller may write. Every field optional; absent means "leave alone". */
export interface OidcSettingsPatch {
  enabled?: boolean;
  issuer?: string;
  clientId?: string;
  /** Empty string clears the stored secret. Never read back out. */
  clientSecret?: string;
  scopes?: string;
  roleClaim?: string;
  roleMap?: string;
  defaultRole?: UserRole;
  allowLocalLogin?: boolean;
  allowedEndpointOrigins?: string;
}

/** The merged answer: what is actually in effect right now. */
export interface EffectiveOidcSettings {
  enabled: boolean;
  issuer: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  roleClaim: string;
  roleMap: string;
  defaultRole: UserRole;
  allowLocalLogin: boolean;
  allowedEndpointOrigins: string;
}

/** One field as the settings screen needs to render it. */
export interface OidcFieldView {
  /** Never populated for `clientSecret` — see {@link OidcSettingsView}. */
  value: string;
  /** True when an environment variable owns it, so the input is disabled. */
  managedByEnv: boolean;
}

export interface OidcSettingsView {
  fields: Record<OidcField, OidcFieldView>;
  /**
   * Whether a client secret is stored, never the secret itself.
   *
   * The same shape `ChannelSummary.secretsSet` uses, and for the same reason: a
   * form has to be able to say "already set, leave blank to keep" without the
   * value ever travelling back to a browser.
   */
  clientSecretSet: boolean;
  /** Derived, so the operator can copy it into the provider's registration. */
  redirectUri: string;
}

const DEFAULTS: EffectiveOidcSettings = {
  enabled: false,
  issuer: '',
  clientId: '',
  clientSecret: '',
  scopes: 'openid profile email',
  roleClaim: '',
  roleMap: '',
  defaultRole: 'viewer',
  allowLocalLogin: true,
  allowedEndpointOrigins: '',
};

@Injectable()
export class AuthSettingsService implements OnModuleInit {
  private readonly logger = new Logger(AuthSettingsService.name);

  /** The stored half only. The environment is read live, since it cannot change. */
  private stored: Partial<Record<OidcField, string>> = {};
  private storedSecret = '';
  private loadedAt = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly credentials: CredentialStore,
    /**
     * What the operator declared, injectable so a test can supply one.
     *
     * **Not `process.env`**, and that distinction is the whole feature: NestJS
     * writes the validated configuration — schema defaults included — back onto
     * `process.env`, so reading it would report `AUTH_PROVIDER`, `OIDC_SCOPES`,
     * `OIDC_DEFAULT_ROLE` and `OIDC_ALLOW_LOCAL_LOGIN` as declared on an
     * instance that declared none of them, and lock four fields of the form for
     * no reason. `declaredEnv()` is captured before defaults are applied.
     *
     * `@Optional()` for the reason `OidcService.doFetch` documents: NestJS
     * resolves constructor parameters from `design:paramtypes` at runtime, and
     * a default value alone does not stop it looking for a provider.
     */
    @Optional() private readonly env: Record<string, string | undefined> = declaredEnv(),
  ) {}

  async onModuleInit(): Promise<void> {
    // A failure here must not stop the container: OIDC may not be configured at
    // all, and refusing to boot over an unreadable optional setting would take
    // down an instance whose operator logs in with a password.
    try {
      await this.reload();
    } catch (error) {
      this.logger.warn(`Could not load stored auth settings: ${(error as Error).message}`);
    }
  }

  /**
   * Which environment variable, if any, owns a field.
   *
   * Read from the *declared* environment rather than `ConfigService` or
   * `process.env`, both of which have had schema defaults folded into them by
   * the time anything asks. "Locked" has to mean "the operator declared it".
   */
  private envValue(field: OidcField): string | undefined {
    const raw = this.env[OIDC_FIELDS[field]];
    // Coerced because an injected environment may carry real booleans, where
    // `process.env` only ever holds strings. Blank counts as unset: an empty
    // variable is how compose expresses "not provided", and treating it as a
    // declaration would lock a field to nothing.
    if (raw === undefined || raw === null || raw === '') return undefined;
    return String(raw);
  }

  managedByEnv(field: OidcField): boolean {
    return this.envValue(field) !== undefined;
  }

  private async reload(): Promise<void> {
    const rows = await this.prisma.setting.findMany({
      where: { key: { startsWith: PREFIX } },
      select: { key: true, value: true },
    });

    const stored: Partial<Record<OidcField, string>> = {};
    for (const row of rows) {
      const field = row.key.slice(PREFIX.length) as OidcField;
      if (OIDC_FIELD_NAMES.includes(field)) stored[field] = row.value;
    }
    this.stored = stored;

    const bundle = (await this.credentials.has(OIDC_CREDENTIAL_REF))
      ? await this.credentials.get(OIDC_CREDENTIAL_REF)
      : {};
    this.storedSecret = typeof bundle.clientSecret === 'string' ? bundle.clientSecret : '';

    this.loadedAt = Date.now();
  }

  /** Re-read if the snapshot has aged out. Fire-and-forget by design. */
  private refreshIfStale(): void {
    if (Date.now() - this.loadedAt < REFRESH_MS) return;
    // Marked before awaiting so a burst of calls queues one read, not many.
    this.loadedAt = Date.now();
    void this.reload().catch((error) =>
      this.logger.warn(`Could not refresh auth settings: ${(error as Error).message}`),
    );
  }

  /** Force a read, for callers that must not act on a stale snapshot. */
  async reloadNow(): Promise<void> {
    await this.reload();
  }

  private raw(field: OidcField): string | undefined {
    return this.envValue(field) ?? this.stored[field];
  }

  /** What is in effect. Environment first, then stored, then the default. */
  effective(): EffectiveOidcSettings {
    this.refreshIfStale();

    const text = (field: OidcField, fallback: string): string => this.raw(field) ?? fallback;
    const flag = (field: OidcField, fallback: boolean): boolean => {
      const value = this.raw(field);
      return value === undefined ? fallback : value === 'true';
    };

    return {
      // `AUTH_PROVIDER` is not a boolean, so it is the one field whose env form
      // differs from its stored form.
      enabled:
        this.envValue('enabled') !== undefined
          ? this.envValue('enabled') === 'oidc'
          : this.stored.enabled === 'true',
      issuer: text('issuer', DEFAULTS.issuer),
      clientId: text('clientId', DEFAULTS.clientId),
      clientSecret: this.envValue('clientSecret') ?? this.storedSecret,
      scopes: text('scopes', DEFAULTS.scopes),
      roleClaim: text('roleClaim', DEFAULTS.roleClaim),
      roleMap: text('roleMap', DEFAULTS.roleMap),
      defaultRole: text('defaultRole', DEFAULTS.defaultRole) as UserRole,
      allowLocalLogin: flag('allowLocalLogin', DEFAULTS.allowLocalLogin),
      allowedEndpointOrigins: text('allowedEndpointOrigins', DEFAULTS.allowedEndpointOrigins),
    };
  }

  /** The same values shaped for the form, with the secret withheld. */
  view(redirectUri: string): OidcSettingsView {
    const effective = this.effective();

    const fields = Object.fromEntries(
      OIDC_FIELD_NAMES.map((field): [OidcField, OidcFieldView] => [
        field,
        {
          value:
            field === 'clientSecret'
              ? ''
              : field === 'enabled'
                ? String(effective.enabled)
                : String(effective[field]),
          managedByEnv: this.managedByEnv(field),
        },
      ]),
    ) as Record<OidcField, OidcFieldView>;

    return { fields, clientSecretSet: effective.clientSecret !== '', redirectUri };
  }

  /**
   * Write the fields the environment does not own.
   *
   * A field the environment owns is **refused, not ignored**: silently dropping
   * it would let the screen report a save that changed nothing, which is the
   * exact "form that lies" this design exists to avoid. The screen disables
   * those inputs, so reaching this is either a stale page or a direct API call.
   */
  async save(patch: OidcSettingsPatch): Promise<void> {
    const locked = (Object.keys(patch) as OidcField[]).filter(
      (field) => patch[field] !== undefined && this.managedByEnv(field),
    );
    if (locked.length > 0) {
      throw new Error(
        `These are set in the environment and cannot be changed here: ` +
          `${locked.map((f) => OIDC_FIELDS[f]).join(', ')}. Change them where they are declared.`,
      );
    }

    const writes = (Object.keys(patch) as OidcField[])
      .filter((field) => field !== 'clientSecret' && patch[field] !== undefined)
      .map((field) => {
        const value = String(patch[field]);
        return this.prisma.setting.upsert({
          where: { key: `${PREFIX}${field}` },
          create: { key: `${PREFIX}${field}`, value },
          update: { value },
        });
      });

    if (writes.length > 0) await this.prisma.$transaction(writes);

    if (patch.clientSecret !== undefined) {
      if (patch.clientSecret === '') {
        await this.credentials.delete(OIDC_CREDENTIAL_REF);
      } else {
        await this.credentials.put(OIDC_CREDENTIAL_REF, { clientSecret: patch.clientSecret });
      }
    }

    await this.reload();
  }
}
