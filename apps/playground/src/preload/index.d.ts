// Types for the contextBridge surface exposed by the preload. Picked up
// by the renderer's tsconfig.web.json `include` so `window.millePlayground`
// is typed inside `src/renderer/`.

export interface MillePlaygroundApi {
  pickAndOpenWorkspace(): Promise<string | null>;
}

declare global {
  interface Window {
    readonly millePlayground: MillePlaygroundApi;
  }
}
