import { BadRequestException, Injectable } from '@nestjs/common';
import type { CatalogSource } from '@hub/connector-sdk';
// Not `import type` — Nest injects this, and a type-only import degrades
// `design:paramtypes` to Object and fails DI at runtime (rule 7).
import { CredentialStore } from '../connectors/credential-store.service';

/**
 * Secrets for catalog sources, parallel to how `ChannelsService` uses
 * `CredentialStore` for connectors — but simpler, because a catalog source has
 * exactly one live instance rather than one row per operator-created channel.
 *
 * CardTrader is the first source needing this: `CatalogService.makeCtx` and
 * `CatalogIngestService.makeCtx` hardcoded `secrets: {}` from the day the
 * `CatalogCtx.secrets` field was written, because nothing had yet needed
 * authentication (see `docs/CONNECTOR_ROADMAP.md`'s CardTrader section for the
 * live probe that found this).
 *
 * No new table and no migration: `Credential.ref` is a free unique string, and
 * a source's key is already stable and unique (`CatalogSourceRegistry.register`
 * enforces that), so `catalog:<sourceKey>` is a ref that needs nothing else to
 * exist. The ref is bound in as AEAD associated data by `CredentialStore`
 * itself, so this reuses the same protection channel credentials get: nobody
 * can move one source's ciphertext onto another's ref.
 */
@Injectable()
export class CatalogCredentialsService {
  constructor(private readonly credentials: CredentialStore) {}

  private ref(sourceKey: string): string {
    return `catalog:${sourceKey}`;
  }

  /**
   * Secrets for one call, or `{}` for a public source or one not yet
   * configured. Never throws for a missing credential: a source declaring
   * `secretFields` but holding none configured should fail with *its own*
   * clear error from the HTTP call it cannot make, not a generic one here.
   */
  async loadSecrets(source: CatalogSource): Promise<Readonly<Record<string, string>>> {
    if (!source.secretFields || source.secretFields.length === 0) return {};

    try {
      return await this.credentials.get(this.ref(source.key));
    } catch {
      // NotFoundException (nothing stored yet) and a decrypt failure both land
      // here, and both mean the same thing to a caller: nothing usable is
      // configured. Distinguishing them is `status()`'s job, not this one's.
      return {};
    }
  }

  /**
   * Which declared secret fields are set, without ever returning their values —
   * the same trade `ChannelsService.toSummary` makes for connectors.
   */
  async status(
    source: CatalogSource,
  ): Promise<{ secretFieldsRequired: string[]; secretsSet: string[] }> {
    const declared = source.secretFields ?? [];
    if (declared.length === 0) return { secretFieldsRequired: [], secretsSet: [] };

    let secretsSet: string[];
    try {
      const stored = await this.credentials.get(this.ref(source.key));
      secretsSet = declared.filter((field) => Boolean(stored[field]));
    } catch {
      secretsSet = [];
    }

    return { secretFieldsRequired: [...declared], secretsSet };
  }

  /**
   * Store secrets for a source, merged with whatever is already there — so
   * rotating one field does not require re-entering the others, matching
   * `ChannelsService.update`.
   */
  async setSecrets(source: CatalogSource, secrets: Record<string, string>): Promise<void> {
    const declared = source.secretFields ?? [];
    if (declared.length === 0) {
      throw new BadRequestException(
        `Catalog source "${source.key}" takes no credentials — it needs no authentication.`,
      );
    }

    const unknown = Object.keys(secrets).filter((key) => !declared.includes(key));
    if (unknown.length > 0) {
      throw new BadRequestException(
        `Catalog source "${source.key}" does not use: ${unknown.join(', ')}. It expects: ${declared.join(', ')}.`,
      );
    }

    const ref = this.ref(source.key);
    const current = await this.credentials.get(ref).catch(() => ({}));
    await this.credentials.put(ref, { ...current, ...secrets });
  }
}
