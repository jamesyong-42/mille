// useContextMenuState — tracks per-tree context-menu anchor state.
//
// Phase 6. Two shapes of "open":
//
//   - Mouse right-click: Radix's `ContextMenu.Root` (one per row) opens
//     itself in response to the real `contextmenu` event; this hook's
//     state does NOT need to be set for that path. Row wrappers select
//     the target row (if not already in selection) and let Radix take
//     over.
//
//   - Keyboard (Menu / Shift+F10): the tree container captures the key
//     and has to synthesize a `contextmenu` event on the focused row's
//     DOM node so Radix anchors at that row's top-left. This hook
//     owns the tiny registry of row DOM refs (keyed by `EntryId`) that
//     the tree populates as rows mount and the keyboard handler
//     consumes when it needs to dispatch the synthetic event.

import { useCallback, useMemo, useRef } from 'react';
import type { EntryId } from '@vibecook/mille';

/**
 * Imperative handle returned from `useContextMenuState`. Rows call
 * `registerRowElement(id, el)` when they mount to hand their DOM node
 * to the tree; the tree's keyboard path calls `openAtRow(id)` to fire
 * a synthetic `contextmenu` event at that row's top-left.
 */
export interface ContextMenuStateHandle {
  /**
   * Register (or clear with `null`) the DOM element for a given row id.
   * Idempotent — subsequent registrations overwrite the prior entry.
   */
  registerRowElement(id: EntryId, el: HTMLElement | null): void;
  /**
   * Programmatically open the context menu at the given row. Synthesizes
   * a real `MouseEvent('contextmenu')` on the row's DOM node so Radix's
   * anchor-at-cursor machinery picks it up. Returns `true` on success.
   */
  openAtRow(id: EntryId): boolean;
}

export function useContextMenuState(): ContextMenuStateHandle {
  const rowsRef = useRef<Map<EntryId, HTMLElement>>(new Map());

  const registerRowElement = useCallback(
    (id: EntryId, el: HTMLElement | null) => {
      const map = rowsRef.current;
      if (el === null) {
        map.delete(id);
      } else {
        map.set(id, el);
      }
    },
    [],
  );

  const openAtRow = useCallback((id: EntryId): boolean => {
    const el = rowsRef.current.get(id);
    if (!el) return false;
    // Compute a sensible anchor: top-left of the row + small offset so
    // Radix's collision-avoidance doesn't shove the menu off-screen.
    // `getBoundingClientRect` may not be fully driven under happy-dom;
    // fall back to (0,0) if it returns zeros.
    let clientX = 0;
    let clientY = 0;
    if (typeof el.getBoundingClientRect === 'function') {
      const rect = el.getBoundingClientRect();
      clientX = Math.floor(rect.left) + 8;
      clientY = Math.floor(rect.top) + 8;
    }
    // Prefer the global `MouseEvent` so happy-dom's event path runs;
    // bail gracefully if the env somehow lacks it.
    const MouseEventCtor =
      typeof globalThis !== 'undefined' &&
      typeof (globalThis as { MouseEvent?: typeof MouseEvent }).MouseEvent === 'function'
        ? (globalThis as { MouseEvent: typeof MouseEvent }).MouseEvent
        : null;
    if (!MouseEventCtor) return false;
    const evt = new MouseEventCtor('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY,
      button: 2,
    });
    el.dispatchEvent(evt);
    return true;
  }, []);

  return useMemo<ContextMenuStateHandle>(
    () => ({ registerRowElement, openAtRow }),
    [registerRowElement, openAtRow],
  );
}
