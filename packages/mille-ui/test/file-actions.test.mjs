import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { fileActionTargetForId } from '../dist/index.js';

const entry = (id, parentId, name) => ({
  id,
  parentId,
  name,
  kind: id === 3 ? 0 : 1,
  size: 0,
  mtimeMs: 0,
  ctimeMs: 0,
  isIgnored: false,
  isReadonly: false,
  isHidden: false,
});

const snapshot = (entries) => ({
  getById: (id) => entries.get(id) ?? null,
});

test('file action target preserves root identity and both path forms', () => {
  const root = entry(1, null, 'workspace');
  const folder = entry(2, 1, 'src');
  const file = entry(3, 2, 'index.ts');
  const target = fileActionTargetForId(
    snapshot(new Map([[1, root], [2, folder], [3, file]])),
    3,
  );
  assert.deepEqual(target, {
    entry: file,
    rootId: 1,
    rootName: 'workspace',
    rootQualifiedPath: 'workspace/src/index.ts',
    rootRelativePath: 'src/index.ts',
  });
});

test('root targets use an empty root-relative path', () => {
  const root = entry(9, null, 'workspace');
  const target = fileActionTargetForId(snapshot(new Map([[9, root]])), 9);
  assert.equal(target.rootQualifiedPath, 'workspace');
  assert.equal(target.rootRelativePath, '');
});

test('file action target rejects missing parents, cycles, and unsafe segments', () => {
  assert.equal(
    fileActionTargetForId(snapshot(new Map([[2, entry(2, 99, 'orphan')]])), 2),
    null,
  );
  assert.equal(
    fileActionTargetForId(snapshot(new Map([[1, entry(1, 1, 'loop')]])), 1),
    null,
  );
  assert.equal(
    fileActionTargetForId(snapshot(new Map([[1, entry(1, null, '../bad')]])), 1),
    null,
  );
  assert.equal(
    fileActionTargetForId(snapshot(new Map([[1, entry(1, null, 'bad\\name')]])), 1),
    null,
  );
});
