// Phase A1.7 — mille-ui integration test against a port-shaped engine.
//
// Proves that `registerAgentRulesDecorations` (and by extension the git
// companion) happily accepts a port-client-shaped object: `fx` only
// needs `registerDecorationProvider` + `getSnapshot`. The provider
// companion pushes a provider into the fake engine; the fake's
// scripted snapshot carries a decoration map so the FileTree renders
// the badge on the matching row.
//
// The fake engine's native shape already exposes `registerDecorationProvider`
// (Phase 10). The test wraps it in a second object `portClient` that
// only exposes the port-shaped surface (`registerDecorationProvider` +
// delegated snapshot / on / setExpanded / setViewport) so we exercise
// the A1.5/A1.6 widened `fx` type.

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

const { FileTree } = await import('../dist/index.js');
const { createFakeEngine } = await import('../dist/testing.js');
const { registerAgentRulesDecorations } = await import(
  '../dist/agent-rules.js'
);

/**
 * Wrap a FakeEngine in a port-client-shaped facade. Exposes only the
 * methods that `PortFileExplorer` surfaces (no `getByUri`) so the
 * companion's fallback path for port clients is exercised.
 */
function asPortClient(fake) {
  return {
    getSnapshot: () => fake.getSnapshot(),
    on: (event, listener) => fake.on(event, listener),
    setExpanded: (diff) => fake.setExpanded(diff),
    setViewport: (opts) => fake.setViewport(opts),
    registerDecorationProvider: (provider) => {
      // The fake's native `registerDecorationProvider` is the
      // Phase-10 in-process path. For this integration test we feed
      // the provider's `provide()` result directly into the fake's
      // scripted decoration store so the FileTree can see the badge
      // on the matching row. Mirrors the host-side "merge + publish"
      // outcome without running the real FileExplorerHost.
      const snap = fake.getSnapshot();
      const rows = snap.visibleRows({
        expanded: new Set(),
        offset: 0,
        limit: Number.MAX_SAFE_INTEGER,
      });
      const touched = [];
      for (const row of rows) {
        let decoration = null;
        try {
          const maybe = provider.provide(row);
          if (maybe !== null && typeof maybe !== 'object') continue;
          decoration = maybe;
        } catch {
          decoration = null;
        }
        if (decoration !== null) {
          fake.setDecorations(row.id, [decoration]);
          touched.push(row.id);
        }
      }
      if (touched.length > 0) fake.bumpDecorationVersion(touched);
      return {
        dispose: () => {
          for (const id of touched) fake.setDecorations(id, null);
          if (touched.length > 0) fake.bumpDecorationVersion(touched);
        },
      };
    },
  };
}

function makeRow(init) {
  return {
    id: init.id,
    parentId: init.parentId ?? null,
    name: init.name,
    kind: init.kind ?? 0,
    size: 0,
    mtimeMs: 0,
    ctimeMs: 0,
    isIgnored: false,
    isReadonly: false,
    isHidden: false,
    depth: init.depth ?? 0,
    hasChildren: init.hasChildren ?? false,
    isExpanded: init.isExpanded ?? false,
  };
}

test('port-client: agent-rules decoration lands on a matching row', async () => {
  const fake = createFakeEngine();
  const portClient = asPortClient(fake);

  // Seed a row with the CLAUDE.md agent-rules pattern. The
  // matcher's default set matches on `/CLAUDE.md` so the leaf name
  // alone is enough to produce a badge via the provider's built-in
  // `/${entry.name}` fallback.
  const claudeRow = makeRow({ id: 1, name: 'CLAUDE.md', depth: 0 });
  const otherRow = makeRow({ id: 2, name: 'README.md', depth: 0 });
  fake.emitDelta({
    treeVersion: 1,
    rows: [claudeRow, otherRow],
    roots: [claudeRow, otherRow],
  });

  // Register the provider. The portClient facade pushes the provider
  // result into the fake's decoration store (mirroring what the real
  // host would do via the `decorations` frame + fan-out).
  const handle = registerAgentRulesDecorations({
    fx: portClient,
    rootPath: '/ROOT',
  });

  // Assert: the fake's snapshot now carries a decoration for the
  // CLAUDE.md row, and not for the README row.
  const afterSnap = fake.getSnapshot();
  const claudeDec = afterSnap.getDecorations(1);
  assert.equal(claudeDec.length, 1, 'CLAUDE.md has one decoration');
  assert.ok(typeof claudeDec[0].badge === 'string' && claudeDec[0].badge.length > 0,
    'decoration has a badge string');

  const readmeDec = afterSnap.getDecorations(2);
  assert.equal(readmeDec.length, 0, 'README.md has no decoration');

  // Render the FileTree so we prove the whole read path works
  // against the port-shaped fx. Virtualization in happy-dom has
  // quirks around layout measurement, so we only assert mount
  // succeeds without throwing — the decoration assertions above are
  // the primary contract this test guards.
  const root = createRoot(hdDocument.body);
  try {
    await act(async () => {
      root.render(createElement(FileTree, { fx: portClient }));
    });
    // Sanity: FileTree mounted some DOM (the virtualizer container).
    assert.ok(
      hdDocument.body.querySelector('[role="tree"], [role="grid"], div') !== null,
      'FileTree rendered at least one element against the port-shaped fx',
    );
  } finally {
    await act(async () => {
      root.unmount();
    });
    handle.dispose();
  }
});
