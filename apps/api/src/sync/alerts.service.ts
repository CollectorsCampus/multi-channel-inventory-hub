import { Injectable, Optional } from '@nestjs/common';
import { decodeJson, encodeJson } from '@hub/db';
import { PrismaService } from '../prisma/prisma.service';
import { SyslogService } from './syslog.service';
import { EmailService } from './email.service';

/**
 * The only writer of alerts (§7).
 *
 * It exists for two reasons, both of which were bugs before it did.
 *
 * **`severityRank` is derived from `severity`.** Ordering the inbox by the
 * severity *string* sorts alphabetically — critical, info, warning — so routine
 * info notices outranked real warnings, which is the exact inversion the inbox
 * ordering was meant to prevent. Postgres cannot express a custom order without
 * raw SQL (rule 1), so the order is stored. A derived column is only safe while
 * one writer owns it; this is that writer, and a test asserts the two can never
 * disagree.
 *
 * **Flag semantics were hand-rolled in three places and absent in a fourth.**
 * The outbound worker and the reconcile sweep each had their own find-then-
 * update-or-create; the inbound worker's unmapped-listing alert had none at
 * all, so a store with one unmapped listing selling steadily produced one alert
 * per sale. `raiseFlag` is that logic, once.
 */

export type AlertSeverity = 'info' | 'warning' | 'critical';

/**
 * Ascending by urgency, so `orderBy: { severityRank: 'asc' }` puts the most
 * urgent first. Values are spaced by 1 deliberately: a new severity between two
 * existing ones is a migration, not an accident of arithmetic.
 */
export const SEVERITY_RANK: Record<AlertSeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

/** Matches the column default, so an unknown severity sorts as a warning. */
const DEFAULT_RANK = SEVERITY_RANK.warning;

export function rankOf(severity: string): number {
  return SEVERITY_RANK[severity as AlertSeverity] ?? DEFAULT_RANK;
}

export interface RaiseAlertInput {
  kind: string;
  severity: AlertSeverity;
  title: string;
  detail?: string;
  channelInstanceId?: string | null;
  inventoryItemId?: string | null;
  skuId?: string | null;
  context?: Record<string, unknown>;
}

export interface RaiseFlagInput extends Omit<RaiseAlertInput, 'title' | 'detail'> {
  /**
   * Null for a condition that is not about a channel at all.
   *
   * Every original flag was a sync fact, so this was required. A split catalog
   * item is the first that is not: it is about the ledger's own data and would
   * be just as true with no channel connected. The identity below is
   * `(kind, channelInstanceId, source)` either way, and `null` is a perfectly
   * good third of a key.
   */
  channelInstanceId?: string | null;

  /**
   * Discriminator within (kind, channel).
   *
   * Two different facts legitimately share a kind: the reconcile sweep and the
   * inbound worker both file `reconcile_drift` for the same channel, and
   * closing one because the other cleared would discard it. Stored in context
   * because the schema has no column for it and adding one for a value only
   * this service reads would be a wider change than the problem.
   */
  source: string;

  /** Given how many times this flag has been raised, including this one. */
  title: string | ((occurrences: number) => string);
  detail?: string | ((occurrences: number) => string);
}

@Injectable()
export class AlertsService {
  constructor(
    private readonly prisma: PrismaService,
    // Optional so the many tests that construct this service directly need
    // not care about shipping; when absent, nothing is emitted.
    @Optional() private readonly syslog?: SyslogService,
    @Optional() private readonly email?: EmailService,
  ) {}

  /**
   * Raise a new alert unconditionally.
   *
   * For facts where each occurrence needs its own resolution — an oversell is
   * the case that matters, because each one is a different customer whose order
   * someone has to deal with. Do not use it for a condition that simply stays
   * true; that is `raiseFlag`.
   */
  async raise(input: RaiseAlertInput): Promise<{ id: string }> {
    const created = await this.prisma.alert.create({
      data: {
        kind: input.kind,
        severity: input.severity,
        severityRank: rankOf(input.severity),
        channelInstanceId: input.channelInstanceId ?? null,
        inventoryItemId: input.inventoryItemId ?? null,
        skuId: input.skuId ?? null,
        title: input.title,
        detail: input.detail,
        context: input.context ? encodeJson(input.context) : null,
        status: 'open',
      },
      select: { id: true },
    });
    this.syslog?.emitAlert({
      event: 'raised',
      kind: input.kind,
      severity: input.severity,
      title: input.title,
      detail: input.detail,
      channelInstanceId: input.channelInstanceId,
    });
    this.email?.notifyAlert({
      severity: input.severity,
      kind: input.kind,
      title: input.title,
      detail: input.detail,
      channelInstanceId: input.channelInstanceId,
    });
    return created;
  }

