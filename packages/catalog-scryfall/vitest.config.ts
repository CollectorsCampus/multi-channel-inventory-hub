import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const sdk = fileURLToPath(new URL('../connector-sdk/src', import.meta.url));

/**
 * Resolve @hub/connector-sdk to its TypeScript source during tests.
 *
 * Two reasons. The published entry points are CommonJS (the API is NestJS, which
 * is CJS), and `@hub/connector-sdk/testing` imports vitest — which cannot be
 * `require()`d from a CJS module. Aliasing to source sidesteps that entirely.
 *
 * It also means the contract suite runs against the SDK as it is now, not as it
 * was the last time someone remembered to rebuild it. A connector passing a
 * stale copy of the contract is exactly the failure this suite exists to
 * prevent.
 */
export default defineConfig({
  resolve: {
    alias: [
      { find: '@hub/connector-sdk/testing', replacement: `${sdk}/testing.ts` },
      { find: '@hub/connector-sdk', replacement: `${sdk}/index.ts` },
    ],
  },
});
