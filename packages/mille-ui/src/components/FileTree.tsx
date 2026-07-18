// FileTree — Phase-3/4 virtualized tree with full keyboard + selection.
//
// Composition:
//   - If the caller passes `fx`, we self-compose `<FileTreeProvider>`
//     so `<FileTree fx={...} />` works standalone.
//   - Else we read the engine + snapshot from `useFileTreeContext`.
//
// Phase 4 adds on top of Phase 3:
//   - Full WAI-ARIA tree keyboard model via `useFileTreeKeyboard`.
//   - Focus + selection separation via `useFileTreeSelection`.
//   - Roving tabindex (exactly one row tabbable).
//   - Typeahead.
//   - Controlled focus/selection opt-in props.
//   - Focus restoration: re-entering the tree via Tab focuses the last
//     row the user interacted with, or the first row if none.

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  type CSSProperties,
  type FocusEvent as ReactFocusEvent,
  type ForwardedRef,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import type { Entry, EntryId, VisibleRow } from '@vibecook/mille';
import { FileTreeProvider } from '../provider.js';
import { useFileTreeContext } from '../hooks/useFileTreeContext.js';
import { useExpandedSet } from '../hooks/useExpandedSet.js';
import { useSetExpandedBridge } from '../hooks/useSetExpandedBridge.js';
import { useVirtualizerForSnapshot } from '../hooks/useVirtualizerForSnapshot.js';
import { useFileTreeSelection } from '../hooks/useFileTreeSelection.js';
import {
  useFileTreeKeyboard,
  type KeyboardExpansionActions,
  type KeyboardRowLookup,
  type ViewportKeyboardActions,
} from '../hooks/useFileTreeKeyboard.js';
import {
  useRenameState,
  type RenameStateFx,
  type RenameStateSnapshot,
} from '../hooks/useRenameState.js';
import { useContextMenuState } from '../hooks/useContextMenuState.js';
import { useClipboardState } from '../hooks/useClipboardState.js';
import { useFilterState } from '../hooks/useFilterState.js';
import { useFileTreeDragDrop } from '../hooks/useFileTreeDragDrop.js';
import { FileTreeRow } from './FileTreeRow.js';
import { FileContextMenu } from './FileContextMenu.js';
import { FileTreeFilter, type FileTreeFilterHandle } from './FileTreeFilter.js';
import { SearchResultList } from './SearchResultList.js';
import type { SearchableEngine } from '../hooks/useSearchResults.js';
import { mergeDecorations } from '../hooks/useFileDecorations.js';
import type { Command, CommandContext, CommandRegistry } from '../commands/types.js';
import { defaultCommands } from '../commands/defaults.js';
import type {
  AriaRowProps,
  FileTreeEngine,
  FileTreeProps,
  FileTreeRef,
  FileTreeRowProps,
  FileTreeSnapshotLike,
} from './types.js';

// Local structural type for the "full registry" narrowing. We can't
// import the full CommandRegistry at the context level because the
// provider deliberately exposes only `dispatch`; hosts that pass a
// full registry satisfy this shape structurally.
interface CommandRegistryHandleLike {
  all(): readonly Command[];
}

/**
 * Public entry. If `fx` is passed, composes its own
 * `<FileTreeProvider>` so single-tree apps can drop in without setting
 * up a provider. Callers that wrap `<FileTree>` in their own
 * `<FileTreeProvider>` (e.g. to pass a command registry) omit `fx`.
 *
 * v0.2 B6 — wrapped in `React.forwardRef<FileTreeRef, ...>` so hosts can
 * drive the tree imperatively via `revealPath` / `reset` / etc. Callers
 * that don't need the handle just omit `ref` — existing code keeps
 * working unchanged.
 */
function FileTreeBase(
  props: FileTreeProps,
  ref: ForwardedRef<FileTreeRef>,
): ReactElement {
  const { fx, ...rest } = props;
  if (fx) {
    return (
      <FileTreeProvider fx={fx as unknown as Parameters<typeof FileTreeProvider>[0]['fx']}>
        <FileTreeInner {...rest} forwardedRef={ref} />
      </FileTreeProvider>
    );
  }
  return <FileTreeInner {...rest} forwardedRef={ref} />;
}

export const FileTree = forwardRef<FileTreeRef, FileTreeProps>(FileTreeBase);
FileTree.displayName = 'FileTree';

// ─── Inner tree — assumes provider is present ──────────────────────

type FileTreeInnerProps = Omit<FileTreeProps, 'fx'> & {
  readonly forwardedRef?: ForwardedRef<FileTreeRef>;
};

