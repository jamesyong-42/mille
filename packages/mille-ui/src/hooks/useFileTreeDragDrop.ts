// useFileTreeDragDrop — Phase 11 drag-source + drop-target helpers for
// the HTML5 native DnD system. Covers:
//
//   - Internal moves (tree → tree): `fx.move`, with optional multi-row
//     carry when the drag source is inside the current selection.
//   - External drag-out: sets the three MIME types from
//     MILLE_UI_SPEC.md §6.3 (`text/uri-list`,
//     `application/x-mille-ui-entries`, `application/vnd.claude.attachment`)
//     + a `text/plain` fallback.
//   - External drag-in from the OS: accepts `text/uri-list`, copies via
//     `fx.copy` when the engine supports source paths, falls back to
//     `fx.create` when it does not.
//   - Drop validation: cycle / cross-root / self-drop / gitignore
//     confirmation.
//   - `Alt` modifier → copy instead of move.
//   - Auto-expand-on-hover via `useAutoExpandDwell` (300 ms default).
//
// State contract:
//   - `draggingIds` / `dropTargetId` / `dropPosition` / `effect` live in
//     `useState` so rows re-render with the correct data-attrs. All
//     transient state (bounding rects, last source event) lives in refs
//     to avoid the per-`dragover` render storm that would otherwise
//     drop frames.

import { useCallback, useMemo, useRef, useState } from 'react';
import type { EntryId } from '@vibecook/mille';
import { useFileTreeContext } from './useFileTreeContext.js';
import type { FileTreeSnapshotLike } from '../components/types.js';
import { useAutoExpandDwell } from './useAutoExpandDwell.js';

// ─── Public option + return types ─────────────────────────────────────

/**
 * Effect applied to a successful drop. `'move'` is the default;
 * `'copy'` fires when the user holds Alt/Option during the drag.
 */
export type DragDropEffect = 'move' | 'copy';

/**
 * Where the pointer is inside the hovered row. The top 25 % of the row
 * is `'above'`, the bottom 25 % is `'below'`, and the middle 50 % is
 * `'self'`. For non-folder rows the UI may collapse `'self'` into the
 * parent's "between siblings" drop.
 */
export type DropPosition = 'self' | 'above' | 'below';

export interface DragDropValidateContext {
  readonly sourceIds: readonly EntryId[];
  readonly targetParentId: EntryId | null;
  readonly effect: DragDropEffect;
}

export interface DragDropValidationResult {
  readonly ok: boolean;
  readonly warning?: string;
  readonly requireConfirm?: boolean;
}

/**
 * Options forwarded from `<FileTreeProps.dragDrop>`. Deliberately
 * overlaps with the Phase-3 `DragDropOptions` type in
 * `components/types.ts` but adds Phase-11-specific fields (callbacks).
 */
export interface DragDropOptions {
  /** Allow tree ↔ tree drops. Default `true`. */
  readonly internal?: boolean;
  /** Emit external MIME types on drag-start. Default `true`. */
  readonly externalOut?: boolean;
  /**
   * Accept OS drops (`text/uri-list`). `'copy'` copies via the engine,
   * `'move'` attempts a move, `false` rejects external drops. Default
   * `'copy'`.
   */
  readonly externalIn?: DragDropEffect | false;
  /** Allow drops that cross workspace roots. Default `false`. */
  readonly crossRoot?: boolean;
  /** Existing destination behavior. Default `error`. */
  readonly collision?: 'error' | 'rename' | 'overwrite' | 'skip' | 'merge';
  /** Optional validation override — runs before cycle/cross-root checks. */
  readonly onDropValidate?: (
    ctx: DragDropValidateContext,
  ) => DragDropValidationResult;
  /**
   * Consumer-supplied confirmation dialog used for warnings (e.g. the
   * gitignore "drop anyway?" prompt). Sync or async; a falsy return
   * aborts the drop.
   */
  readonly onConfirm?: (message: string) => boolean | Promise<boolean>;
  /**
   * Per-item collision prompt for batch drops. Invoked only when the
   * destination already collides (exists or case-only conflict). Return a
   * policy or `{ policy, applyToAll: true }` to reuse it for remaining items.
   */
  readonly onCollision?: (
    request: {
      readonly sourcePath?: string;
      readonly sourceId?: number;
      readonly targetParentId: EntryId;
      readonly desiredName: string;
      readonly remaining: number;
      readonly status: 'exists' | 'case_conflict';
      readonly existingName?: string;
    },
  ) =>
    | 'error'
    | 'rename'
    | 'overwrite'
    | 'skip'
    | 'merge'
    | {
        readonly policy: 'error' | 'rename' | 'overwrite' | 'skip' | 'merge';
        readonly applyToAll?: boolean;
      }
    | Promise<
        | 'error'
        | 'rename'
        | 'overwrite'
        | 'skip'
        | 'merge'
        | {
            readonly policy: 'error' | 'rename' | 'overwrite' | 'skip' | 'merge';
            readonly applyToAll?: boolean;
          }
      >;
  /**
   * Surfaces drop/import failures. Without this, rejections still reject
   * the `onDrop` promise for hosts that await it.
   */
  readonly onDropError?: (error: unknown) => void;
  /** Dwell before an auto-expand fires on a hovered collapsed folder. */
  readonly autoExpandDelayMs?: number;
}

