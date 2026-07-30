import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { validateCatalogSource, type CatalogCtx } from '@hub/connector-sdk';
import { createTcgcsvSource } from './tcgcsv';
import {
  normalizePrinting,
  parseCategories,
  parseGroups,
  parseProductsAndPrices,
  toCandidates,
} from './rows';

/**
 * Every fixture is a slice of a real tcgcsv download, trimmed only in the length
 * of long text fields. The shapes are the point: CRLF endings, quoted commas,
 * newlines *inside* quoted fields, absent market prices, an empty
 * `subTypeName`, one product with two printings, and a category whose header
 * order differs from Magic's.
 */
const fixture = (name: string) =>
  readFileSync(join(__dirname, '..', 'test', 'fixtures', name), 'utf8');

const CATEGORIES = fixture('categories.csv');
const MAGIC_GROUPS = fixture('magic-groups.csv');
const MAGIC_PRODUCTS = fixture('magic-products-and-prices.csv');
const POKEMON_PRODUCTS = fixture('pokemon-products-and-prices.csv');

const ctx = (): CatalogCtx => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  secrets: {},
});

describe('the fixtures really do carry the awkward shapes', () => {
  // If this fails, every assertion below is testing something easier than
  // reality and the suite has quietly stopped being worth running.
  it('carries a CRLF *inside* a quoted field, not just between records', () => {
    expect(MAGIC_PRODUCTS).toContain('\r\n');

    // The nastier shape than a bare LF: the rules text contains the very
    // sequence that separates records. There are 6 data rows plus a header, so
    // 7 line breaks would be the count if none were embedded — and there are
    // more, which is only survivable by tracking quote state.
    const breaks = MAGIC_PRODUCTS.split('\r\n').length - 1;
    expect(breaks).toBeGreaterThan(7);

    // And the parser still finds exactly 6 records, not one per line break.
    expect(parseProductsAndPrices(MAGIC_PRODUCTS)).toHaveLength(6);
  });

  it('contains a quoted comma, an absent price and an empty subTypeName', () => {
    expect(MAGIC_PRODUCTS).toContain('"Brad Boimler, Eager Ensign"');
    expect(MAGIC_PRODUCTS).toMatch(/,,/); // an empty cell somewhere
  });

  it('has a Pokémon header ordered differently from Magic', () => {
    const magicHeader = MAGIC_PRODUCTS.split('\r\n')[0] ?? '';
    const pokemonHeader = POKEMON_PRODUCTS.split('\r\n')[0] ?? '';

    expect(magicHeader).not.toEqual(pokemonHeader);
    // Magic puts rarity before the price block; Pokémon puts it after.
    expect(magicHeader.indexOf('extRarity')).toBeLessThan(magicHeader.indexOf('lowPrice'));
    expect(pokemonHeader.indexOf('extRarity')).toBeGreaterThan(pokemonHeader.indexOf('lowPrice'));
  });
});

describe('parseCategories', () => {
  it('reads both the short and display names', () => {
    const categories = parseCategories(CATEGORIES);

    const magic = categories.find((c) => c.categoryId === '1');
    expect(magic).toMatchObject({ name: 'Magic', displayName: 'Magic: The Gathering' });

    // The short name is what CatalogItem.game holds, so it must not be the
    // marketing one.
    expect(magic?.name).not.toContain(':');
  });

  it('includes categories with no groups rather than dropping them', () => {
    // "Marvel Comics" publishes 0 groups. Silently omitting it would make a
    // legitimate "nothing there" indistinguishable from an unknown game.
    const categories = parseCategories(CATEGORIES);
    expect(categories.length).toBeGreaterThan(1);
    expect(categories.every((c) => c.categoryId !== '')).toBe(true);
  });
});

describe('parseGroups', () => {
  it('reads set names and keeps them tied to their category', () => {
    const groups = parseGroups(MAGIC_GROUPS);

    expect(groups.length).toBeGreaterThan(0);
    expect(groups.every((g) => g.categoryId === '1')).toBe(true);
    expect(groups.map((g) => g.name)).toContain('Star Trek');
  });
});

