import { contextBridge, ipcRenderer } from 'electron';

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
});
