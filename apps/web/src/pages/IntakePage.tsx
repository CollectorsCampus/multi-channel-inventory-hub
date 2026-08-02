import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import {
  useCatalogSearch,
  useCatalogSources,
  useIntake,
  useLocalSets,
  type CatalogCandidate,
} from '../api/catalog';
import { formatPrice } from '../api/inventory';
import { useChannels, type Channel } from '../api/channels';
import { describeOutcome, useIntakeAndList } from '../api/listings';
import { SKU_CONDITIONS } from '../constants';

/**
 * Intake: search the catalog, pick a printing, add stock (§7).
 *
 * Stock lands unallocated — where it goes is a separate decision, made in the
 * allocation editor.
 */
export function IntakePage() {
  const sources = useCatalogSources();
  const [text, setText] = useState('');
  const [debounced, setDebounced] = useState('');
  const [game, setGame] = useState('');
  const [setName, setSetName] = useState('');
  const [selected, setSelected] = useState<CatalogCandidate | null>(null);

  // Catalog sources sit behind someone else's rate limits; do not query them
  // on every keystroke.
  useEffect(() => {
    const handle = setTimeout(() => setDebounced(text), 350);
    return () => clearTimeout(handle);
  }, [text]);

  const search = useCatalogSearch(debounced, game || undefined, setName || undefined);

  /**
   * Every set the local catalog holds — fetched unfiltered, then narrowed here.
   *
   * Deliberately not `useLocalSets(game)`: the game suggestions are derived
   * from this list, so filtering it by the chosen game would collapse those
   * suggestions to the one already chosen the moment anything was typed.
   */
  const localSets = useLocalSets();
  const heldSets = localSets.data ?? [];

  /**
   * Games to suggest: what the sources declare, plus what has been ingested.
   *
   * Neither alone is enough. Scryfall declares Magic and tcgcsv declares
   * nothing, so the declared list is nearly empty — while the local catalog
   * knows Pokemon, Lorcana and One Piece because someone ingested them.
   */
  const gameSuggestions = [
    ...new Set([
      ...(sources.data ?? []).flatMap((s) => s.games),
      ...heldSets.flatMap((s) => (s.game ? [s.game] : [])),
    ]),
  ].sort();

  const setSuggestions = game
    ? heldSets.filter((s) => s.game?.toLowerCase() === game.trim().toLowerCase())
    : heldSets;

  return (
    <section>
      <header className="page-head">
        <div>
          <Link to="/" className="back">
            ← Inventory
          </Link>
          <h1>Add stock</h1>
          <p className="muted">Search the catalog, then add units. They land unallocated.</p>
        </div>
      </header>

      <div className="panel">
        <div className="filters">
          <input
            type="search"
            autoFocus
            placeholder="Search for a card…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            aria-label="Search the catalog"
          />
          {/* Free text with suggestions, and shown unconditionally.
              Previously a `<select>` that appeared only when the registered
              sources between them declared more than one game — and they do
              not: Scryfall declares Magic, tcgcsv declares none because it
              covers ninety product lines it cannot enumerate up front. So the
              field vanished, and the one source that *needs* a game had no way
              to be given one. The same reasoning, and the same solution, as the
              game field on the match screen. */}
          <input
            type="text"
            list="intake-games"
            placeholder="Game — e.g. Pokemon"
            value={game}
            onChange={(e) => setGame(e.target.value)}
            aria-label="Game"
          />
          <datalist id="intake-games">
            {gameSuggestions.map((g) => (
              <option key={g} value={g} />
            ))}
          </datalist>

          {/* Some sources cannot answer without a set. tcgcsv is static files
              with no search endpoint, so an unscoped query would mean
              downloading a whole category; it says so rather than returning a
              fraction of the matches.

              Suggestions come from the local catalog, which is the only place
              that knows how a set is actually spelled — and spelling is the
              whole difficulty: the same set is "ME02: Phantasmal Flames" to a
              source and "Phantasmal Flames" on the box. Still free text,
              because a set nobody has ingested must remain typeable. */}
          <input
            type="text"
            list="intake-sets"
            placeholder="Set — needed by some sources"
            value={setName}
            onChange={(e) => setSetName(e.target.value)}
            aria-label="Set"
          />
          <datalist id="intake-sets">
            {setSuggestions.map((s) => (
              <option key={`${s.game ?? ''}:${s.setName}`} value={s.setName}>
                {s.game ? `${s.game} · ${s.items} items` : `${s.items} items`}
              </option>
            ))}
          </datalist>
        </div>

        <p className="field-hint">
          A game narrows the search and some sources refuse without one. The set box suggests what
          the local catalog holds, but anything can be typed — it is passed to the sources as you
          spell it.
        </p>

        {sources.data?.length === 0 && (
          <p className="muted">No catalog sources are registered on this instance.</p>
        )}

        {text.trim().length > 0 && text.trim().length < 3 && <p className="muted">Keep typing…</p>}

        {search.isFetching && <p className="muted">Searching…</p>}

        {search.isError && <p className="error">{(search.error as Error).message}</p>}

        {/* A source being down must not hide the results that did come back —
            and must not look like the search failed either. One source of
            several declining is a notice, not an error, and styling it red
            beside a list of perfectly good results reads as "this is broken".
            The source's own explanation is folded away: it is usually a
            sentence about that source's internals, which matters only to
            someone who wants results from it specifically. */}
        {(search.data?.failures.length ?? 0) > 0 && (
          <details className="quiet-details">
            <summary>
              {search.data!.failures.map((f) => f.sourceKey).join(', ')} did not answer — these
              results are from the other sources
            </summary>
            {search.data!.failures.map((failure) => (
              <p key={failure.sourceKey} className="field-hint">
                <strong>{failure.sourceKey}:</strong> {failure.message}
              </p>
            ))}
          </details>
        )}

        {search.data && search.data.candidates.length === 0 && !search.isFetching && (
          <p className="muted">Nothing matched.</p>
        )}

        <ul className="candidates">
          {search.data?.candidates.map((candidate) => (
            <li key={`${candidate.sourceKey}:${candidate.sourceId}`}>
              <button
                type="button"
                className={`candidate${selected?.sourceId === candidate.sourceId ? ' candidate-selected' : ''}`}
                onClick={() => setSelected(candidate)}
              >
                {candidate.imageUrl && (
                  <img src={candidate.imageUrl} alt="" width={44} height={61} loading="lazy" />
                )}
                <span className="candidate-body">
                  <span className="cell-title">{candidate.name}</span>
                  <span className="cell-sub">
                    {[candidate.setName, candidate.game].filter(Boolean).join(' · ')}
                  </span>
                  <span className="chips">
                    {Object.keys(candidate.externalIds).map((namespace) => (
                      <span key={namespace} className="chip">
                        {namespace}
                      </span>
                    ))}
                  </span>
                </span>
                {candidate.marketPrice !== undefined && (
                  <span className="muted">{formatPrice(candidate.marketPrice)}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </div>

      {selected && <IntakeForm candidate={selected} onDone={() => setSelected(null)} />}
    </section>
  );
}

function IntakeForm({ candidate, onDone }: { candidate: CatalogCandidate; onDone: () => void }) {
  const printings = candidate.printings ?? ['NORMAL'];

  /**
   * Channels this stock could be listed on as it is taken in.
   *
   * Only ones that can actually create a listing and have said what a created
   * product should carry. A channel offered here that then refuses would put
   * the failure after the operator has already committed stock — and the
   * refusal is deliberate, so it is better never to offer it.
   */
  const channels = useChannels();
  const listable = (channels.data ?? []).filter(
    (c) => c.enabled && c.capabilities.includes('listing.create') && hasDeclaredDefaults(c),
  );

  /**
   * Which channel to list on, or none. Seeded from the channel's own
   * `autoListNewStock`, so the toggle is a default rather than a decision taken
   * away — the operator can still clear it for one card without changing the
   * channel.
   */
  const [listOn, setListOn] = useState('');
  const autoChannel = listable.find((c) => c.autoListNewStock);
  const listedChannel = listable.find((c) => c.id === listOn);

  useEffect(() => {
    if (autoChannel && listOn === '') setListOn(autoChannel.id);
  }, [autoChannel, listOn]);

  const [condition, setCondition] = useState('NM');
  const [printing, setPrinting] = useState(printings[0] ?? 'NORMAL');
  const [quantity, setQuantity] = useState('1');
  const [cost, setCost] = useState('');

  const intake = useIntake();
  const intakeAndList = useIntakeAndList(listOn);
  const pending = intake.isPending || intakeAndList.isPending;
  const failure = (intake.error ?? intakeAndList.error) as Error | null;

  useEffect(() => {
    setPrinting(candidate.printings?.[0] ?? 'NORMAL');
    setQuantity('1');
    setCost('');
    intake.reset();
    intakeAndList.reset();
    // Resetting when the operator picks a different card; the mutation objects
    // themselves are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidate.sourceKey, candidate.sourceId]);

  const missingTcgplayer = !candidate.externalIds.tcgplayer;

  return (
    <div className="panel">
      <h2>Add {candidate.name}</h2>

      {/* ADR 0002: coverage is incomplete, and this matters later when matching
          a TCGPlayer listing back to this item. */}
      {missingTcgplayer && (
        <p className="muted">
          This printing has no TCGPlayer id in the catalog. It can still be tracked and sold;
          matching it to a TCGPlayer listing will need doing by hand.
        </p>
      )}

      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          const body = {
            sourceKey: candidate.sourceKey,
            sourceId: candidate.sourceId,
            condition,
            printing,
            language: candidate.language,
            quantity: Number(quantity) || 0,
            ...(cost === '' ? {} : { costBasis: Math.round(Number(cost) * 100) }),
          };
          const done = { onSuccess: () => setQuantity('1') };

          // Two endpoints rather than one with a nullable channel: listing on
          // no channel is plain intake, and routing it through the channel path
          // would mean inventing a channel id to ignore.
          if (listOn) intakeAndList.mutate(body, done);
          else intake.mutate(body, done);
        }}
      >
        <label htmlFor="condition">Condition</label>
        <select id="condition" value={condition} onChange={(e) => setCondition(e.target.value)}>
          {SKU_CONDITIONS.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>

        <label htmlFor="printing">Printing</label>
        <select id="printing" value={printing} onChange={(e) => setPrinting(e.target.value)}>
          {printings.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>

        <label htmlFor="quantity">Quantity</label>
        <input
          id="quantity"
          type="number"
          min={1}
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
        />

        <label htmlFor="cost">Unit cost</label>
        <input
          id="cost"
          type="number"
          step="0.01"
          min={0}
          placeholder="optional"
          value={cost}
          onChange={(e) => setCost(e.target.value)}
        />

        {listable.length > 0 && (
          <>
            <label htmlFor="list-on">List on</label>
            <select id="list-on" value={listOn} onChange={(e) => setListOn(e.target.value)}>
              <option value="">Nowhere — just add to inventory</option>
              {listable.map((channel) => (
                <option key={channel.id} value={channel.id}>
                  {channel.displayName}
                </option>
              ))}
            </select>
          </>
        )}

        <button type="submit" disabled={pending}>
          {pending ? 'Adding…' : listOn ? 'Add and list' : 'Add to inventory'}
        </button>
        <button type="button" className="ghost" onClick={onDone}>
          Done
        </button>
      </form>

      {/* The defaults are shown rather than described, and that is the point.
          They are one fixed set applied to *every* card listed this way — so a
          Magic card added while the channel says "Pokémon" would be tagged
          Pokémon, land in the wrong collection, and nothing would report it.
          Naming them here makes that visible before the card is added instead
          of after. Listing a mixed batch belongs on /list, which picks per run. */}
      {listable.length > 0 && (
        <p className="field-hint">
          {listOn ? (
            <>
              Created as a draft
              {listedChannel && describeDefaults(listedChannel)}. Stock follows on its own, and
              nothing becomes buyable until you publish it. These apply to every card added this way
              — for a mixed batch, use the list screen, which chooses per run.
            </>
          ) : (
            'Stock lands unallocated. You can list it later from the item or the list screen.'
          )}
        </p>
      )}

      {/* A channel that *can* create but has been told nothing is deliberately
          not offered above, and saying so is the difference between a missing
          feature and one step of setup. Without this the select simply has
          fewer options than the operator expects, with nothing to explain it. */}
      {channels.data?.some(
        (c) => c.enabled && c.capabilities.includes('listing.create') && !hasDeclaredDefaults(c),
      ) && (
        <p className="field-hint">
          Some channels are not offered because they have no listing defaults yet — the tags, custom
          fields and category a created product should carry. Set them on the channel first; the hub
          applies them verbatim and will not guess one.
        </p>
      )}

      {failure && <p className="error">{failure.message}</p>}

      {intake.isSuccess && intake.data && (
        <p className="muted">
          Added. Now holding <strong>{intake.data.ledger.quantityOnHand}</strong>, all unallocated.{' '}
          <Link to="/items/$id" params={{ id: intake.data.ledger.inventoryItemId }}>
            Open item
          </Link>
        </p>
      )}

      {/* The intake half is reported even when the listing half failed, because
          it happened: the stock is on the shelf either way, and saying only
          "could not list" would leave the operator wondering whether to add it
          again. */}
      {intakeAndList.isSuccess && intakeAndList.data && (
        <>
          <p className="muted">
            Added. Now holding <strong>{intakeAndList.data.intake.ledger.quantityOnHand}</strong>.{' '}
            <Link to="/items/$id" params={{ id: intakeAndList.data.intake.ledger.inventoryItemId }}>
              Open item
            </Link>
          </p>

          {intakeAndList.data.listing.listings.map((listing) => (
            <p key={listing.externalListingId} className="muted">
              Listed as <strong>{describeOutcome(listing.outcome)}</strong> · SKU{' '}
              <code>{listing.sku}</code>
            </p>
          ))}

          {intakeAndList.data.listing.problems.map((problem) => (
            <p key={problem.inventoryItemId + problem.message} className="error">
              Added to inventory, but not listed: {problem.message}
            </p>
          ))}
        </>
      )}
    </div>
  );
}

/**
 * Has this channel been told what a created product should carry?
 *
 * Mirrors `hasDeclaredDefaults` on the server, and for the same reason: an
 * empty declaration means the hub would have to invent tags, and on a store
 * whose collections are all tag rules an invented tag produces a product that
 * is invisible in the shop and reported by nothing.
 */
function hasDeclaredDefaults(channel: Channel): boolean {
  const { tags, metafields, category, vendor } = channel.listingDefaults;
  return (
    tags !== undefined || metafields !== undefined || category !== undefined || vendor !== undefined
  );
}

/**
 * Name what a created product will carry, in the operator's own words.
 *
 * Counts rather than values for the custom fields: those are opaque platform
 * ids that would tell a reader nothing. Tags are shown in full because they are
 * the ones that decide whether the product appears in the shop at all, and the
 * ones most likely to be wrong for the card in hand.
 */
function describeDefaults(channel: Channel): string {
  const { tags, metafields, vendor } = channel.listingDefaults;
  const parts: string[] = [];

  // An explicit empty list is an answer, and a different one from "unset" —
  // saying so out loud is what stops it reading as a bug.
  if (tags?.length) parts.push(`tagged ${tags.join(', ')}`);
  else if (tags) parts.push('with no tags');

  if (vendor) parts.push(`vendor ${vendor}`);
  if (metafields?.length) parts.push(`${metafields.length} custom field(s)`);

  return parts.length > 0 ? `, ${parts.join(' · ')}` : '';
}
