// Bincode decoder tests.
//
// Two layers:
//   1. Primitive-reader tests using hand-crafted buffers that exercise
//      each bincode standard-config codec path (varint branches, zigzag,
//      Option tags, Vec, String).
//   2. An end-to-end round-trip against the live .node: call
//      `MirrorSnapshot.visibleRowsBin` on an empty root and verify the
//      decoder agrees it's empty. Phase 5 hasn't wired up the walker, so
//      an empty result is the only shape we can cover at this stage;
//      Phase 6.4+ will extend this once rows actually exist.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';

import { BincodeReader, decodeBulkRows } from '../dist/decode.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// ────────────────────────────────── primitives ─────────────────────────────

test('varint: single-byte path (value < 251)', () => {
  for (const v of [0, 1, 42, 250]) {
    const r = new BincodeReader(new Uint8Array([v]));
    assert.equal(r.readVarintU64(), BigInt(v));
    assert.equal(r.remaining, 0);
  }
});

test('varint: u16 path (marker 251 + 2 LE bytes)', () => {
  // 300 = 0x012c LE → [0x2c, 0x01]
  const r = new BincodeReader(new Uint8Array([251, 0x2c, 0x01]));
  assert.equal(r.readVarintU64(), 300n);
});

test('varint: u32 path (marker 252 + 4 LE bytes)', () => {
  // 0x11223344 LE
  const r = new BincodeReader(new Uint8Array([252, 0x44, 0x33, 0x22, 0x11]));
  assert.equal(r.readVarintU64(), 0x11223344n);
});

test('varint: u64 path (marker 253 + 8 LE bytes)', () => {
  // 2^40 = 0x010000000000 LE → 6 bytes of zero then 0x01 then zero
  const buf = new Uint8Array([253, 0, 0, 0, 0, 0, 1, 0, 0]);
  const r = new BincodeReader(buf);
  assert.equal(r.readVarintU64(), 1n << 40n);
});

test('varint: u128 marker rejected', () => {
  const r = new BincodeReader(new Uint8Array([254, 0, 0]));
  assert.throws(() => r.readVarintU64(), /u128 varint unsupported/);
});

test('zigzag i64: positive encodes as 2n, negative as -2n-1', () => {
  // 0 → 0, 1 → 2, -1 → 1, 2 → 4, -2 → 3
  for (const [enc, dec] of [
    [0, 0n],
    [2, 1n],
    [1, -1n],
    [4, 2n],
    [3, -2n],
  ]) {
    const r = new BincodeReader(new Uint8Array([enc]));
    assert.equal(r.readVarintI64(), dec);
  }
});

test('readVarintU64AsNumber asserts safe-int ceiling', () => {
  // Compose a varint that encodes 2^53 + 1 (just over the safe int).
  // Marker 253, then 8-byte LE u64.
  const big = (1n << 53n) + 1n;
  const buf = new Uint8Array(9);
  buf[0] = 253;
  const view = new DataView(buf.buffer);
  view.setBigUint64(1, big, true);
  const r = new BincodeReader(buf);
  assert.throws(() => r.readVarintU64AsNumber(), /exceeds Number\.MAX_SAFE_INTEGER/);
});

test('readBool accepts 0/1 and rejects others', () => {
  assert.equal(new BincodeReader(new Uint8Array([0])).readBool(), false);
  assert.equal(new BincodeReader(new Uint8Array([1])).readBool(), true);
  assert.throws(() => new BincodeReader(new Uint8Array([2])).readBool(), /invalid bool/);
});

test('readString: varint length + UTF-8 bytes', () => {
  // "hi" = 0x68 0x69, length 2 < 251 so single-byte varint
  const r = new BincodeReader(new Uint8Array([2, 0x68, 0x69]));
  assert.equal(r.readString(), 'hi');
});

test('readString: multibyte UTF-8 passes through', () => {
  // "café" = 63 61 66 C3 A9 (5 bytes)
  const r = new BincodeReader(new Uint8Array([5, 0x63, 0x61, 0x66, 0xc3, 0xa9]));
  assert.equal(r.readString(), 'café');
});

