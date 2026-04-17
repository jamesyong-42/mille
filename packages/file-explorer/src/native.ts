// Per-platform native loader.
//
// At runtime we try/catch require() each published per-platform package, then
// fall back to a locally-built `.node` file sitting next to this file (dev
// mode, before artifacts are assembled). The list below mirrors the triples
// declared in package.json#napi.triples.additional and §6.1 of SPEC.md.
//
// TODO: Phase 5 — replace this stub with the real @napi-rs/cli generated
// loader (napi build --js-binding). The generated file will look roughly like:
//
//   const { version, FileExplorer, createFileExplorerHost, ... } =
//     loadBinding(__dirname, 'file-explorer', '@mille/file-explorer');
//
// until then we export a dummy object so the umbrella builds cleanly.

export interface NativeBinding {
  version(): string;
}

const stub: NativeBinding = {
  version: () => 'unreleased',
};

export const native: NativeBinding = stub;
export const version = stub.version;
