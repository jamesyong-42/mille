// @mille/file-explorer — entry point
//
// Phase 6 layers a typed client on top of the raw napi-rs binding.
// Commit 6.1 exposes just the loader + a smoke-test-friendly version().
// Commits 6.4-6.7 add the FileExplorer wrapper, MirrorSnapshot type,
// and React adapter.

import { native } from './native.js';

export { native };

/**
 * Returns the fx-binding version string (the napi-rs crate version).
 * Smoke-test hook: consumers that just want to confirm the binary
 * loaded can call this without constructing a FileExplorer.
 */
export function version(): string {
  return native.version();
}