test('readOption: None (tag 0) and Some<bool> (tag 1 + inner)', () => {
  assert.equal(new BincodeReader(new Uint8Array([0])).readOption((r) => r.readBool()), null);
  assert.equal(new BincodeReader(new Uint8Array([1, 1])).readOption((r) => r.readBool()), true);
  assert.throws(
    () => new BincodeReader(new Uint8Array([2])).readOption((r) => r.readBool()),
    /invalid Option tag/,
  );
});

test('readVec<string>: length-prefixed element stream', () => {
  // vec!["a", "b"] = [2, 1, 'a', 1, 'b']
  const r = new BincodeReader(new Uint8Array([2, 1, 0x61, 1, 0x62]));
  assert.deepEqual(r.readVec((rr) => rr.readString()), ['a', 'b']);
});

test('truncated buffer throws on next read', () => {
  const r = new BincodeReader(new Uint8Array([]));
  assert.throws(() => r.readU8(), /truncated/);
});

// ────────────────────────────── decodeBulkRows ─────────────────────────────

test('decodeBulkRows: empty vec decodes to []', () => {
  // bincode encoding of Vec<T>::new(): just the length varint 0.
  assert.deepEqual(decodeBulkRows(new Uint8Array([0])), []);
});

test('decodeBulkRows: decodes a hand-crafted single row', () => {
  // Hand-roll a buffer matching EnrichedRow for:
  //   id = 1, parentId = None, name = "root", kind = 1 (Directory),
  //   size = 0, mtimeMs = 0, ctimeMs = 0,
  //   symlinkTargetIsDir = None, pathSegments = None,
  //   isIgnored = 0, isReadonly = 0, isHidden = 0,
  //   depth = 0, hasChildren = 0, isExpanded = 0
  const buf = new Uint8Array([
    1, // vec length = 1
    // id (varint u64): 1
    1,
    // parent_raw_id (Option): None → 0
    0,
    // name (String): len=4, "root"
    4, 0x72, 0x6f, 0x6f, 0x74,
    // kind (u8): 1
    1,
    // size (varint u64): 0
    0,
    // mtime_ms (varint i64 zigzag): 0
    0,
    // ctime_ms (varint i64 zigzag): 0
    0,
    // symlink_target_is_dir (Option<bool>): None
    0,
    // path_segments (Option<Vec<String>>): None
    0,
    // is_ignored, is_readonly, is_hidden (bool)
    0, 0, 0,
    // depth (u16 as varint): 0
    0,
    // has_children, is_expanded (bool)
    0, 0,
  ]);
  const rows = decodeBulkRows(buf);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    id: 1,
    parentId: null,
    name: 'root',
    kind: 1,
    size: 0,
    mtimeMs: 0,
    ctimeMs: 0,
    symlinkTargetIsDir: null,
    pathSegments: null,
    isIgnored: false,
    isReadonly: false,
    isHidden: false,
    depth: 0,
    hasChildren: false,
    isExpanded: false,
  });
});

test('decodeBulkRows: trailing bytes throw (schema drift guard)', () => {
  // length 0 + a stray byte
  assert.throws(() => decodeBulkRows(new Uint8Array([0, 0xff])), /trailing bytes/);
});

// ────────────────────────────── live .node round-trip ──────────────────────

// Derived from the host the way `src/native.ts` resolves a dev build. The
// previous hand-written list covered only darwin and linux-gnu, so on Windows
// and musl `native` stayed null and every test below silently skipped — the
// live round-trip reported green while running nothing.
const base = `mille.${process.platform}-${process.arch}`;
const candidates = [
  `../${base}.node`,
  `../${base}-gnu.node`,
  `../${base}-musl.node`,
  `../${base}-msvc.node`,
];

let native = null;
for (const rel of candidates) {
  try {
    native = require(rel);
    break;
  } catch (err) {
    if (err && err.code !== 'MODULE_NOT_FOUND') throw err;
  }
}

test('visibleRowsBin on an empty snapshot round-trips to []', { skip: !native }, () => {
  const { FileExplorer } = native;
  const dir = mkdtempSync(join(tmpdir(), 'mille-decode-'));
  try {
    const fx = new FileExplorer({ roots: [dir] });
    const snap = fx.getSnapshot();
    const buf = snap.visibleRowsBin({ expanded: [], offset: 0, limit: 100 });
    assert.ok(buf instanceof Uint8Array, 'visibleRowsBin returns a Buffer/Uint8Array');
    const rows = decodeBulkRows(buf);
    assert.deepEqual(rows, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
