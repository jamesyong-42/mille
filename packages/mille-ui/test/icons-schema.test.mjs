// Phase 9.1 — icon theme schema validator tests.
//
// Hand-rolled validator, so we test both the happy paths (light-only,
// split, extra unknown fields) and each kind of rejection (wrong
// types, missing iconDefinitions, references to ids that don't
// exist, etc.).

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  IconThemeValidationError,
  validateIconTheme,
} from '../dist/icons/schema.js';

function minimal() {
  return {
    iconDefinitions: { _file: { iconPath: './file.svg' } },
    file: '_file',
  };
}

test('validateIconTheme accepts a light-only minimal theme', () => {
  const t = validateIconTheme(minimal());
  assert.equal(t.id, '<unnamed>');
  assert.equal(t.file, '_file');
  assert.ok(t.iconDefinitions['_file']);
  assert.equal(t.light, undefined);
  assert.equal(t.dark, undefined);
});

test('validateIconTheme accepts a split theme with light+dark overrides', () => {
  const t = validateIconTheme({
    iconDefinitions: {
      _file: { iconPath: './file.svg' },
      _file_light: { iconPath: './file-light.svg' },
      _file_dark: { iconPath: './file-dark.svg' },
    },
    file: '_file',
    light: { file: '_file_light' },
    dark: { file: '_file_dark' },
  });
  assert.ok(t.light);
  assert.ok(t.dark);
  assert.equal(t.light?.file, '_file_light');
  assert.equal(t.dark?.file, '_file_dark');
});

test('validateIconTheme accepts fileExtensions + fileNames + languageIds maps', () => {
  const t = validateIconTheme({
    iconDefinitions: {
      _ts: { iconPath: './ts.svg' },
      _rd: { iconPath: './readme.svg' },
      _py: { iconPath: './py.svg' },
    },
    fileExtensions: { ts: '_ts' },
    fileNames: { 'readme.md': '_rd' },
    languageIds: { python: '_py' },
  });
  assert.equal(t.fileExtensions?.['ts'], '_ts');
  assert.equal(t.fileNames?.['readme.md'], '_rd');
  assert.equal(t.languageIds?.['python'], '_py');
});

test('validateIconTheme preserves caller-supplied id', () => {
  const t = validateIconTheme({ ...minimal(), id: 'material' });
  assert.equal(t.id, 'material');
});

test('validateIconTheme rejects non-object root', () => {
  assert.throws(() => validateIconTheme(null), IconThemeValidationError);
  assert.throws(() => validateIconTheme('string'), IconThemeValidationError);
  assert.throws(() => validateIconTheme([1, 2]), IconThemeValidationError);
});

test('validateIconTheme rejects missing iconDefinitions in light-only', () => {
  assert.throws(
    () => validateIconTheme({ file: '_file' }),
    IconThemeValidationError,
  );
});

test('validateIconTheme rejects iconDefinition with no iconPath/fontCharacter/inlineSvg', () => {
  assert.throws(
    () =>
      validateIconTheme({
        iconDefinitions: { _empty: {} },
        file: '_empty',
      }),
    IconThemeValidationError,
  );
});

test('validateIconTheme rejects non-string iconPath', () => {
  assert.throws(
    () =>
      validateIconTheme({
        iconDefinitions: { _file: { iconPath: 42 } },
      }),
    IconThemeValidationError,
  );
});

test('validateIconTheme rejects non-string map value', () => {
  assert.throws(
    () =>
      validateIconTheme({
        iconDefinitions: { _ts: { iconPath: './ts.svg' } },
        fileExtensions: { ts: 99 },
      }),
    IconThemeValidationError,
  );
});

test('validateIconTheme rejects references to missing iconDefinition ids', () => {
  assert.throws(
    () =>
      validateIconTheme({
        iconDefinitions: { _file: { iconPath: './file.svg' } },
        file: '_file',
        fileExtensions: { ts: '_missing' },
      }),
    IconThemeValidationError,
  );
});

test('validateIconTheme rejects wrong default-id type', () => {
  assert.throws(
    () =>
      validateIconTheme({
        iconDefinitions: { _file: { iconPath: './file.svg' } },
        file: 42,
      }),
    IconThemeValidationError,
  );
});

test('validateIconTheme rejects malformed light override', () => {
  assert.throws(
    () =>
      validateIconTheme({
        iconDefinitions: { _file: { iconPath: './file.svg' } },
        file: '_file',
        light: 'not-an-object',
      }),
    IconThemeValidationError,
  );
});

test('validateIconTheme error.path points at the failing key', () => {
  try {
    validateIconTheme({
      iconDefinitions: {
        _ts: { iconPath: './ts.svg' },
      },
      fileExtensions: { ts: '_not_here' },
    });
    assert.fail('expected validation error');
  } catch (err) {
    assert.ok(err instanceof IconThemeValidationError);
    assert.match(err.path, /fileExtensions/);
  }
});

test('validateIconTheme accepts inlineSvg iconDefinitions', () => {
  const t = validateIconTheme({
    iconDefinitions: {
      _ts: { inlineSvg: '<svg></svg>' },
    },
    file: '_ts',
  });
  assert.equal(t.iconDefinitions['_ts']?.inlineSvg, '<svg></svg>');
});

test('validateIconTheme keeps fontColor when provided', () => {
  const t = validateIconTheme({
    iconDefinitions: {
      _ts: { iconPath: './ts.svg', fontColor: '#f00' },
    },
    file: '_ts',
  });
  assert.equal(t.iconDefinitions['_ts']?.fontColor, '#f00');
});
