// Phase B4.2 — `.git/HEAD` + `.git/index` watcher.
//
// Fires a debounced `onChange()` whenever either file's mtime or
// contents change. We use `fs.watch` with `persistent: false` so the
// watcher doesn't pin the Node event loop open after the host quits —
// decoration refresh is a convenience, never a lifecycle anchor.
//
// Watching these two files covers the cases that matter for badge
// freshness:
//   - HEAD flips on branch switches / detached-HEAD moves.
//   - index flips on `git add` / `git reset` / commit.
// Worktree-only edits are NOT detected by this watcher; the companion's
// `refresh()` + the user's own file-save events fill that gap. A full
// worktree watcher would need chokidar or libfswatch, which is out of
// scope for v0.2.
//
// Each watched path may or may not exist — an empty repo has no index,
// and a bare repo has no HEAD in the usual location. ENOENT is
// swallowed; the watcher still produces a valid disposer.

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface WatchDotGitOptions {
  /** Debounce window between fs events and the `onChange` firing. */
  readonly debounceMs?: number;
}

/**
 * Watch `{gitDir}/HEAD` and `{gitDir}/index` for changes. Returns a
 * disposer that closes the underlying `fs.FSWatcher`s.
 *
 * The disposer is idempotent — safe to call twice.
 */
export function watchDotGit(
  gitDir: string,
  onChange: () => void,
  opts: WatchDotGitOptions = {},
): () => void {
  const debounceMs = opts.debounceMs ?? 100;

  const watchers: fs.FSWatcher[] = [];
  let pending: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  function fire(): void {
    if (disposed) return;
    if (pending !== null) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = null;
      if (disposed) return;
      try { onChange(); } catch { /* listener errors are caller's problem */ }
    }, debounceMs);
  }

  function tryWatchFile(target: string): void {
    try {
      const w = fs.watch(target, { persistent: false }, () => {
        fire();
      });
      // Swallow async watcher errors (ENOENT on an untouched repo path
      // that later gets deleted, etc.) — the other watcher keeps running.
      w.on('error', () => { /* ignore */ });
      watchers.push(w);
    } catch {
      // ENOENT (file not yet created) or EACCES — skip quietly.
    }
  }

  // QA fix — Linux atomic-rename safety.
  //
  // `fs.watch(path)` on an individual file uses inotify's inode-based
  // watch, which goes silent after git rewrites `.git/index` via
  // `rename(index.lock, index)` (the old inode is gone, the new file
  // is a different inode). On Linux, subsequent edits never fire.
  // Fix: watch the containing directory as well, and filter by name.
  // Directory watches survive atomic renames because they track the
  // directory inode, not the file inodes. macOS FSEvents already
  // handles this via path-based watching; the dir watch is redundant
  // there but harmless.
  function tryWatchDir(): void {
    try {
      const w = fs.watch(gitDir, { persistent: false }, (_event, filename) => {
        if (filename === 'HEAD' || filename === 'index' || filename === 'index.lock') {
          fire();
        }
      });
      w.on('error', () => { /* ignore */ });
      watchers.push(w);
    } catch {
      /* ENOENT / EACCES — no gitDir, skip. */
    }
  }

  tryWatchDir();
  tryWatchFile(path.join(gitDir, 'HEAD'));
  tryWatchFile(path.join(gitDir, 'index'));

  return (): void => {
    if (disposed) return;
    disposed = true;
    if (pending !== null) {
      clearTimeout(pending);
      pending = null;
    }
    for (const w of watchers) {
      try { w.close(); } catch { /* ignore */ }
    }
    watchers.length = 0;
  };
}
