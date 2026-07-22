import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { decodeClientEntries, encodeClientEntries } from '../dist/entry-codec.js';

function entry(overrides = {}) {
  return {
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
    ...overrides,
  };
}

test('ClientEntry binary codec round-trips every field and option shape', () => {
  const entries = [
    entry(),
    entry({
      id: 2 ** 40,
      parentId: 1,
      name: 'café-树.txt',
      kind: 2,
      size: 2 ** 42,
      mtimeMs: -1_234_567,
      ctimeMs: 1_725_000_000_123,
      symlinkTargetIsDir: true,
      pathSegments: ['workspace', 'café-树.txt'],
      isIgnored: true,
      isReadonly: true,
      isHidden: true,
    }),
  ];

  const encoded = encodeClientEntries(entries);
  assert.ok(encoded instanceof ArrayBuffer);
  assert.deepEqual(decodeClientEntries(encoded), entries);
});

test('ClientEntry binary codec rejects truncated and trailing payloads', () => {
  const encoded = new Uint8Array(encodeClientEntries([entry()]));
  assert.throws(() => decodeClientEntries(encoded.subarray(0, encoded.length - 1)), /truncated/);

  const trailing = new Uint8Array(encoded.length + 1);
  trailing.set(encoded);
  trailing[trailing.length - 1] = 0xff;
  assert.throws(() => decodeClientEntries(trailing), /trailing byte/);
});

test('binary ClientEntry payload is materially smaller than JSON for a viewport', () => {
  const entries = Array.from({ length: 64 }, (_, index) =>
    entry({
      id: index + 1,
      parentId: 0,
      name: `file-${String(index + 1).padStart(6, '0')}.txt`,
      kind: 0,
    }),
  );
  const binaryBytes = encodeClientEntries(entries).byteLength;
  const jsonBytes = Buffer.byteLength(JSON.stringify(entries));

  assert.ok(
    binaryBytes < jsonBytes * 0.4,
    `${binaryBytes} binary bytes vs ${jsonBytes} JSON bytes`,
  );
});
