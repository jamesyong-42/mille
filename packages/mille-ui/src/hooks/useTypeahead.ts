// useTypeahead — 500 ms rolling typeahead matcher for tree navigation.
//
// Standard NSOutlineView / VS Code behavior: while the tree has focus,
// pressing a printable character appends to a buffer and jumps to the
// next row whose name starts with the buffer (case-insensitive). After
// 500 ms of idle time, the buffer clears and the next keystroke starts
// a fresh search.
//
// Matching semantics (matches Finder / VS Code):
//   - Buffer is accumulated across keystrokes within the window.
//   - Match uses case-insensitive `startsWith` on the row's display name.
//   - Search begins at the row *after* the current focused row, wrapping
//     to the top. If the typed buffer's first character matches the
//     current focused row's name but the whole buffer does not, we still
//     accept the focused row when it's the best candidate (important for
//     single-letter presses where the user is stepping to the next "A...").
//   - Single-letter repeat: if the current buffer is a single identical
//     char (e.g. pressing "a" three times), the matcher treats this as
//     "step to the next A..." by searching strictly after the focused row.
//     This matches the Finder convention.
//
// The hook is kept stateful via a ref so callers' key handlers don't need
// to thread state around. The timer is kept off the React tree — reset on
// every keystroke, cleared on unmount or reset().

import { useCallback, useEffect, useRef } from 'react';
import type { EntryId } from '@vibecook/mille';

export interface TypeaheadVisibleRow {
  readonly id: EntryId;
  readonly name: string;
}

export interface UseTypeaheadOptions {
  /** Idle window in ms before the buffer resets. Default 500. */
  readonly windowMs?: number;
}

export interface TypeaheadRowSource {
  readonly rowCount: number;
  readRows(offset: number, limit: number): readonly TypeaheadVisibleRow[];
  findRowIndex(id: EntryId): number;
}

export interface TypeaheadHandle {
  /**
   * Push a keystroke and return the next matching row id, or `null` if
   * no row matches. Pass the flat visible-rows list (ordered top to
   * bottom) and the currently focused row id as the search origin.
   */
  push(
    char: string,
    visibleRows: readonly TypeaheadVisibleRow[],
    fromId: EntryId | null,
  ): EntryId | null;
  /**
   * Windowed equivalent of `push`. It preserves ordered wraparound matching
   * without allocating the complete visible-row list.
   */
  pushWindowed(
    char: string,
    source: TypeaheadRowSource,
    fromId: EntryId | null,
  ): EntryId | null;
  /**
   * Scan a small local window, then delegate a full-wrap miss to a
   * payload-free engine query. Stale async results are discarded.
   */
  pushWindowedIndexed(
    char: string,
    source: TypeaheadRowSource,
    fromId: EntryId | null,
    resolve: (
      prefix: string,
      fromId: EntryId | null,
      skipCurrent: boolean,
    ) => Promise<EntryId | null>,
  ): Promise<EntryId | null>;
  /** Clear the buffer immediately. Called from Esc etc. */
  reset(): void;
  /** Current buffer contents (mainly for testing / inspection). */
  readonly buffer: string;
}

