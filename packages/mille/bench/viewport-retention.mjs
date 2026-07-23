#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { performance } from 'node:perf_hooks';
import { MessageChannel } from 'node:worker_threads';

import { createMirror } from '../dist/mirror.js';
import { applyDelta, applySnapshot } from '../dist/mirror-reducer.js';
import { encodeChildLists } from '../dist/child-list-codec.js';
import { decodeClientEntries, encodeClientEntries } from '../dist/entry-codec.js';

function numberOption(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} requires a positive integer`);
  }
  return value;
}

function entry(id, parentId, name, kind = 0) {
  return {
    id,
    parentId,
    name,
    kind,
    size: 0,
    mtimeMs: 0,
    ctimeMs: 0,
    symlinkTargetIsDir: null,
    pathSegments: null,
    isIgnored: false,
    isReadonly: false,
    isHidden: false,
  };
}

function percentile(sorted, fraction) {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

const entryCount = numberOption('--entries', 50_000);
const mirrorCap = numberOption('--cap', 4_096);
const viewportSize = numberOption('--viewport', 64);
const moves = numberOption('--moves', 200);
const wireMessages = numberOption('--wire-messages', 2_000);
assert.ok(entryCount > viewportSize, 'entries must exceed viewport size');
assert.ok(mirrorCap > viewportSize, 'cap must exceed viewport size');

const entries = [entry(0, null, 'root', 1)];
for (let id = 1; id <= entryCount; id++) {
  entries.push(entry(id, 0, `file-${String(id).padStart(6, '0')}.txt`));
}

const hydrateStarted = performance.now();
const rootPayload = encodeClientEntries([entries[0]]);
let state = applySnapshot(
  createMirror(),
  {
    version: 1,
    roots: [0],
    mirror: rootPayload,
    directChildCounts: { 0: entryCount },
    visibleCount: 1,
  },
  mirrorCap,
);
const hydrateMs = performance.now() - hydrateStarted;
state.expanded.add(0);

const initialViewportIds = Array.from({ length: viewportSize }, (_, index) => index + 1);
const initialViewportPayload = encodeClientEntries(initialViewportIds.map((id) => entries[id]));
const structureStarted = performance.now();
const childListsBin = encodeChildLists(
  new Map([[0, Array.from({ length: entryCount }, (_, index) => index + 1)]]),
);
state = applyDelta(
  state,
  {
    version: 2,
    changedIds: [],
    viewportPatch: initialViewportPayload,
    viewportIds: initialViewportIds,
    childSetChanged: [0],
    childListsBin,
    removedIds: [],
    directChildCounts: { 0: entryCount },
    coarseSubtrees: [],
    subtreeDirty: [],
    subtreeResynced: [],
  },
  mirrorCap,
);
const structureMs = performance.now() - structureStarted;
assert.equal(state.children.get(0)?.length, entryCount, 'complete structural ids retained');
assert.ok(state.children.get(0) instanceof Uint32Array, 'structural ids use packed u32 storage');
assert.ok(state.orderedChildren.has(0), 'child order is authoritative');

const encodeLatencies = [];
const applyLatencies = [];
let binaryBytes = 0;
let jsonBytes = 0;
let firstViewport = [];
let peakEntries = state.byId.size;
for (let move = 0; move < moves; move++) {
  const startId = 1 + ((move * 257) % (entryCount - viewportSize));
  const viewportIds = Array.from({ length: viewportSize }, (_, index) => startId + index);
  if (move === 0) firstViewport = viewportIds;
  const viewportEntries = viewportIds.map((id) => entries[id]);
  const encodeStarted = performance.now();
  const payload = encodeClientEntries(viewportEntries);
  encodeLatencies.push(performance.now() - encodeStarted);
  binaryBytes += payload.byteLength;
  jsonBytes += Buffer.byteLength(JSON.stringify(viewportEntries));
  const applyStarted = performance.now();
  state = applyDelta(
    state,
    {
      version: move + 3,
      changedIds: [],
      viewportPatch: payload,
      viewportIds,
      removedIds: [],
      directChildCounts: {},
      coarseSubtrees: [],
      subtreeDirty: [],
      subtreeResynced: [],
    },
    mirrorCap,
  );
  applyLatencies.push(performance.now() - applyStarted);
  peakEntries = Math.max(peakEntries, state.byId.size);
  assert.ok(state.byId.size <= mirrorCap, `mirror exceeded cap: ${state.byId.size}`);
  assert.ok(
    viewportIds.every((id) => state.byId.has(id)),
    `move ${move} lost viewport rows`,
  );
}

assert.ok(
  firstViewport.every((id) => !state.byId.has(id)),
  'cold first viewport should be evicted after sustained movement',
);

encodeLatencies.sort((a, b) => a - b);
applyLatencies.sort((a, b) => a - b);
const encodeP50 = percentile(encodeLatencies, 0.5);
const encodeP95 = percentile(encodeLatencies, 0.95);
const applyP50 = percentile(applyLatencies, 0.5);
const applyP95 = percentile(applyLatencies, 0.95);
const applyMax = applyLatencies.at(-1);
const averageBinaryBytes = binaryBytes / moves;
const averageJsonBytes = jsonBytes / moves;
const payloadReduction = 1 - averageBinaryBytes / averageJsonBytes;
assert.ok(payloadReduction >= 0.6, `binary payload reduction was only ${payloadReduction}`);

console.log(
  '| fixture | root handshake | structure seed | moves | binary / JSON | reduction | encode p50 / p95 | decode+apply p50 / p95 / max | peak mirror |',
);
console.log('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
console.log(
  `| ${entryCount.toLocaleString()} entries / ${viewportSize}-row viewport | ${hydrateMs.toFixed(2)} ms | ${structureMs.toFixed(2)} ms | ${moves} | ${averageBinaryBytes.toFixed(0)} B / ${averageJsonBytes.toFixed(0)} B | ${(payloadReduction * 100).toFixed(1)}% | ${encodeP50.toFixed(3)} / ${encodeP95.toFixed(3)} ms | ${applyP50.toFixed(2)} / ${applyP95.toFixed(2)} / ${applyMax.toFixed(2)} ms | ${peakEntries.toLocaleString()} / ${mirrorCap.toLocaleString()} |`,
);

async function wireTrial(kind, payload, count) {
  const { port1, port2 } = new MessageChannel();
  let received = 0;
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  port2.on('message', (message) => {
    const decoded = kind === 'binary' ? decodeClientEntries(message) : JSON.parse(message);
    assert.equal(decoded.length, viewportSize);
    received++;
    if (received === count) resolveDone();
  });
  const started = performance.now();
  for (let index = 0; index < count; index++) port1.postMessage(payload);
  await done;
  const elapsed = performance.now() - started;
  port1.close();
  port2.close();
  return elapsed;
}

const wireEntries = initialViewportIds.map((id) => entries[id]);
const wireJson = JSON.stringify(wireEntries);
const wireBinary = encodeClientEntries(wireEntries);
await wireTrial('json', wireJson, 200);
await wireTrial('binary', wireBinary, 200);
const jsonWireTrials = [];
const binaryWireTrials = [];
for (let trial = 0; trial < 5; trial++) {
  jsonWireTrials.push(await wireTrial('json', wireJson, wireMessages));
  binaryWireTrials.push(await wireTrial('binary', wireBinary, wireMessages));
}
jsonWireTrials.sort((a, b) => a - b);
binaryWireTrials.sort((a, b) => a - b);
const jsonWireMedian = percentile(jsonWireTrials, 0.5);
const binaryWireMedian = percentile(binaryWireTrials, 0.5);

console.log();
console.log('| MessageChannel clone + decode | JSON | binary | change |');
console.log('| --- | ---: | ---: | ---: |');
console.log(
  `| ${wireMessages.toLocaleString()} × ${viewportSize}-row patches, median of 5 | ${jsonWireMedian.toFixed(2)} ms | ${binaryWireMedian.toFixed(2)} ms | ${((binaryWireMedian / jsonWireMedian - 1) * 100).toFixed(1)}% |`,
);
