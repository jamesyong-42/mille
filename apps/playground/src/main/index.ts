import { app, BrowserWindow, MessageChannelMain, utilityProcess } from 'electron';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cwd } from 'node:process';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Phase 15.3 — default to the user's home when no override is set.
// Rationale: the playground exists to demonstrate a realistic
// workspace, and `cwd()` under `pnpm dev` resolves to the monorepo
// root which is useful for dogfooding but noisy for demo screenshots.
// macOS / Linux: `$HOME`; Windows: `%USERPROFILE%` (both resolved by
// `os.homedir()` with the same semantics as the plan).
const WORKSPACE_ROOT =
  process.env.WORKSPACE_ROOT ?? homedir() ?? cwd();

async function createWindow(): Promise<void> {
  const fxProcess = utilityProcess.fork(join(__dirname, '../main/fx-host.mjs'), [], {
    serviceName: 'mille-file-explorer',
    stdio: 'pipe',
    env: {
      ...process.env,
      WORKSPACE_ROOT,
    },
  });
  fxProcess.stdout?.on('data', (d) => process.stdout.write(`[fx-host] ${d}`));
  fxProcess.stderr?.on('data', (d) => process.stderr.write(`[fx-host] ${d}`));
  fxProcess.on('exit', (code) => {
    if (code !== 0) console.error(`[playground] fx utility exited with code ${code}`);
  });

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

  const { port1, port2 } = new MessageChannelMain();
  fxProcess.postMessage({ type: 'attach' }, [port1]);
  win.webContents.postMessage('fx-port', { workspaceRoot: WORKSPACE_ROOT }, [port2]);
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});
