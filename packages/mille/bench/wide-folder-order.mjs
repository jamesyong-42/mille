#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { performance } from 'node:perf_hooks';

import { encodeChildLists } from '../dist/child-list-codec.js';
import { createMirror } from '../dist/mirror.js';
import { applyDelta } from '../dist/mirror-reducer.js';

function numberOption(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} requires a positive integer`);
  }
  return value;
}

function delta(structure) {
  return {
    version: 1,
    changedIds: [],
    childSetChanged: [0],
    removedIds: [],
    directChildCounts: { 0: structure.count },
    coarseSubtrees: [],
    subtreeDirty: [],
    subtreeResynced: [],
    ...structure.payload,
  };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

const count = numberOption('--entries', 1_000_000);
const rounds = numberOption('--rounds', 5);
assert.ok(count <= 0xffff_fffe, 'u32 fixture limit exceeded');
const ids = Array.from({ length: count }, (_, index) => index + 1);

const encodeTimes = [];
let packed;
for (let round = 0; round < rounds; round++) {
  const started = performance.now();
  packed = encodeChildLists(new Map([[0, ids]]));
  encodeTimes.push(performance.now() - started);
}

const packedApplyTimes = [];
let packedState;
for (let round = 0; round < rounds; round++) {
  const cloned = structuredClone(packed);
  const started = performance.now();
  packedState = applyDelta(
    createMirror(),
    delta({ count, payload: { childListsBin: cloned } }),
    4_096,
  );
  packedApplyTimes.push(performance.now() - started);
}

const legacyApplyTimes = [];
for (let round = 0; round < rounds; round++) {
  const clonedIds = structuredClone(ids);
  const started = performance.now();
  const legacyState = applyDelta(
    createMirror(),
    delta({ count, payload: { childLists: { 0: clonedIds } } }),
    4_096,
  );
  legacyApplyTimes.push(performance.now() - started);
  assert.equal(legacyState.children.get(0).length, count);
}

const retained = packedState.children.get(0);
assert.ok(retained instanceof Uint32Array, 'million-sibling order must retain a u32 view');
assert.equal(retained.length, count);
assert.equal(retained[0], 1);
assert.equal(retained.at(-1), count);
assert.equal(retained.buffer.byteLength, packed.byteLength, 'reducer must retain zero-copy view');
assert.ok(
  packed.byteLength <= count * Uint32Array.BYTES_PER_ELEMENT + 32,
  `packed structure exceeded four bytes per id: ${packed.byteLength}`,
);
assert.equal(packedState.byId.size, 0, 'structural identities must not hydrate entry records');

const packedBytesPerId = packed.byteLength / count;
const applyChange = 1 - median(packedApplyTimes) / median(legacyApplyTimes);

console.log(
  '| fixture | packed bytes | bytes / id | encode median | packed apply median | legacy array apply median | apply change | hydrated records |',
);
console.log('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
console.log(
  `| ${count.toLocaleString()} siblings | ${packed.byteLength.toLocaleString()} | ${packedBytesPerId.toFixed(3)} | ${median(encodeTimes).toFixed(2)} ms | ${median(packedApplyTimes).toFixed(2)} ms | ${median(legacyApplyTimes).toFixed(2)} ms | ${(applyChange * 100).toFixed(1)}% | ${packedState.byId.size} |`,
);
