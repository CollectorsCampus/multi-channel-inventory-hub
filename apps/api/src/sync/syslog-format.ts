/**
 * RFC 5424 syslog formatting — pure functions, the way `allocation.ts` and
 * `repricing.ts` are pure. The I/O (UDP datagrams, TCP frames, settings) lives
 * in `SyslogService`.
 *
 * The hub ships two message kinds, mirroring the Activity page's two panels:
 * alerts (MSGID `alert`) and sync events (MSGID `sync`). The body is JSON —
 * collectors parse structured payloads far more reliably than they parse
 * prose, and the fields are the same ones the API serves.
 */

/** RFC 5424 facility `local0`, the conventional slot for application logs. */
const FACILITY = 16;

/**
 * RFC 5424 severity codes. Only the ones this hub emits — the full table runs
 * 0–7, but nothing here is ever an `emerg` and inventing one would page
 * somebody's on-call for a card shop.
 */
export const SYSLOG_SEVERITY = {
  crit: 2,
  err: 3,
  warning: 4,
  notice: 5,
  info: 6,
} as const;

export type SyslogSeverity = keyof typeof SYSLOG_SEVERITY;

/** Alert severities map onto the syslog vocabulary; unknown reads as warning. */
export function severityForAlert(alertSeverity: string): SyslogSeverity {
  switch (alertSeverity) {
    case 'critical':
      return 'crit';
    case 'info':
      return 'info';
    default:
      return 'warning';
  }
}

/** Sync outcomes likewise. `pending` rows are never shipped — only completions. */
export function severityForOutcome(outcome: string): SyslogSeverity {
  switch (outcome) {
    case 'error':
      return 'err';
    case 'conflict':
      return 'warning';
    default:
      return 'info';
  }
}

export interface SyslogMessageInput {
  severity: SyslogSeverity;
  timestamp: Date;
  hostname: string;
  /** `alert` or `sync` — which panel of the Activity page this came from. */
  msgId: string;
  /** Already-serialised body; the caller decides the JSON shape. */
  message: string;
}

/**
 * One RFC 5424 message: `<PRI>1 TIMESTAMP HOSTNAME APP-NAME PROCID MSGID SD MSG`.
 *
 * PROCID and structured data are `-` (nil): the process id changes on every
 * restart and means nothing across a fleet of one, and the structure lives in
 * the JSON body where every collector's JSON parser can reach it.
 */
export function formatSyslog(input: SyslogMessageInput): string {
  const pri = FACILITY * 8 + SYSLOG_SEVERITY[input.severity];
  // RFC 5424 wants RFC 3339; Date#toISOString is exactly that.
  const timestamp = input.timestamp.toISOString();
  const hostname = sanitizeToken(input.hostname) || '-';
  const msgId = sanitizeToken(input.msgId) || '-';
  return `<${pri}>1 ${timestamp} ${hostname} inventory-hub - ${msgId} - ${input.message}`;
}

/**
 * Frame a message for TCP transport: RFC 6587 octet counting (`LEN SP MSG`).
 *
 * Octet counting rather than newline framing because the body is JSON, which
 * a collector could not safely split on newlines if a detail string ever
 * carried one.
 */
export function frameTcp(message: string): string {
  const bytes = Buffer.byteLength(message, 'utf8');
  return `${bytes} ${message}`;
}

/**
 * Header fields are space-separated, so a value containing whitespace would
 * shift every field after it. Print-ASCII only, per the RFC's SD-NAME rules.
 */
function sanitizeToken(value: string): string {
  return value.replace(/[^\x21-\x7e]/g, '').slice(0, 255);
}
