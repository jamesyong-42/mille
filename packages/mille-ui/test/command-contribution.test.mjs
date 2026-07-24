// Phase 5.4 — command contribution contract tests.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

const {
  createCommandRegistry,
  contributeCommands,
  dispatchWithLifecycle,
  evaluateEnablement,
  partitionCommandsForMenu,
  buildCommandContext,
  evaluateWhen,
} = await import('../dist/commands.js');

function fakeCtx(overrides = {}) {
  return buildCommandContext(
    {
      fx: {},
      snapshot: { getById: () => null },
      focusedId: null,
      focusedEntry: null,
      selectedIds: new Set(),
      selectedEntries: [],
      isMultiSelect: false,
      isRenaming: false,
      host: {},
      cutIds: new Set(),
      copyIds: new Set(),
      ...overrides,
    },
    overrides.contribution,
  );
}

test('contributeCommands registers and disposes commands', () => {
  const registry = createCommandRegistry([]);
  const ran = [];
  const handle = contributeCommands(registry, {
    id: 'host.demo',
    commands: [
      {
        id: 'host.hello',
        label: 'Hello',
        group: '9_custom',
        run: () => {
          ran.push('hello');
        },
      },
    ],
  });
  assert.ok(registry.get('host.hello'));
  assert.deepEqual(handle.commandIds, ['host.hello']);

  registry.setContextProvider(() => fakeCtx());
  registry.dispatch('host.hello');
  assert.deepEqual(ran, ['hello']);

  handle.dispose();
  assert.equal(registry.get('host.hello'), undefined);
});

test('contributeCommands menu placement overrides group and submenu', () => {
  const registry = createCommandRegistry([
    {
      id: 'host.x',
      label: 'X',
      group: '1_nav',
      run: () => {},
    },
  ]);
  contributeCommands(registry, {
    id: 'host.place',
    commands: [],
    menus: {
      context: [
        {
          command: 'host.x',
          group: '5_scm',
          submenu: 'history',
          submenuLabel: 'History',
          order: 5,
        },
      ],
    },
  });
  const cmd = registry.get('host.x');
  assert.equal(cmd.group, '5_scm');
  assert.equal(cmd.submenu, 'history');
  assert.equal(cmd.submenuLabel, 'History');
  assert.equal(cmd.order, 5);
});

test('evaluateEnablement defaults true and respects when-language', () => {
  const ctxFile = fakeCtx({
    focusedEntry: { kind: 0, id: 1, name: 'a.ts', parentId: 0 },
    focusedId: 1,
  });
  // focusedIs.file needs proper entry shape - evaluateWhen uses focusedEntry
  const enabled = evaluateEnablement(
    { id: 'x', label: 'x', enablement: 'focusedIs.file', run: () => {} },
    {
      ...ctxFile,
      focusedEntry: {
        id: 1,
        parentId: null,
        name: 'a.ts',
        kind: 0,
        size: 0,
        mtimeMs: 0,
        ctimeMs: 0,
        isIgnored: false,
        isReadonly: false,
        isHidden: false,
      },
    },
  );
  assert.equal(enabled, true);

  const disabled = evaluateEnablement(
    { id: 'x', label: 'x', enablement: 'focusedIs.folder', run: () => {} },
    {
      ...ctxFile,
      focusedEntry: {
        id: 1,
        parentId: null,
        name: 'a.ts',
        kind: 0,
        size: 0,
        mtimeMs: 0,
        ctimeMs: 0,
        isIgnored: false,
        isReadonly: false,
        isHidden: false,
      },
    },
  );
  assert.equal(disabled, false);
});