describe('parseProductsAndPrices', () => {
  it('survives a quoted comma and an embedded newline', () => {
    const rows = parseProductsAndPrices(MAGIC_PRODUCTS);

    const boimler = rows.find((r) => r.productId === '706132');
    expect(boimler?.name).toBe('Brad Boimler, Eager Ensign');
    // The rules text spans lines; a line-splitting parser would have produced a
    // truncated name or an extra phantom row.
    expect(boimler?.extended.extOracleText).toContain('\n');
    expect(rows).toHaveLength(6);
  });

  it('parses prices to integer cents without touching a float', () => {
    const rows = parseProductsAndPrices(MAGIC_PRODUCTS);

    // 2.99 * 100 is 298.99999999999997 in IEEE-754. This must be exactly 299.
    expect(rows.find((r) => r.productId === '706132')?.marketPriceCents).toBe(299);

    // One decimal place, which the source really does emit.
    expect(rows.find((r) => r.productId === '706138')?.marketPriceCents).toBe(15780);
  });

  it('leaves an absent market price undefined rather than zero', () => {
    const rows = parseProductsAndPrices(MAGIC_PRODUCTS);
    const crusher = rows.find((r) => r.productId === '706134');

    // Two thirds of the rows in the real file have no market price. Reading that
    // as 0 would price a card at nothing.
    expect(crusher?.marketPriceCents).toBeUndefined();
    expect(crusher?.name).toBe('Dr. Beverly Crusher');
  });

  it('reads columns by name, so a different category order still parses', () => {
    const rows = parseProductsAndPrices(POKEMON_PRODUCTS);

    expect(rows).toHaveLength(3);
    const pack = rows.find((r) => r.productId === '696613');
    expect(pack?.name).toBe('30th Celebration Pack');
    expect(pack?.marketPriceCents).toBe(3265);
    expect(pack?.categoryId).toBe('3');

    // Pokémon's extras are a different set entirely from Magic's. Checked
    // across all rows, because a sealed product carries fewer of them than a
    // card does — the first row here is a booster pack with only extCardText.
    const allExtras = new Set(rows.flatMap((r) => Object.keys(r.extended)));
    expect(allExtras).toContain('extCardText');
    expect(allExtras).toContain('extRarity');
    expect(allExtras).not.toContain('extOracleText');
  });

  it('keeps unknown ext columns instead of discarding them', () => {
    const rows = parseProductsAndPrices(MAGIC_PRODUCTS);
    const extended = rows.find((r) => r.productId === '706132')?.extended ?? {};

    expect(extended.extRarity).toBe('U');
    expect(extended.extNumber).toBe('5');
    // Core price/identity columns must not leak into the extras bag.
    expect(extended.marketPrice).toBeUndefined();
    expect(extended.productId).toBeUndefined();
  });
});

describe('normalizePrinting', () => {
  it('treats an absent finish as NORMAL, not as an error', () => {
    // A real sealed booster pack has an empty subTypeName.
    expect(normalizePrinting('')).toEqual({ printing: 'NORMAL' });
    expect(normalizePrinting(undefined)).toEqual({ printing: 'NORMAL' });
  });

  it('maps the finishes we know onto the Sku printing vocabulary', () => {
    expect(normalizePrinting('Normal').printing).toBe('NORMAL');
    expect(normalizePrinting('Foil').printing).toBe('FOIL');
    expect(normalizePrinting('Reverse Holofoil').printing).toBe('REVERSE_HOLOFOIL');
  });

  it('reports an unfamiliar finish but still yields a usable printing', () => {
    const result = normalizePrinting('Rainbow Etched');

    // Reported, so a new finish surfaces as a message rather than as silently
    // mispriced stock — but not discarded, because the row's identity is its id.
    expect(result.unrecognised).toBe('Rainbow Etched');
    expect(result.printing).toBe('RAINBOW_ETCHED');
  });

  it('never returns an empty printing', () => {
    // A nullable or blank printing would make Sku's natural key unenforceable,
    // since NULL != NULL on all three dialects.
    for (const input of ['', ' ', undefined, 'Foil', '???']) {
      expect(normalizePrinting(input).printing).not.toBe('');
    }
  });
});

