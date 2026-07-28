import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@hub/db';
import { checkStatement } from './statement';

/**
 * Admin-only read-only SQL console (TECHNICAL_DESIGN.md §7).
 *
 * This is the **one** sanctioned exception to the no-raw-SQL rule. Everywhere
 * else raw SQL is banned because it bypasses Prisma's dialect abstraction; here
 * the raw statement *is* the feature, and the rule it must not break is a
 * different one — writes never touch the ledger, because the allocation
 * invariant spans two tables and no database constraint can enforce it. Only
 * InventoryService can be trusted to keep it.
 *
 * ## Three layers, in order of how much they are worth
 *
 * 1. **A separate database role.** `QUERY_CONSOLE_DATABASE_URL` is a distinct
 *    connection the operator grants `SELECT` and nothing else. This is the
 *    control that actually holds, and `validateEnv` refuses to start with the
 *    console enabled and no separate URL — because the obvious shortcut,
 *    pointing it at `DATABASE_URL`, hands an admin a writable connection and
 *    quietly removes the entire protection.
 * 2. **A `READ ONLY` transaction.** Every statement runs inside one, so even a
 *    misconfigured role that *can* write is refused by PostgreSQL itself. This
 *    is what makes the feature safe when the operator gets step 1 wrong, which
 *    is the case worth designing for.
 * 3. **A statement shape check.** Turns an obvious mistake into a clear message.
 *    Explicitly not a security boundary — see statement.ts.
 *
 * On top of those: a statement timeout so one query cannot pin a backend, a row
 * cap so a careless `SELECT *` cannot exhaust memory rendering it, and a
 * separate connection pool so none of this competes with the application's.
 *
 * ## Why this is defensible at all
 *
 * The database holds no directly usable secret. Session tokens are stored as
 * SHA-256 hashes, API keys as argon2id hashes, and connector credentials as
 * AES-GCM ciphertext whose master key lives in the environment rather than the
 * database. So the blast radius is business data an admin can already read
 * through the UI — which is why "admin-only, read-only" is a sufficient bar,
 * and why the feature ships off by default anyway.
 */

/** Beyond this, the browser is the bottleneck and nobody is reading the rows. */
const DEFAULT_MAX_ROWS = 500;
const HARD_MAX_ROWS = 5_000;

/**
 * Long enough for an honest aggregate over a large ledger, short enough that a
 * cartesian-product mistake gives the operator an error rather than a hung tab.
 */
const STATEMENT_TIMEOUT_MS = 15_000;

export interface QueryRequest {
  sql: string;
  maxRows?: number;
}

export interface QueryResult {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  /** True when the result was cut to `maxRows`; there was more behind it. */
  truncated: boolean;
  durationMs: number;
}

@Injectable()
export class QueryConsoleService implements OnModuleDestroy {
  private readonly logger = new Logger(QueryConsoleService.name);
  private client?: PrismaClient;

  constructor(private readonly config: ConfigService) {}

  /** Whether the feature is switched on for this deployment. */
  get enabled(): boolean {
    return this.config.get<boolean>('ENABLE_QUERY_CONSOLE') === true;
  }

  /**
   * What the UI needs to decide whether to show itself.
   *
   * `available` is deliberately distinct from `enabled`: the console can be
   * switched on and still be unusable because the deployment is not on
   * PostgreSQL, and an operator deserves to be told which of the two it is.
   */
  status(): { enabled: boolean; available: boolean; reason?: string; maxRows: number } {
    if (!this.enabled) {
      return { enabled: false, available: false, maxRows: DEFAULT_MAX_ROWS };
    }

    const provider = this.config.get<string>('DATABASE_PROVIDER');
    if (provider !== 'postgresql') {
      return {
        enabled: true,
        available: false,
        reason:
          `The query console requires PostgreSQL — its read-only guarantee is a PostgreSQL ` +
          `READ ONLY transaction, and this deployment is on ${provider}. Running without that ` +
          `guarantee would mean trusting the connection's grants alone.`,
        maxRows: DEFAULT_MAX_ROWS,
      };
    }

    return { enabled: true, available: true, maxRows: DEFAULT_MAX_ROWS };
  }