test('partitionCommandsForMenu nests submenus', () => {
  const groups = partitionCommandsForMenu([
    {
      id: 'scm.compareWithHead',
      label: 'HEAD',
      group: '5_scm',
      submenu: 'compare',
      submenuLabel: 'Compare',
      order: 1,
      run: () => {},
    },
    {
      id: 'scm.revert',
      label: 'Revert',
      group: '5_scm',
      order: 2,
      run: () => {},
    },
    {
      id: 'scm.compareWithPrevious',
      label: 'Previous',
      group: '5_scm',
      submenu: 'compare',
      order: 0,
      run: () => {},
    },
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].items.length, 1);
  assert.equal(groups[0].items[0].id, 'scm.revert');
  assert.equal(groups[0].submenus.length, 1);
  assert.equal(groups[0].submenus[0].label, 'Compare');
  assert.deepEqual(
    groups[0].submenus[0].items.map((c) => c.id),
    ['scm.compareWithPrevious', 'scm.compareWithHead'],
  );
});

test('dispatchWithLifecycle reports progress and telemetry', async () => {
  const registry = createCommandRegistry([
    {
      id: 'host.work',
      label: 'Work',
      async run(ctx) {
        ctx.reportProgress?.({ phase: 'running', fraction: 0.5, message: 'halfway' });
        await Promise.resolve();
      },
    },
  ]);
  registry.setContextProvider(() => fakeCtx());

  const phases = [];
  const telemetry = [];
  await dispatchWithLifecycle(registry, 'host.work', {
    lifecycle: {
      onProgress: (e) => phases.push(e.phase),
      telemetry: (e) => telemetry.push(e.type),
    },
  });
  assert.ok(phases.includes('preparing'));
  assert.ok(phases.includes('running'));
  assert.ok(phases.includes('completed'));
  assert.deepEqual(telemetry, ['command.start', 'command.success']);
});

test('dispatchWithLifecycle notifies on failure', async () => {
  const registry = createCommandRegistry([
    {
      id: 'host.fail',
      label: 'Fail',
      run: async () => {
        throw new Error('boom');
      },
    },
  ]);
  registry.setContextProvider(() => fakeCtx());

  const notes = [];
  await assert.rejects(
    () =>
      dispatchWithLifecycle(registry, 'host.fail', {
        lifecycle: {
          onNotify: (level, message) => notes.push({ level, message }),
        },
      }),
    /boom/,
  );
  assert.equal(notes.length, 1);
  assert.equal(notes[0].level, 'error');
  assert.match(notes[0].message, /boom/);
});

test('dispatchWithLifecycle cancels on aborted signal', async () => {
  const registry = createCommandRegistry([
    {
      id: 'host.slow',
      label: 'Slow',
      run: async () => {
        await new Promise((r) => setTimeout(r, 50));
      },
    },
  ]);
  registry.setContextProvider(() => fakeCtx());
  const ac = new AbortController();
  ac.abort();
  const phases = [];
  await dispatchWithLifecycle(registry, 'host.slow', {
    signal: ac.signal,
    lifecycle: { onProgress: (e) => phases.push(e.phase) },
  });
  assert.ok(phases.includes('cancelled'));
  assert.ok(!phases.includes('completed'));
});

test('buildCommandContext attaches IDE surfaces', () => {
  const ctx = buildCommandContext(
    {
      fx: {},
      snapshot: { getById: () => null },
      focusedId: null,
      focusedEntry: null,
      selectedIds: new Set(),
      selectedEntries: [],
      isMultiSelect: false,
      isRenaming: false,
      host: {},
      cutIds: new Set(),
      copyIds: new Set(),
    },
    {
      workspaceRoot: '/ws',
      editor: { activePath: 'a.ts', dirtyPaths: ['a.ts'] },
      scm: { changedPaths: ['b.ts'] },
      diagnostics: { problemPaths: ['c.ts'] },
    },
  );
  assert.equal(ctx.workspaceRoot, '/ws');
  assert.equal(ctx.editor?.activePath, 'a.ts');
  assert.deepEqual(ctx.scm?.changedPaths, ['b.ts']);
  assert.deepEqual(ctx.diagnostics?.problemPaths, ['c.ts']);
});

// silence unused import when evaluateWhen not needed
void evaluateWhen;
