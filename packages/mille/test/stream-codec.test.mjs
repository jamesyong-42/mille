// Framed stream codec + decoder tests — remote-workspace PR 2 (SPEC §24.2).
//
// The codec is the one place where a hostile peer's bytes are parsed before
// anything about them is trusted, so the negative cases matter at least as
// much as the round-trips.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import {
  DEFAULT_LIMITS,
  FrameDecoder,
  FrameProtocolError,
  HEADER_BYTES,
  decodeFrame,
  encodeFrame,
  parseHeader,
  resolveLimits,
} from '../dist/node.js';

const L = DEFAULT_LIMITS;

/** Encode then decode through the incremental decoder in one chunk. */
function roundTrip(message, limits = L) {
  const bytes = encodeFrame(message, limits);
  const decoder = new FrameDecoder(limits);
  const out = decoder.push(bytes);
  assert.equal(out.length, 1, 'exactly one message decoded');
  return out[0];
}

// ─── Round-trips ────────────────────────────────────────────────────────

test('round-trips each semantic message shape', () => {
  const messages = [
    { v: 1, type: 'handshake', body: { version: 1, clientId: 'c-abc', options: {} } },
    { v: 1, type: 'setExpanded', body: { add: [1, 2, 3], remove: [] } },
    { v: 1, type: 'setViewport', body: { offset: 0, limit: 40, overscan: 8 } },
    { v: 1, type: 'ack', body: { version: 42 } },
    { v: 1, type: 'error', body: { code: 'EINVAL', message: 'nope' } },
    { v: 1, type: 'callResult', body: { reqId: 7, result: null } },
    { v: 1, type: 'delta', body: { changedIds: [], removedIds: [], coarseSubtrees: [] } },
  ];
  for (const msg of messages) {
    assert.deepEqual(roundTrip(msg), msg, `${msg.type} survived`);
  }
});

test('round-trips nested binary of every view type', () => {
  const backing = new ArrayBuffer(64);
  new Uint8Array(backing).forEach((_, i, a) => {
    a[i] = i;
  });

  const message = {
    v: 1,
    type: 'snapshot',
    body: {
      version: 3,
      mirror: new Uint8Array([1, 2, 3, 4]),
      childListsBin: Buffer.from('MCL1payload'),
      viewportPatch: new DataView(backing, 8, 16),
      nested: { deep: [new Uint8Array([9, 9]), { deeper: new Uint8Array(0) }] },
      wholeBuffer: new ArrayBuffer(3),
    },
  };
  const out = roundTrip(message);

  assert.deepEqual([...out.body.mirror], [1, 2, 3, 4]);
  assert.equal(Buffer.from(out.body.childListsBin).toString(), 'MCL1payload');
  assert.equal(out.body.viewportPatch.byteLength, 16, 'DataView kept its length');
  assert.deepEqual([...out.body.viewportPatch], [...new Uint8Array(backing, 8, 16)]);
  assert.deepEqual([...out.body.nested.deep[0]], [9, 9]);
  assert.equal(out.body.nested.deep[1].deeper.byteLength, 0, 'empty attachment survives');
  assert.equal(out.body.wholeBuffer.byteLength, 3);
  assert.equal(out.body.version, 3, 'non-binary fields untouched');
});

test('SPEC §11.5: a typed-array view ships only its own byte range', () => {
  // The regression this guards: serializing `.buffer` would ship all 1000
  // bytes and hand the peer the wrong 10.
  const backing = new Uint8Array(1000);
  backing.fill(7);
  const slice = backing.subarray(500, 510);

  const bytes = encodeFrame({ v: 1, type: 'event', body: { slice } }, L);
  assert.ok(
    bytes.byteLength < 200,
    `frame should carry 10 payload bytes, not 1000 (got ${bytes.byteLength})`,
  );

  const out = roundTrip({ v: 1, type: 'event', body: { slice } });
  assert.equal(out.body.slice.byteLength, 10);
  assert.equal(out.body.slice.byteOffset, 0, 'decoded views are freshly allocated');
  assert.deepEqual([...out.body.slice], new Array(10).fill(7));
});

// ─── Fragmentation ──────────────────────────────────────────────────────

test('decodes a frame fed one byte at a time', () => {
  const message = { v: 1, type: 'snapshot', body: { mirror: new Uint8Array(300).fill(3) } };
  const bytes = encodeFrame(message, L);
  const decoder = new FrameDecoder(L);

  const out = [];
  for (let i = 0; i < bytes.byteLength; i += 1) {
    out.push(...decoder.push(bytes.subarray(i, i + 1)));
  }
  assert.equal(out.length, 1);
  assert.equal(out[0].body.mirror.byteLength, 300);
  assert.equal(decoder.bufferedBytes, 0, 'nothing left buffered');
});

