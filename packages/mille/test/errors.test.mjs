// FileSystemError + tryParseFxReason tests.
//
// Pure JS — no native binding required. Exercises the wire-format
// decoder that pairs with fx-binding/src/error.rs. The Rust side has
// its own parse_fx_reason() unit test covering encoding symmetry; this
// file covers the TS side.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  FileSystemError,
  isFileSystemError,
  tryParseFxReason,
} from '../dist/errors.js';

test('FileSystemError carries code + message + optional path', () => {
  const e = new FileSystemError('ENOENT', 'file not found', '/tmp/missing');
  assert.equal(e.name, 'FileSystemError');
  assert.equal(e.code, 'ENOENT');
  assert.equal(e.message, 'file not found');
  assert.equal(e.path, '/tmp/missing');
  assert.ok(e instanceof Error);
  assert.ok(isFileSystemError(e));
});

test('FileSystemError leaves path undefined when empty or omitted', () => {
  const a = new FileSystemError('EUNKNOWN', 'boom');
  const b = new FileSystemError('EUNKNOWN', 'boom', '');
  assert.equal(a.path, undefined);
  assert.equal(b.path, undefined);
});

test('isFileSystemError rejects plain errors and non-errors', () => {
  assert.equal(isFileSystemError(new Error('x')), false);
  assert.equal(isFileSystemError('FX|ENOENT|/a|b'), false);
  assert.equal(isFileSystemError(null), false);
  assert.equal(isFileSystemError(undefined), false);
});

test('tryParseFxReason round-trips ENOENT with path', () => {
  const fx = tryParseFxReason('FX|ENOENT|/a/b|No such file or directory');
  assert.ok(fx);
  assert.equal(fx.code, 'ENOENT');
  assert.equal(fx.path, '/a/b');
  assert.equal(fx.message, 'No such file or directory');
});

test('tryParseFxReason round-trips EUNKNOWN with empty path', () => {
  const fx = tryParseFxReason('FX|EUNKNOWN||entry id space exhausted');
  assert.ok(fx);
  assert.equal(fx.code, 'EUNKNOWN');
  assert.equal(fx.path, undefined);
  assert.equal(fx.message, 'entry id space exhausted');
});

test('tryParseFxReason preserves pipes inside the message', () => {
  // Rust side uses splitn(3, '|') so anything past the second pipe
  // belongs to the message verbatim.
  const fx = tryParseFxReason('FX|EINVAL||bad input: a|b|c');
  assert.ok(fx);
  assert.equal(fx.code, 'EINVAL');
  assert.equal(fx.message, 'bad input: a|b|c');
});

test('tryParseFxReason returns null for non-FX strings', () => {
  assert.equal(tryParseFxReason('regular error message'), null);
  assert.equal(tryParseFxReason('FX|only-one-segment'), null);
  assert.equal(tryParseFxReason(''), null);
  assert.equal(tryParseFxReason(null), null);
  assert.equal(tryParseFxReason(undefined), null);
  assert.equal(tryParseFxReason(42), null);
});
