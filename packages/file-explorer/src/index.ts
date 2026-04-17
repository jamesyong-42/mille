// @mille/file-explorer — entry point
//
// TODO: Phase 6 — export the full public API described in ../api.d.ts.
// For now this just re-exports the native loader stub so the workspace wires up
// end-to-end. Subsequent phases will layer on:
//   - Phase 5: wire the real NAPI-RS generated loader in ./native
//   - Phase 6: FileExplorer class, MirrorSnapshot, React adapter (./react)
//   - Phase 8: UtilityProcess host/client split (./host, ./client)

export * from './native.js';
