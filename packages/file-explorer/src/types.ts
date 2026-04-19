// Shared runtime types for the host/client split — Phase 7 commit 7.1.
//
// api.d.ts is the package's authoritative public type surface (including
// `MessagePortLike` and `FileExplorerHost`). This module re-declares the
// runtime-facing subset so src/host.ts and src/client.ts can reference
// them without coupling to the .d.ts bundled at the package root.
//
// Keep these definitions compatible with api.d.ts. Phase 7 ships the
// runtime; the two surfaces unify in Phase 8 when the decl file moves
// under src/.

import type { FileExplorer } from './client.js';

/**
 * Minimal `MessagePort`-like surface satisfied by `MessagePortMain`,
 * the DOM `MessagePort`, and Node's `worker_threads` `MessagePort`.
 * Mirrors api.d.ts.
 */
export interface MessagePortLike {
  postMessage(message: unknown, transfer?: readonly unknown[]): void;
  addEventListener(type: 'message', listener: (ev: { data: unknown }) => void): void;
  removeEventListener(type: 'message', listener: (ev: { data: unknown }) => void): void;
  start?(): void;
  close?(): void;
}

/** Uniform dispose shape used across the package. */
export interface Disposable {
  dispose(): void;
}

/**
 * UtilityProcess-side host. Wraps a single native `FileExplorer` and
 * multiplexes zero-or-more renderer sessions over attached MessagePorts.
 * Mirrors api.d.ts.
 */
export interface FileExplorerHost {
  attachPort(port: MessagePortLike): Disposable;
  readonly sessionCount: number;
  readonly local: FileExplorer;
  /**
   * Flag a subtree root as coarse (e.g. watcher Overflow). The next
   * tick's delta will include the root in its `coarseSubtrees` field so
   * attached sessions can invalidate just that subtree rather than the
   * whole mirror. Wired to the native watcher in Phase 5.
   */
  markSubtreeCoarse(rootId: number): void;
  dispose(): Promise<void>;
}
