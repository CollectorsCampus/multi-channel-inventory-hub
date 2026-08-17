import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { decodeJsonObject, encodeJson } from '@hub/db';
import { connectorSyncMode, hasCapability, type SyncMode } from '@hub/connector-sdk';
import { PrismaService } from '../prisma/prisma.service';
import { ConnectorRegistry } from '../connectors/connector-registry.service';
import { CredentialStore } from '../connectors/credential-store.service';
import { pickSchemaFields, validateChannelConfig } from './config-schema';
import {
  SELLOUT_SCOPES,
  encodeListingDefaults,
  hasDeclaredDefaults,
  parseListingDefaults,
  type ChannelListingDefaults,
  type SelloutScope,
} from './listing-defaults';
import {
  encodeRepricingPolicy,
  parseRepricingPolicy,
  type RepricingPolicy,
} from '../pricing/repricing';

/**
 * Channel instance management (§7 "Channels").
 *
 * Secrets go in and never come out. The API reports only *which* secret fields
 * are set, never their values — an operator who has lost an access token must
 * re-enter it, which is the correct trade for a value that grants control of
 * their storefront.
 */

export interface ChannelSummary {
  id: string;
  connectorKey: string;
  displayName: string;
  enabled: boolean;
  config: Record<string, unknown>;
  /** Which declared secret fields have a stored value. Never the values. */
  secretsSet: string[];
  secretFieldsRequired: string[];
  syncMode: SyncMode;
  capabilities: readonly string[];
  healthStatus: string;
  healthDetail: string | null;
  lastPolledAt: Date | null;
  lastReconciledAt: Date | null;
  /** Opt-in re-push when reconciliation finds the channel showing something else (§6). */
  reconcileAutoCorrect: boolean;
  /** Opt-in: list stock on this channel as it is taken in. Needs listingDefaults. */
  autoListNewStock: boolean;
  /** Opt-in: draft a single's product when its pushed quantity reaches zero. */
  draftAtSellout: boolean;
  /** What that applies to: "singles" (default) or "all". */
  selloutScope: string;
  /** Opt-in: publish again when stock returns, if the hub was what hid it. */
  reactivateOnRestock: boolean;
  /** How this channel turns market prices into asking prices. */
  repricingPolicy: RepricingPolicy;
  /** What a listing created here carries, applied verbatim. Never derived. */
  listingDefaults: ChannelListingDefaults;
  /** Present only when the connector receives webhooks. */
  webhookPath: string | null;
  allocationCount: number;
  createdAt: Date;
}

export interface CreateChannelInput {
  connectorKey: string;
  displayName: string;
  config: Record<string, unknown>;
  secrets?: Record<string, string>;
}

export interface UpdateChannelInput {
  displayName?: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
  secrets?: Record<string, string>;
  reconcileAutoCorrect?: boolean;
  autoListNewStock?: boolean;
  draftAtSellout?: boolean;
  selloutScope?: string;
  reactivateOnRestock?: boolean;
  /** Replaced wholesale, like listingDefaults; sanitised through the tolerant parser. */
  repricingPolicy?: Record<string, unknown>;
  /**
   * Replaced wholesale, not merged.
   *
   * The opposite of `config` above, and deliberately: this is one form section
   * answering one question — "what should a product created here carry" — and
   * merging would make removing the last tag impossible. `config` merges
   * because it is assembled from whichever connector fields a form happened to
   * render.
   */
  listingDefaults?: ChannelListingDefaults;
}

@Injectable()
export class ChannelsService {
  private readonly logger = new Logger(ChannelsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ConnectorRegistry,
    private readonly credentials: CredentialStore,
  ) {}

  async list(): Promise<ChannelSummary[]> {
    const instances = await this.prisma.channelInstance.findMany({
      orderBy: { createdAt: 'asc' },
      include: { _count: { select: { allocations: true } } },
    });

    return Promise.all(instances.map((instance) => this.toSummary(instance)));
  }

  async get(id: string): Promise<ChannelSummary> {
    const instance = await this.prisma.channelInstance.findUnique({
      where: { id },
      include: { _count: { select: { allocations: true } } },
    });
    if (!instance) throw new NotFoundException(`Channel ${id} not found.`);
    return this.toSummary(instance);
  }

  async create(input: CreateChannelInput): Promise<ChannelSummary> {
    const connector = this.registry.get(input.connectorKey);

    const config = pickSchemaFields(connector.configSchema, input.config);
    this.assertConfigValid(connector.configSchema, config);
    this.assertSecretsDeclared(connector.secretFields ?? [], input.secrets);

    const credentialRef = input.secrets ? CredentialStore.newRef(input.connectorKey) : null;

    if (credentialRef && input.secrets) {
      // Written before the channel row so a failure here cannot leave a channel
      // pointing at credentials that do not exist.
      await this.credentials.put(credentialRef, input.secrets);
    }

    const instance = await this.prisma.channelInstance.create({
      data: {
        connectorKey: input.connectorKey,
        displayName: input.displayName.trim(),
        config: encodeJson(config),
        credentialRef,
      },
      include: { _count: { select: { allocations: true } } },
    });

    this.logger.log(`Created channel "${instance.displayName}" (${input.connectorKey})`);
    return this.toSummary(instance);
  }

