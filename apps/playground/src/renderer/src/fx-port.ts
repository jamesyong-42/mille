// Listens for `fx-port` window messages forwarded from the preload.
// Every picker-driven workspace change produces a fresh port; the
// renderer swaps the connection when a new one lands.
//
// Two consumers:
//   - `fxPortReady` (initial handshake) — resolves with the first
//     port the main process posts. App.tsx uses it on mount.
//   - `onFxPort(cb)` — fires on every arrival, including subsequent
//     swaps. App.tsx subscribes after mount so picker-driven changes
//     dispose the old connection and attach the new one.

export interface FxPortMessage {
  port: MessagePort;
  /** Primary (first) root — identity for navigation state and demo seeds. */
  workspaceRoot: string;
  /** Every open root, in the order the engine received them. */
  workspaceRoots: readonly string[];
}

type Listener = (msg: FxPortMessage) => void;
const listeners = new Set<Listener>();

let resolveInitial: (msg: FxPortMessage) => void;
export const fxPortReady: Promise<FxPortMessage> = new Promise((res) => {
  resolveInitial = res;
});
let initialDelivered = false;

window.addEventListener('message', (evt: MessageEvent) => {
  const data = evt.data as
    | { type?: string; workspaceRoot?: string; workspaceRoots?: string[] }
    | undefined;
  if (data?.type !== 'fx-port' || evt.ports.length === 0) return;
  const primary = data.workspaceRoot ?? '';
  const msg: FxPortMessage = {
    port: evt.ports[0]!,
    workspaceRoot: primary,
    workspaceRoots:
      data.workspaceRoots && data.workspaceRoots.length > 0
        ? data.workspaceRoots
        : [primary],
  };
  if (!initialDelivered) {
    initialDelivered = true;
    resolveInitial(msg);
    return;
  }
  for (const cb of listeners) {
    try {
      cb(msg);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[fx-port] listener threw', err);
    }
  }
});

/**
 * Subscribe to subsequent `fx-port` arrivals (post-initial). Returns
 * a disposer. Does NOT fire for the initial arrival — consume
 * `fxPortReady` for that.
 */
export function onFxPort(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
