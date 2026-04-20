// `@vibecook/mille-ui/headless` entry point — smoke tests.
//
// Verifies:
//   1. Every member of the `FileTreeHeadless` namespace resolves to a
//      defined component / function.
//   2. `<FileTreeHeadless.Root fx={fake} ariaLabel="Files" />` renders
//      structural DOM + ARIA without importing any CSS (happy-dom has
//      no stylesheet loaded; rendering relies only on inline / layout
//      styles).
//   3. The `milleClassNames` catalog returns the concrete `mille-*`
//      strings the components emit.
//   4. Hooks are callable from `/headless` (smoke via hook identity).
//   5. DnD + clipboard + selection hooks are importable from `/headless`.
//   6. `defaultCommands` is exported from `/headless` (command registry
//      surface).

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { Window } from 'happy-dom';

const hdWindow = new Window({ url: 'http://localhost/' });
const hdDocument = hdWindow.document;

function installGlobal(name, value) {
  Object.defineProperty(globalThis, name, {
    value,
    configurable: true,
    writable: true,
    enumerable: false,
  });
}

installGlobal('window', hdWindow);
installGlobal('document', hdDocument);
installGlobal('navigator', hdWindow.navigator);
installGlobal('HTMLElement', hdWindow.HTMLElement);
installGlobal('Node', hdWindow.Node);
installGlobal('Element', hdWindow.Element);
installGlobal('MessageChannel', hdWindow.MessageChannel);
installGlobal('IS_REACT_ACT_ENVIRONMENT', true);
if (typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  installGlobal('ResizeObserver', ResizeObserverMock);
}

const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');

// The subpath-export under test. This import MUST resolve without any
// CSS side-effect — if mille-ui/headless grows a `import './tokens.css'`
// the test would still pass (Node ignores CSS imports), but it proves
// the JS export surface is complete on its own.
const headless = await import('../dist/headless.js');
const {
  FileTreeHeadless,
  milleClassNames,
  createCommandRegistry,
  defaultCommands,
  useFileTreeDragDrop,
  useClipboardState,
  useFileTreeSelection,
  FileTreeProvider,
  useFileTreeContext,
} = headless;

const { createFakeEngine, createFakeSnapshot } = await import(
  '../dist/testing.js'
);

// Synthetic observers so @tanstack/react-virtual can compute a range
// under happy-dom. Same pattern as `file-tree-read.test.mjs`.
function makeObservers({ height = 400, width = 600 } = {}) {
  const offsetRef = { current: 0 };
  const offsetListeners = new Set();
  const observeElementRect = (_instance, cb) => {
    cb({ width, height });
    return () => {};
  };
  const observeElementOffset = (_instance, cb) => {
    offsetListeners.add(cb);
    cb(offsetRef.current, false);
    return () => {
      offsetListeners.delete(cb);
    };
  };
  return { observeElementRect, observeElementOffset };
}

function makeRow({ id, parentId, name, depth, kind, hasChildren, isExpanded }) {
  return {
    id,
    parentId,
    name,
    kind,
    size: 0,
    mtimeMs: 0,
    ctimeMs: 0,
    isIgnored: false,
    isReadonly: false,
    isHidden: false,
    depth,
    hasChildren,
    isExpanded,
  };
}

// ─── Test 1: namespace completeness ────────────────────────────────

test('FileTreeHeadless exposes every documented member', () => {
  const expected = [
    'Root',
    'Row',
    'Icon',
    'Decorations',
    'RenameInput',
    'ContextMenu',
    'ContextMenuItem',
    'Filter',
    'SearchResults',
    'DragIndicator',
    'IndentGuides',
    'DisclosureChevron',
    'LoadingBadge',
  ];
  for (const key of expected) {
    const member = FileTreeHeadless[key];
    assert.ok(member, `FileTreeHeadless.${key} should be defined`);
    // React memo() wraps a function in a special object (with
    // `$$typeof = Symbol(react.memo)`); plain components are functions.
    // Both are valid React elements — accept either.
    const t = typeof member;
    assert.ok(
      t === 'function' || (t === 'object' && member.$$typeof !== undefined),
      `FileTreeHeadless.${key} should be a React component (got ${t})`,
    );
  }
});

// ─── Test 2: <Root> renders structural DOM + ARIA without CSS ──────

