// ViewportMirror working state — Phase 8 commit 8.1.
//
// Mutable, per-client mirror state that lives alongside a
// PortFileExplorer. Never exposed to consumers directly — a frozen
// ClientMirrorSnapshot is published on every delta (8.2) and the
// delta reducer (8.3) clones this working state before mutating.
//
// Per SPEC §4.9.1 the client mirror tracks:
//   - byId                — every entry the client has been told about
//   - children            — known child lists for expanded folders
//   - directChildCounts   — immediate child counts for every folder
//                           (populated even for un-expanded ones so the
//                           twisty caret renders correctly)
//   - pendingExpansions   — folders the client has asked to expand but
//                           whose children haven't arrived yet
//   - roots               — workspace roots in display order
//   - treeVersion         — the host's authoritative tree-version
//   - decorationVersion   — companion for Phase 9
//   - volatileSubtrees    — subtrees currently flagged dirty (SPEC §4.9.10)

/**
 * Mirror-local copy of an Entry record. Shape matches api.d.ts Entry
 * but with `undefined`-holes replaced by explicit `null` since the
 * wire representation (JSON for Phase 8) cannot round-trip `undefined`.
 */
export interface ClientEntry {
  id: number;
  parentId: number | null;
  name: string;
  /** 0=File, 1=Directory, 2=Symlink, 3=Unknown — mirrors EntryKind. */
  kind: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  symlinkTargetIsDir: boolean | null;
  pathSegments: string[] | null;
  isIgnored: boolean;
  isReadonly: boolean;
  isHidden: boolean;
}

/**
 * Mutable working state. The reducer (8.3) produces a new
 * MirrorWorking via cloneMirror() + mutations; the snapshot wrapper
 * (8.2) wraps it in a frozen view before handing it to consumers.
 */
export interface MirrorWorking {
  /** Every entry the client has been told about. */
  byId: Map<number, ClientEntry>;
  /** Known-to-the-client child lists for expanded folders. */
  children: Map<number, number[]>;
  /** Direct-child counts for every folder (even un-expanded ones). */
  directChildCounts: Map<number, number>;
  /** Folders the client has asked to expand but whose children haven't arrived yet. */
  pendingExpansions: Set<number>;
  /** Roots in display order. */
  roots: number[];
  /** Current tree version. */
  treeVersion: number;
  /** Current decoration version (Phase 9). */
  decorationVersion: number;
  /** Subtrees flagged volatile (SPEC §4.9.10). */
  volatileSubtrees: Set<number>;
}

/** Construct an empty working state. */
export function createMirror(): MirrorWorking {
  return {
    byId: new Map(),
    children: new Map(),
    directChildCounts: new Map(),
    pendingExpansions: new Set(),
    roots: [],
    treeVersion: 0,
    decorationVersion: 0,
    volatileSubtrees: new Set(),
  };
}

/**
 * Shallow clone the maps. ClientEntry records are treated as
 * immutable — the reducer replaces entries wholesale instead of
 * mutating them in place, so aliasing between the source and the
 * clone is safe.
 */
export function cloneMirror(m: MirrorWorking): MirrorWorking {
  return {
    byId: new Map(m.byId),
    children: new Map(m.children),
    directChildCounts: new Map(m.directChildCounts),
    pendingExpansions: new Set(m.pendingExpansions),
    roots: [...m.roots],
    treeVersion: m.treeVersion,
    decorationVersion: m.decorationVersion,
    volatileSubtrees: new Set(m.volatileSubtrees),
  };
}
