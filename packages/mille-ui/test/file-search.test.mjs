import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { fileSearchRequestForIds } from '../dist/index.js';

function entry(id, parentId, name, kind = 1) {
  return {
    id,
    parentId,
    name,
    kind,
    size: 0,
    mtimeMs: 0,
    ctimeMs: 0,
    isIgnored: false,
    isReadonly: false,
    isHidden: false,
  };
}

function snapshot(entries) {
  return { getById: (id) => entries.get(id) ?? null };
}

test('file search requests preserve root identity, order, and de-duplicate targets', () => {
  const entries = new Map([
    [1, entry(1, null, 'workspace')],
    [2, entry(2, 1, 'src')],
    [3, entry(3, null, 'workspace')],
    [4, entry(4, 3, 'src')],
  ]);
  const request = fileSearchRequestForIds(snapshot(entries), 'include', [4, 2, 4]);
  assert.ok(request);
  assert.equal(request.kind, 'include');
  assert.deepEqual(
    request.targets.map((target) => [
      target.rootId,
      target.rootQualifiedPath,
      target.rootRelativePath,
    ]),
    [
      [3, 'workspace/src', 'src'],
      [1, 'workspace/src', 'src'],
    ],
  );
  assert.ok(Object.isFrozen(request));
  assert.ok(Object.isFrozen(request.targets));
});

test('file search request rejects missing, hostile, empty, and oversized scopes atomically', () => {
  const entries = new Map([
    [1, entry(1, null, 'workspace')],
    [2, entry(2, 1, 'src')],
    [3, entry(3, 99, 'orphan')],
  ]);
  const view = snapshot(entries);
  assert.equal(fileSearchRequestForIds(view, 'findInFolder', []), null);
  assert.equal(fileSearchRequestForIds(view, 'exclude', [2, 3]), null);
  assert.equal(fileSearchRequestForIds(view, 'include', Array.from({ length: 1_025 }, () => 2)), null);
});
