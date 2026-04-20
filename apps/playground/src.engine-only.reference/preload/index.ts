import { ipcRenderer } from 'electron';

// MessagePort can't pass through contextBridge (prototype is stripped).
// Forward via window.postMessage with the port in the transfer list; the
// renderer listens on 'message' and reads event.ports[0].
ipcRenderer.on('fx-port', (event, payload: { workspaceRoot: string }) => {
  window.postMessage(
    { type: 'fx-port', workspaceRoot: payload.workspaceRoot },
    '*',
    event.ports as unknown as Transferable[],
  );
});
