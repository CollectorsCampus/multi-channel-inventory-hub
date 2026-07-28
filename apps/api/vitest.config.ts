import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.spec.ts', 'src/**/*.spec.ts'],
    setupFiles: ['./test/setup-env.ts'],

    /**
     * Run spec files one at a time.
     *
     * Several suites are integration tests sharing one database, and each
     * truncates the tables it uses so it starts from a known state. Run in
     * parallel they delete each other's rows mid-test, producing failures that
     * look like logic bugs — a count assertion off by one — and that vanish
     * when the file is run alone. That is the worst kind of flake.
     *
     * The alternative is a schema or database per file, which is more machinery
     * than a suite this size warrants.
     */
    fileParallelism: false,
  },
  // Vitest transforms with esbuild, which does not implement
  // `emitDecoratorMetadata` — so NestJS DI would see no `design:paramtypes` and
  // every test that builds a module would fail. SWC does implement it.
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
