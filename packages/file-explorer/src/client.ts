// Renderer-side entry. See SPEC.md §2.1 and §4.9.
//
// TODO: Phase 8 — implement connectFileExplorer(port, options): Promise<FileExplorer>
// Attaches to a MessagePort exposed by a FileExplorerHost and returns a
// FileExplorer whose sync reads are served by the local ViewportMirror.

// Types are declared in ../api.d.ts; see note in ./host.ts — Phase 8 will
// replace these placeholders with the real internal type module.
type ClientOptions = unknown;
type FileExplorer = unknown;
type MessagePortLike = unknown;

export async function connectFileExplorer(
  _port: MessagePortLike,
  _options?: ClientOptions,
): Promise<FileExplorer> {
  throw new Error('TODO: Phase 8 — connectFileExplorer not yet implemented');
}
