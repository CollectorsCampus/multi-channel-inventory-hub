import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.spec.ts', 'src/**/*.spec.ts'],
    setupFiles: ['./test/setup-env.ts'],
  },
  // Vitest transforms with esbuild, which does not implement
  // `emitDecoratorMetadata` — so NestJS DI would see no `design:paramtypes` and
  // every test that builds a module would fail. SWC does implement it.
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
