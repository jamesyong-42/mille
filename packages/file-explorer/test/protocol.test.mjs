// Wire protocol helpers — Phase 7 commit 7.2.
//
// Exercises the frame envelope helpers. Message routing itself lands
// in 7.3 (host) and 7.4 (client); these tests only pin the envelope
// shape + version-gate behavior.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  PROTOCOL_VERSION,
  validateFrameVersion,
  isCompatibleVersion,
  frame,
} from '../dist/protocol.js';

test('frame() wraps body with current version + type', () => {
  const f = frame('handshake', { version: 1, clientId: 'x' });
  assert.equal(f.v, PROTOCOL_VERSION);
  assert.equal(f.type, 'handshake');
  assert.deepEqual(f.body, { version: 1, clientId: 'x' });
});

test('validateFrameVersion rejects non-object', () => {
  assert.equal(validateFrameVersion(null), null);
  assert.equal(validateFrameVersion('string'), null);
  assert.equal(validateFrameVersion(42), null);
  // Arrays are objects but lack the required fields.
  assert.equal(validateFrameVersion([1, 2, 3]), null);
});

test('validateFrameVersion rejects missing fields', () => {
  assert.equal(validateFrameVersion({ v: 1 }), null);
  assert.equal(validateFrameVersion({ v: 1, type: 'x' }), null);
  assert.equal(validateFrameVersion({ type: 'x', body: {} }), null);
});

test('validateFrameVersion rejects wrong field types', () => {
  assert.equal(validateFrameVersion({ v: '1', type: 'x', body: {} }), null);
  assert.equal(validateFrameVersion({ v: 1, type: 2, body: {} }), null);
});

test('validateFrameVersion accepts valid shape', () => {
  const ok = validateFrameVersion({ v: 1, type: 'handshake', body: {} });
  assert.ok(ok);
  assert.equal(ok?.v, 1);
  assert.equal(ok?.type, 'handshake');
});

test('isCompatibleVersion compares major', () => {
  assert.ok(isCompatibleVersion(PROTOCOL_VERSION));
  assert.equal(isCompatibleVersion(999), false);
  assert.equal(isCompatibleVersion(0), false);
});

test('PROTOCOL_VERSION is a positive integer', () => {
  assert.equal(typeof PROTOCOL_VERSION, 'number');
  assert.ok(Number.isInteger(PROTOCOL_VERSION));
  assert.ok(PROTOCOL_VERSION > 0);
});
