import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The published version, read from the package manifest rather than repeated.
 *
 * A second copy of a version string is a copy that gets forgotten at the one
 * moment it matters — a release. The manifest sits beside `dist/` in both the
 * container and a local build, and this module compiles to `dist/version.js`,
 * so the relative path holds however deep the importer lives.
 *
 * Wrapped because this is only a label: a packaging change that moved the
 * manifest should not stop the server booting, and reporting `0.0.0` is a
 * visible wrong answer rather than a silent crash.
 */
function readVersion(): string {
  try {
    const manifest = readFileSync(join(__dirname, '..', 'package.json'), 'utf8');
    return (JSON.parse(manifest) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Read once: the manifest cannot change under a running process. */
const version = readVersion();

export function apiVersion(): string {
  return version;
}
