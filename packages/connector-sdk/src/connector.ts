import {
  CAPABILITY_METHODS,
  isCapability,
  syncModeOf,
  type Capability,
  type SyncMode,
} from './capabilities';
import type {
  Ctx,
  DelistRequest,
  ExportListingsRequest,
  ExportedFile,
  ImportResult,
  ImportedFile,
  LiveListingState,
  NormalizedEvent,
  PushListingRequest,
  PushListingResult,
  UpdatePriceRequest,
  UpdateQuantityRequest,
} from './types';

/**
 * The contract every channel connector implements.
 *
 * **Every operation is optional.** §5 declared capabilities but still required
 * all four outbound methods, which contradicted itself — a connector that
 * cannot push a listing should not be forced to implement `pushListing` just to
 * throw from it. Capabilities are now the single source of truth, and
 * {@link validateConnector} rejects any connector whose declarations and
 * methods disagree.
 *
 * Connectors are dumb pipes. They translate between the core's canonical
 * operations and one platform's interface. They never decide a quantity, never
 * read the ledger, and never resolve a conflict.
 */
export interface Connector {
  /** Stable identifier persisted on ChannelInstance.connectorKey. */
  readonly key: string;

  readonly displayName: string;

  /** Optional prose shown in the channel picker. */
  readonly description?: string;

  /**
   * JSON Schema for this connector's non-secret settings. The core generates
   * the settings form from it, so community connectors get a real config UI
   * without touching core code (§5).
   */
  readonly configSchema: JsonSchema;

  /**
   * Names of the secret fields this connector expects in `Ctx.secrets`.
   * Declared so the core can prompt for them and store them encrypted —
   * secrets must never appear in configSchema.
   */
  readonly secretFields?: readonly string[];

  readonly capabilities: readonly Capability[];

  /**
   * Requests per second the core's queue limiter should allow for this
   * connector. Rate limiting lives in the core (§5), so connectors declare
   * their limit rather than implementing throttling themselves.
   */
  readonly rateLimit?: { requestsPerSecond: number; burst?: number };

  // Product lookup is not here by design — see CatalogSource in catalog.ts.

  // --- outbound ------------------------------------------------------------
  pushListing?(ctx: Ctx, req: PushListingRequest): Promise<PushListingResult>;
  updateQuantity?(ctx: Ctx, req: UpdateQuantityRequest): Promise<void>;
  updatePrice?(ctx: Ctx, req: UpdatePriceRequest): Promise<void>;
  delist?(ctx: Ctx, req: DelistRequest): Promise<void>;

  // --- inbound, live -------------------------------------------------------
  /**
   * Verify a webhook signature against the byte-exact raw body.
   *
   * Required alongside `orders.webhook`: an unverified webhook endpoint is an
   * open door to forged sales, so {@link validateConnector} rejects declaring
   * the capability without it.
   */
  verifyWebhook?(ctx: Ctx, headers: Record<string, string>, rawBody: Buffer): boolean;
  parseWebhook?(ctx: Ctx, rawBody: Buffer): NormalizedEvent[];
  pollChanges?(ctx: Ctx, since: Date): Promise<NormalizedEvent[]>;

  // --- reconciliation ------------------------------------------------------
  fetchLiveState?(ctx: Ctx, externalListingIds: string[]): Promise<LiveListingState[]>;

  // --- file transport (ADR 0002) -------------------------------------------
  exportListings?(ctx: Ctx, req: ExportListingsRequest): Promise<ExportedFile>;
  importOrders?(ctx: Ctx, file: ImportedFile): Promise<ImportResult<NormalizedEvent>>;
  importInventory?(ctx: Ctx, file: ImportedFile): Promise<ImportResult<LiveListingState>>;
}

/** Minimal structural type; the core only passes this to a JSON Schema form renderer. */
export interface JsonSchema {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

export interface ConnectorProblem {
  code: 'unknown_capability' | 'missing_method' | 'undeclared_method' | 'invalid_definition';
  message: string;
}

/**
 * Check a connector's declarations against its implementation.
 *
 * Run by the registry before a connector is usable, so a mismatch surfaces at
 * startup with a clear message rather than as a runtime failure during a sale.
 * This is deliberately a runtime check rather than a type-level one: community
 * connectors may be plain JavaScript, or compiled with settings we do not
 * control, and the guarantee has to hold for them too.
 */
export function validateConnector(connector: Connector): ConnectorProblem[] {
  const problems: ConnectorProblem[] = [];

  if (!connector.key || typeof connector.key !== 'string') {
    problems.push({
      code: 'invalid_definition',
      message: 'Connector must declare a string `key`.',
    });
  }
  if (!connector.displayName) {
    problems.push({
      code: 'invalid_definition',
      message: 'Connector must declare a `displayName`.',
    });
  }
  if (!connector.configSchema || typeof connector.configSchema !== 'object') {
    problems.push({
      code: 'invalid_definition',
      message: 'Connector must declare a `configSchema`, even if it is an empty object schema.',
    });
  }
  if (!Array.isArray(connector.capabilities)) {
    problems.push({ code: 'invalid_definition', message: '`capabilities` must be an array.' });
    return problems;
  }

  const declared = new Set<string>();

  for (const capability of connector.capabilities) {
    if (!isCapability(capability)) {
      problems.push({
        code: 'unknown_capability',
        message: `Unknown capability "${String(capability)}".`,
      });
      continue;
    }
    declared.add(capability);

    const method = CAPABILITY_METHODS[capability];
    if (typeof (connector as unknown as Record<string, unknown>)[method] !== 'function') {
      problems.push({
        code: 'missing_method',
        message: `Capability "${capability}" requires \`${method}()\`, which is not implemented.`,
      });
    }
  }

  // A webhook endpoint without signature verification would accept forged
  // sales from anyone who learns the URL.
  if (declared.has('orders.webhook') && typeof connector.verifyWebhook !== 'function') {
    problems.push({
      code: 'missing_method',
      message:
        'Capability "orders.webhook" requires `verifyWebhook()`. An unverified webhook ' +
        'endpoint would accept forged sale events.',
    });
  }

  // The reverse direction: an implemented-but-undeclared method never runs,
  // because the core dispatches on capabilities. Silently dead code in a
  // connector is worth a loud complaint.
  for (const [capability, method] of Object.entries(CAPABILITY_METHODS)) {
    const implemented =
      typeof (connector as unknown as Record<string, unknown>)[method] === 'function';
    if (implemented && !declared.has(capability)) {
      problems.push({
        code: 'undeclared_method',
        message:
          `\`${method}()\` is implemented but "${capability}" is not declared, so the core ` +
          `will never call it.`,
      });
    }
  }

  return problems;
}

export function assertValidConnector(connector: Connector): void {
  const problems = validateConnector(connector);
  if (problems.length > 0) {
    throw new Error(
      `Connector "${connector.key ?? '(unnamed)'}" is invalid:\n` +
        problems.map((p) => `  - [${p.code}] ${p.message}`).join('\n'),
    );
  }
}

/** How current this connector's data can be, derived from its capabilities. */
export function connectorSyncMode(connector: Connector): SyncMode {
  return syncModeOf(connector.capabilities);
}
