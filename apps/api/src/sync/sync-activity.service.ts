import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, decodeJson } from '@hub/db';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Reads over the audit log and alert inbox (§7 "Sync activity").
 *
 * Read-only apart from acknowledging and resolving alerts. SyncEvent itself is
 * never edited from here — it is the record of what happened, and a log an
 * operator can rewrite is not evidence.
 */

export interface SyncEventQuery {
  direction?: string;
  outcome?: string;
  channelInstanceId?: string;
  /** Restrict to specific entities — the item detail page passes its allocation ids. */
  entityIds?: string[];
  page?: number;
  pageSize?: number;
}

export interface AlertQuery {
  status?: string;
  kind?: string;
  channelInstanceId?: string;
  page?: number;
  pageSize?: number;
}

@Injectable()
export class SyncActivityService {
  constructor(private readonly prisma: PrismaService) {}

  async listEvents(query: SyncEventQuery) {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, query.pageSize ?? 50));

    const where: Prisma.SyncEventWhereInput = {
      ...(query.direction ? { direction: query.direction } : {}),
      ...(query.outcome ? { outcome: query.outcome } : {}),
      ...(query.channelInstanceId ? { channelInstanceId: query.channelInstanceId } : {}),
      ...(query.entityIds?.length ? { entityId: { in: query.entityIds } } : {}),
    };

    const [total, rows] = await Promise.all([
      this.prisma.syncEvent.count({ where }),
      this.prisma.syncEvent.findMany({
        where,
        orderBy: { ts: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { channelInstance: { select: { displayName: true } } },
      }),
    ]);

    return {
      items: rows.map((row) => ({
        id: row.id,
        ts: row.ts,
        direction: row.direction,
        outcome: row.outcome,
        operation: row.operation,
        entityType: row.entityType,
        entityId: row.entityId,
        detail: row.detail,
        durationMs: row.durationMs,
        channelInstanceId: row.channelInstanceId,
        channelName: row.channelInstance?.displayName ?? null,
        // Stored as a JSON string (ADR 0001 §2). Decoded for the UI, which
        // shows it as the raw record of what crossed the boundary.
        payload: decodeJson<unknown>(row.payload, null),
      })),
      total,
      page,
      pageSize,
      pageCount: Math.ceil(total / pageSize),
    };
  }

  async listAlerts(query: AlertQuery) {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, query.pageSize ?? 50));

    const where: Prisma.AlertWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.channelInstanceId ? { channelInstanceId: query.channelInstanceId } : {}),
    };

    const [total, rows] = await Promise.all([
      this.prisma.alert.count({ where }),
      this.prisma.alert.findMany({
        where,
        // Critical first, then newest. An oversell buried under a page of
        // routine drift notices is an alert nobody acts on.
        orderBy: [{ severity: 'asc' }, { createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { channelInstance: { select: { displayName: true } } },
      }),
    ]);

    return {
      items: rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        severity: row.severity,
        title: row.title,
        detail: row.detail,
        status: row.status,
        channelInstanceId: row.channelInstanceId,
        channelName: row.channelInstance?.displayName ?? null,
        inventoryItemId: row.inventoryItemId,
        context: decodeJson<unknown>(row.context, null),
        acknowledgedBy: row.acknowledgedBy,
        acknowledgedAt: row.acknowledgedAt,
        resolvedAt: row.resolvedAt,
        createdAt: row.createdAt,
      })),
      total,
      page,
      pageSize,
      pageCount: Math.ceil(total / pageSize),
    };
  }

  /** Count of alerts still needing attention, for the nav badge. */
  async openAlertCount(): Promise<number> {
    return this.prisma.alert.count({ where: { status: 'open' } });
  }

  /**
   * Acknowledge: someone has seen it and is dealing with it.
   *
   * Distinct from resolving. An oversell stays visible while the operator sorts
   * out the customer; marking it acknowledged says "this is being handled"
   * without claiming it is finished.
   */
  async acknowledge(id: string, username: string) {
    await this.requireAlert(id);
    return this.prisma.alert.update({
      where: { id },
      data: { status: 'acknowledged', acknowledgedBy: username, acknowledgedAt: new Date() },
    });
  }

  async resolve(id: string, username: string) {
    const alert = await this.requireAlert(id);
    return this.prisma.alert.update({
      where: { id },
      data: {
        status: 'resolved',
        resolvedAt: new Date(),
        // Preserve whoever acknowledged it; resolving straight from open still
        // records who acted.
        acknowledgedBy: alert.acknowledgedBy ?? username,
        acknowledgedAt: alert.acknowledgedAt ?? new Date(),
      },
    });
  }

  /** Reopen a mistakenly-closed alert. Nothing is ever deleted. */
  async reopen(id: string) {
    await this.requireAlert(id);
    return this.prisma.alert.update({
      where: { id },
      data: { status: 'open', resolvedAt: null },
    });
  }

  private async requireAlert(id: string) {
    const alert = await this.prisma.alert.findUnique({ where: { id } });
    if (!alert) throw new NotFoundException(`Alert ${id} not found.`);
    return alert;
  }
}
