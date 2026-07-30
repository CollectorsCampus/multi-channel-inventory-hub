import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const sdk = fileURLToPath(new URL('../connector-sdk/src', import.meta.url));

/**
 * Resolve @hub/connector-sdk to its TypeScript source during tests, for the same
 * reasons as the Scryfall package: the published entry points are CommonJS, and
 * aliasing to source means the contract suite runs against the SDK as it is now
 * rather than as it was the last time someone rebuilt it.
 *
 * `@hub/connector-tcgplayer` is deliberately *not* aliased. It is consumed here
 * only for its CSV codec, and reading it from `dist` matches how apps/api
 * consumes connectors — so a change to that codec has to be rebuilt to take
 * effect here, exactly as it would in the API.
 */
export default defineConfig({
  resolve: {
    alias: [
      { find: '@hub/connector-sdk/testing', replacement: `${sdk}/testing.ts` },
      { find: '@hub/connector-sdk', replacement: `${sdk}/index.ts` },
    ],
  },
});
