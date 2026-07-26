// Pins the invariant `policy_gate` exists for: a watcher batch classifying
// with one matcher must not land on top of a settings change that reclassified
// with another.
//
// The gate makes "read the matchers, write the store" atomic on both sides, so
// `updateProjectionSettings` either runs before a batch (the batch then uses
// the new matcher) or after it (the reclassify fixes the batch's rows). Remove
// it and a long batch can interleave: rows written after the reclassify keep a
// classification computed from the old globs, and excluded files stay visible.
//
// This is a stress test, not a deterministic one: the window is real but has
// to be hit, and nothing here can inject a pause into the Rust batch loop.
// It is therefore calibrated rather than guessed. Commenting out the
// `policy_gate` acquisition in `watch_runtime::process_batch` and rebuilding:
//
//   400 files, 5 offsets  → caught 2 of 3 runs   (too weak to keep)
//   1,200 files, 7 offsets → caught 5 of 5 runs, and passed 6 of 6 with the
//                            gate restored
//
// The file count is what matters: a wider batch keeps the classify-and-write
// loop busy for longer, so the settings change has somewhere to land. Shrink
// it and this stops being a guard. If it ever fails, do not treat it as flaky
// until the gate is confirmed intact.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_EXPLORER_SETTINGS, FileExplorer } from '../dist/index.js';

const BASE = {
  ...DEFAULT_EXPLORER_SETTINGS,
  compactFolders: false,
  fileNestingPatterns: {},
  // Excluded entries are only *hidden* when this is off; the default keeps
  // them visible (project-view behaviour), which would make the assertion
  // below unfalsifiable.
  showIgnoredFiles: false,
};

/** A batch wide enough that a settings change can land in the middle of it. */
const BATCH_FILES = 1_200;
const DEBOUNCE_MS = 40;

function visibleNames(fx) {
  const snap = fx.getSnapshot();
  const rootId = snap.roots()[0]?.id;
  if (rootId === undefined) return [];
  return snap
    .visibleRows({ expanded: new Set([rootId]), offset: 0, limit: 5_000 })
    .map((row) => row.name);
}

async function waitFor(predicate, timeoutMs = 10_000) {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

test('a watcher batch cannot resurrect entries a settings change excluded', async () => {
  // Several interleavings: the settings change is aimed just before, during,
  // and just after the batch the debounce releases.
  const offsets = [0, 5, 10, 20, 35, 60, 90];
  for (const offset of offsets) {
    const root = mkdtempSync(join(tmpdir(), 'mille-policy-race-'));
    const fx = new FileExplorer({
      roots: [root],
      settings: { ...BASE, excludeGlobs: [] },
      watchDebounceMs: DEBOUNCE_MS,
    });
    try {
      await fx.populateFromRoots();

      // Land the whole batch on disk first so the debounce releases it as one
      // unit of work for the watcher to classify.
      for (let i = 0; i < BATCH_FILES; i += 1) {
        writeFileSync(join(root, `entry-${i}.log`), 'x');
      }

      // Fire the settings change into that window.
      await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS + offset));
      fx.updateProjectionSettings({ ...BASE, excludeGlobs: ['*.log'] });

      // Let the watcher finish whatever it was doing.
      const settled = await waitFor(() => {
        const names = visibleNames(fx);
        return names.every((name) => !name.endsWith('.log'));
      });

      const leaked = visibleNames(fx).filter((name) => name.endsWith('.log'));
      assert.ok(
        settled && leaked.length === 0,
        `offset ${offset} ms: ${leaked.length} excluded file(s) still visible ` +
          `(e.g. ${leaked.slice(0, 3).join(', ')}) — a watcher batch wrote a ` +
          'classification from the pre-change globs',
      );
    } finally {
      await fx.dispose();
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }
});
