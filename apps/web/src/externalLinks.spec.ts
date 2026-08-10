import { describe, expect, it } from 'vitest';
import { externalLinks } from './externalLinks';

describe('externalLinks', () => {
  it('links each verified namespace', () => {
    expect(
      externalLinks({
        tcgplayer: '656259',
        scryfall: 'e3285e6b-3e79-4d7c-bf96-d920f973b122',
        cardtrader: '57957',
      }),
    ).toEqual([
      { label: 'TCGplayer', url: 'https://www.tcgplayer.com/product/656259' },
      { label: 'Scryfall', url: 'https://scryfall.com/card/e3285e6b-3e79-4d7c-bf96-d920f973b122' },
      { label: 'CardTrader', url: 'https://www.cardtrader.com/en/cards/57957' },
    ]);
  });

  /**
   * tcgcsv republishes TCGPlayer's catalogue in the same id space, and most
   * ingested items carry both refs. Two links to one page is noise.
   */
  it('collapses tcgplayer and tcgcsv into one link', () => {
    const links = externalLinks({ tcgplayer: '656259', tcgcsv: '656259' });
    expect(links).toHaveLength(1);
    expect(links[0]!.url).toBe('https://www.tcgplayer.com/product/656259');
  });

  it('links a tcgcsv-only item to TCGplayer, since the ids are theirs', () => {
    expect(externalLinks({ tcgcsv: '593559' })).toEqual([
      { label: 'TCGplayer', url: 'https://www.tcgplayer.com/product/593559' },
    ]);
  });

  it('offers nothing for namespaces with no public page', () => {
    expect(externalLinks({ hub: 'some-sku-uuid', cardmarket: '377187' })).toEqual([]);
  });

  it('skips blank ids rather than building a link to nothing', () => {
    expect(externalLinks({ tcgplayer: '  ' })).toEqual([]);
  });

  it('escapes an id that is not URL-safe', () => {
    expect(externalLinks({ scryfall: 'a/b' })[0]!.url).toBe('https://scryfall.com/card/a%2Fb');
  });
});
