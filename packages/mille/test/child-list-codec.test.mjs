import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { decodeChildLists, encodeChildLists } from '../dist/child-list-codec.js';

test('packed child lists retain parent order and use u32 views when possible', () => {
  const encoded = encodeChildLists(
    new Map([
      [7, [9, 3, 5]],
      [11, []],
    ]),
  );
  const decoded = decodeChildLists(encoded);
  assert.ok(decoded.get(7) instanceof Uint32Array);
  assert.deepEqual(Array.from(decoded.get(7)), [9, 3, 5]);
  assert.deepEqual(Array.from(decoded.get(11)), []);
  assert.equal(encoded.byteLength, 56);
});

test('packed child lists preserve safe ids above u32', () => {
  const large = 0x1_0000_0001;
  const decoded = decodeChildLists(encodeChildLists(new Map([[large, [1, large, 4]]])));
  assert.ok(decoded.get(large) instanceof Float64Array);
  assert.deepEqual(Array.from(decoded.get(large)), [1, large, 4]);
});

test('packed child lists reject malformed and truncated payloads', () => {
  const encoded = encodeChildLists(new Map([[1, [2, 3, 4]]]));
  assert.throws(() => decodeChildLists(encoded.slice(0, -1)), /truncated children/);
  const badMagic = encoded.slice(0);
  new DataView(badMagic).setUint32(0, 0, true);
  assert.throws(() => decodeChildLists(badMagic), /invalid magic/);
});
