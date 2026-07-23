import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_EXPLORER_SETTINGS, FileExplorer } from '../dist/index.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mille-settings-order-'));
  writeFileSync(join(root, 'z.ts'), '');
  writeFileSync(join(root, 'a.js'), '');
  writeFileSync(join(root, 'alpha.txt'), '');
  writeFileSync(join(root, 'Beta.txt'), '');
  mkdirSync(join(root, 'folder.zz'));
  utimesSync(join(root, 'z.ts'), new Date(10_000), new Date(10_000));
  utimesSync(join(root, 'a.js'), new Date(30_000), new Date(30_000));
  return root;
}

async function namesFor(root, override) {
  const fx = new FileExplorer({
    roots: [root],
    settings: { ...DEFAULT_EXPLORER_SETTINGS, ...override },
  });
  try {
    await fx.populateFromRoots();
    const snapshot = fx.getSnapshot();
    const rootEntry = snapshot.roots()[0];
    assert.ok(rootEntry);
    return snapshot
      .visibleRows({ expanded: new Set([rootEntry.id]), offset: 1, limit: 20 })
      .map((row) => row.name);
  } finally {
    await fx.dispose();
  }
}

test('native snapshot applies type, modified, case, and folders-on-top settings', async () => {
  const root = fixture();
  const byType = await namesFor(root, { sortBy: 'type', foldersOnTop: false });
  assert.ok(byType.indexOf('a.js') < byType.indexOf('z.ts'));
  assert.ok(byType.indexOf('z.ts') < byType.indexOf('folder.zz'));

  const byModified = await namesFor(root, {
    sortBy: 'modified',
    foldersOnTop: false,
  });
  assert.ok(byModified.indexOf('a.js') < byModified.indexOf('z.ts'));

  const foldersFirst = await namesFor(root, {
    sortBy: 'type',
    foldersOnTop: true,
  });
  assert.equal(foldersFirst[0], 'folder.zz');

  const caseSensitive = await namesFor(root, {
    sortBy: 'name',
    caseSensitive: true,
    foldersOnTop: false,
  });
  assert.ok(caseSensitive.indexOf('Beta.txt') < caseSensitive.indexOf('alpha.txt'));
});

test('native snapshot applies locale tailoring without losing numeric ordering', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mille-settings-locale-'));
  for (const name of ['z.txt', 'å.txt', 'ä.txt', 'ö.txt', 'file10.txt', 'file2.txt']) {
    writeFileSync(join(root, name), '');
  }

  const english = await namesFor(root, {
    locale: 'en',
    foldersOnTop: false,
  });
  const swedish = await namesFor(root, {
    locale: 'sv',
    foldersOnTop: false,
  });

  assert.ok(english.indexOf('å.txt') < english.indexOf('z.txt'));
  assert.ok(swedish.indexOf('z.txt') < swedish.indexOf('å.txt'));
  assert.ok(swedish.indexOf('å.txt') < swedish.indexOf('ä.txt'));
  assert.ok(swedish.indexOf('ä.txt') < swedish.indexOf('ö.txt'));
  assert.ok(swedish.indexOf('file2.txt') < swedish.indexOf('file10.txt'));
});
