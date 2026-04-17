// React adapter: useSyncExternalStore over MirrorSnapshot.
//
// TODO: Phase 6 — implement useFileExplorerSnapshot(fx): MirrorSnapshot
// Thin wrapper around React.useSyncExternalStore that subscribes to the
// 'change' event and returns the identity-stable snapshot described in
// api.d.ts / SPEC.md §3.2.

// Types are declared in ../api.d.ts; see note in ./host.ts — Phase 6 will
// replace these placeholders with the real internal type module.
type FileExplorer = unknown;
type MirrorSnapshot = unknown;

export function useFileExplorerSnapshot(_fx: FileExplorer): MirrorSnapshot {
  throw new Error('TODO: Phase 6 — useFileExplorerSnapshot not yet implemented');
}
