// Best-effort removal of a test's temporary directory.
//
// Tearing down a temp dir is not the subject of any test, but on Windows it
// was failing six of them — always in `finally`, never on an assertion:
//
//   ENOTEMPTY: directory not empty, rmdir '...\mille-multi-root-le1Mgz\...'
//   EPERM: operation not permitted, lstat '...\mille-undo-3UBsZN\...\fresh.txt'
//
// Both are the Windows delete-pending signature: a delete only completes once
// the last handle closes, so until then the entry is still listed (rmdir sees
// a non-empty directory) and cannot be stat'd (rimraf's lstat gets access
// denied). `fs.rm`'s own `maxRetries`/`retryDelay` did not clear it, and the
// same six tests failed identically across runs, so this is not the transient
// contention it first looks like — something holds those handles for longer
// than a retry window.
//
// That is worth knowing about, so this warns rather than swallowing: a leak
// stays visible in the log without failing a test that has already made all of
// its assertions. The OS reclaims the temp directory regardless.
//
// If these warnings appear consistently for the same paths, the question to
// chase is on the product side, not here — `journal.rs` pins an open
// `Arc<std::fs::File>` per undoable create, and the watcher holds a directory
// handle for each watched root. Neither costs anything on Unix; both block
// deletion on Windows.

import { rmSync } from 'node:fs';

/**
 * Remove `dir` recursively. Never throws.
 *
 * @param {string} dir Directory to remove.
 * @param {string} [label] Optional context for the warning.
 */
export function removeTempDir(dir, label) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch (err) {
    const where = label ? ` (${label})` : '';
    console.warn(
      `[test-temp] could not remove ${dir}${where}: ${err.code ?? 'error'} — ` +
        `${err.message}. Leaving it to the OS; if this repeats for the same ` +
        `path, something is holding a handle open past dispose.`,
    );
  }
}
