import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  MessageChannelMain,
  utilityProcess,
  type UtilityProcess,
} from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cwd } from 'node:process';
import { statSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Default to `cwd()` — under `pnpm --filter playground dev` this is
// the monorepo root, which populates in ~1s. A typical macOS $HOME
// (node_modules / caches / Library) walks for tens of seconds and
// looks identical to a stuck handshake; pick-and-open a specific
// folder via the toolbar to explore anywhere else.
const DEFAULT_WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ?? cwd();

// The currently-running utility process. Replaced on every workspace
// swap so the old root's watchers/walkers tear down cleanly.
let fxProcess: UtilityProcess | null = null;

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

async function createWindow(): Promise<void> {
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
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    await win.loadFile(join(__dirname, '../renderer/index.html'));
  }

  openWorkspace(win, DEFAULT_WORKSPACE_ROOT);

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
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});

app.on('before-quit', () => {
  if (fxProcess !== null) {
    try {
      fxProcess.kill();
    } catch {
      /* already dead */
    }
    fxProcess = null;
  }
});
