// ExplorerChannel contract tests — remote-workspace PR 1 (SPEC §24.1).
//
// These assert the semantics every channel implementation must hold
// (CH-001…CH-008), against the MessagePort adapter. PR 2's framed stream
// channel is expected to reuse this file's expectations, so the assertions
// are written against the interface rather than the transport wherever
// the transport permits it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MessageChannel } from 'node:worker_threads';

import {
  createMessagePortClientChannel,
  createMessagePortHostChannel,
  isExplorerChannel,
} from '../dist/channel/message-port.js';

/** A MessageChannel pair wired to a host channel and a client channel. */
function pair() {
  const mc = new MessageChannel();
  const host = createMessagePortHostChannel(mc.port1);
  const client = createMessagePortClientChannel(mc.port2);
  return { host, client, mc };
}

/** Resolve after the event loop has drained queued port messages. */
const settle = () => new Promise((r) => setTimeout(r, 0));

/**
 * Poll until `predicate` holds. A MessagePort does not necessarily deliver
 * a large batch within one macrotask, so bulk assertions wait for the
 * expected count rather than for a fixed tick.
 */
async function waitFor(predicate, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await settle();
  }
}

test('CH-001: 10,000 messages arrive in send order', async () => {
  const { host, client } = pair();
  const received = [];
  client.onMessage((m) => received.push(m.body.n));

  for (let n = 0; n < 10_000; n += 1) {
    host.send({ v: 1, type: 'event', body: { n } });
  }
  await waitFor(() => received.length === 10_000, 'all 10,000 messages');

  assert.equal(received.length, 10_000, 'every message arrived');
  for (let n = 0; n < 10_000; n += 1) {
    assert.equal(received[n], n, `message ${n} kept its position`);
  }
  host.close();
  client.close();
});

test('CH-003: send after close throws', async () => {
  const { host, client } = pair();
  host.close();
  assert.equal(host.state, 'closed');
  assert.throws(() => host.send({ v: 1, type: 'event', body: {} }), /closed/);
  client.close();
});

test('CH-005: close is idempotent and emits exactly once', async () => {
  const { host, client } = pair();
  let closes = 0;
  let lastCode;
  host.onClose((ev) => {
    closes += 1;
    lastCode = ev.code;
  });

  host.close('first');
  host.close('second');
  host.dispose();
  await settle();

  assert.equal(closes, 1, 'only one close event');
  assert.equal(lastCode, 'LOCAL_CLOSE');
  client.close();
});

test('CH-006: no messages are delivered after close', async () => {
  const { host, client, mc } = pair();
  const received = [];
  client.onMessage((m) => received.push(m));

  host.send({ v: 1, type: 'event', body: { n: 1 } });
  await settle();
  assert.equal(received.length, 1, 'baseline delivery works');

  client.close();
  // Post straight at the raw port, bypassing the closed host channel, to
  // prove the client channel gates delivery on its own state rather than
  // relying on the underlying port listener having detached.
  mc.port1.postMessage({ v: 1, type: 'event', body: { n: 2 } });
  await settle();

  assert.equal(received.length, 1, 'nothing delivered after close');
  host.close();
});

test('CH-007: listener disposal stops callbacks and is idempotent', async () => {
  const { host, client } = pair();
  let count = 0;
  const sub = client.onMessage(() => {
    count += 1;
  });

  host.send({ v: 1, type: 'event', body: {} });
  await settle();
  assert.equal(count, 1);

  sub.dispose();
  sub.dispose(); // second dispose must not throw
  host.send({ v: 1, type: 'event', body: {} });
  await settle();
  assert.equal(count, 1, 'disposed listener stopped firing');

  host.close();
  client.close();
});

test('CH-008: a throwing listener does not stop the others or the channel', async () => {
  const { host, client } = pair();
  const warnings = [];
  // Rebuild the client channel with a logger so we can assert the throw
  // was reported rather than swallowed.
  client.close();
  const mc2 = new MessageChannel();
  const host2 = createMessagePortHostChannel(mc2.port1);
  const client2 = createMessagePortClientChannel(mc2.port2, {
    logger: { warn: (msg, detail) => warnings.push({ msg, detail }) },
  });

  const seen = [];
  client2.onMessage(() => {
    throw new Error('listener blew up');
  });
  client2.onMessage((m) => seen.push(m.body.n));

  host2.send({ v: 1, type: 'event', body: { n: 7 } });
  await settle();

  assert.deepEqual(seen, [7], 'the second listener still ran');
  assert.equal(client2.state, 'open', 'the channel survived');
  assert.equal(warnings.length, 1, 'the throw was reported');
  assert.match(warnings[0].msg, /listener threw/);

  host.close();
  host2.close();
  client2.close();
});

test('CH-004: drain resolves after queued messages are accepted', async () => {
  const { host, client } = pair();
  const received = [];
  client.onMessage((m) => received.push(m.body.n));

  for (let n = 0; n < 100; n += 1) host.send({ v: 1, type: 'event', body: { n } });
  await host.drain();
  // MessagePort accepts synchronously, so drain implies handoff is done;
  // bufferedBytes must therefore be zero once it resolves.
  assert.equal(host.bufferedBytes, 0);

  await settle();
  assert.equal(received.length, 100);
  host.close();
  client.close();
});

test('onClose after the channel already closed still fires', async () => {
  const { host, client } = pair();
  host.close('early');

  const events = [];
  host.onClose((ev) => events.push(ev));
  await settle();

  assert.equal(events.length, 1, 'late subscriber got the terminal state');
  assert.equal(events[0].code, 'LOCAL_CLOSE');
  client.close();
});

test('a transport error closes with TRANSPORT_ERROR and rethrows', async () => {
  // A port whose postMessage always throws stands in for a dead transport.
  const dead = {
    postMessage() {
      throw new Error('port is gone');
    },
    addEventListener() {},
    removeEventListener() {},
  };
  const channel = createMessagePortHostChannel(dead);
  const codes = [];
  channel.onClose((ev) => codes.push(ev.code));

  assert.throws(() => channel.send({ v: 1, type: 'event', body: {} }), /port is gone/);
  assert.equal(channel.state, 'closed');
  assert.deepEqual(codes, ['TRANSPORT_ERROR']);
});

test('isExplorerChannel distinguishes a channel from a raw port', () => {
  const mc = new MessageChannel();
  const channel = createMessagePortHostChannel(mc.port1);
  assert.equal(isExplorerChannel(channel), true);
  assert.equal(isExplorerChannel(mc.port2), false);
  assert.equal(isExplorerChannel(null), false);
  assert.equal(isExplorerChannel(undefined), false);
  channel.close();
  // port2 was never wrapped in a channel, so nothing else will close it —
  // an open MessagePort keeps the event loop alive and hangs `node --test`.
  mc.port2.close();
});
