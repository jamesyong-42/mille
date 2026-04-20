/// <reference types="vite/client" />

// Mirror of the preload's contextBridge API. Duplicated here (small)
// because the renderer tsconfig only includes `src/renderer/**`, not
// the preload sources. Keep both copies in sync.
export interface MillePlaygroundApi {
  pickAndOpenWorkspace(): Promise<string | null>;
}

declare global {
  interface Window {
    readonly millePlayground: MillePlaygroundApi;
  }
}
