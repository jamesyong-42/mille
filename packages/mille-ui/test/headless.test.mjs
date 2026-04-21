// `@vibecook/mille-ui/headless` entry point — smoke tests.
//
// v0.2 B8 contract: `/headless` ships the tree's **logic layer** only —
// no styled components, no Radix, no icon bundle. What it exports:
//
//   - Every pre-existing logic hook (selection, keyboard, clipboard,
//     dnd, etc.) plus the v0.2 B8 hooks split out of the heavy styled
//     components (`useFileTreeRow`, `useFileRenameInput`,
//     `useFileContextMenu`).
//   - The provider + command registry primitives + icon theme types.
//   - The `milleClassNames` catalog.
//
// What's **NOT** in `/headless`:
//   - The `FileTreeHeadless` namespace (removed — styled-component
//     re-exports blew the gzip budget; consumers import styled
//     components from the default entry `@vibecook/mille-ui`).
//   - `defaultCommands` / `treeDefaults` / `mutationDefaults` (moved
//     to `@vibecook/mille-ui/commands` — 16 KB raw is not a headless
//     concern).
//   - `FileIcon` (lives at `@vibecook/mille-ui/icons`).

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
  milleClassNames,
  createCommandRegistry,
  useFileTreeDragDrop,
  useClipboardState,
  useFileTreeSelection,
  FileTreeProvider,
  useFileTreeContext,
  // v0.2 B8 — logic hooks split out of the heavy styled components.
  useFileTreeRow,
  useFileRenameInput,
  useFileContextMenu,
} = headless;

// `defaultCommands` lives at `@vibecook/mille-ui/commands` post-B8 —
// the headless entry exports only the registry primitives.
const { defaultCommands } = await import('../dist/commands.js');

// The styled `FileTree` + siblings live at the default entry, not the
// headless entry. The ARIA / rendering smoke test below imports them
// from there; the v0.1 `FileTreeHeadless` namespace is gone.
const styled = await import('../dist/index.js');
const StyledFileTree = styled.FileTree;

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

// ─── Test 1: v0.2 B8 logic hooks are exported from /headless ──────

test('/headless exports the v0.2 B8 logic hooks', () => {
  assert.equal(typeof useFileTreeRow, 'function');
  assert.equal(typeof useFileRenameInput, 'function');
  assert.equal(typeof useFileContextMenu, 'function');
});

// ─── Test 2: styled tree (from default entry) still renders ARIA ──
//
// B8 moves the styled `FileTree` off the `/headless` entry but keeps
// it reachable from the default `@vibecook/mille-ui` entry. This test
// still smoke-tests the render path, via that default entry, to lock
// in the "public API of the styled entry is unchanged" hard constraint.

test('styled FileTree from default entry renders DOM + ARIA', async () => {
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
      createElement(StyledFileTree, {
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

// ─── Test 6: command registry primitives exported from /headless ──

test('command registry primitives are exported from /headless', () => {
  assert.equal(typeof createCommandRegistry, 'function');
  // `defaultCommands` no longer ships from `/headless` post-B8 — it
  // moved to `/commands`. The registry primitives themselves stay put
  // and compose cleanly with the command set from its own entry.
  assert.ok(Array.isArray(defaultCommands));
  assert.ok(
    defaultCommands.length > 0,
    'defaultCommands (imported from /commands) should be non-empty',
  );
  const registry = createCommandRegistry(defaultCommands);
  assert.equal(typeof registry.dispatch, 'function');
  assert.equal(typeof registry.all, 'function');
});

// ─── Test 7: styled-component re-exports are NOT in /headless ─────
//
// B8 hard-removes the `FileTreeHeadless` namespace and the individual
// styled-component re-exports (`FileTree`, `FileTreeRow`, etc.) from
// the headless entry. Consumers who want them import from the default
// entry — this test locks in the removal so a future re-add would
// flag as a regression against the 12 KB gzip budget.
test('styled-component re-exports are absent from /headless', () => {
  assert.equal(headless.FileTreeHeadless, undefined);
  assert.equal(headless.FileTree, undefined);
  assert.equal(headless.FileTreeRow, undefined);
  assert.equal(headless.FileRenameInput, undefined);
  assert.equal(headless.FileContextMenu, undefined);
  assert.equal(headless.FileIcon, undefined);
});
