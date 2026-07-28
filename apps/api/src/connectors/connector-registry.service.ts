import { Injectable, Logger, NotFoundException, type OnModuleInit } from '@nestjs/common';
import {
  assertValidConnector,
  connectorSyncMode,
  hasCapability,
  type Capability,
  type Connector,
  type SyncMode,
} from '@hub/connector-sdk';
import { createShopifyConnector } from '@hub/connector-shopify';

/**
 * Resolves a `ChannelInstance.connectorKey` to a connector implementation (§5).
 *
 * Bundled connectors register at startup. Every one is validated on the way in,
 * so a connector whose declarations and methods disagree fails the boot with a
 * clear message rather than throwing mid-sale at three in the morning. That
 * matters more for community connectors than bundled ones — the registry is the
 * only place the core can check them before trusting them.
 */

export interface ConnectorSummary {
  key: string;
  displayName: string;
  description?: string;
  capabilities: readonly Capability[];
  syncMode: SyncMode;
  configSchema: Connector['configSchema'];
  secretFields: readonly string[];
}

@Injectable()
export class ConnectorRegistry implements OnModuleInit {
  private readonly logger = new Logger(ConnectorRegistry.name);
  private readonly connectors = new Map<string, Connector>();

  onModuleInit(): void {
    // Bundled connectors land here as they are built: Shopify in Phase 3,
    // TCGPlayer (file-based, per ADR 0002) in Phase 4. Dynamic loading of
    // third-party connectors is deliberately not supported yet — it means
    // executing arbitrary code from disk, which needs its own design.
    for (const connector of BUNDLED_CONNECTORS) {
      this.register(connector);
    }

    this.logger.log(
      this.connectors.size === 0
        ? 'No connectors registered yet'
        : `Registered ${this.connectors.size} connector(s): ${[...this.connectors.keys()].join(', ')}`,
    );
  }

  /**
   * Validate and register a connector.
   *
   * Throws on an invalid definition or a duplicate key. Both are programming
   * errors that should stop the process, not warnings to be scrolled past.
   */
  register(connector: Connector): void {
    assertValidConnector(connector);

    if (this.connectors.has(connector.key)) {
      throw new Error(
        `Two connectors both claim the key "${connector.key}". Keys resolve ChannelInstance ` +
          `rows to implementations, so they must be unique.`,
      );
    }

    this.connectors.set(connector.key, connector);
  }

  get(key: string): Connector {
    const connector = this.connectors.get(key);
    if (!connector) {
      const known = [...this.connectors.keys()];
      throw new NotFoundException(
        `No connector registered for "${key}". Registered: ${known.length ? known.join(', ') : 'none'}.`,
      );
    }
    return connector;
  }

  has(key: string): boolean {
    return this.connectors.has(key);
  }

  /** Everything the channel-configuration UI needs to render a picker and a form. */
  list(): ConnectorSummary[] {
    return [...this.connectors.values()].map((c) => ({
      key: c.key,
      displayName: c.displayName,
      description: c.description,
      capabilities: c.capabilities,
      syncMode: connectorSyncMode(c),
      configSchema: c.configSchema,
      secretFields: c.secretFields ?? [],
    }));
  }

  /**
   * Whether a channel supports an operation, for the engine to branch on.
   *
   * Callers must ask before dispatching. Capabilities are declared precisely so
   * the core can degrade gracefully — scheduling a poll where there is no
   * webhook, offering a file export where there is no API — rather than calling
   * a method that does not exist.
   */
  supports(key: string, capability: Capability): boolean {
    const connector = this.connectors.get(key);
    return connector ? hasCapability(connector.capabilities, capability) : false;
  }

  /** Test seam: drop all registrations. */
  clear(): void {
    this.connectors.clear();
  }
}

/**
 * The connectors shipped in the box.
 *
 * TCGPlayer joins in Phase 4 as a file-based connector — its package still
 * exports only a key, and registering a placeholder would mean validating
 * something that cannot sync (ADR 0002).
 */
const BUNDLED_CONNECTORS: Connector[] = [createShopifyConnector()];
