// useAutoExpandDwell — 300 ms hover dwell → expand helper for Phase 11
// DnD. When the user drags a row and hovers over a collapsed folder,
// the tree auto-expands that folder after the configured dwell so the
// user can drop into a nested target without first clicking to expand.
//
// Respects `prefers-reduced-motion`: when the media query matches, the
// timer never fires; the consumer must expand via an explicit click.
// See MILLE_UI_SPEC.md §6.3 / §6.8.

import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { EntryId } from '@vibecook/mille';

export interface UseAutoExpandDwellOptions {
  /** Dwell before `onExpand` fires, in ms. Default: 300. */
  readonly delayMs?: number;
  readonly onExpand: (id: EntryId) => void;
}

export interface AutoExpandDwellHandle {
  /**
   * Begin (or restart) the dwell timer for the given id. Passing a new
   * id cancels any prior timer and starts a fresh one. Passing `null`
   * is equivalent to `clear()`.
   */
  track(id: EntryId | null): void;
  /** Cancel any pending timer without firing. */
  clear(): void;
}

/**
 * Read `prefers-reduced-motion` at call time. Cheap enough to call on
 * every `track()` — media queries don't walk DOM, they snapshot a
 * parsed value. Falls back to `false` when `matchMedia` is unavailable
 * (SSR, tests without DOM media support).
 */
function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  const mm = window.matchMedia;
  if (typeof mm !== 'function') return false;
  try {
    return mm.call(window, '(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * Hook backing the drag-auto-expand dwell. The returned `track` fn
 * restarts the timer on every new id (a drag hovering across several
 * rows cancels and restarts cleanly); `clear()` aborts on
 * `dragleave` / `drop` / `dragend`.
 */
export function useAutoExpandDwell(
  options: UseAutoExpandDwellOptions,
): AutoExpandDwellHandle {
  const { delayMs = 300, onExpand } = options;

  // Latest `onExpand` in a ref so the callback inside the timer sees
  // the current host reference without restarting timers on every
  // render.
  const onExpandRef = useRef(onExpand);
  useEffect(() => {
    onExpandRef.current = onExpand;
  }, [onExpand]);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const trackedIdRef = useRef<EntryId | null>(null);

  const clear = useCallback((): void => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    trackedIdRef.current = null;
  }, []);

  const track = useCallback(
    (id: EntryId | null): void => {
      if (id === null) {
        clear();
        return;
      }
      // Same id already being tracked — don't reset; a re-enter event
      // on the same row should not perpetually defer expansion.
      if (trackedIdRef.current === id && timerRef.current !== null) return;

      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      trackedIdRef.current = id;

      if (prefersReducedMotion()) {
        // Do not arm the timer; reduced-motion users must click to
        // expand. Tracked id stays set so the handle's state matches
        // what a consumer might inspect.
        return;
      }

      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        const pending = trackedIdRef.current;
        trackedIdRef.current = null;
        if (pending !== null) {
          try {
            onExpandRef.current(pending);
          } catch {
            // Don't crash the drag if a consumer throws.
          }
        }
      }, delayMs);
    },
    [clear, delayMs],
  );

  // Ensure any pending timer is cancelled on unmount to avoid firing
  // an expansion against a removed tree.
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      trackedIdRef.current = null;
    };
  }, []);

  return useMemo<AutoExpandDwellHandle>(
    () => ({ track, clear }),
    [track, clear],
  );
}