  /**
   * Run one statement and return its rows.
   *
   * Throws {@link NotFoundException} when the feature is off, so a deployment
   * that has not enabled it does not advertise that the endpoint exists.
   */
  async run(request: QueryRequest, actor: string): Promise<QueryResult> {
    const status = this.status();
    if (!status.enabled) {
      throw new NotFoundException('The query console is not enabled on this deployment.');
    }
    if (!status.available) {
      throw new BadRequestException(status.reason);
    }

    const check = checkStatement(request.sql);
    if (!check.ok) throw new BadRequestException(check.reason);

    const maxRows = Math.min(
      HARD_MAX_ROWS,
      Math.max(1, Math.trunc(request.maxRows ?? DEFAULT_MAX_ROWS)),
    );

    const client = this.connection();
    const started = Date.now();

    let raw: unknown;
    try {
      raw = await client.$transaction(
        async (tx) => {
          // The three raw calls below are the sanctioned exception to the
          // no-raw-SQL rule (see the class doc): the raw statement is this
          // feature's entire purpose, and the first of them is what makes it
          // safe. The directives sit immediately above each call — a comment
          // between a disable-next-line and its target silently disables
          // nothing, which is how this rule gets bypassed by accident.

          // Must come first in the transaction. From here PostgreSQL refuses
          // every write itself, whatever the role happens to be granted.
          // eslint-disable-next-line no-restricted-syntax
          await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');

          // eslint-disable-next-line no-restricted-syntax
          await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);

          // The statement is the operator's input; there is nothing to
          // parameterize, which is exactly why the layers above it exist.
          // eslint-disable-next-line no-restricted-syntax
          return tx.$queryRawUnsafe(request.sql);
        },
        {
          // Comfortably past the statement timeout, so a slow query is reported
          // as a timeout rather than as Prisma abandoning its own transaction.
          timeout: STATEMENT_TIMEOUT_MS + 5_000,
          maxWait: 5_000,
        },
      );
    } catch (error) {
      const message = (error as Error).message;
      // The statement matters most on the failing path — a refused write is
      // exactly what someone reviewing this log came to find — and Prisma's
      // wrapper says nothing, so the driver's own message is what gets written.
      this.logger.warn(
        `Query by ${actor} failed after ${Date.now() - started}ms: ` +
          `${driverMessage(message)} — ${firstLine(request.sql)}`,
      );
      throw new BadRequestException(explain(message));
    }

    const durationMs = Date.now() - started;
    const all = Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : [];
    const rows = all.slice(0, maxRows).map(serializeRow);

    // Statement, actor and shape, but never the rows: the log is for "who read
    // what", and copying the answers into it would put the data somewhere with
    // a different retention story and no access control of its own.
    this.logger.log(
      `Query by ${actor}: ${all.length} row(s) in ${durationMs}ms — ${firstLine(request.sql)}`,
    );

    return {
      columns: columnsOf(rows, all),
      rows,
      rowCount: all.length,
      truncated: all.length > rows.length,
      durationMs,
    };
  }

  /**
   * The console's own connection, built on first use.
   *
   * Separate from PrismaService on purpose. Sharing the application's client
   * would mean sharing its pool — so one careless query could starve the sync
   * workers — and, far worse, would run the console under the application's
   * read-write credentials.
   */
  private connection(): PrismaClient {
    if (this.client) return this.client;

    const url = this.config.get<string>('QUERY_CONSOLE_DATABASE_URL');
    if (!url) {
      // Unreachable in a booted app: validateEnv refuses this combination at
      // startup. Kept because the alternative to a clear error here is silently
      // falling back to the application's writable connection.
      throw new BadRequestException(
        'QUERY_CONSOLE_DATABASE_URL is not set. The console must never share the application ' +
          'connection.',
      );
    }

    this.client = new PrismaClient({ datasources: { db: { url } } });
    this.logger.log('Query console connection created (read-only)');
    return this.client;
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.$disconnect();
  }
}

