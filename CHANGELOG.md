# mille changelog

## Unreleased

Windows was building but never running. Every test job targeted
`ubuntu-latest`; Windows appeared only in the build matrix, which compiles a
`.node` and uploads it without loading it. The one thing that executed on
Windows was the post-release published-package smoke test — 94 lines that load
the binary and perform a single walk. So the watcher, the host/renderer port
protocol and the mutation paths shipped unexercised there, and three defects
were living in that gap.

### Engine (`@vibecook/mille`)

- **Every file save on Windows arrived as a warning, a pair-window late** —
  `ReadDirectoryChangesW` reports a content write as `FILE_ACTION_MODIFIED`
  without distinguishing data from metadata, so notify surfaces `Modify(Any)`.
  That fell into the classifier's catch-all and became `RawEvent::Any`, and
  `Any` is not merely "ambiguous": it is the only channel `RenamePairer`
  accepts. Every save was therefore queued as a possible rename half, held for
  the pair window, then flushed as `RenameDegraded` — consumers listening for
  `changed` never fired, and got a `WRENAMEDEGRADED` warning instead. Measured
  through the public API: modify now reports `changed` in ~49 ms (the debounce)
  where it previously reported a warning. Reconciliation was never affected —
  `Modified` and `Unknown` take the same `reconcile_nearest_parent`.
  Classifying `Modify(Any)` alone regressed directory renames, because Windows
  can report `Modify(Name(..))` and `Modify(Any)` for one path in a single
  batch and the coalescer's `Modified`-wins arm then consumed the rename's
  "from" half, leaving the destination with no known descendants; the coalescer
  keeps the pairing channel intact on Windows for that reason. Both halves are
  pinned by tests that assert the Windows and non-Windows mappings explicitly.
- **The documented synchronization points were timed, not acknowledged** —
  `mutate`, `updateProjectionSettings`, `reorderRoots`, `updateWorkspaceRoots`
  and `refreshWorkspaceRoots` all promise in comments that every attached
  mirror is current before the initiating client observes completion, but each
  flushed with a single `setImmediate`. That is a guess about when the peer
  runs; it held on an idle Linux runner and lost on Windows, where a second
  client's mirror was reliably one version behind when the initiator's promise
  resolved. They now use the acknowledged flush that `resync` already had. Six
  tests across five files covered this invariant and had never run on a
  platform that could fail it.
- **A client that never acknowledges no longer slows every mutation** — the
  change above introduced this: a session that handshakes but predates the
  `ack` frame cannot satisfy the wait, so each mutation paid the full fallback,
  measured at ~1012 ms per rename. Sessions that time out are now marked and
  skipped by later synchronization points, and any `ack` restores standing, so
  a momentarily busy renderer recovers rather than being written off. One
  bounded probe, then ~1 ms.
- **Windows filesystem errors reported `EUNKNOWN`** — error mapping fell back
  to `io::ErrorKind` on Windows, which has no category for
  `ERROR_SHARING_VIOLATION`: a file held by another process (an open editor, a
  scanner) reported `EUNKNOWN` despite `EMBEDDING.md` documenting `EBUSY` for
  exactly that case. Win32 status codes now map explicitly — sharing and lock
  violations, disk-full, write-protect, invalid name, aborted operation and
  reparse-resolution failure among them.

### Tooling & CI

- **The suite runs on Windows** — a `test-windows` job runs fmt, clippy, the
  Rust suite, the full JS suite, and repeats the watcher and port
  synchronization regressions ten times each. It carries an explicit
  `timeout-minutes`, because the failure mode that concealed the port defect
  was a test process that completed its tests and then never exited.
- **Line endings are pinned** — `.editorconfig` declared `end_of_line = lf`
  but nothing enforced it at checkout, so a Windows clone (Git's default
  `core.autocrlf=true`) materialized the tree as CRLF. That broke
  `pnpm format:check` and `cargo fmt --check` wholesale — `rustfmt.toml` sets
  `newline_style = "Unix"` — and left the committed, generated `tokens.css`
  dirty after every build. A `.gitattributes` pins the checkout and
  `tokens.css` generation moved to a script that normalizes line endings, so
  the artifact is byte-identical on every platform.
- **`pnpm test` runs outside a globbing shell** — the package test scripts were
  spelled `node --test test/*.test.mjs`, which depends on the *shell* expanding
  the glob. pnpm runs package scripts through the platform shell, and neither
  cmd.exe nor PowerShell expands globs, so on Windows Node received the pattern
  verbatim and exited before running anything. Node only learned to expand
  globs itself in v21 and this repo targets v20, so the three packages now
  share a small runner that expands it explicitly.
