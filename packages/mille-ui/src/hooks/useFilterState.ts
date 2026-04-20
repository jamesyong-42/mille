// useFilterState — local state for the `<FileTreeFilter>` input.
//
// Phase 8. Keeps the tree's filter text in local React state, with the
// standard controlled/uncontrolled split used throughout mille-ui.
// Exposes `clear()` as a convenience for Esc handling.
//
// - Uncontrolled: seeded from `''` on mount; `setFilter(next)` updates
//   the internal state and optionally fires an observer.
// - Controlled: `opts.controlled = { value, onChange }`; `setFilter`
//   only fires `onChange`, never touches internal state.
//
// The filter value is kept intentionally opaque: higher-level logic
// (substring match for `mode='filter'`, debounced search for
// `mode='search'`) lives in `<FileTree>` and `useSearchResults`.

import { useCallback, useState } from 'react';

export interface UseFilterStateControlled {
  readonly value: string;
  onChange(next: string): void;
}

export interface UseFilterStateOptions {
  readonly controlled?: UseFilterStateControlled;
  /** Initial value when uncontrolled. Defaults to `''`. */
  readonly defaultValue?: string;
}

export interface FilterStateHandle {
  readonly filter: string;
  setFilter(next: string): void;
  clear(): void;
}

/**
 * Hook returning `{ filter, setFilter, clear }`.
 *
 * The hook is intentionally tiny — it mirrors `useControlledState` but
 * exposes a more ergonomic `clear()` call site (Esc at the tree level).
 */
export function useFilterState(
  opts: UseFilterStateOptions = {},
): FilterStateHandle {
  const { controlled, defaultValue = '' } = opts;
  const isControlled = controlled !== undefined;

  const [internal, setInternal] = useState<string>(defaultValue);

  const setFilter = useCallback(
    (next: string) => {
      if (isControlled) {
        controlled!.onChange(next);
      } else {
        setInternal(next);
      }
    },
    [isControlled, controlled],
  );

  const clear = useCallback(() => {
    setFilter('');
  }, [setFilter]);

  const filter = isControlled ? controlled!.value : internal;

  return { filter, setFilter, clear };
}
