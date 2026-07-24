/// <reference types="vite/client" />

import type {
  WatchBenchConfig,
  WatchBenchEvent,
  WatchBenchObservation,
} from '../../shared/watch-bench';
import type {
  PlaygroundFileActionRequest,
  PlaygroundFileActionResult,
} from '../../../scripts/file-actions.mjs';

// Mirror of the preload's contextBridge API. Duplicated here (small)
// because the renderer tsconfig only includes `src/renderer/**`, not
// the preload sources. Keep both copies in sync.
export interface MillePlaygroundApi {
  pickAndOpenWorkspace(): Promise<string | null>;
  /** v0.2 B7 — open a known path (from recents) without re-prompting. */
  openWorkspace(path: string): Promise<void>;
  /**
   * Phase 5.3 multi-root — pick a folder and *append* it to the workspace
   * instead of replacing it. Resolves with the resulting root list, or null
   * if the picker was cancelled.
   */
  addWorkspaceFolder(): Promise<readonly string[] | null>;
  /** Phase 5.3 multi-root — currently open workspace roots. */
  getWorkspaceRoots(): Promise<readonly string[]>;
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
