import { useEffect, useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useCatalogSources } from '../api/catalog';
import { useChannels } from '../api/channels';
import { formatPrice } from '../api/inventory';
import {
  describeReason,
  useConfirmMatches,
  useProposeMatches,
  type ConfirmLink,
  type MatchCandidate,
  type MatchProposal,
} from '../api/matching';
import { SKU_CONDITIONS } from '../constants';

/**
 * Link a channel's existing listings to inventory, one set at a time (§7).
 *
 * ## Why one set
 *
 * Thirteen hundred proposals in one screen do not get reviewed — they get
 * accepted wholesale, which defeats the point of proposing. One set is a few
 * dozen rows, small enough that someone reads the weak ones.
 *
 * ## What the screen refuses to do
 *
 * Nothing is accepted for the operator. A `certain` match — an exact barcode or
 * platform id — can be swept up by "select all certain", because that evidence is
 * an identity rather than a resemblance. Everything below it is a per-row
 * decision, and an ambiguous proposal cannot be accepted at all until one of its
 * candidates is picked. That is the same rule the condition parser follows: a
 * wrong link points stock at the wrong listing, and the mistake shows up days
 * later as drift nobody can explain.
 */
export function MatchPage() {
  const channels = useChannels();
  const sources = useCatalogSources();
  const propose = useProposeMatches();

  const [channelId, setChannelId] = useState('');
  const [sourceKey, setSourceKey] = useState('');
  const [game, setGame] = useState('');
  const [setName, setSetName] = useState('');

  // Only channels that can say what they are already selling. A file-based
  // channel is matched through its import instead, so offering it here would be
  // an invitation to an error message.
  const matchable = (channels.data ?? []).filter((c) =>
    c.capabilities.includes('listing.enumerate'),
  );

  const games = [...new Set((sources.data ?? []).flatMap((s) => s.games))];

  useEffect(() => {
    if (!channelId && matchable[0]) setChannelId(matchable[0].id);
    if (!sourceKey && sources.data?.[0]) setSourceKey(sources.data[0].key);
  }, [channelId, sourceKey, matchable, sources.data]);

  const canPropose = channelId !== '' && sourceKey !== '' && setName.trim() !== '';

  return (
    <section>
      <header className="page-head">
        <div>
          <Link to="/channels" className="back">
            ← Channels
          </Link>
          <h1>Match listings</h1>
          <p className="muted">
            Link listings that already exist on a channel to inventory. Proposals only — nothing is
            saved until you confirm.
          </p>
        </div>
      </header>

      <div className="panel">
        {channels.isSuccess && matchable.length === 0 && (
          <p className="muted">
            No channel here can list what it is already selling. Add a Shopify channel, or match a
            file-based channel through its inventory import on the{' '}
            <Link to="/channels">channels page</Link>.
          </p>
        )}

        <form
          className="filters"
          onSubmit={(e) => {
            e.preventDefault();
            if (!canPropose) return;
            propose.mutate({
              channelInstanceId: channelId,
              sourceKey,
              setName: setName.trim(),
              ...(game ? { game } : {}),
            });
          }}
        >
          <select
            value={channelId}
            onChange={(e) => setChannelId(e.target.value)}
            aria-label="Channel"
          >
            {matchable.map((c) => (
              <option key={c.id} value={c.id}>
                {c.displayName}
              </option>
            ))}
          </select>

          <select
            value={sourceKey}
            onChange={(e) => setSourceKey(e.target.value)}
            aria-label="Catalog source"
          >
            {(sources.data ?? []).map((s) => (
              <option key={s.key} value={s.key}>
                {s.displayName}
              </option>
            ))}
          </select>

          {/* Free text with suggestions, not a select. Sources that declare their
              games get listed, but tcgcsv covers 90 product lines and declares
              none — the list is fetched at runtime, so it cannot be compiled in.
              A select built from declared games would offer "Magic" only and
              leave Pokemon untypeable. */}
          <input
            type="text"
            list="match-games"
            placeholder="Game — e.g. Pokemon"
            value={game}
            onChange={(e) => setGame(e.target.value)}
            aria-label="Game"
          />
          <datalist id="match-games">
            {games.map((g) => (
              <option key={g} value={g} />
            ))}
          </datalist>

          <input
            type="text"
            placeholder="Set — required"
            value={setName}
            onChange={(e) => setSetName(e.target.value)}
            aria-label="Set"
          />

          <button type="submit" disabled={!canPropose || propose.isPending}>
            {propose.isPending ? 'Proposing…' : 'Propose matches'}
          </button>
        </form>

        <p className="field-hint">
          A set is required, and a game is strongly advised. Without a set this would download a
          whole product line to answer one question; without a game, some sources have to read the
          set list of every product line they carry.
        </p>

        {propose.isError && <p className="error">{(propose.error as Error).message}</p>}
      </div>

      {propose.isSuccess && propose.data && (
        <ReviewList
          key={`${channelId}:${setName}`}
          channelId={channelId}
          sourceKey={sourceKey}
          result={propose.data}
        />
      )}
    </section>
  );
}

