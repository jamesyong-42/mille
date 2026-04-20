// Tests for the when-clause mini-language evaluator.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { evaluateWhen } from '../dist/commands/when.js';

// Numeric EntryKind constants (mirror api.d.ts).
const KIND_FILE = 0;
const KIND_DIRECTORY = 1;

function makeCtx({
  focusedEntry = null,
  focusedId = focusedEntry?.id ?? null,
  selectedIds = new Set(),
  selectedEntries = [],
  isMultiSelect = false,
  isRenaming = false,
} = {}) {
  return {
    fx: /** dummy — when-clauses never touch fx */ ({}),
    snapshot: /** dummy */ ({}),
    focusedId,
    focusedEntry,
    selectedIds,
    selectedEntries,
    isMultiSelect,
    isRenaming,
    host: {},
  };
}

function fileEntry(id = 1, parentId = 2) {
  return { id, parentId, name: 'foo.ts', kind: KIND_FILE, size: 0, mtimeMs: 0, ctimeMs: 0, isIgnored: false, isReadonly: false, isHidden: false };
}
function folderEntry(id = 2, parentId = null) {
  return { id, parentId, name: 'src', kind: KIND_DIRECTORY, size: 0, mtimeMs: 0, ctimeMs: 0, isIgnored: false, isReadonly: false, isHidden: false };
}

describe('evaluateWhen — tokens', () => {
  it('focusedIs.file is true when focused entry is a file', () => {
    const ctx = makeCtx({ focusedEntry: fileEntry() });
    assert.equal(evaluateWhen('focusedIs.file', ctx), true);
    assert.equal(evaluateWhen('focusedIs.folder', ctx), false);
  });

  it('focusedIs.folder is true for a directory', () => {
    const ctx = makeCtx({ focusedEntry: folderEntry() });
    assert.equal(evaluateWhen('focusedIs.folder', ctx), true);
    assert.equal(evaluateWhen('focusedIs.file', ctx), false);
  });

  it('focusedIs.root is true when focused has no parent', () => {
    const ctx = makeCtx({ focusedEntry: folderEntry(5, null) });
    assert.equal(evaluateWhen('focusedIs.root', ctx), true);
  });

  it('focusedIs.root is false when parent is set', () => {
    const ctx = makeCtx({ focusedEntry: folderEntry(5, 1) });
    assert.equal(evaluateWhen('focusedIs.root', ctx), false);
  });

  it('hasSelection reflects selection size', () => {
    assert.equal(evaluateWhen('hasSelection', makeCtx()), false);
    assert.equal(evaluateWhen('hasSelection', makeCtx({ selectedIds: new Set([1]) })), true);
  });

  it('isMultiSelect flag', () => {
    assert.equal(evaluateWhen('isMultiSelect', makeCtx()), false);
    assert.equal(evaluateWhen('isMultiSelect', makeCtx({ isMultiSelect: true })), true);
  });

  it('isRenaming flag', () => {
    assert.equal(evaluateWhen('isRenaming', makeCtx()), false);
    assert.equal(evaluateWhen('isRenaming', makeCtx({ isRenaming: true })), true);
  });
});

describe('evaluateWhen — operators', () => {
  it('&& combinator', () => {
    const ctx = makeCtx({
      focusedEntry: folderEntry(),
      selectedIds: new Set([2]),
    });
    assert.equal(evaluateWhen('focusedIs.folder && hasSelection', ctx), true);
    assert.equal(evaluateWhen('focusedIs.file && hasSelection', ctx), false);
  });

  it('|| combinator', () => {
    const ctx = makeCtx({ focusedEntry: fileEntry() });
    assert.equal(evaluateWhen('focusedIs.folder || focusedIs.file', ctx), true);
  });

  it('! unary negation', () => {
    const ctx = makeCtx();
    assert.equal(evaluateWhen('!hasSelection', ctx), true);
    assert.equal(evaluateWhen('!isRenaming', ctx), true);
  });

  it('parentheses override precedence', () => {
    const ctx = makeCtx({
      focusedEntry: fileEntry(),
      isRenaming: true,
    });
    // Without parens: focusedIs.file || (focusedIs.folder && !isRenaming)
    // With parens:    (focusedIs.file || focusedIs.folder) && !isRenaming
    assert.equal(
      evaluateWhen('focusedIs.file || focusedIs.folder && !isRenaming', ctx),
      true, // first operand satisfies ||
    );
    assert.equal(
      evaluateWhen('(focusedIs.file || focusedIs.folder) && !isRenaming', ctx),
      false, // !isRenaming is false → whole is false
    );
  });
});

describe('evaluateWhen — function form', () => {
  it('invokes the function', () => {
    const ctx = makeCtx({ isMultiSelect: true });
    assert.equal(evaluateWhen((c) => c.isMultiSelect, ctx), true);
    assert.equal(evaluateWhen((c) => !c.isMultiSelect, ctx), false);
  });

  it('undefined clause → true', () => {
    assert.equal(evaluateWhen(undefined, makeCtx()), true);
  });
});

describe('evaluateWhen — bad input', () => {
  it('throws on unknown token', () => {
    assert.throws(() => evaluateWhen('unknownThing', makeCtx()), /unknown token/);
  });

  it('throws on unknown operator character', () => {
    assert.throws(() => evaluateWhen('hasSelection & isRenaming', makeCtx()), /expected '&&'/);
  });

  it('throws on trailing input', () => {
    assert.throws(
      () => evaluateWhen('hasSelection hasSelection', makeCtx()),
      /trailing input/,
    );
  });

  it('throws on unclosed paren', () => {
    assert.throws(() => evaluateWhen('(hasSelection', makeCtx()), /expected '\)'/);
  });
});
