import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  DEFAULT_EXPLORER_SETTINGS,
  EXPLORER_SETTINGS_LIMITS,
  parseExplorerSettings,
  resolveExplorerSettings,
  serializeExplorerSettings,
} from '../dist/index.js';

test('settings defaults are explicit and stable', () => {
  assert.deepEqual(resolveExplorerSettings(null), DEFAULT_EXPLORER_SETTINGS);
  assert.deepEqual(DEFAULT_EXPLORER_SETTINGS, {
    sortBy: 'name',
    caseSensitive: false,
    locale: null,
    foldersOnTop: true,
    showHiddenFiles: true,
    showIgnoredFiles: true,
    compactFolders: true,
    excludeGlobs: [],
    fileNestingPatterns: {},
  });
});

test('root settings override workspace settings which override globals', () => {
  const document = parseExplorerSettings({
    version: 1,
    global: {
      sortBy: 'type',
      foldersOnTop: false,
      excludeGlobs: ['dist/**'],
      fileNestingPatterns: { '*.ts': ['${capture}.test.ts'] },
    },
    workspaces: {
      alpha: {
        settings: {
          sortBy: 'modified',
          showIgnoredFiles: false,
          fileNestingPatterns: { '*.js': ['${capture}.map'] },
        },
        roots: {
          app: {
            sortBy: 'name',
            caseSensitive: true,
            excludeGlobs: ['generated/**'],
          },
        },
      },
    },
  });
  assert.ok(document);
  assert.deepEqual(resolveExplorerSettings(document, 'alpha', 'app'), {
    ...DEFAULT_EXPLORER_SETTINGS,
    sortBy: 'name',
    caseSensitive: true,
    foldersOnTop: false,
    showIgnoredFiles: false,
    excludeGlobs: ['generated/**'],
    fileNestingPatterns: {
      '*.js': ['${capture}.map'],
      '*.ts': ['${capture}.test.ts'],
    },
  });
});

test('parser migrates flat v0 settings and serializes deterministic key order', () => {
  const migrated = parseExplorerSettings({
    sortBy: 'modified',
    excludeGlobs: ['z/**', 'a/**', 'z/**'],
  });
  assert.ok(migrated);
  assert.equal(migrated.version, 1);
  assert.deepEqual(migrated.global?.excludeGlobs, ['a/**', 'z/**']);
  assert.equal(
    serializeExplorerSettings(migrated),
    '{"version":1,"global":{"sortBy":"modified","excludeGlobs":["a/**","z/**"]}}',
  );
  assert.equal(parseExplorerSettings({ version: 99 }), null);
  assert.equal(parseExplorerSettings('{broken'), null);
});

test('parser bounds workspaces, roots, globs, and nesting rules', () => {
  const roots = Object.fromEntries(
    Array.from({ length: EXPLORER_SETTINGS_LIMITS.rootsPerWorkspace + 10 }, (_, index) => [
      `root-${index}`,
      { showHiddenFiles: false },
    ]),
  );
  const workspaces = Object.fromEntries(
    Array.from({ length: EXPLORER_SETTINGS_LIMITS.workspaces + 10 }, (_, index) => [
      `workspace-${index}`,
      { roots },
    ]),
  );
  const parsed = parseExplorerSettings({ version: 1, workspaces });
  assert.ok(parsed);
  assert.equal(Object.keys(parsed.workspaces ?? {}).length, EXPLORER_SETTINGS_LIMITS.workspaces);
  const first = Object.values(parsed.workspaces ?? {})[0];
  assert.equal(Object.keys(first?.roots ?? {}).length, EXPLORER_SETTINGS_LIMITS.rootsPerWorkspace);
});
