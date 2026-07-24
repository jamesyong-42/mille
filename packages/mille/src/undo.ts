// Browser-safe undo descriptor types and wire normalizers.
//
// Used by both the in-process client (`client.ts`, Node/native) and the
// port client (`client-port.ts`, renderer). Must NOT import `native.ts`,
// `node:*`, or any other Node-only module — Vite bundles the port entry
// for Electron's renderer and will fail if this pulls the native loader.

export type UndoKind = 'create' | 'rename' | 'move' | 'delete';

export interface UndoDescriptor {
  readonly id: number;
  readonly kind: UndoKind;
  readonly label: string;
  readonly undoable: boolean;
  readonly reason?: string;
  readonly timestampMs: number;
}

export interface UndoResult {
  readonly id: number;
  readonly kind: UndoKind;
  readonly label: string;
  readonly entryId?: number;
}

export function normalizeUndoKind(value: unknown): UndoKind | null {
  if (
    value === 'create' ||
    value === 'rename' ||
    value === 'move' ||
    value === 'delete'
  ) {
    return value;
  }
  return null;
}

/** Normalize a wire/native undo descriptor into the public shape. */
export function normalizeUndoDescriptor(raw: unknown): UndoDescriptor | null {
  if (raw === null || raw === undefined || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const kind = normalizeUndoKind(obj.kind);
  if (kind === null) return null;
  const reason = obj.reason;
  return {
    id: Number(obj.id),
    kind,
    label: String(obj.label ?? ''),
    undoable: Boolean(obj.undoable),
    ...(typeof reason === 'string' && reason.length > 0 ? { reason } : null),
    timestampMs: Number(obj.timestampMs ?? obj.timestamp_ms ?? 0),
  };
}

/** Normalize a wire/native undo result into the public shape. */
export function normalizeUndoResult(raw: unknown): UndoResult | null {
  if (raw === null || raw === undefined || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const kind = normalizeUndoKind(obj.kind);
  if (kind === null) return null;
  const entryId = obj.entryId ?? obj.entry_id;
  return {
    id: Number(obj.id),
    kind,
    label: String(obj.label ?? ''),
    ...(entryId !== undefined && entryId !== null
      ? { entryId: Number(entryId) }
      : null),
  };
}
