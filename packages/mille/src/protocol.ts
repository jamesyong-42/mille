// IPC wire protocol for the host/client split — Phase 7 commit 7.2.
//
// Per SPEC §4.9.3, every message on the MessagePort wire is a versioned
// frame `{ v, type, body }`. This file defines the discriminated unions
// for both directions and a pair of helpers (frame / validateFrameVersion
// / isCompatibleVersion) that gate inbound frames before dispatch.
//
// No routing lives here — message handlers land in 7.3 (host) and 7.4
// (client). Bulk payloads (`snapshot.mirror`, `delta.addedRows`) are
// typed as ArrayBuffer so they can ride postMessage's transfer list
// and skip the structured-clone copy; their bincode encoding is wired
// through in 7.3.

/**
 * Wire protocol version. Bump on shape changes; clients with a mismatched
 * major version are rejected at handshake (§4.9.10).
 */
export const PROTOCOL_VERSION = 1;

/**
 * Common envelope for every message on the wire.
 */
export interface Frame<T = unknown> {
  v: number;       // protocol version
  type: string;    // discriminator
  body: T;
}

// ─── Client → Host messages ─────────────────────────────────────────────

export interface HandshakeMsg {
  type: 'handshake';
  body: {
    version: number;       // the client's PROTOCOL_VERSION
    clientId: string;      // opaque label, logged by the host
    options: {
      prefetchRows?: number;
      mirrorCap?: number;
    };
  };
}

export interface SetExpandedMsg {
  type: 'setExpanded';
  body: {
    add: number[];         // EntryIds to add to the expansion set
    remove: number[];
  };
}

export interface SetViewportMsg {
  type: 'setViewport';
  body: {
    offset: number;
    limit: number;
    overscan?: number;
  };
}

export interface MutateMsg {
  type: 'mutate';
  body: {
    reqId: number;
    op:
      | 'create'
      | 'rename'
      | 'move'
      | 'delete'
      | 'copy'
      | 'writeFile'
      | 'readFile'
      | 'readText';
    args: Record<string, unknown>;
  };
}

export interface CallMsg {
  type: 'call';
  body: {
    reqId: number;
    method: string;
    args: unknown[];
  };
}

export interface DisposeMsg {
  type: 'dispose';
  body: Record<string, never>;
}

export type ClientToHostMessage =
  | HandshakeMsg
  | SetExpandedMsg
  | SetViewportMsg
  | MutateMsg
  | CallMsg
  | DisposeMsg;

// ─── Host → Client messages ─────────────────────────────────────────────

export interface SnapshotMsg {
  type: 'snapshot';
  body: {
    version: number;                             // tree version
    roots: number[];
    /** Bincode-encoded flat rows. Transferred, not cloned. */
    mirror: ArrayBuffer;
    directChildCounts: Record<string, number>;   // keys are stringified ids
    /** Bincode-encoded viewport slice (see SPEC §4.8). */
    viewport: ArrayBuffer;
    visibleCount: number;
  };
}

export interface DeltaMsg {
  type: 'delta';
  body: {
    version: number;
    changedIds: number[];
    addedRows?: ArrayBuffer;
    removedIds: number[];
    directChildCounts: Record<string, number>;
    viewportPatch?: ArrayBuffer;
    newVisibleCount: number;
    coarseSubtrees: number[];
    subtreeDirty: number[];
    subtreeResynced: number[];
  };
}

export interface EventMsg {
  type: 'event';
  body: {
    kind: string;
    id?: number;
    parentId?: number;
    path?: string;
    code?: string;
    message?: string;
  };
}

export interface MutateResultMsg {
  type: 'mutateResult';
  body: {
    reqId: number;
    result: unknown;
    error?: {
      code: string;
      message: string;
      path?: string;
    };
  };
}

export interface CallResultMsg {
  type: 'callResult';
  body: {
    reqId: number;
    result: unknown;
    error?: {
      code: string;
      message: string;
      path?: string;
    };
  };
}

export interface WarningMsg {
  type: 'warning';
  body: { code: string; detail?: string };
}

export interface ErrorMsg {
  type: 'error';
  body: { code: string; message: string };
}

export type HostToClientMessage =
  | SnapshotMsg
  | DeltaMsg
  | EventMsg
  | MutateResultMsg
  | CallResultMsg
  | WarningMsg
  | ErrorMsg;

// ─── Helpers ────────────────────────────────────────────────────────────

/**
 * Shape-check an inbound value as a `Frame`. Returns the frame when
 * the envelope is well-formed, `null` otherwise. Version negotiation
 * is a separate step — call `isCompatibleVersion` on the result.
 */
export function validateFrameVersion(frame: unknown): Frame | null {
  if (
    typeof frame !== 'object' ||
    frame === null ||
    !('v' in frame) ||
    !('type' in frame) ||
    !('body' in frame)
  ) {
    return null;
  }
  const f = frame as Frame;
  if (typeof f.v !== 'number' || typeof f.type !== 'string') {
    return null;
  }
  return f;
}

/** Exact-match gate: bump PROTOCOL_VERSION to break older clients. */
export function isCompatibleVersion(v: number): boolean {
  return v === PROTOCOL_VERSION;
}

/** Wrap a body in a versioned frame, ready to hand to `postMessage`. */
export function frame<T>(type: string, body: T): Frame<T> {
  return { v: PROTOCOL_VERSION, type, body };
}
