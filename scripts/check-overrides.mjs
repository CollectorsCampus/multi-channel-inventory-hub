#!/usr/bin/env node
/**
 * Every declared pnpm override must survive into the lockfile.
 *
 * ## Why this exists
 *
 * The four overrides in `package.json` are not preferences. Each pins a
 * transitive dependency that a parent exact-pins, which is the only reason
 * `find-my-way`, `js-yaml` and `brace-expansion` resolve to patched versions at
 * all, and the only reason exactly one copy of `fastify` is installed rather
 * than two. `docs`/CLAUDE.md record what each one cost to discover.
 *
 * They are also easy to lose silently. pnpm 9.15.4 already warns that the
 * `pnpm` field in `package.json` "is no longer read" — it still reads it, and
 * an install under that warning writes the overrides into the lockfile exactly
 * as before, but pnpm 10 will not. **Moving them to `pnpm-workspace.yaml` today
 * does not work either**: tested on 2026-08-20 by relocating `fastify@5` alone
 * and re-resolving, which dropped it from the lockfile's `overrides` block
 * entirely. So the pins have to stay where they are until the pnpm 10 upgrade
 * moves them deliberately.
 *
 * The failure mode is the dangerous kind: an install regenerates the lockfile
 * without the overrides, every advisory quietly comes back, and **CI stays
 * green**, because nothing else asserts which versions resolved. This turns
 * that into a red build.
 *
 * ## What it does not check
 *
 * Only that each declared override reaches the lockfile. Whether the resolved
 * version is *reachable* — the argument in CLAUDE.md about advisory
 * preconditions — is a judgement no script can make, and whether it shipped is
 * proven by looking inside the built image at release time.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const declared =
  JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))?.pnpm?.overrides ?? {};
const lockfile = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8');

/**
 * The lockfile's own `overrides:` block, read as text rather than through a
 * YAML parser — this script must run with no dependencies so it cannot itself
 * be broken by the resolution problem it exists to detect.
 */
const block = /^overrides:\n((?:[ \t]+.*\n)*)/m.exec(lockfile)?.[1] ?? '';
const inLockfile = new Map(
  block
    .split('\n')
    .map((line) => /^\s+(\S+):\s*(.+?)\s*$/.exec(line))
    .filter((m) => m !== null)
    .map((m) => [m[1].replace(/^['"]|['"]$/g, ''), m[2].replace(/^['"]|['"]$/g, '')]),
);

const problems = [];
for (const [name, range] of Object.entries(declared)) {
  const found = inLockfile.get(name);
  if (found === undefined) {
    problems.push(`  ${name}: declared as "${range}", missing from the lockfile`);
  } else if (found !== range) {
    problems.push(`  ${name}: declared as "${range}", lockfile says "${found}"`);
  }
}

const count = Object.keys(declared).length;

if (problems.length > 0) {
  console.error(
    `\npnpm overrides are not reaching the lockfile:\n\n${problems.join('\n')}\n\n` +
      'Each of these pins a transitive dependency that its parent exact-pins, so losing one\n' +
      'silently restores a known advisory or installs a second copy of a package. If pnpm has\n' +
      'stopped reading `pnpm.overrides` from package.json, move them to wherever the current\n' +
      'version reads settings from and re-run — do not delete this check.\n',
  );
  process.exit(1);
}

console.log(`All ${count} pnpm override(s) present in the lockfile.`);
