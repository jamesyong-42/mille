import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  MessageChannelMain,
  shell,
  utilityProcess,
  type UtilityProcess,
} from 'electron';
import { dirname, join, resolve as pathResolve } from 'node:path';
import { resolveTrustedRoot } from '../../scripts/workspace-roots.mjs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { cwd } from 'node:process';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

import { WatchBenchController, watchBenchConfigFromEnvironment } from './watch-bench-controller';
import type { WatchBenchObservation } from '../shared/watch-bench';
import {
  createNavigationStateStore,
  type NavigationStateStore,
} from '../../scripts/navigation-state-store.mjs';
import { performPlaygroundFileAction, terminalLaunchSpec } from '../../scripts/file-actions.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// v0.2 B7 — recent folders persistence.
//
// The last ~10 pick-and-open paths are persisted to a small JSON file
// in `app.getPath('userData')`. On every successful `openWorkspace`
// the path is prepended (dedup by equality) and the list is capped.
// The renderer reads it via `ipcMain.handle('get-recent-folders')` to
// populate the toolbar dropdown.
//
// Resolved lazily in `app.whenReady()` — `app.getPath('userData')`
// throws if called before then.
const RECENT_FOLDERS_MAX = 10;
let recentFoldersPath: string | null = null;
let navigationStateStore: NavigationStateStore | null = null;

function loadRecentFolders(): string[] {
  if (recentFoldersPath === null) return [];
  try {
    const raw = readFileSync(recentFoldersPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p): p is string => typeof p === 'string');
  } catch {
    // Missing file, bad JSON, permissions — treat as empty.
    return [];
  }
}

function saveRecentFolders(list: readonly string[]): void {
  if (recentFoldersPath === null) return;
  try {
    writeFileSync(recentFoldersPath, JSON.stringify(list, null, 2), 'utf8');
  } catch {
    // Disk full, permissions — non-fatal; recents are a convenience.
  }
}

/**
 * Prepend `path` to the persisted recents list, dedup by equality,
 * cap at `RECENT_FOLDERS_MAX`. Called from `openWorkspace` so both
 * the initial boot and picker-driven swaps bump the list.
 */
function recordRecentFolder(path: string): void {
  const current = loadRecentFolders();
  const deduped = current.filter((p) => p !== path);
  deduped.unshift(path);
  if (deduped.length > RECENT_FOLDERS_MAX) {
    deduped.length = RECENT_FOLDERS_MAX;
  }
  saveRecentFolders(deduped);
}

// Default to `cwd()` — under `pnpm --filter playground dev` this is
// the monorepo root, which populates in ~1s. A typical macOS $HOME
// (node_modules / caches / Library) walks for tens of seconds and
// looks identical to a stuck handshake; pick-and-open a specific
// folder via the toolbar to explore anywhere else.
const DEFAULT_WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ?? cwd();
// Phase 5.3 multi-root: the workspace is a list. `activeWorkspaceRoot` stays
// as the primary (first) root for the single-root paths — watch bench, demo
// diagnostics seeds — while SCM and git status accept any open root.
let activeWorkspaceRoots: string[] = [DEFAULT_WORKSPACE_ROOT];
let activeWorkspaceRoot = DEFAULT_WORKSPACE_ROOT;

// The currently-running utility process. Replaced on every workspace
// swap so the old root's watchers/walkers tear down cleanly.
let fxProcess: UtilityProcess | null = null;
let watchBenchController: WatchBenchController | null = null;

function forkFxProcess(roots: readonly string[]): UtilityProcess {
  const proc = utilityProcess.fork(join(__dirname, '../main/fx-host.mjs'), [], {
    serviceName: 'mille-file-explorer',
    stdio: 'pipe',
    env: {
      ...process.env,
      // WORKSPACE_ROOT stays the primary root so single-root consumers
      // (watch bench harness) keep working; WORKSPACE_ROOTS carries the set.
      WORKSPACE_ROOT: roots[0] ?? DEFAULT_WORKSPACE_ROOT,
      WORKSPACE_ROOTS: JSON.stringify(roots),
    },
  });
  proc.stdout?.on('data', (d) => process.stdout.write(`[fx-host] ${d}`));
  proc.stderr?.on('data', (d) => process.stderr.write(`[fx-host] ${d}`));
  proc.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`[playground] fx utility exited with code ${code}`);
    }
  });
  return proc;
}