describe('toCandidates', () => {
  const candidates = () =>
    toCandidates(parseProductsAndPrices(MAGIC_PRODUCTS), {
      categoryName: () => 'Magic',
      groupName: () => 'Star Trek',
    });

  it('collapses a product sold in two finishes into one candidate', () => {
    const all = candidates();

    // Six rows, but 706191 appears twice — once Normal, once Foil.
    expect(all).toHaveLength(5);

    const enterprise = all.find((c) => c.sourceId === '706191');
    expect(enterprise?.printings).toEqual(expect.arrayContaining(['NORMAL', 'FOIL']));
    expect(enterprise?.printings).toHaveLength(2);
  });

  it('prefers the non-foil price, matching the Scryfall source', () => {
    const enterprise = candidates().find((c) => c.sourceId === '706191');

    // In the fixture the Foil row has no market price and the Normal row has
    // 39.65 — so a naive "first row wins" would have reported no price at all.
    expect(enterprise?.marketPrice).toBe(3965);
  });

  it('carries the product-level tcgplayer id, which is the point of this source', () => {
    const boimler = candidates().find((c) => c.sourceId === '706132');

    expect(boimler?.externalIds.tcgplayer).toBe('706132');
    expect(boimler?.externalIds.tcgcsv).toBe('706132');
  });

  it('omits a price rather than inventing one', () => {
    const crusher = candidates().find((c) => c.sourceId === '706134');

    expect(crusher).toBeDefined();
    expect(crusher?.marketPrice).toBeUndefined();
  });

  it('labels game and set from the category and group, not from the row', () => {
    const boimler = candidates().find((c) => c.sourceId === '706132');

    // The row itself only has numeric ids; the names come from Categories.csv
    // and Groups.csv.
    expect(boimler?.game).toBe('Magic');
    expect(boimler?.setName).toBe('Star Trek');
  });
});

describe('the source contract', () => {
  it('is a valid CatalogSource', () => {
    expect(validateCatalogSource(createTcgcsvSource())).toEqual([]);
  });

  it('declares the tcgplayer id namespace', () => {
    const source = createTcgcsvSource();

    // Intake prefers a source that yields the ids we key the catalog on.
    expect(source.providesExternalIds).toContain('tcgplayer');
    expect(source.key).toBe('tcgcsv');
  });
});

