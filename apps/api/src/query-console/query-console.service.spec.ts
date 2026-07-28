import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@hub/db';
import { QueryConsoleService } from './query-console.service';

/**
 * The query console against a real PostgreSQL.
 *
 * Everything here is about one question: can this thing write? The statement
 * checks in statement.spec.ts are a courtesy layer and could be bypassed by
 * anyone who cared to; these tests exercise the controls that cannot.
 *
 * Two of them are demonstrated separately, because they protect against
 * different mistakes:
 *
 * 1. The `READ ONLY` transaction, proved by pointing the console at the
 *    application's own **read-write** connection and showing writes are still
 *    refused. That is the case that matters — an operator who misconfigures the
 *    role, or points the console at DATABASE_URL to "just get it working".
 * 2. The restricted role, proved by building the exact role the documentation
 *    tells operators to create and showing it cannot write either. If the
 *    documented recipe is wrong, this is where it shows up rather than on
 *    somebody's deployment.
 */

const dbUrl = process.env.TEST_DATABASE_URL;
const describeDb = dbUrl ? describe : describe.skip;

const READONLY_ROLE = 'hub_console_test';
const READONLY_PASSWORD = 'console-test-password';

/** A ConfigService stand-in; the service only ever reads four keys. */
function config(values: Record<string, unknown>) {
  return {
    get: (key: string) => values[key],
  } as never;
}

function makeService(url: string | undefined, overrides: Record<string, unknown> = {}) {
  return new QueryConsoleService(
    config({
      ENABLE_QUERY_CONSOLE: true,
      DATABASE_PROVIDER: 'postgresql',
      QUERY_CONSOLE_DATABASE_URL: url,
      ...overrides,
    }),
  );
}

/** The read-write URL with the console role's credentials swapped in. */
function readOnlyUrl(base: string): string {
  const parsed = new URL(base);
  parsed.username = READONLY_ROLE;
  parsed.password = READONLY_PASSWORD;
  return parsed.toString();
}

