import { describe, expect, it } from 'vitest';
import { formatSyslog, frameTcp, severityForAlert, severityForOutcome } from './syslog-format';

describe('formatSyslog', () => {
  const at = new Date('2026-08-12T20:00:00.000Z');

  it('produces an RFC 5424 header with local0 PRI and nil PROCID/SD', () => {
    const line = formatSyslog({
      severity: 'warning',
      timestamp: at,
      hostname: 'hub-host',
      msgId: 'alert',
      message: '{"kind":"sync_failure"}',
    });
    // local0 (16) * 8 + warning (4) = 132.
    expect(line).toBe(
      '<132>1 2026-08-12T20:00:00.000Z hub-host inventory-hub - alert - {"kind":"sync_failure"}',
    );
  });

  it('maps each severity onto its own PRI', () => {
    const pri = (severity: Parameters<typeof formatSyslog>[0]['severity']) =>
      formatSyslog({ severity, timestamp: at, hostname: 'h', msgId: 'm', message: 'x' }).slice(
        0,
        6,
      );
    expect(pri('crit')).toBe('<130>1');
    expect(pri('err')).toBe('<131>1');
    expect(pri('warning')).toBe('<132>1');
    expect(pri('notice')).toBe('<133>1');
    expect(pri('info')).toBe('<134>1');
  });

  /**
   * Header fields are space-separated; a hostname carrying a space would shift
   * every field after it and the collector would misparse the stream.
   */
  it('strips whitespace and non-ASCII from header tokens', () => {
    const line = formatSyslog({
      severity: 'info',
      timestamp: at,
      hostname: 'my host\né',
      msgId: 'sync',
      message: 'x',
    });
    expect(line).toContain(' myhost inventory-hub - sync - x');
  });

  it('falls back to nil for a hostname that sanitises to nothing', () => {
    const line = formatSyslog({
      severity: 'info',
      timestamp: at,
      hostname: ' ',
      msgId: 'sync',
      message: 'x',
    });
    expect(line).toContain(' - inventory-hub - sync - x');
  });
});

describe('frameTcp', () => {
  it('prefixes the octet count, counting bytes rather than characters', () => {
    expect(frameTcp('hello')).toBe('5 hello');
    // é is two bytes in UTF-8; a character count would under-frame and the
    // collector would read the tail as the start of the next message.
    expect(frameTcp('é')).toBe('2 é');
  });
});

describe('severity mapping', () => {
  it('maps alert severities, defaulting the unknown to warning', () => {
    expect(severityForAlert('critical')).toBe('crit');
    expect(severityForAlert('warning')).toBe('warning');
    expect(severityForAlert('info')).toBe('info');
    expect(severityForAlert('someday-severity')).toBe('warning');
  });

  it('maps sync outcomes', () => {
    expect(severityForOutcome('error')).toBe('err');
    expect(severityForOutcome('conflict')).toBe('warning');
    expect(severityForOutcome('ok')).toBe('info');
  });
});
