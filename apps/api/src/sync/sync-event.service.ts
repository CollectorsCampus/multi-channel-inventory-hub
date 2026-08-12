import { Injectable, Logger, Optional } from '@nestjs/common';
import { encodeJson } from '@hub/db';
import { PrismaService } from '../prisma/prisma.service';
import { SyslogService } from './syslog.service';

/**
 * The append-only audit log (§2: "every external mutation is logged before and
 * after execution").
 *
 * Before matters as much as after. A push that never returns — process killed,
 * network black hole — leaves a `pending` row, which is the only evidence the
 * attempt happened at all. Writing only on completion would make those
 * invisible, and they are exactly the failures worth finding.
 */

export type SyncOutcome = 'pending' | 'ok' | 'error' | 'conflict';

export interface SyncEventDraft {
  direction: 'inbound' | 'outbound' | 'reconcile';
  channelInstanceId?: string | null;
  entityType: 'allocation' | 'order' | 'listing' | 'inventory' | 'channel';
  entityId?: string | null;
  operation?: string;
  detail?: string;
  payload?: unknown;
}

@Injectable()
export class SyncEventService {
  private readonly logger = new Logger(SyncEventService.name);

  constructor(
    private readonly prisma: PrismaService,
    // Optional so tests constructing this directly need not care; when
    // absent, nothing is shipped.
    @Optional() private readonly syslog?: SyslogService,
  ) {}

  /** Write the `pending` row before an external call. Returns its id. */
  async begin(draft: SyncEventDraft): Promise<string> {
    const row = await this.prisma.syncEvent.create({
      data: {
        direction: draft.direction,
        channelInstanceId: draft.channelInstanceId ?? null,
        entityType: draft.entityType,
        entityId: draft.entityId ?? null,
        operation: draft.operation ?? null,
        outcome: 'pending',
        detail: truncate(draft.detail),
        // String column holding JSON (ADR 0001 §2).
        payload: draft.payload === undefined ? null : encodeJson(draft.payload),
      },
      select: { id: true },
    });
    return row.id;
  }

  /**
   * Close out an attempt.
   *
   * Updates the pending row rather than appending a second, so the log holds
   * one row per attempt and a reader need not pair them up. It stays
   * append-only in the sense that matters: nothing is deleted, and an outcome
   * is written once.
   */
  async finish(
    syncEventId: string,
    outcome: Exclude<SyncOutcome, 'pending'>,
    extra: { detail?: string; payload?: unknown; durationMs?: number } = {},
  ): Promise<void> {
    try {
      // No `select`, deliberately: the full updated row is what syslog ships,
      // and Prisma returns it from the update anyway — no second read.
      const row = await this.prisma.syncEvent.update({
        where: { id: syncEventId },
        data: {
          outcome,
          detail: truncate(extra.detail),
          ...(extra.payload === undefined ? {} : { payload: encodeJson(extra.payload) }),
          durationMs: extra.durationMs ?? null,
        },
      });
      this.syslog?.emitSyncEvent(row);
    } catch (error) {
      // Losing the audit write must not fail the operation it describes.
      this.logger.warn(`Could not finalise sync event ${syncEventId}: ${(error as Error).message}`);
    }
  }

  /** One-shot record for work with no meaningful "before". */
  async record(
    draft: SyncEventDraft & { outcome: Exclude<SyncOutcome, 'pending'>; durationMs?: number },
  ): Promise<string> {
    const id = await this.begin(draft);
    await this.finish(id, draft.outcome, {
      detail: draft.detail,
      payload: draft.payload,
      durationMs: draft.durationMs,
    });
    return id;
  }
}

/** `detail` is free text from a platform; keep one bad message from bloating a row. */
function truncate(value: string | undefined): string | null {
  return value === undefined ? null : value.slice(0, 2000);
}