export interface DragDropState {
  readonly draggingIds: ReadonlySet<EntryId>;
  readonly dropTargetId: EntryId | null;
  readonly dropPosition: DropPosition | null;
  readonly effect: DragDropEffect;
}

/** Minimal DragEvent-like surface our handlers touch. */
type DragEventLike = {
  readonly clientY: number;
  readonly altKey: boolean;
  readonly currentTarget: EventTarget | null;
  readonly target: EventTarget | null;
  readonly dataTransfer: DataTransferLike | null;
  preventDefault(): void;
  stopPropagation(): void;
};

type DataTransferLike = {
  effectAllowed: string;
  dropEffect: string;
  readonly types: ReadonlyArray<string> | DOMStringList | readonly string[];
  readonly files?: FileList | { length: number; item?(i: number): File | null };
  setData(format: string, data: string): void;
  getData(format: string): string;
  // clearData is optional on happy-dom's shim.
  clearData?(format?: string): void;
};

export interface DragDropHandlers {
  onDragStart(rowId: EntryId, event: DragEventLike): void;
  onDragEnter(rowId: EntryId, event: DragEventLike): void;
  onDragOver(rowId: EntryId, event: DragEventLike): void;
  onDragLeave(rowId: EntryId, event: DragEventLike): void;
  onDrop(rowId: EntryId, event: DragEventLike): Promise<void>;
  onDragEnd(event: DragEventLike): void;
}

export interface UseFileTreeDragDropResult {
  readonly state: DragDropState;
  readonly handlers: DragDropHandlers;
}

// ─── Engine surface we touch (duck-typed) ─────────────────────────────

interface DragDropEngine {
  move(
    id: EntryId,
    newParentId: EntryId,
    newName?: string,
    options?: {
      readonly crossRoot?: boolean;
      readonly collision?: 'error' | 'rename' | 'overwrite' | 'skip' | 'merge';
    },
  ): Promise<{ id: EntryId } | unknown>;
  copy(
    id: EntryId,
    newParentId: EntryId,
    newName?: string,
    options?: {
      readonly crossRoot?: boolean;
      readonly collision?: 'error' | 'rename' | 'overwrite' | 'skip' | 'merge';
    },
  ): Promise<{ id: EntryId } | unknown>;
  setExpanded(diff: {
    readonly add?: readonly EntryId[];
    readonly remove?: readonly EntryId[];
  }): void;
  /**
   * Import an absolute filesystem path into a workspace folder. Required
   * for external drag-in; empty-file create placeholders are not used.
   */
  copyFromPath?(
    sourcePath: string,
    targetParentId: EntryId,
    newName?: string,
    options?: {
      readonly crossRoot?: boolean;
      readonly collision?: 'error' | 'rename' | 'overwrite' | 'skip' | 'merge';
    },
  ): Promise<unknown>;
  probeDestination?(
    parentId: EntryId,
    name: string,
  ): Promise<{
    status: string;
    existingName?: string;
    path?: string;
  }>;
  create?(
    parentId: EntryId,
    name: string,
    kind: number,
  ): Promise<unknown>;
}

// ─── Selection surface (read-only) ───────────────────────────────────

interface DragDropSelection {
  readonly selectedIds: ReadonlySet<EntryId>;
}

