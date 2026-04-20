// Phase 13.1 — GitClient interface.
//
// Host-supplied git status source. The companion never ships a default
// implementation: libgit2 via napi or isomorphic-git are heavy,
// host-specific, and out of scope for the UI layer. Consumers inject
// whatever their platform supports (Electron main process talking to a
// native git binary, node-git, dulwich, etc.).

/**
 * VS Code / git porcelain short-status letters used by the companion.
 *
 *   M — modified           C — copied
 *   A — added              ? — untracked
 *   D — deleted            ! — ignored
 *   U — unmerged / conflicted
 *   R — renamed
 */
export type GitStatusLetter =
  | 'M'
  | 'A'
  | 'D'
  | 'U'
  | 'R'
  | 'C'
  | '?'
  | '!';

/**
 * One row's worth of git status. `path` is workspace-relative (POSIX
 * separators). `staged` is optional: when `true`, the entry is in the
 * index; when `false`/omitted, it reflects the working tree.
 */
export interface GitStatusEntry {
  readonly path: string;
  readonly status: GitStatusLetter;
  readonly staged?: boolean;
}

/**
 * Minimal contract the UI needs from a host-supplied git client.
 *
 * `getStatus(root)` returns a snapshot map keyed by workspace-relative
 * path. The UI treats the map as immutable; implementations should
 * return a fresh map per call unless they can guarantee no mutation.
 *
 * `onChange(cb)` subscribes to HEAD/index/worktree changes. The
 * callback fires on every interesting transition; the companion
 * coalesces storms via its own batcher.
 */
export interface GitClient {
  /**
   * Fetch the current status for all modified / untracked / ignored
   * paths under `root`. Paths in the returned map are expected to be
   * workspace-relative with POSIX separators.
   */
  getStatus(root: string): Promise<ReadonlyMap<string, GitStatusEntry>>;

  /**
   * Subscribe to changes. Returns a disposer that unsubscribes.
   * Must be safe to call multiple times.
   */
  onChange(cb: () => void): () => void;
}
