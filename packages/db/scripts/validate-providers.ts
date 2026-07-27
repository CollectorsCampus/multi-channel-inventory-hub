/**
 * Validates the canonical schema against every supported dialect.
 *
 * Phase 0 ships a Postgres-only migration history, so the 3-DB test matrix in
 * TECHNICAL_DESIGN.md §3 does not exist yet. This is the cheap stand-in: it
 * catches violations of the portability rules (dialect-specific native types,
 * unsupported scalars, unsupported attributes) at near-zero cost. It does NOT
 * catch behavioural drift between dialects — only a real test matrix does that.
 *
 * Run: pnpm --filter @hub/db validate:all
 */

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CANONICAL_PROVIDER = 'postgresql';

const PROVIDERS: Record<string, string> = {
  postgresql: 'postgresql://user:pass@localhost:5432/db',
  mysql: 'mysql://user:pass@localhost:3306/db',
  sqlite: 'file:./validate.db',
};

const here = fileURLToPath(new URL('.', import.meta.url));
const schemaPath = join(here, '..', 'prisma', 'schema.prisma');
const canonical = readFileSync(schemaPath, 'utf8');

/**
 * Resolve the Prisma CLI entry point and run it with `node` directly.
 *
 * Invoking the `prisma` shim instead would need `shell: true` on Windows,
 * which concatenates arguments unescaped — Node flags that as a security
 * hazard (DEP0190), and paths here come from tmpdir().
 */
const require = createRequire(import.meta.url);
const prismaPkgPath = require.resolve('prisma/package.json');
const prismaPkg = JSON.parse(readFileSync(prismaPkgPath, 'utf8')) as {
  bin?: string | Record<string, string>;
};
const binEntry = typeof prismaPkg.bin === 'string' ? prismaPkg.bin : prismaPkg.bin?.prisma;
if (!binEntry) {
  console.error(`Could not locate the Prisma CLI entry point from ${prismaPkgPath}.`);
  process.exit(1);
}
const prismaCli = join(dirname(prismaPkgPath), binEntry);

const providerLine = new RegExp(`provider\\s*=\\s*"${CANONICAL_PROVIDER}"`);
if (!providerLine.test(canonical)) {
  console.error(
    `Could not find \`provider = "${CANONICAL_PROVIDER}"\` in ${schemaPath}. ` +
      `Update CANONICAL_PROVIDER in this script if the reference dialect changed.`,
  );
  process.exit(1);
}

const workDir = mkdtempSync(join(tmpdir(), 'hub-schema-'));
let failed = false;

try {
  for (const [provider, url] of Object.entries(PROVIDERS)) {
    const variant = canonical.replace(providerLine, `provider = "${provider}"`);
    const variantPath = join(workDir, `schema.${provider}.prisma`);

    // Must be written without a BOM; the Prisma parser rejects one outright.
    writeFileSync(variantPath, variant, { encoding: 'utf8' });

    try {
      execFileSync(process.execPath, [prismaCli, 'validate', '--schema', variantPath], {
        stdio: 'pipe',
        env: { ...process.env, DATABASE_URL: url },
      });
      console.log(`  ok    ${provider}`);
    } catch (error) {
      failed = true;
      const err = error as { stdout?: Buffer; stderr?: Buffer };
      const output = `${err.stdout?.toString() ?? ''}${err.stderr?.toString() ?? ''}`.trim();
      console.error(`  FAIL  ${provider}\n${output.replace(/^/gm, '        ')}`);
    }
  }
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

if (failed) {
  console.error('\nSchema is not portable across all supported dialects.');
  process.exit(1);
}
console.log('\nSchema validates against all supported dialects.');
