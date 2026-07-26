// Framed stream channel tests — remote-workspace PR 2 (SPEC §24.1, §24.3).
//
// Two halves: the channel contract re-asserted over a Duplex rather than a
// MessagePort (the framed transport is the one that actually has a byte
// queue, so backpressure is testable here in a way it is not on a port),
// and a real FileExplorerHost driven by a real PortFileExplorer over paired
// PassThroughs — no native module, no tailnet, no Electron.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Duplex } from 'node:stream';

import {
  createFramedStreamHostChannel,
  createFramedStreamClientChannel,
  encodeFrame,
  DEFAULT_LIMITS,
} from '../dist/node.js';

const settle = () => new Promise((r) => setImmediate(r));

async function waitFor(predicate, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await settle();
  }
}

/**
 * Two PassThroughs cross-wired into a bidirectional pair, so a host channel
 * on one side and a client channel on the other actually talk.
 */
function duplexPair() {
  const a2b = new PassThrough();
  const b2a = new PassThrough();
  const a = Duplex.from({ readable: b2a, writable: a2b });
  const b = Duplex.from({ readable: a2b, writable: b2a });
  // Destroying one half of an in-process pair aborts the other with
  // ABORT_ERR, and a stream with no 'error' listener throws it as an
  // uncaught exception. A real transport's peer is on another machine; this
  // is harness plumbing, not something the channel should paper over.
  for (const s of [a, b, a2b, b2a]) s.on('error', () => {});
  return { a, b, a2b, b2a };
}

test('carries messages both ways over a Duplex', async () => {
  const { a, b } = duplexPair();
  const host = createFramedStreamHostChannel(a);
  const client = createFramedStreamClientChannel(b);

  const atClient = [];
  const atHost = [];
  client.onMessage((m) => atClient.push(m));
  host.onMessage((m) => atHost.push(m));

  host.send({ v: 1, type: 'snapshot', body: { mirror: new Uint8Array([1, 2, 3]) } });
  client.send({ v: 1, type: 'ack', body: { version: 9 } });

  await waitFor(() => atClient.length === 1 && atHost.length === 1, 'both directions');
  assert.deepEqual([...atClient[0].body.mirror], [1, 2, 3]);
  assert.equal(atHost[0].body.version, 9);

  host.close();
  client.close();
});

test('CH-001: order is preserved across 5,000 framed messages', async () => {
  const { a, b } = duplexPair();
  const host = createFramedStreamHostChannel(a);
  const client = createFramedStreamClientChannel(b);

  const seen = [];
  client.onMessage((m) => seen.push(m.body.n));
  for (let n = 0; n < 5000; n += 1) host.send({ v: 1, type: 'event', body: { n } });

  await waitFor(() => seen.length === 5000, 'all 5,000 frames');
  for (let n = 0; n < 5000; n += 1) assert.equal(seen[n], n);

  host.close();
  client.close();
});

test('CH-003 / CH-005 / CH-006: close semantics hold over a stream', async () => {
  const { a, b } = duplexPair();
  const host = createFramedStreamHostChannel(a);
  const client = createFramedStreamClientChannel(b);

  let closes = 0;
  host.onClose(() => {
    closes += 1;
  });
  host.close('done');
  host.close('again');
  await settle();

  assert.equal(closes, 1, 'exactly one close event');
  assert.equal(host.state, 'closed');
  assert.throws(() => host.send({ v: 1, type: 'event', body: {} }), /closed/);
  client.close();
});

test('a peer ending the stream closes the channel as REMOTE_CLOSE', async () => {
  const { a, b } = duplexPair();
  const host = createFramedStreamHostChannel(a);
  const client = createFramedStreamClientChannel(b);

  const codes = [];
  client.onClose((ev) => codes.push(ev.code));
  host.close();

  await waitFor(() => codes.length === 1, 'client observed the close');
  assert.equal(codes[0], 'REMOTE_CLOSE');
  client.close();
});

test('a malformed frame closes with PROTOCOL_ERROR and does not throw outward', async () => {
  const { a, b } = duplexPair();
  const client = createFramedStreamClientChannel(b);
  const codes = [];
  client.onClose((ev) => codes.push(ev.code));

  // Garbage that cannot be a Mille frame.
  a.write(Buffer.from('NOTAFRAME________________________'));

  await waitFor(() => codes.length === 1, 'protocol error surfaced');
  assert.equal(codes[0], 'PROTOCOL_ERROR');
  assert.equal(client.state, 'closed');
  a.destroy();
});

