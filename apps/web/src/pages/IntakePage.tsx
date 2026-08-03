import { useEffect, useRef, useState, type Ref } from 'react';
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
import { enlargedImageUrl } from '../cardImage';
import { previewTags } from '../tagSuggest';

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
  /**
   * Kept apart from `selected` on purpose: examining a card is how you decide
   * whether to pick it, so looking must not commit you to it. Closing the
   * viewer leaves the selection exactly as it was.
   */
  const [zoomed, setZoomed] = useState<CatalogCandidate | null>(null);

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
            <li key={`${candidate.sourceKey}:${candidate.sourceId}`} className="candidate-row">
              {/* The art is its own button, outside the one that selects.
                  Nesting them would be invalid HTML and would give the row two
                  competing activations for one keyboard Enter — and the whole
                  point is that looking closely and choosing are different acts.
                  A candidate with no art gets a spacer so the rows still line
                  up; a ragged left edge in a list you are scanning is worse
                  than an empty box. */}
              {candidate.imageUrl ? (
                <button
                  type="button"
                  className="candidate-art"
                  onClick={() => setZoomed(candidate)}
                  aria-label={`Enlarge the picture of ${candidate.name}`}
                  title="Click to enlarge"
                >
                  <img src={candidate.imageUrl} alt="" width={44} height={61} loading="lazy" />
                </button>
              ) : (
                <span className="candidate-art candidate-art-empty" aria-hidden="true" />
              )}

              <button
                type="button"
                className={`candidate${selected?.sourceId === candidate.sourceId ? ' candidate-selected' : ''}`}
                onClick={() => setSelected(candidate)}
              >
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

      {zoomed && <CardViewer candidate={zoomed} onClose={() => setZoomed(null)} />}
    </section>
  );
}

/**
 * The card, big enough to actually check — and the place you add it from.
 *
 * The reason this exists: at 44px you can tell a card from a booster box and
 * nothing else, and the question being asked is "is this the right printing" —
 * which is decided by art, set symbol and collector number.
 *
 * ## The form is here, not just a "choose this" button
 *
 * Looking at the card and saying what you have are the *same* decision: the art
 * is how you tell 013/094 from 130/094, and the condition and printing you then
 * enter describe that exact copy. Sending the operator back to a form further
 * down the page to type them would put the picture out of view at the moment it
 * is most needed.
 *
 * It is the **same** `IntakeForm` the page renders below, not a second copy —
 * two forms writing stock would eventually disagree about defaults, validation
 * or which channel to list on.
 *
 * ## Resolution is the whole feature
 *
 * Showing the *stored* URL larger would be pointless for most of the
 * catalogue: tcgcsv's images are 200 pixels wide, and scaling one to card size
 * is a blur that answers nothing. `enlargedImageUrl` swaps in a bigger variant
 * where the source publishes one, and `onError` falls back to the stored URL —
 * so an unknown host or a changed CDN degrades to what would have been shown
 * anyway rather than to a broken image.
 */
function CardViewer({ candidate, onClose }: { candidate: CatalogCandidate; onClose: () => void }) {
  const [src, setSrc] = useState(() => enlargedImageUrl(candidate.imageUrl) ?? candidate.imageUrl);
  const closeButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setSrc(enlargedImageUrl(candidate.imageUrl) ?? candidate.imageUrl);
  }, [candidate.imageUrl]);

  // Escape closes, and focus moves into the overlay so that Escape reaches it
  // and Tab does not wander back into the list behind.
  //
  // Focus is then handed back to whatever opened this. Without that it drops to
  // <body>, and a keyboard user comparing four printings of one card loses
  // their place in the list every time they close the viewer — which is exactly
  // the task the viewer exists for.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeButton.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      // Only if it is still in the document: choosing this card replaces the
      // list, and focusing a detached node silently does nothing.
      if (opener?.isConnected) opener.focus();
    };
  }, [onClose]);

  return (
    <div
      className="viewer-backdrop"
      role="presentation"
      // Only a click on the backdrop itself, never one that bubbled up from the
      // picture — otherwise looking closely at the card dismisses it.
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="viewer" role="dialog" aria-modal="true" aria-label={candidate.name}>
        <img
          className="viewer-art"
          src={src ?? undefined}
          alt={candidate.name}
          onError={() => {
            // The enlarged variant did not resolve. Fall back once, to the URL
            // the catalogue actually stores.
            if (src !== candidate.imageUrl) setSrc(candidate.imageUrl);
          }}
        />

        <div className="viewer-meta">
          <h3>{candidate.name}</h3>
          <p className="muted">
            {[candidate.setName, candidate.game].filter(Boolean).join(' · ') || 'No set recorded'}
          </p>
          {candidate.marketPrice !== undefined && (
            <p className="muted">Market {formatPrice(candidate.marketPrice)}</p>
          )}

          {/* Stays open after a successful add, deliberately: a playset is
              often several conditions of one card, and closing would mean
              finding the same row again for each. Close is explicit. */}
          <IntakeForm candidate={candidate} onDone={onClose} embedded closeRef={closeButton} />
        </div>
      </div>
    </div>
  );
}