  /**
   * Raise or refresh one open alert per (kind, channel, source).
   *
   * "Alerts are flags, not tallies": a channel that is broken is one problem
   * however many pushes fail against it, and an alert per failure trains an
   * operator to ignore the inbox — the one outcome alerting cannot survive. The
   * count is kept in context so the detail can still say how often, without
   * multiplying rows.
   *
   * Only alerts this service raised under the same `source` are touched.
   */
  async raiseFlag(input: RaiseFlagInput): Promise<{ id: string; occurrences: number }> {
    const existing = await this.findFlag(input.kind, input.channelInstanceId, input.source);

    const occurrences = (existing?.occurrences ?? 0) + 1;
    const title = typeof input.title === 'function' ? input.title(occurrences) : input.title;
    const detail = typeof input.detail === 'function' ? input.detail(occurrences) : input.detail;

    const context = encodeJson({
      ...(input.context ?? {}),
      source: input.source,
      occurrences,
    });

    if (existing) {
      await this.prisma.alert.update({
        where: { id: existing.id },
        // Severity is refreshed too: a condition can worsen while its flag is
        // open, and leaving the original severity would hide that.
        data: {
          title,
          detail,
          context,
          severity: input.severity,
          severityRank: rankOf(input.severity),
          // Refreshed with the rest, and `?? null` rather than left alone: a
          // flag stands for many occurrences but describes the **latest**, so
          // the row it points at has to be the one `detail` is talking about.
          // Kept it would name the first failure beside text about the most
          // recent — which is worse than no link at all, because it reads as a
          // fact rather than as staleness.
          inventoryItemId: input.inventoryItemId ?? null,
        },
      });
      // Shipped on every refresh, unlike email: syslog is a log stream, and
      // deduplication is the collector's job, not ours.
      this.syslog?.emitAlert({
        event: 'refreshed',
        kind: input.kind,
        severity: input.severity,
        title,
        detail,
        channelInstanceId: input.channelInstanceId,
        occurrences,
      });
      // Email only when the condition *worsened* — a refresh at the same
      // severity is occurrence n of a problem the operator already heard
      // about, and re-sending it is how a sender gets filtered.
      if (rankOf(input.severity) < rankOf(existing.severity)) {
        this.email?.notifyAlert({
          severity: input.severity,
          kind: input.kind,
          title,
          detail,
          channelInstanceId: input.channelInstanceId,
          escalatedFrom: existing.severity,
        });
      }
      return { id: existing.id, occurrences };
    }

    const created = await this.raise({
      ...input,
      title,
      detail,
      context: { ...(input.context ?? {}), source: input.source, occurrences },
    });
    return { id: created.id, occurrences };
  }

  /**
   * Resolve the flag for (kind, channel, source), if it is open.
   *
   * Self-clearing matters: a flag that stays raised after the problem is gone
   * is a flag nobody trusts.
   */
  async clearFlag(kind: string, channelInstanceId: string, source: string): Promise<boolean> {
    const existing = await this.findFlag(kind, channelInstanceId, source);
    if (!existing) return false;

    await this.prisma.alert.update({
      where: { id: existing.id },
      data: { status: 'resolved', resolvedAt: new Date() },
    });
    this.syslog?.emitAlert({
      event: 'resolved',
      kind,
      severity: 'info',
      title: `Flag cleared (${source})`,
      channelInstanceId,
    });
    return true;
  }

  private async findFlag(
    kind: string,
    channelInstanceId: string | null | undefined,
    source: string,
  ): Promise<{ id: string; occurrences: number; severity: string } | null> {
    // Filtered in memory on `source` because it lives inside the JSON-encoded
    // context string (ADR 0001 §2) and there is no column to index. The set is
    // bounded by "open alerts of one kind on one channel", which flag semantics
    // keep at a handful.
    const open = await this.prisma.alert.findMany({
      // `?? null` rather than passing undefined through: Prisma drops an
      // undefined filter entirely, which would match alerts on *every* channel
      // and let an unrelated one masquerade as this flag.
      where: { kind, channelInstanceId: channelInstanceId ?? null, status: 'open' },
      select: { id: true, context: true, severity: true },
    });

    for (const alert of open) {
      const ctx = decodeJson<{ source?: string; occurrences?: number }>(alert.context, {});
      if (ctx.source === source) {
        return { id: alert.id, occurrences: ctx.occurrences ?? 1, severity: alert.severity };
      }
    }
    return null;
  }
}
