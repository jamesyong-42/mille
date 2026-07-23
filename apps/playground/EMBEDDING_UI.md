# Embedding `@vibecook/mille-ui` in an Electron app

This guide walks through the full stack the `apps/playground` example demonstrates:

- `@vibecook/mille` runs in an Electron **UtilityProcess** (native
  file-system walker, watcher, ignore-parser — everything in Rust).
- A **MessagePort** bridges the UtilityProcess to the renderer.
- `@vibecook/mille-ui` runs in the **renderer**: `FileTreeProvider` +
  `FileTree` + icon theme + optional decoration providers.

Companion to `@vibecook/mille`'s own `EMBEDDING.md` — that doc covers
the engine transport; this one covers the UI layer on top.

## 1. Architecture

```
┌─────────────────────────┐                    ┌─────────────────────────┐
│       main process      │                    │     UtilityProcess       │
│                         │    MessageChannel   │                         │
│  createWindow()         │ ─────── port1 ────► │  fx-host.ts              │
│  utilityProcess.fork()  │                    │    createFileExplorer    │
│  postMessage([port2])   │                    │    Host(...)              │
│                         │                    │    host.attachPort(port1) │
└────────────┬────────────┘                    └─────────────────────────┘
             │
             │ webContents.postMessage('fx-port', _, [port2])
             ▼
┌─────────────────────────┐
│       renderer          │
│                         │
│  preload forwards port  │
│  connectFileExplorer(p) │
│    → PortFileExplorer   │
│                         │
│  <FileTreeProvider      │
│     fx={fx}>            │
│    <FileTree ... />     │
│  </FileTreeProvider>    │
└─────────────────────────┘
```

Key invariants:

- The renderer never touches `node:fs` — everything flows through the port.
- The `PortFileExplorer` implements the `FileExplorer`-shaped surface
  `mille-ui` needs (snapshots, `setExpanded`, mutations).
- Snapshot identity is stable between deltas so React 19's
  `useSyncExternalStore` sees `===`-equal references and skips renders.

## 2. Step-by-step integration

### 2.1 Install deps

```bash
pnpm add @vibecook/mille @vibecook/mille-ui
pnpm add @tanstack/react-virtual \
         @radix-ui/react-context-menu \
         @radix-ui/react-dialog \
         @radix-ui/react-tooltip
pnpm add -D react@^19.2 react-dom@^19.2 electron electron-vite vite
```

Radix deps are **optional peers** — only required when you use the
context menu / rename tooltip / dialog-hosted flows. If you use the
headless entry (`@vibecook/mille-ui/headless`), you can skip them.

### 2.2 Main process — fork the UtilityProcess, transfer the port

```ts
// src/main/index.ts
import { app, BrowserWindow, MessageChannelMain, utilityProcess } from 'electron';
import { homedir } from 'node:os';
import { join } from 'node:path';

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ?? homedir();

async function createWindow() {
  const fxProcess = utilityProcess.fork(join(__dirname, '../main/fx-host.mjs'), [], {
    serviceName: 'mille-file-explorer',
    env: { ...process.env, WORKSPACE_ROOT },
  });

  const win = new BrowserWindow({
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: false,
    },
  });
  await win.loadURL(process.env.ELECTRON_RENDERER_URL ?? 'file://…');

  const { port1, port2 } = new MessageChannelMain();
  fxProcess.postMessage({ type: 'attach' }, [port1]);
  win.webContents.postMessage('fx-port', { workspaceRoot: WORKSPACE_ROOT }, [port2]);
}

app.whenReady().then(createWindow);
```

### 2.3 UtilityProcess — attach the engine

```ts
// src/utility/fx-host.ts
import { createFileExplorerHost } from '@vibecook/mille/host';

const host = await createFileExplorerHost({
  roots: [process.env.WORKSPACE_ROOT!],
  respectIgnore: true,
  followSymlinks: 'smart',
  watchDebounceMs: 75,
});

await host.local.populateFromRoots();

process.parentPort.on('message', (evt) => {
  const port = evt.ports[0];
  if (evt.data?.type === 'attach' && port) {
    host.attachPort(wrapMessagePortMain(port));
  }
});
```

