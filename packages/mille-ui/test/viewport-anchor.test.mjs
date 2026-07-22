import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  captureViewportAnchor,
  resolveViewportAnchor,
} from '../dist/hooks/viewportAnchor.js';

const rows = (ids) => ids.map((id) => ({ id }));

test('viewport anchor preserves the top row and sub-row pixel offset after insertion above', () => {
  const previous = rows([1, 2, 3, 4, 5]);
  const next = rows([10, 11, 1, 2, 3, 4, 5]);
  const anchor = captureViewportAnchor(previous, 45, 20);

  assert.deepEqual(anchor, { id: 3, index: 2, viewportOffsetPx: -5 });
  assert.deepEqual(resolveViewportAnchor(anchor, previous, next, 20), {
    id: 3,
    index: 4,
    scrollOffsetPx: 85,
    usedFallback: false,
  });
});

test('viewport anchor uses the next surviving row when the anchor is deleted', () => {
  const previous = rows([1, 2, 3, 4, 5]);
  const next = rows([1, 2, 4, 5]);
  const anchor = captureViewportAnchor(previous, 40, 20);

  assert.deepEqual(resolveViewportAnchor(anchor, previous, next, 20), {
    id: 4,
    index: 2,
    scrollOffsetPx: 20,
    usedFallback: true,
  });
});

test('viewport anchor leaves an empty or fully replaced projection alone', () => {
  const previous = rows([1, 2, 3]);
  const anchor = captureViewportAnchor(previous, 20, 20);
  assert.equal(resolveViewportAnchor(anchor, previous, [], 20), null);
  assert.equal(resolveViewportAnchor(anchor, previous, rows([10, 11]), 20), null);
});
