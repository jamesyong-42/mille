# mille changelog

## Unreleased

### Engine (`@vibecook/mille`)

- **Filesystem provider boundary (Phase 6.1)** — new subpath
  `@vibecook/mille/provider` with `FileSystemProvider` runtime, capability
  helpers (bits **and** method presence → `EUNSUPPORTED`), memfs with
  cycle-safe rename/copy + scoped watch, single-flight tree refresh,
  shadow-safe registry, latency/offline wrappers, and platform path helpers
  (drive/UNC/Unicode). Watcher-driven refreshes coalesce, while an explicit
  `refresh()` is serialized behind any in-flight walk — so `await writeFile()`
  → `await refresh()` never resolves with a tree read before the write.
  Local `FileExplorer` unchanged; native `registerProvider` still deferred.
- **Scoped provider invalidation** — a watcher event invalidates the directory
  whose listing it changed, and the walk re-reads only those directories,
  returning every subtree with no dirty descendant by reference. Adding one
  file to a 6-directory tree costs **2 provider calls instead of 38**;
  `bench:provider` gates the call count. `refresh()` remains a full rebuild
  (the recovery path for a missed event), as does the first walk or a burst
  touching more than 64 directories.
- **Bounded-concurrency provider walk** — a full walk overlaps provider calls
  under a shared cap (`concurrency`, default 8) instead of awaiting each
  `stat` / `readDirectory` in series. On a 38-call tree behind a 5 ms provider
  it drops from ~222 ms to ~39 ms.
- **Provider copy collisions** — `copy` takes `{ overwrite }` and fails with
  `EEXIST` when the destination exists. Copying a file used to clobber the
  destination silently while copying a directory threw; wrappers now forward
  the option instead of dropping it.
- **Offline gate covers live watchers** — a watcher created while online stops
  delivering events once the provider is marked offline, and resumes on
  reconnect. Previously "offline" only rejected new calls.
