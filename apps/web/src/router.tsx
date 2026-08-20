import { Outlet, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { AppShell } from './AppShell';
import { InventoryListPage } from './pages/InventoryListPage';
import { ItemDetailPage } from './pages/ItemDetailPage';
import { IntakePage } from './pages/IntakePage';
import { CatalogPage } from './pages/CatalogPage';
import { ChannelsPage } from './pages/ChannelsPage';
import { MatchPage } from './pages/MatchPage';
import { ListOnChannelPage } from './pages/ListOnChannelPage';
import { ActivityPage } from './pages/ActivityPage';
import { QueryConsolePage } from './pages/QueryConsolePage';
import { SettingsPage } from './pages/SettingsPage';
import { SKU_CONDITIONS } from './constants';

/**
 * Code-based routes rather than the file-based convention.
 *
 * File-based routing needs a codegen step and a generated route tree checked
 * into the repo. With two routes that is more moving parts than it earns; it
 * can be adopted when the route count justifies it.
 */

const rootRoute = createRootRoute({
  component: () => (
    <AppShell>
      <Outlet />
    </AppShell>
  ),
});

export interface InventorySearch {
  search?: string;
  /** Several conditions at once. A single one is a list of one. */
  condition?: string[];
  /** A game, or the sentinel below for items that have none. */
  game?: string;
  /**
   * A set within the chosen game. Meaningless without one, and cleared
   * whenever the game changes — a set from the previous game would match
   * nothing and read as a broken filter rather than an empty one.
   */
  set?: string;
  /** A channel the item is allocated to, or the sentinel below for "none". */
  channel?: string;
  /** Only what is physically held. Part of what the table shows, so it lives in the URL. */
  inStock?: boolean;
  page?: number;
  pageSize?: number;
  sortBy?: 'name' | 'quantityOnHand' | 'updatedAt' | 'condition' | 'price';
  sortDir?: 'asc' | 'desc';
}

const SORT_FIELDS = ['name', 'quantityOnHand', 'updatedAt', 'condition', 'price'] as const;

/**
 * Page sizes the browser offers, and the only ones it will accept in a URL.
 *
 * A fixed set rather than any integer: this reaches a `take` in a database
 * query, and the route's own rule is that unrecognised search params are
 * dropped rather than trusted.
 */
export const PAGE_SIZES = [25, 50, 100, 200] as const;

/**
 * `channel=none` means "on no channel at all".
 *
 * A sentinel in the URL rather than a second parameter, because it is one
 * choice in one dropdown and two params could contradict each other. It is
 * translated into the API's own `unlisted` flag at the call site.
 */
export const NO_CHANNEL = 'none';

/**
 * `game=none` means "has no game at all" — supplies, sealed accessories, a
 * Funko Pop, anything hand-entered. Same sentinel shape as `channel=none`,
 * and translated into the API's `noGame` flag at the call site.
 */
export const NO_GAME = 'none';

/**
 * The conditions named in a URL, dropping anything unrecognised.
 *
 * Unknown values are not merely useless — a filter that silently returns
 * nothing reads as a broken page rather than as a filter. Dropping them means
 * a mangled URL shows more than intended rather than less, which is the same
 * direction every other param here fails in.
 */
function parseConditions(raw: unknown): string[] | undefined {
  const parts =
    typeof raw === 'string'
      ? raw.split(',')
      : Array.isArray(raw)
        ? raw.flatMap((v) => (typeof v === 'string' ? v.split(',') : []))
        : [];

  const known = parts
    .map((v) => v.trim())
    .filter((v) => (SKU_CONDITIONS as readonly string[]).includes(v));
  return known.length > 0 ? [...new Set(known)] : undefined;
}

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: InventoryListPage,
  /**
   * Browse state lives in the URL so a filtered view is bookmarkable and
   * shareable — the "saved filters" requirement in §7 falls out of this for
   * free. Unrecognised values are dropped rather than trusted: search params
   * are user input, and they end up in an API query.
   */
  validateSearch: (raw: Record<string, unknown>): InventorySearch => {
    const page = Number(raw.page);
    const pageSize = Number(raw.pageSize);
    const sortBy = SORT_FIELDS.find((f) => f === raw.sortBy);

    return {
      search: typeof raw.search === 'string' && raw.search ? raw.search : undefined,
      // Comma-separated in the URL so a filtered view stays shareable as one
      // param, and narrowed to the known vocabulary — these reach a database
      // filter, and search params are user input.
      condition: parseConditions(raw.condition),
      game: typeof raw.game === 'string' && raw.game ? raw.game : undefined,
      // Dropped without a game, so a hand-edited URL cannot leave a set filter
      // applied with no visible control saying so.
      set:
        typeof raw.set === 'string' && raw.set && typeof raw.game === 'string' && raw.game
          ? raw.set
          : undefined,
      channel: typeof raw.channel === 'string' && raw.channel ? raw.channel : undefined,
      // Only `true` survives. Anything else — absent, "false", a stray string —
      // means the filter is off, so a malformed URL shows everything rather
      // than hiding rows for a reason nobody can see.
      inStock: raw.inStock === true || raw.inStock === 'true' ? true : undefined,
      page: Number.isInteger(page) && page > 0 ? page : undefined,
      // Only a size the picker offers. Anything else is dropped rather than
      // passed through to a `take` in a database query.
      pageSize: PAGE_SIZES.find((size) => size === pageSize),
      sortBy,
      sortDir: raw.sortDir === 'desc' ? 'desc' : raw.sortDir === 'asc' ? 'asc' : undefined,
    };
  },
});

const itemRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/items/$id',
  component: ItemDetailPage,
});

const intakeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/intake',
  component: IntakePage,
});

const catalogRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/catalog',
  component: CatalogPage,
});

const channelsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/channels',
  component: ChannelsPage,
});

/**
 * Reached from the channels page rather than the top nav: it acts on one channel,
 * and it is a setup task rather than a daily one.
 */
const matchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/match',
  component: MatchPage,
  // `listing` deep-links the manual-link panel — the unmapped-listing alert
  // carries the platform id of what sold, and this is how it lands here.
  validateSearch: (raw: Record<string, unknown>): { listing?: string } => ({
    ...(typeof raw.listing === 'string' && raw.listing ? { listing: raw.listing } : {}),
  }),
});

/**
 * The mirror of `/match`, and reached the same way — from a channel. Matching
 * links listings that exist; this makes ones that do not.
 */
const listRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/list',
  component: ListOnChannelPage,
});

const activityRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/activity',
  component: ActivityPage,
});

/**
 * Registered whether or not the feature is enabled. The page reports the
 * deployment's own status, which is a better answer for someone following a
 * link than a 404 from the SPA router.
 */
const queryConsoleRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/query',
  component: QueryConsolePage,
});

/**
 * Reached from the account menu rather than the top navigation: it is where
 * you go to change how the tool behaves, not somewhere you go while using it.
 */
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: SettingsPage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  itemRoute,
  intakeRoute,
  catalogRoute,
  channelsRoute,
  matchRoute,
  listRoute,
  activityRoute,
  queryConsoleRoute,
  settingsRoute,
]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