/**
 * Column order, taken from the driver's own key order.
 *
 * Read from the first *unsliced* row so a query capped to zero visible rows
 * still reports its shape, and unioned across the visible rows because a row
 * with a NULL in a column may omit it entirely.
 */
function columnsOf(
  rows: Array<Record<string, unknown>>,
  all: Array<Record<string, unknown>>,
): string[] {
  const columns = new Set<string>();
  for (const row of rows.length > 0 ? rows : all.slice(0, 1)) {
    for (const key of Object.keys(row ?? {})) columns.add(key);
  }
  return [...columns];
}

/**
 * Make a row safe to serialize.
 *
 * `JSON.stringify` throws outright on a BigInt, and PostgreSQL returns one for
 * `count(*)` — so the single most common query in any console would 500 without
 * this. Dates, Buffers and Prisma's Decimal are converted for the same reason:
 * the console's job is to show what is there, not to guess how it should look.
 */
function serializeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row ?? {})) {
    out[key] = serializeValue(value);
  }
  return out;
}

function serializeValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `\\x${value.toString('hex')}`;
  if (Array.isArray(value)) return value.map(serializeValue);

  if (typeof value === 'object') {
    // Prisma's Decimal and PostGIS-style objects both expose toString; anything
    // else structured is passed through for the client to render as JSON.
    const maybeDecimal = value as { toFixed?: unknown; toString(): string };
    if (typeof maybeDecimal.toFixed === 'function') return maybeDecimal.toString();
    return value;
  }

  return value;
}

/**
 * Turn a driver error into something an operator can act on.
 *
 * The read-only refusal in particular arrives as a bare PostgreSQL message that
 * reads like a bug in the application rather than the console working exactly
 * as designed.
 */
function explain(message: string): string {
  if (/read-only transaction/i.test(message)) {
    return (
      'Refused: this console runs every statement in a read-only transaction. ' +
      "Changes go through the API's validated endpoints, which is what keeps the allocation " +
      'invariant enforceable.'
    );
  }

  if (/statement timeout|canceling statement/i.test(message)) {
    return `Timed out after ${STATEMENT_TIMEOUT_MS / 1000}s. Narrow the query and try again.`;
  }

  const driver = driverMessage(message);

  if (/permission denied/i.test(message)) {
    return `${driver} — the console's database role has not been granted access to that object.`;
  }

  return driver;
}

/**
 * Dig the database's own message out of Prisma's wrapper.
 *
 * A raw-query failure arrives as several lines of
 * ``Invalid `prisma.$queryRawUnsafe()` invocation:`` followed by a source path,
 * with the part the operator needs — `syntax error at or near "WHERE"` — buried
 * in the middle. Showing the wrapper instead would tell someone with a typo
 * nothing at all, and would put an internal file path on their screen.
 */
function driverMessage(message: string): string {
  const wrapped = /Message: `([^`]+)`/.exec(message)?.[1];
  if (wrapped) return wrapped.trim().slice(0, 500);

  const useful = message
    .split('\n')
    .map((line) => line.trim())
    .find(
      (line) =>
        line !== '' &&
        // Prisma's invocation banner and the source location under it.
        !/^Invalid `/.test(line) &&
        !/^\s*\d+\s/.test(line) &&
        !/[/\\].*\.(ts|js):\d+/.test(line),
    );

  return (useful ?? firstLine(message)).slice(0, 500);
}

/** Postgres errors carry a multi-line position indicator; the first line is the message. */
function firstLine(value: string): string {
  return (value.split('\n').find((line) => line.trim() !== '') ?? value).trim().slice(0, 500);
}
