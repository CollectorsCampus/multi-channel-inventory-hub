import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const sdk = fileURLToPath(new URL('../connector-sdk/src', import.meta.url));

/** See packages/catalog-scryfall/vitest.config.ts for why this alias exists. */
export default defineConfig({
  resolve: {
    alias: [
      { find: '@hub/connector-sdk/testing', replacement: `${sdk}/testing.ts` },
      { find: '@hub/connector-sdk', replacement: `${sdk}/index.ts` },
    ],
  },
});
