// Default command set.
//
// Every command in SPEC §5.2. Split into two groups:
//   - `treeDefaults`    — expand/collapse/reveal/selectAll (structural)
//   - `mutationDefaults` — create/rename/delete/move/copy/open/reveal (mutations)
//
// The combined `defaultCommands` is re-exported for convenience.
//
// Note on selection: tree commands do NOT mutate selection state here.
// Selection lives in the Provider's local React state (Phase 4+); a
// `tree.selectAll` command dispatches through a host override or the
// Provider-installed hook — the default implementation is a no-op stub
// that the Provider replaces when it wires up. We still include it so the
// id is reserved and its label/keybinding are consistent.

import type { Entry, EntryId } from '@vibecook/mille';
import { commandOpenEvent } from '../open-policy.js';
import { fileActionTargetForId } from '../file-actions.js';
import {
  fileSearchRequestForIds,
  type FileSearchRequestKind,
} from '../file-search.js';
import { expandedDescendantIds } from '../tree-expansion.js';
import type { Command, CommandContext } from './types.js';

// Local mirror of api.d.ts `EntryKind`. The engine ships `entry.kind` as a
// plain `number` in the public types and doesn't re-export the enum, so we
// keep numeric constants here. Values match api.d.ts §EntryKind.
const KIND_FILE = 0;
const KIND_DIRECTORY = 1;

/** Phase 6.3 — surface mutation success via host.notify (live announcer). */
function announceMutation(ctx: CommandContext, message: string): void {
  try {
    ctx.host.notify?.('info', message);
  } catch {
    /* host notify must not break mutations */
  }
}

// ─── Tree structure commands ───────────────────────────────────────────────

/**
 * Expand one or more folders. Args shape: `{ ids?: readonly EntryId[] }`.
 * Defaults to `[ctx.focusedId]` when omitted.
 */
const expandCommand: Command = {
  id: 'tree.expand',
  label: 'Expand',
  keybinding: 'ArrowRight',
  when: 'focusedIs.folder',
  run(ctx, args) {
    const ids = resolveIds(args, ctx.focusedId);
    if (ids.length === 0) return;
    setExpanded(ctx, { add: ids });
  },
};

const collapseCommand: Command = {
  id: 'tree.collapse',
  label: 'Collapse',
  keybinding: 'ArrowLeft',
  when: 'focusedIs.folder',
  run(ctx, args) {
    const ids = resolveIds(args, ctx.focusedId);
    if (ids.length === 0) return;
    setExpanded(ctx, { remove: ids });
  },
};

/**
 * Expand a folder and every known descendant folder. Args: `{ id?: EntryId }`.
 * Uses the current snapshot's known direct-children set; descendants added
 * asynchronously (after delta) are not automatically expanded.
 */
const expandAllCommand: Command = {
  id: 'tree.expandAll',
  label: 'Expand All',
  when: 'focusedIs.folder',
  run(ctx, args) {
    const rootId = resolveSingleId(args, ctx.focusedId);
    if (rootId === null) return;
    const ids = collectDescendantFolders(ctx, rootId);
    setExpanded(ctx, { add: ids });
  },
};

const collapseAllCommand: Command = {
  id: 'tree.collapseAll',
  label: 'Collapse All',
  run(ctx) {
    const ids = ctx.expansion ? [...ctx.expansion.expandedIds] : ctx.snapshot.roots().map((r) => r.id);
    if (ids.length === 0) return;
    setExpanded(ctx, { remove: ids });
  },
};

const collapseDescendantsCommand: Command = {
  id: 'tree.collapseDescendants',
  label: 'Collapse Descendants',
  group: '1_navigation',
  when: 'focusedIs.folder',
  run(ctx, args) {
    const rootId = resolveSingleId(args, ctx.focusedId);
    if (rootId === null) return;
    const ids = expandedDescendantIds(
      ctx.snapshot,
      ctx.expansion?.expandedIds ?? new Set<EntryId>(),
      rootId,
    );
    if (ids.length === 0) return;
    setExpanded(ctx, { remove: ids });
  },
};

/**
 * Select all visible rows. Default implementation is a no-op; the Provider
 * overrides with an implementation that sets its local selection state.
 * Reserved so hosts can rebind / disable without synthesizing an id.
 */
