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
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
let activeWorkspaceRoot = DEFAULT_WORKSPACE_ROOT;

// The currently-running utility process. Replaced on every workspace
// swap so the old root's watchers/walkers tear down cleanly.
let fxProcess: UtilityProcess | null = null;
let watchBenchController: WatchBenchController | null = null;

function forkFxProcess(root: string): UtilityProcess {
  const proc = utilityProcess.fork(join(__dirname, '../main/fx-host.mjs'), [], {
    serviceName: 'mille-file-explorer',
    stdio: 'pipe',
    env: {
      ...process.env,
      WORKSPACE_ROOT: root,
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
function openWorkspace(win: BrowserWindow, root: string): void {
  activeWorkspaceRoot = root;
  if (fxProcess !== null) {
    try {
      fxProcess.kill();
    } catch {
      /* already dead */
    }
    fxProcess = null;
  }
  const proc = forkFxProcess(root);
  fxProcess = proc;
  console.log(`[playground-main] forked fx-host for ${root}`);

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
    win.webContents.postMessage('fx-port', { workspaceRoot: root }, [port2]);
    console.log(`[playground-main] attach+port transferred for ${root}`);
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

  openWorkspace(win, DEFAULT_WORKSPACE_ROOT);

  if (watchBenchConfig !== null) {
    watchBenchController = new WatchBenchController(win, watchBenchConfig);
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

  ipcMain.handle('open-workspace', async (_evt, raw: unknown) => {
    if (typeof raw !== 'string' || raw.length === 0) {
      throw new Error('open-workspace: path must be a non-empty string');
    }
    // Light validation: exists + is a directory. Detailed path
    // canonicalization / workspace-root containment is the engine's
    // job; here we just reject the obvious mistakes.
    try {
      const st = statSync(raw);
      if (!st.isDirectory()) throw new Error('not a directory');
    } catch (e) {
      throw new Error(
        `open-workspace: cannot open "${raw}": ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    openWorkspace(win, raw);
  });

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
