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

  const region = body.querySelector('[data-mille-live-announcer]');
  assert.ok(region);
  assert.equal(region.textContent, 'Deleted c.ts');

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
  assert.equal(region.textContent, 'Deleted c.ts');

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