function FileTreeInner(props: FileTreeInnerProps): ReactElement {
  const {
    rowHeight = 22,
    overscan = 20,
    iconTheme,
    emptyState,
    loadingState,
    ariaLabel,
    className,
    style,
    rowRenderer,
    stickyRoots = true,
    multiSelect = true,
    focusedId: controlledFocusedId,
    onFocusedIdChange,
    selectedIds: controlledSelectedIds,
    onSelectionChange,
    renameTargetId: controlledRenameTargetId,
    onRenameTargetIdChange,
    onOpen,
    onClipboardChange,
    contextMenuSlot,
    contextMenuExtraItems,
    contextMenuEmptyPlaceholder,
    disableContextMenu = false,
    filter: controlledFilter,
    onFilterChange,
    searchMode = 'off',
    onSearchModeChange,
    filterInputRef,
    showFilter = false,
    dragDrop,
    disableDragDrop = false,
    forwardedRef,
    __testSearchDebounceMs,
    __testObserveElementRect,
    __testObserveElementOffset,
  } = props;

  const ctx = useFileTreeContext();
  // Cast through unknown: FileTreeFx from context is a narrower shape
  // but structurally compatible with the subset we need here.
  const fx = ctx.fx as unknown as FileTreeEngine;
  const snapshot = ctx.snapshot as unknown as FileTreeSnapshotLike;
  const commandsHandle = ctx.commands;

  // Rename + create state. Drives the inline FileRenameInput on the
  // matching row. Controlled mode when caller passes `renameTargetId`.
  const renameState = useRenameState({
    fx: fx as unknown as RenameStateFx,
    snapshot: snapshot as unknown as RenameStateSnapshot,
    ...(controlledRenameTargetId !== undefined && onRenameTargetIdChange
      ? {
          controlled: {
            value: controlledRenameTargetId,
            onChange: onRenameTargetIdChange,
          },
        }
      : {}),
  });

  // Phase 8 — filter / search state. Always instantiated, but only
  // *applied* when `searchMode !== 'off'`. The filter input's `onChange`
  // flows through here; the tree then decides whether to substring-match
  // visible rows (`'filter'`) or swap to `<SearchResultList>` (`'search'`).
  const filterState = useFilterState(
    controlledFilter !== undefined && onFilterChange
      ? { controlled: { value: controlledFilter, onChange: onFilterChange } }
      : controlledFilter !== undefined
        ? { controlled: { value: controlledFilter, onChange: () => {} } }
        : {},
  );

  // Embedded filter input ref (used when `showFilter` is true). Separate
  // from `filterInputRef` so we can fall back to focusing the embedded
  // one even when the caller didn't supply a ref.
  const embeddedFilterInputRef = useRef<FileTreeFilterHandle | null>(null);

  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const { expanded, toggle, add: addExpanded, remove: removeExpanded } =
    useExpandedSet();

  // Selection (selection + focus state) — respects controlled props.
  const selection = useFileTreeSelection({
    ...(controlledSelectedIds !== undefined
      ? { selectedIds: controlledSelectedIds }
      : {}),
    ...(onSelectionChange ? { onSelectionChange } : {}),
    ...(controlledFocusedId !== undefined
      ? { focusedId: controlledFocusedId }
      : {}),
    ...(onFocusedIdChange ? { onFocusedIdChange } : {}),
  });

  // Bridge: every change to `expanded` is forwarded to the engine
  // (wrapped in `startTransition`). Engine's subsequent delta flows
  // back through the provider's `useSyncExternalStore`.
  useSetExpandedBridge(fx, expanded);

  // Virtualizer. `count` reflects the snapshot's `visibleRowCount`.
  const { virtualItems, totalSize, count, scrollToIndex } = useVirtualizerForSnapshot({
    snapshot,
    expanded,
    rowHeight,
    overscan,
    scrollerRef,
    ...(__testObserveElementRect
      ? { observeElementRect: __testObserveElementRect }
      : null),
    ...(__testObserveElementOffset
      ? { observeElementOffset: __testObserveElementOffset }
      : null),
  });

  const pendingSet = useMemo<ReadonlySet<EntryId>>(
    () => snapshot.visibleRowCount(expanded).pendingExpansions,
    [snapshot, expanded],
  );

  const rootsCount = snapshot.roots().length;

  // Materialize the flat visible-row list once per render. `count` is
  // the authoritative size; we pull the rows in a single slice because
  // the keyboard handler (range select, typeahead) needs random access.
  const visibleRows = useMemo<readonly VisibleRow[]>(() => {
    if (count === 0) return [];
    return snapshot.visibleRows({ expanded, offset: 0, limit: count });
  }, [snapshot, expanded, count]);

  // ─── Keyboard helpers ──────────────────────────────────────────────

  const expansionActions = useMemo<KeyboardExpansionActions>(
    () => ({
      isExpanded: (id) => expanded.has(id),
      expand: (id) => addExpanded(id),
      collapse: (id) => removeExpanded(id),
      toggle: (id) => toggle(id),
    }),
    [expanded, addExpanded, removeExpanded, toggle],
  );

  const rowsLookup = useMemo<KeyboardRowLookup>(
    () => ({
      visibleRows,
      getRowById: (id) => {
        for (const r of visibleRows) {
          if (r.id === id) return r;
        }
        return null;
      },
    }),
    [visibleRows],
  );

  const viewportActions = useMemo<ViewportKeyboardActions>(
    () => ({
      pageUp: (fromId) => {
        const el = scrollerRef.current;
        const viewportPx = el ? el.clientHeight || 0 : 0;
        const rowsPerPage = viewportPx > 0
          ? Math.max(1, Math.floor(viewportPx / rowHeight))
          : 10;
        if (visibleRows.length === 0) return null;
        const fromIdx = fromId !== null
          ? visibleRows.findIndex((r) => r.id === fromId)
          : -1;
        const base = fromIdx >= 0 ? fromIdx : 0;
        const targetIdx = Math.max(0, base - rowsPerPage);
        const target = visibleRows[targetIdx];
        return target ? target.id : null;
      },
      pageDown: (fromId) => {
        const el = scrollerRef.current;
        const viewportPx = el ? el.clientHeight || 0 : 0;
        const rowsPerPage = viewportPx > 0
          ? Math.max(1, Math.floor(viewportPx / rowHeight))
          : 10;
        if (visibleRows.length === 0) return null;
        const fromIdx = fromId !== null
          ? visibleRows.findIndex((r) => r.id === fromId)
          : -1;
        const base = fromIdx >= 0 ? fromIdx : 0;
        const targetIdx = Math.min(visibleRows.length - 1, base + rowsPerPage);
        const target = visibleRows[targetIdx];
        return target ? target.id : null;
      },
    }),
    [visibleRows, rowHeight],
  );

  // ─── Phase 5: create-new-entry flow ─────────────────────────────────
  //
  // When Mod+N / Mod+Shift+N fires, we synthesize a provisional name,
  // ask the engine to create the entry, then open the rename input on
  // the returned id so the user types the real name. If the engine
  // rejects our provisional name (sanitization), we try `__new_1`,
  // `__new_2` etc. before giving up.
  const onCreate = useCallback(
    async (kind: 'file' | 'directory') => {
      // Resolve parent id: prefer focused folder, else focused's parent,
      // else first root.
      const focusedId = selection.focusedId;
      let parentId: EntryId | null = null;
      if (focusedId !== null) {
        const focused = snapshot.getById(focusedId);
        if (focused !== null) {
          parentId = focused.kind === 1 ? focused.id : focused.parentId;
        }
      }
      if (parentId === null) {
        const firstRoot = snapshot.roots()[0];
        if (firstRoot) parentId = firstRoot.id;
      }
      if (parentId === null) return;

      // Duck-typed create: FileTreeEngine doesn't declare create on its
      // minimal surface — the real engine does. Test fakes also do.
      const fxWithCreate = fx as unknown as {
        create?(parentId: EntryId, name: string, kind: number): Promise<{ id: EntryId }>;
      };
      if (typeof fxWithCreate.create !== 'function') return;

      const numericKind = kind === 'directory' ? 1 : 0;
      const provisional = `__mille_new_${kind}__`;
      const fallbackBase = '__new_';
      let attempt = 0;
      let lastErr: unknown = null;
      // Try provisional name, then `__new_1`, `__new_2`, ...
      while (attempt <= 20) {
        const name = attempt === 0 ? provisional : `${fallbackBase}${attempt}`;
        try {
          const entry = await fxWithCreate.create(parentId, name, numericKind);
          if (entry && typeof entry.id === 'number') {
            renameState.startRename(entry.id);
          }
          return;
        } catch (e) {
          lastErr = e;
          attempt += 1;
        }
      }
      // Exhausted attempts; surface via console only — the host's
      // `file.create` command registry can install its own error surface.
      if (lastErr && typeof process !== 'undefined' && process.env?.['NODE_ENV'] !== 'production') {
        // eslint-disable-next-line no-console
        console.warn('mille-ui: file.create: provisional-name attempts exhausted', lastErr);
      }
    },
    [fx, snapshot, selection, renameState],
  );

  // ─── Phase 6: context menu state ────────────────────────────────
  //
  // Row DOM ref registry (for keyboard-triggered menu open) + the
  // "open on row" dispatcher called by `useFileTreeKeyboard`.
  const contextMenuState = useContextMenuState();
  const onOpenContextMenu = useCallback(
    (id: EntryId | null) => {
      if (disableContextMenu) return;
      if (id === null) return;
      contextMenuState.openAtRow(id);
    },
    [contextMenuState, disableContextMenu],
  );

  // ─── Phase 7: in-app clipboard (cut/copy/paste) ─────────────────
  //
  // State local to the tree. Host observers read via `onClipboardChange`.
  // The registry's `file.paste` command is registered on mount if not
  // already present — this lets consumers who wire their own (older)
  // registry still get paste semantics from Mod+V. Hosts that register
  // their own `file.paste` win via the normal shadow/restore stack.
  const clipboard = useClipboardState();

  // Forward changes to any caller-supplied observer.
  useEffect(() => {
    if (!onClipboardChange) return;
    onClipboardChange({
      cutIds: clipboard.cutIds,
      copyIds: clipboard.copyIds,
    });
  }, [onClipboardChange, clipboard.cutIds, clipboard.copyIds]);

  // Register `file.paste` into a full command registry if absent. We
  // do NOT try to install into the minimal `dispatch`-only handle:
  // hosts that pass only a handle are opting into a different wiring
  // and can register `file.paste` themselves.
  useEffect(() => {
    const handle = commandsHandle as unknown as {
      get?: (id: string) => Command | undefined;
      register?: (command: Command) => { dispose(): void };
    } | null;
    if (!handle || typeof handle.register !== 'function' || typeof handle.get !== 'function') {
      return undefined;
    }
    if (handle.get('file.paste') !== undefined) return undefined;
    const paste = defaultCommands.find((c) => c.id === 'file.paste');
    if (!paste) return undefined;
    const disp = handle.register(paste);
    return () => {
      disp.dispose();
    };
  }, [commandsHandle]);

  // ─── Phase 11 — drag-and-drop coordinator ───────────────────────
  //
  // Always instantiated so row-level DnD handlers are stable identities
  // across renders (the hook's `handlers` object is memoized). Row
  // wiring gates on `disableDragDrop` to decide whether to actually
  // attach the listeners; the hook's state is harmlessly idle when no
  // drags occur.
  //
  // The `DragDropOptions` type in `components/types.ts` overlaps with
  // the hook's own option surface but declares a deprecated `external`
  // alias. Normalize: if `external` is present and `externalIn` is not,
  // forward `external` as `externalIn`.
  const dndOptions = useMemo<Parameters<typeof useFileTreeDragDrop>[0]>(() => {
    if (!dragDrop) return {};
    return {
      ...(dragDrop.internal !== undefined ? { internal: dragDrop.internal } : null),
      ...(dragDrop.externalOut !== undefined ? { externalOut: dragDrop.externalOut } : null),
      ...(dragDrop.externalIn !== undefined
        ? { externalIn: dragDrop.externalIn }
        : dragDrop.external !== undefined
          ? { externalIn: dragDrop.external }
          : null),
      ...(dragDrop.crossRoot !== undefined ? { crossRoot: dragDrop.crossRoot } : null),
      ...(dragDrop.onDropValidate !== undefined ? { onDropValidate: dragDrop.onDropValidate } : null),
      ...(dragDrop.onConfirm !== undefined ? { onConfirm: dragDrop.onConfirm } : null),
      ...(dragDrop.autoExpandDelayMs !== undefined ? { autoExpandDelayMs: dragDrop.autoExpandDelayMs } : null),
    };
  }, [dragDrop]);

  const dnd = useFileTreeDragDrop(dndOptions, { selectedIds: selection.selectedIds });

  const { onKeyDown } = useFileTreeKeyboard({
    selection,
    expansion: expansionActions,
    rows: rowsLookup,
    viewport: viewportActions,
    commands: commandsHandle,
    multiSelect,
    ...(onOpen ? { onOpenFallback: (row: VisibleRow) => onOpen(row) } : {}),
    onStartRename: (id) => {
      renameState.startRename(id);
    },
    onCreate,
    onOpenContextMenu,
    onEscape: () => {
      // Phase 7: Esc clears the clipboard in addition to selection. The
      // rename-input owns Esc when a rename is active — this callback
      // only fires when the tree's root `onKeyDown` handles the
      // keystroke (i.e. user NOT in rename).
      clipboard.clear();
      // Phase 8 — Esc also clears the filter so the tree returns to
      // an unfiltered view. Harmless when no filter was active.
      filterState.clear();
    },
    onFocusFilter: () => {
      // Phase 8 — prefer the caller-supplied ref; fall back to the
      // embedded filter input when `showFilter` is true.
      const ext = filterInputRef?.current;
      if (ext && typeof ext.focus === 'function') {
        ext.focus();
        return;
      }
      const emb = embeddedFilterInputRef.current;
      if (emb && typeof emb.focus === 'function') {
        emb.focus();
      }
      // When neither is available, `tree.focusFilter` has already been
      // dispatched through the registry (Phase 2 contract) — the host
      // owns the side effect in that case.
    },
    clipboard: {
      cutIds: clipboard.cutIds,
      copyIds: clipboard.copyIds,
      markCut: clipboard.markCut,
      markCopy: clipboard.markCopy,
      clear: clipboard.clear,
    },
  });

  // ─── Phase 6: menu context + rendered content ───────────────────
  //
  // The `commandsHandle` published through the Provider is the minimal
  // `CommandRegistryHandle` (dispatch-only); a host wiring a real
  // `CommandRegistry` (from `createCommandRegistry`) passes one that is
  // structurally compatible with the full interface. We narrow by
  // sniffing for `all()`; when absent, we skip the menu rendering
  // altogether so no empty menus appear.
  const fullRegistry = commandsHandle as unknown as
    | (CommandRegistry & CommandRegistryHandleLike)
    | null;
  const hasFullRegistry =
    fullRegistry !== null &&
    typeof (fullRegistry as unknown as { all?: unknown }).all === 'function';

  const menuCommandContext = useMemo<CommandContext | null>(() => {
    if (!hasFullRegistry) return null;
    const focusedId = selection.focusedId;
    const focusedEntry: Entry | null =
      focusedId !== null ? snapshot.getById(focusedId) : null;
    const selectedEntries: Entry[] = [];
    for (const id of selection.selectedIds) {
      const e = snapshot.getById(id);
      if (e !== null) selectedEntries.push(e);
    }
    return {
      // `fx` is structurally richer than the Engine surface we use;
      // for menu population we only need the snapshot + state, but
      // hosts' custom commands may rely on the full engine.
      fx: fx as unknown as CommandContext['fx'],
      snapshot: snapshot as unknown as CommandContext['snapshot'],
      focusedId,
      focusedEntry,
      selectedIds: selection.selectedIds,
      selectedEntries,
      isMultiSelect: multiSelect && selection.selectedIds.size > 1,
      isRenaming: renameState.renameTargetId !== null,
      host: {},
      cutIds: clipboard.cutIds,
      copyIds: clipboard.copyIds,
    };
  }, [
    hasFullRegistry,
    fx,
    snapshot,
    selection.focusedId,
    selection.selectedIds,
    multiSelect,
    renameState.renameTargetId,
    clipboard.cutIds,
    clipboard.copyIds,
  ]);

  const contextMenuContent = useMemo<ReactNode>(() => {
    if (disableContextMenu) return null;
    if (contextMenuSlot !== undefined) return contextMenuSlot;
    if (!hasFullRegistry || menuCommandContext === null || fullRegistry === null) {
      return null;
    }
    return (
      <FileContextMenu
        registry={fullRegistry as CommandRegistry}
        context={menuCommandContext}
        {...(contextMenuExtraItems !== undefined
          ? { extraItems: contextMenuExtraItems }
          : null)}
        {...(contextMenuEmptyPlaceholder !== undefined
          ? { emptyPlaceholder: contextMenuEmptyPlaceholder }
          : null)}
      />
    );
  }, [
    disableContextMenu,
    contextMenuSlot,
    hasFullRegistry,
    fullRegistry,
    menuCommandContext,
    contextMenuExtraItems,
    contextMenuEmptyPlaceholder,
  ]);

  // Chevron click — toggles local expansion and dispatches through the
  // command registry when one is attached.
  const onChevronClick = useCallback(
    (id: EntryId, wasExpanded: boolean) => {
      toggle(id);
      if (commandsHandle) {
        const commandId = wasExpanded ? 'tree.collapse' : 'tree.expand';
        try {
          const result = commandsHandle.dispatch(commandId, { id });
          if (result && typeof (result as Promise<void>).catch === 'function') {
            (result as Promise<void>).catch(() => {
              /* swallow — local toggle already applied */
            });
          }
        } catch {
          /* swallow — local toggle already applied */
        }
      }
    },
    [commandsHandle, toggle],
  );

  // ─── Focus restoration ─────────────────────────────────────────────
  //
  // Remember the last focused id across blurs so re-entering the tree
  // via Tab restores the previous focused row. Separate from selection
  // focus — focus can advance while selection stays put.
  const lastFocusedRef = useRef<EntryId | null>(null);
  useEffect(() => {
    if (selection.focusedId !== null) {
      lastFocusedRef.current = selection.focusedId;
    }
  }, [selection.focusedId]);

  // If focus enters the container but no row is focused (e.g. user
  // Tab'd in), pick the remembered row (or the first row as a fallback).
  const onContainerFocus = useCallback(
    (e: ReactFocusEvent<HTMLElement>) => {
      // Only intercept focus events where the target is the container
      // itself, not a descendant row (rows fire onFocus separately).
      if (e.target !== e.currentTarget) return;
      if (selection.focusedId !== null) return;
      const restoreId = lastFocusedRef.current;
      const first = visibleRows[0];
      if (restoreId !== null && visibleRows.some((r) => r.id === restoreId)) {
        selection.setFocused(restoreId);
      } else if (first) {
        selection.setFocused(first.id);
      }
    },
    [selection, visibleRows],
  );

  const onRowFocus = useCallback(
    (id: EntryId) => {
      if (selection.focusedId !== id) {
        selection.setFocused(id);
      }
    },
    [selection],
  );

  // ─── v0.2 B6 — Imperative handle ───────────────────────────────────
  //
  // Exposes a `FileTreeRef` surface for hosts that want to drive the
  // tree programmatically (command palette, "Reset" button, etc.). All
  // state mutators delegate to the existing hooks (`selection.clear`,
  // `filterState.clear`, `clipboard.clear`, `addExpanded`, …); the
  // `revealPath` implementation sniffs for `fx.getByUri` first and
  // falls back to a snapshot child-walk.

  // Computing an ancestor chain from a target id to its root walks
  // `entry.parentId`. Returned leaf-first; callers reverse for
  // top-down expansion. Short-circuits when any ancestor is missing.
  const ancestorsOf = useCallback(
    (id: EntryId): readonly EntryId[] => {
      const chain: EntryId[] = [];
      let cursor: EntryId | null = id;
      let guard = 0;
      while (cursor !== null && guard < 10_000) {
        const entry = snapshot.getById(cursor);
        if (entry === null) break;
        if (entry.parentId === null) break;
        chain.push(entry.parentId);
        cursor = entry.parentId;
        guard += 1;
      }
      return chain;
    },
    [snapshot],
  );

  const revealId = useCallback(
    (id: EntryId): boolean => {
      // Verify the id actually exists in the current mirror. If not we
      // can't reveal it — the caller is probably racing a walker; they
      // should retry once the next delta lands.
      if (snapshot.getById(id) === null) return false;

      // Expand every ancestor (top-down order doesn't matter because
      // each `add` is idempotent and the sets commute).
      for (const ancestorId of ancestorsOf(id)) {
        addExpanded(ancestorId);
      }

      // Once expanded, the next render's `visibleRows` will contain the
      // target. Today's list may still be stale (we just dispatched
      // setState calls via `addExpanded`), but we can look up by
      // walking `visibleRows` as-is; if the row isn't there yet, fall
      // back to zero.
      const idx = visibleRows.findIndex((r) => r.id === id);
      if (idx >= 0) {
        scrollToIndex(idx, { align: 'start' });
        selection.setFocused(id);
      } else {
        // Queue a focus-only update — the re-rendered tree's
        // `onContainerFocus` + roving tabindex will pick this up.
        selection.setFocused(id);
      }
      return true;
    },
    [snapshot, ancestorsOf, addExpanded, visibleRows, scrollToIndex, selection],
  );

  // `fx.getByUri` is async; when the engine exposes it we use it to
  // turn a workspace-relative path into an `EntryId`. Many minimal
  // engines (fakes, port clients) don't implement it — we fall back to
  // a depth-first name-match walk over the snapshot's already-known
  // children. Both paths return `null` when resolution fails.
  const resolvePath = useCallback(
    async (path: string): Promise<EntryId | null> => {
      const trimmed = path.replace(/^\/+/, '').replace(/\/+$/, '');
      if (trimmed.length === 0) {
        const firstRoot = snapshot.roots()[0];
        return firstRoot ? firstRoot.id : null;
      }
      const segments = trimmed.split('/');

      // Strategy 1 — engine-native URI lookup when available.
      const fxWithUri = fx as unknown as {
        getByUri?: (uri: string) => Promise<{ id: EntryId } | null>;
      };
      if (typeof fxWithUri.getByUri === 'function') {
        try {
          // Build a synthetic `mille://` URI relative to the first
          // root. The engine resolves whatever URI forms it accepts;
          // we pass several common shapes to improve the hit rate.
          const firstRoot = snapshot.roots()[0];
          const candidates: string[] = [];
          if (firstRoot) {
            candidates.push(`mille://${firstRoot.name}/${trimmed}`);
          }
          candidates.push(`file:///${trimmed}`);
          candidates.push(trimmed);
          for (const uri of candidates) {
            const entry = await fxWithUri.getByUri(uri);
            if (entry && typeof entry.id === 'number') {
              return entry.id;
            }
          }
        } catch {
          // Swallow — fall through to the child-walk fallback.
        }
      }

      // Strategy 2 — depth-first walk over each root's children.
      // Matches the first segment against any root by name; subsequent
      // segments against direct children. Uses the snapshot's
      // already-loaded entries only (no engine RPC).
      const roots = snapshot.roots();
      const snapAny = snapshot as unknown as {
        childrenOf?: (id: EntryId) => readonly Entry[];
      };
      const childrenOf = (parentId: EntryId): readonly Entry[] => {
        if (typeof snapAny.childrenOf === 'function') {
          return snapAny.childrenOf(parentId);
        }
        // Fallback: scan the full row list for entries whose parentId
        // matches. `visibleRows` is bounded by what's currently
        // expanded; unexpanded subtrees won't be represented. Callers
        // needing deeper resolution should expand first.
        const out: Entry[] = [];
        for (const row of visibleRows) {
          if (row.parentId === parentId) out.push(row as unknown as Entry);
        }
        return out;
      };

      // Descend one segment at a time.
      let cursor: Entry | null = null;
      const first = segments[0];
      if (first === undefined) return null;
      for (const root of roots) {
        if (root.name === first) {
          cursor = root;
          break;
        }
      }
      // Also allow the first segment to be a direct child of the first
      // root — matches the common case where `path` is relative to the
      // single workspace root (e.g. 'src/foo.ts').
      if (cursor === null && roots.length > 0) {
        const firstRoot = roots[0];
        if (firstRoot) {
          for (const child of childrenOf(firstRoot.id)) {
            if (child.name === first) {
              cursor = child;
              break;
            }
          }
          // If the path segment matched, start the remaining descent
          // below from the second segment; otherwise we'll return null
          // after the next loop because cursor is still null.
          if (cursor !== null) {
            for (let i = 1; i < segments.length; i += 1) {
              const seg = segments[i];
              const kids = childrenOf(cursor.id);
              let matched: Entry | null = null;
              for (const k of kids) {
                if (k.name === seg) {
                  matched = k;
                  break;
                }
              }
              if (matched === null) return null;
              cursor = matched;
            }
            return cursor.id;
          }
        }
      }
      if (cursor === null) return null;

      // Descend the remaining segments from the matched first-segment
      // entry (the "first segment is a root name" branch).
      for (let i = 1; i < segments.length; i += 1) {
        const seg = segments[i];
        const kids = childrenOf(cursor.id);
        let matched: Entry | null = null;
        for (const k of kids) {
          if (k.name === seg) {
            matched = k;
            break;
          }
        }
        if (matched === null) return null;
        cursor = matched;
      }
      return cursor.id;
    },
    [fx, snapshot, visibleRows],
  );

  const revealPath = useCallback(
    async (path: string): Promise<boolean> => {
      const id = await resolvePath(path);
      if (id === null) return false;
      return revealId(id);
    },
    [resolvePath, revealId],
  );

  const focusFilter = useCallback((): boolean => {
    const ext = filterInputRef?.current;
    if (ext && typeof ext.focus === 'function') {
      ext.focus();
      return true;
    }
    const emb = embeddedFilterInputRef.current;
    if (emb && typeof emb.focus === 'function') {
      emb.focus();
      return true;
    }
    return false;
  }, [filterInputRef]);

  useImperativeHandle(
    forwardedRef,
    (): FileTreeRef => ({
      revealPath,
      revealId,
      scrollToRow: (index: number) => {
        scrollToIndex(index, { align: 'start' });
      },
      clearSelection: () => {
        selection.clear();
      },
      clearFilter: () => {
        filterState.clear();
      },
      clearClipboard: () => {
        clipboard.clear();
      },
      focusFilter,
      reset: () => {
        selection.clear();
        filterState.clear();
        clipboard.clear();
        // Return keyboard focus to the tree. The tree container itself
        // isn't focusable (rows own the roving tabindex); when a first
        // row exists, focus it so arrow keys work immediately. Without
        // any rows we call `.focus()` on the container anyway — if the
        // caller stapled a `tabIndex` this still lands meaningfully.
        const first = visibleRows[0];
        if (first !== undefined) {
          selection.setFocused(first.id);
          const scrollEl = scrollerRef.current;
          const rowEl = scrollEl
            ? scrollEl.querySelector<HTMLElement>(
                `[data-mille-row-id="${first.id}"]`,
              )
            : null;
          if (rowEl && typeof rowEl.focus === 'function') {
            rowEl.focus();
            return;
          }
        }
        const el = scrollerRef.current;
        if (el && typeof el.focus === 'function') el.focus();
      },
    }),
    [
      revealPath,
      revealId,
      scrollToIndex,
      selection,
      filterState,
      clipboard,
      focusFilter,
      visibleRows,
    ],
  );

  // ─── Phase 8 — filter / search derivations ──────────────────────────
  //
  // `filterActive` means: user has typed something AND the mode makes
  // the filter meaningful. `'off'` leaves the filter inert; `'filter'`
  // triggers substring hiding; `'search'` swaps the tree for the
  // ranked result list.
  const filterText = filterState.filter;
  const filterActive = searchMode !== 'off' && filterText.length > 0;
  const inSearchMode = searchMode === 'search' && filterActive;

  // Pre-compute the lowercased needle once per render to avoid doing
  // it inside a hot per-row map.
  const filterNeedle = useMemo<string>(
    () => (searchMode === 'filter' && filterActive ? filterText.toLowerCase() : ''),
    [searchMode, filterActive, filterText],
  );

  // ─── Render decisions ──────────────────────────────────────────────
  const showEmpty = count === 0 && pendingSet.size === 0 && rootsCount > 0;
  const showLoading =
    rootsCount === 0 && count === 0 && snapshot.treeVersion === 0;

  if (showLoading && loadingState !== undefined) {
    return (
      <div
        role="tree"
        aria-label={ariaLabel}
        aria-multiselectable={multiSelect}
        aria-busy="true"
        className={className ? `mille-tree ${className}` : 'mille-tree'}
        data-mille-tree-state="loading"
        style={{ height: '100%', overflow: 'auto', ...style }}
      >
        {loadingState}
      </div>
    );
  }

  if (showEmpty && emptyState !== undefined) {
    return (
      <div
        role="tree"
        aria-label={ariaLabel}
        aria-multiselectable={multiSelect}
        className={className ? `mille-tree ${className}` : 'mille-tree'}
        data-mille-tree-state="empty"
        style={{ height: '100%', overflow: 'auto', ...style }}
      >
        {emptyState}
      </div>
    );
  }

  const Row = rowRenderer ?? FileTreeRow;

  const scrollerStyle: CSSProperties = {
    height: '100%',
    overflow: 'auto',
    position: 'relative',
    ...(showFilter ? { height: 'calc(100% - 32px)' } : null),
    ...style,
  };

  const innerStyle: CSSProperties = {
    height: `${totalSize}px`,
    position: 'relative',
    width: '100%',
  };

  // ─── Phase 8 — render the embedded filter + (tree | search list) ───
  const embeddedFilterNode = showFilter ? (
    <FileTreeFilter
      ref={embeddedFilterInputRef}
      mode={searchMode === 'off' ? 'filter' : searchMode}
      {...(controlledFilter !== undefined ? { value: filterText } : {})}
      onChange={(next) => {
        filterState.setFilter(next);
        if (onFilterChange) onFilterChange(next);
      }}
      onModeChange={(next) => {
        if (onSearchModeChange) onSearchModeChange(next);
      }}
    />
  ) : null;

  // Search mode: swap the tree DOM for the virtualized result list.
  if (inSearchMode) {
    const searchContent = (
      <SearchResultList
        fx={fx as unknown as SearchableEngine}
        query={filterText}
        {...(onOpen
          ? {
              onOpen: (entryId) => {
                const entry = snapshot.getById(entryId);
                if (entry) {
                  // `onOpen` receives a `VisibleRow`-compatible object.
                  onOpen(entry as unknown as Parameters<typeof onOpen>[0]);
                }
              },
            }
          : null)}
        {...(__testSearchDebounceMs !== undefined
          ? { debounceMs: __testSearchDebounceMs }
          : null)}
        {...(__testObserveElementRect
          ? { __testObserveElementRect }
          : null)}
        {...(__testObserveElementOffset
          ? { __testObserveElementOffset }
          : null)}
      />
    );
    const outerStyle: CSSProperties = {
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      minHeight: 0,
      ...style,
    };
    return (
      <div
        className={className ? `mille-tree ${className}` : 'mille-tree'}
        data-mille-tree-state="search"
        style={outerStyle}
        onKeyDown={onKeyDown}
      >
        {embeddedFilterNode}
        <div style={{ flex: '1 1 auto', minHeight: 0 }}>{searchContent}</div>
      </div>
    );
  }

  const treeScrollerNode = (
    <div
      ref={scrollerRef}
      role="tree"
      aria-label={ariaLabel}
      aria-multiselectable={multiSelect}
      className={
        showFilter
          ? 'mille-tree'
          : className
            ? `mille-tree ${className}`
            : 'mille-tree'
      }
      data-mille-tree-state="ready"
      data-mille-filter-active={filterActive && searchMode === 'filter' ? 'true' : undefined}
      style={scrollerStyle}
      onKeyDown={onKeyDown}
      onFocus={onContainerFocus}
    >
      <div style={innerStyle}>
        {virtualItems.map((vItem) => {
          const row = visibleRows[vItem.index];
          if (!row) return null;

          const rowExpanded = expanded.has(row.id);
          const pending = pendingSet.has(row.id) || row.pending === true;
          const depth = row.depth;
          const isStickyRoot = stickyRoots && depth === 0;
          const isSelected = selection.selectedIds.has(row.id);
          const isFocused = selection.focusedId === row.id;

          const aria: AriaRowProps = {
            'aria-level': depth + 1,
            'aria-setsize': count,
            'aria-posinset': vItem.index + 1,
            'aria-selected': isSelected,
            ...(row.hasChildren ? { 'aria-expanded': rowExpanded } : null),
          };

          const rowStyle: CSSProperties = {
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: `${rowHeight}px`,
            transform: `translateY(${vItem.start}px)`,
          };

          // Phase 10: compute merged decoration per row. `getDecorations`
          // returns an identity-stable `readonly Decoration[]` per
          // snapshot (engine SPEC §9.4), and `mergeDecorations` folds
          // that into an identity-stable `MergedDecoration` via a
          // WeakMap cache — so decoration-only snapshot bumps only
          // disturb rows whose raw array reference actually changed.
          const rowDecorations = mergeDecorations(
            snapshot.getDecorations(row.id),
          );

          const isCut = clipboard.cutIds.has(row.id);
          // Phase 8 — `'filter'` mode: hide rows whose name doesn't
          // contain the case-insensitive needle. `display:none` chosen
          // for v0.1 simplicity (virtualizer count stays stable); see
          // MILLE_UI_PLAN.md §Phase 8 for the trade-off discussion.
          const isHidden =
            filterNeedle.length > 0
              ? !row.name.toLowerCase().includes(filterNeedle)
              : false;

          const rowProps: FileTreeRowProps = {
            row,
            depth,
            selected: isSelected,
            focused: isFocused,
            expanded: rowExpanded,
            hasChildren: row.hasChildren,
            pending,
            decorations: rowDecorations,
            ...(iconTheme ? { iconTheme } : null),
            style: rowStyle,
            ariaProps: aria,
            isStickyRoot,
            cut: isCut,
            hidden: isHidden,
            renameTargetId: renameState.renameTargetId,
            onRenameCommit: (newName: string) => {
              const result = renameState.commit(newName);
              if (result && typeof result.catch === 'function') {
                result.catch(() => {
                  /* error is tracked in `lastError`; no need to re-throw */
                });
              }
            },
            onRenameCancel: () => renameState.cancel(),
            validateRename: (newName: string) => renameState.validate(newName),
            renameError:
              renameState.renameTargetId === row.id && renameState.lastError
                ? renameState.lastError.message
                : null,
            onExpand: () => {
              if (!rowExpanded) toggle(row.id);
            },
            onCollapse: () => {
              if (rowExpanded) toggle(row.id);
            },
            onChevronClick: (e: ReactMouseEvent<HTMLElement>) => {
              e.stopPropagation();
              onChevronClick(row.id, rowExpanded);
            },
            onClick: (e: ReactMouseEvent<HTMLElement>) => {
              const withMod =
                multiSelect && (e.shiftKey || e.metaKey || e.ctrlKey);
              if (multiSelect && e.shiftKey) {
                const anchor = selection.anchorId ?? selection.focusedId ?? row.id;
                const allIds: EntryId[] = visibleRows.map((r) => r.id);
                selection.selectRange(anchor, row.id, allIds);
              } else if (multiSelect && (e.metaKey || e.ctrlKey)) {
                selection.toggle(row.id);
              } else {
                selection.selectOne(row.id);
              }
              // Single-click expands/collapses folders (entire row, not
              // just the chevron). Matches Finder / the archival design.
              // `detail === 1` skips the second click of a double-click
              // so a folder is not toggled twice and left closed.
              if (
                row.hasChildren &&
                !withMod &&
                e.detail === 1
              ) {
                onChevronClick(row.id, rowExpanded);
              }
            },
            onDoubleClick: () => {
              // Folders already toggle on single-click; double-click only
              // opens leaf entries (files).
              if (!row.hasChildren && onOpen) {
                onOpen(row);
              }
            },
            onContextMenu: () => {
              // Phase 6: per SPEC §6.2, replace selection with target
              // if target is not already in selection. Then let Radix's
              // per-row <ContextMenu.Root> open the menu at cursor.
              if (!selection.selectedIds.has(row.id)) {
                selection.selectOne(row.id);
              } else {
                selection.setFocused(row.id);
              }
            },
            onFocus: () => onRowFocus(row.id),
            disableContextMenu,
            ...(contextMenuContent !== null && contextMenuContent !== undefined
              ? { contextMenuContent }
              : null),
            registerRowElement: contextMenuState.registerRowElement,
            // Phase 11 — drag-and-drop wiring. Each row receives closures
            // that capture its own `row.id`. Row-level gating happens
            // inside `FileTreeRow` via `disableDragDrop`. When the tree's
            // `disableDragDrop` prop is `true`, we skip attaching the
            // handlers entirely so the row's `draggable` attr never
            // renders and the DnD listeners never install.
            disableDragDrop,
            dragging: dnd.state.draggingIds.has(row.id),
            dropTargetPosition:
              dnd.state.dropTargetId === row.id ? dnd.state.dropPosition : null,
            ...(disableDragDrop
              ? null
              : {
                  onDragStart: (e) => dnd.handlers.onDragStart(row.id, e),
                  onDragEnter: (e) => dnd.handlers.onDragEnter(row.id, e),
                  onDragOver: (e) => dnd.handlers.onDragOver(row.id, e),
                  onDragLeave: (e) => dnd.handlers.onDragLeave(row.id, e),
                  onDrop: (e) => {
                    const result = dnd.handlers.onDrop(row.id, e);
                    if (result && typeof result.catch === 'function') {
                      result.catch(() => {
                        /* engine errors surface elsewhere */
                      });
                    }
                  },
                  onDragEnd: (e) => dnd.handlers.onDragEnd(e),
                }),
          };

          return <Row key={row.id} {...rowProps} />;
        })}
      </div>
    </div>
  );

  if (showFilter) {
    const outerStyle: CSSProperties = {
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      minHeight: 0,
      ...style,
    };
    return (
      <div
        className={className ? `mille-tree-container ${className}` : 'mille-tree-container'}
        data-mille-tree-container=""
        style={outerStyle}
      >
        {embeddedFilterNode}
        <div style={{ flex: '1 1 auto', minHeight: 0, overflow: 'hidden' }}>
          {treeScrollerNode}
        </div>
      </div>
    );
  }

  return treeScrollerNode;
}

// Re-export helpers are handled via components/index.js.
export type { FileTreeProps, FileTreeRowProps };
export type FileTreeEmptyStateProps = { readonly children?: ReactNode };
