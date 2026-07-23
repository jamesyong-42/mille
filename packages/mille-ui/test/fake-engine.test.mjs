// Sanity tests for the scriptable fake engine.
//
// Exercise the basics that every later phase relies on:
//   - Identity-stable snapshots between emissions.
//   - `emitDelta` advances the snapshot reference.
//   - Listeners fire exactly once per delta.
//   - Mutation methods record their calls and synthesize a delta.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  createFakeEngine,
  createFakeSnapshot,
} from '../dist/testing.js';

test('getSnapshot is identity-stable until emitDelta', () => {
  const fx = createFakeEngine();
  const a = fx.getSnapshot();
  const b = fx.getSnapshot();
  assert.equal(a, b, 'repeated getSnapshot() must return the same reference');

  fx.emitDelta(createFakeSnapshot({ treeVersion: 1 }));
  const c = fx.getSnapshot();
  assert.notEqual(a, c, 'emitDelta must advance the snapshot reference');
  assert.equal(c.treeVersion, 1);
});

test('on("change") fires once per emitDelta; dispose stops further fires', () => {
  const fx = createFakeEngine();
  let fired = 0;
  const sub = fx.on('change', () => {
    fired += 1;
  });
  fx.emitDelta(createFakeSnapshot({ treeVersion: 1 }));
  fx.emitDelta(createFakeSnapshot({ treeVersion: 2 }));
  assert.equal(fired, 2);
  sub.dispose();
  fx.emitDelta(createFakeSnapshot({ treeVersion: 3 }));
  assert.equal(fired, 2, 'disposed listener must not fire');
});

test('setMirror swaps the row list and bumps treeVersion', () => {
  const fx = createFakeEngine();
  const before = fx.getSnapshot();
  fx.setMirror([
    {
      id: 1,
      parentId: null,
      name: 'root',
      kind: 1,
      size: 0,
      mtimeMs: 0,
      ctimeMs: 0,
      isIgnored: false,
      isReadonly: false,
      isHidden: false,
      depth: 0,
      hasChildren: false,
      isExpanded: false,
    },
  ]);
  const after = fx.getSnapshot();
  assert.notEqual(before, after);
  assert.equal(after.treeVersion, before.treeVersion + 1);
  const rows = after.visibleRows({ expanded: new Set(), offset: 0, limit: 10 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'root');
});

test('mutations record call args and synthesize a delta', async () => {
  const fx = createFakeEngine();
  const before = fx.getSnapshot();

  await fx.create(0, 'a.ts', 0);
  await fx.rename(10_001, 'b.ts');
  await fx.delete(10_001, { trash: true });
  await fx.move(10_001, 42);
  await fx.copy(10_001, 42, 'c.ts');

  assert.deepEqual(fx.calls.create, [{ parentId: 0, name: 'a.ts', kind: 0 }]);
  assert.equal(fx.calls.rename.length, 1);
  assert.equal(fx.calls.delete.length, 1);
  assert.equal(fx.calls.move.length, 1);
  assert.equal(fx.calls.copy.length, 1);

  const after = fx.getSnapshot();
  assert.ok(after.treeVersion >= before.treeVersion + 5);
});

test('setExpanded + setViewport record their calls without notifying', () => {
  const fx = createFakeEngine();
  let fired = 0;
  fx.on('change', () => {
    fired += 1;
  });
  fx.setExpanded({ add: [1, 2], remove: [3] });
  fx.setViewport({ offset: 0, limit: 100, overscan: 20 });
  assert.equal(fired, 0, 'setExpanded/setViewport are session state — no change fires');
  assert.equal(fx.calls.setExpanded.length, 1);
  assert.deepEqual(fx.calls.setExpanded[0].add, [1, 2]);
  assert.deepEqual(fx.calls.setExpanded[0].remove, [3]);
  assert.equal(fx.calls.setViewport.length, 1);
  assert.equal(fx.calls.setViewport[0].limit, 100);
});

test('resync controls record scope without synthesizing disk changes', async () => {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ treeVersion: 7 }));
  assert.equal(await fx.resync(42, { recursive: true }), 7);
  assert.equal(await fx.resyncWorkspace(), 7);
  assert.deepEqual(fx.calls.resync, [{ id: 42, recursive: true }]);
  assert.deepEqual(fx.calls.resyncWorkspace, [{}]);
  assert.equal(fx.getSnapshot().treeVersion, 7);
});

test('reset clears listeners and call records', () => {
  const fx = createFakeEngine();
  let fired = 0;
  fx.on('change', () => {
    fired += 1;
  });
  fx.emitDelta(createFakeSnapshot({ treeVersion: 1 }));
  assert.equal(fired, 1);
  fx.reset();
  fx.emitDelta(createFakeSnapshot({ treeVersion: 5 }));
  assert.equal(fired, 1, 'reset must drop listeners');
  assert.equal(fx.calls.create.length, 0);
});