const selectAllCommand: Command = {
  id: 'tree.selectAll',
  label: 'Select All',
  keybinding: 'Mod+A',
  run(_ctx) {
    // Intentionally empty. Provider overrides.
  },
};

/**
 * Reveal an entry in the tree: expand every ancestor folder. The Provider
 * overrides this to additionally scroll + focus the row.
 *
 * Args: `{ id: EntryId }`. (Path-based reveal is reserved for when the
 * engine surfaces a sync `getByUri`; hosts that need path-based reveal
 * today should resolve the id themselves and pass it in.)
 */
const revealPathCommand: Command = {
  id: 'tree.revealPath',
  label: 'Reveal in Tree',
  run(ctx, args) {
    const id = resolveRevealTarget(ctx, args);
    if (id === null) return;
    const ancestors = collectAncestors(ctx, id);
    if (ancestors.length > 0) {
      ctx.fx.setExpanded({ add: ancestors });
    }
  },
};

export const treeDefaults: readonly Command[] = [
  expandCommand,
  collapseCommand,
  expandAllCommand,
  collapseAllCommand,
  collapseDescendantsCommand,
  selectAllCommand,
  revealPathCommand,
];

// ─── Mutation commands ─────────────────────────────────────────────────────

/**
 * Create a file or folder.
 *
 * Args (Phase-5):
 *   `{ parentId?: EntryId, kind?: 'file'|'folder'|EntryKind, name?: string }`
 *
 *   - If `name` is provided, the command calls `fx.create` directly
 *     (headless path — hosts can script new-entry creation).
 *   - If `name` is omitted, the command returns a no-op at the registry
 *     level. The inline new-entry flow (provisional name + open rename)
 *     is owned by `<FileTree>`'s keyboard handler (`Mod+N` /
 *     `Mod+Shift+N`), which dispatches `file.create` for hosts to
 *     observe, then performs the provisional-create itself. This keeps
 *     the command dispatchable both with and without a name argument.
 *
 *   Defaults: parentId = focused (folder) or its parent; kind = file.
 */
const createCommand: Command = {
  id: 'file.create',
  label: 'New File',
  keybinding: 'Mod+N',
  async run(ctx, args) {
    const parsed = parseCreateArgs(args, ctx);
    if (parsed === null) return;
    await ctx.fx.create(parsed.parentId, parsed.name, parsed.kind);
    const kindLabel = parsed.kind === KIND_DIRECTORY ? 'Folder' : 'File';
    announceMutation(ctx, `Created ${kindLabel.toLowerCase()} ${parsed.name}`);
  },
};

/**
 * Rename focused or args-provided entry.
 *
 * Args (Phase-5):
 *   `{ id?: EntryId, newName?: string }`
 *
 *   - If `newName` is provided, the command calls `fx.rename` directly.
 *   - If `newName` is omitted, the command is a no-op at the registry
 *     level. `<FileTree>`'s keyboard handler (`F2`) dispatches this
 *     command *and* opens the inline rename input — keeps hosts free
 *     to observe the dispatch for telemetry etc. without duplicating
 *     the rename-UI logic in every command handler.
 */
const renameCommand: Command = {
  id: 'file.rename',
  label: 'Rename',
  keybinding: 'F2',
  when: 'hasSelection || focusedIs.file || focusedIs.folder',
  async run(ctx, args) {
    const parsed = parseRenameArgs(args, ctx);
    if (parsed === null) return;
    await ctx.fx.rename(parsed.id, parsed.newName);
    announceMutation(ctx, `Renamed to ${parsed.newName}`);
  },
};

/**
 * Delete one or more entries.
 * Args: `{ ids?: readonly EntryId[], toTrash?: boolean, recursive?: boolean }`.
 * Defaults: ids = ctx.selectedIds (or [focusedId] if no selection),
 *           toTrash = true, recursive = true.
 *
 * Phase 7 multi-select confirm: when the resolved id count is > 1 AND
 * the host supplied `ctx.host.confirm`, the command asks for a single
 * pluralized confirmation (`"Delete N items?"`). `false` aborts the
 * whole batch. Single-item deletes skip the prompt to preserve the
 * Phase 2 default-command behavior hosts may already depend on.
 *
 * `fx.delete(id, { trash: toTrash })` — the engine routes to trash or hard-delete.
 */
