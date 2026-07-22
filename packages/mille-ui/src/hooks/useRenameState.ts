// useRenameState — local rename + new-entry state machine.
//
// Phase-5 primitive. Owns `renameTargetId` — the id of the row whose
// name span is currently being replaced by `<FileRenameInput>`. Exposes
// `startRename`, `commit`, `cancel`, plus a local `validate` that runs
// before the engine round-trip (empty/whitespace, unsafe chars,
// sibling-collision pre-check via `fx.getByUri` when available).
//
// Commit flow (success):
//   1. caller → commit(newName)
//   2. hook → fx.rename(targetId, newName)
//   3. engine resolves → onCommit?(result) → clear renameTargetId.
//
// Commit flow (engine rejects with FileSystemError):
//   1. caller → commit(newName)
//   2. hook → fx.rename(targetId, newName) rejects
//   3. hook stores err in `lastError`; leaves renameTargetId set so the
//      input stays open with `errorTooltip` = err.message.
//
// Controlled mode: caller supplies `controlled: { value, onChange }`.
// Uncontrolled: hook keeps state via `useControlledState`.

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Entry, EntryId } from '@vibecook/mille';
import { useControlledState } from './useControlledState.js';

// ─── Minimal fx / snapshot shapes the hook uses ───────────────────────
//
// We intentionally do NOT pull in `FileExplorer` directly — the engine
// type is heavy and the hook only needs two methods. Tests satisfy the
// same shape via the `FakeEngine` in `src/testing/`.

export interface RenameStateFx {
  rename(id: EntryId, newName: string): Promise<Entry>;
  create?(parentId: EntryId, name: string, kind: number): Promise<Entry>;
  /**
   * Optional URI → entry lookup. When present, used for client-side
   * collision pre-check. When absent, collision check is skipped.
   * See `api.d.ts` §FileExplorer.getByUri.
   */
  getByUri?: unknown;
}

export interface RenameStateSnapshot {
  getById(id: EntryId): Entry | null;
}

// ─── FileSystemError duck-typing ──────────────────────────────────────
//
// The engine's `FileSystemError` is a class with `.code: ErrorCode` and
// `.message: string`. We treat anything with those as a `FileSystemError`
// for error surfacing purposes.

export interface RenameFileSystemError {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

function asFileSystemError(e: unknown): RenameFileSystemError | null {
  if (e === null || typeof e !== 'object') return null;
  const rec = e as Record<string, unknown>;
  const code = rec['code'];
  const message = rec['message'];
  if (typeof code !== 'string' || typeof message !== 'string') return null;
  return {
    code,
    message,
    ...(typeof rec['path'] === 'string' ? { path: rec['path'] as string } : {}),
  };
}

// ─── Options / handle ────────────────────────────────────────────────

export interface RenameStateControlled {
  readonly value: EntryId | null;
  onChange(next: EntryId | null): void;
}

export interface RenameCommitResult {
  readonly id: EntryId;
  readonly newName: string;
  readonly entry: Entry | null;
}

export interface UseRenameStateOptions {
  readonly fx: RenameStateFx;
  readonly snapshot: RenameStateSnapshot;
  readonly controlled?: RenameStateControlled | undefined;
  onCommit?(result: RenameCommitResult): void;
  onError?(err: RenameFileSystemError): void;
}

export interface RenameStateHandle {
  readonly renameTargetId: EntryId | null;
  readonly lastError: RenameFileSystemError | null;
  /** Increments for every failed commit, including repeated identical errors. */
  readonly errorRevision: number;
  startRename(id: EntryId): void;
  commit(newName: string): Promise<void>;
  cancel(): void;
  /**
   * Client-side pre-check. Returns a human-readable error string on
   * failure, or `null` on success. Does not mutate state.
   */
  validate(newName: string): string | null;
}

// ─── Validation helpers ──────────────────────────────────────────────

const UNSAFE_CHAR_RE = /[/\\:]/;

function isWhitespaceOnly(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    // space, tab, newline, carriage return
    if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) return false;
  }
  return true;
}

/**
 * Resolve the parent path for collision check. The engine surface as of
 * api.d.ts exposes `Entry.name` and `parentId` but not an accumulated
 * path string; we synthesize one by walking ancestors in the snapshot.
 * Returns `''` (root) if no ancestors.
 */
function parentPathFromSnapshot(
  snapshot: RenameStateSnapshot,
  entryId: EntryId,
): string | null {
  const self = snapshot.getById(entryId);
  if (self === null) return null;
  if (self.parentId === null) return '';
  const segments: string[] = [];
  let current: Entry | null = snapshot.getById(self.parentId);
  // Walk upward. Cap depth to prevent pathological cycles.
  let guard = 0;
  while (current !== null && guard < 10_000) {
    segments.push(current.name);
    if (current.parentId === null) break;
    current = snapshot.getById(current.parentId);
    guard += 1;
  }
  segments.reverse();
  return '/' + segments.join('/');
}

// ─── Hook ────────────────────────────────────────────────────────────

