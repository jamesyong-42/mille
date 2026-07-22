import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  captureViewportAnchor,
  captureWindowedViewportAnchor,
  resolveViewportAnchor,
  resolveWindowedViewportAnchor,
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

function windowed(rows, requests) {
  return {
    rowCount: rows.length,
    readRows: (offset, limit) => {
      requests.push(limit);
      return rows.slice(offset, offset + limit);
    },
    findRowIndex: (id, hint, maxProbeRows) => {
      const start = Math.max(0, hint - Math.floor((maxProbeRows ?? 16_384) / 2));
      const limit = Math.min(rows.length - start, maxProbeRows ?? 16_384);
      requests.push(limit);
      const local = rows.slice(start, start + limit).findIndex((row) => row.id === id);
      return local === -1 ? -1 : start + local;
    },
  };
}

test('windowed anchor preserves insertion drift without full row arrays', () => {
  const previousRows = Array.from({ length: 20_000 }, (_, index) => ({ id: index + 1 }));
  const inserted = Array.from({ length: 1_000 }, (_, index) => ({ id: 30_000 + index }));
  const nextRows = [...inserted, ...previousRows];
  const requests = [];
  const previous = windowed(previousRows, requests);
  const next = windowed(nextRows, requests);
  const anchor = captureWindowedViewportAnchor(previous, 10_000 * 22, 22);
  assert.ok(anchor);
  const resolved = resolveWindowedViewportAnchor(anchor, previous, next, 22);
  assert.equal(resolved?.scrollOffsetPx, 11_000 * 22);
  assert.equal(resolved?.usedFallback, false);
});

test('windowed anchor preserves the next survivor position when its row is deleted', () => {
  const previousRows = Array.from({ length: 100 }, (_, index) => ({ id: index + 1 }));
  const nextRows = previousRows.filter((row) => row.id !== 51);
  const requests = [];
  const previous = windowed(previousRows, requests);
  const next = windowed(nextRows, requests);
  const anchor = captureWindowedViewportAnchor(previous, 50 * 22 + 5, 22);
  assert.ok(anchor);

  const resolved = resolveWindowedViewportAnchor(anchor, previous, next, 22);
  assert.equal(resolved?.id, 52);
  assert.equal(resolved?.scrollOffsetPx, 50 * 22 - 17);
  assert.equal(resolved?.usedFallback, true);
});

test('windowed anchor leaves a fully replaced projection alone', () => {
  const requests = [];
  const previous = windowed(rows([1, 2, 3]), requests);
  const next = windowed(rows([10, 11, 12]), requests);
  const anchor = captureWindowedViewportAnchor(previous, 20, 20);
  assert.ok(anchor);
  assert.equal(resolveWindowedViewportAnchor(anchor, previous, next, 20), null);
});
