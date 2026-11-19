import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// A release under dist/ can silently import missing packages from the repo's
// node_modules. Run a copy outside the checkout, just like a fresh installation.
export function smokeFixture(source, kind) {
  const fixture = mkdtempSync(join(tmpdir(), `runember-${kind}-`));
  const runtime = join(fixture, 'runtime space');
  cpSync(resolve(source), runtime, { recursive: true });
  return { fixture, runtime };
}
