// Phase 6.3 — throttled live-region announcer.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { Window } from 'happy-dom';

const hdWindow = new Window({ url: 'http://localhost/' });
const hdDocument = hdWindow.document;

const { createLiveAnnouncer } = await import('../dist/a11y.js');

test('createLiveAnnouncer is lazy-mounted (no DOM at construct)', () => {
  const body = hdDocument.body;
  const before = body.querySelectorAll('[data-mille-live-announcer]').length;
  const announcer = createLiveAnnouncer({
    document: hdDocument,
    mount: (el) => body.appendChild(el),
  });
  assert.equal(announcer.mounted, false);
  assert.equal(
    body.querySelectorAll('[data-mille-live-announcer]').length,
    before,
  );
  announcer.dispose();
});

test('createLiveAnnouncer coalesces within window without flushForce', async () => {
  const body = hdDocument.body;
  let fakeNow = 1_000;
  const timers = [];
  const announcer = createLiveAnnouncer({
    document: hdDocument,
    minIntervalMs: 200,
    coalesceWindowMs: 30,
    now: () => fakeNow,
    setTimeout: (fn, ms) => {
      const id = { fn, at: fakeNow + ms };
      timers.push(id);
      return id;
    },
    clearTimeout: (id) => {
      const i = timers.indexOf(id);
      if (i >= 0) timers.splice(i, 1);
    },
    mount: (el) => body.appendChild(el),
  });

  announcer.announce('Deleted a.ts');
  announcer.announce('Deleted b.ts');
  announcer.announce('Deleted c.ts');

  // Advance past coalesce window only.
  fakeNow += 30;
  for (const t of [...timers]) {
    if (t.at <= fakeNow) {
      const i = timers.indexOf(t);
      if (i >= 0) timers.splice(i, 1);
      t.fn();
    }
  }

  const region = body.querySelector('[data-mille-live-announcer="polite"]');
  assert.ok(region);
  // Two messages were dropped by the coalesce window; the storm reports its
  // size rather than leaving the user with one arbitrary filename.
  assert.equal(region.textContent, 'Deleted c.ts (and 2 more)');

  // Second announce within minInterval should wait.
  announcer.announce('Deleted d.ts');
  fakeNow += 30;
  for (const t of [...timers]) {
    if (t.at <= fakeNow) {
      const i = timers.indexOf(t);
      if (i >= 0) timers.splice(i, 1);
      t.fn();
    }
  }
  // Still old message — min interval not elapsed.
  assert.equal(region.textContent, 'Deleted c.ts (and 2 more)');

  fakeNow += 200;
  for (const t of [...timers]) {
    if (t.at <= fakeNow) {
      const i = timers.indexOf(t);
      if (i >= 0) timers.splice(i, 1);
      t.fn();
    }
  }
  assert.equal(region.textContent, 'Deleted d.ts');

  announcer.dispose();
});

test('politeness uses separate regions with matching roles', () => {
  const body = hdDocument.body;
  const mounted = [];
  const announcer = createLiveAnnouncer({
    document: hdDocument,
    minIntervalMs: 0,
    coalesceWindowMs: 0,
    mount: (el) => {
      mounted.push(el);
      body.appendChild(el);
    },
  });

  announcer.announce('Saved', 'polite');
  announcer.flushForce();
  announcer.announce('Delete failed', 'assertive');
  announcer.flushForce();

  // Assistive tech latches politeness at insert time, so each politeness
  // needs its own region — never one node with a mutated aria-live.
  assert.equal(mounted.length, 2);
  const polite = mounted.find(
    (el) => el.getAttribute('data-mille-live-announcer') === 'polite',
  );
  const assertive = mounted.find(
    (el) => el.getAttribute('data-mille-live-announcer') === 'assertive',
  );
  assert.ok(polite && assertive);
  // role=status is implicitly polite, role=alert implicitly assertive —
  // the pairing must not contradict aria-live.
  assert.equal(polite.getAttribute('role'), 'status');
  assert.equal(polite.getAttribute('aria-live'), 'polite');
  assert.equal(assertive.getAttribute('role'), 'alert');
  assert.equal(assertive.getAttribute('aria-live'), 'assertive');

  assert.equal(polite.textContent, 'Saved');
  assert.equal(assertive.textContent, 'Delete failed');

  announcer.dispose();
  assert.equal(
    body.querySelectorAll('[data-mille-live-announcer]').length,
    0,
    'dispose removes both regions',
  );
});

test('announceMany singular and plural', () => {
  const body = hdDocument.body;
  const announcer = createLiveAnnouncer({
    document: hdDocument,
    minIntervalMs: 0,
    coalesceWindowMs: 0,
    mount: (el) => body.appendChild(el),
  });
  announcer.announceMany('Renamed', 1);
  announcer.flushForce();
  const region = body.querySelector('[data-mille-live-announcer]');
  assert.equal(region?.textContent, 'Renamed 1 item');
  announcer.announceMany('Deleted', 12);
  announcer.flushForce();
  assert.equal(region?.textContent, 'Deleted 12 items');
  announcer.dispose();
});