describeDb('QueryConsoleService', () => {
  let admin: PrismaClient;
  const services: QueryConsoleService[] = [];

  const service = (url: string | undefined, overrides?: Record<string, unknown>) => {
    const created = makeService(url, overrides);
    services.push(created);
    return created;
  };

  beforeAll(async () => {
    admin = new PrismaClient({ datasources: { db: { url: dbUrl } } });
    await admin.$connect();

    // The role the documentation tells operators to create. Built here so a
    // mistake in that recipe fails this suite rather than a deployment. Raw
    // because it is DDL under test, with no Prisma equivalent.
    // eslint-disable-next-line no-restricted-syntax
    await admin.$executeRawUnsafe(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${READONLY_ROLE}') THEN
          CREATE ROLE ${READONLY_ROLE} LOGIN PASSWORD '${READONLY_PASSWORD}';
        END IF;
      END
      $$;
    `);

    for (const statement of [
      `GRANT CONNECT ON DATABASE ${new URL(dbUrl!).pathname.slice(1)} TO ${READONLY_ROLE}`,
      `GRANT USAGE ON SCHEMA public TO ${READONLY_ROLE}`,
      `GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${READONLY_ROLE}`,
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ${READONLY_ROLE}`,
    ]) {
      // eslint-disable-next-line no-restricted-syntax
      await admin.$executeRawUnsafe(statement);
    }
  });

  afterAll(async () => {
    await Promise.all(services.map((s) => s.onModuleDestroy()));
    await admin.$disconnect();
  });

  // -------------------------------------------------------------------------

  describe('reads', () => {
    it('returns rows and column names', async () => {
      const result = await service(dbUrl).run({ sql: 'SELECT 1 AS one, 2 AS two' }, 'tester');

      expect(result.columns).toEqual(['one', 'two']);
      expect(result.rows).toEqual([{ one: 1, two: 2 }]);
      expect(result.rowCount).toBe(1);
      expect(result.truncated).toBe(false);
    });

    /**
     * `count(*)` is the single most likely first query anyone types, and
     * PostgreSQL returns it as a BigInt, which JSON.stringify throws on. Without
     * serialisation the console would 500 on its own hello-world.
     */
    it('survives a bigint, which count(*) returns', async () => {
      const result = await service(dbUrl).run(
        { sql: 'SELECT count(*) FROM inventory_items' },
        'tester',
      );

      expect(() => JSON.stringify(result)).not.toThrow();
      expect(typeof result.rows[0]!.count).toBe('string');
    });

    it('renders timestamps as ISO strings', async () => {
      const result = await service(dbUrl).run({ sql: 'SELECT now() AS at' }, 'tester');
      expect(String(result.rows[0]!.at)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('reports a null rather than dropping the column', async () => {
      const result = await service(dbUrl).run({ sql: 'SELECT NULL AS nothing' }, 'tester');
      expect(result.rows[0]).toEqual({ nothing: null });
    });

    it('caps rows and says it did', async () => {
      const result = await service(dbUrl).run(
        { sql: 'SELECT generate_series(1, 100) AS n', maxRows: 10 },
        'tester',
      );

      expect(result.rows).toHaveLength(10);
      expect(result.rowCount).toBe(100);
      expect(result.truncated).toBe(true);
    });

    it('reports an empty result without inventing rows', async () => {
      const result = await service(dbUrl).run({ sql: 'SELECT 1 WHERE false' }, 'tester');
      expect(result.rows).toEqual([]);
      expect(result.truncated).toBe(false);
    });

    /**
     * Prisma wraps a raw-query failure in its own banner and a source path.
     * Showing that would tell an operator with a typo nothing at all, and would
     * put an internal file path on their screen.
     */
    it('surfaces the database message, not the Prisma wrapper', async () => {
      const failing = service(dbUrl).run({ sql: 'SELECT FROM WHERE' }, 'tester');

      await expect(failing).rejects.toThrow(/syntax error/i);
      await expect(failing).rejects.not.toThrow(/queryRawUnsafe|query-console\.service/);
    });
  });

  // -------------------------------------------------------------------------

  /**
   * The heart of it. The console is pointed at the application's own read-write
   * connection — the worst realistic misconfiguration — and still cannot write.
   */
  describe('cannot write, even on a read-write connection', () => {
    it.each([
      ["INSERT INTO settings (key, value) VALUES ('x', 'y')", 'INSERT'],
      ['UPDATE inventory_items SET quantity_on_hand = 0', 'UPDATE'],
      ['DELETE FROM alerts', 'DELETE'],
    ])('refuses %j at the statement check', async (sql) => {
      await expect(service(dbUrl).run({ sql }, 'tester')).rejects.toThrow(/read-only/i);
    });

    /**
     * With the shape check bypassed, PostgreSQL itself has to be the one saying
     * no. A writing CTE is the neatest way to demonstrate that: it starts with
     * `WITH`, so every keyword-based filter in the world waves it through.
     */
    it('refuses a data-modifying CTE, which looks like a SELECT', async () => {
      const sql = `
        WITH inserted AS (
          INSERT INTO settings (key, value) VALUES ('console-test', 'should-not-exist')
          RETURNING key
        )
        SELECT * FROM inserted
      `;

      await expect(service(dbUrl).run({ sql }, 'tester')).rejects.toThrow(/read-only transaction/i);

      // And nothing landed.
      const leaked = await admin.setting.findUnique({ where: { key: 'console-test' } });
      expect(leaked).toBeNull();
    });

    it('refuses DDL hidden behind an allowed keyword', async () => {
      // `EXPLAIN ANALYZE` actually executes the statement it is given.
      await expect(
        service(dbUrl).run(
          { sql: "EXPLAIN ANALYZE INSERT INTO settings (key, value) VALUES ('nope', 'nope')" },
          'tester',
        ),
      ).rejects.toThrow(/read-only transaction/i);

      const leaked = await admin.setting.findUnique({ where: { key: 'nope' } });
      expect(leaked).toBeNull();
    });

    it('explains the refusal in terms of where writes should go', async () => {
      const sql = `WITH x AS (DELETE FROM alerts RETURNING id) SELECT * FROM x`;
      await expect(service(dbUrl).run({ sql }, 'tester')).rejects.toThrow(/validated endpoints/i);
    });
  });

  // -------------------------------------------------------------------------

  describe('the documented read-only role', () => {
    it('can read', async () => {
      const result = await service(readOnlyUrl(dbUrl!)).run(
        { sql: 'SELECT count(*) FROM inventory_items' },
        'tester',
      );
      expect(result.rows).toHaveLength(1);
    });

    /**
     * Belt and braces: even without the READ ONLY transaction this role has no
     * grant to write with. Verified directly rather than through the service, so
     * the two layers are shown to hold independently.
     */
    it('has no write grant of its own', async () => {
      const asRole = new PrismaClient({ datasources: { db: { url: readOnlyUrl(dbUrl!) } } });
      try {
        // Raw on purpose: this proves a property of the role's grants, not of
        // any query the application would build.
        // eslint-disable-next-line no-restricted-syntax
        const write = asRole.$executeRawUnsafe(
          "INSERT INTO settings (key, value) VALUES ('role', 'x')",
        );
        await expect(write).rejects.toThrow(/permission denied/i);
      } finally {
        await asRole.$disconnect();
      }
    });
  });

  // -------------------------------------------------------------------------

  describe('availability', () => {
    it('is invisible when the feature is off', async () => {
      const off = service(dbUrl, { ENABLE_QUERY_CONSOLE: false });

      expect(off.status()).toMatchObject({ enabled: false, available: false });
      // NotFound, not Forbidden: a deployment that has not enabled this should
      // not advertise that the endpoint exists.
      await expect(off.run({ sql: 'SELECT 1' }, 'tester')).rejects.toThrow(/not enabled/i);
    });

    it('refuses to run on a dialect where the guarantee does not exist', async () => {
      const sqlite = service(dbUrl, { DATABASE_PROVIDER: 'sqlite' });

      expect(sqlite.status()).toMatchObject({ enabled: true, available: false });
      expect(sqlite.status().reason).toMatch(/requires PostgreSQL/i);
      await expect(sqlite.run({ sql: 'SELECT 1' }, 'tester')).rejects.toThrow(/PostgreSQL/i);
    });

    /**
     * validateEnv already refuses this pairing at boot. Asserted again because
     * the failure mode if it ever slipped through — falling back to the
     * application's writable connection — is the whole thing this feature is
     * built to avoid.
     */
    it('refuses to fall back to the application connection', async () => {
      const noUrl = service(undefined);
      await expect(noUrl.run({ sql: 'SELECT 1' }, 'tester')).rejects.toThrow(
        /must never share the application connection/i,
      );
    });
  });
});
