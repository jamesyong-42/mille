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
  /**
   * Absolute workspace root this tab belongs to (multi-root). When set,
   * view projectors and decorations resolve under this root instead of
   * a single default.
   */
  readonly rootPath?: string;
  /**
   * Known engine EntryId. Prefer this for multi-root Open Files views so
   * same-named files across roots cannot collide.
   */
  readonly entryId?: number;
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
   * Active-path override (workspace-relative). Prefer `activeEntryId` or
   * `activeRootPath` + `activePath` in multi-root workspaces so identical
   * relative paths across roots do not all become active.
   *
   * - non-empty string → match tabs (see activeEntryId / activeRootPath)
   * - `null` or `''` → clear active on every path
   * - omitted/`undefined` → keep per-tab `active` flags
   */
  readonly activePath?: string | null;
  /**
   * Multi-root: when set with `activePath`, only the tab under this absolute
   * workspace root is marked active.
   */
  readonly activeRootPath?: string | null;
  /**
   * Multi-root: preferred sole active tab identity. Wins over path matching.
   */
  readonly activeEntryId?: number | null;
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
  /**
   * Workspace-relative path for this tab. Present when the map key is a
   * multi-root identity key rather than a bare relative path.
   */
  readonly path?: string;
  readonly rootPath?: string;
  readonly entryId?: number;
}

/**
 * Stable map key for an editor tab. Prefers entryId, then rootPath+path,
 * so `/a/src/index.ts` and `/b/src/index.ts` never collapse.
 */
export function editorTabIdentityKey(
  tab: Pick<EditorTabState, 'path' | 'rootPath' | 'entryId'>,
): string {
  if (typeof tab.entryId === 'number' && Number.isFinite(tab.entryId)) {
    return `entry:${tab.entryId}`;
  }
  if (typeof tab.rootPath === 'string' && tab.rootPath.length > 0) {
    return `root:${tab.rootPath}\0${tab.path}`;
  }
  return tab.path;
}

/**
 * Recover the workspace-relative path from a normalize map key / flags.
 */
export function editorPathFromIdentity(
  key: string,
  flags?: EditorPathFlags,
): string {
  if (flags?.path !== undefined && flags.path.length > 0) return flags.path;
  if (key.startsWith('root:')) {
    const i = key.indexOf('\0');
    return i >= 0 ? key.slice(i + 1) : key;
  }
  if (key.startsWith('entry:')) return flags?.path ?? '';
  return key;
}

/**
 * Collapse a snapshot into an identity → flags map. Later tabs override
 * earlier ones for the **same identity key** (not bare relative path alone).
 *
 * Active override precedence:
 *   1. `activeEntryId` (number) → sole active tab by entry id
 *   2. `activePath` + optional `activeRootPath` → match path (and root)
 *   3. `activePath` alone → match path only when a single tab has that path;
 *      if multiple tabs share the path across roots, none is forced active
 *      unless `activeRootPath` or `activeEntryId` disambiguates
 *   4. `null`/`''` activePath → clear all active
 *   5. omitted → keep per-tab `active` flags
 */
export function normalizeEditorState(
  snapshot: EditorStateSnapshot,
): Map<string, EditorPathFlags> {
  const out = new Map<string, EditorPathFlags>();
  for (const tab of snapshot.open) {
    const key = editorTabIdentityKey(tab);
    const prev = out.get(key);
    const title =
      tab.title !== undefined && tab.title.length > 0
        ? tab.title
        : prev?.title;
    out.set(key, {
      open: true,
      dirty: Boolean(tab.dirty) || Boolean(prev?.dirty),
      active: Boolean(tab.active) || Boolean(prev?.active),
      path: tab.path,
      ...(tab.rootPath !== undefined
        ? { rootPath: tab.rootPath }
        : prev?.rootPath !== undefined
          ? { rootPath: prev.rootPath }
          : {}),
      ...(tab.entryId !== undefined
        ? { entryId: tab.entryId }
        : prev?.entryId !== undefined
          ? { entryId: prev.entryId }
          : {}),
      ...(title !== undefined ? { title } : {}),
    });
  }

  const activeEntryId = snapshot.activeEntryId;
  if (typeof activeEntryId === 'number' && Number.isFinite(activeEntryId)) {
    let matched = false;
    for (const [key, flags] of out) {
      const isActive = flags.entryId === activeEntryId;
      if (isActive) matched = true;
      out.set(key, { ...flags, active: isActive });
    }
    if (!matched) {
      const key = `entry:${activeEntryId}`;
      out.set(key, {
        open: true,
        dirty: false,
        active: true,
        entryId: activeEntryId,
        ...(typeof snapshot.activePath === 'string' && snapshot.activePath.length > 0
          ? { path: snapshot.activePath }
          : {}),
        ...(typeof snapshot.activeRootPath === 'string' &&
        snapshot.activeRootPath.length > 0
          ? { rootPath: snapshot.activeRootPath }
          : {}),
      });
    }
    return out;
  }

  const activePath = snapshot.activePath;
  if (activePath === null || activePath === '') {
    for (const [key, flags] of out) {
      out.set(key, { ...flags, active: false });
    }
    return out;
  }

  if (typeof activePath === 'string' && activePath.length > 0) {
    const activeRoot =
      typeof snapshot.activeRootPath === 'string' &&
      snapshot.activeRootPath.length > 0
        ? snapshot.activeRootPath
        : null;

    // Count path matches to detect multi-root ambiguity.
    const pathMatches: string[] = [];
    for (const [key, flags] of out) {
      const path = editorPathFromIdentity(key, flags);
      if (path !== activePath) continue;
      if (activeRoot !== null && flags.rootPath !== activeRoot) continue;
      pathMatches.push(key);
    }

    if (activeRoot !== null || pathMatches.length <= 1) {
      let matched = false;
      for (const [key, flags] of out) {
        const path = editorPathFromIdentity(key, flags);
        let isActive = path === activePath;
        if (isActive && activeRoot !== null) {
          isActive = flags.rootPath === activeRoot;
        }
        // Ambiguous bare path with multiple roots: already handled by
        // pathMatches.length > 1 branch below.
        if (isActive) matched = true;
        out.set(key, { ...flags, active: isActive });
      }
      if (!matched) {
        const key =
          activeRoot !== null
            ? editorTabIdentityKey({
                path: activePath,
                rootPath: activeRoot,
              })
            : activePath;
        out.set(key, {
          open: true,
          dirty: false,
          active: true,
          path: activePath,
          ...(activeRoot !== null ? { rootPath: activeRoot } : {}),
        });
      }
    } else {
      // Multiple tabs share activePath across roots and no disambiguator —
      // clear override rather than marking every root active.
      for (const [key, flags] of out) {
        out.set(key, { ...flags, active: false });
      }
    }
  }
  return out;
}
