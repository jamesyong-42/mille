// Run a package's `test/*.test.mjs` under the Node test runner.
//
// The package scripts used to spell this as `node --test test/*.test.mjs`,
// which relies on the *shell* expanding the glob. pnpm runs package scripts
// through the platform shell, and neither cmd.exe nor PowerShell expands
// globs, so on Windows Node received the pattern verbatim and exited with
// "Could not find 'D:\...\test\*.test.mjs'" before running anything. It worked
// on Linux only because bash expanded it first.
//
// The obvious alternatives do not survive the Node version this repo targets:
//
//   - Quoting the glob and letting Node expand it needs Node >= 21. CI pins
//     Node 20, and `engines` allows it.
//   - `node --test test/` treats the directory as a module to load, not a
//     directory to search ("Cannot find module .../test").
//   - Bare `node --test` recursive discovery matches `**/test/**/*`, which
//     picks up `test/fixtures/panic-probe-child.cjs` — a child-process fixture,
//     not a test — and reports it as a failure.
//
// So expand it here, where the behaviour is explicit and version-independent.
// Extra arguments are forwarded to the runner (e.g. --test-concurrency=4).

import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const TEST_DIR = 'test';

let entries;
try {
  entries = readdirSync(TEST_DIR);
} catch (err) {
  console.error(`run-tests: cannot read ${TEST_DIR}/ in ${process.cwd()}: ${err.message}`);
  process.exit(1);
}

const files = entries
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()
  .map((name) => join(TEST_DIR, name));

if (files.length === 0) {
  // Silence here would look identical to a green run.
  console.error(`run-tests: no *.test.mjs found in ${join(process.cwd(), TEST_DIR)}`);
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], {
  stdio: 'inherit',
});

if (result.error) {
  console.error(`run-tests: failed to start the test runner: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