- **Test files no longer assume POSIX** — `smoke.test.mjs` and
  `decode.test.mjs` hardcoded a `.node` candidate list covering only darwin
  and linux-gnu; the first failed at import on Windows and musl, and the
  second silently skipped its only live round-trip while reporting green. Both
  now derive the binary name from the host. Also fixed: POSIX basename
  splitting on real temp paths, Unix errno literals, rooted-but-not-absolute
  workspace paths, a symlink fixture that needs Windows Developer Mode, and a
  git fixture that inherited the developer's `core.autocrlf`.

## 0.3.0 — 2026-07-25

Ships Phases 4.4, 5 and 6.1–6.3, and closes a defect that made every prior
release unsafe to embed: a Rust panic aborted the host process outright. If you
are on 0.2.x inside an Electron app, this is the upgrade that stops an
unexpected filesystem edge case from taking the whole editor with it.

### Engine (`@vibecook/mille`)

- **A native panic no longer kills the host process** — mille loads into
  someone else's Electron main process, and until now any Rust panic took that
  process down with it via SIGABRT: no catchable error, no crash handler,
  nothing flushed. Two independent causes, both measured before being fixed.
  `[profile.release]` carried `panic = "abort"`, so a release build exited 134
  for both a sync and an async entry point; abort also defeats tokio's own
  task-level capture, which is why async calls recovered in a debug build and
  died in release. And none of the 67 callable `#[napi]` entry points opted
  into `catch_unwind` (napi-rs makes it per-function opt-in), so panics unwound
  out of the generated `extern "C"` shim — an abort by definition, measured at
  134 even in debug. The release profile now unwinds and every entry point
  carries the attribute; a panic arrives in JS as a normal catchable error.
  `buildIdentity()` gains `nativePanicStrategy` so an embedder can assert this
  about the binary it actually loaded.
- **Filesystem provider boundary (Phase 6.1)** — new subpath
  `@vibecook/mille/provider` with `FileSystemProvider` runtime, capability
  helpers (bits **and** method presence → `EUNSUPPORTED`), memfs with
  cycle-safe rename/copy + scoped watch, single-flight tree refresh,
  shadow-safe registry, latency/offline wrappers, and platform path helpers
  (drive/UNC/Unicode). Watcher-driven refreshes coalesce, while an explicit
  `refresh()` is serialized behind any in-flight walk — so `await writeFile()`
  → `await refresh()` never resolves with a tree read before the write.
  Local `FileExplorer` unchanged; native `registerProvider` still deferred.
- **`resync` is an acknowledged synchronization point** — the host used to
  flush deltas and wait one `setImmediate`, which is not observable evidence
  that a peer applied anything; the guarantee held on an idle machine and lost
  under load. Deltas flushed by `resync` / `resyncWorkspace` now carry
  `ackRequested`, clients reply with an `ack` frame once applied, and the call
  resolves when every attached session has confirmed. Additive and
  version-compatible: a client that never acks (or predates the frame) is
  covered by a 1 s fallback, which degrades to the old behaviour rather than
  hanging. Ordinary churn is unchanged — no acks are requested, so the hot
  path stays one-way.

  The ack frame alone was not enough, and the fallback hid the remainder for a
  while: `applyDelta` **assigned** the incoming `treeVersion` instead of
  advancing to it. A delta emitted only to carry markers (subtree
  resynced/dirty, root changes, decorations) reports an empty ChangeSet's
  version, which lags whatever the periodic tick already delivered — so such a
  delta dragged an up-to-date mirror *backwards*, and the regressed mirror
  acked the stale version. `resync` then waited for a target no ack could
  reach and fell through to the 1 s timeout, returning as though it had
  synchronized. It reproduced about one run in twenty on an idle machine.
  The fix is that mirror versions are now monotonic — one `Math.max`.
  `applyViewportPatch` had always advanced this way; `applyDelta` had not.
  Deltas deliberately keep reporting the ChangeSet's version rather than the
  host's current one: understating is the safe direction, since a monotonic
  mirror cannot be dragged backwards by it, while overstating would ship a
  version whose entries are not in that delta and let a client ack content it
  never received.
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
- **`VERSION` no longer lies** — the exported constant read `'0.1.0'` in all
  three entry points that declare it, while the package shipped as 0.2.1.
  Nothing compared the two, so it drifted three releases. Now matched to
  `package.json` and guarded by a test.

### Versioning

- The Rust crates and the npm packages now share one version. `buildInfo()`
  used to report `crateVersion: '0.1.0'` from a 0.2.1 package, which made
  build identity in a bug report ambiguous.

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
