import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  MAX_LAYOUT_ANIMATION_ROWS,
  planLayoutAnimation,
} from '../dist/hooks/layoutAnimation.js';

const defaults = {
  viewportAnchored: false,
  prefersReducedMotion: false,
  animationInFlight: false,
};

test('layout animation plans only entered and materially repositioned mounted rows', () => {
  const plan = planLayoutAnimation(
    new Map([
      [1, 0],
      [2, 22],
      [3, 44],
    ]),
    [
      { id: 1, offsetPx: 0 },
      { id: 9, offsetPx: 22 },
      { id: 2, offsetPx: 44 },
    ],
    defaults,
  );

  assert.equal(plan.active, true);
  assert.deepEqual(Array.from(plan.enteringIds), [9]);
  assert.deepEqual(Array.from(plan.repositioningIds), [2]);
});

test('unrelated structural versions do not animate a stable viewport', () => {
  const plan = planLayoutAnimation(
    new Map([
      [1, 0],
      [2, 22],
    ]),
    [
      { id: 1, offsetPx: 0 },
      { id: 2, offsetPx: 22 },
    ],
    defaults,
  );

  assert.equal(plan.active, false);
  assert.equal(plan.suppressedBy, 'no-visible-change');
});

test('anchoring, reduced motion, and an in-flight transaction suppress new motion', () => {
  const previous = new Map([[1, 0]]);
  const next = [{ id: 2, offsetPx: 0 }];

  for (const [option, reason] of [
    ['viewportAnchored', 'anchored'],
    ['prefersReducedMotion', 'reduced-motion'],
    ['animationInFlight', 'in-flight'],
  ]) {
    const plan = planLayoutAnimation(previous, next, {
      ...defaults,
      [option]: true,
    });
    assert.equal(plan.active, false);
    assert.equal(plan.suppressedBy, reason);
  }
});

test('large visible churn is rejected before it can create a transition storm', () => {
  const previous = new Map(
    Array.from({ length: MAX_LAYOUT_ANIMATION_ROWS + 1 }, (_, index) => [
      index + 1,
      index * 22,
    ]),
  );
  const next = Array.from(
    { length: MAX_LAYOUT_ANIMATION_ROWS + 1 },
    (_, index) => ({ id: index + 1, offsetPx: (index + 1) * 22 }),
  );
  const plan = planLayoutAnimation(previous, next, defaults);

  assert.equal(plan.active, false);
  assert.equal(plan.suppressedBy, 'budget');
  assert.equal(plan.enteringIds.size, 0);
  assert.equal(plan.repositioningIds.size, 0);
});
