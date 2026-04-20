// useExpandedSet — local state for the set of expanded entry ids.
//
// The set IS the source of truth for the virtualizer's row count; the
// engine gets informed via `fx.setExpanded` through the companion
// `useSetExpandedBridge` hook.
//
// Every mutator returns the NEW set identity when the content changed
// and preserves the old reference otherwise, so memo consumers don't
// re-run when a no-op mutation (e.g. removing an already-absent id)
// is requested.

import { useCallback, useMemo, useState } from 'react';
import type { EntryId } from '@vibecook/mille';

export interface ExpandedSetHandle {
  readonly expanded: ReadonlySet<EntryId>;
  add(id: EntryId): void;
  remove(id: EntryId): void;
  toggle(id: EntryId): void;
  setMany(diff: {
    readonly add?: readonly EntryId[];
    readonly remove?: readonly EntryId[];
  }): void;
  clear(): void;
}

export function useExpandedSet(
  initial?: Iterable<EntryId>,
): ExpandedSetHandle {
  const [expanded, setExpanded] = useState<ReadonlySet<EntryId>>(() =>
    initial ? new Set(initial) : new Set<EntryId>(),
  );

  const add = useCallback((id: EntryId) => {
    setExpanded((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  const remove = useCallback((id: EntryId) => {
    setExpanded((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const toggle = useCallback((id: EntryId) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const setMany = useCallback(
    (diff: { readonly add?: readonly EntryId[]; readonly remove?: readonly EntryId[] }) => {
      setExpanded((prev) => {
        const addList = diff.add ?? [];
        const removeList = diff.remove ?? [];
        let changed = false;
        const next = new Set(prev);
        for (const id of addList) {
          if (!next.has(id)) {
            next.add(id);
            changed = true;
          }
        }
        for (const id of removeList) {
          if (next.has(id)) {
            next.delete(id);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    },
    [],
  );

  const clear = useCallback(() => {
    setExpanded((prev) => (prev.size === 0 ? prev : new Set<EntryId>()));
  }, []);

  return useMemo<ExpandedSetHandle>(
    () => ({ expanded, add, remove, toggle, setMany, clear }),
    [expanded, add, remove, toggle, setMany, clear],
  );
}