/**
 * Say what you have, and put it in the ledger.
 *
 * Rendered in two places and deliberately one component: below the results when
 * a row is selected, and inside the enlarged card. Two copies would drift on
 * defaults, validation or which channel to list on, and the drift would show up
 * as stock added one way behaving differently from stock added the other.
 *
 * `embedded` drops the panel chrome — inside a dialog the card's own heading is
 * already the title, and a second `<h2>` repeating the name is noise. It also
 * stacks the fields, because the dialog column is far narrower than the panel
 * and a wrapping row there breaks into unreadable fragments.
 */
function IntakeForm({
  candidate,
  onDone,
  embedded = false,
  closeRef,
}: {
  candidate: CatalogCandidate;
  onDone: () => void;
  embedded?: boolean;
  /** So the dialog can put initial focus on a control inside its own form. */
  closeRef?: Ref<HTMLButtonElement>;
}) {
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

  /**
   * Both copies of this form can be on screen at once — a row is selected below
   * while the enlarged card is open above — so the ids must not collide.
   * Duplicate ids do not fail loudly: the label just focuses whichever control
   * the document happens to reach first, which is the one behind the dialog.
   */
  const fieldId = (name: string) => (embedded ? `dialog-${name}` : name);

  return (
    <div className={embedded ? 'embedded-intake' : 'panel'}>
      {!embedded && <h2>Add {candidate.name}</h2>}

      {/* ADR 0002: coverage is incomplete, and this matters later when matching
          a TCGPlayer listing back to this item. */}
      {missingTcgplayer && (
        <p className="muted">
          This printing has no TCGPlayer id in the catalog. It can still be tracked and sold;
          matching it to a TCGPlayer listing will need doing by hand.
        </p>
      )}

      <form
        className={embedded ? 'stacked-form' : 'inline-form'}
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
        <label htmlFor={fieldId('condition')}>Condition</label>
        <select
          id={fieldId('condition')}
          value={condition}
          onChange={(e) => setCondition(e.target.value)}
        >
          {SKU_CONDITIONS.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>

        <label htmlFor={fieldId('printing')}>Printing</label>
        <select
          id={fieldId('printing')}
          value={printing}
          onChange={(e) => setPrinting(e.target.value)}
        >
          {printings.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>

        <label htmlFor={fieldId('quantity')}>Quantity</label>
        <input
          id={fieldId('quantity')}
          type="number"
          min={1}
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
        />

        <label htmlFor={fieldId('cost')}>Unit cost</label>
        <input
          id={fieldId('cost')}
          type="number"
          step="0.01"
          min={0}
          placeholder="optional"
          value={cost}
          onChange={(e) => setCost(e.target.value)}
        />

        {listable.length > 0 && (
          <>
            <label htmlFor={fieldId('list-on')}>List on</label>
            <select
              id={fieldId('list-on')}
              value={listOn}
              onChange={(e) => setListOn(e.target.value)}
            >
              <option value="">Nowhere — just add to inventory</option>
              {listable.map((channel) => (
                <option key={channel.id} value={channel.id}>
                  {channel.displayName}
                </option>
              ))}
            </select>
          </>
        )}

        <div className="form-actions">
          <button type="submit" disabled={pending}>
            {pending ? 'Adding…' : listOn ? 'Add and list' : 'Add to inventory'}
          </button>
          {/* "Close" in the dialog, "Done" in the panel: the same action, but in
              a dialog "Done" reads as "finish and save" and this saves nothing. */}
          <button type="button" className="ghost" onClick={onDone} ref={closeRef}>
            {embedded ? 'Close' : 'Done'}
          </button>
        </div>
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
              {listedChannel && describeDefaults(listedChannel, candidate)}. Stock follows on its
              own, and nothing becomes buyable until you publish it. These apply to every card added
              this way — for a mixed batch, use the list screen, which chooses per run.
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
  const { tags, tagRules, metafields, category, vendor } = channel.listingDefaults;
  // `tagRules` is the usual way to configure a channel now, so leaving it out
  // meant a fully configured channel was silently never offered here.
  return (
    tags !== undefined ||
    tagRules !== undefined ||
    metafields !== undefined ||
    category !== undefined ||
    vendor !== undefined
  );
}

/**
 * Name what this *particular* card will carry, in the operator's own words.
 *
 * Per card rather than per channel, because that is now what the answer depends
 * on: the channel's rules decide which tags apply, and a Pokémon card and a
 * Magic card added in the same session get different ones. Showing the
 * channel's whole configuration instead would be describing something that is
 * not about to happen.
 *
 * Counts rather than values for the custom fields: those are opaque platform
 * ids that would tell a reader nothing. Tags are shown in full because they
 * decide whether the product appears in the shop at all.
 */
function describeDefaults(channel: Channel, candidate: CatalogCandidate): string {
  const { tagRules, tags, metafields, vendor } = channel.listingDefaults;
  const parts: string[] = [];

  const applied = previewTags(tagRules ?? [], tags ?? [], {
    name: candidate.name,
    game: candidate.game,
    setName: candidate.setName,
  });

  if (applied.length > 0) parts.push(`tagged ${applied.join(', ')}`);
  // Not the same as "no rules configured" — this card matched none of them, and
  // an untagged product is in no collection, which nothing else would report.
  else parts.push('with no tags — no rule matches this card');

  if (vendor) parts.push(`vendor ${vendor}`);
  if (metafields?.length) parts.push(`${metafields.length} custom field(s)`);

  return `, ${parts.join(' · ')}`;
}
