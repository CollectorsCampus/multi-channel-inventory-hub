import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { decodeJsonObject, encodeJson } from '@hub/db';
import { connectorSyncMode, hasCapability, type SyncMode } from '@hub/connector-sdk';
import { PrismaService } from '../prisma/prisma.service';
import { ConnectorRegistry } from '../connectors/connector-registry.service';
import { CredentialStore } from '../connectors/credential-store.service';
import { pickSchemaFields, validateChannelConfig } from './config-schema';

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

    const instance = await this.prisma.channelInstance.update({
      where: { id },
      data: {
        ...(input.displayName !== undefined ? { displayName: input.displayName.trim() } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.reconcileAutoCorrect !== undefined
          ? { reconcileAutoCorrect: input.reconcileAutoCorrect }
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
      secretFieldsRequired: [...secretFields],
      syncMode: connector ? connectorSyncMode(connector) : 'outbound-only',
      capabilities: connector?.capabilities ?? [],
      healthStatus: connector ? instance.healthStatus : 'error',
      healthDetail: connector
        ? instance.healthDetail
        : `No connector registered for "${instance.connectorKey}".`,
      lastPolledAt: instance.lastPolledAt,
      lastReconciledAt: instance.lastReconciledAt,
      reconcileAutoCorrect: instance.reconcileAutoCorrect,
      webhookPath: receivesWebhooks ? `/api/webhooks/${instance.id}` : null,
      allocationCount: instance._count.allocations,
      createdAt: instance.createdAt,
    };
  }
}