test('FileTreeHeadless.Root renders structural DOM + ARIA without CSS', async () => {
  const fx = createFakeEngine();
  const rows = [
    makeRow({
      id: 1,
      parentId: null,
      name: 'root',
      depth: 0,
      kind: 1,
      hasChildren: true,
      isExpanded: true,
    }),
    makeRow({
      id: 2,
      parentId: 1,
      name: 'a.txt',
      depth: 1,
      kind: 0,
      hasChildren: false,
      isExpanded: false,
    }),
    makeRow({
      id: 3,
      parentId: 1,
      name: 'b.txt',
      depth: 1,
      kind: 0,
      hasChildren: false,
      isExpanded: false,
    }),
  ];
  fx.emitDelta(createFakeSnapshot({ rows, treeVersion: 1 }));

  const container = hdDocument.createElement('div');
  hdDocument.body.appendChild(container);
  const root = createRoot(container);
  const obs = makeObservers({ height: 400 });

  await act(async () => {
    root.render(
      createElement(FileTreeHeadless.Root, {
        fx,
        ariaLabel: 'Files',
        rowHeight: 20,
        overscan: 5,
        __testObserveElementRect: obs.observeElementRect,
        __testObserveElementOffset: obs.observeElementOffset,
      }),
    );
  });

  const tree = container.querySelector('[role="tree"]');
  assert.ok(tree, 'tree element must render');
  assert.equal(tree.getAttribute('aria-label'), 'Files');

  const items = container.querySelectorAll('[role="treeitem"]');
  assert.ok(items.length >= 1, 'should render at least one treeitem');
  for (const item of items) {
    // ARIA level is the core structural guarantee for headless.
    const level = Number(item.getAttribute('aria-level'));
    assert.ok(Number.isFinite(level) && level >= 1);
    // Class-name hook is present — consumers rely on this to target CSS.
    assert.ok(item.className.includes(milleClassNames.row));
  }

  await act(async () => {
    root.unmount();
  });
  container.remove();
});

// ─── Test 3: className catalog shape + values ──────────────────────

test('milleClassNames returns the concrete mille-* strings', () => {
  assert.equal(milleClassNames.tree, 'mille-tree');
  assert.equal(milleClassNames.row, 'mille-row');
  assert.equal(milleClassNames.rowName, 'mille-row-name');
  assert.equal(milleClassNames.contextMenuItem, 'mille-context-menu-item');
  assert.equal(milleClassNames.renameInput, 'mille-rename-input');
  assert.equal(milleClassNames.decorationBadge, 'mille-decoration-badge');
  assert.equal(milleClassNames.decorationLetter, 'mille-decoration-letter');
  assert.equal(milleClassNames.indentGuide, 'mille-indent-guide');
  assert.equal(milleClassNames.filter, 'mille-filter');
  assert.equal(milleClassNames.searchList, 'mille-search-list');
  // Frozen — mutations must not succeed.
  assert.ok(Object.isFrozen(milleClassNames));
  assert.throws(() => {
    // Writing to a frozen object throws in strict mode (ES modules are
    // strict by default), which is what we want.
    milleClassNames.tree = 'mutated';
  });
});

// ─── Test 4: hooks importable from /headless ───────────────────────

test('hooks exported from /headless are callable functions', async () => {
  assert.equal(typeof useFileTreeDragDrop, 'function');
  assert.equal(typeof useClipboardState, 'function');
  assert.equal(typeof useFileTreeSelection, 'function');
  assert.equal(typeof useFileTreeContext, 'function');
  // Provider + hooks carry the same implementations as the top-level
  // entry — verify by identity.
  const top = await import('../dist/index.js');
  assert.equal(top.useFileTreeSelection, useFileTreeSelection);
  assert.equal(top.useClipboardState, useClipboardState);
  assert.equal(top.useFileTreeDragDrop, useFileTreeDragDrop);
  assert.equal(top.FileTreeProvider, FileTreeProvider);
});

// ─── Test 5: DnD MIME constants + headless-specific re-exports ─────

test('DnD MIME constants are exported from /headless', () => {
  assert.equal(headless.MIME_URI_LIST, 'text/uri-list');
  assert.equal(
    headless.MIME_MILLE_ENTRIES,
    'application/x-mille-ui-entries',
  );
  assert.equal(
    headless.MIME_CLAUDE_ATTACHMENT,
    'application/vnd.claude.attachment',
  );
  assert.equal(headless.MIME_TEXT_PLAIN, 'text/plain');
});

// ─── Test 6: command registry surface ──────────────────────────────

test('command registry surface is exported from /headless', () => {
  assert.equal(typeof createCommandRegistry, 'function');
  assert.ok(Array.isArray(defaultCommands));
  assert.ok(
    defaultCommands.length > 0,
    'defaultCommands should be non-empty',
  );
  // Registry constructs and dispatches cleanly off the headless export.
  const registry = createCommandRegistry(defaultCommands);
  assert.equal(typeof registry.dispatch, 'function');
  assert.equal(typeof registry.all, 'function');
});
