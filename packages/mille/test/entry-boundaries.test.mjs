// Entry-point boundary guard — remote-workspace PR 2 (SPEC NFR-007).
//
// NFR-007 says the public API "must not import Node-only modules from
// browser-safe entry points". Two facts about this package shape what that
// actually means, and both are easy to get wrong:
//
//  1. **The package root is not a browser-safe entry point and never was.**
//     `index.ts` re-exports the native loader, which needs `node:fs`,
//     `node:path`, `node:module` and `node:url` to find and load a `.node`
//     binary. The browser-safe entries are `./port` (renderer proxy) and
//     `./react`. A renderer that imports the root is already wrong today.
//
//  2. **The framed stream channel imports `node:stream` as a *type* only.**
//     `Duplex` is used in signatures and nowhere at runtime, so TypeScript
//     erases the import entirely and the built module has no Node
//     dependency at all. The `./node` split is therefore about API clarity
//     and tree-shaking, not about keeping a polyfill out of a bundle — and
//     the channel will accept any duck-typed Duplex, including a Truffle
//     mesh socket, without `node:stream` being present.
//
// The guard that matters is the second one staying true, and the renderer
// entries staying clean.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, '../dist');

/** Every import specifier in a built ESM file. */
function importsOf(file) {
  const src = readFileSync(file, 'utf8');
  const specs = [];
  for (const re of [
    /(?:^|[\s;}])(?:import|export)\b[^'"]*?from\s*['"]([^'"]+)['"]/g,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /(?:^|[\s;}])import\s*['"]([^'"]+)['"]/g,
  ]) {
    let m;
    while ((m = re.exec(src)) !== null) specs.push(m[1]);
  }
  return specs;
}

/** Transitively collect the graph rooted at `entry`, plus its bare specifiers. */
function moduleGraph(entry) {
  const seen = new Set();
  const bare = new Set();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    for (const spec of importsOf(file)) {
      if (spec.startsWith('.')) queue.push(resolve(dirname(file), spec));
      else bare.add(spec);
    }
  }
  return { files: seen, bare };
}

const nodeBuiltins = (bare) => [...bare].filter((s) => s.startsWith('node:')).sort();

test('the renderer-facing entries import no node: builtins', () => {
  // react.js is two hooks over a handful of imports; only client-port has a
  // graph worth calling deep. Both must simply resolve and stay clean.
  for (const entry of ['client-port.js', 'react.js']) {
    const { bare, files } = moduleGraph(resolve(dist, entry));
    assert.ok(files.size >= 1, `${entry} did not resolve`);
    assert.deepEqual(
      nodeBuiltins(bare),
      [],
      `${entry} must stay browser-safe, found: ${nodeBuiltins(bare).join(', ')}`,
    );
  }
});

test('the framed stream channel has no runtime Node dependency', () => {
  // `Duplex` is type-only, so this stays empty. If it ever gains a real
  // `node:*` import, the /node split becomes load-bearing for bundlers and
  // this test should be updated deliberately rather than silently.
  const { bare } = moduleGraph(resolve(dist, 'stream/framed-channel.js'));
  assert.deepEqual(
    nodeBuiltins(bare),
    [],
    `framed-channel gained a runtime Node import: ${nodeBuiltins(bare).join(', ')}`,
  );
});

test('the stream channel is reachable from /node and not from the root', () => {
  const viaNode = moduleGraph(resolve(dist, 'node.js'));
  assert.ok(
    [...viaNode.files].some((f) => f.includes('framed-channel')),
    '/node must export the framed channel',
  );

  const viaRoot = moduleGraph(resolve(dist, 'index.js'));
  const leaked = [...viaRoot.files].filter((f) => f.includes('framed-channel'));
  assert.deepEqual(leaked, [], 'framed-channel must not be reachable from the root entry');
});

test('the root entry is Node-only by design, via the native loader', () => {
  // Documents the status quo so a future "make the root browser-safe"
  // change has to confront this test rather than discover it in a bundle.
  const { bare } = moduleGraph(resolve(dist, 'index.js'));
  assert.deepEqual(
    nodeBuiltins(bare),
    ['node:fs', 'node:module', 'node:path', 'node:url'],
    'the root entry loads the native binary; renderers should import ./port',
  );
});
