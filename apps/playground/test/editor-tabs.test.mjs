import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { planEditorTabOpen, settleEditorTabLoad } from '../scripts/editor-tabs.mjs';

const welcome = {
  id: 'welcome',
  title: 'Welcome',
  kind: 'welcome',
  body: 'welcome',
  highlighted: true,
  preview: false,
};

const entry = (id) => ({ id, name: `file-${id}.ts` });

test('one preview slot is replaced while permanent tabs survive', () => {
  const first = planEditorTabOpen([welcome], entry(1), 'preview');
  assert.equal(first.shouldLoad, true);
  assert.deepEqual(
    first.tabs.map((tab) => [tab.entryId, tab.preview]),
    [[1, true]],
  );

  const second = planEditorTabOpen(first.tabs, entry(2), 'preview');
  assert.deepEqual(
    second.tabs.map((tab) => [tab.entryId, tab.preview]),
    [[2, true]],
  );

  const promoted = planEditorTabOpen(second.tabs, entry(2), 'permanent');
  assert.equal(promoted.shouldLoad, false);
  assert.deepEqual(
    promoted.tabs.map((tab) => [tab.entryId, tab.preview]),
    [[2, false]],
  );

  const third = planEditorTabOpen(promoted.tabs, entry(3), 'preview');
  assert.deepEqual(
    third.tabs.map((tab) => [tab.entryId, tab.preview]),
    [
      [2, false],
      [3, true],
    ],
  );
});

test('reopening a permanent tab activates it without duplicates or reload', () => {
  const opened = planEditorTabOpen([welcome], entry(7), 'permanent');
  const reopened = planEditorTabOpen(opened.tabs, entry(7), 'preview');
  assert.equal(reopened.activeTabId, 'file:7');
  assert.equal(reopened.shouldLoad, false);
  assert.equal(reopened.tabs.length, 1);
  assert.equal(reopened.tabs[0].preview, false);
});

test('content settlement rejects removed and superseded loads', () => {
  const first = planEditorTabOpen([welcome], entry(1), 'preview');
  const replaced = planEditorTabOpen(first.tabs, entry(2), 'preview');
  const removed = settleEditorTabLoad(replaced.tabs, first.activeTabId, 'stale', true, 1, 1);
  assert.equal(removed, replaced.tabs);

  const reopened = planEditorTabOpen(replaced.tabs, entry(1), 'preview');
  const superseded = settleEditorTabLoad(
    reopened.tabs,
    reopened.activeTabId,
    'old request',
    true,
    1,
    2,
  );
  assert.equal(superseded, reopened.tabs);
  assert.equal(superseded[0].body, '// loading…');

  const current = settleEditorTabLoad(reopened.tabs, reopened.activeTabId, 'current', true, 2, 2);
  assert.equal(current[0].body, 'current');
  assert.equal(current[0].highlighted, true);
});
