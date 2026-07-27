/**
 * JSON-bearing columns (`ChannelInstance.config`, `SyncEvent.payload`,
 * `WebhookEvent.headers`, `Alert.context`) are stored as `String`.
 *
 * Not because Prisma lacks a `Json` scalar on SQLite — 6.19+ supports it on all
 * three providers — but because Json null semantics diverge across dialects:
 * the `Prisma.DbNull` vs `Prisma.JsonNull` distinction is Postgres-only, so the
 * same code would behave differently depending on the deployment's database.
 *
 * These helpers are the only sanctioned way to cross that boundary. Core logic
 * must never query *into* these columns — see TECHNICAL_DESIGN.md §3.
 */

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Encode a value for storage in a JSON-bearing String column. */
export function encodeJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

/**
 * Decode a JSON-bearing String column. Returns `fallback` when the column is
 * null/empty or holds malformed JSON — a corrupt audit payload must never take
 * down a request path.
 */
export function decodeJson<T = JsonValue>(raw: string | null | undefined, fallback: T): T {
  if (raw === null || raw === undefined || raw === '') return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Decode an object-shaped column, defaulting to `{}`. */
export function decodeJsonObject(raw: string | null | undefined): Record<string, JsonValue> {
  const parsed = decodeJson<unknown>(raw, {});
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, JsonValue>)
    : {};
}
