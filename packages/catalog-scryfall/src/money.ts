/**
 * Scryfall reports prices as decimal *strings* — `"2.49"`, `"1250.00"`.
 *
 * Converting via `parseFloat(x) * 100` is the obvious approach and it is
 * subtly wrong: `2.49 * 100` is `248.99999999999997` in IEEE-754. `Math.round`
 * happens to rescue that particular case, but the pattern silently misprices
 * elsewhere, and a rounding error in a price is a real financial defect rather
 * than a cosmetic one.
 *
 * Parsing the decimal representation directly avoids floating point entirely.
 */
export function usdStringToCents(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;

  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return undefined;

  const [whole = '0', fraction = ''] = trimmed.split('.');

  // Pad or truncate to exactly two decimal places, rounding the third if present.
  const cents = fraction.padEnd(3, '0');
  const base = Number(whole) * 100 + Number(cents.slice(0, 2));
  const roundUp = Number(cents[2]) >= 5;

  const total = base + (roundUp ? 1 : 0);
  return Number.isFinite(total) ? total : undefined;
}
