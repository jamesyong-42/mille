// UtilityProcess-side entry. See SPEC.md §2.1 and §4.9.
//
// TODO: Phase 8 — implement createFileExplorerHost(options): Promise<FileExplorerHost>
// Owns the native EntryStore + walker + watcher; accepts MessagePort attachments
// from renderer clients.

// Types are declared in ../api.d.ts (sibling to this package's src) but are
// intentionally not re-imported here: the umbrella's published public types
// live in dist/ after build, and this stub doesn't need them at compile time.
// Phase 8 will wire the real types through a proper internal module.
type ExplorerOptions = unknown;
type FileExplorerHost = unknown;

export async function createFileExplorerHost(
  _options: ExplorerOptions,
): Promise<FileExplorerHost> {
  throw new Error('TODO: Phase 8 — createFileExplorerHost not yet implemented');
}
