// Phase 6.1 — URI-first filesystem provider contract (runtime).
//
// Mirrors `api.d.ts` FileSystemProvider / Capability so hosts can implement
// non-`file` schemes without waiting on native scheme dispatch. Local
// FileExplorer remains the optimized default for `file:`.

import type { ErrorCode } from '../errors.js';

/** URI for scheme-based provider dispatch. Mirrors VS Code's Uri shape. */
export interface Uri {
  readonly scheme: string;
  readonly authority?: string;
  readonly path: string;
  readonly query?: string;
  readonly fragment?: string;
}

/**
 * Bitmask. Providers advertise which methods they implement.
 * Keep in sync with `api.d.ts` Capability and Rust `Capability`.
 */
export const Capability = {
  None: 0,
  ReadWrite: 1 << 0,
  CaseSensitive: 1 << 1,
  Readonly: 1 << 2,
  Trash: 1 << 3,
  AtomicWrite: 1 << 4,
  Watch: 1 << 5,
  Stream: 1 << 6,
  Clone: 1 << 7,
  Realpath: 1 << 8,
  FileLock: 1 << 9,
} as const;

export type CapabilityBit = (typeof Capability)[keyof typeof Capability];

export type EntryKind = 0 | 1 | 2 | 3 | 4;

export const EntryKind = {
  File: 0 as EntryKind,
  Directory: 1 as EntryKind,
  Symlink: 2 as EntryKind,
  Unknown: 3 as EntryKind,
  Unavailable: 4 as EntryKind,
};

/**
 * Provider-facing entry. Ids are session-scoped and stable across renames
 * within a single provider instance (same contract as the native engine).
 */
export interface ProviderEntry {
  readonly id: number;
  readonly parentId: number | null;
  readonly name: string;
  readonly kind: EntryKind;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  /** Workspace-relative POSIX path under the provider root (no leading slash). */
  readonly path: string;
  readonly isSymlink?: boolean;
  readonly isReadonly?: boolean;
}

export type FileSystemEventType =
  | 'created'
  | 'changed'
  | 'deleted'
  | 'renamed';

export interface FileSystemEvent {
  readonly type: FileSystemEventType;
  readonly uri: Uri;
  readonly oldUri?: Uri;
}

export interface Disposable {
  dispose(): void;
}

export type EventListener<T> = (event: T) => void;

export interface WatchOptions {
  readonly recursive?: boolean;
  readonly excludes?: readonly string[];
  readonly includes?: readonly string[];
}

export interface Watcher extends Disposable {
  onDidChange(listener: EventListener<FileSystemEvent>): Disposable;
}

/**
 * Host-implemented filesystem for a URI scheme.
 * Missing optional methods must not appear in `capabilities`.
 */
export interface FileSystemProvider {
  readonly scheme: string;
  readonly capabilities: number;
  stat(uri: Uri): Promise<ProviderEntry>;
  readDirectory(uri: Uri): Promise<readonly ProviderEntry[]>;
  readFile(uri: Uri): Promise<Uint8Array>;
  writeFile?(
    uri: Uri,
    data: Uint8Array,
    options?: { atomic?: boolean },
  ): Promise<void>;
  createDirectory?(uri: Uri): Promise<void>;
  delete?(
    uri: Uri,
    options?: { recursive?: boolean; trash?: boolean },
  ): Promise<void>;
  rename?(oldUri: Uri, newUri: Uri): Promise<void>;
  /**
   * Copy a file or directory. Fails with `EEXIST` when the destination
   * exists unless `overwrite` is set — a silent clobber is never the
   * default, and the collision policy belongs to the caller.
   */
  copy?(
    source: Uri,
    destination: Uri,
    options?: { overwrite?: boolean },
  ): Promise<void>;
  watch?(uri: Uri, options?: WatchOptions): Watcher;
  readFileStream?(
    uri: Uri,
    signal?: AbortSignal,
  ): AsyncIterable<Uint8Array>;
}

/** High-level operations used for capability gating and UI enablement. */
export type ProviderOperation =
  | 'stat'
  | 'readDirectory'
  | 'readFile'
  | 'writeFile'
  | 'createDirectory'
  | 'delete'
  | 'rename'
  | 'copy'
  | 'watch'
  | 'stream'
  | 'trash'
  | 'atomicWrite';

export interface UnsupportedOperationInfo {
  readonly operation: ProviderOperation;
  readonly code: ErrorCode;
  readonly message: string;
  readonly requiredCapabilities: number;
  readonly actualCapabilities: number;
}