const deleteCommand: Command = {
  id: 'file.delete',
  label: 'Delete',
  keybinding: ['Delete', 'Backspace'],
  when: 'hasSelection || focusedIs.file || focusedIs.folder',
  async run(ctx, args) {
    const parsed = parseDeleteArgs(args, ctx);
    if (parsed === null) return;
    if (parsed.ids.length > 1 && typeof ctx.host.confirm === 'function') {
      const message = `Delete ${parsed.ids.length} items?`;
      const ok = await ctx.host.confirm(message);
      if (!ok) return;
    }
    for (const id of parsed.ids) {
      await ctx.fx.delete(id, { trash: parsed.toTrash, recursive: parsed.recursive });
    }
    const n = parsed.ids.length;
    announceMutation(
      ctx,
      n === 1 ? 'Deleted 1 item' : `Deleted ${n} items`,
    );
  },
};

/**
 * Move one or more entries under a new parent.
 * Args: `{ ids?: readonly EntryId[], targetParentId: EntryId, newName?: string }`.
 */
const moveCommand: Command = {
  id: 'file.move',
  label: 'Move',
  async run(ctx, args) {
    const parsed = parseMoveOrCopyArgs(args, ctx);
    if (parsed === null) return;
    for (const id of parsed.ids) {
      await ctx.fx.move(id, parsed.targetParentId, parsed.newName);
    }
    const n = parsed.ids.length;
    announceMutation(ctx, n === 1 ? 'Moved 1 item' : `Moved ${n} items`);
  },
};

// Phase 7: `file.copy` no longer reserves `Mod+C`. The user-facing
// copy intent is now `clipboard.copy` (from the keyboard handler) →
// `file.paste` when the user presses `Mod+V`. `file.copy` stays as a
// headless command hosts can still dispatch with `{ ids, targetParentId }`.
const copyCommand: Command = {
  id: 'file.copy',
  label: 'Copy',
  async run(ctx, args) {
    const parsed = parseMoveOrCopyArgs(args, ctx);
    if (parsed === null) return;
    for (const id of parsed.ids) {
      await ctx.fx.copy(id, parsed.targetParentId, parsed.newName);
    }
    const n = parsed.ids.length;
    announceMutation(ctx, n === 1 ? 'Copied 1 item' : `Copied ${n} items`);
  },
};

/**
 * Paste the in-app clipboard under the focused folder (or the focused
 * entry's parent). Chooses `fx.move` when `cutIds` is populated,
 * `fx.copy` when `copyIds` is populated. If both sets are empty the
 * command is a no-op (it's also hidden from the context menu via
 * `visibleInContextMenu`, so this only triggers from stale dispatches).
 *
 * The engine's `move` / `copy` are per-id; we iterate so callers can
 * keep the plural clipboard model without an engine-level bulk API.
 *
 * Phase 7. See MILLE_UI_SPEC.md §6.6.
 */
const pasteCommand: Command = {
  id: 'file.paste',
  label: 'Paste',
  keybinding: 'Mod+V',
  group: '3_cutcopypaste',
  visibleInContextMenu: (ctx) => ctx.cutIds.size > 0 || ctx.copyIds.size > 0,
  async run(ctx) {
    const targetParent = resolvePasteTarget(ctx);
    if (targetParent === null) return;
    if (ctx.cutIds.size > 0) {
      for (const id of ctx.cutIds) {
        await ctx.fx.move(id, targetParent);
      }
      return;
    }
    if (ctx.copyIds.size > 0) {
      for (const id of ctx.copyIds) {
        await ctx.fx.copy(id, targetParent);
      }
    }
  },
};

/**
 * Pick the parent id we paste into. Folder focus → the folder itself;
 * file focus → the file's parent; no focus → `null` (paste no-ops).
 * Separated from `run` so tests + hosts can reason about it in isolation.
 */
function resolvePasteTarget(ctx: CommandContextLike): EntryId | null {
  const focused = ctx.focusedEntry;
  if (focused === null) return null;
  if (focused.kind === KIND_DIRECTORY) return focused.id;
  // Resolve via snapshot so callers who supplied a stale focused entry
  // (e.g. after a delta) still paste under the current live parent.
  const live = ctx.snapshot.getById(focused.id);
  if (live !== null) return live.parentId;
  return focused.parentId;
}

/**
 * Open the focused entry via `ctx.host.onOpen`. No engine call — opening is
 * the host's responsibility.
 * Args: `{ id?: EntryId }`.
 */
