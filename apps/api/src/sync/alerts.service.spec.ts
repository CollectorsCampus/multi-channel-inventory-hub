import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient, decodeJson } from '@hub/db';
import { AlertsService, SEVERITY_RANK, rankOf } from './alerts.service';
import { SyncActivityService } from './sync-activity.service';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * Alert raising against a real database.
 *
 * Two things here are regressions waiting to happen rather than hypotheticals.
 *
 * `severityRank` is derived from `severity`, and a derived column is only safe
 * while one writer owns it — so the ordering assertions below are written
 * against the *strings* an operator sees, not against the ranks, and would fail
 * if the two ever disagreed.
 *
 * Flag semantics are the other. The inbox is only useful while a condition that
 * stays true produces one row, and the version of this code before
 * `AlertsService` created one alert per sale for an unmapped listing.
 */

const dbUrl = process.env.TEST_DATABASE_URL;
const describeAlerts = dbUrl ? describe : describe.skip;

let prisma: PrismaClient;
let alerts: AlertsService;
let activity: SyncActivityService;
let channelId: string;
let otherChannelId: string;

describeAlerts('AlertsService', () => {
  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });
    await prisma.$connect();
    alerts = new AlertsService(prisma as unknown as PrismaService);
    activity = new SyncActivityService(prisma as unknown as PrismaService);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.alert.deleteMany();
    await prisma.inventoryItem.deleteMany();
    await prisma.sku.deleteMany();
    await prisma.catalogItem.deleteMany();
    await prisma.channelInstance.deleteMany();

    const make = async (name: string) =>
      (
        await prisma.channelInstance.create({
          data: { connectorKey: 'test-alerts', displayName: name, config: '{}' },
        })
      ).id;

    channelId = await make('Channel A');
    otherChannelId = await make('Channel B');
  });

  /** A ledger row for an alert to point at. */
  async function seedItem(): Promise<string> {
    const catalogItem = await prisma.catalogItem.create({
      data: {
        name: `Card ${Math.random().toString(36).slice(2, 10)}`,
        searchName: 'card',
        skus: { create: [{ condition: 'NM', printing: 'NORMAL', language: 'EN' }] },
      },
      include: { skus: true },
    });
    const item = await prisma.inventoryItem.create({
      data: { skuId: catalogItem.skus[0]!.id, quantityOnHand: 1 },
    });
    return item.id;
  }

  // -------------------------------------------------------------------------

  describe('severity rank', () => {
    it('stores a rank matching the severity for every severity', async () => {
      for (const severity of ['critical', 'warning', 'info'] as const) {
        await alerts.raise({ kind: 'oversell', severity, title: severity });
      }

      const rows = await prisma.alert.findMany({ select: { severity: true, severityRank: true } });

      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(row.severityRank).toBe(SEVERITY_RANK[row.severity as 'critical']);
      }
    });

    it('ranks an unknown severity as a warning rather than to the top', () => {
      // Fails safe. Sorting an unrecognised severity to rank 0 would let a typo
      // outrank every real critical in the inbox.
      expect(rankOf('not-a-severity')).toBe(SEVERITY_RANK.warning);
      expect(rankOf('')).toBe(SEVERITY_RANK.warning);
    });
  });

  /**
   * The bug this whole column exists for. Ordering by the severity *string*
   * sorts alphabetically — critical, info, warning — so an info notice appeared
   * above a warning. Asserting on the strings means this test describes what an
   * operator sees rather than the mechanism underneath it.
   */
  describe('inbox ordering', () => {
    it('orders by urgency, not alphabetically', async () => {
      await alerts.raise({ kind: 'reconcile_drift', severity: 'info', title: 'info one' });
      await alerts.raise({ kind: 'sync_failure', severity: 'warning', title: 'warning one' });
      await alerts.raise({ kind: 'oversell', severity: 'critical', title: 'critical one' });

      const page = await activity.listAlerts({});

      expect(page.items.map((a) => a.severity)).toEqual(['critical', 'warning', 'info']);
    });

    it('puts a newer alert first within one severity', async () => {
      await alerts.raise({ kind: 'oversell', severity: 'critical', title: 'older' });
      await new Promise((r) => setTimeout(r, 5));
      await alerts.raise({ kind: 'oversell', severity: 'critical', title: 'newer' });

      const page = await activity.listAlerts({});

      expect(page.items.map((a) => a.title)).toEqual(['newer', 'older']);
    });

    it('keeps a critical on top of a page full of info notices', async () => {
      for (let i = 0; i < 30; i += 1) {
        await alerts.raise({ kind: 'reconcile_drift', severity: 'info', title: `noise ${i}` });
      }
      await alerts.raise({ kind: 'oversell', severity: 'critical', title: 'the one that matters' });

      const page = await activity.listAlerts({ pageSize: 10 });

      expect(page.items[0]!.title).toBe('the one that matters');
    });
  });

  // -------------------------------------------------------------------------

  describe('flags', () => {
    const flag = (overrides: Record<string, unknown> = {}) =>
      alerts.raiseFlag({
        kind: 'sync_failure',
        source: 'outbound:push-failure',
        severity: 'warning',
        channelInstanceId: channelId,
        title: 'Could not push',
        ...overrides,
      });

    it('raises one row however many times the condition recurs', async () => {
      await flag();
      await flag();
      await flag();

      expect(await prisma.alert.count()).toBe(1);
    });

    it('counts the occurrences it collapsed', async () => {
      await flag();
      const second = await flag();

      expect(second.occurrences).toBe(2);

      const row = await prisma.alert.findFirstOrThrow();
      expect(decodeJson<{ occurrences?: number }>(row.context, {}).occurrences).toBe(2);
    });

    it('gives the title and detail the running count', async () => {
      await alerts.raiseFlag({
        kind: 'sync_failure',
        source: 's',
        severity: 'warning',
        channelInstanceId: channelId,
        title: (n) => `failed ${n} times`,
        detail: (n) => `detail ${n}`,
      });
      await alerts.raiseFlag({
        kind: 'sync_failure',
        source: 's',
        severity: 'warning',
        channelInstanceId: channelId,
        title: (n) => `failed ${n} times`,
        detail: (n) => `detail ${n}`,
      });

      const row = await prisma.alert.findFirstOrThrow();
      expect(row.title).toBe('failed 2 times');
      expect(row.detail).toBe('detail 2');
    });

    /**
     * A flag stands for many occurrences but describes the **latest**, and the
     * item it names is what the inbox offers a link to. Kept from the first
     * raise, that link would point at one card beside text about another —
     * worse than no link, because it reads as a fact rather than as staleness.
     */
    it('re-points at the item of the latest occurrence, and lets go of it', async () => {
      const flag = (inventoryItemId?: string) => ({
        kind: 'sync_failure',
        source: 's',
        severity: 'warning' as const,
        channelInstanceId: channelId,
        title: 'failed',
        ...(inventoryItemId ? { inventoryItemId } : {}),
      });

      const first = await seedItem();
      const second = await seedItem();

      await alerts.raiseFlag(flag(first));
      expect((await prisma.alert.findFirstOrThrow()).inventoryItemId).toBe(first);

      await alerts.raiseFlag(flag(second));
      expect((await prisma.alert.findFirstOrThrow()).inventoryItemId).toBe(second);

      // A later failure with no item clears it rather than leaving the last
      // one standing, for the same reason.
      await alerts.raiseFlag(flag());
      expect((await prisma.alert.findFirstOrThrow()).inventoryItemId).toBeNull();
    });

    /**
     * The separation CLAUDE.md relies on: the reconcile sweep and the inbound
     * worker both file `reconcile_drift` for the same channel, and each must be
     * able to raise and clear without touching the other.
     */
    it('keeps two sources of the same kind on one channel apart', async () => {
      await alerts.raiseFlag({
        kind: 'reconcile_drift',
        source: 'reconcile-sweep',
        severity: 'warning',
        channelInstanceId: channelId,
        title: 'drift',
      });
      await alerts.raiseFlag({
        kind: 'reconcile_drift',
        source: 'inbound:unmapped-listing',
        severity: 'info',
        channelInstanceId: channelId,
        title: 'unmapped',
      });

      expect(await prisma.alert.count()).toBe(2);

      await alerts.clearFlag('reconcile_drift', channelId, 'reconcile-sweep');

      const open = await prisma.alert.findMany({ where: { status: 'open' } });
      expect(open).toHaveLength(1);
      expect(open[0]!.title).toBe('unmapped');
    });

    it('keeps the same source on two channels apart', async () => {
      await flag();
      await flag({ channelInstanceId: otherChannelId });

      expect(await prisma.alert.count()).toBe(2);
    });

    it('starts a new flag once the old one is resolved', async () => {
      await flag();
      await alerts.clearFlag('sync_failure', channelId, 'outbound:push-failure');
      const again = await flag();

      // Not a continuation of the resolved one: the count restarts, because the
      // condition genuinely recurred rather than never having stopped.
      expect(again.occurrences).toBe(1);
      expect(await prisma.alert.count()).toBe(2);
      expect(await prisma.alert.count({ where: { status: 'open' } })).toBe(1);
    });

    it('reports whether there was anything to clear', async () => {
      expect(await alerts.clearFlag('sync_failure', channelId, 'nothing-here')).toBe(false);
      await flag();
      expect(await alerts.clearFlag('sync_failure', channelId, 'outbound:push-failure')).toBe(true);
    });

    /**
     * A condition can worsen while its flag is open. Leaving the original
     * severity would leave it sorted where it no longer belongs — and the rank
     * has to move with it, or the inbox order and the badge disagree.
     */
    it('re-ranks when a flag worsens', async () => {
      await flag({ severity: 'info' });
      await flag({ severity: 'critical' });

      const row = await prisma.alert.findFirstOrThrow();
      expect(row.severity).toBe('critical');
      expect(row.severityRank).toBe(SEVERITY_RANK.critical);
    });
  });

  // -------------------------------------------------------------------------

  describe('per-occurrence alerts', () => {
    /**
     * Oversells are deliberately not flags. Each is a different customer whose
     * order someone has to deal with, so collapsing them would hide work rather
     * than reduce noise.
     */
    it('raises a row per occurrence', async () => {
      await alerts.raise({
        kind: 'oversell',
        severity: 'critical',
        channelInstanceId: channelId,
        title: 'Oversold by 1',
      });
      await alerts.raise({
        kind: 'oversell',
        severity: 'critical',
        channelInstanceId: channelId,
        title: 'Oversold by 2',
      });

      expect(await prisma.alert.count({ where: { kind: 'oversell' } })).toBe(2);
    });

    it('stores context as JSON the reader can decode', async () => {
      await alerts.raise({
        kind: 'oversell',
        severity: 'critical',
        title: 'Oversold',
        context: { allocationId: 'alloc-1', shortfall: 3 },
      });

      const row = await prisma.alert.findFirstOrThrow();
      expect(decodeJson<{ allocationId?: string; shortfall?: number }>(row.context, {})).toEqual({
        allocationId: 'alloc-1',
        shortfall: 3,
      });
    });
  });
});
