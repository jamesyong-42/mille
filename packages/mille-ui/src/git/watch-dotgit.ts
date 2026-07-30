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
//
// The argument is a `.git` *entry*, not necessarily a directory:
// linked worktrees and submodules make it a file holding a `gitdir:`
// redirect, and following that is mandatory rather than cosmetic. See
// `resolveGitDir` below.

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface WatchDotGitOptions {
  /** Debounce window between fs events and the `onChange` firing. */
  readonly debounceMs?: number;
}

/**
 * Resolve a `.git` entry to the directory that actually holds `HEAD`
 * and `index`.
 *
 * In an ordinary repository `.git` *is* that directory. In a linked
 * worktree (`git worktree add`) or a submodule it is a **file** whose
 * contents are `gitdir: <path>`, and both `HEAD` and `index` live at
 * the far end of that redirect — per worktree, not in the common dir.
 *
 * Following it is load-bearing, not a nicety. Watching the `.git` file
 * itself attaches an inode watch whose events report the basename
 * `.git`, which the HEAD/index filter rejects; watching its containing
 * directory (what this used to fall back to) attaches to the worktree
 * root, where neither `HEAD` nor `index` will ever appear. Both spell
 * the same failure: the watcher goes permanently silent and badges
 * freeze at whatever they showed on first paint, with no error.
 *
 * The redirect is resolved against the `.git` entry's own directory.
 * Git writes an absolute path today, but the format permits a relative
 * one and submodules in older repositories carry them.
 *
 * Returns `null` when the entry cannot be stat'd, read, or parsed —
 * callers skip the watcher entirely rather than attach a dead one.
 */
export function resolveGitDir(dotGit: string): string | null {
  let stats: fs.Stats;
  try {
    stats = fs.statSync(dotGit);
  } catch {
    return null;
  }
  if (stats.isDirectory()) return dotGit;
  try {
    // Deliberately anchored and multiline: the file is a single
    // `gitdir: …` line today, but an unanchored search would happily
    // match the word inside some future trailing key.
    const match = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGit, 'utf8'));
    const target = match?.[1];
    if (target === undefined || target === '') return null;
    return path.resolve(path.dirname(dotGit), target);
  } catch {
    return null;
  }
}

/**
 * Watch `HEAD` and `index` for changes. Returns a disposer that closes
 * the underlying `fs.FSWatcher`s.
 *
 * `dotGit` may be either a real gitdir or a `.git` entry carrying a
 * `gitdir:` redirect (linked worktree, submodule) — it is resolved
 * before anything is watched, so passing an ordinary `.git` directory
 * behaves exactly as it always has.
 *
 * The disposer is idempotent — safe to call twice.
 */
export function watchDotGit(
  dotGit: string,
  onChange: () => void,
  opts: WatchDotGitOptions = {},
): () => void {
  const debounceMs = opts.debounceMs ?? 100;

  // An unresolvable entry has nothing worth watching. Return a valid
  // no-op disposer rather than attaching watchers to a path that can
  // never produce a HEAD/index event.
  const resolved = resolveGitDir(dotGit);
  if (resolved === null) return (): void => {};

  // The helpers below are hoisted function declarations, and narrowing
  // from the guard above does not reach into those — rebind to a
  // plainly-typed const so they see a `string`.
  const gitDir: string = resolved;

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