See `src/utility/fx-host.ts` for the full `wrapMessagePortMain` adapter
— Electron's `MessagePortMain` has a slightly different event shape
than Node's `worker_threads` port, and the wrapper normalizes both.

### 2.4 Preload — forward the port to the renderer

```ts
// src/preload/index.ts
import { ipcRenderer } from 'electron';

ipcRenderer.on('fx-port', (event, payload) => {
  window.postMessage(
    { type: 'fx-port', workspaceRoot: payload.workspaceRoot },
    '*',
    event.ports as unknown as Transferable[],
  );
});
```

MessagePort can't pass through `contextBridge` (prototype is stripped).
Forwarding through `window.postMessage` keeps the port object intact.

### 2.5 Renderer — connect + render

```tsx
// src/renderer/src/App.tsx
import { useEffect, useMemo, useState } from 'react';
import { FileTreeProvider, FileTree } from '@vibecook/mille-ui';
import { defaultIconTheme } from '@vibecook/mille-ui/icons';
import { createCommandRegistry, defaultCommands } from '@vibecook/mille-ui/commands';
import { connectFileExplorer } from '@vibecook/mille/port';
import type { FileExplorer } from '@vibecook/mille';

export function App() {
  const [fx, setFx] = useState<FileExplorer | null>(null);

  useEffect(() => {
    let disposed = false;
    (async () => {
      const { port } = await fxPortReady; // see fx-port.ts
      const client = await connectFileExplorer(port, { mirrorCap: 20_000 });
      if (!disposed) setFx(client as unknown as FileExplorer);
    })();
    return () => {
      disposed = true;
    };
  }, []);

  const commands = useMemo(() => createCommandRegistry(defaultCommands), []);
  if (!fx) return <div>Connecting…</div>;

  return (
    <FileTreeProvider fx={fx} commands={commands}>
      <FileTree ariaLabel="Workspace files" iconTheme={defaultIconTheme} showFilter />
    </FileTreeProvider>
  );
}
```

Import the tokens stylesheet **once** at your renderer entry so the
CSS-variable surface is available everywhere:

```ts
// src/renderer/src/main.tsx
import '@vibecook/mille-ui/tokens.css';
```

The `fx-port.ts` helper (see playground source) subscribes to
`window.postMessage` synchronously at module load so the port is never
lost between the preload's send and React's first `useEffect`.

## 3. Keyboard reference

Full listing in the engine UI spec — `MILLE_UI_SPEC.md` §6.1.
Short summary:

| Key             | Action                       |
| --------------- | ---------------------------- |
| ↑ / ↓           | Move focus                   |
| → / ←           | Expand / collapse folder     |
| Enter           | Open file                    |
| Space           | Toggle selection             |
| Shift + ↑ / ↓   | Range select                 |
| Mod + A         | Select all                   |
| Mod + C / X / V | Copy / cut / paste           |
| F2              | Rename                       |
| Delete          | Delete                       |
| Mod + F         | Focus filter                 |
| Mod + N         | New file in focused folder   |
| Mod + Shift + N | New folder                   |
| Esc             | Clear selection / close menu |

## 4. Icon themes

Default theme (~4 KB, Codicons-derived) ships inline:

```tsx
import { defaultIconTheme } from '@vibecook/mille-ui/icons';
<FileTree iconTheme={defaultIconTheme} ... />
```

For custom themes, the loader consumes VS Code's File Icon Theme JSON
schema:

```ts
import { loadIconTheme } from '@vibecook/mille-ui/icons';

const theme = await loadIconTheme({
  url: '/icons/material/icon-theme.json',
  appearance: 'auto', // watches prefers-color-scheme
});
```

Swap at runtime by replacing the `iconTheme` prop. The resolver is
memoized per theme so swapping is cheap.

**v0.1 caveat:** the Material Icon Theme bundle is a stub. Selecting
`'material'` in the playground falls back to the default theme and
shows a toast. The full bundle lands in v0.2.

## 5. Decoration providers

### 5.1 Git

```tsx
import { registerGitDecorations } from '@vibecook/mille-ui/git';

// Host supplies the git client (libgit2 via napi, isomorphic-git, …).
// The companion wires it into the engine's decoration pipeline.
const handle = registerGitDecorations({
  fx, // engine with registerDecorationProvider
  client: hostGitClient, // your implementation of GitClient
  rootPath: '/Users/you/my-repo',
});

// Later:
handle.dispose();
```