export function useTypeahead(options: UseTypeaheadOptions = {}): TypeaheadHandle {
  const { windowMs = 500 } = options;
  const bufferRef = useRef<string>('');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestGenerationRef = useRef(0);

  const reset = useCallback(() => {
    bufferRef.current = '';
    requestGenerationRef.current += 1;
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const pushCharacter = useCallback(
    (char: string): string | null => {
      // Only accept single-character printable keys.
      if (typeof char !== 'string' || char.length !== 1) return null;
      // Filter out whitespace / control chars; keep any Unicode letter/digit.
      // We intentionally allow punctuation (e.g. "-", ".") — file names.
      if (char === ' ' || char === '\t' || char === '\n' || char === '\r') return null;

      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        bufferRef.current = '';
        requestGenerationRef.current += 1;
        timerRef.current = null;
      }, windowMs);

      bufferRef.current += char;
      return bufferRef.current.toLowerCase();
    },
    [windowMs],
  );

  const push = useCallback(
    (
      char: string,
      visibleRows: readonly TypeaheadVisibleRow[],
      fromId: EntryId | null,
    ): EntryId | null => {
      const buf = pushCharacter(char);
      if (buf === null) return null;

      if (visibleRows.length === 0) return null;

      const fromIdx = fromId !== null
        ? visibleRows.findIndex((r) => r.id === fromId)
        : -1;

      // Single-letter repeat: when the buffer is a single character,
      // always step to the next match strictly after `fromIdx`. This
      // matches Finder's "press 'a' to advance" behavior and avoids
      // sticking on the currently focused match.
      const isSingleCharStep = buf.length === 1;
      const startIdx = isSingleCharStep
        ? (fromIdx >= 0 ? fromIdx + 1 : 0)
        : (fromIdx >= 0 ? fromIdx : 0);

      // Search: wrap-around scan starting at startIdx.
      for (let offset = 0; offset < visibleRows.length; offset += 1) {
        const idx = (startIdx + offset) % visibleRows.length;
        const row = visibleRows[idx];
        if (!row) continue;
        const name = row.name.toLowerCase();
        if (name.startsWith(buf)) {
          return row.id;
        }
      }
      return null;
    },
    [pushCharacter],
  );

  const pushWindowed = useCallback(
    (
      char: string,
      source: TypeaheadRowSource,
      fromId: EntryId | null,
    ): EntryId | null => {
      const buf = pushCharacter(char);
      if (buf === null) return null;
      const rowCount = Math.max(0, Math.trunc(source.rowCount));
      if (rowCount === 0) return null;

      const fromIndex = fromId === null ? -1 : source.findRowIndex(fromId);
      const startIndex = buf.length === 1
        ? (fromIndex >= 0 ? fromIndex + 1 : 0)
        : (fromIndex >= 0 ? fromIndex : 0);
      const chunkSize = 256;
      let cursor = startIndex % rowCount;
      let remaining = rowCount;

      while (remaining > 0) {
        const limit = Math.min(chunkSize, remaining, rowCount - cursor);
        const window = source.readRows(cursor, limit);
        for (const row of window) {
          if (row.name.toLowerCase().startsWith(buf)) return row.id;
        }
        remaining -= limit;
        cursor = (cursor + limit) % rowCount;
      }
      return null;
    },
    [pushCharacter],
  );

  const pushWindowedIndexed = useCallback(
    async (
      char: string,
      source: TypeaheadRowSource,
      fromId: EntryId | null,
      resolve: (
        prefix: string,
        fromId: EntryId | null,
        skipCurrent: boolean,
      ) => Promise<EntryId | null>,
    ): Promise<EntryId | null> => {
      const buf = pushCharacter(char);
      if (buf === null) return null;
      const generation = ++requestGenerationRef.current;
      const rowCount = Math.max(0, Math.trunc(source.rowCount));
      if (rowCount === 0) return null;

      const fromIndex = fromId === null ? -1 : source.findRowIndex(fromId);
      const skipCurrent = buf.length === 1;
      const startIndex = skipCurrent
        ? (fromIndex >= 0 ? fromIndex + 1 : 0)
        : (fromIndex >= 0 ? fromIndex : 0);
      const localBudget = Math.min(rowCount, 512);
      let cursor = startIndex % rowCount;
      let remaining = localBudget;
      while (remaining > 0) {
        const limit = Math.min(256, remaining, rowCount - cursor);
        const window = source.readRows(cursor, limit);
        for (const row of window) {
          if (row.name.toLowerCase().startsWith(buf)) {
            return generation === requestGenerationRef.current ? row.id : null;
          }
        }
        remaining -= limit;
        cursor = (cursor + limit) % rowCount;
      }
      if (localBudget === rowCount) return null;

      const match = await resolve(buf, fromId, skipCurrent);
      return generation === requestGenerationRef.current ? match : null;
    },
    [pushCharacter],
  );

  // Clean the timer on unmount to avoid leaking across mounts in tests.
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  return {
    push,
    pushWindowed,
    pushWindowedIndexed,
    reset,
    get buffer() {
      return bufferRef.current;
    },
  };
}
