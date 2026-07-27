/**
 * Development seed.
 *
 * Deliberately does NOT create a user: the first admin is created through the
 * first-run setup flow (POST /api/auth/setup) so that no deployment ever ships
 * with a known default credential.
 *
 * Run: pnpm --filter @hub/db seed
 */

import { PrismaClient } from '../generated/client';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed a production database.');
  }

  await prisma.setting.upsert({
    where: { key: 'schema.seededAt' },
    update: { value: new Date().toISOString() },
    create: { key: 'schema.seededAt', value: new Date().toISOString() },
  });

  // A small, realistic slice: one card with two conditions, so the allocation
  // work in Phase 1 has something to operate on.
  const charizard = await prisma.catalogItem.upsert({
    where: { id: 'seed-charizard-base-set' },
    update: {},
    create: {
      id: 'seed-charizard-base-set',
      name: 'Charizard',
      game: 'Pokemon',
      setName: 'Base Set',
      externalRefs: {
        create: [{ source: 'tcgplayer', externalId: '42366' }],
      },
    },
  });

  for (const [condition, quantity, cost] of [
    ['NM', 3, 25_000],
    ['LP', 5, 18_000],
  ] as const) {
    const sku = await prisma.sku.upsert({
      where: {
        catalogItemId_condition_printing_language: {
          catalogItemId: charizard.id,
          condition,
          printing: 'NORMAL',
          language: 'EN',
        },
      },
      update: {},
      create: {
        catalogItemId: charizard.id,
        condition,
        printing: 'NORMAL',
        language: 'EN',
      },
    });

    await prisma.inventoryItem.upsert({
      where: { skuId: sku.id },
      update: {},
      create: { skuId: sku.id, quantityOnHand: quantity, costBasis: cost },
    });
  }

  const items = await prisma.inventoryItem.count();
  console.log(`Seed complete — ${items} inventory item(s).`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
