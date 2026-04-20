// useFileTreeKeyboard — keyboard handler factory for the tree container.
//
// Implements the keyboard map from MILLE_UI_SPEC.md §6.1. Returns a
// single `onKeyDown(event)` that the tree container wires up. Internally
// uses Phase 2's `parseKeybinding` + `matchKeybinding` for consistency
// with the command registry's binding lookup.
//
// Behavior fork: if the provider supplies a command registry, key-driven
// actions dispatch through `commands.dispatch(id, args)`. Otherwise we
// fall back to calling the supplied side-effect callbacks directly
// (this is how tests without a registry still exercise keyboard nav).
//
// The handler is designed to be idempotent and read-only on `focusedId`
// / `selectedIds` — those are updated via the `selection` handle passed
// in by `FileTree`. Similarly, expansion deltas go through `expanded`.

import { useCallback, useMemo } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { EntryId, VisibleRow } from '@vibecook/mille';
import {
  matchKeybinding,
  parseKeybinding,
  type KeyboardEventLike,
} from '../commands/keybinding.js';
import type { CommandRegistryHandle } from '../types.js';
import type { FileTreeSelectionHandle } from './useFileTreeSelection.js';
import { useTypeahead, type TypeaheadVisibleRow } from './useTypeahead.js';

/**
 * Phase 7 — clipboard wiring passed from `<FileTree>`. The tree owns the
 * real state via `useClipboardState`; the keyboard hook reads `cutIds`
 * to decide whether to suppress typeahead fallthrough and calls the
 * setters for Mod+C / Mod+X. `Mod+V` dispatches `file.paste` through
 * the registry — the registry's `run` consults `cutIds`/`copyIds` via
 * the `CommandContext`.
 */
export interface KeyboardClipboardActions {
  readonly cutIds: ReadonlySet<EntryId>;
  readonly copyIds: ReadonlySet<EntryId>;
  markCut(ids: Iterable<EntryId>): void;
  markCopy(ids: Iterable<EntryId>): void;
  clear(): void;
}

export interface ViewportKeyboardActions {
  /** Scroll one viewport and return the new top row id (may equal the last). */
  pageUp(fromId: EntryId | null): EntryId | null;
  /** Scroll one viewport and return the new bottom row id. */
  pageDown(fromId: EntryId | null): EntryId | null;
}

export interface KeyboardExpansionActions {
  /** Is this id currently expanded? */
  isExpanded(id: EntryId): boolean;
  /** Expand a folder (local state + engine bridge). */
  expand(id: EntryId): void;
  /** Collapse a folder. */
  collapse(id: EntryId): void;
  /** Toggle the expansion for a folder. */
  toggle(id: EntryId): void;
}

export interface KeyboardRowLookup {
  /** Snapshot-derived lookup for a row id → entry. */
  getRowById(id: EntryId): VisibleRow | null;
  /** The flat visible row list (same order the tree renders). */
  readonly visibleRows: readonly VisibleRow[];
}