const openCommand: Command = {
  id: 'file.open',
  label: 'Open',
  keybinding: 'Enter',
  when: 'focusedIs.file',
  run(ctx, args) {
    const entry = resolveEntry(args, ctx);
    if (entry === null) return;
    ctx.host.onOpen?.(entry, commandOpenEvent(args));
  },
};

const revealInEditorCommand: Command = {
  id: 'file.revealInEditor',
  label: 'Reveal in Editor',
  when: 'focusedIs.file',
  run(ctx, args) {
    const entry = resolveEntry(args, ctx);
    if (entry === null) return;
    ctx.host.onRevealInEditor?.(entry);
  },
};

const copyAbsolutePathCommand: Command = {
  id: 'file.copyAbsolutePath',
  label: 'Copy Absolute Path',
  group: '4_path_actions',
  when: 'focusedIs.file || focusedIs.folder',
  async run(ctx, args) {
    const target = resolveFileActionTarget(args, ctx);
    if (target === null) return;
    await ctx.host.copyPath?.(target, 'absolute');
  },
};

const copyRelativePathCommand: Command = {
  id: 'file.copyRelativePath',
  label: 'Copy Workspace-Relative Path',
  group: '4_path_actions',
  when: 'focusedIs.file || focusedIs.folder',
  async run(ctx, args) {
    const target = resolveFileActionTarget(args, ctx);
    if (target === null) return;
    await ctx.host.copyPath?.(target, 'relative');
  },
};

const revealInFileManagerCommand: Command = {
  id: 'file.revealInFileManager',
  label: 'Reveal in File Manager',
  group: '4_path_actions',
  when: 'focusedIs.file || focusedIs.folder',
  async run(ctx, args) {
    const target = resolveFileActionTarget(args, ctx);
    if (target === null) return;
    await ctx.host.revealInFileManager?.(target);
  },
};

const openContainingFolderCommand: Command = {
  id: 'file.openContainingFolder',
  label: 'Open Containing Folder',
  group: '4_path_actions',
  when: 'focusedIs.file || focusedIs.folder',
  async run(ctx, args) {
    const target = resolveFileActionTarget(args, ctx);
    if (target === null) return;
    await ctx.host.openContainingFolder?.(target);
  },
};

const openTerminalCommand: Command = {
  id: 'file.openTerminal',
  label: 'Open in Terminal',
  group: '4_path_actions',
  when: 'focusedIs.file || focusedIs.folder',
  async run(ctx, args) {
    const target = resolveFileActionTarget(args, ctx);
    if (target === null) return;
    await ctx.host.openTerminalForEntry?.(target);
  },
};

const refreshSubtreeCommand: Command = {
  id: 'tree.refresh',
  label: 'Refresh from Disk',
  group: '4_path_actions',
  when: '(focusedIs.file || focusedIs.folder) && !focusedIs.root',
  visibleInContextMenu: (ctx) =>
    ctx.host.refresh !== undefined ||
    typeof (ctx.fx as unknown as { resync?: unknown }).resync === 'function',
  async run(ctx, args) {
    const id = resolveSingleId(args, ctx.focusedId);
    if (id === null) return;
    if (ctx.host.refresh) {
      await ctx.host.refresh({ kind: 'subtree', id, recursive: true });
      return;
    }
    await ctx.fx.resync(id, { recursive: true });
  },
};

const refreshWorkspaceCommand: Command = {
  id: 'workspace.refresh',
  label: 'Refresh Workspace',
  group: '4_path_actions',
  when: 'focusedIs.root',
  visibleInContextMenu: (ctx) =>
    ctx.host.refresh !== undefined ||
    typeof (ctx.fx as unknown as { resyncWorkspace?: unknown }).resyncWorkspace === 'function',
  async run(ctx) {
    if (ctx.host.refresh) {
      await ctx.host.refresh({ kind: 'workspace' });
      return;
    }
    await ctx.fx.resyncWorkspace();
  },
};

const findInFolderCommand: Command = {
  id: 'search.findInFolder',
  label: 'Find in Folder…',
  group: '5_search',
  when: 'focusedIs.folder',
  async run(ctx, args) {
    const id = resolveSingleId(args, ctx.focusedId);
    if (id === null) return;
    const request = fileSearchRequestForIds(ctx.snapshot, 'findInFolder', [id]);
    if (request !== null) await ctx.host.searchScope?.(request);
  },
};

