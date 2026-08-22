import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { CatalogCandidate, CatalogSearchQuery, CatalogSource } from '@hub/connector-sdk';
import { PrismaService } from '../prisma/prisma.service';
import { CatalogSourceRegistry } from './catalog-source-registry.service';

/**
 * The `imported` catalog source: cards the operator loaded by hand, served
 * back through the same interface every other source answers.
 *
 * ## Why a source at all, rather than just rows in the local catalog
 *
 * Intake never trusts the client for catalogue data — `IntakeService.intake`
 * takes a `(sourceKey, sourceId)` pair and re-fetches the candidate
 * server-side. That is the right rule and it makes a registered source the
 * *only* way imported items become intakeable: rows written straight into
 * `CatalogItem` with no source to re-verify them would be browsable and
 * nothing more. Registering `imported` closes the loop — search it on the
 * intake screen, confirm out of it, list on a channel — with zero special
 * cases anywhere downstream.
 *
 * It exists for games no catalogue carries: Neuroscape today (no TCGPlayer
 * category, no CardTrader game, a Carde.io backend with no public API), and
 * whatever launches next. The day a real source appears, its ingest converges
 * on these rows only if it shares an id namespace — which it will not — so a
 * migration to a real source is a merge on the duplicates screen, not magic.
 *
 * ## Shape
 *
 * - **DB-backed, so it lives in the api rather than a package.** Every other
 *   source wraps a third-party HTTP API and gets a package; this one's
 *   backing store *is* the local catalog, filtered to rows carrying an
 *   `imported` ref. `CatalogCtx` is accepted and ignored.
 * - **An un-narrowed search is allowed.** tcgcsv and CardTrader throw on one
 *   to protect a community CDN; this is one indexed database query, and the
 *   protective refusal would only make the source harder to use.
 * - **`games` is declared empty**, meaning "always consulted" — the games
 *   here are whatever the operator imported, which a static declaration
 *   cannot know. tcgcsv makes the same choice for the same reason.
 * - **No `listSets`/`fetchSet`**: nothing to bulk-ingest — data arrives
 *   through `POST /catalog/import`, and the local catalog *is* the store, so
 *   an ingest of it into itself is meaningless. `canIngest` false keeps the
 *   ingest panel honest.
 */

export const IMPORTED_SOURCE_KEY = 'imported';

/** Search results are a short list for a picker, same budget as the registry's fan-out. */
const MAX_RESULTS = 50;

type ImportedRow = {
  name: string;
  game: string | null;
  setName: string | null;
  imageUrl: string | null;
  collectorNumber: string | null;
  externalRefs: Array<{ source: string; externalId: string }>;
};

function toCandidate(row: ImportedRow): CatalogCandidate | null {
  const own = row.externalRefs.find((r) => r.source === IMPORTED_SOURCE_KEY);
  // Unreachable through the queries below, which filter on the ref — but a
  // candidate without its own id would break intake, so refuse to emit one.
  if (!own) return null;
  return {
    sourceId: own.externalId,
    name: row.name,
    externalIds: Object.fromEntries(row.externalRefs.map((r) => [r.source, r.externalId])),
    ...(row.game !== null ? { game: row.game } : {}),
    ...(row.setName !== null ? { setName: row.setName } : {}),
    ...(row.imageUrl !== null ? { imageUrl: row.imageUrl } : {}),
    ...(row.collectorNumber !== null ? { collectorNumber: row.collectorNumber } : {}),
  };
}

const ROW_SELECT = {
  name: true,
  game: true,
  setName: true,
  imageUrl: true,
  collectorNumber: true,
  externalRefs: { select: { source: true, externalId: true } },
} as const;

export function createImportedSource(prisma: PrismaService): CatalogSource {
  return {
    key: IMPORTED_SOURCE_KEY,
    displayName: 'Imported',
    description:
      'Cards loaded by hand through the catalog import — a home for games no catalogue carries yet.',
    games: [],

    async search(_ctx, query: CatalogSearchQuery): Promise<CatalogCandidate[]> {
      const text = query.text.trim().toLowerCase();
      const rows = await prisma.catalogItem.findMany({
        where: {
          externalRefs: { some: { source: IMPORTED_SOURCE_KEY } },
          ...(query.game !== undefined ? { game: query.game } : {}),
          ...(query.setName !== undefined ? { setName: query.setName } : {}),
          // `searchName` is the lowercased copy kept for exactly this — a
          // `mode: "insensitive"` filter would be PostgreSQL-only (rule 2).
          ...(text !== '' ? { searchName: { contains: text } } : {}),
        },
        select: ROW_SELECT,
        orderBy: { name: 'asc' },
        take: Math.min(query.limit ?? MAX_RESULTS, MAX_RESULTS),
      });
      return rows.map(toCandidate).filter((c): c is CatalogCandidate => c !== null);
    },

    async fetchById(_ctx, sourceId: string): Promise<CatalogCandidate | null> {
      const ref = await prisma.catalogExternalRef.findUnique({
        where: {
          source_externalId: { source: IMPORTED_SOURCE_KEY, externalId: sourceId },
        },
        select: { catalogItem: { select: ROW_SELECT } },
      });
      return ref === null ? null : toCandidate(ref.catalogItem);
    },
  };
}

/**
 * Registers the source at boot. A separate provider rather than a constructor
 * dependency of `CatalogSourceRegistry`, so the registry stays constructible
 * bare (its own spec builds it with `new`) and the one source that needs the
 * database is wired where the need is visible. Nest runs init hooks in
 * dependency order, so the registry's own bundled registration happens first.
 */
@Injectable()
export class ImportedSourceRegistrar implements OnModuleInit {
  constructor(
    private readonly registry: CatalogSourceRegistry,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.registry.register(createImportedSource(this.prisma));
  }
}
