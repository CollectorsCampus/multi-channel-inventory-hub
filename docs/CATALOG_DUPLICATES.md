# Duplicate catalog items — what causes them, and what to build

Spec, not a design that has been built. Written 2026-08-17 after the operator
reported "some show up twice" in catalogue search, and the repricing sweep
reported five sets tcgcsv could not name.

Those two symptoms have one cause and two different remedies; the reporting half
shipped separately (#141), and this is the other half.

## The cause, measured

`IntakeService.resolveCatalogItem` decides whether a candidate is a product the
catalogue already holds, and it matches on **external refs alone**:

```ts
const existing = await this.prisma.catalogExternalRef.findFirst({
  where: { OR: refs.map(([source, externalId]) => ({ source, externalId })) },
});
```

There is no name-and-set fallback, deliberately: two cards with the same name in
the same set are a real thing, and guessing they are one product is the split
this ledger exists to prevent — in the other direction.

So **two sources converge only if they share an id in some namespace.** That is
not luck, it is the design:

| Source pair                                               | Shared namespace                    | Converges?                           |
| --------------------------------------------------------- | ----------------------------------- | ------------------------------------ |
| tcgcsv ↔ Scryfall                                         | `tcgplayer` (Scryfall publishes it) | Usually                              |
| tcgcsv ↔ CardTrader                                       | `tcgplayer` (CardTrader publishes)  | Yes — 143/156 in one measured ingest |
| tcgcsv ↔ Palworld                                         | none                                | **No**                               |
| Scryfall ↔ anything, where Scryfall has no `tcgplayer_id` | none                                | **No**                               |

Scryfall's `tcgplayer_id` is not universal. It is absent from older printings,
and — the case the operator hit — from Secret Lair, Universes Within and very
new sets. A Magic card taken in through Scryfall with no TCGPlayer id becomes
its own catalog item, and if tcgcsv already had that card, the catalogue now
holds two.

Measured on a 2026-08-11 copy of production, for `game = 'Magic'`:

- **8,347** items with a tcgcsv/tcgplayer ref and no Scryfall ref
- **1** with both
- **1** with a Scryfall ref only
- **1** exact `(game, setName, name)` duplicate group

The counts are small because Magic intake through Scryfall started recently. It
is the growing case, not the historical one.

## Why the set names diverge too

The same event with a different symptom. A catalog item keeps the `setName` of
whichever source created it, and `refreshCatalogItem` is fill-empty-only, so it
is never relabelled. Scryfall and tcgcsv spell Magic sets differently:

| Scryfall                        | tcgcsv                                                    |
| ------------------------------- | --------------------------------------------------------- |
| Final Fantasy                   | `FINAL FANTASY`                                           |
| Doctor Who                      | `Universes Beyond: Doctor Who`                            |
| Tales of Middle-earth Commander | `Commander: The Lord of the Rings: Tales of Middle-earth` |
| Secret Lair Drop                | many separate `Secret Lair …` groups                      |
| Universes Within                | no tcgcsv group at all — a Scryfall-only concept          |

The repricing sweep resolves a tcgcsv set by exact `setName`, on a documented
assumption that "stored names came from that same listing so equality holds".
True while tcgcsv was the only thing creating Magic items. **#141 stopped this
being reported as a failure** when a later source prices the card anyway; it did
not make tcgcsv able to find the set.

## What to build

### 1. Detection — a report, never an automatic merge

A duplicate is two catalog items that are one real product. Merging them moves
SKUs, allocations, stock movements and possibly live listing links between rows.
That is not a thing to do on a heuristic. **Find them, rank them, and let the
operator merge deliberately** — the same discipline as `propose`/`confirm` in
matching, which never resolves a tie.

Signals, strongest first:

1. **Same collector number in the same game.** tcgcsv carries it in
   `TcgcsvProductRow.extended.extNumber`, Scryfall in `collector_number`,
   Bushiroad in `card_number` — but **none of it is stored**: `toCandidates`
   drops `extended`, `CatalogCandidate` has no field and `CatalogItem` has no
   column. This is the same gap the "collector numbers in a title" note records,
   and the same migration would serve both. Strongest signal, needs the most
   work.
2. **Normalised name equality within a game**, with set names compared through a
   known alias map. `normalizeForMatch` in the web app already does the name
   half; the set half is the table above, which is data, not a rule.
3. **Same image URL.** Cheap, and a genuine signal when two sources happen to
   mirror the same CDN. Weak on its own.

Report each group with what each side carries — refs, set name, SKU count,
allocation count — because which row to keep is decided by what is attached to
it, not by which is "right".

### 2. Merge — explicit, and refusing what it cannot do safely

Keep one item, move everything to it, delete the other:

- Move `Sku` rows, unless the target already has a SKU with the same natural key
  (`condition`+`printing`+`language`). Where both do, the SKUs themselves need
  merging, which moves inventory — **refuse and report** rather than guess.
- Union the external refs. `addMissingRefs` already handles a ref colliding with
  a different item, and already raises a flag for it.
- Keep the target's `name`/`setName`. Immutable-after-creation is the existing
  rule and merging is not a reason to break it.
- Record it. A merge is not recoverable by re-running anything.

### 3. Prevention — worth doing first, and cheaper

Storing the collector number would let intake converge on it as well as on refs,
which stops most future duplicates rather than cleaning them up afterwards. It
is one nullable column, plumbed through `CatalogCandidate` and three sources.

Note it does **not** subsume refs: a collector number is unique within a set, so
it needs the set to be comparable, and set names are exactly what diverges. It
narrows the problem rather than closing it.

## What not to do

- **Do not auto-merge on name similarity.** Reprints, alternate arts and
  same-named cards across sets make this wrong often enough to corrupt stock.
- **Do not relabel set names to one source's spelling.** That was tried by
  accident when CardTrader ingested over tcgcsv items and silently re-spelled
  143 of them, which is why `refreshCatalogItem` is fill-empty-only.
- **Do not treat a tcgcsv set miss as the bug.** It is a symptom. #141 made the
  reporting honest; the fix is convergence, not louder errors.
