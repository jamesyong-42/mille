// Types for the contextBridge surface exposed by the preload. Picked up
// by the renderer's tsconfig.web.json `include` so `window.millePlayground`
// is typed inside `src/renderer/`.

import type {
  WatchBenchConfig,
  WatchBenchEvent,
  WatchBenchObservation,
} from '../shared/watch-bench';
import type {
  PlaygroundFileActionRequest,
  PlaygroundFileActionResult,
} from '../../scripts/file-actions.mjs';

export interface MillePlaygroundApi {
  pickAndOpenWorkspace(): Promise<string | null>;
  /** v0.2 B7 — open a known path (from recents) without re-prompting. */
  openWorkspace(path: string): Promise<void>;
  /** v0.2 B7 — last ~10 successfully-opened folders, newest first. */
  getRecentFolders(): Promise<string[]>;
  /** Phase 3 — bounded navigation state keyed by absolute workspace root. */
  getFileTreeNavigationState(root: string): Promise<string | null>;
  saveFileTreeNavigationState(root: string, state: string): Promise<boolean>;
  performFileAction(request: PlaygroundFileActionRequest): Promise<PlaygroundFileActionResult>;
  /** v0.2 — toggle git decorations (runs in fx utility process). */
  setGitDecorations(enabled: boolean): Promise<void>;
  /** Phase 5.2 — one-shot git status for Changed Files view. */
  getGitStatus(
    rootPath?: string,
  ): Promise<ReadonlyArray<{ path: string; status: string; staged?: boolean }>>;
  /** Phase 5.3 — file timeline via shell git log. */
  getFileHistory(
    path: string,
    options?: { rootPath?: string; limit?: number },
  ): Promise<
    ReadonlyArray<{
      id: string;
      shortId?: string;
      author?: string;
      message?: string;
      timestampMs: number;
    }>
  >;
  scmCompare(request: {
    path: string;
    rootPath?: string;
    left: { kind: 'working' } | { kind: 'revision'; revision: string };
    right: { kind: 'working' } | { kind: 'revision'; revision: string };
  }): Promise<{
    path: string;
    leftLabel: string;
    rightLabel: string;
    left: string | null;
    right: string | null;
  }>;
  scmRevert(paths: readonly string[], rootPath?: string): Promise<void>;
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
