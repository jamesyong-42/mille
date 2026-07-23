// @vibecook/mille — entry point
//
// Phase 6 layers a typed client on top of the raw napi-rs binding.
// Commit 6.1 exposed the loader + smoke-test version(). Commits 6.4-6.7
// add FileSystemError, the FileExplorer wrapper, MirrorSnapshot, and
// the React adapter.

import { native, nativeLoadInfo, type NativeLoadSource } from './native.js';
import { PROTOCOL_VERSION } from './protocol.js';

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
  SearchHit,
  SearchOptions,
  TransferOptions,
  Uri,
  VisibleRow,
  VisibleRowCount,
  VisibleRowsOptions,
} from './client.js';
export { DecorationStore } from './decorations.js';
export type { DecorationProvider } from './decorations.js';
export { createFileExplorerHost } from './host.js';
export type { FileExplorerHost, MessagePortLike } from './types.js';
export { connectFileExplorer, PortFileExplorer, PortMirrorSnapshot } from './client-port.js';
export {
  EXPLORER_SETTINGS_VERSION,
  EXPLORER_SETTINGS_LIMITS,
  DEFAULT_EXPLORER_SETTINGS,
  parseExplorerSettings,
  serializeExplorerSettings,
  resolveExplorerSettings,
} from './explorer-settings.js';
export type {
  ExplorerSortBy,
  ExplorerProjectionSettings,
  ExplorerSettingsOverride,
  ExplorerWorkspaceSettings,
  ExplorerSettingsDocument,
  ResolvedExplorerSettings,
} from './explorer-settings.js';

/**
 * Returns the fx-binding version string (the napi-rs crate version).
 * Smoke-test hook: consumers that just want to confirm the binary
 * loaded can call this without constructing a FileExplorer.
 */
export function version(): string {
  return native.version();
}

export interface BuildIdentity {
  readonly packageVersion: string;
  readonly nativeVersion: string;
  readonly nativeProfile: string;
  readonly nativeTarget: string;
  readonly protocolVersion: number;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly source: NativeLoadSource;
  readonly resolvedPath: string;
}

let cachedBuildIdentity: BuildIdentity | null = null;

/**
 * Describe the exact TypeScript package and native artifact loaded by this
 * process. Benchmarks and bug reports should record this payload so a stale
 * local `.node` file cannot masquerade as the current source implementation.
 */
export function buildIdentity(): BuildIdentity {
  if (cachedBuildIdentity !== null) return cachedBuildIdentity;
  const nativeInfo = native.buildInfo?.() ?? {
    crateVersion: native.version(),
    profile: 'unknown',
    target: `${process.platform}-${process.arch}`,
  };
  cachedBuildIdentity = Object.freeze({
    packageVersion: nativeLoadInfo.packageVersion,
    nativeVersion: nativeInfo.crateVersion,
    nativeProfile: nativeInfo.profile,
    nativeTarget: nativeInfo.target,
    protocolVersion: PROTOCOL_VERSION,
    platform: process.platform,
    arch: process.arch,
    source: nativeLoadInfo.source,
    resolvedPath: nativeLoadInfo.resolvedPath,
  });
  return cachedBuildIdentity;
}
