// Types for the contextBridge surface exposed by the preload. Picked up
// by the renderer's tsconfig.web.json `include` so `window.millePlayground`
// is typed inside `src/renderer/`.

export interface MillePlaygroundApi {
  pickAndOpenWorkspace(): Promise<string | null>;
  /** v0.2 B7 — open a known path (from recents) without re-prompting. */
  openWorkspace(path: string): Promise<void>;
  /** v0.2 B7 — last ~10 successfully-opened folders, newest first. */
  getRecentFolders(): Promise<string[]>;
}

declare global {
  interface Window {
    readonly millePlayground: MillePlaygroundApi;
  }
}
