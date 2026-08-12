import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@hub/db';
import { EmailService, EMAIL_CREDENTIAL_REF } from './email.service';
import { AlertsService } from './alerts.service';
import { CredentialStore } from '../connectors/credential-store.service';
import type { PrismaService } from '../prisma/prisma.service';

/** The documented all-'A' test key: exactly 32 base64-encoded bytes. */
const TEST_MASTER_KEY = 'QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE=';

function buildCredentials(): CredentialStore {
  const config = { getOrThrow: () => TEST_MASTER_KEY } as unknown as ConfigService;
  return new CredentialStore(prisma as unknown as PrismaService, config);
}

/**
 * The email path with the SMTP transport captured at its factory seam.
 *
 * What is worth pinning is the judgement, not nodemailer: a new alert below
 * the threshold is silent; a flag refreshed at the same severity is silent
 * however often it fires (the anti-flood rule in its email form); an
 * escalation sends exactly once, saying what it was before; and the password
 * round-trips through the credential store without ever appearing in a view.
 */

const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

let prisma: PrismaClient;

interface SentMail {
  from?: string;
  to?: string;
  subject?: string;
  text?: string;
}

function capturingFactory() {
  const sent: SentMail[] = [];
  const factory = () => ({
    sendMail: async (mail: SentMail) => {
      sent.push(mail);
      return { accepted: [mail.to] };
    },
  });
  return { sent, factory };
}

/** Wait for fire-and-forget notifications to settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

describeDb('EmailService', () => {
  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  beforeEach(async () => {
    await prisma.alert.deleteMany();
    await prisma.setting.deleteMany({ where: { key: { startsWith: 'notify.email.' } } });
    await prisma.credential.deleteMany({ where: { ref: EMAIL_CREDENTIAL_REF } });
  });

  function build() {
    const { sent, factory } = capturingFactory();
    const email = new EmailService(prisma as unknown as PrismaService, buildCredentials(), factory);
    const alerts = new AlertsService(prisma as unknown as PrismaService, undefined, email);
    return { email, alerts, sent };
  }

  async function enable(email: EmailService, threshold: 'critical' | 'warning' | 'info') {
    await email.update({
      enabled: true,
      host: 'smtp.example.com',
      from: 'hub@example.com',
      to: 'owner@example.com',
      threshold,
    });
  }

  it('round-trips settings, reporting the password as set but never returning it', async () => {
    const { email } = build();
    await email.update({
      enabled: true,
      host: 'smtp.mx.cloudflare.net',
      port: 465,
      secure: true,
      username: 'api_token',
      password: 'cf-token-value',
      from: 'alerts@example.com',
      to: 'owner@example.com',
      threshold: 'critical',
    });

    const view = await build().email.view();
    expect(view).toEqual({
      enabled: true,
      host: 'smtp.mx.cloudflare.net',
      port: 465,
      secure: true,
      username: 'api_token',
      from: 'alerts@example.com',
      to: 'owner@example.com',
      threshold: 'critical',
      passwordSet: true,
    });
    expect(JSON.stringify(view)).not.toContain('cf-token-value');
  });

  it('refuses to enable without server, from and recipient', async () => {
    const { email } = build();
    await expect(email.update({ enabled: true, host: 'smtp.example.com' })).rejects.toThrow(
      /required to enable/,
    );
  });

  it('emails a new alert at the threshold, and stays silent below it', async () => {
    const { email, alerts, sent } = build();
    await enable(email, 'warning');

    await alerts.raise({ kind: 'oversell', severity: 'critical', title: 'Oversold by 1' });
    await alerts.raise({ kind: 'reconcile_drift', severity: 'info', title: 'Routine notice' });
    await settle();

    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toBe('[Inventory Hub] CRITICAL: Oversold by 1');
    expect(sent[0]!.to).toBe('owner@example.com');
    expect(sent[0]!.text).toContain('Oversold by 1');
  });

  it('names the channel in the body when the alert carries one', async () => {
    const { email, alerts, sent } = build();
    await enable(email, 'warning');
    const channel = await prisma.channelInstance.create({
      data: { connectorKey: 'test', displayName: 'My Storefront', config: '{}' },
    });

    await alerts.raise({
      kind: 'sync_failure',
      severity: 'warning',
      title: 'Push failed',
      channelInstanceId: channel.id,
    });
    await settle();

    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain('Channel: My Storefront');

    await prisma.alert.deleteMany();
    await prisma.channelInstance.delete({ where: { id: channel.id } });
  });

  /**
   * The anti-flood rule in its email form: a flag re-raised at the same
   * severity is occurrence n of a problem already reported. Only a worsening
   * gets a second message, and it says what it worsened from.
   */
  it('emails a flag once, ignores same-severity refreshes, and reports an escalation', async () => {
    const { email, alerts, sent } = build();
    await enable(email, 'warning');

    const flag = {
      kind: 'sync_failure',
      source: 'test:flag',
      severity: 'warning' as const,
      title: 'Push failing',
    };
    await alerts.raiseFlag(flag);
    await alerts.raiseFlag(flag);
    await alerts.raiseFlag(flag);
    await settle();
    expect(sent).toHaveLength(1);

    await alerts.raiseFlag({ ...flag, severity: 'critical' });
    await settle();
    expect(sent).toHaveLength(2);
    expect(sent[1]!.subject).toBe('[Inventory Hub] CRITICAL: Push failing (was warning)');
  });

  it('sends nothing while disabled, whatever the severity', async () => {
    const { alerts, sent } = build();
    await alerts.raise({ kind: 'oversell', severity: 'critical', title: 'Oversold by 1' });
    await settle();
    expect(sent).toHaveLength(0);
  });

  it('reports a test-send failure without throwing', async () => {
    const failing = () => ({
      sendMail: async () => {
        throw new Error('535 Authentication failed');
      },
    });
    const email = new EmailService(prisma as unknown as PrismaService, buildCredentials(), failing);
    await enable(email, 'warning');

    const result = await email.test();
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('535');
  });
});
