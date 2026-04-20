// FileTreeProvider — root component wiring an `fx: FileExplorer` into
// React context. Reads the current `MirrorSnapshot` via
// `useSyncExternalStore` so React 19 concurrent rendering observes a
// consistent view between deltas.
//
// No rendering logic here: the Provider just surfaces the snapshot
// through context. Phase 3's `<FileTree>` and later phases consume it.
// See MILLE_UI_SPEC.md §4.1 and §5.1.

import { useMemo, type ReactNode } from 'react';
import { useFileExplorerSnapshot } from '@vibecook/mille/react';
import type { FileExplorer } from '@vibecook/mille';
import { FileTreeContext, type FileTreeContextValue } from './context.js';
import type { CommandRegistryHandle } from './types.js';

export interface FileTreeProviderProps {
  readonly fx: FileExplorer;
  readonly commands?: CommandRegistryHandle | null;
  readonly keybindings?: Readonly<Record<string, string | null>>;
  readonly decorationsOrder?: readonly string[];
  readonly children: ReactNode;
}

const EMPTY_KEYBINDINGS: Readonly<Record<string, string | null>> = Object.freeze({});
const EMPTY_DECORATIONS_ORDER: readonly string[] = Object.freeze([]);

export function FileTreeProvider({
  fx,
  commands = null,
  keybindings = EMPTY_KEYBINDINGS,
  decorationsOrder = EMPTY_DECORATIONS_ORDER,
  children,
}: FileTreeProviderProps): ReactNode {
  // Identity-stable across deltas; new reference only when the engine
  // publishes a 'change'. `@vibecook/mille/react` centralizes the
  // `useSyncExternalStore` wiring so both the engine's own consumers
  // and mille-ui observe bumps identically.
  const snapshot = useFileExplorerSnapshot(fx);

  const value = useMemo<FileTreeContextValue>(
    () => ({
      fx,
      snapshot,
      commands,
      keybindings,
      decorationsOrder,
    }),
    [fx, snapshot, commands, keybindings, decorationsOrder],
  );

  return <FileTreeContext.Provider value={value}>{children}</FileTreeContext.Provider>;
}
