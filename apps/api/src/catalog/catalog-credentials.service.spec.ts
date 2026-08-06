import { describe, expect, it } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import type { CatalogSource } from '@hub/connector-sdk';
import { CatalogCredentialsService } from './catalog-credentials.service';
import type { CredentialStore } from '../connectors/credential-store.service';

/**
 * A unit test rather than an integration one: `CredentialStore` itself is
 * already proven against a real database (credential-store.spec.ts). What
 * this needs to prove is the mapping on top — the `catalog:<key>` ref, the
 * declared-fields validation, and never letting a missing credential surface
 * as anything but "nothing configured".
 */
function fakeStore(): CredentialStore & { seed: Map<string, Record<string, string>> } {
  const seed = new Map<string, Record<string, string>>();
  return {
    seed,
    async get(ref: string) {
      const value = seed.get(ref);
      if (!value) throw new NotFoundException(`No credentials stored for "${ref}".`);
      return value;
    },
    async put(ref: string, secrets: Record<string, string>) {
      seed.set(ref, secrets);
    },
    async has(ref: string) {
      return seed.has(ref);
    },
    async delete(ref: string) {
      seed.delete(ref);
    },
  } as unknown as CredentialStore & { seed: Map<string, Record<string, string>> };
}

const source = (over: Partial<CatalogSource> = {}): CatalogSource =>
  ({
    key: 'cardtrader',
    displayName: 'CardTrader',
    games: [],
    secretFields: ['token'],
    search: async () => [],
    ...over,
  }) as CatalogSource;

describe('CatalogCredentialsService', () => {
  it('returns empty secrets for a source that declares none', async () => {
    const svc = new CatalogCredentialsService(fakeStore());
    const secrets = await svc.loadSecrets(source({ secretFields: undefined }));
    expect(secrets).toEqual({});
  });

  it('returns empty secrets, not a thrown error, when nothing is configured yet', async () => {
    const svc = new CatalogCredentialsService(fakeStore());
    const secrets = await svc.loadSecrets(source());
    expect(secrets).toEqual({});
  });

  it('stores and later loads a secret under catalog:<sourceKey>', async () => {
    const store = fakeStore();
    const svc = new CatalogCredentialsService(store);

    await svc.setSecrets(source(), { token: 'live-token' });

    expect(store.seed.get('catalog:cardtrader')).toEqual({ token: 'live-token' });
    expect(await svc.loadSecrets(source())).toEqual({ token: 'live-token' });
  });

  it('merges a new secret with what is already stored, rather than replacing it', async () => {
    const store = fakeStore();
    const svc = new CatalogCredentialsService(store);
    const twoFieldSource = source({ secretFields: ['token', 'other'] });

    await svc.setSecrets(twoFieldSource, { token: 'first' });
    await svc.setSecrets(twoFieldSource, { other: 'second' });

    expect(await svc.loadSecrets(twoFieldSource)).toEqual({ token: 'first', other: 'second' });
  });

  it('refuses a field the source never declared', async () => {
    const svc = new CatalogCredentialsService(fakeStore());
    await expect(svc.setSecrets(source(), { bogus: 'x' })).rejects.toThrow(/does not use/i);
  });

  it('refuses to store anything for a source with no secretFields', async () => {
    const svc = new CatalogCredentialsService(fakeStore());
    await expect(
      svc.setSecrets(source({ secretFields: undefined }), { token: 'x' }),
    ).rejects.toThrow(/takes no credentials/i);
  });

  it('reports which declared fields are set, never their values', async () => {
    const store = fakeStore();
    const svc = new CatalogCredentialsService(store);
    const twoFieldSource = source({ secretFields: ['token', 'other'] });

    await svc.setSecrets(twoFieldSource, { token: 'live-token' });
    const status = await svc.status(twoFieldSource);

    expect(status).toEqual({ secretFieldsRequired: ['token', 'other'], secretsSet: ['token'] });
    expect(JSON.stringify(status)).not.toContain('live-token');
  });

  it('reports nothing set when the source declares fields but none are stored', async () => {
    const svc = new CatalogCredentialsService(fakeStore());
    const status = await svc.status(source());
    expect(status).toEqual({ secretFieldsRequired: ['token'], secretsSet: [] });
  });
});
