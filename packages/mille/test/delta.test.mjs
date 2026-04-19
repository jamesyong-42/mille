// Unit tests for computeSessionDelta / applyDeltaToSession — Phase 7.5.
//
// The delta diff is pure: given a global ChangeSet and a per-session
// view (expanded + knownIds), it produces the session-scoped frame.
// Wave 4 layers viewport-aware addedIds/removedIds on top; these tests
// lock in the indexed-intersection behaviour.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  computeSessionDelta,
  applyDeltaToSession,
} from '../dist/delta.js';

function emptyChangeSet(overrides = {}) {
  return {
    changedIds: [],
    subtreeRootsChanged: [],
    childSetChanged: [],
    reparentedIds: [],
    fromVersion: 0,
    toVersion: 0,
    ...overrides,
  };
}

function view(expanded = [], known = []) {
  return {
    expanded: new Set(expanded),
    knownIds: new Set(known),
  };
}

test('empty ChangeSet produces an empty delta', () => {
  const delta = computeSessionDelta(emptyChangeSet(), view());
  assert.deepEqual(delta.changedIds, []);
  assert.deepEqual(delta.childSetChanged, []);
  assert.deepEqual(delta.reparentedIds, []);
  assert.deepEqual(delta.addedIds, []);
  assert.deepEqual(delta.removedIds, []);
  assert.equal(delta.version, 0);
});

test('changedIds is filtered by session.knownIds', () => {
  const cs = emptyChangeSet({
    changedIds: [1, 2, 3, 4],
    fromVersion: 4,
    toVersion: 5,
  });
  const delta = computeSessionDelta(cs, view([], [2, 4, 99]));
  // Only 2 and 4 are known; 1/3 are dropped, 99 wasn't changed.
  assert.deepEqual(delta.changedIds.sort(), [2, 4]);
});

test('changedIds for a session that knows nothing is empty', () => {
  const cs = emptyChangeSet({ changedIds: [1, 2, 3] });
  const delta = computeSessionDelta(cs, view());
  assert.deepEqual(delta.changedIds, []);
});

test('childSetChanged passes parents present in expanded set', () => {
  const cs = emptyChangeSet({ childSetChanged: [10, 20, 30] });
  const delta = computeSessionDelta(cs, view([10, 30], []));
  assert.deepEqual(delta.childSetChanged.sort((a, b) => a - b), [10, 30]);
});

test('childSetChanged also passes parents that are merely known', () => {
  // If the session has a row for a folder but has not expanded it, a
  // child-set mutation still matters — hasChildren might flip.
  const cs = emptyChangeSet({ childSetChanged: [10, 20] });
  const delta = computeSessionDelta(cs, view([], [10]));
  assert.deepEqual(delta.childSetChanged, [10]);
});

test('childSetChanged drops parents neither expanded nor known', () => {
  const cs = emptyChangeSet({ childSetChanged: [10, 20] });
  const delta = computeSessionDelta(cs, view([30], [40]));
  assert.deepEqual(delta.childSetChanged, []);
});

test('reparentedIds filtered by knownIds; old/new parents preserved', () => {
  const cs = emptyChangeSet({
    reparentedIds: [
      { id: 1, oldParentId: 100, newParentId: 200 },
      { id: 2, oldParentId: null, newParentId: 300 },
      { id: 3, oldParentId: 400, newParentId: null },
    ],
  });
  const delta = computeSessionDelta(cs, view([], [1, 3]));
  assert.equal(delta.reparentedIds.length, 2);
  const byId = Object.fromEntries(delta.reparentedIds.map((r) => [r.id, r]));
  assert.equal(byId[1].oldParentId, 100);
  assert.equal(byId[1].newParentId, 200);
  assert.equal(byId[3].oldParentId, 400);
  assert.equal(byId[3].newParentId, null);
});

test('version stamp from toVersion propagates', () => {
  const cs = emptyChangeSet({ fromVersion: 42, toVersion: 99 });
  const delta = computeSessionDelta(cs, view());
  assert.equal(delta.version, 99);
});

test('applyDeltaToSession updates knownIds in place', () => {
  const session = view([], [1, 2, 3]);
  applyDeltaToSession(
    {
      version: 5,
      changedIds: [],
      childSetChanged: [],
      addedIds: [4, 5],
      removedIds: [2],
      reparentedIds: [],
    },
    session,
  );
  assert.deepEqual([...session.knownIds].sort((a, b) => a - b), [1, 3, 4, 5]);
});

test('applyDeltaToSession is a no-op on an empty delta', () => {
  const session = view([], [1, 2]);
  applyDeltaToSession(
    {
      version: 0,
      changedIds: [],
      childSetChanged: [],
      addedIds: [],
      removedIds: [],
      reparentedIds: [],
    },
    session,
  );
  assert.deepEqual([...session.knownIds].sort((a, b) => a - b), [1, 2]);
});
