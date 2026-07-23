import { contextBridge, ipcRenderer } from 'electron';

import type {
  WatchBenchConfig,
  WatchBenchEvent,
  WatchBenchObservation,
} from '../shared/watch-bench';
import type {
  PlaygroundFileActionRequest,
  PlaygroundFileActionResult,
} from '../../scripts/file-actions.mjs';

// MessagePort can't pass through contextBridge (prototype is stripped).
// Forward via window.postMessage with the port in the transfer list; the
// renderer listens on 'message' and reads event.ports[0]. Fires on every
// arrival — the renderer swaps the connection when a new port lands
// (triggered by the toolbar's "Open folder…" picker).
ipcRenderer.on('fx-port', (event, payload: { workspaceRoot: string }) => {
  window.postMessage(
    { type: 'fx-port', workspaceRoot: payload.workspaceRoot },
    '*',
    event.ports as unknown as Transferable[],
  );
});

// Renderer-facing API. Contextually isolated: only the named methods
// are exposed, not ipcRenderer wholesale.
contextBridge.exposeInMainWorld('millePlayground', {
  /**
   * Open the native folder-picker; if the user confirms, tears down
   * the old fx utility and starts a new one against the picked path.
   * Resolves with the chosen path, or null if cancelled. Throws if
   * the chosen path isn't a directory (rare — should only happen if
   * the path was deleted between picker close and open).
   *
   * A fresh `fx-port` message with the new workspaceRoot is emitted
   * asynchronously after this promise resolves — the renderer's
   * listener swaps the connection.
   */
  async pickAndOpenWorkspace(): Promise<string | null> {
    const picked: string | null = await ipcRenderer.invoke('pick-workspace');
    if (picked === null) return null;
    await ipcRenderer.invoke('open-workspace', picked);
    return picked;
  },

  /**
   * v0.2 B7 — open a specific path directly, bypassing the native
   * picker. Used by the recents dropdown to one-click-swap between
   * previously-visited folders. Main-process validates `path` is an
   * existing directory and throws otherwise; caller should surface
   * the rejection (e.g. a toast) if the entry has gone stale.
   */
  async openWorkspace(path: string): Promise<void> {
    await ipcRenderer.invoke('open-workspace', path);
  },

  /**
   * v0.2 B7 — recents list, newest first, capped at ~10 entries and
   * persisted to `app.getPath('userData') + '/recent-folders.json'`.
   * Cheap re-read from disk per call (no IPC push-channel needed for
   * a dropdown that opens on demand).
   */
  async getRecentFolders(): Promise<string[]> {
    const list: unknown = await ipcRenderer.invoke('get-recent-folders');
    if (!Array.isArray(list)) return [];
    return list.filter((p): p is string => typeof p === 'string');
  },

  async getFileTreeNavigationState(root: string): Promise<string | null> {
    const state: unknown = await ipcRenderer.invoke('get-file-tree-navigation-state', root);
    return typeof state === 'string' ? state : null;
  },

  async saveFileTreeNavigationState(root: string, state: string): Promise<boolean> {
    return (await ipcRenderer.invoke('save-file-tree-navigation-state', root, state)) === true;
  },

  async performFileAction(
    request: PlaygroundFileActionRequest,
  ): Promise<PlaygroundFileActionResult> {
    return (await ipcRenderer.invoke('perform-file-action', request)) as PlaygroundFileActionResult;
  },

  /**
   * v0.2 — toggle git decorations. The shell-based `GitClient` uses
   * `node:child_process` + `fs.watch`, which can't run in the
   * renderer, so the provider lives in the fx utility process and
   * A1's decoration fan-out carries badges to every attached port
   * session automatically.
   */
  async setGitDecorations(enabled: boolean): Promise<void> {
    await ipcRenderer.invoke('set-git-decorations', enabled);
  },

  async getWatchBenchConfig(): Promise<WatchBenchConfig | null> {
    return (await ipcRenderer.invoke('watch-bench:get-config')) as WatchBenchConfig | null;
  },

  onWatchBenchEvent(listener: (event: WatchBenchEvent) => void): void {
    ipcRenderer.on('watch-bench:event', (_event, message: WatchBenchEvent) => listener(message));
  },

  watchBenchReady(): void {
    ipcRenderer.send('watch-bench:ready');
  },

  reportWatchBenchObservation(observation: WatchBenchObservation): void {
    ipcRenderer.send('watch-bench:observed', observation);
  },
});
