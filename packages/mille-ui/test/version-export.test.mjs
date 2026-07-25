// The public `VERSION` export must match the version actually published.
//
// It had drifted to '0.1.0' while the package shipped as 0.2.1 — three
// releases stale — because nothing ever compared the two. A consumer reading
// `VERSION` to report a bug or gate a feature was being told the wrong thing.
// Hardcoding it is fine; leaving it unguarded is what let it rot.

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(__dirname, '..');

const packageVersion = JSON.parse(await readFile(join(pkgRoot, 'package.json'), 'utf8')).version;

// Every entry point that exports one, not just the barrel — they are separate
// literals and drifted together only by luck.
const sources = ['src/index.ts', 'src/testing.ts', 'src/tailwind-preset.ts'];

test('every exported VERSION matches package.json', async () => {
  const mismatches = [];
  for (const rel of sources) {
    const text = await readFile(join(pkgRoot, rel), 'utf8');
    const match = text.match(/export const VERSION = '([^']+)';/);
    if (!match) {
      mismatches.push(`${rel}: no VERSION export found`);
      continue;
    }
    if (match[1] !== packageVersion) {
      mismatches.push(`${rel}: exports ${match[1]}, package.json says ${packageVersion}`);
    }
  }

  assert.deepEqual(mismatches, [], `VERSION export drift:\n  ${mismatches.join('\n  ')}`);
});
