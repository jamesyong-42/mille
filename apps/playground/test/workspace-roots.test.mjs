// Phase 5.3 multi-root — workspace root parsing + renderer trust boundary.

import { strict as assert } from 'node:assert';
import { resolve } from 'node:path';
import { test } from 'node:test';

import {
  parseWorkspaceRoots,
  resolveTrustedRoot,
} from '../scripts/workspace-roots.mjs';

test('parseWorkspaceRoots falls back to the primary root', () => {
  assert.deepEqual(parseWorkspaceRoots(undefined, '/ws'), ['/ws']);
  assert.deepEqual(parseWorkspaceRoots('', '/ws'), ['/ws']);
  assert.deepEqual(parseWorkspaceRoots('not json', '/ws'), ['/ws']);
  assert.deepEqual(parseWorkspaceRoots('{"a":1}', '/ws'), ['/ws']);
  assert.deepEqual(parseWorkspaceRoots('[]', '/ws'), ['/ws']);
  assert.deepEqual(parseWorkspaceRoots('[1, null, ""]', '/ws'), ['/ws']);
});

test('parseWorkspaceRoots keeps a well-formed list in order', () => {
  assert.deepEqual(parseWorkspaceRoots('["/a","/b","/c"]', '/a'), [
    '/a',
    '/b',
    '/c',
  ]);
  // Junk entries are dropped, real ones survive.
  assert.deepEqual(parseWorkspaceRoots('["/a", 7, "/b"]', '/a'), ['/a', '/b']);
});

test('resolveTrustedRoot accepts any open root, not just the primary', () => {
  const roots = [resolve('/ws/a'), resolve('/ws/b')];
  // Multi-root SCM needs root B addressable — that is the whole point of
  // grouping destructive actions by owning root.
  assert.equal(resolveTrustedRoot(roots[1], roots), roots[1]);
  assert.equal(resolveTrustedRoot(roots[0], roots), roots[0]);
  // Unnormalized spellings still resolve to the stored root.
  assert.equal(resolveTrustedRoot(`${roots[1]}/../b`, roots), roots[1]);
  // Omitted root falls back to the primary.
  assert.equal(resolveTrustedRoot(undefined, roots), roots[0]);
  assert.equal(resolveTrustedRoot('', roots), roots[0]);
});

test('resolveTrustedRoot rejects a directory outside the workspace', () => {
  const roots = [resolve('/ws/a')];
  for (const bad of [
    resolve('/etc'),
    resolve('/ws'),
    `${resolve('/ws/a')}/../..`,
    resolve('/ws/a-sibling'),
  ]) {
    assert.throws(
      () => resolveTrustedRoot(bad, roots),
      /not an open workspace root/,
      `expected rejection for ${bad}`,
    );
  }
});

test('resolveTrustedRoot returns the stored spelling, not the caller string', () => {
  // Callers pass the result to git; it must be a path the main process
  // chose rather than whatever the renderer sent.
  const roots = [resolve('/ws/a')];
  const returned = resolveTrustedRoot(`${resolve('/ws/a')}/./`, roots);
  assert.equal(returned, roots[0]);
});

test('resolveTrustedRoot refuses when no workspace is open', () => {
  assert.throws(() => resolveTrustedRoot('/ws/a', []), /no workspace root/);
  assert.throws(() => resolveTrustedRoot(undefined, []), /no workspace root/);
});