export interface UseFileTreeKeyboardOptions {
  readonly selection: FileTreeSelectionHandle;
  readonly expansion: KeyboardExpansionActions;
  readonly rows: KeyboardRowLookup;
  readonly viewport: ViewportKeyboardActions;
  readonly commands?: CommandRegistryHandle | null;
  readonly multiSelect?: boolean;
  /** Host callback for `file.open` when the command registry is absent. */
  readonly onOpenFallback?: (row: VisibleRow) => void;
  /** Invoked when `Esc` is pressed; host can additionally hide filters etc. */
  readonly onEscape?: () => void;
  /**
   * Phase 5: invoked when F2 fires — opens the inline rename input on
   * the focused row. Called after the command-registry dispatch, so
   * hosts can still intercept via `file.rename` for side effects.
   */
  readonly onStartRename?: (id: EntryId) => void;
  /**
   * Phase 5: invoked when Mod+N / Mod+Shift+N fires — the host creates
   * a new file / folder under the focused parent. The registry's
   * `file.create` command is dispatched with `{ kind }`; this callback
   * gives the tree a chance to run the provisional-create + rename
   * open-on-entry flow even without a registry.
   */
  readonly onCreate?: (kind: 'file' | 'directory') => void;
  /**
   * Phase 6: invoked when `Shift+F10` or `Menu` fires — the tree is
   * expected to open its context menu anchored at the focused row. The
   * registry's `tree.openContextMenu` command is still dispatched with
   * `{ id }` so hosts can observe/intercept.
   */
  readonly onOpenContextMenu?: (id: EntryId | null) => void;
  /**
   * Phase 7: in-app clipboard actions. When supplied, Mod+C / Mod+X /
   * Mod+V are wired; when omitted, those keys are still captured
   * (to prevent typeahead fallthrough) but no-op — matches the
   * pre-Phase-7 behavior.
   */
  readonly clipboard?: KeyboardClipboardActions;
  /**
   * Phase 8: invoked when `Mod+F` fires. The tree/consumer typically
   * focuses a `<FileTreeFilter>` input via a ref. `tree.focusFilter`
   * is still dispatched through the command registry first so hosts
   * can observe/intercept.
   */
  readonly onFocusFilter?: () => void;
}

export interface UseFileTreeKeyboardResult {
  onKeyDown(event: ReactKeyboardEvent<HTMLElement>): void;
  /** Expose the typeahead handle so consumers can reset it (e.g. on blur). */
  readonly typeahead: ReturnType<typeof useTypeahead>;
}

// ─── Internal helpers ────────────────────────────────────────────────

// Numeric enum matching api.d.ts §EntryKind.
const KIND_DIRECTORY = 1;

function visibleIds(rows: readonly VisibleRow[]): EntryId[] {
  const out: EntryId[] = [];
  for (const r of rows) out.push(r.id);
  return out;
}

function toTypeaheadRows(rows: readonly VisibleRow[]): TypeaheadVisibleRow[] {
  const out: TypeaheadVisibleRow[] = [];
  for (const r of rows) out.push({ id: r.id, name: r.name });
  return out;
}

function findRowIndex(rows: readonly VisibleRow[], id: EntryId | null): number {
  if (id === null) return -1;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (row && row.id === id) return i;
  }
  return -1;
}

