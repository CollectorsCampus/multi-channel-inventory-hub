import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { decodeJsonObject } from '@hub/db';
import type { Connector, ConnectorLogger, Ctx } from '@hub/connector-sdk';
import { PrismaService } from '../prisma/prisma.service';
import { ConnectorRegistry } from './connector-registry.service';
import { CredentialStore } from './credential-store.service';

/**
 * Builds the `Ctx` handed to a connector for one call (§5).
 *
 * This is the only place secrets are decrypted. They live in the returned
 * object and nowhere else — never written back to config, never logged, never
 * returned to the UI.
 */

export interface ResolvedChannel {
  connector: Connector;
  ctx: Ctx;
  displayName: string;
  enabled: boolean;
}

@Injectable()
export class ChannelContextFactory {
  private readonly logger = new Logger(ChannelContextFactory.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ConnectorRegistry,
    private readonly credentials: CredentialStore,
  ) {}

  /**
   * Resolve a channel instance into its connector plus a ready-to-use context.
   *
   * @param options.requireEnabled reject a disabled channel. Outbound work
   *   should set this; reconciliation and diagnostics may not want to.
   */
  async resolve(
    channelInstanceId: string,
    options: { requireEnabled?: boolean; signal?: AbortSignal } = {},
  ): Promise<ResolvedChannel> {
    const instance = await this.prisma.channelInstance.findUnique({
      where: { id: channelInstanceId },
    });
    if (!instance) {
      throw new NotFoundException(`Channel instance ${channelInstanceId} not found.`);
    }

    if (options.requireEnabled && !instance.enabled) {
      throw new BadRequestException(`Channel "${instance.displayName}" is disabled.`);
    }

    const connector = this.registry.get(instance.connectorKey);

    // config is a String column holding JSON (ADR 0001 §2); decodeJsonObject
    // falls back to {} rather than throwing, so a corrupt row degrades to
    // "misconfigured channel" instead of taking down the worker.
    const config = decodeJsonObject(instance.config);

    // A channel with no credentialRef has never been connected. That is a
    // normal state for a freshly created channel, so secrets are empty rather
    // than an error — connectors needing them should fail with their own
    // message, which will be far more actionable than one from here.
    const secrets = instance.credentialRef
      ? await this.credentials.get(instance.credentialRef)
      : {};

    return {
      connector,
      displayName: instance.displayName,
      enabled: instance.enabled,
      ctx: {
        channelInstanceId: instance.id,
        config,
        secrets: Object.freeze({ ...secrets }),
        logger: this.makeLogger(instance.connectorKey, instance.displayName),
        signal: options.signal,
      },
    };
  }

  /**
   * A logger scoped to one channel.
   *
   * Connector authors are told not to log secrets, but a mistake there would
   * write credentials to an operator's console permanently, so metadata is
   * scrubbed on the way out rather than trusted.
   */
  private makeLogger(connectorKey: string, displayName: string): ConnectorLogger {
    const context = `connector:${connectorKey}`;
    const prefix = `[${displayName}]`;

    const write =
      (level: 'debug' | 'log' | 'warn' | 'error') =>
      (message: string, meta?: Record<string, unknown>) => {
        const safe = meta ? redactSecrets(meta) : undefined;
        this.logger[level](
          safe ? `${prefix} ${message} ${JSON.stringify(safe)}` : `${prefix} ${message}`,
          context,
        );
      };

    return {
      debug: write('debug'),
      info: write('log'),
      warn: write('warn'),
      error: write('error'),
    };
  }
}

const SECRET_KEY_PATTERN = /(secret|token|password|passwd|apikey|api_key|key|credential|auth)/i;

/** Replace values whose key looks sensitive. Shallow by design — logs are not deep. */
export function redactSecrets(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    out[key] = SECRET_KEY_PATTERN.test(key) ? '[redacted]' : value;
  }
  return out;
}