// ─── MIME constants ──────────────────────────────────────────────────

export const MIME_URI_LIST = 'text/uri-list';
export const MIME_MILLE_ENTRIES = 'application/x-mille-ui-entries';
export const MIME_CLAUDE_ATTACHMENT = 'application/vnd.claude.attachment';
export const MIME_TEXT_PLAIN = 'text/plain';

// ─── Helpers ─────────────────────────────────────────────────────────

const EMPTY_SET: ReadonlySet<EntryId> = new Set<EntryId>();

/** Resolve the path for an entry by walking parents to its root. */
function resolvePath(
  snapshot: FileTreeSnapshotLike,
  id: EntryId,
): string | null {
  const parts: string[] = [];
  let cur = snapshot.getById(id);
  if (cur === null) return null;
  while (cur !== null) {
    parts.push(cur.name);
    if (cur.parentId === null) break;
    const next = snapshot.getById(cur.parentId);
    if (next === null) break;
    cur = next;
  }
  return '/' + parts.reverse().join('/');
}

/** Walk up from `id` until we hit a root. Returns the root id. */
function rootOf(
  snapshot: FileTreeSnapshotLike,
  id: EntryId,
): EntryId | null {
  let cur = snapshot.getById(id);
  if (cur === null) return null;
  while (cur.parentId !== null) {
    const next = snapshot.getById(cur.parentId);
    if (next === null) break;
    cur = next;
  }
  return cur.id;
}

/**
 * True when `candidate` is `ancestor` or any of `ancestor`'s descendants
 * (i.e. dropping `ancestor` into `candidate` would form a cycle). Walks
 * parents from `candidate` up; snapshot lookup is O(1).
 */
function isSelfOrDescendant(
  snapshot: FileTreeSnapshotLike,
  ancestor: EntryId,
  candidate: EntryId,
): boolean {
  if (ancestor === candidate) return true;
  let cur = snapshot.getById(candidate);
  while (cur !== null && cur.parentId !== null) {
    if (cur.parentId === ancestor) return true;
    cur = snapshot.getById(cur.parentId);
  }
  return false;
}

/** Small bitset for `DataTransfer.types` — happy-dom returns a plain array. */
function hasType(dt: DataTransferLike, name: string): boolean {
  const types = dt.types;
  if (!types) return false;
  // DOMStringList.contains / Array.includes — both exist in happy-dom,
  // but the shape differs. Iterate defensively.
  const len = (types as { length?: number }).length ?? 0;
  for (let i = 0; i < len; i += 1) {
    const v = (types as unknown as { [index: number]: string })[i];
    if (v === name) return true;
  }
  return false;
}

// EntryKind numeric enum mirrors @vibecook/mille.
const KIND_FILE = 0;
const KIND_DIRECTORY = 1;

// ─── Main hook ───────────────────────────────────────────────────────

/**
 * Drag-drop coordinator for `<FileTree>` rows. Row components call the
 * returned `handlers` on their native drag events; the returned `state`
 * drives the `data-mille-*` attrs on each row.
 */