/**
 * Start (or restart) the fx utility against `root` and transfer a
 * fresh MessagePort to the renderer. The old utility is killed first
 * so its watchers release. Called at startup and on every workspace
 * change from the toolbar.
 *
 * We wait for the utility's `ready` message before transferring the
 * port — otherwise Node's parent-channel delivery can drop a
 * transferred MessagePort when the listener isn't registered yet.
 * First boot happened to dodge this via `await loadURL`; picker-driven
 * respawns don't have that incidental delay, so an explicit handshake
 * is the fix.
 */
function openWorkspace(win: BrowserWindow, roots: readonly string[]): void {
  const list = roots.length > 0 ? [...roots] : [DEFAULT_WORKSPACE_ROOT];
  activeWorkspaceRoots = list;
  activeWorkspaceRoot = list[0]!;
  const root = activeWorkspaceRoot;
  if (fxProcess !== null) {
    try {
      fxProcess.kill();
    } catch {
      /* already dead */
    }
    fxProcess = null;
  }
  const proc = forkFxProcess(list);
  fxProcess = proc;
  console.log(`[playground-main] forked fx-host for ${list.join(', ')}`);

  // v0.2 B7 — bump the recents list. The fx utility may still fail
  // (e.g. path vanished between the picker close and walker start)
  // but the path has already passed `statSync` validation in the
  // IPC handler for picker-driven opens. For the DEFAULT_WORKSPACE_ROOT
  // boot path we accept the small risk of recording a bad entry — the
  // loader tolerates missing paths by simply failing to walk them.
  recordRecentFolder(root);

  const onMessage = (msg: unknown): void => {
    const m = msg as { type?: string } | undefined;
    if (m?.type !== 'ready') return;
    proc.off('message', onMessage);
    if (proc !== fxProcess) return; // superseded by a newer respawn
    const { port1, port2 } = new MessageChannelMain();
    proc.postMessage({ type: 'attach' }, [port1]);
    win.webContents.postMessage(
      'fx-port',
      { workspaceRoot: root, workspaceRoots: list },
      [port2],
    );
    console.log(
      `[playground-main] attach+port transferred for ${list.join(', ')}`,
    );
  };
  proc.on('message', onMessage);
}

