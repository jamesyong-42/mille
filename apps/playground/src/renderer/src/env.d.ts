/// <reference types="vite/client" />

import type {
  WatchBenchConfig,
  WatchBenchEvent,
  WatchBenchObservation,
} from '../../shared/watch-bench';

// Mirror of the preload's contextBridge API. Duplicated here (small)
// because the renderer tsconfig only includes `src/renderer/**`, not
// the preload sources. Keep both copies in sync.
export interface MillePlaygroundApi {
  pickAndOpenWorkspace(): Promise<string | null>;
  /** v0.2 B7 — open a known path (from recents) without re-prompting. */
  openWorkspace(path: string): Promise<void>;
  /** v0.2 B7 — last ~10 successfully-opened folders, newest first. */
  getRecentFolders(): Promise<string[]>;
  /** v0.2 — toggle git decorations (runs in fx utility process). */
  setGitDecorations(enabled: boolean): Promise<void>;
  getWatchBenchConfig(): Promise<WatchBenchConfig | null>;
  onWatchBenchEvent(listener: (event: WatchBenchEvent) => void): void;
  watchBenchReady(): void;
  reportWatchBenchObservation(observation: WatchBenchObservation): void;
}

declare global {
  interface Window {
    readonly millePlayground: MillePlaygroundApi;
  }
}
