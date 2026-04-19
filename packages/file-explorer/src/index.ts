// @mille/file-explorer — entry point
//
// Phase 6 layers a typed client on top of the raw napi-rs binding.
// Commit 6.1 exposed the loader + smoke-test version(). Commits 6.4-6.7
// add FileSystemError, the FileExplorer wrapper, MirrorSnapshot, and
// the React adapter.

import { native } from './native.js';

export { native };
export { FileSystemError, isFileSystemError } from './errors.js';
export type { ErrorCode } from './errors.js';
export { decodeBulkRows } from './decode.js';
export type { VisibleRow as DecodedVisibleRow } from './decode.js';
export { FileExplorer, MirrorSnapshot } from './client.js';
export type {
  Entry,
  EntryId,
  EventName,
  ExplorerOptions,
  Decoration,
  Disposable,
  Uri,
  VisibleRow,
  VisibleRowCount,
  VisibleRowsOptions,
} from './client.js';
export { createFileExplorerHost } from './host.js';
export type { FileExplorerHost, MessagePortLike } from './types.js';

/**
 * Returns the fx-binding version string (the napi-rs crate version).
 * Smoke-test hook: consumers that just want to confirm the binary
 * loaded can call this without constructing a FileExplorer.
 */
export function version(): string {
  return native.version();
}
