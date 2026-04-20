// useFileTreeSnapshot — thin wrapper returning just the current
// MirrorSnapshot. The common consumer need; saves callers from
// destructuring the full context value.

import type { MirrorSnapshot } from '@vibecook/mille';
import { useFileTreeContext } from './useFileTreeContext.js';

export function useFileTreeSnapshot(): MirrorSnapshot {
  return useFileTreeContext().snapshot;
}