test('decodes many frames delivered in a single chunk', () => {
  const parts = [];
  for (let n = 0; n < 50; n += 1) {
    parts.push(encodeFrame({ v: 1, type: 'event', body: { n } }, L));
  }
  const joined = Buffer.concat(parts.map((p) => Buffer.from(p)));

  const decoder = new FrameDecoder(L);
  const out = decoder.push(joined);
  assert.equal(out.length, 50);
  out.forEach((m, i) => assert.equal(m.body.n, i, 'frame order preserved'));
});

test('property: any partition of the byte stream decodes identically', () => {
  const messages = [
    { v: 1, type: 'event', body: { n: 1, blob: new Uint8Array([1, 2, 3]) } },
    { v: 1, type: 'event', body: { n: 2 } },
    { v: 1, type: 'delta', body: { changedIds: [4, 5, 6], patch: new Uint8Array(64).fill(8) } },
  ];
  const stream = Buffer.concat(messages.map((m) => Buffer.from(encodeFrame(m, L))));

  fc.assert(
    fc.property(fc.array(fc.integer({ min: 0, max: stream.length }), { maxLength: 24 }), (cuts) => {
      const points = [...new Set([0, ...cuts, stream.length])].sort((a, b) => a - b);
      const decoder = new FrameDecoder(L);
      const out = [];
      for (let i = 0; i < points.length - 1; i += 1) {
        out.push(...decoder.push(stream.subarray(points[i], points[i + 1])));
      }
      assert.equal(out.length, messages.length);
      assert.equal(out[0].body.n, 1);
      assert.deepEqual([...out[0].body.blob], [1, 2, 3]);
      assert.equal(out[2].body.patch.byteLength, 64);
      assert.equal(decoder.bufferedBytes, 0);
    }),
    { numRuns: 200 },
  );
});

// ─── Malformed input ────────────────────────────────────────────────────

/** Build a header with arbitrary declared lengths, for negative tests. */
function header({
  magic = 'MLLE',
  major = 1,
  minor = 0,
  flags = 0,
  meta = 0,
  count = 0,
  bytes = 0,
}) {
  const buf = Buffer.alloc(HEADER_BYTES);
  buf.write(magic, 0, 'ascii');
  buf[4] = major;
  buf[5] = minor;
  buf.writeUInt16BE(flags, 6);
  buf.writeUInt32BE(meta, 8);
  buf.writeUInt32BE(count, 12);
  buf.writeUInt32BE(bytes, 16);
  return buf;
}

test('rejects a bad magic', () => {
  assert.throws(() => parseHeader(header({ magic: 'XXXX' }), L), /bad magic/);
});

test('rejects an unsupported wire major', () => {
  assert.throws(() => parseHeader(header({ major: 2 }), L), /unsupported wire major/);
});

test('accepts a higher wire minor', () => {
  const h = parseHeader(header({ minor: 9 }), L);
  assert.equal(h.totalLength, HEADER_BYTES);
});

test('rejects any active flag bit', () => {
  assert.throws(() => parseHeader(header({ flags: 0x0001 }), L), /unknown active wire flags/);
});

test('rejects declared lengths above the limits before allocating', () => {
  assert.throws(() => parseHeader(header({ meta: 0xffffffff }), L), /metadata length/);
  assert.throws(() => parseHeader(header({ count: 0xffff }), L), /attachment count/);
  assert.throws(() => parseHeader(header({ bytes: 0xffffffff }), L), /frame length/);
});

test('a huge declared length does not allocate — the decoder stays bounded', () => {
  const decoder = new FrameDecoder(L);
  // 4 GiB of attachments claimed, 20 bytes actually delivered.
  assert.throws(() => decoder.push(header({ bytes: 0xffffffff })), FrameProtocolError);
  assert.ok(decoder.bufferedBytes <= HEADER_BYTES, 'buffered no more than what arrived');
});

test('rejects invalid UTF-8 metadata', () => {
  const meta = Buffer.from([0xff, 0xfe, 0xfd]);
  const frame = Buffer.concat([header({ meta: meta.length }), meta]);
  const h = parseHeader(frame.subarray(0, HEADER_BYTES), L);
  assert.throws(() => decodeFrame(frame, h), /not valid UTF-8/);
});