interface Decision {
  accepted: boolean;
  /** Which candidate, for an ambiguous proposal. */
  targetId?: string;
  condition: string;
  printing?: string;
  language?: string;
}

function ReviewList({
  channelId,
  sourceKey,
  result,
}: {
  channelId: string;
  sourceKey: string;
  result: NonNullable<ReturnType<typeof useProposeMatches>['data']>;
}) {
  const confirm = useConfirmMatches(channelId);
  // Off by default and deliberately not remembered between runs: it overwrites
  // whatever the seller already had in that field.
  const [writeSku, setWriteSku] = useState(false);

  // Keyed by listing id. Seeded from what the listing title implied, which is an
  // offer rather than an answer — the operator can change every one.
  const [decisions, setDecisions] = useState<Record<string, Decision>>(() =>
    Object.fromEntries(
      result.proposals.map((p) => [
        p.listing.externalListingId,
        {
          accepted: false,
          ...(p.status === 'matched' ? { targetId: p.candidate.target.id } : {}),
          condition: p.derived?.condition ?? 'NM',
          ...(p.derived?.printing !== undefined ? { printing: p.derived.printing } : {}),
          ...(p.derived?.language !== undefined ? { language: p.derived.language } : {}),
        } satisfies Decision,
      ]),
    ),
  );

  const update = (id: string, patch: Partial<Decision>) =>
    setDecisions((prev) => {
      const current = prev[id];
      if (!current) return prev;
      return { ...prev, [id]: { ...current, ...patch } };
    });

  const links = useMemo(
    () =>
      result.proposals.flatMap((proposal): ConfirmLink[] => {
        const decision = decisions[proposal.listing.externalListingId];
        if (!decision?.accepted || decision.targetId === undefined) return [];

        return [
          {
            externalListingId: proposal.listing.externalListingId,
            sourceKey,
            sourceId: decision.targetId,
            condition: decision.condition,
            ...(decision.printing !== undefined ? { printing: decision.printing } : {}),
            ...(decision.language !== undefined ? { language: decision.language } : {}),
            // The channel's own price, so a link does not silently reprice a
            // live listing. Absent where the channel reported none.
            ...(proposal.listing.price !== undefined ? { price: proposal.listing.price } : {}),
          },
        ];
      }),
    [result.proposals, decisions, sourceKey],
  );

  const selectAllCertain = () =>
    setDecisions((prev) => {
      const next = { ...prev };
      for (const proposal of result.proposals) {
        if (proposal.status !== 'matched' || proposal.candidate.confidence !== 'certain') continue;
        const id = proposal.listing.externalListingId;
        const current = next[id];
        if (current) next[id] = { ...current, accepted: true };
      }
      return next;
    });

  return (
    <div className="panel">
      <div className="stat-row">
        <Stat label="Matched" value={result.summary.matched} />
        <Stat label="Certain" value={result.summary.certain} hint="safe to accept in bulk" />
        <Stat label="Ambiguous" value={result.summary.ambiguous} hint="pick one" />
        <Stat label="No match" value={result.summary.unmatched} />
        <Stat label="Already linked" value={result.skipped} hint="skipped" />
      </div>

      <p className="field-hint">
        {result.candidateCount} catalog candidate{result.candidateCount === 1 ? '' : 's'} in this
        set.
        {result.nextCursor !== undefined &&
          ' More listings remain — propose again after confirming.'}
      </p>

      <div className="inline-form">
        <button type="button" className="ghost" onClick={selectAllCertain}>
          Select all certain ({result.summary.certain})
        </button>
        <button
          type="button"
          disabled={links.length === 0 || confirm.isPending}
          onClick={() =>
            confirm.mutate({ links, ...(writeSku ? { writeSkuToChannel: true } : {}) })
          }
        >
          {confirm.isPending
            ? 'Linking…'
            : `Confirm ${links.length} link${links.length === 1 ? '' : 's'}`}
        </button>
      </div>

      <label className="inline-check">
        <input type="checkbox" checked={writeSku} onChange={(e) => setWriteSku(e.target.checked)} />
        Also write the catalog id into the channel’s SKU field
      </label>
      {/* Stated at the point of decision, not in documentation nobody reads. The
          benefit is real — a rebuilt hub re-derives every link from the
          storefront — and so is the cost. */}
      <p className="field-hint">
        {writeSku ? (
          <strong>
            This overwrites the SKU already on each listing you confirm. Existing codes are not
            recoverable from here.
          </strong>
        ) : (
          'Leaves the channel untouched. Turning it on records the mapping on the platform, so a rebuilt hub can re-derive every link — at the cost of the SKU currently there.'
        )}
      </p>

      {confirm.isError && <p className="error">{(confirm.error as Error).message}</p>}

      {confirm.isSuccess && confirm.data && (
        <div className="import-result">
          <p className={confirm.data.problems.length > 0 ? 'outcome-conflict' : 'outcome-ok'}>
            Linked {confirm.data.linked}
            {confirm.data.unchanged > 0 && `, ${confirm.data.unchanged} already as requested`}
            {confirm.data.skuWritten > 0 && `, ${confirm.data.skuWritten} SKU(s) rewritten`}
            {confirm.data.problems.length > 0 && `, ${confirm.data.problems.length} failed`}.
          </p>
          {/* Each link is independent, so the ones that failed are named rather
              than losing the whole batch. */}
          <ul className="error">
            {confirm.data.problems.map((problem) => (
              <li key={problem.externalListingId}>
                {problem.externalListingId}: {problem.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {result.proposals.length === 0 && (
        <p className="muted">
          Every listing on this page is already linked. Nothing left to review here.
        </p>
      )}

      <ul className="candidates">
        {result.proposals.map((proposal) => (
          <li key={proposal.listing.externalListingId}>
            <ProposalRow
              proposal={proposal}
              decision={decisions[proposal.listing.externalListingId]}
              onChange={(patch) => update(proposal.listing.externalListingId, patch)}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

function ProposalRow({
  proposal,
  decision,
  onChange,
}: {
  proposal: MatchProposal;
  decision?: Decision;
  onChange: (patch: Partial<Decision>) => void;
}) {
  if (!decision) return null;

  const { listing } = proposal;
  // An ambiguous proposal is unacceptable until one candidate is chosen. Picking
  // for the operator is the one thing this screen must not do.
  const canAccept = proposal.status !== 'unmatched' && decision.targetId !== undefined;

  return (
    <div className="allocation">
      <div className="allocation-head">
        <div>
          <span className="cell-title">{listing.title}</span>
          <span className="cell-sub">
            <code>{listing.externalListingId}</code>
            {listing.sku && ` · SKU ${listing.sku}`}
            {listing.barcode && ` · barcode ${listing.barcode}`}
            {listing.price !== undefined && ` · ${formatPrice(listing.price)}`}
          </span>
        </div>
        <span className="chips">
          {proposal.status === 'matched' && (
            <span className={confidenceClass(proposal.candidate.confidence)}>
              {proposal.candidate.confidence} · {describeReason(proposal.candidate.reason)}
            </span>
          )}
          {proposal.status === 'ambiguous' && (
            <span className="chip severity-warning">
              {proposal.candidates.length} possibilities
            </span>
          )}
          {proposal.status === 'unmatched' && <span className="chip">no match</span>}
          {listing.active === false && <span className="chip">not active on channel</span>}
        </span>
      </div>

      {proposal.status === 'matched' && <p className="field-hint">{proposal.candidate.detail}</p>}

      {proposal.status === 'ambiguous' && (
        <>
          <p className="field-hint">
            These fit equally well. Reprints share names, so this is normal — pick the right one.
          </p>
          <ul className="candidates">
            {proposal.candidates.map((candidate) => (
              <li key={candidate.target.id}>
                <label className="inline-check">
                  <input
                    type="radio"
                    name={`target-${listing.externalListingId}`}
                    checked={decision.targetId === candidate.target.id}
                    onChange={() => onChange({ targetId: candidate.target.id })}
                  />
                  <CandidateLabel candidate={candidate} />
                </label>
              </li>
            ))}
          </ul>
        </>
      )}

      {proposal.status === 'unmatched' && (
        <p className="field-hint">
          Nothing in this set resembled it. It may belong to another set, or be something the
          catalog does not carry — a supply, a gift card, a bundle.
        </p>
      )}

      {proposal.status !== 'unmatched' && (
        <div className="inline-form">
          <label className="inline-check">
            <input
              type="checkbox"
              checked={decision.accepted}
              disabled={!canAccept}
              onChange={(e) => onChange({ accepted: e.target.checked })}
            />
            Link this
          </label>

          <label htmlFor={`condition-${listing.externalListingId}`}>Condition</label>
          <select
            id={`condition-${listing.externalListingId}`}
            value={decision.condition}
            onChange={(e) => onChange({ condition: e.target.value })}
          >
            {SKU_CONDITIONS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>

          {/* Shown only when the title actually said so. A blank here means the
              title implied nothing, and the default is a guess the operator
              should see rather than inherit silently. */}
          {proposal.derived ? (
            <span className="muted">
              from title: {proposal.derived.condition} · {proposal.derived.printing} ·{' '}
              {proposal.derived.language}
            </span>
          ) : (
            <span className="muted">title implied no condition — check this</span>
          )}
        </div>
      )}
    </div>
  );
}

function CandidateLabel({ candidate }: { candidate: MatchCandidate }) {
  return (
    <span className="candidate-body">
      <span className="cell-title">{candidate.target.name}</span>
      <span className="cell-sub">
        {[candidate.target.setName, candidate.target.game].filter(Boolean).join(' · ')}
        {' · '}
        {candidate.detail}
      </span>
      <span className="chips">
        {Object.keys(candidate.target.externalIds ?? {}).map((namespace) => (
          <span key={namespace} className="chip">
            {namespace}
          </span>
        ))}
      </span>
    </span>
  );
}

function confidenceClass(confidence: 'certain' | 'probable' | 'possible'): string {
  // Reusing the alert severities: `certain` reads as settled, `possible` as
  // something to look at. Same visual language as the alert inbox, which is
  // where operators already learned what these colours mean.
  switch (confidence) {
    case 'certain':
      return 'chip chip-pooled';
    case 'probable':
      return 'chip severity-info';
    case 'possible':
      return 'chip severity-warning';
  }
}

function Stat({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {hint && <span className="stat-hint">{hint}</span>}
    </div>
  );
}
