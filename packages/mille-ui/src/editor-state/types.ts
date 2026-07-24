// Phase 5.1 — editor open / dirty / active decoration types.
//
// Hosts push tab state from their editor model; the companion never
// tracks dirty buffers itself.

/**
 * One open editor / tab. Paths are workspace-relative with POSIX
 * separators (same convention as diagnostics and git status).
 */
export interface EditorTabState {
  readonly path: string;
  /** Unsaved buffer. Default false. */
  readonly dirty?: boolean;
  /**
   * Whether this tab is the active editor. When multiple tabs claim
   * active, the last one in the snapshot wins; hosts may also set
   * `EditorStateSnapshot.activePath` which overrides tab flags.
   */
  readonly active?: boolean;
  /** Optional display name for tooltips. */
  readonly title?: string;
}

/**
 * Full editor-state snapshot for decoration refresh.
 */
export interface EditorStateSnapshot {
  readonly open: readonly EditorTabState[];
  /**
   * Active-path override:
   * - non-empty string → sole active editor
   * - `null` or `''` → clear active on every path
   * - omitted/`undefined` → keep per-tab `active` flags
   */
  readonly activePath?: string | null;
}

/**
 * Host-supplied editor state source.
 *
 * `getEditorState(root)` returns the current open/dirty/active set.
 * `onChange` fires when tabs open, close, activate, or dirty-flip.
 */
export interface EditorStateClient {
  getEditorState(
    root: string,
  ): Promise<EditorStateSnapshot> | EditorStateSnapshot;
  onChange(cb: () => void): () => void;
}

/**
 * Resolved per-path flags after snapshot normalization.
 */
export interface EditorPathFlags {
  readonly open: boolean;
  readonly dirty: boolean;
  readonly active: boolean;
  /** Optional display name from the last tab that claimed this path. */
  readonly title?: string;
}

/**
 * Collapse a snapshot into a path → flags map. Later tabs override
 * earlier ones for the same path.
 *
 * `activePath` semantics:
 *   - non-empty string → that path is the sole active editor
 *   - `null` or `''` → clear active on every path
 *   - `undefined` (omitted) → keep per-tab `active` flags as-is
 */
export function normalizeEditorState(
  snapshot: EditorStateSnapshot,
): Map<string, EditorPathFlags> {
  const out = new Map<string, EditorPathFlags>();
  for (const tab of snapshot.open) {
    const prev = out.get(tab.path);
    const title =
      tab.title !== undefined && tab.title.length > 0
        ? tab.title
        : prev?.title;
    out.set(tab.path, {
      open: true,
      dirty: Boolean(tab.dirty) || Boolean(prev?.dirty),
      active: Boolean(tab.active) || Boolean(prev?.active),
      ...(title !== undefined ? { title } : {}),
    });
  }
  const activePath = snapshot.activePath;
  if (activePath === null || activePath === '') {
    // Explicit clear: drop active from every open path.
    for (const [path, flags] of out) {
      out.set(path, {
        open: flags.open,
        dirty: flags.dirty,
        active: false,
        ...(flags.title !== undefined ? { title: flags.title } : {}),
      });
    }
  } else if (typeof activePath === 'string' && activePath.length > 0) {
    for (const [path, flags] of out) {
      out.set(path, {
        open: flags.open,
        dirty: flags.dirty,
        active: path === activePath,
        ...(flags.title !== undefined ? { title: flags.title } : {}),
      });
    }
    // Active path not in open list still counts as open+active.
    if (!out.has(activePath)) {
      out.set(activePath, { open: true, dirty: false, active: true });
    }
  }
  return out;
}
