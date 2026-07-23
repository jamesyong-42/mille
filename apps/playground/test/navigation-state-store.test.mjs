import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createNavigationStateStore } from '../scripts/navigation-state-store.mjs';

function state(label) {
  return JSON.stringify({
    version: 1,
    expandedPaths: [`${label}/src`],
    selectedPaths: [],
    focusedPath: null,
    filter: '',
    searchMode: 'off',
    scrollAnchor: null,
  });
}

test('workspace navigation state survives a fresh store instance', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mille-navigation-store-'));
  const filePath = join(dir, 'navigation.json');
  const first = createNavigationStateStore({ filePath, now: () => 10 });
  assert.equal(first.get('/workspace/a'), null);
  assert.equal(first.set('/workspace/a', state('a')), true);

  const second = createNavigationStateStore({ filePath });
  assert.equal(second.get('/workspace/a'), state('a'));
  assert.deepEqual(JSON.parse(readFileSync(filePath, 'utf8')), {
    version: 1,
    workspaces: [{ root: '/workspace/a', updatedAt: 10, state: state('a') }],
  });
});

test('store rejects invalid/oversized records and recovers from corrupt disk data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mille-navigation-store-'));
  const filePath = join(dir, 'navigation.json');
  const store = createNavigationStateStore({ filePath, maxStateBytes: 200 });
  assert.equal(store.set('/workspace', '{bad'), false);
  assert.equal(store.set('/workspace', JSON.stringify({ version: 99 })), false);
  assert.equal(store.set('/workspace', state('x').repeat(20)), false);

  const corruptPath = join(dir, 'corrupt.json');
  writeFileSync(corruptPath, '{broken', 'utf8');
  const corrupt = createNavigationStateStore({ filePath: corruptPath });
  assert.equal(corrupt.get('/workspace'), null);
  assert.deepEqual(corrupt.entries(), []);
});

test('store keeps only the most recently updated bounded workspaces', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mille-navigation-store-'));
  let clock = 0;
  const store = createNavigationStateStore({
    filePath: join(dir, 'navigation.json'),
    maxWorkspaces: 3,
    now: () => ++clock,
  });
  for (const name of ['a', 'b', 'c', 'd']) {
    assert.equal(store.set(`/workspace/${name}`, state(name)), true);
  }
  assert.deepEqual(
    store.entries().map((entry) => entry.root),
    ['/workspace/d', '/workspace/c', '/workspace/b'],
  );
  assert.equal(store.get('/workspace/a'), null);
});
