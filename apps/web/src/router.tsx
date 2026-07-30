import { Outlet, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { AppShell } from './AppShell';
import { InventoryListPage } from './pages/InventoryListPage';
import { ItemDetailPage } from './pages/ItemDetailPage';
import { IntakePage } from './pages/IntakePage';
import { ChannelsPage } from './pages/ChannelsPage';
import { MatchPage } from './pages/MatchPage';
import { ActivityPage } from './pages/ActivityPage';
import { QueryConsolePage } from './pages/QueryConsolePage';

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
  condition?: string;
  page?: number;
  pageSize?: number;
  sortBy?: 'name' | 'quantityOnHand' | 'updatedAt' | 'condition';
  sortDir?: 'asc' | 'desc';
}

const SORT_FIELDS = ['name', 'quantityOnHand', 'updatedAt', 'condition'] as const;

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
      condition: typeof raw.condition === 'string' && raw.condition ? raw.condition : undefined,
      page: Number.isInteger(page) && page > 0 ? page : undefined,
      pageSize: Number.isInteger(pageSize) && pageSize > 0 ? pageSize : undefined,
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

const routeTree = rootRoute.addChildren([
  indexRoute,
  itemRoute,
  intakeRoute,
  channelsRoute,
  matchRoute,
  activityRoute,
  queryConsoleRoute,
]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