export function useRenameState(options: UseRenameStateOptions): RenameStateHandle {
  const { fx, snapshot, controlled, onCommit, onError } = options;

  // Controlled vs. uncontrolled via `useControlledState`. Controlled
  // mode plumbs through `controlled.value` / `controlled.onChange`.
  const [renameTargetId, setRenameTargetId] = useControlledState<EntryId | null>({
    value: controlled ? controlled.value : undefined,
    defaultValue: null,
    ...(controlled ? { onChange: controlled.onChange } : {}),
  });

  const [errorState, setErrorState] = useState<{
    readonly error: RenameFileSystemError | null;
    readonly revision: number;
  }>(() => ({ error: null, revision: 0 }));

  // A monotonic token prevents a late async result from closing a newer
  // rename session, including a new session that happens to reuse the id.
  const operationTokenRef = useRef(0);
  const targetRef = useRef(renameTargetId);
  targetRef.current = renameTargetId;
  const observedTargetRef = useRef<EntryId | null>(null);

  const clearError = useCallback(() => {
    setErrorState((current) =>
      current.error === null ? current : { ...current, error: null },
    );
  }, []);

  const startRename = useCallback(
    (id: EntryId) => {
      operationTokenRef.current += 1;
      clearError();
      setRenameTargetId(id);
    },
    [clearError, setRenameTargetId],
  );

  const cancel = useCallback(() => {
    operationTokenRef.current += 1;
    observedTargetRef.current = null;
    clearError();
    setRenameTargetId(null);
  }, [clearError, setRenameTargetId]);

  // Once a target has existed in the snapshot, its disappearance ends the
  // inline session. This avoids resurrecting a stale draft if an entry id is
  // later recycled, while still allowing a controlled target before hydration.
  useLayoutEffect(() => {
    if (renameTargetId === null) {
      observedTargetRef.current = null;
      return;
    }
    if (snapshot.getById(renameTargetId) !== null) {
      observedTargetRef.current = renameTargetId;
      return;
    }
    if (observedTargetRef.current !== renameTargetId) return;
    operationTokenRef.current += 1;
    observedTargetRef.current = null;
    clearError();
    setRenameTargetId(null);
  }, [snapshot, renameTargetId, clearError, setRenameTargetId]);

  const validate = useCallback(
    (newName: string): string | null => {
      // 1. Empty / whitespace-only.
      if (newName.length === 0 || isWhitespaceOnly(newName)) {
        return 'A file or folder name must be provided.';
      }
      // 2. Unsafe characters. Cross-platform: slash, backslash, colon.
      if (UNSAFE_CHAR_RE.test(newName)) {
        return 'The name contains invalid characters (/, \\, :).';
      }
      // 3. Sibling collision via `fx.getByUri` — skip if unavailable.
      if (renameTargetId === null) return null;
      const self = snapshot.getById(renameTargetId);
      // If the new name matches the current name exactly, no collision.
      if (self !== null && self.name === newName) return null;
      const getByUri = fx.getByUri;
      if (typeof getByUri !== 'function') return null;

      const parentPath = parentPathFromSnapshot(snapshot, renameTargetId);
      if (parentPath === null) return null;
      const candidate = {
        scheme: 'file',
        path: parentPath === '' ? `/${newName}` : `${parentPath}/${newName}`,
      };
      // `fx.getByUri` is async in the engine, but for the client-side
      // pre-check we treat it best-effort: if it returns a Promise we
      // can't await in the sync validator — just skip. Engine-side
      // collision is still surfaced via `errorTooltip` on commit.
      let result: unknown;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        result = (getByUri as (u: unknown) => unknown).call(fx, candidate);
      } catch {
        return null;
      }
      if (result && typeof (result as { then?: unknown }).then === 'function') {
        // Async — defer to engine-side error.
        return null;
      }
      if (result === null || result === undefined) return null;
      // Same id → not a collision (renaming a file to its existing name).
      const hit = result as { id?: unknown };
      if (typeof hit.id === 'number' && hit.id === renameTargetId) return null;
      return 'A file or folder with this name already exists.';
    },
    [fx, snapshot, renameTargetId],
  );

  const commit = useCallback(
    async (newName: string): Promise<void> => {
      const id = renameTargetId;
      if (id === null) return;
      // Trim is the caller's responsibility (the input does this before
      // calling commit); we also accept already-trimmed input safely.
      const validationErr = validate(newName);
      if (validationErr !== null) {
        const err: RenameFileSystemError = {
          code: 'EINVAL',
          message: validationErr,
        };
        setErrorState((current) => ({
          error: err,
          revision: current.revision + 1,
        }));
        onError?.(err);
        return;
      }
      const operationToken = operationTokenRef.current + 1;
      operationTokenRef.current = operationToken;
      try {
        const entry = await fx.rename(id, newName);
        if (
          operationTokenRef.current !== operationToken ||
          targetRef.current !== id
        ) {
          return;
        }
        clearError();
        observedTargetRef.current = null;
        setRenameTargetId(null);
        onCommit?.({ id, newName, entry });
      } catch (e) {
        if (
          operationTokenRef.current !== operationToken ||
          targetRef.current !== id
        ) {
          return;
        }
        const fse = asFileSystemError(e) ?? {
          code: 'EUNKNOWN',
          message: e instanceof Error ? e.message : String(e),
        };
        setErrorState((current) => ({
          error: fse,
          revision: current.revision + 1,
        }));
        onError?.(fse);
        // Intentionally DO NOT clear `renameTargetId` — the input stays
        // open so the user can retry or hit Esc.
      }
    },
    [
      fx,
      renameTargetId,
      validate,
      onCommit,
      onError,
      clearError,
      setRenameTargetId,
    ],
  );

  return useMemo<RenameStateHandle>(
    () => ({
      renameTargetId,
      lastError: errorState.error,
      errorRevision: errorState.revision,
      startRename,
      commit,
      cancel,
      validate,
    }),
    [renameTargetId, errorState, startRename, commit, cancel, validate],
  );
}