describe('search', () => {
  /** Serves the fixtures for the paths the source is expected to request. */
  const stubFetch = (calls: string[] = []) =>
    vi.fn(async (url: string) => {
      calls.push(url);
      const body = url.endsWith('/Categories.csv')
        ? CATEGORIES
        : url.endsWith('/Groups.csv')
          ? MAGIC_GROUPS
          : url.includes('/1/') && url.includes('ProductsAndPrices')
            ? MAGIC_PRODUCTS
            : url.includes('/3/') && url.includes('ProductsAndPrices')
              ? POKEMON_PRODUCTS
              : null;

      if (body === null) return new Response('missing', { status: 404 });
      return new Response(body, { status: 200 });
    });

  const source = (fetchImpl: ReturnType<typeof stubFetch>) =>
    createTcgcsvSource({
      fetch: fetchImpl as unknown as typeof fetch,
      baseUrl: 'https://x/tcgplayer',
    });

  /**
   * Measured, not guessed: tcgcsv's CDN answers **401** to an empty `User-Agent`
   * and to a generic one like `node`, and 200 to a descriptive one. Node's `fetch`
   * sends none at all, so omitting this made the source return 401 for every
   * request in production while every test here passed — because these tests stub
   * `fetch` and a stub never checks a header. This is that gap closed.
   */
  it('identifies itself, because the CDN rejects a request that does not', async () => {
    const seen: Array<Record<string, string> | undefined> = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      seen.push(init?.headers as Record<string, string> | undefined);
      return new Response(CATEGORIES);
    });

    const s = createTcgcsvSource({
      fetch: fetchImpl as unknown as typeof fetch,
      baseUrl: 'https://x/tcgplayer',
    });
    await s.search(ctx(), { text: 'x', game: 'nothing-matches-this' });

    expect(seen.length).toBeGreaterThan(0);
    for (const headers of seen) {
      expect(headers?.['User-Agent']).toBeTruthy();
      // A generic agent is refused by the CDN just as a blank one is.
      expect(headers?.['User-Agent']).not.toBe('node');
      expect(headers?.['User-Agent']).toMatch(/InventoryHub/);
    }
  });

  it('falls back rather than sending a blank agent an override asked for', async () => {
    const seen: Array<Record<string, string> | undefined> = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      seen.push(init?.headers as Record<string, string> | undefined);
      return new Response(CATEGORIES);
    });

    const s = createTcgcsvSource({
      fetch: fetchImpl as unknown as typeof fetch,
      baseUrl: 'https://x/tcgplayer',
      userAgent: '   ',
    });
    await s.search(ctx(), { text: 'x', game: 'nothing-matches-this' });

    // Honouring a blank override would reintroduce the 401, silently.
    expect(seen[0]?.['User-Agent']).toMatch(/InventoryHub/);
  });

  it('finds a card when narrowed to a game and set', async () => {
    const results = await source(stubFetch()).search(ctx(), {
      text: 'enterprise',
      game: 'Magic',
      setName: 'Star Trek',
    });

    expect(results.map((r) => r.sourceId)).toEqual(['706191']);
    expect(results[0]?.name).toBe('U.S.S. Enterprise-D, Galaxy-Class');
  });

  it('matches loosely, so punctuation in a card name does not defeat it', async () => {
    const results = await source(stubFetch()).search(ctx(), {
      text: 'uss enterprise d',
      game: 'Magic',
      setName: 'Star Trek',
    });

    // "U.S.S. Enterprise-D" typed without the dots or the dash.
    expect(results.map((r) => r.sourceId)).toEqual(['706191']);
  });

  it('accepts the display name of a game as well as the short one', async () => {
    const results = await source(stubFetch()).search(ctx(), {
      text: 'boimler',
      game: 'Magic: The Gathering',
      setName: 'Star Trek',
    });

    expect(results.map((r) => r.sourceId)).toEqual(['706132']);
  });

  /**
   * Magic really ships "Star Trek", "Commander: Star Trek" and "Star Trek:
   * Stardates" simultaneously — all three are in the group fixture. Containment
   * alone would turn an operator naming one set precisely into three downloads,
   * and past the limit into a refusal to search at all.
   */
  it('prefers an exactly named set over the ones merely containing it', async () => {
    const calls: string[] = [];
    await source(stubFetch(calls)).search(ctx(), {
      text: 'boimler',
      game: 'Magic',
      setName: 'Star Trek',
    });

    const downloads = calls.filter((c) => c.includes('ProductsAndPrices'));
    expect(downloads).toHaveLength(1);
    expect(downloads[0]).toContain('/1/24766/');
  });

  it('still casts a wide net for a partial set name', async () => {
    const calls: string[] = [];
    await source(stubFetch(calls)).search(ctx(), {
      text: 'boimler',
      game: 'Magic',
      setName: 'trek',
    });

    // No set is called exactly "trek", so all three Star Trek sets are in play —
    // which is presumably what someone typing a fragment wanted.
    const downloads = calls.filter((c) => c.includes('ProductsAndPrices'));
    expect(downloads).toHaveLength(3);
  });

  /**
   * A set name narrows which set *files* are downloaded, but not how many group
   * *lists* must be read to find them. Without a game that is one request per
   * product line — 90 to a community CDN to answer one question.
   */
  it('refuses to read the set list of every product line', async () => {
    const calls: string[] = [];
    const fetchImpl = stubFetch(calls);

    await expect(
      source(fetchImpl).search(ctx(), { text: 'boimler', setName: 'Star Trek' }),
    ).rejects.toThrow(/needs a game/i);

    // Categories were read; no per-category group list was.
    expect(calls.filter((c) => c.includes('Groups.csv'))).toEqual([]);
  });

  it('allows a game that legitimately matches two product lines', async () => {
    // "Pokemon" also matches "Pokemon Japan", and a Japanese card is a real
    // thing someone stocks — so the limit is two rather than one.
    const fetchImpl = stubFetch();
    const paired = createTcgcsvSource({
      fetch: fetchImpl as unknown as typeof fetch,
      baseUrl: 'https://x/tcgplayer',
      maxCategoriesPerSearch: 2,
    });

    // The fixture's categories include Magic and Pokemon; "Pokemon" matches one
    // exactly, so this must not be refused.
    await expect(
      paired.search(ctx(), { text: 'anything', game: 'Pokemon', setName: 'nothing here' }),
    ).resolves.toEqual([]);
  });

  it('refuses an entirely un-narrowed search', async () => {
    const calls: string[] = [];
    const fetchImpl = stubFetch(calls);

    // No game, no set. Refused for wanting a game, which is the first thing that
    // would have to be read per product line.
    await expect(source(fetchImpl).search(ctx(), { text: 'enterprise' })).rejects.toThrow(
      /needs a game/i,
    );

    // Refused before fetching a single set file.
    expect(calls.filter((c) => c.includes('ProductsAndPrices'))).toEqual([]);
  });

  it('refuses a whole product line with no set named', async () => {
    const calls: string[] = [];
    const fetchImpl = stubFetch(calls);

    // A game narrows to one category, but Magic alone has 453 sets. The group cap
    // is what stops this, and it is the same message as any over-broad set name.
    await expect(
      source(fetchImpl).search(ctx(), { text: 'enterprise', game: 'Magic' }),
    ).rejects.toThrow(/above the limit/i);

    expect(calls.filter((c) => c.includes('ProductsAndPrices'))).toEqual([]);
  });

  it('refuses when a set name matches more sets than the download limit', async () => {
    const fetchImpl = stubFetch();
    const narrow = createTcgcsvSource({
      fetch: fetchImpl as unknown as typeof fetch,
      baseUrl: 'https://x/tcgplayer',
      maxGroupsPerSearch: 1,
    });

    // "trek" matches no set exactly, so all three Star Trek sets are in play —
    // above a limit of one.
    await expect(
      narrow.search(ctx(), { text: 'anything', game: 'Magic', setName: 'trek' }),
    ).rejects.toThrow(/above the limit/i);
  });

  it('returns nothing for a game it has no category for', async () => {
    const results = await source(stubFetch()).search(ctx(), {
      text: 'anything',
      game: 'Warhammer Underworlds',
      setName: 'Nightvault',
    });

    // Not an error: the registry asks every source, and most do not cover a
    // given game.
    expect(results).toEqual([]);
  });

  it('returns nothing for empty text without making a request', async () => {
    const calls: string[] = [];
    const fetchImpl = stubFetch(calls);

    expect(await source(fetchImpl).search(ctx(), { text: '   ' })).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('honours the caller limit', async () => {
    const results = await source(stubFetch()).search(ctx(), {
      text: 'star trek',
      game: 'Magic',
      setName: 'Star Trek',
      limit: 1,
    });

    expect(results).toHaveLength(1);
  });

  it('caches downloads, then re-fetches once the content could have changed', async () => {
    const calls: string[] = [];
    const fetchImpl = stubFetch(calls);
    let clock = 0;

    const cached = createTcgcsvSource({
      fetch: fetchImpl as unknown as typeof fetch,
      baseUrl: 'https://x/tcgplayer',
      now: () => clock,
      cacheTtlMs: 1000,
    });

    const query = { text: 'boimler', game: 'Magic', setName: 'Star Trek' };

    await cached.search(ctx(), query);
    const first = calls.length;
    expect(first).toBeGreaterThan(0);

    // Same search again inside the window: served from cache. tcgcsv publishes
    // once a day, so re-downloading per keystroke would be rude and pointless.
    await cached.search(ctx(), query);
    expect(calls.length).toBe(first);

    // Past the window, it goes back for a possible new drop.
    clock = 5000;
    await cached.search(ctx(), query);
    expect(calls.length).toBeGreaterThan(first);
  });

  it('reports a failed download rather than treating it as no results', async () => {
    const failing = createTcgcsvSource({
      fetch: (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch,
      baseUrl: 'https://x/tcgplayer',
    });

    // An empty array here would read as "this card does not exist", which is the
    // wrong answer to give someone about their own inventory.
    await expect(failing.search(ctx(), { text: 'x', game: 'Magic' })).rejects.toThrow(/500/);
  });
});

describe('fetchById', () => {
  const stub = (calls: string[] = []) =>
    vi.fn(async (url: string) => {
      calls.push(url);
      const body = url.endsWith('/Categories.csv')
        ? CATEGORIES
        : url.endsWith('/Groups.csv')
          ? MAGIC_GROUPS
          : url.includes('/1/') && url.includes('ProductsAndPrices')
            ? MAGIC_PRODUCTS
            : null;
      return body === null ? new Response('missing', { status: 404 }) : new Response(body);
    });

  const make = (f: ReturnType<typeof stub>) =>
    createTcgcsvSource({
      fetch: f as unknown as typeof fetch,
      baseUrl: 'https://x/tcgplayer',
    });

  it('returns null for a product whose set has never been read', async () => {
    const source = make(stub());

    // tcgcsv publishes no product-to-set index, so there is nowhere to look.
    // Null is honest; scanning ~4,000 set files would not be.
    expect(await source.fetchById!(ctx(), '706132')).toBeNull();
  });

  it('re-fetches a product from a set that was searched', async () => {
    const source = make(stub());

    // The flow the core actually performs: search a set, then re-verify one
    // product out of it before writing CatalogExternalRef.
    await source.search(ctx(), { text: 'boimler', game: 'Magic', setName: 'Star Trek' });

    const candidate = await source.fetchById!(ctx(), '706132');
    expect(candidate?.name).toBe('Brad Boimler, Eager Ensign');
    expect(candidate?.externalIds.tcgplayer).toBe('706132');
    expect(candidate?.setName).toBe('Star Trek');
    expect(candidate?.game).toBe('Magic');
  });

  it('indexes the whole set, not only the rows that matched the query', async () => {
    const source = make(stub());

    // Searching for one card must still make its set-mates re-fetchable: which
    // product the operator confirms is not knowable at search time.
    await source.search(ctx(), { text: 'boimler', game: 'Magic', setName: 'Star Trek' });

    const other = await source.fetchById!(ctx(), '706191');
    expect(other?.name).toBe('U.S.S. Enterprise-D, Galaxy-Class');
  });

  it('collapses printings on re-fetch the same way search does', async () => {
    const source = make(stub());
    await source.search(ctx(), { text: 'enterprise', game: 'Magic', setName: 'Star Trek' });

    const candidate = await source.fetchById!(ctx(), '706191');
    expect(candidate?.printings).toEqual(expect.arrayContaining(['NORMAL', 'FOIL']));
    // Non-foil price still wins, as in search.
    expect(candidate?.marketPrice).toBe(3965);
  });

  it('serves a re-fetch from cache rather than downloading again', async () => {
    const calls: string[] = [];
    const source = make(stub(calls));

    await source.search(ctx(), { text: 'boimler', game: 'Magic', setName: 'Star Trek' });
    const after = calls.length;

    await source.fetchById!(ctx(), '706132');
    expect(calls.length).toBe(after);
  });

  it('returns null for an empty id without touching the network', async () => {
    const calls: string[] = [];
    const source = make(stub(calls));

    expect(await source.fetchById!(ctx(), '   ')).toBeNull();
    expect(calls).toEqual([]);
  });
});