  async update(id: string, input: UpdateChannelInput): Promise<ChannelSummary> {
    const existing = await this.prisma.channelInstance.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Channel ${id} not found.`);

    const connector = this.registry.get(existing.connectorKey);

    let config: string | undefined;
    if (input.config) {
      // Merged, not replaced: the settings form only submits fields it renders,
      // and a partial save must not silently clear the rest.
      const merged = {
        ...decodeJsonObject(existing.config),
        ...pickSchemaFields(connector.configSchema, input.config),
      };
      this.assertConfigValid(connector.configSchema, merged);
      config = encodeJson(merged);
    }

    let credentialRef = existing.credentialRef;
    if (input.secrets && Object.keys(input.secrets).length > 0) {
      this.assertSecretsDeclared(connector.secretFields ?? [], input.secrets);

      // Merge with what is stored, so an operator updating one secret does not
      // have to re-enter the others.
      const current = credentialRef
        ? await this.credentials.get(credentialRef).catch(() => ({}))
        : {};
      credentialRef ??= CredentialStore.newRef(existing.connectorKey);
      await this.credentials.put(credentialRef, { ...current, ...input.secrets });
    }

    // Resolved against what this same request is writing, not against what is
    // stored: declaring the defaults and switching the toggle on is one save in
    // the settings form, and checking the stored column would reject it.
    const listingDefaults = input.listingDefaults ?? parseListingDefaults(existing.listingDefaults);
    const autoList = input.autoListNewStock ?? existing.autoListNewStock;

    if (autoList && !hasDeclaredDefaults(listingDefaults)) {
      // Refused rather than allowed-and-warned. Automatic creation with nothing
      // declared puts untagged, uncategorised drafts on a storefront at the
      // speed of intake — and on a tag-driven store an untagged product is in
      // no collection, so it is invisible in the shop and reported by nothing.
      throw new BadRequestException(
        `"${existing.displayName}" has no listing defaults, so new stock cannot be listed ` +
          `automatically. Set the tags, custom fields and category a created product should ` +
          `carry first — the hub applies them verbatim and will not guess one.`,
      );
    }

    const instance = await this.prisma.channelInstance.update({
      where: { id },
      data: {
        ...(input.displayName !== undefined ? { displayName: input.displayName.trim() } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.reconcileAutoCorrect !== undefined
          ? { reconcileAutoCorrect: input.reconcileAutoCorrect }
          : {}),
        ...(input.autoListNewStock !== undefined
          ? { autoListNewStock: input.autoListNewStock }
          : {}),
        ...(input.draftAtSellout !== undefined ? { draftAtSellout: input.draftAtSellout } : {}),
        // Narrowed to the known vocabulary before it is stored. `inSelloutScope`
        // reads anything else as "singles" anyway, but a rejected value that
        // round-trips would show the operator a setting they do not have.
        ...(input.selloutScope !== undefined &&
        SELLOUT_SCOPES.includes(input.selloutScope as SelloutScope)
          ? { selloutScope: input.selloutScope }
          : {}),
        ...(input.reactivateOnRestock !== undefined
          ? { reactivateOnRestock: input.reactivateOnRestock }
          : {}),
        ...(input.repricingPolicy !== undefined
          ? {
              repricingPolicy: encodeRepricingPolicy(
                parseRepricingPolicy(JSON.stringify(input.repricingPolicy)),
              ),
            }
          : {}),
        ...(input.listingDefaults !== undefined
          ? { listingDefaults: encodeListingDefaults(input.listingDefaults) }
          : {}),
        ...(config !== undefined ? { config } : {}),
        ...(credentialRef !== existing.credentialRef ? { credentialRef } : {}),
      },
      include: { _count: { select: { allocations: true } } },
    });

    return this.toSummary(instance);
  }

  /**
   * Delete a channel.
   *
   * Refused while allocations still point at it. Cascading would silently
   * delete the operator's per-channel quantities and prices, and returning that
   * stock to the pool is a decision they should make deliberately.
   */
  async remove(id: string): Promise<void> {
    const instance = await this.prisma.channelInstance.findUnique({
      where: { id },
      include: { _count: { select: { allocations: true } } },
    });
    if (!instance) throw new NotFoundException(`Channel ${id} not found.`);

    if (instance._count.allocations > 0) {
      throw new BadRequestException(
        `${instance.displayName} still has ${instance._count.allocations} allocation(s). ` +
          `Remove them first, or disable the channel instead.`,
      );
    }

    if (instance.credentialRef) {
      await this.credentials.delete(instance.credentialRef);
    }

    await this.prisma.channelInstance.delete({ where: { id } });
    this.logger.log(`Deleted channel "${instance.displayName}"`);
  }

  /** Connectors available to create a channel from, with their settings schemas. */
  listConnectors() {
    return this.registry.list();
  }

  // -------------------------------------------------------------------------

  private assertConfigValid(
    schema: Parameters<typeof validateChannelConfig>[0],
    config: Record<string, unknown>,
  ) {
    const issues = validateChannelConfig(schema, config);
    if (issues.length > 0) {
      throw new BadRequestException({ message: 'Channel configuration is incomplete.', issues });
    }
  }

  /**
   * Reject secret fields the connector never declared.
   *
   * Otherwise an arbitrary blob would be encrypted and handed to the connector
   * inside `Ctx.secrets`, which is neither useful nor something to store.
   */
  private assertSecretsDeclared(declared: readonly string[], secrets?: Record<string, string>) {
    if (!secrets) return;
    const unknown = Object.keys(secrets).filter((key) => !declared.includes(key));
    if (unknown.length > 0) {
      throw new BadRequestException(
        `This connector does not use: ${unknown.join(', ')}. It expects: ${declared.join(', ') || 'none'}.`,
      );
    }
  }

  private async toSummary(instance: {
    id: string;
    connectorKey: string;
    displayName: string;
    enabled: boolean;
    config: string;
    credentialRef: string | null;
    healthStatus: string;
    healthDetail: string | null;
    lastPolledAt: Date | null;
    lastReconciledAt: Date | null;
    reconcileAutoCorrect: boolean;
    autoListNewStock: boolean;
    draftAtSellout: boolean;
    selloutScope: string;
    reactivateOnRestock: boolean;
    repricingPolicy: string;
    listingDefaults: string;
    createdAt: Date;
    _count: { allocations: number };
  }): Promise<ChannelSummary> {
    // A channel may reference a connector that is no longer registered — a
    // downgrade, or a community connector removed from the deployment. Report
    // it rather than throwing, so the operator can see and fix it.
    const connector = this.registry.has(instance.connectorKey)
      ? this.registry.get(instance.connectorKey)
      : null;

    const secretFields = connector?.secretFields ?? [];
    const optionalSecretFields = connector?.optionalSecretFields ?? [];
    let secretsSet: string[] = [];

    if (instance.credentialRef && secretFields.length > 0) {
      try {
        const stored = await this.credentials.get(instance.credentialRef);
        secretsSet = secretFields.filter((field) => Boolean(stored[field]));
      } catch {
        // Undecryptable credentials mean the master key changed. Reporting none
        // set is honest: they cannot be used.
        secretsSet = [];
      }
    }

    const receivesWebhooks =
      connector !== null && hasCapability(connector.capabilities, 'orders.webhook');

    return {
      id: instance.id,
      connectorKey: instance.connectorKey,
      displayName: instance.displayName,
      enabled: instance.enabled,
      config: decodeJsonObject(instance.config),
      secretsSet,
      // Only the fields a channel cannot work without. This drives the "still
      // needs: …" warning, so including an optional field there tells a working
      // channel it is broken — and sends the operator looking for a credential
      // the platform may not even issue.
      secretFieldsRequired: secretFields.filter((field) => !optionalSecretFields.includes(field)),
      syncMode: connector ? connectorSyncMode(connector) : 'outbound-only',
      capabilities: connector?.capabilities ?? [],
      healthStatus: connector ? instance.healthStatus : 'error',
      healthDetail: connector
        ? instance.healthDetail
        : `No connector registered for "${instance.connectorKey}".`,
      lastPolledAt: instance.lastPolledAt,
      lastReconciledAt: instance.lastReconciledAt,
      reconcileAutoCorrect: instance.reconcileAutoCorrect,
      // Reported even when the connector cannot create listings at all, so the
      // settings form can say why the toggle is unavailable rather than hiding
      // it and leaving the operator to wonder where it went.
      autoListNewStock: instance.autoListNewStock,
      draftAtSellout: instance.draftAtSellout,
      selloutScope: instance.selloutScope,
      reactivateOnRestock: instance.reactivateOnRestock,
      repricingPolicy: parseRepricingPolicy(instance.repricingPolicy),
      listingDefaults: parseListingDefaults(instance.listingDefaults),
      webhookPath: receivesWebhooks ? `/api/webhooks/${instance.id}` : null,
      allocationCount: instance._count.allocations,
      createdAt: instance.createdAt,
    };
  }
}
