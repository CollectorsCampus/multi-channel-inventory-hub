import {
  Controller,
  Header,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { encodeJson } from '@hub/db';
import { Public } from '../auth/decorators';
import { PrismaService } from '../prisma/prisma.service';
import { ChannelContextFactory } from '../connectors/channel-context.service';
import { InboundQueue } from '../queue/inbound-queue.service';

/**
 * Webhook ingress (§6, and the first of the three rules in §2).
 *
 * **Does no work inline.** Verify the signature, persist the raw event,
 * enqueue, return 200. Nothing else. A platform that does not get a prompt 200
 * will retry, and several platforms disable an endpoint that is repeatedly slow
 * — so the ledger must never be touched on this path.
 *
 * Public by necessity: the caller is Shopify, not a signed-in operator. The
 * HMAC *is* the authentication, which is why the connector SDK refuses to let a
 * connector declare `orders.webhook` without implementing `verifyWebhook`.
 */
@ApiTags('webhooks')
@Controller('webhooks')
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly channels: ChannelContextFactory,
    private readonly inbound: InboundQueue,
  ) {}

  @Public()
  @Post(':channelInstanceId')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @ApiExcludeEndpoint()
  async receive(
    @Param('channelInstanceId') channelInstanceId: string,
    @Req() request: FastifyRequest & { rawBody?: Buffer },
  ): Promise<{ received: true }> {
    const rawBody = request.rawBody;

    // Without the exact bytes the HMAC cannot be checked, and accepting an
    // unverifiable body would let anyone who learns the URL forge sales.
    if (!rawBody || rawBody.length === 0) {
      throw new UnauthorizedException('Missing request body.');
    }

    const { connector, ctx } = await this.channels.resolve(channelInstanceId);

    if (typeof connector.verifyWebhook !== 'function') {
      throw new UnauthorizedException('This channel does not accept webhooks.');
    }

    const headers = normalizeHeaders(request.headers);

    if (!connector.verifyWebhook(ctx, headers, rawBody)) {
      // Deliberately terse. A detailed reason would help someone probing the
      // endpoint work out what to forge.
      this.logger.warn(`Rejected unverified webhook for channel ${channelInstanceId}`);
      throw new UnauthorizedException('Invalid signature.');
    }

    // Idempotency key for the *delivery*. A hash of the body rather than a
    // platform header: it is connector-agnostic, and a redelivery of the same
    // payload is byte-identical by definition. Per-sale keys come later, from
    // the connector's parsed events.
    const externalEventId = createHash('sha256').update(rawBody).digest('hex');

    const existing = await this.prisma.webhookEvent.findUnique({
      where: { channelInstanceId_externalEventId: { channelInstanceId, externalEventId } },
      select: { id: true },
    });

    // Redeliveries are routine, not errors. Answer 200 so the platform stops
    // retrying, and do not queue the work twice.
    if (existing) {
      this.logger.debug(`Ignoring duplicate webhook delivery ${externalEventId.slice(0, 12)}`);
      return { received: true };
    }

    const event = await this.prisma.webhookEvent.create({
      data: {
        channelInstanceId,
        topic: headers['x-shopify-topic'] ?? headers['x-webhook-topic'] ?? null,
        externalEventId,
        headers: encodeJson(redactAuthHeaders(headers)),
        body: rawBody.toString('utf8'),
        status: 'received',
      },
      select: { id: true },
    });

    // If enqueueing fails the row still exists with status `received`, so the
    // delivery is recoverable rather than lost. Returning 500 would make the
    // platform redeliver, which the dedupe above would then discard — leaving
    // the work stuck. Better to 200 and let a sweep pick it up.
    try {
      await this.inbound.enqueue(event.id);
    } catch (error) {
      this.logger.error(
        `Persisted webhook ${event.id} but could not queue it: ${(error as Error).message}`,
      );
    }

    return { received: true };
  }
}

function normalizeHeaders(headers: FastifyRequest['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[key.toLowerCase()] = Array.isArray(value) ? (value[0] ?? '') : String(value);
  }
  return out;
}

/**
 * Headers are stored for debugging, so anything bearing a credential is
 * stripped first — this row is readable by any admin and lives indefinitely.
 * The HMAC itself is kept: it is a signature over a body we already store, and
 * it is what makes a rejected delivery diagnosable.
 */
function redactAuthHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = /^(authorization|cookie|proxy-authorization)$/i.test(key) ? '[redacted]' : value;
  }
  return out;
}