test('rejects invalid JSON metadata', () => {
  const meta = Buffer.from('{not json', 'utf8');
  const frame = Buffer.concat([header({ meta: meta.length }), meta]);
  const h = parseHeader(frame.subarray(0, HEADER_BYTES), L);
  assert.throws(() => decodeFrame(frame, h), /not valid JSON/);
});

test('rejects an attachment table that disagrees with the header', () => {
  const meta = Buffer.from('{"a":1}', 'utf8');
  const table = Buffer.alloc(4);
  table.writeUInt32BE(99, 0); // claims 99 bytes
  const payload = Buffer.alloc(4); // header says 4
  const frame = Buffer.concat([
    header({ meta: meta.length, count: 1, bytes: payload.length }),
    meta,
    table,
    payload,
  ]);
  const h = parseHeader(frame.subarray(0, HEADER_BYTES), L);
  assert.throws(() => decodeFrame(frame, h), /attachment table sums to/);
});

test('rejects a placeholder index outside the attachment list', () => {
  const meta = Buffer.from(JSON.stringify({ x: { $mille: 'bin', i: 5 } }), 'utf8');
  const frame = Buffer.concat([header({ meta: meta.length }), meta]);
  const h = parseHeader(frame.subarray(0, HEADER_BYTES), L);
  assert.throws(() => decodeFrame(frame, h), /out of range/);
});

test('rejects a cyclic message', () => {
  const body = { self: null };
  body.self = body;
  assert.throws(() => encodeFrame({ v: 1, type: 'event', body }, L), /cyclic/);
});

test('rejects SharedArrayBuffer and exotic prototypes', () => {
  if (typeof SharedArrayBuffer !== 'undefined') {
    const sab = new Uint8Array(new SharedArrayBuffer(8));
    assert.throws(
      () => encodeFrame({ v: 1, type: 'event', body: { sab } }, L),
      /SharedArrayBuffer/,
    );
  }
  assert.throws(
    () => encodeFrame({ v: 1, type: 'event', body: { m: new Map() } }, L),
    /unsupported value with prototype/,
  );
  assert.throws(
    () => encodeFrame({ v: 1, type: 'event', body: { d: new Date() } }, L),
    /unsupported value with prototype/,
  );
});

test('rejects oversize payloads at encode time', () => {
  const tight = resolveLimits({ maxFrameBytes: 1024, maxMetadataBytes: 512 });
  assert.throws(
    () => encodeFrame({ v: 1, type: 'event', body: { big: new Uint8Array(4096) } }, tight),
    /exceeds limit/,
  );
  assert.throws(
    () => encodeFrame({ v: 1, type: 'event', body: { s: 'x'.repeat(2000) } }, tight),
    /metadata .* exceeds limit/,
  );
});

test('rejects more attachments than the limit allows', () => {
  const tight = resolveLimits({ maxAttachments: 2 });
  const body = { a: new Uint8Array(1), b: new Uint8Array(1), c: new Uint8Array(1) };
  assert.throws(() => encodeFrame({ v: 1, type: 'event', body }, tight), /too many binary/);
});

test('resolveLimits rejects incoherent configuration', () => {
  assert.throws(() => resolveLimits({ maxMetadataBytes: 0 }), RangeError);
  assert.throws(() => resolveLimits({ maxAttachments: -1 }), RangeError);
  assert.throws(() => resolveLimits({ maxMetadataBytes: 64, maxFrameBytes: 32 }), RangeError);
  assert.throws(() => resolveLimits({ outboundSoftBytes: 64, outboundHardBytes: 32 }), RangeError);
});

test('fuzz: mutated headers are rejected or decoded, never crash the decoder', () => {
  const valid = Buffer.from(
    encodeFrame({ v: 1, type: 'event', body: { n: 1, b: new Uint8Array([1, 2]) } }, L),
  );

  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: valid.length - 1 }),
      fc.integer({ min: 0, max: 255 }),
      (index, byte) => {
        const mutated = Buffer.from(valid);
        mutated[index] = byte;
        const decoder = new FrameDecoder(L);
        try {
          decoder.push(mutated);
        } catch (err) {
          // The only acceptable failure is a protocol error — never a
          // TypeError, RangeError, or an OOM from a trusted length.
          assert.ok(
            err instanceof FrameProtocolError,
            `expected FrameProtocolError, got ${err?.constructor?.name}: ${err?.message}`,
          );
        }
        assert.ok(decoder.bufferedBytes <= L.maxFrameBytes);
      },
    ),
    { numRuns: 500 },
  );
});