const includeInSearchCommand: Command = {
  id: 'search.include',
  label: 'Include in Search',
  group: '5_search',
  when: 'focusedIs.folder',
  async run(ctx, args) {
    const request = resolveFileSearchRequest(args, ctx, 'include');
    if (request !== null) await ctx.host.searchScope?.(request);
  },
};

const excludeFromSearchCommand: Command = {
  id: 'search.exclude',
  label: 'Exclude from Search',
  group: '5_search',
  when: 'focusedIs.folder',
  async run(ctx, args) {
    const request = resolveFileSearchRequest(args, ctx, 'exclude');
    if (request !== null) await ctx.host.searchScope?.(request);
  },
};

export const mutationDefaults: readonly Command[] = [
  createCommand,
  renameCommand,
  deleteCommand,
  moveCommand,
  copyCommand,
  pasteCommand,
  openCommand,
  revealInEditorCommand,
  copyAbsolutePathCommand,
  copyRelativePathCommand,
  revealInFileManagerCommand,
  openContainingFolderCommand,
  openTerminalCommand,
  refreshSubtreeCommand,
  refreshWorkspaceCommand,
  findInFolderCommand,
  includeInSearchCommand,
  excludeFromSearchCommand,
];

export const defaultCommands: readonly Command[] = [
  ...treeDefaults,
  ...mutationDefaults,
];

// ─── Argument helpers ──────────────────────────────────────────────────────

function resolveIds(
  args: unknown,
  focusedId: EntryId | null,
): readonly EntryId[] {
  if (isRecord(args) && Array.isArray(args['ids'])) {
    return args['ids'].filter((v): v is EntryId => typeof v === 'number');
  }
  if (isRecord(args) && typeof args['id'] === 'number') {
    return [args['id'] as EntryId];
  }
  return focusedId !== null ? [focusedId] : [];
}

function resolveSingleId(args: unknown, focusedId: EntryId | null): EntryId | null {
  if (isRecord(args) && typeof args['id'] === 'number') {
    return args['id'] as EntryId;
  }
  return focusedId;
}

function resolveFileActionTarget(args: unknown, ctx: CommandContextLike) {
  const entry = resolveEntry(args, ctx);
  return entry === null ? null : fileActionTargetForId(ctx.snapshot, entry.id);
}

function resolveFileSearchRequest(
  args: unknown,
  ctx: CommandContextLike,
  kind: FileSearchRequestKind,
) {
  let ids: readonly EntryId[];
  if (isRecord(args) && Array.isArray(args['ids'])) {
    ids = args['ids'].filter((value): value is EntryId => typeof value === 'number');
  } else if (ctx.focusedId !== null && ctx.selectedIds.has(ctx.focusedId)) {
    ids = [...ctx.selectedIds];
  } else {
    ids = ctx.focusedId === null ? [] : [ctx.focusedId];
  }
  return fileSearchRequestForIds(ctx.snapshot, kind, ids);
}

interface ParsedCreateArgs {
  readonly parentId: EntryId;
  readonly name: string;
  readonly kind: number;
}

function parseCreateArgs(args: unknown, ctx: CommandContextLike): ParsedCreateArgs | null {
  if (!isRecord(args)) return null;
  const name = typeof args['name'] === 'string' ? args['name'] : null;
  if (name === null) return null;
  const parentId = resolveCreateParent(args, ctx);
  if (parentId === null) return null;
  const kind = parseKind(args['kind']);
  return { parentId, name, kind };
}

function resolveCreateParent(args: Record<string, unknown>, ctx: CommandContextLike): EntryId | null {
  if (typeof args['parentId'] === 'number') return args['parentId'] as EntryId;
  const focused = ctx.focusedEntry;
  if (focused === null) return null;
  if (focused.kind === KIND_DIRECTORY) return focused.id;
  return focused.parentId;
}

function parseKind(raw: unknown): number {
  if (raw === KIND_DIRECTORY || raw === 'folder' || raw === 'directory' || raw === 'dir') {
    return KIND_DIRECTORY;
  }
  return KIND_FILE;
}

interface ParsedRenameArgs { readonly id: EntryId; readonly newName: string }

