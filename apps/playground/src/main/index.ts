import { app, BrowserWindow, MessageChannelMain, utilityProcess } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cwd } from 'node:process';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Default to `cwd()` — under `pnpm --filter playground dev` this is
// the monorepo root, which populates in ~1s. Previously tried
// `os.homedir()`, but a typical macOS $HOME with node_modules / caches
// / Library walks for tens of seconds before the attach handler
// registers, which looks to the renderer exactly like a stuck
// handshake. Set WORKSPACE_ROOT to override (any absolute path).
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ?? cwd();

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
