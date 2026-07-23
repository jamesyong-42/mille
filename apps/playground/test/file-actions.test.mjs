import { strict as assert } from 'node:assert';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';

import {
  performPlaygroundFileAction,
  resolvePlaygroundFileAction,
  terminalLaunchSpec,
} from '../scripts/file-actions.mjs';

const workspaceRoot = resolve('workspace');

function request(action, rootRelativePath = 'src/index.ts') {
  return { action, workspaceRoot, rootRelativePath };
}

function dependencies() {
  const calls = [];
  return {
    calls,
    value: {
      activeWorkspaceRoot: workspaceRoot,
      writeClipboard: (value) => calls.push(['clipboard', value]),
      revealInFileManager: (path) => calls.push(['reveal', path]),
      isDirectory: (path) => !path.endsWith('.ts'),
      openPath: async (path) => calls.push(['openPath', path]),
      openTerminal: async (path) => calls.push(['terminal', path]),
    },
  };
}

test('file action resolution is workspace-contained and root-relative', () => {
  assert.deepEqual(resolvePlaygroundFileAction(request('copyAbsolutePath'), workspaceRoot), {
    action: 'copyAbsolutePath',
    absolutePath: resolve(workspaceRoot, 'src', 'index.ts'),
    relativePath: 'src/index.ts',
  });
  assert.equal(
    resolvePlaygroundFileAction(request('copyRelativePath', ''), workspaceRoot).relativePath,
    '.',
  );
  assert.throws(
    () => resolvePlaygroundFileAction(request('copyAbsolutePath', '../escape'), workspaceRoot),
    /stay below/,
  );
  assert.throws(
    () => resolvePlaygroundFileAction(request('copyAbsolutePath', '/escape'), workspaceRoot),
    /stay below/,
  );
  assert.throws(
    () => resolvePlaygroundFileAction(request('copyAbsolutePath', 'src//escape'), workspaceRoot),
    /stay below/,
  );
  assert.throws(
    () => resolvePlaygroundFileAction(request('copyAbsolutePath', 'src/./escape'), workspaceRoot),
    /stay below/,
  );
  assert.throws(
    () =>
      resolvePlaygroundFileAction(
        { ...request('copyAbsolutePath'), workspaceRoot: resolve('stale') },
        workspaceRoot,
      ),
    /active workspace/,
  );
  assert.throws(
    () => resolvePlaygroundFileAction(request('unknown'), workspaceRoot),
    /unsupported/,
  );
  assert.throws(() => resolvePlaygroundFileAction(null, workspaceRoot), /must be an object/);
  assert.equal(
    resolvePlaygroundFileAction(request('copyRelativePath', 'src\\index.ts'), workspaceRoot)
      .relativePath,
    'src/index.ts',
  );
});

test('copy and reveal actions call only their narrow host capability', async () => {
  const deps = dependencies();
  await performPlaygroundFileAction(request('copyAbsolutePath'), deps.value);
  await performPlaygroundFileAction(request('copyRelativePath'), deps.value);
  await performPlaygroundFileAction(request('revealInFileManager'), deps.value);
  assert.deepEqual(deps.calls, [
    ['clipboard', resolve(workspaceRoot, 'src', 'index.ts')],
    ['clipboard', 'src/index.ts'],
    ['reveal', resolve(workspaceRoot, 'src', 'index.ts')],
  ]);
});

test('containing-folder and terminal actions resolve file versus directory targets', async () => {
  const deps = dependencies();
  await performPlaygroundFileAction(request('openContainingFolder'), deps.value);
  await performPlaygroundFileAction(request('openTerminal', 'src'), deps.value);
  assert.deepEqual(deps.calls, [
    ['openPath', dirname(resolve(workspaceRoot, 'src', 'index.ts'))],
    ['terminal', resolve(workspaceRoot, 'src')],
  ]);
});

test('terminal launch specs are explicit for macOS, Windows, and Linux', () => {
  assert.deepEqual(terminalLaunchSpec('darwin', '/workspace/src'), {
    command: 'open',
    args: ['-a', 'Terminal', '/workspace/src'],
    cwd: '/workspace/src',
  });
  assert.deepEqual(terminalLaunchSpec('win32', 'C:\\workspace\\src'), {
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', 'start', '', 'cmd.exe'],
    cwd: 'C:\\workspace\\src',
  });
  assert.deepEqual(terminalLaunchSpec('linux', '/workspace/src', { TERMINAL: 'kitty' }), {
    command: 'kitty',
    args: [],
    cwd: '/workspace/src',
  });
  assert.equal(terminalLaunchSpec('linux', '/workspace/src', {}).command, 'x-terminal-emulator');
});