test('SPEC §20.1: writes stop at backpressure and bufferedBytes reflects our queue', async () => {
  // A writable that never drains: everything past the high-water mark stays
  // in the channel's own queue, which is exactly what bufferedBytes counts.
  const stalled = new Duplex({
    highWaterMark: 1,
    read() {},
    write(_chunk, _enc, _cb) {
      /* never call the callback — the stream never drains */
    },
  });
  const channel = createFramedStreamHostChannel(stalled, { outboundHardBytes: 4 * 1024 * 1024 });

  const payload = new Uint8Array(64 * 1024);
  for (let i = 0; i < 20; i += 1) {
    channel.send({ v: 1, type: 'event', body: { i, payload } });
  }

  assert.ok(channel.bufferedBytes > 0, 'frames are queued in the channel, not lost');
  assert.equal(channel.state, 'open', 'backpressure alone does not close the channel');

  // drain() must not resolve while the transport is stalled.
  let drained = false;
  void channel.drain().then(() => {
    drained = true;
  });
  await settle();
  assert.equal(drained, false, 'drain waits for the transport');

  channel.close();
  stalled.destroy();
});

test('exceeding the outbound hard limit closes with BACKPRESSURE and throws', async () => {
  const stalled = new Duplex({
    highWaterMark: 1,
    read() {},
    write() {
      /* never drains */
    },
  });
  const codes = [];
  const channel = createFramedStreamHostChannel(stalled, { outboundHardBytes: 256 * 1024 });
  channel.onClose((ev) => codes.push(ev.code));

  const payload = new Uint8Array(64 * 1024);
  assert.throws(() => {
    for (let i = 0; i < 100; i += 1) channel.send({ v: 1, type: 'event', body: { i, payload } });
  }, /exceed/);

  assert.equal(channel.state, 'closed');
  assert.deepEqual(codes, ['BACKPRESSURE']);
  assert.equal(channel.bufferedBytes, 0, 'the queue is released on close');
  stalled.destroy();
});

test('drain resolves once the transport accepts what was queued', async () => {
  const { a, b } = duplexPair();
  const host = createFramedStreamHostChannel(a);
  const client = createFramedStreamClientChannel(b);

  const seen = [];
  client.onMessage(() => seen.push(1));
  for (let i = 0; i < 200; i += 1) {
    host.send({ v: 1, type: 'event', body: { i, blob: new Uint8Array(1024) } });
  }
  await host.drain();
  assert.equal(host.bufferedBytes, 0, 'nothing left queued after drain');

  await waitFor(() => seen.length === 200, 'all frames delivered');
  host.close();
  client.close();
});

test('an encode failure throws but leaves the channel usable', async () => {
  const { a, b } = duplexPair();
  const host = createFramedStreamHostChannel(a);
  const client = createFramedStreamClientChannel(b);
  const seen = [];
  client.onMessage((m) => seen.push(m));

  const cyclic = { v: 1, type: 'event', body: {} };
  cyclic.body.self = cyclic.body;
  assert.throws(() => host.send(cyclic), /cyclic/);
  assert.equal(host.state, 'open', 'a caller bug is not a transport fault');

  host.send({ v: 1, type: 'event', body: { ok: true } });
  await waitFor(() => seen.length === 1, 'channel still works');
  assert.equal(seen[0].body.ok, true);

  host.close();
  client.close();
});

test('a frame larger than the negotiated limit is rejected by the receiver', async () => {
  const { a, b } = duplexPair();
  // Receiver accepts at most 4 KiB; sender is willing to emit more.
  const client = createFramedStreamClientChannel(b, { maxFrameBytes: 4096 });
  const codes = [];
  client.onClose((ev) => codes.push(ev.code));

  const oversized = encodeFrame(
    { v: 1, type: 'event', body: { blob: new Uint8Array(16 * 1024) } },
    DEFAULT_LIMITS,
  );
  a.write(Buffer.from(oversized));

  await waitFor(() => codes.length === 1, 'receiver rejected the frame');
  assert.equal(codes[0], 'PROTOCOL_ERROR');
  a.destroy();
});