- **`parsePlatformPath` honors its `platform` argument** — passing `'posix'`
  no longer falls through to Windows drive/UNC parsing (POSIX permits `\` and
  `:` in names).

### UI (`@vibecook/mille-ui`)

- **Live announcer (Phase 6.3)** — `@vibecook/mille-ui/a11y`
  `createLiveAnnouncer` coalesces and throttles `aria-live` feedback.

## 0.2.1 — 2026-07-12

Explorer correctness + soft-duotone icons + docs site. No public-API breaks.

### Engine (`@vibecook/mille`)

- **Expand gitignored folders.** Expanding a walk-root that is itself
  ignored (e.g. `node_modules`, `out/`) no longer clears
  `read_children_path`, so Project-view “show ignored” folders populate.
- **Symlink expandability.** Walker records `symlinkTargetIsDir` from
  target metadata; `hasChildren` treats directory-target symlinks as
  expandable. UI/mirror `isExpandableEntry` matches (pnpm package
  links open as folders).
- **Project-view visible rows.** Folders-first sibling rank; default
  visibility keeps ignored/hidden entries while still hiding `.git` and
  `.DS_Store`. Library-root / symlink data attributes for chrome styling.

### UI (`@vibecook/mille-ui`)

- **Soft-duotone icon theme** — `duotoneIconTheme` via
  `@vibecook/mille-ui/icons/duotone` (also re-exported from
  `@vibecook/mille-ui/icons`). Compact filled folders + language-accent
  file chips; playground default.
- **Row layout / virtualizer.** Dropped `position: relative !important`
  on rows so absolute + `translateY` virtualization no longer doubles
  vertical gaps. VCS badges render before the name; library-root and
  symlink markers for IDE chrome.

### Docs & playground

- Static product site (`docs/index.html`) + API reference (`docs/api.html`).
- Icon theme comparison page (`docs/icons-preview.html`).
- Playground reshaped as a JetBrains-style Project tool window
  (density, library roots, gear settings, duotone default).

## 0.2.0 — 2026-04-25

Engine correctness + Track A completion. Builds on v0.1; no breaking API
changes for in-process consumers. The port wire protocol gains optional
`roots` on delta frames and adds `decorations` / `decorationChanged` frame
types — old clients keep working, new fields ignored if unused.

### Engine (`@vibecook/mille`)

- **Roots in deltas (B1).** `DeltaMsg.roots?` carries root-set updates so a
  client mirror that handshakes before the walker has populated the root
  no longer ends up with `roots=[]` forever. `populateFromRoots`-before-
  `ready` workarounds can be removed.
- **Lazy list-on-expand (B2).** New `ExplorerOptions.initialWalk?:
  'full' | 'roots-only' | 'none'` (default `'full'` for back-compat).
  `host.handleSetExpanded` now triggers shallow walks for newly-expanded
  folders whose direct children aren't yet in the store. Tree renders in
  <200 ms with `'roots-only'` even on huge repos.
- **Symlink-aware ignore (B3).** Walker applies gitignore rules on the
  DirEntry name before resolving symlinks, so pnpm-style
  `node_modules → central store` symlinks are correctly skipped.
  Walks are now O(tracked-files) on pnpm monorepos instead of
  O(tracked + store).
- **Port-side decoration pipeline (Phase A1).** New `decorations` and
  `decorationChanged` frame types. `PortFileExplorer` implements
  `registerDecorationProvider` with batched push semantics; the host
  merges into its `DecorationStore` and fans out to every connected
  client. Other clients see the same git/lint badges (by design).
- **Host-level `registerDecorationProvider`.** Decoration providers can
  be registered against the host (not just per-port-client), letting an
  embedder install one git provider that fans out to every renderer.
- **NAPI-undefined guards.** `getByUri` and provider-edge paths handle
  `undefined` returns from the binding without crashing.

### UI (`@vibecook/mille-ui`)

- **Shell-based `createShellGitClient` (B4 / A2).** Spawns
  `git status --porcelain=v2 -z`, watches `.git/HEAD` and `.git/index`
  via `node:fs.watch` (100 ms debounce). Now exported from
  `@vibecook/mille-ui/git/node` (Node-only entrypoint) so the browser
  bundle stays free of `node:child_process`.
- **Material Icon Theme bundle (B5 / A3).** `loadMaterialIconTheme()`
  returns the real bundle. Built at publish time from the upstream
  `material-extensions/vscode-material-icon-theme` repo (MIT) via
  `scripts/build-material.mjs`. See `NOTICES.md` for attribution.
- **Imperative `FileTreeRef` handle (B6).** `forwardRef` on `FileTree`
  exposes `revealPath` / `revealId` / `scrollToRow` / `clearSelection`
  / `clearFilter` / `clearClipboard` / `focusFilter`. New
  `useFileTreeRef` hook for nested consumers.
- **Headless bundle trim (B8).** Headless entry now ships logic hooks
  + ARIA primitives without the styled-row chrome. Bundle dropped from
  21.69 KB → 12.46 KB gzip (SPEC §12 target was 12 KB; landed within
  the 13 KB fail-on-regression boundary). `size-limit` now fails CI on
  regression.

### Playground (`apps/playground`)

- **Folder picker + recent folders dropdown (B7).** Open-folder button
  becomes a dropdown of up to 10 recent projects (persisted to
  `app.getPath('userData')/recent-folders.json`) plus "Browse…".
- Removed the decoration no-op shim — git and agent-rules toggles now
  render real badges via the port-side pipeline.
- Switched to `initialWalk: 'roots-only'`; dropped the
  `populateFromRoots`-before-`ready` workaround and the temporary
  `excludeGlobs` workaround for pnpm symlinks.

### Known gaps (carried into v0.2.x / v0.3)

- Headless bundle is 12.46 KB gzip vs the 12 KB SPEC §12 target — within
  the regression boundary but not under the aspirational floor.
- Full Logic-hook + View split per `MILLE_UI_SPEC` §4.9 is partial; the
  remaining row primitives are not yet split.
- Playwright perf guardrails + visual regression baselines deferred.
- Content search is still a separate package (not yet built).
- Remote FS providers (SSH, zip, memfs) reserved in API; implementations
  deferred.
- `AbortSignal` on async mutations still partial (napi-rs 3.x `!Send`).
- Windows parent-directory fsync (POSIX-only today).

## 0.1.0 — 2026-04-19

First release. Local-mode `@vibecook/mille` with:

### Rust core (`mille-core`)

- `EntryStore` with `ArcSwap` snapshot rotation, `BTreeMap` + summary caches
- Cross-platform walker (`jwalk` + `ignore` + compact folders)
- Watcher (`notify` + debouncer + rename pairing + volatile throttling)
- Crash-resume (atomic bincode write + fsync parent + `events_since` diff)
- Fuzzy search via `nucleo`
- `ChangeSet` accumulator for Phase 7 session deltas

### NAPI binding (`mille-binding`)

- `FileExplorer` class with typed `ExplorerOptions`
- `MirrorSnapshot` with `roots` / `getById` / `directChildCount` /
  `hasChildren` / `visibleRows` / `visibleRowCount`
- Mutations (`create` / `rename` / `move` / `delete` / `copy` / `readFile` /
  `readText` / `writeFile` / `readFileStream`)
- Eight event channels via `ThreadsafeFunction`
- `AbortSignal` plumbing (partial — see v0.1.x)
- Bincode `Buffer` bulk-return path

### TS client (`@vibecook/mille`)

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

- 204 `mille-core` tests (unit + integration + proptests)
- 197 package tests (unit + integration + `fast-check` proptests)

### Known gaps (tracked for v0.1.x / v0.2)

- Content search is a separate package (not yet built)
- Remote FS providers (SSH, zip, memfs) reserved in API; implementations
  deferred
- `AbortSignal` on async mutations (napi-rs 3.x `!Send` constraint)
- Windows parent-directory fsync (POSIX-only today)
- Example Electron + Playwright apps (patterns in `EMBEDDING.md`)
