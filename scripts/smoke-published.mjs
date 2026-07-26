// Smoke-test a *published* @vibecook/mille against a real installed tree.
//
// CI builds and tests the artifact it just produced. Nothing until now checked
// the artifact npm actually serves, and the two are not the same object: the
// registry copy travelled through `napi pre-publish` version stamping, a
// per-platform package split, an optionalDependencies resolution and a tarball
// round-trip. A binary for the wrong architecture, an empty `.node`, a missing
// `dist/`, or a platform package whose `optionalDependencies` entry never
// resolves would all pass CI and fail on a user's machine.
//
// Seven of the eight platform packages had never been proven to load at all.
//
// Loading is necessary but not sufficient, so this also drives a real walk:
// a `.node` can dlopen cleanly and still be built against the wrong libc or
// miss a symbol that is only reached once work starts.
//
// Usage: node scripts/smoke-published.mjs <installDir> <expectedVersion>

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [installDir, expectedVersion] = process.argv.slice(2);
if (!installDir || !expectedVersion) {
  console.error('usage: smoke-published.mjs <installDir> <expectedVersion>');
  process.exit(2);
}

const entry = pathToFileURL(
  join(installDir, 'node_modules', '@vibecook', 'mille', 'dist', 'index.js'),
).href;

const failures = [];
const check = (label, actual, expected) => {
  const ok = actual === expected;
  console.log(
    `  ${ok ? 'ok  ' : 'FAIL'}  ${label}: ${actual}${ok ? '' : ` (expected ${expected})`}`,
  );
  if (!ok) failures.push(`${label}: got ${actual}, expected ${expected}`);
};

console.log(`Loading published @vibecook/mille from ${installDir}`);
const { FileExplorer, buildIdentity, version } = await import(entry);

const id = buildIdentity();
console.log(JSON.stringify(id, null, 2));

check('packageVersion', id.packageVersion, expectedVersion);
check('nativeVersion', id.nativeVersion, expectedVersion);
check('nativeProfile', id.nativeProfile, 'release');
check('nativePanicStrategy', id.nativePanicStrategy, 'unwind');
check('platform', id.platform, process.platform);
check('arch', id.arch, process.arch);
// The whole point of the per-triple split: a local dev `.node` must not be
// what satisfied the import, or this would be testing nothing.
check('source', id.source, 'platform-package');
check('version() agrees', version(), id.nativeVersion);

// Loading proved dlopen. This proves the thing actually runs: build a small
// tree, walk it natively, and read back what the walk found.
const sandbox = mkdtempSync(join(tmpdir(), 'mille-smoke-'));
try {
  mkdirSync(join(sandbox, 'nested'), { recursive: true });
  writeFileSync(join(sandbox, 'alpha.txt'), 'a');
  writeFileSync(join(sandbox, 'beta.txt'), 'b');
  writeFileSync(join(sandbox, 'nested', 'gamma.txt'), 'c');

  const fx = new FileExplorer({ roots: [sandbox] });
  await fx.populateFromRoots();
  const snap = fx.getSnapshot();
  const roots = snap.roots();

  console.log(`  walk: ${roots.length} root(s), treeVersion=${snap.treeVersion}`);
  if (roots.length !== 1) failures.push(`walk returned ${roots.length} roots, expected 1`);

  const names = [...snap.projectedChildrenOf(roots[0].id)]
    .map((cid) => snap.getById(cid)?.name)
    .sort();
  console.log(`  children: ${JSON.stringify(names)}`);
  for (const expected of ['alpha.txt', 'beta.txt', 'nested']) {
    if (!names.includes(expected)) failures.push(`walk did not find ${expected}`);
  }
} finally {
  rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

if (failures.length > 0) {
  console.error('\nPublished package smoke test FAILED:');
  for (const f of failures) console.error(`::error::${f}`);
  process.exit(1);
}

console.log('\nPublished package smoke test passed.');
