# mille changelog

## 0.1.0 — 2026-04-19

First release. Local-mode `@mille/file-explorer` with:

### Rust core (`fx-core`)

- `EntryStore` with `ArcSwap` snapshot rotation, `BTreeMap` + summary caches
- Cross-platform walker (`jwalk` + `ignore` + compact folders)
- Watcher (`notify` + debouncer + rename pairing + volatile throttling)
- Crash-resume (atomic bincode write + fsync parent + `events_since` diff)
- Fuzzy search via `nucleo`
- `ChangeSet` accumulator for Phase 7 session deltas

### NAPI binding (`fx-binding`)

- `FileExplorer` class with typed `ExplorerOptions`
- `MirrorSnapshot` with `roots` / `getById` / `directChildCount` /
  `hasChildren` / `visibleRows` / `visibleRowCount`
- Mutations (`create` / `rename` / `move` / `delete` / `copy` / `readFile` /
  `readText` / `writeFile` / `readFileStream`)
- Eight event channels via `ThreadsafeFunction`
- `AbortSignal` plumbing (partial — see v0.1.x)
- Bincode `Buffer` bulk-return path

### TS client (`@mille/file-explorer`)

- Per-platform optional-deps loader
- `FileSystemError` + `isFileSystemError`
- Bincode decoder for bulk rows
- Typed `FileExplorer` wrapper with `wrap()`-based error reconstruction
- `useFileExplorerSnapshot` React hook
- Host / client split: `createFileExplorerHost` + `connectFileExplorer`
- Full IPC protocol (handshake + snapshot + delta + mutate/call + dispose)
- Mutation ordering guarantees (SPEC §5.1 — delta-before-result)
- Coarse / dirty / resynced subtree plumbing
- Client-side `ViewportMirror` with frozen `MirrorSnapshot`, cache-miss
  placeholders, `mirrorCap` eviction
- Decoration providers with scoped `change:decorations` events

### Tests

- 204 `fx-core` tests (unit + integration + proptests)
- 197 package tests (unit + integration + `fast-check` proptests)

### Known gaps (tracked for v0.1.x / v0.2)

- Content search is a separate package (not yet built)
- Remote FS providers (SSH, zip, memfs) reserved in API; implementations
  deferred
- `AbortSignal` on async mutations (napi-rs 3.x `!Send` constraint)
- Windows parent-directory fsync (POSIX-only today)
- Example Electron + Playwright apps (patterns in `EMBEDDING.md`)