/** Dispatch a command through the registry; swallow missing-command errors. */
function tryDispatch(
  registry: CommandRegistryHandle | null | undefined,
  id: string,
  args?: unknown,
): boolean {
  if (!registry) return false;
  try {
    const result = registry.dispatch(id, args);
    if (result && typeof (result as Promise<void>).catch === 'function') {
      (result as Promise<void>).catch(() => {
        /* swallow — failure handled upstream if needed */
      });
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Phase 7 helper. If the registry is the full `CommandRegistry` (has
 * `getBinding`), consult it for the keystroke; if it returns a command,
 * dispatch that command's id. Returns `true` if a dispatch happened.
 *
 * When `fallbackId` is provided, we ALSO dispatch it in the case where
 * the registry is the minimal `dispatch`-only handle (no `getBinding`) —
 * tests can then register an override by command id without having to
 * wire up keybinding parsing. This matters for paste in particular:
 * the built-in `file.paste` default command is what should run on
 * Mod+V in the common case.
 */
function dispatchRegistryBinding(
  registry: CommandRegistryHandle | null | undefined,
  event: ReactKeyboardEvent<HTMLElement>,
  fallbackId?: string,
): boolean {
  if (!registry) return false;
  const getBinding = (registry as unknown as {
    getBinding?: (ev: KeyboardEvent) => { id: string } | undefined;
  }).getBinding;
  if (typeof getBinding === 'function') {
    const match = getBinding(event.nativeEvent as KeyboardEvent);
    if (match) {
      return tryDispatch(registry, match.id);
    }
  }
  if (fallbackId !== undefined) {
    return tryDispatch(registry, fallbackId);
  }
  return false;
}

/** Is this event a plain alphanumeric / punctuation key (no Cmd/Ctrl/Alt)? */
function isTypeaheadKey(event: KeyboardEventLike): boolean {
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  // Only printable single-char keys that aren't whitespace.
  const k = event.key;
  if (typeof k !== 'string' || k.length !== 1) return false;
  if (k === ' ' || k === '\t' || k === '\n' || k === '\r') return false;
  return true;
}

// ─── Hardcoded bindings — parsed once, matched every keystroke ───────
//
// These mirror SPEC §6.1. The command registry is still the source of
// truth for *what* a keybinding means, but we hardcode the intents here
// so the tree responds even when no registry is wired. When one is
// wired, we still dispatch by command-id for consistency.

interface KeyIntent {
  readonly id:
    | 'cursor.down'
    | 'cursor.up'
    | 'cursor.pageDown'
    | 'cursor.pageUp'
    | 'cursor.home'
    | 'cursor.end'
    | 'range.extend.down'
    | 'range.extend.up'
    | 'range.extend.home'
    | 'range.extend.end'
    | 'tree.expandOrFocusChild'
    | 'tree.collapseOrFocusParent'
    | 'row.enter'
    | 'row.space'
    | 'file.rename'
    | 'file.create.file'
    | 'file.create.directory'
    | 'file.delete.trash'
    | 'file.delete.hard'
    | 'tree.selectAll'
    | 'tree.focusFilter'
    | 'tree.clearSelection'
    | 'tree.openContextMenu'
    | 'clipboard.cut'
    | 'clipboard.copy'
    | 'clipboard.paste';
  readonly binding: string;
}

// Intents register both Cmd+<key> and Ctrl+<key> variants explicitly —
// `Mod` would normally bind to one or the other based on platform, but
// SPEC §6.1 expects the same command to work on both (Electron apps
// routinely run cross-platform). The first match wins; order stable.
const INTENTS: readonly KeyIntent[] = Object.freeze([
  { id: 'range.extend.down', binding: 'Shift+ArrowDown' },
  { id: 'range.extend.up', binding: 'Shift+ArrowUp' },
  { id: 'range.extend.home', binding: 'Shift+Home' },
  { id: 'range.extend.end', binding: 'Shift+End' },
  { id: 'cursor.down', binding: 'ArrowDown' },
  { id: 'cursor.up', binding: 'ArrowUp' },
  { id: 'cursor.pageDown', binding: 'PageDown' },
  { id: 'cursor.pageUp', binding: 'PageUp' },
  { id: 'cursor.home', binding: 'Home' },
  { id: 'cursor.end', binding: 'End' },
  { id: 'tree.expandOrFocusChild', binding: 'ArrowRight' },
  { id: 'tree.collapseOrFocusParent', binding: 'ArrowLeft' },
  { id: 'row.enter', binding: 'Enter' },
  { id: 'row.space', binding: 'Space' },
  { id: 'file.rename', binding: 'F2' },
  // Create new folder (Shift variant must come before the non-shift
  // so the match-first-wins loop picks it when Shift is held).
  { id: 'file.create.directory', binding: 'Cmd+Shift+N' },
  { id: 'file.create.directory', binding: 'Ctrl+Shift+N' },
  { id: 'file.create.file', binding: 'Cmd+N' },
  { id: 'file.create.file', binding: 'Ctrl+N' },
  { id: 'file.delete.hard', binding: 'Shift+Delete' },
  { id: 'file.delete.hard', binding: 'Shift+Backspace' },
  { id: 'file.delete.trash', binding: 'Delete' },
  { id: 'file.delete.trash', binding: 'Backspace' },
  { id: 'tree.selectAll', binding: 'Cmd+A' },
  { id: 'tree.selectAll', binding: 'Ctrl+A' },
  { id: 'tree.focusFilter', binding: 'Cmd+F' },
  { id: 'tree.focusFilter', binding: 'Ctrl+F' },
  { id: 'tree.openContextMenu', binding: 'Shift+F10' },
  { id: 'tree.openContextMenu', binding: 'ContextMenu' },
  { id: 'tree.clearSelection', binding: 'Escape' },
  // Phase 7 — in-app clipboard. Parsed so they don't fall through to
  // typeahead even when no clipboard handle is wired; real behavior
  // only fires when `clipboard` is supplied in the hook options.
  { id: 'clipboard.cut', binding: 'Cmd+X' },
  { id: 'clipboard.cut', binding: 'Ctrl+X' },
  { id: 'clipboard.copy', binding: 'Cmd+C' },
  { id: 'clipboard.copy', binding: 'Ctrl+C' },
  { id: 'clipboard.paste', binding: 'Cmd+V' },
  { id: 'clipboard.paste', binding: 'Ctrl+V' },
]);

// Pre-parse once at module load. Throwing here would be a dev-time bug.
const PARSED_INTENTS: ReadonlyArray<{ readonly intent: KeyIntent; readonly parsed: ReturnType<typeof parseKeybinding> }> =
  INTENTS.map((intent) => ({ intent, parsed: parseKeybinding(intent.binding) }));

function matchIntent(event: KeyboardEventLike): KeyIntent | null {
  for (const { intent, parsed } of PARSED_INTENTS) {
    if (matchKeybinding(event, parsed)) return intent;
  }
  return null;
}

// ─── Hook ────────────────────────────────────────────────────────────

export function useFileTreeKeyboard(
  options: UseFileTreeKeyboardOptions,
): UseFileTreeKeyboardResult {
  const {
    selection,
    expansion,
    rows,
    viewport,
    commands = null,
    multiSelect = true,
    onOpenFallback,
    onEscape,
    onStartRename,
    onCreate,
    onOpenContextMenu,
    clipboard,
    onFocusFilter,
  } = options;

  const typeahead = useTypeahead();

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      const visible = rows.visibleRows;
      if (visible.length === 0) return;

      const intent = matchIntent(event);

      // Typeahead fallback: if we didn't match a named intent and the key
      // is printable, let typeahead try a name-match.
      if (intent === null) {
        if (!isTypeaheadKey(event)) return;
        const nextId = typeahead.push(
          event.key,
          toTypeaheadRows(visible),
          selection.focusedId,
        );
        if (nextId !== null) {
          event.preventDefault();
          selection.selectOne(nextId);
        }
        return;
      }

      const focusedId = selection.focusedId;
      const focusedIdx = findRowIndex(visible, focusedId);

      switch (intent.id) {
        case 'cursor.down': {
          event.preventDefault();
          const nextIdx = focusedIdx >= 0 ? Math.min(focusedIdx + 1, visible.length - 1) : 0;
          const nextRow = visible[nextIdx];
          if (nextRow) selection.selectOne(nextRow.id);
          return;
        }
        case 'cursor.up': {
          event.preventDefault();
          const nextIdx = focusedIdx > 0 ? focusedIdx - 1 : 0;
          const nextRow = visible[nextIdx];
          if (nextRow) selection.selectOne(nextRow.id);
          return;
        }
        case 'cursor.home': {
          event.preventDefault();
          const first = visible[0];
          if (first) selection.selectOne(first.id);
          return;
        }
        case 'cursor.end': {
          event.preventDefault();
          const last = visible[visible.length - 1];
          if (last) selection.selectOne(last.id);
          return;
        }
        case 'cursor.pageDown': {
          event.preventDefault();
          const nextId = viewport.pageDown(focusedId);
          if (nextId !== null) selection.selectOne(nextId);
          return;
        }
        case 'cursor.pageUp': {
          event.preventDefault();
          const nextId = viewport.pageUp(focusedId);
          if (nextId !== null) selection.selectOne(nextId);
          return;
        }
        case 'range.extend.down': {
          event.preventDefault();
          if (!multiSelect) return;
          const nextIdx = focusedIdx >= 0 ? Math.min(focusedIdx + 1, visible.length - 1) : 0;
          const nextRow = visible[nextIdx];
          if (!nextRow) return;
          const anchor = selection.anchorId ?? focusedId;
          if (anchor === null) {
            selection.selectOne(nextRow.id);
          } else {
            selection.selectRange(anchor, nextRow.id, visibleIds(visible));
          }
          return;
        }
        case 'range.extend.up': {
          event.preventDefault();
          if (!multiSelect) return;
          const nextIdx = focusedIdx > 0 ? focusedIdx - 1 : 0;
          const nextRow = visible[nextIdx];
          if (!nextRow) return;
          const anchor = selection.anchorId ?? focusedId;
          if (anchor === null) {
            selection.selectOne(nextRow.id);
          } else {
            selection.selectRange(anchor, nextRow.id, visibleIds(visible));
          }
          return;
        }
        case 'range.extend.home': {
          event.preventDefault();
          if (!multiSelect) return;
          const first = visible[0];
          if (!first) return;
          const anchor = selection.anchorId ?? focusedId ?? first.id;
          selection.selectRange(anchor, first.id, visibleIds(visible));
          return;
        }
        case 'range.extend.end': {
          event.preventDefault();
          if (!multiSelect) return;
          const last = visible[visible.length - 1];
          if (!last) return;
          const anchor = selection.anchorId ?? focusedId ?? last.id;
          selection.selectRange(anchor, last.id, visibleIds(visible));
          return;
        }
        case 'tree.expandOrFocusChild': {
          event.preventDefault();
          if (focusedId === null) return;
          const row = rows.getRowById(focusedId);
          if (!row) return;
          const isFolder = row.kind === KIND_DIRECTORY || row.hasChildren;
          if (!isFolder) return;
          if (!expansion.isExpanded(focusedId)) {
            expansion.expand(focusedId);
            tryDispatch(commands, 'tree.expand', { id: focusedId });
            return;
          }
          // Already expanded — focus first child (next row if child exists).
          const nextIdx = focusedIdx + 1;
          const nextRow = visible[nextIdx];
          if (nextRow && nextRow.parentId === focusedId) {
            selection.selectOne(nextRow.id);
          }
          return;
        }
        case 'tree.collapseOrFocusParent': {
          event.preventDefault();
          if (focusedId === null) return;
          const row = rows.getRowById(focusedId);
          if (!row) return;
          const isFolder = row.kind === KIND_DIRECTORY || row.hasChildren;
          if (isFolder && expansion.isExpanded(focusedId)) {
            expansion.collapse(focusedId);
            tryDispatch(commands, 'tree.collapse', { id: focusedId });
            return;
          }
          // Not expanded (or not a folder) — focus parent.
          if (row.parentId !== null) {
            selection.selectOne(row.parentId);
          }
          return;
        }
        case 'row.enter': {
          event.preventDefault();
          if (focusedId === null) return;
          const row = rows.getRowById(focusedId);
          if (!row) return;
          const isFolder = row.kind === KIND_DIRECTORY || row.hasChildren;
          if (isFolder) {
            expansion.toggle(focusedId);
            tryDispatch(
              commands,
              expansion.isExpanded(focusedId) ? 'tree.collapse' : 'tree.expand',
              { id: focusedId },
            );
          } else {
            // Dispatch file.open through registry if present, else host cb.
            if (!tryDispatch(commands, 'file.open', { id: focusedId })) {
              onOpenFallback?.(row);
            }
          }
          return;
        }
        case 'row.space': {
          event.preventDefault();
          if (focusedId === null) return;
          selection.toggle(focusedId);
          return;
        }
        case 'file.rename': {
          event.preventDefault();
          if (focusedId === null) return;
          // Phase 5: dispatch through the registry first (so a host can
          // observe / intercept via `file.rename`), then open the inline
          // input. The registry default command is a no-op when
          // `onStartRename` is wired — the host callback performs the
          // real work of flipping `renameTargetId`.
          tryDispatch(commands, 'file.rename', { id: focusedId });
          if (onStartRename) onStartRename(focusedId);
          return;
        }
        case 'file.create.file': {
          event.preventDefault();
          // Dispatch through the registry so hosts can intercept.
          tryDispatch(commands, 'file.create', { kind: 'file' });
          if (onCreate) onCreate('file');
          return;
        }
        case 'file.create.directory': {
          event.preventDefault();
          tryDispatch(commands, 'file.create', { kind: 'directory' });
          if (onCreate) onCreate('directory');
          return;
        }
        case 'file.delete.trash': {
          event.preventDefault();
          if (focusedId === null && selection.selectedIds.size === 0) return;
          const ids =
            selection.selectedIds.size > 0
              ? Array.from(selection.selectedIds)
              : focusedId !== null
                ? [focusedId]
                : [];
          if (ids.length === 0) return;
          tryDispatch(commands, 'file.delete', { ids, toTrash: true });
          return;
        }
        case 'file.delete.hard': {
          event.preventDefault();
          if (focusedId === null && selection.selectedIds.size === 0) return;
          const ids =
            selection.selectedIds.size > 0
              ? Array.from(selection.selectedIds)
              : focusedId !== null
                ? [focusedId]
                : [];
          if (ids.length === 0) return;
          tryDispatch(commands, 'file.delete', { ids, toTrash: false });
          return;
        }
        case 'tree.selectAll': {
          event.preventDefault();
          if (!multiSelect) return;
          const all = new Set<EntryId>();
          for (const r of visible) all.add(r.id);
          selection.setSelection(all);
          return;
        }
        case 'tree.focusFilter': {
          event.preventDefault();
          // Dispatch first so hosts can observe/intercept. The default
          // `tree.focusFilter` command is a no-op (registry contract);
          // the real side effect happens in `onFocusFilter`.
          tryDispatch(commands, 'tree.focusFilter');
          if (onFocusFilter) onFocusFilter();
          return;
        }
        case 'tree.clearSelection': {
          event.preventDefault();
          selection.clear();
          onEscape?.();
          return;
        }
        case 'tree.openContextMenu': {
          event.preventDefault();
          // Registry dispatch first so hosts can observe/intercept.
          tryDispatch(commands, 'tree.openContextMenu', { id: focusedId });
          // Phase 6: open the menu anchored at the focused row. The
          // callback synthesizes a `contextmenu` event on the row's
          // DOM node so Radix anchors at the right position.
          if (onOpenContextMenu) onOpenContextMenu(focusedId);
          return;
        }
        case 'clipboard.cut': {
          // Respect registry override — if a host rebinds Mod+X to a
          // custom command, let that take precedence. The registry's
          // getBinding is available on the full registry but not the
          // minimal `dispatch`-only handle, so we sniff for it.
          if (dispatchRegistryBinding(commands, event)) {
            event.preventDefault();
            return;
          }
          event.preventDefault();
          if (!clipboard) return;
          if (selection.selectedIds.size === 0) return;
          clipboard.markCut(selection.selectedIds);
          return;
        }
        case 'clipboard.copy': {
          if (dispatchRegistryBinding(commands, event)) {
            event.preventDefault();
            return;
          }
          event.preventDefault();
          if (!clipboard) return;
          if (selection.selectedIds.size === 0) return;
          clipboard.markCopy(selection.selectedIds);
          return;
        }
        case 'clipboard.paste': {
          if (dispatchRegistryBinding(commands, event, 'file.paste')) {
            event.preventDefault();
            return;
          }
          event.preventDefault();
          // Fallback path: no registry wired — nothing to dispatch. The
          // command registry is the authoritative paste implementation
          // (it consults `cutIds`/`copyIds` via CommandContext) so tests
          // without a registry see a no-op here, matching Mod+C / Mod+X.
          return;
        }
      }
    },
    [
      rows,
      selection,
      expansion,
      viewport,
      commands,
      multiSelect,
      onOpenFallback,
      onEscape,
      onStartRename,
      onCreate,
      onOpenContextMenu,
      onFocusFilter,
      clipboard,
      typeahead,
    ],
  );

  return useMemo<UseFileTreeKeyboardResult>(
    () => ({ onKeyDown, typeahead }),
    [onKeyDown, typeahead],
  );
}