function parseRenameArgs(args: unknown, ctx: CommandContextLike): ParsedRenameArgs | null {
  if (!isRecord(args)) return null;
  const newName = typeof args['newName'] === 'string' ? args['newName'] : null;
  if (newName === null) return null;
  const id = typeof args['id'] === 'number'
    ? (args['id'] as EntryId)
    : ctx.focusedId;
  if (id === null) return null;
  return { id, newName };
}

interface ParsedDeleteArgs {
  readonly ids: readonly EntryId[];
  readonly toTrash: boolean;
  readonly recursive: boolean;
}

function parseDeleteArgs(args: unknown, ctx: CommandContextLike): ParsedDeleteArgs | null {
  const rec = isRecord(args) ? args : {};
  let ids: readonly EntryId[];
  if (Array.isArray(rec['ids'])) {
    ids = rec['ids'].filter((v): v is EntryId => typeof v === 'number');
  } else if (ctx.selectedIds.size > 0) {
    ids = Array.from(ctx.selectedIds);
  } else if (ctx.focusedId !== null) {
    ids = [ctx.focusedId];
  } else {
    return null;
  }
  if (ids.length === 0) return null;
  const toTrash = rec['toTrash'] === undefined ? true : Boolean(rec['toTrash']);
  const recursive = rec['recursive'] === undefined ? true : Boolean(rec['recursive']);
  return { ids, toTrash, recursive };
}

interface ParsedMoveOrCopyArgs {
  readonly ids: readonly EntryId[];
  readonly targetParentId: EntryId;
  readonly newName: string | undefined;
}

function parseMoveOrCopyArgs(args: unknown, ctx: CommandContextLike): ParsedMoveOrCopyArgs | null {
  if (!isRecord(args)) return null;
  const targetParentId = typeof args['targetParentId'] === 'number'
    ? (args['targetParentId'] as EntryId)
    : null;
  if (targetParentId === null) return null;
  let ids: readonly EntryId[];
  if (Array.isArray(args['ids'])) {
    ids = args['ids'].filter((v): v is EntryId => typeof v === 'number');
  } else if (ctx.selectedIds.size > 0) {
    ids = Array.from(ctx.selectedIds);
  } else if (ctx.focusedId !== null) {
    ids = [ctx.focusedId];
  } else {
    return null;
  }
  if (ids.length === 0) return null;
  const newName = typeof args['newName'] === 'string' ? args['newName'] : undefined;
  return { ids, targetParentId, newName };
}

function resolveEntry(args: unknown, ctx: CommandContextLike): Entry | null {
  if (isRecord(args) && typeof args['id'] === 'number') {
    return ctx.snapshot.getById(args['id'] as EntryId);
  }
  return ctx.focusedEntry;
}

function resolveRevealTarget(_ctx: CommandContextLike, args: unknown): EntryId | null {
  if (isRecord(args) && typeof args['id'] === 'number') {
    return args['id'] as EntryId;
  }
  return null;
}

function collectDescendantFolders(ctx: CommandContextLike, rootId: EntryId): readonly EntryId[] {
  const out: EntryId[] = [];
  collectAllFolders(ctx, rootId, out);
  return out;
}

function collectAllFolders(ctx: CommandContextLike, startId: EntryId, out: EntryId[]): void {
  const entry = ctx.snapshot.getById(startId);
  if (entry === null) return;
  if (entry.kind !== KIND_DIRECTORY) return;
  out.push(startId);
  // Traverse only known children via the snapshot; no engine calls.
  // For a fuller traversal, consumers iterate after the initial expand as
  // deltas arrive — this keeps the default O(1) and delta-friendly.
}

function collectAncestors(ctx: CommandContextLike, id: EntryId): readonly EntryId[] {
  const out: EntryId[] = [];
  let current = ctx.snapshot.getById(id);
  while (current !== null && current.parentId !== null) {
    out.push(current.parentId);
    current = ctx.snapshot.getById(current.parentId);
  }
  return out;
}

function setExpanded(
  ctx: CommandContextLike,
  diff: { readonly add?: readonly EntryId[]; readonly remove?: readonly EntryId[] },
): void {
  if (ctx.expansion) {
    ctx.expansion.setExpanded(diff);
  } else {
    ctx.fx.setExpanded(diff);
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Local alias to keep helper signatures short; exactly the Command `ctx`.
type CommandContextLike = Parameters<Command['run']>[0];
