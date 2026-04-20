// React context carrying the engine handle and its latest snapshot.
// See MILLE_UI_SPEC.md §3 / §4.1 / §5.3.

import { createContext } from 'react';
import type { MirrorSnapshot } from '@vibecook/mille';
import type { CommandRegistryHandle } from './types.js';

// `fx` is deliberately typed as the minimal shape actually used by the
// Phase 1 context: snapshot reads + the change subscription used by
// `useSyncExternalStore`. Consumers wanting the full surface cast the
// fx they pass into Provider to `FileExplorer` at call sites; the
// context value never needs the mutation methods because those go
// through `commands.dispatch(...)`.
export interface FileTreeFx {
  getSnapshot(): MirrorSnapshot;
  on(event: 'change', listener: (n?: unknown) => void): { dispose(): void };
}

export interface FileTreeContextValue {
  readonly fx: FileTreeFx;
  readonly snapshot: MirrorSnapshot;
  readonly commands: CommandRegistryHandle | null;
  readonly keybindings: Readonly<Record<string, string | null>>;
  readonly decorationsOrder: readonly string[];
}

export const FileTreeContext = createContext<FileTreeContextValue | null>(null);
FileTreeContext.displayName = 'FileTreeContext';