async function openTerminal(directory: string): Promise<void> {
  const spec = terminalLaunchSpec(process.platform, directory, process.env);
  await new Promise<void>((resolveLaunch, rejectLaunch) => {
    const child = spawn(spec.command, [...spec.args], {
      cwd: spec.cwd,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.once('error', rejectLaunch);
    child.once('spawn', () => {
      child.unref();
      resolveLaunch();
    });
  });
}

/**
 * Phase 6.3 — run axe-core against the live renderer and exit on violations.
 *
 * happy-dom cannot host axe (it has no layout, so contrast and visibility
 * rules are meaningless there), which is why the unit suite hand-rolls the
 * ARIA tree pattern instead. This is the other half: a real Chromium, real
 * styles, real computed colours. Enabled by `MILLE_AXE_REPORT`; see
 * `scripts/axe-check.mjs`.
 */
async function runAxeAudit(win: BrowserWindow, reportPath: string): Promise<void> {
  const exit = (code: number): void => {
    setTimeout(() => app.exit(code), 50);
  };
  try {
    const require = createRequire(import.meta.url);
    const axeSource = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
    await win.webContents.executeJavaScript(axeSource);

    const results = (await win.webContents.executeJavaScript(`(async () => {
      // Audit the painted tree, not the boot card: wait for real rows.
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        if (document.querySelector('[role="treeitem"]')) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      // Expand the root so chevrons, badges and nested rows are all audited.
      const first = document.querySelector('[role="treeitem"]');
      if (first) {
        first.click();
        first.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
        );
      }
      await new Promise((r) => setTimeout(r, 500));

      const options = {
        resultTypes: ['violations'],
        runOnly: {
          type: 'tag',
          values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'],
        },
      };
      // Both themes: contrast is a property of the palette in force, and the
      // light palette shipped a failing --jb-text-dim that a dark-only audit
      // could never see.
      const previous = document.documentElement.dataset.theme;
      const all = [];
      for (const theme of ['dark', 'light']) {
        document.documentElement.dataset.theme = theme;
        await new Promise((r) => setTimeout(r, 250));
        const run = await axe.run(document, options);
        for (const violation of run.violations) {
          all.push({ ...violation, theme });
        }
      }
      if (previous === undefined) delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = previous;
      return { violations: all };
    })()`)) as {
      violations: {
        id: string;
        impact: string;
        help: string;
        theme: string;
        nodes: unknown[];
      }[];
    };

    writeFileSync(reportPath, `${JSON.stringify(results, null, 2)}\n`);
    const { violations } = results;
    if (violations.length === 0) {
      console.log('[playground-axe] no WCAG A/AA violations');
      exit(0);
      return;
    }
    console.error(`[playground-axe] ${violations.length} violation(s):`);
    for (const violation of violations) {
      console.error(
        `  [${violation.impact}] ${violation.theme}: ${violation.id} — ` +
          `${violation.help} (${violation.nodes.length} node(s))`,
      );
    }
    console.error(`[playground-axe] report ${reportPath}`);
    exit(1);
  } catch (error) {
    console.error('[playground-axe] audit failed:', error);
    exit(1);
  }
}

async function createWindow(): Promise<void> {
  const watchBenchConfig = watchBenchConfigFromEnvironment();
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: false,
    },
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    await win.loadURL(process.env.ELECTRON_RENDERER_URL);
    if (watchBenchConfig === null) win.webContents.openDevTools({ mode: 'detach' });
  } else {
    await win.loadFile(join(__dirname, '../renderer/index.html'));
  }

  openWorkspace(win, [DEFAULT_WORKSPACE_ROOT]);

  if (watchBenchConfig !== null) {
    watchBenchController = new WatchBenchController(win, watchBenchConfig);
  }

  if (process.env.MILLE_AXE_REPORT) {
    void runAxeAudit(win, process.env.MILLE_AXE_REPORT);
  }

  ipcMain.handle('watch-bench:get-config', () => watchBenchConfig);
  ipcMain.on('watch-bench:ready', (event) => {
    if (event.sender !== win.webContents) return;
    watchBenchController?.start();
  });
  ipcMain.on('watch-bench:observed', (event, raw: unknown) => {
    if (event.sender !== win.webContents || watchBenchController === null) return;
    const observation = raw as Partial<WatchBenchObservation>;
    if (
      typeof observation.id !== 'number' ||
      typeof observation.kind !== 'string' ||
      typeof observation.treeVersion !== 'number' ||
      typeof observation.mirrorLatencyMs !== 'number' ||
      typeof observation.commitLatencyMs !== 'number' ||
      typeof observation.reactDurationMs !== 'number' ||
      typeof observation.reactBaseDurationMs !== 'number' ||
      typeof observation.paintLatencyMs !== 'number' ||
      typeof observation.commitToPaintMs !== 'number' ||
      typeof observation.frameIntervalMs !== 'number' ||
      typeof observation.observedAt !== 'number'
    ) {
      return;
    }
    watchBenchController.observe(observation as WatchBenchObservation);
  });

  // Pick-and-open flow: renderer button → `pick-workspace` returns a
  // path (or null if cancelled) → renderer calls `open-workspace`
  // which tears down the old utility and starts a fresh one. Both
  // handlers bind against this window's webContents.
  ipcMain.handle('pick-workspace', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: 'Open folder',
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  // Light validation: exists + is a directory. Detailed path
  // canonicalization / workspace-root containment is the engine's
  // job; here we just reject the obvious mistakes.
  function assertDirectory(raw: unknown, label: string): string {
    if (typeof raw !== 'string' || raw.length === 0) {
      throw new Error(`${label}: path must be a non-empty string`);
    }
    try {
      const st = statSync(raw);
      if (!st.isDirectory()) throw new Error('not a directory');
    } catch (e) {
      throw new Error(
        `${label}: cannot open "${raw}": ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    return raw;
  }

  ipcMain.handle('open-workspace', async (_evt, raw: unknown) => {
    openWorkspace(win, [assertDirectory(raw, 'open-workspace')]);
  });

  /**
   * Phase 5.3 multi-root — append a second (third, …) root instead of
   * replacing the workspace, so multi-root SCM has something to act on.
   * Returns the resulting root list.
   */
  ipcMain.handle('add-workspace-folder', async (_evt, raw: unknown) => {
    const added = assertDirectory(raw, 'add-workspace-folder');
    const resolved = pathResolve(added);
    if (activeWorkspaceRoots.some((r) => pathResolve(r) === resolved)) {
      return [...activeWorkspaceRoots]; // already open — no respawn
    }
    openWorkspace(win, [...activeWorkspaceRoots, added]);
    return [...activeWorkspaceRoots];
  });

  ipcMain.handle('get-workspace-roots', () => [...activeWorkspaceRoots]);

  // v0.2 B7 — renderer reads this to populate the toolbar dropdown.
  // Cheap enough to re-read from disk on every call; no cache layer.
  ipcMain.handle('get-recent-folders', () => loadRecentFolders());

  ipcMain.handle('get-file-tree-navigation-state', (_evt, root: unknown) => {
    if (typeof root !== 'string' || root.length === 0) return null;
    return navigationStateStore?.get(root) ?? null;
  });
  ipcMain.handle('save-file-tree-navigation-state', (_evt, root: unknown, state: unknown) => {
    if (typeof root !== 'string' || typeof state !== 'string') return false;
    return navigationStateStore?.set(root, state) ?? false;
  });

  ipcMain.handle('perform-file-action', async (_evt, request: unknown) => {
    return performPlaygroundFileAction(request, {
      activeWorkspaceRoot,
      writeClipboard: (value) => clipboard.writeText(value),
      revealInFileManager: (path) => shell.showItemInFolder(path),
      isDirectory: (path) => statSync(path).isDirectory(),
      openPath: async (path) => {
        const error = await shell.openPath(path);
        if (error.length > 0) throw new Error(error);
      },
      openTerminal,
    });
  });

  // Git decorations run in the fx utility process (they shell out to
  // `git`, which `node:child_process` can't do from the renderer).
  // Toolbar toggle → IPC → we forward to the current utility as a
  // `set-git-decorations` control message.
  ipcMain.handle('set-git-decorations', (_evt, enabled: unknown) => {
    const on = enabled === true;
    if (fxProcess === null) return;
    try {
      fxProcess.postMessage({ type: 'set-git-decorations', enabled: on });
    } catch (err) {
      console.warn('[playground-main] failed to forward git-decorations toggle:', err);
    }
  });

  // Security: never trust renderer-supplied rootPath. Only the active
  // workspace root is allowed; relative paths are containment-checked in
  // createShell* clients (history/SCM).
  function trustedWorkspaceRoot(requested: unknown): string {
    return resolveTrustedRoot(requested, activeWorkspaceRoots);
  }

  // Phase 5.2 — Changed Files view needs a one-shot status snapshot in the
  // renderer. Shell git stays in main (node:child_process); no watcher.
  ipcMain.handle('get-git-status', async (_evt, rawRoot: unknown) => {
    let root: string;
    try {
      root = trustedWorkspaceRoot(rawRoot);
    } catch (err) {
      console.warn('[playground-main] get-git-status rejected root:', err);
      return [];
    }
    try {
      const { createShellGitClient } = await import('@vibecook/mille-ui/git/node');
      const client = createShellGitClient({
        rootPath: root,
        disableWatcher: true,
        warn: (msg) => console.warn('[playground-main] git status:', msg),
      });
      try {
        const map = await client.getStatus(root);
        // Structured-clone friendly plain objects.
        return [...map.values()].map((e) => ({
          path: e.path,
          status: e.status,
          ...(e.staged === true ? { staged: true } : {}),
        }));
      } finally {
        // createShellGitClient may leave no-op watchers when disabled; best-effort dispose.
        const dispose = (client as { dispose?: () => void }).dispose;
        if (typeof dispose === 'function') dispose.call(client);
      }
    } catch (err) {
      console.warn('[playground-main] get-git-status failed:', err);
      return [];
    }
  });

  // Phase 5.3 — file history + SCM mutations (main process, shell git).

  ipcMain.handle('get-file-history', async (_evt, payload: unknown) => {
    const body = payload as { rootPath?: string; path?: string; limit?: number };
    let root: string;
    try {
      root = trustedWorkspaceRoot(body?.rootPath);
    } catch (err) {
      console.warn('[playground-main] get-file-history rejected root:', err);
      return [];
    }
    const rel = typeof body?.path === 'string' ? body.path : '';
    if (!rel) return [];
    try {
      const { createShellFileHistoryClient } = await import(
        '@vibecook/mille-ui/git/node'
      );
      const client = createShellFileHistoryClient({ rootPath: root });
      return await client.getHistory({
        path: rel,
        rootPath: root,
        limit: typeof body.limit === 'number' ? body.limit : 50,
      });
    } catch (err) {
      console.warn('[playground-main] get-file-history failed:', err);
      return [];
    }
  });

  ipcMain.handle('scm-compare', async (_evt, payload: unknown) => {
    const body = payload as {
      rootPath?: string;
      path?: string;
      left?: { kind: string; revision?: string };
      right?: { kind: string; revision?: string };
    };
    const root = trustedWorkspaceRoot(body?.rootPath);
    const rel = typeof body?.path === 'string' ? body.path : '';
    if (!rel) throw new Error('scm-compare: path required');
    const { createShellScmClient } = await import('@vibecook/mille-ui/git/node');
    const client = createShellScmClient({ rootPath: root });
    if (!client.compare) throw new Error('scm-compare: unsupported');
    const side = (s: { kind: string; revision?: string } | undefined) => {
      if (s?.kind === 'revision' && typeof s.revision === 'string') {
        return { kind: 'revision' as const, revision: s.revision };
      }
      return { kind: 'working' as const };
    };
    return client.compare({
      path: rel,
      rootPath: root,
      left: side(body.left),
      right: side(body.right),
    });
  });

  ipcMain.handle('scm-revert', async (_evt, payload: unknown) => {
    const body = payload as { rootPath?: string; paths?: string[] };
    const root = trustedWorkspaceRoot(body?.rootPath);
    const paths = Array.isArray(body?.paths)
      ? body.paths.filter((p): p is string => typeof p === 'string')
      : [];
    if (paths.length === 0) throw new Error('scm-revert: paths required');
    const { createShellScmClient } = await import('@vibecook/mille-ui/git/node');
    const client = createShellScmClient({ rootPath: root });
    if (!client.revert) throw new Error('scm-revert: unsupported');
    await client.revert(paths, { rootPath: root });
    return true;
  });
}

app.whenReady().then(() => {
  // v0.2 B7 — resolve userData path now that Electron is ready.
  recentFoldersPath = join(app.getPath('userData'), 'recent-folders.json');
  navigationStateStore = createNavigationStateStore({
    filePath: join(app.getPath('userData'), 'file-tree-navigation.json'),
  });
  return createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});

app.on('before-quit', () => {
  watchBenchController?.dispose();
  watchBenchController = null;
  if (fxProcess !== null) {
    try {
      fxProcess.kill();
    } catch {
      /* already dead */
    }
    fxProcess = null;
  }
});
