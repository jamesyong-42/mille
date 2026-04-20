// Attach the window.postMessage listener synchronously at module load so
// the port doesn't slip through the gap between the preload's
// window.postMessage and React's first useEffect.

export interface FxPortMessage {
  port: MessagePort;
  workspaceRoot: string;
}

export const fxPortReady: Promise<FxPortMessage> = new Promise((resolve) => {
  const handler = (evt: MessageEvent): void => {
    const data = evt.data as { type?: string; workspaceRoot?: string } | undefined;
    if (data?.type === 'fx-port' && evt.ports.length > 0) {
      window.removeEventListener('message', handler);
      resolve({ port: evt.ports[0]!, workspaceRoot: data.workspaceRoot ?? '' });
    }
  };
  window.addEventListener('message', handler);
});
