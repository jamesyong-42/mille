// React adapter — Phase 6 commit 6.6.
//
// Thin useSyncExternalStore wrapper over FileExplorer's snapshot +
// change-event. Consumers wire it up once per FileExplorer and the
// returned MirrorSnapshot is identity-stable between deltas, so
// React 19 concurrent rendering sees a consistent view (visibleRows()
// during concurrent render won't tear).
//
// Two variants are exposed:
//   - useFileExplorerSnapshot — subscribes to 'change' (tree *or*
//     decoration bumps). Default for viewport renderers that care
//     about both dimensions.
//   - useFileExplorerTreeSnapshot — subscribes to 'change:tree'.
//     Decoration-only bumps don't re-render; useful for scanners /
//     indexers and any UI that doesn't show git/lint overlays.
//
// SSR note: both hooks use the client snapshot as the server-side
// fallback. Consumers rendering on the server should gate this call
// themselves — the native module isn't loadable outside Node.

import { useSyncExternalStore } from 'react';
import type { FileExplorer, MirrorSnapshot } from './client.js';

/**
 * Subscribe to any tree or decoration bump. Returns the current
 * MirrorSnapshot; React re-renders on each `'change'` emission.
 */
export function useFileExplorerSnapshot(fx: FileExplorer): MirrorSnapshot {
  return useSyncExternalStore(
    (onStoreChange) => {
      const sub = fx.on('change', onStoreChange);
      return () => sub.dispose();
    },
    () => fx.getSnapshot(),
    () => fx.getSnapshot(),
  );
}

/**
 * Like useFileExplorerSnapshot but scoped to tree-only bumps —
 * decoration changes don't trigger a re-render.
 */
export function useFileExplorerTreeSnapshot(fx: FileExplorer): MirrorSnapshot {
  return useSyncExternalStore(
    (onStoreChange) => {
      const sub = fx.on('change:tree', onStoreChange);
      return () => sub.dispose();
    },
    () => fx.getSnapshot(),
    () => fx.getSnapshot(),
  );
}