### 5.2 Agent-rules

Highlights "files-as-config" entries (`CLAUDE.md`, `.cursor/rules/*`,
`.kiro/steering/*`, `.clinerules`, `.continue/*`, `AGENTS.md`, `.rules`):

```tsx
import { registerAgentRulesDecorations } from '@vibecook/mille-ui/agent-rules';

const handle = registerAgentRulesDecorations({
  fx,
  rootPath: '/Users/you/my-repo',
  // additionalMatchers: [{ pattern: /\.project-rules$/ }],  // extend the defaults
});
```

### 5.3 Port-client limitation

`registerGitDecorations` / `registerAgentRulesDecorations` call
`fx.registerDecorationProvider(...)`. The **port-backed client** in
the playground does not surface that method yet — decorations run on
the native engine in the UtilityProcess. For v0.1 the playground
registers against a no-op shim so the UI wiring is demonstrable; a
host-side decoration forwarder (decoration frames across the port)
lands in v0.2.

If your renderer embeds the native engine directly (e.g. headless
Node test, non-Electron shell), you get decorations end-to-end out of
the box.

## 6. Common pitfalls

- **React 19 required.** `useSyncExternalStore` concurrent semantics
  and `memo` identity rules differ enough from 18 that mille-ui
  targets `>=19.0.0` as a hard peer. Check with `pnpm why react`.
- **Radix peer warnings.** When you don't use the context menu or
  rename tooltip, the optional peer warnings are noisy but benign.
  Silence by listing them explicitly in your `package.json`
  `dependencies`, or use the `@vibecook/mille-ui/headless` entry.
- **StrictMode + port.** Rendering `<App />` inside `<StrictMode>`
  double-invokes effects. If the port listener is set up inside the
  effect and the subscribe sees a synchronous `'message'` event, React
  19 warns "Cannot update a component while rendering a different
  component". The playground calls `useSyncExternalStore` directly and
  omits `StrictMode` to avoid this; for production apps, prefer
  subscribing outside React (as `fx-port.ts` does).
- **SharedArrayBuffer / WebContainer.** Not used today, but when a
  future scenario needs it (e.g. cross-process filesystems in a
  browser tab), remember to set the COOP/COEP headers. The playground
  runs in Electron so the restriction doesn't apply.
- **tokens.css must be imported.** Without it, focus rings and
  decoration colors render as `currentColor` fallbacks — readable but
  flat. Import it at the renderer entry.
- **Workspace root.** `os.homedir()` is a reasonable default. For a
  real product, provide an OS-native "open folder" flow (Electron's
  `dialog.showOpenDialogSync`) and persist the last choice.

## 6.1. Recent folders (v0.2 B7)

The playground persists the last ~10 opened paths to
`app.getPath('userData') + '/recent-folders.json'` and exposes them
via `window.millePlayground.getRecentFolders()`; the toolbar's "Open
folder…" control is a dropdown listing recents + a "Browse…" row.
Clear by deleting that JSON file (or the whole `userData` dir).
Stored paths are trusted — they can only be seeded by the OS-native
folder picker, never renderer-supplied strings — so the main-process
skips canonicalization beyond `statSync` directory validation.

## 6.2. Explorer navigation state (Phase 3)

The playground restores expansion, selection, focus, filter, and scroll state
from `app.getPath('userData') + '/file-tree-navigation.json'`. The renderer
accesses it only through the context-isolated preload API; synchronous disk I/O
stays in the main process. Records are keyed by absolute workspace root, capped
at 500 KB each and 32 workspaces total, and written via temporary-file rename.
Invalid, oversized, missing, or corrupt state falls back to a fresh tree.

## 7. Reference

- Playground source: `apps/playground/src/`
- Pre-mille-ui reference snapshot: `apps/playground/src.engine-only.reference/`
- Engine integration: `packages/mille/EMBEDDING.md`
- UI spec: `MILLE_UI_SPEC.md` (root of the research folder)
- Phase plan: `MILLE_UI_PLAN.md`