export function useFileTreeDragDrop(
  options: DragDropOptions = {},
  selection?: DragDropSelection,
): UseFileTreeDragDropResult {
  const {
    internal = true,
    externalOut = true,
    externalIn = 'copy',
    crossRoot = false,
    collision = 'error',
    onDropValidate,
    onConfirm,
    onCollision,
    onDropError,
    autoExpandDelayMs = 300,
  } = options;

  type CollisionChoice = 'error' | 'rename' | 'overwrite' | 'skip' | 'merge';

  async function probeCollision(
    targetParentId: EntryId,
    desiredName: string,
  ): Promise<{ status: 'free' | 'exists' | 'case_conflict'; existingName?: string }> {
    if (typeof fx.probeDestination === 'function') {
      try {
        const probe = await fx.probeDestination(targetParentId, desiredName);
        if (probe.status === 'exists' || probe.status === 'case_conflict') {
          return {
            status: probe.status,
            ...(probe.existingName !== undefined
              ? { existingName: probe.existingName }
              : null),
          };
        }
        return { status: 'free' };
      } catch {
        // Fall through to snapshot heuristic.
      }
    }
    // Snapshot heuristic when probe is unavailable / children already mirrored.
    const snap = snapshotRef.current;
    const maybeChildrenOf = (snap as unknown as {
      childrenOf?: (id: EntryId) => readonly EntryId[];
    }).childrenOf;
    const childIds =
      typeof maybeChildrenOf === 'function' ? maybeChildrenOf(targetParentId) : [];
    for (const id of childIds) {
      const child = snap.getById(id);
      if (child === null) continue;
      if (child.name === desiredName) {
        return { status: 'exists', existingName: child.name };
      }
      if (child.name.toLowerCase() === desiredName.toLowerCase()) {
        return { status: 'case_conflict', existingName: child.name };
      }
    }
    return { status: 'free' };
  }

  async function resolveItemCollision(
    batch: { applied: CollisionChoice | null },
    request: {
      readonly sourcePath?: string;
      readonly sourceId?: number;
      readonly targetParentId: EntryId;
      readonly desiredName: string;
      readonly remaining: number;
    },
  ): Promise<CollisionChoice> {
    if (batch.applied !== null) return batch.applied;
    // Only prompt when the destination actually collides.
    const probe = await probeCollision(request.targetParentId, request.desiredName);
    if (probe.status === 'free') return collision;
    if (typeof onCollision !== 'function') return collision;
    const result = await onCollision({
      ...request,
      status: probe.status,
      ...(probe.existingName !== undefined ? { existingName: probe.existingName } : null),
    });
    if (typeof result === 'string') return result;
    if (result && typeof result === 'object' && typeof result.policy === 'string') {
      if (result.applyToAll === true) {
        batch.applied = result.policy;
      }
      return result.policy;
    }
    return collision;
  }

  function reportDropError(error: unknown): void {
    if (typeof onDropError === 'function') {
      try {
        onDropError(error);
      } catch {
        /* host error handler must not break drop cleanup */
      }
    }
  }

  const ctx = useFileTreeContext();
  const fx = ctx.fx as unknown as DragDropEngine;
  const snapshot = ctx.snapshot as unknown as FileTreeSnapshotLike;

  // The latest selection captured on each render — used by drag-start
  // to decide if the source belongs to the selection (multi-row carry).
  const selectedIdsRef = useRef<ReadonlySet<EntryId>>(
    selection?.selectedIds ?? EMPTY_SET,
  );
  selectedIdsRef.current = selection?.selectedIds ?? EMPTY_SET;

  // Snapshot ref so handlers always read the latest structure without
  // being re-created on every snapshot change (which would re-bind
  // listeners on every row).
  const snapshotRef = useRef<FileTreeSnapshotLike>(snapshot);
  snapshotRef.current = snapshot;

  // ─── Reactive bits ─────────────────────────────────────────────────

  const [draggingIds, setDraggingIds] = useState<ReadonlySet<EntryId>>(
    EMPTY_SET,
  );
  const [dropTargetId, setDropTargetId] = useState<EntryId | null>(null);
  const [dropPosition, setDropPosition] = useState<DropPosition | null>(null);
  const [effect, setEffect] = useState<DragDropEffect>('move');

  // ─── Refs (per-drag transient state) ───────────────────────────────

  // Source id set at drag start. Mirrors `draggingIds` but avoids a
  // closure snapshot lag during the same drag's `dragover` cadence.
  const sourceIdsRef = useRef<ReadonlySet<EntryId>>(EMPTY_SET);

  // Tracks whether the drag originated from this tree. `dragstart`
  // within our rows sets this to `true`; cleared on `dragend`.
  const isInternalDragRef = useRef<boolean>(false);

  const autoExpand = useAutoExpandDwell({
    delayMs: autoExpandDelayMs,
    onExpand: (id) => {
      // Only expand folders. A no-op elsewhere.
      const e = snapshotRef.current.getById(id);
      if (e === null) return;
      if (e.kind !== KIND_DIRECTORY) return;
      try {
        fx.setExpanded({ add: [id] });
      } catch {
        /* swallow — next drag event will reconcile */
      }
    },
  });

  // ─── Drag start ────────────────────────────────────────────────────

  const onDragStart = useCallback(
    (rowId: EntryId, event: DragEventLike): void => {
      if (internal === false && externalOut === false) return;
      const dt = event.dataTransfer;
      if (dt === null) return;

      // If the source is part of the current selection, carry the full
      // set; otherwise carry just the source row.
      const sel = selectedIdsRef.current;
      const ids: EntryId[] =
        sel.size > 0 && sel.has(rowId) ? Array.from(sel) : [rowId];

      const idsSet: ReadonlySet<EntryId> = new Set(ids);
      sourceIdsRef.current = idsSet;
      isInternalDragRef.current = true;

      setDraggingIds(idsSet);

      if (externalOut !== false) {
        // Resolve paths for every source id; skip any that can't be
        // resolved (shouldn't normally happen).
        const paths: string[] = [];
        for (const id of ids) {
          const p = resolvePath(snapshotRef.current, id);
          if (p !== null) paths.push(p);
        }

        const uriList = paths.map((p) => `file://${p}`).join('\r\n');
        const payload = JSON.stringify({ ids, paths });

        try {
          dt.setData(MIME_URI_LIST, uriList);
        } catch {
          /* happy-dom may throw on unknown formats; ignore */
        }
        try {
          dt.setData(MIME_MILLE_ENTRIES, payload);
        } catch {
          /* ignore */
        }
        try {
          dt.setData(MIME_CLAUDE_ATTACHMENT, payload);
        } catch {
          /* ignore */
        }
        try {
          dt.setData(MIME_TEXT_PLAIN, paths.join('\n'));
        } catch {
          /* ignore */
        }

        dt.effectAllowed = 'copyMove';
      } else {
        dt.effectAllowed = 'move';
      }
    },
    [internal, externalOut],
  );

  // ─── Drop-position classifier ──────────────────────────────────────

  /**
   * Classify a pointer location inside a row's bounding rect into one
   * of the three drop zones. Uses the `currentTarget`'s
   * `getBoundingClientRect()` if available; falls back to `'self'` when
   * geometry is missing (happy-dom sometimes returns zero-sized rects).
   */
  function classifyDropPosition(event: DragEventLike): DropPosition {
    const target = event.currentTarget as {
      getBoundingClientRect?: () => { top: number; height: number };
    } | null;
    if (!target || typeof target.getBoundingClientRect !== 'function') {
      return 'self';
    }
    const rect = target.getBoundingClientRect();
    const height = rect.height || 0;
    if (height <= 0) return 'self';
    const y = event.clientY - rect.top;
    const ratio = y / height;
    if (ratio < 0.25) return 'above';
    if (ratio > 0.75) return 'below';
    return 'self';
  }

  // ─── Drop-target resolver ──────────────────────────────────────────

  /**
   * Given the hovered row + drop position, return the actual
   * `targetParentId` a drop would create children under. `'self'` on a
   * folder → that folder; `'above'` / `'below'` → the hovered row's
   * parent (sibling drop). `'self'` on a file → the file's parent
   * (fall-through).
   */
  function resolveTargetParent(
    snap: FileTreeSnapshotLike,
    rowId: EntryId,
    position: DropPosition,
  ): EntryId | null {
    const row = snap.getById(rowId);
    if (row === null) return null;
    if (position === 'above' || position === 'below') {
      return row.parentId;
    }
    // `'self'` — folder drop-in, or file fallback to parent.
    if (row.kind === KIND_DIRECTORY) return row.id;
    return row.parentId;
  }

  // ─── Validation ────────────────────────────────────────────────────

  /**
   * Synchronous validation used by both `dragover` (to set
   * `effectAllowed = 'none'` on reject) and `drop` (to short-circuit).
   * The gitignore confirmation prompt is async and therefore re-run on
   * `drop` only.
   */
  function validateSync(
    sourceIds: readonly EntryId[],
    targetRowId: EntryId,
    position: DropPosition,
    nextEffect: DragDropEffect,
  ): { ok: boolean; targetParentId: EntryId | null } {
    const snap = snapshotRef.current;
    const targetParentId = resolveTargetParent(snap, targetRowId, position);

    if (targetParentId === null && position === 'self') {
      // Trying to drop `'self'` onto a file whose parent is also null
      // (root file) — invalid; there's nowhere to land.
      return { ok: false, targetParentId: null };
    }

    // Self-drop: dropping on the source row itself, position self.
    if (
      position === 'self' &&
      sourceIds.length === 1 &&
      sourceIds[0] === targetRowId
    ) {
      return { ok: false, targetParentId };
    }

    // Cycle prevention: target must not be the source or any descendant.
    for (const sid of sourceIds) {
      if (targetParentId !== null && isSelfOrDescendant(snap, sid, targetParentId)) {
        return { ok: false, targetParentId };
      }
    }

    // Cross-root check.
    if (crossRoot === false && targetParentId !== null) {
      const targetRoot = rootOf(snap, targetParentId);
      for (const sid of sourceIds) {
        const sroot = rootOf(snap, sid);
        if (sroot !== null && targetRoot !== null && sroot !== targetRoot) {
          return { ok: false, targetParentId };
        }
      }
    }

    // Host override — runs last so built-in checks can't be bypassed.
    if (onDropValidate) {
      const res = onDropValidate({
        sourceIds,
        targetParentId,
        effect: nextEffect,
      });
      if (!res.ok) return { ok: false, targetParentId };
    }

    return { ok: true, targetParentId };
  }

  // ─── Gitignore-warning check (used only on drop) ───────────────────

  /**
   * Look at the target folder's decorations and the source's ignored
   * flag to decide whether the gitignore confirmation should fire.
   * Heuristic: if the target folder has a decoration marked as
   * "ignored" (fontWeight 0, matching the engine convention), or if
   * the source's name carries a dotfile-style prefix the target
   * conventionally excludes, ask the host to confirm.
   */
  async function gitignoreGate(
    sourceIds: readonly EntryId[],
    targetParentId: EntryId | null,
  ): Promise<boolean> {
    if (targetParentId === null) return true;
    if (!onConfirm) return true;
    const snap = snapshotRef.current;
    const decorations = snap.getDecorations(targetParentId);
    let targetIgnored = false;
    for (const d of decorations) {
      const asRecord = d as unknown as { fontWeight?: number; tooltip?: string };
      if (asRecord.fontWeight === 0) {
        targetIgnored = true;
        break;
      }
      if (
        typeof asRecord.tooltip === 'string' &&
        asRecord.tooltip.toLowerCase().includes('ignored')
      ) {
        targetIgnored = true;
        break;
      }
    }
    if (!targetIgnored) {
      // Also check the source: some engines flag the source itself as
      // gitignored (entry.isIgnored). Preserve the warning convention.
      let anySourceIgnored = false;
      for (const sid of sourceIds) {
        const s = snap.getById(sid);
        if (s !== null && s.isIgnored === true) {
          anySourceIgnored = true;
          break;
        }
      }
      if (!anySourceIgnored) return true;
    }
    const ok = await onConfirm(
      'Target folder is gitignored. Move anyway?',
    );
    return Boolean(ok);
  }

  // ─── Event handlers ────────────────────────────────────────────────

  const onDragEnter = useCallback(
    (rowId: EntryId, event: DragEventLike): void => {
      const dt = event.dataTransfer;
      if (dt === null) return;

      const isExternal = !isInternalDragRef.current;
      if (isExternal) {
        if (externalIn === false) return;
        if (!hasType(dt, MIME_URI_LIST) && !hasType(dt, MIME_MILLE_ENTRIES)) {
          return;
        }
      } else if (internal === false) {
        return;
      }

      event.preventDefault();

      const position = classifyDropPosition(event);
      const nextEffect: DragDropEffect =
        event.altKey || externalIn === 'copy' && isExternal ? 'copy' : 'move';

      setDropTargetId(rowId);
      setDropPosition(position);
      setEffect(nextEffect);

      // Auto-expand dwell: fires only when hovering a collapsed folder
      // in the 'self' zone.
      if (position === 'self') {
        const row = snapshotRef.current.getById(rowId);
        if (row !== null && row.kind === KIND_DIRECTORY) {
          autoExpand.track(rowId);
          return;
        }
      }
      autoExpand.clear();
    },
    [internal, externalIn, autoExpand],
  );

  const onDragOver = useCallback(
    (rowId: EntryId, event: DragEventLike): void => {
      const dt = event.dataTransfer;
      if (dt === null) return;

      const isExternal = !isInternalDragRef.current;
      if (isExternal) {
        if (externalIn === false) {
          dt.dropEffect = 'none';
          return;
        }
      } else if (internal === false) {
        dt.dropEffect = 'none';
        return;
      }

      // `preventDefault` is what tells the browser this is a valid drop
      // target; without it the subsequent `drop` never fires.
      event.preventDefault();

      const position = classifyDropPosition(event);
      const nextEffect: DragDropEffect =
        isExternal
          ? externalIn === 'move'
            ? 'move'
            : 'copy'
          : event.altKey
            ? 'copy'
            : 'move';

      // Sync validate — purely id-level.
      const sourceIds = Array.from(sourceIdsRef.current);
      if (!isExternal && sourceIds.length > 0) {
        const { ok } = validateSync(sourceIds, rowId, position, nextEffect);
        if (!ok) {
          dt.dropEffect = 'none';
          setDropTargetId(rowId);
          setDropPosition(position);
          setEffect(nextEffect);
          return;
        }
      }

      dt.dropEffect = nextEffect;

      if (dropTargetId !== rowId) setDropTargetId(rowId);
      if (dropPosition !== position) setDropPosition(position);
      if (effect !== nextEffect) setEffect(nextEffect);

      if (position === 'self') {
        const row = snapshotRef.current.getById(rowId);
        if (row !== null && row.kind === KIND_DIRECTORY) {
          autoExpand.track(rowId);
          return;
        }
      }
      autoExpand.clear();
    },
    [internal, externalIn, autoExpand, dropTargetId, dropPosition, effect],
  );

  const onDragLeave = useCallback(
    (_rowId: EntryId, _event: DragEventLike): void => {
      // HTML5 DnD fires `dragleave` both on child-enter and real leave.
      // We rely on the next `dragenter` / `dragover` to re-establish
      // target state; just cancel the dwell here.
      autoExpand.clear();
    },
    [autoExpand],
  );

  const onDrop = useCallback(
    async (rowId: EntryId, event: DragEventLike): Promise<void> => {
      const dt = event.dataTransfer;
      if (dt === null) return;

      event.preventDefault();
      event.stopPropagation();

      const position = dropPosition ?? classifyDropPosition(event);
      const isExternal = !isInternalDragRef.current;

      autoExpand.clear();

      // Reset visual state immediately — keeping the drop-target attrs
      // lingering after drop is a VS Code / Finder convention violation.
      setDropTargetId(null);
      setDropPosition(null);

      if (isExternal) {
        if (externalIn === false) return;
        await handleExternalDrop(rowId, position, event);
        return;
      }

      if (internal === false) return;

      const sourceIds = Array.from(sourceIdsRef.current);
      if (sourceIds.length === 0) return;

      const nextEffect: DragDropEffect = event.altKey ? 'copy' : 'move';
      const { ok, targetParentId } = validateSync(
        sourceIds,
        rowId,
        position,
        nextEffect,
      );
      if (!ok) return;
      if (targetParentId === null) return;

      // Async gitignore confirmation.
      const proceed = await gitignoreGate(sourceIds, targetParentId);
      if (!proceed) return;

      try {
        const batch = { applied: null as CollisionChoice | null };
        if (nextEffect === 'copy') {
          for (let index = 0; index < sourceIds.length; index += 1) {
            const id = sourceIds[index]!;
            const entry = snapshotRef.current.getById(id);
            const itemCollision = await resolveItemCollision(batch, {
              sourceId: id,
              targetParentId,
              desiredName: entry?.name ?? String(id),
              remaining: sourceIds.length - index - 1,
            });
            await fx.copy(id, targetParentId, undefined, {
              crossRoot,
              collision: itemCollision,
            });
          }
        } else {
          for (let index = 0; index < sourceIds.length; index += 1) {
            const id = sourceIds[index]!;
            // Skip no-op moves (source already has this parent).
            const e = snapshotRef.current.getById(id);
            if (e !== null && e.parentId === targetParentId) continue;
            const itemCollision = await resolveItemCollision(batch, {
              sourceId: id,
              targetParentId,
              desiredName: e?.name ?? String(id),
              remaining: sourceIds.length - index - 1,
            });
            await fx.move(id, targetParentId, undefined, {
              crossRoot,
              collision: itemCollision,
            });
          }
        }
      } catch (error) {
        // Re-throw so FileTree's onDrop handler reports via onDropError once.
        // Do not call reportDropError here — that double-fires with FileTree.
        throw error;
      } finally {
        // Clear dragging state even after failure so the UI is not stuck.
        setDraggingIds(EMPTY_SET);
        sourceIdsRef.current = EMPTY_SET;
        isInternalDragRef.current = false;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [internal, externalIn, dropPosition, autoExpand],
  );

  /** Handle a drop where the source is NOT from this tree. */
  async function handleExternalDrop(
    rowId: EntryId,
    position: DropPosition,
    event: DragEventLike,
  ): Promise<void> {
    const dt = event.dataTransfer;
    if (dt === null) return;

    // Only accept on folders in 'self' — external drops between siblings
    // of an unrelated tree don't really make sense.
    const targetParentId = resolveTargetParent(
      snapshotRef.current,
      rowId,
      position === 'above' || position === 'below' ? position : 'self',
    );
    if (targetParentId === null) return;

    const mille = dt.getData(MIME_MILLE_ENTRIES);
    if (mille && mille.length > 0) {
      // Cross-window mille drag-in. Parse and treat as internal-ish;
      // we only have paths so we fall through to the copy path.
      try {
        const parsed = JSON.parse(mille) as { paths?: string[] };
        if (Array.isArray(parsed.paths)) {
          await copyFromExternalPaths(parsed.paths, targetParentId);
          return;
        }
      } catch {
        /* fall through to uri-list */
      }
    }

    const uriList = dt.getData(MIME_URI_LIST);
    if (uriList && uriList.length > 0) {
      const paths: string[] = [];
      const lines = uriList.split(/\r\n|\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        if (trimmed.startsWith('#')) continue;
        if (trimmed.startsWith('file://')) {
          paths.push(decodeURIComponent(trimmed.slice('file://'.length)));
        } else {
          paths.push(trimmed);
        }
      }
      if (paths.length > 0) {
        await copyFromExternalPaths(paths, targetParentId);
      }
    }
  }

  async function copyFromExternalPaths(
    paths: readonly string[],
    targetParentId: EntryId,
  ): Promise<void> {
    // Real content import requires `copyFromPath`. Empty-file create
    // placeholders are intentionally not used — they hide data loss.
    if (typeof fx.copyFromPath !== 'function') {
      throw new Error(
        'external drag-in requires fx.copyFromPath(sourcePath, parentId)',
      );
    }
    const failures: Array<{ path: string; error: unknown }> = [];
    const batch = { applied: null as CollisionChoice | null };
    for (let index = 0; index < paths.length; index += 1) {
      const p = paths[index]!;
      const desiredName = p.split(/[/\\]/).filter(Boolean).pop() ?? 'imported';
      try {
        const itemCollision = await resolveItemCollision(batch, {
          sourcePath: p,
          targetParentId,
          desiredName,
          remaining: paths.length - index - 1,
        });
        await fx.copyFromPath(p, targetParentId, undefined, {
          collision: itemCollision,
        });
      } catch (error) {
        failures.push({ path: p, error });
      }
    }
    if (failures.length === 0) return;
    const detail = failures
      .map(({ path, error }) => {
        const message =
          error instanceof Error
            ? error.message
            : typeof error === 'string'
              ? error
              : 'unknown error';
        return `${path}: ${message}`;
      })
      .join('; ');
    const err = new Error(
      `external import failed for ${failures.length} of ${paths.length} path(s): ${detail}`,
    );
    (err as { failures?: typeof failures }).failures = failures;
    throw err;
  }

  const onDragEnd = useCallback(
    (_event: DragEventLike): void => {
      setDraggingIds(EMPTY_SET);
      setDropTargetId(null);
      setDropPosition(null);
      setEffect('move');
      sourceIdsRef.current = EMPTY_SET;
      isInternalDragRef.current = false;
      autoExpand.clear();
    },
    [autoExpand],
  );

  const state = useMemo<DragDropState>(
    () => ({ draggingIds, dropTargetId, dropPosition, effect }),
    [draggingIds, dropTargetId, dropPosition, effect],
  );

  const handlers = useMemo<DragDropHandlers>(
    () => ({
      onDragStart,
      onDragEnter,
      onDragOver,
      onDragLeave,
      onDrop,
      onDragEnd,
    }),
    [onDragStart, onDragEnter, onDragOver, onDragLeave, onDrop, onDragEnd],
  );

  return { state, handlers };
}
