// Phase 5.3 — file history + SCM action contracts.
//
// Hosts supply timeline and mutation backends (git, other VCS, mock).
// The UI layer never shells out itself except via optional `/git/node`.

/**
 * One revision on a file's timeline.
 */
export interface FileHistoryRevision {
  /** Opaque revision id (full git SHA, etc.). */
  readonly id: string;
  /** Short display id (e.g. 7-char SHA). */
  readonly shortId?: string;
  readonly author?: string;
  readonly message?: string;
  /** Commit/author time in unix ms. */
  readonly timestampMs: number;
  readonly parents?: readonly string[];
}

export interface FileHistoryQuery {
  /**
   * Workspace-relative POSIX path, or absolute path when `rootPath` is
   * omitted and the client accepts absolute paths.
   */
  readonly path: string;
  readonly rootPath?: string;
  /** Max revisions to return. Default host-defined (often 50). */
  readonly limit?: number;
}

/**
 * Host-supplied file timeline source.
 */
export interface FileHistoryClient {
  getHistory(
    query: FileHistoryQuery,
  ): Promise<readonly FileHistoryRevision[]>;

  /**
   * Optional: file contents at a revision. Used by compare flows.
   * Return `null` when unavailable.
   */
  getContents?(
    query: FileHistoryQuery & { revision: string },
  ): Promise<string | Uint8Array | null>;
}

// ─── SCM actions ──────────────────────────────────────────────────────

export type ScmCompareSide =
  | { readonly kind: 'working' }
  | { readonly kind: 'revision'; readonly revision: string };

export interface ScmCompareRequest {
  readonly path: string;
  readonly rootPath?: string;
  readonly left: ScmCompareSide;
  readonly right: ScmCompareSide;
}

/**
 * Result of a compare that does not open host UI itself. Hosts that open
 * a diff editor may return `void` / `undefined` from `ScmClient.compare`.
 */
export interface ScmCompareResult {
  readonly path: string;
  readonly leftLabel: string;
  readonly rightLabel: string;
  readonly left: string | Uint8Array | null;
  readonly right: string | Uint8Array | null;
}

export type ScmProgressPhase =
  | 'preparing'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface ScmProgressEvent {
  readonly operationId: string;
  readonly action: string;
  readonly phase: ScmProgressPhase;
  readonly message?: string;
  /** 0–1 when known. */
  readonly fraction?: number;
  readonly paths?: readonly string[];
}

/**
 * Host SCM mutation surface. All methods optional so hosts can implement
 * only what they support; missing methods yield EUNSUPPORTED-style errors.
 */
export interface ScmClient {
  /**
   * Discard working-tree changes for the given workspace-relative paths
   * (restore HEAD or index content).
   */
  revert?(
    paths: readonly string[],
    options?: { rootPath?: string; signal?: AbortSignal },
  ): Promise<void>;

  /**
   * Compare two sides. May open host UI and return void, or return
   * content for the caller to display.
   */
  compare?(
    request: ScmCompareRequest,
    options?: { signal?: AbortSignal },
  ): Promise<ScmCompareResult | void>;

  stage?(
    paths: readonly string[],
    options?: { rootPath?: string; signal?: AbortSignal },
  ): Promise<void>;

  unstage?(
    paths: readonly string[],
    options?: { rootPath?: string; signal?: AbortSignal },
  ): Promise<void>;
}

/**
 * Cross-cutting UX hooks for SCM actions (confirm, progress, errors).
 */
export interface ScmActionHooks {
  /**
   * Confirm a destructive action. Returning `false` aborts without
   * calling the client. Default: auto-confirm (true).
   */
  confirm?(message: string): boolean | Promise<boolean>;
  onProgress?(event: ScmProgressEvent): void;
  onError?(
    error: unknown,
    context: { action: string; paths?: readonly string[] },
  ): void;
}

export class ScmActionError extends Error {
  readonly code: string;
  readonly action: string;

  constructor(code: string, action: string, message: string) {
    super(message);
    this.name = 'ScmActionError';
    this.code = code;
    this.action = action;
  }
}
