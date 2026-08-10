/**
 * Public pages for the external ids a catalogue item carries.
 *
 * Only namespaces whose URL shape was **verified to resolve** are linked
 * (2026-08-09): a link that 404s is worse than a bare id. Cardmarket is
 * deliberately absent — its product pages sit behind bot protection and no
 * id-addressed URL could be confirmed. `hub` is this application's own
 * namespace and has no public page by definition.
 *
 * tcgplayer and tcgcsv share one id space (tcgcsv republishes TCGPlayer's
 * catalogue), so an item carrying both gets a single TCGPlayer link rather
 * than two links to the same page.
 */

export interface ExternalLink {
  label: string;
  url: string;
}

const TEMPLATES: ReadonlyArray<{ source: string; label: string; url: (id: string) => string }> = [
  {
    source: 'tcgplayer',
    label: 'TCGplayer',
    url: (id) => `https://www.tcgplayer.com/product/${encodeURIComponent(id)}`,
  },
  {
    source: 'tcgcsv',
    label: 'TCGplayer',
    url: (id) => `https://www.tcgplayer.com/product/${encodeURIComponent(id)}`,
  },
  {
    source: 'scryfall',
    label: 'Scryfall',
    url: (id) => `https://scryfall.com/card/${encodeURIComponent(id)}`,
  },
  {
    source: 'cardtrader',
    label: 'CardTrader',
    url: (id) => `https://www.cardtrader.com/en/cards/${encodeURIComponent(id)}`,
  },
];

/** The links an item's external ids support, deduplicated by destination. */
export function externalLinks(ids: Record<string, string | undefined>): ExternalLink[] {
  const links: ExternalLink[] = [];
  const seen = new Set<string>();

  for (const template of TEMPLATES) {
    const id = ids[template.source]?.trim();
    if (!id) continue;

    const url = template.url(id);
    if (seen.has(url)) continue;
    seen.add(url);

    links.push({ label: template.label, url });
  }

  return links;
}
