import * as dgram from 'node:dgram';
import * as net from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@hub/db';
import { SyslogService } from './syslog.service';
import { AlertsService } from './alerts.service';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * The shipping path against real sockets and a real database.
 *
 * What is worth pinning: a raised alert actually arrives at a UDP collector as
 * a parseable RFC 5424 message; TCP frames with an octet count and reports an
 * unreachable collector without throwing into the caller; and the whole
 * feature stays inert while disabled — the alert write itself must never
 * depend on any of it.
 */

const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

let prisma: PrismaClient;

/** Bind an ephemeral UDP listener and resolve with the first datagram. */
function udpCollector(): Promise<{ port: number; message: Promise<string>; close: () => void }> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    const message = new Promise<string>((resolveMessage) => {
      socket.on('message', (buf) => resolveMessage(buf.toString('utf8')));
    });
    socket.bind(0, '127.0.0.1', () => {
      resolve({ port: socket.address().port, message, close: () => socket.close() });
    });
  });
}

describeDb('SyslogService', () => {
  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  beforeEach(async () => {
    await prisma.alert.deleteMany();
    await prisma.setting.deleteMany({ where: { key: { startsWith: 'notify.syslog.' } } });
  });

  function build() {
    return new SyslogService(prisma as unknown as PrismaService);
  }

  it('round-trips settings through the Setting table', async () => {
    const service = build();
    await service.update({ enabled: true, host: '127.0.0.1', port: 6514, protocol: 'tcp' });

    // A fresh instance must read the same answer back from the database.
    expect(await build().view()).toEqual({
      enabled: true,
      host: '127.0.0.1',
      port: 6514,
      protocol: 'tcp',
    });
  });

  it('refuses to enable with no collector address', async () => {
    await expect(build().update({ enabled: true })).rejects.toThrow(/address is required/);
  });

  it('ships a raised alert to a UDP collector as RFC 5424 JSON', async () => {
    const collector = await udpCollector();
    try {
      const syslog = build();
      await syslog.update({
        enabled: true,
        host: '127.0.0.1',
        port: collector.port,
        protocol: 'udp',
      });

      const alerts = new AlertsService(prisma as unknown as PrismaService, syslog);
      await alerts.raise({
        kind: 'oversell',
        severity: 'critical',
        title: 'Oversold by 1',
        detail: 'Order #1 requested more than was on hand.',
      });

      const line = await collector.message;
      // critical -> crit (2): local0 (16) * 8 + 2 = 130.
      expect(line).toMatch(/^<130>1 /);
      expect(line).toContain(' inventory-hub - alert - ');
      const body = JSON.parse(line.slice(line.indexOf(' - {') + 3)) as Record<string, unknown>;
      expect(body).toMatchObject({
        event: 'raised',
        kind: 'oversell',
        severity: 'critical',
        title: 'Oversold by 1',
      });
    } finally {
      collector.close();
    }
  });

  it('ships over TCP with octet framing, and the test endpoint confirms delivery', async () => {
    const received: Buffer[] = [];
    const server = net.createServer((socket) => {
      socket.on('data', (chunk) => received.push(chunk));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;

    try {
      const syslog = build();
      await syslog.update({ enabled: true, host: '127.0.0.1', port, protocol: 'tcp' });

      const result = await syslog.test();
      expect(result.ok).toBe(true);

      // Give the server a beat to receive what the client already flushed.
      await new Promise((resolve) => setTimeout(resolve, 100));
      const frame = Buffer.concat(received).toString('utf8');
      const space = frame.indexOf(' ');
      const declared = Number(frame.slice(0, space));
      const message = frame.slice(space + 1);
      expect(Buffer.byteLength(message, 'utf8')).toBe(declared);
      expect(message).toContain(' inventory-hub - test - ');
    } finally {
      server.close();
    }
  });

  it('reports an unreachable TCP collector without throwing', async () => {
    const syslog = build();
    // A port nothing listens on: bind-then-close guarantees it is free.
    const probe = net.createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const deadPort = (probe.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    await syslog.update({ enabled: true, host: '127.0.0.1', port: deadPort, protocol: 'tcp' });
    const result = await syslog.test();
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/failed/);
  });

  /**
   * The inert path is the important one: with syslog disabled (the default),
   * raising an alert must behave exactly as it always has.
   */
  it('stays inert while disabled, and the alert write succeeds regardless', async () => {
    const syslog = build();
    const alerts = new AlertsService(prisma as unknown as PrismaService, syslog);

    const { id } = await alerts.raise({
      kind: 'sync_failure',
      severity: 'warning',
      title: 'Push failed',
    });
    expect(id).toBeTruthy();
  });
});
