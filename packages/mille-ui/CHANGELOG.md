# Changelog

## Unreleased

### Added

- **Real external import via `copyFromPath`** — OS drag-in requires the engine
  `copyFromPath` API and imports file/directory contents instead of creating
  empty placeholder entries. Per-item failures are collected and reported;
  partial directory copies do not leave silent empty files.
- **Root-aware scoped-search handoff** — folder menus add Find in Folder,
  Include in Search, and Exclude from Search. `onSearchScope` receives a
  provider-neutral, bounded, atomic request containing exact root-aware
  targets, including multi-selection for include/exclude. The host remains
  responsible for translating literals to its content-search provider.
- **Authoritative refresh and controlled collapse** — files/folders expose
  Refresh from Disk, roots expose Refresh Workspace, and hosts can intercept
  both through `onRefresh`. Collapse All and the new Collapse Descendants
  command now update the tree's actual React expansion state; the imperative
  handle adds `collapseDescendants(id)`. A 100,000-wide/10,000-deep benchmark
  guards descendant-state computation.
- **Root-aware file-system host actions** — the default command registry and
  context menu now provide Copy Absolute Path, Copy Workspace-Relative Path,
  Reveal in File Manager, Open Containing Folder, and Open in Terminal.
  `FileTree` exposes narrow async callbacks with a canonical `FileActionTarget`;
  the Electron playground validates workspace containment in its main process
  before invoking clipboard, shell, or terminal capabilities.
- **Active-entry disposition policy** — `activeEntry` descriptors can tag
  generated or external targets; `activeEntryPolicy` controls opt-in reveal of
  hidden, ignored/excluded, and generated entries; and
  `onActiveEntryResolution` reports visible/hidden/ignored/generated/external/
  missing outcomes. Conservative defaults avoid pending reveals and external
  workspace lookups.
- **Typed file-open policy** — `openBehavior` optionally previews files on
  single click while retaining selection-only as the default.
  `onOpen(entry, event)` identifies preview/permanent mode and the mouse,
  keyboard, search, or command source so editor hosts can implement one preview
  slot and permanent-tab promotion consistently.
- **Active-editor following** — `activeEntry` marks the file active in the
  host editor independently of tree focus/selection, while
  `autoRevealActiveEntry` optionally expands and scrolls through the lazy
  indexed-path pipeline without stealing focus or snapping back on unrelated
  updates.
- **Versioned navigation persistence** — path-based expansion, selection,
  focus, filter mode, and pixel scroll anchors via
  `initialNavigationState`, `onNavigationStateChange`, and
  `FileTreeRef.captureNavigationState()` / `restoreNavigationState()`.
  State is migrated, validated, bounded, and restored through lazy indexed
  path resolution rather than unstable process-local entry IDs.
- **Minimal archival theme** — paper/ink Structure-panel look from the
  spaghetti-ui `FileTreeNode` design. CSS:
  `@vibecook/mille-ui/theme/minimal.css` (activate with
  `data-mille-theme="minimal"`). Icons: `minimalIconTheme` via
  `@vibecook/mille-ui/icons/minimal`. Matches: mono 10px / folder
  natural-case mono labels, `[+]`/`[-]` w-4 disclosure, inverted
  selection, dashed indent rails, `depth*12+8` padding, section
  `px-2 py-2` gutter.
- **`data-mille-kind`** on rows (`directory` | `file` | `symlink`) so
  host themes can style folder labels without re-implementing the row.
- **`--mille-indent-guide-style`** token (default `solid`; minimal uses
  `dashed`).
- **`--mille-row-padding-inline`** — base inset before `depth * indent`
  (minimal uses `8px`); indent guides offset to match.

## 0.2.1 — 2026-07-12

Soft-duotone icons + Project-view row polish. Additive; no public-API breaks.

### Added

- **`duotoneIconTheme`** — `@vibecook/mille-ui/icons/duotone` (and
  re-export from `@vibecook/mille-ui/icons`). Soft-duotone set: filled
  blue folders and dark file bodies with a language-color chip. Designed
  for dense IDE sidebars; playground default.
- **Library / symlink row affordances** — data attributes for library
  roots and directory-target symlinks so host chrome can style them
  (e.g. node_modules tint, symlink mark).

### Fixed

- Virtualized rows no longer double vertical spacing (`position:
  relative !important` removed so `translateY` virtualization works).
- Expand chevrons track `symlinkTargetIsDir` / unwalked dirs correctly
  for pnpm-style package links.
- VCS decoration badges paint before the filename (Project-view order).

## 0.2.0 — 2026-04-25

Demo-ready release. Track A complete (port-side decorations + real git
client + Material icon bundle) plus headless bundle trim and an
imperative tree handle. No public-API breaks; new exports are additive.

### Added

- **`createShellGitClient`** — `@vibecook/mille-ui/git/node`. Real
  `git status --porcelain=v2 -z` + `.git/HEAD` / `.git/index` watcher
  (100 ms debounced). The pure-spec `@vibecook/mille-ui/git` entrypoint
  remains browser-safe; Node-only shell client moved to a sibling
  subpath.
- **Material Icon Theme** — `loadMaterialIconTheme()` now returns the
  real upstream bundle (MIT, `material-extensions/vscode-material-icon-theme`).
  Built at publish time via `scripts/build-material.mjs`. See
  `NOTICES.md`.
- **Imperative `FileTreeRef`** — `forwardRef` on `FileTree` exposes
  `revealPath` / `revealId` / `scrollToRow` / `clearSelection` /
  `clearFilter` / `clearClipboard` / `focusFilter`. New
  `useFileTreeRef` hook for nested consumers (no prop-drilling).
- **Decoration providers across the port boundary** — pairs with the
  engine's new `decorations` / `decorationChanged` frame types.
  `registerGitDecorations` / `registerAgentRulesDecorations` accept a
  `FileExplorer` *or* `PortFileExplorer`.
- **`size-limit` enforced in CI** — headless bundle has a 13 KB
  fail-on-regression boundary (SPEC §12 target 12 KB).

### Changed

- **Headless bundle 21.69 KB → 12.46 KB gzip.** Logic hooks +
  ARIA primitives are now exported directly from
  `@vibecook/mille-ui/headless` without the styled-row chrome.
- Git decoration helper relocated to `@vibecook/mille-ui/git/node` so
  the browser-safe `@vibecook/mille-ui/git` entrypoint no longer pulls
  in `node:child_process` / `node:fs`.

### Fixed

- Decoration provider registration is robust against `undefined` from
  the NAPI edge (`getByUri` guard).
- Host-level `registerDecorationProvider` fans out to every connected
  port client, not just the one that registered.

### Deferred to v0.3 (carried)

- Headless bundle to land under the 12 KB §12 target (currently 12.46 KB).
- Full Logic-hook + View split for the remaining row primitives.
- Playwright perf guardrails + visual regression baselines.
- libgit2 (or `isomorphic-git`) GitClient for environments without a
  `git` binary on PATH.

## 0.1.0 — 2026-04-20

Initial release of `@vibecook/mille-ui` — React file-tree UI companion
to `@vibecook/mille`.

### Added

- `<FileTreeProvider>` + `<FileTree>` — virtualized tree rendering over `MirrorSnapshot`
- Default + headless entry points (`@vibecook/mille-ui` + `@vibecook/mille-ui/headless`)
- Command registry with `Mod+N`, `F2`, `Delete`, arrow nav, Shift-range select, typeahead, `Cmd+F`
- Inline rename + new-file / new-folder flow
- Context menu via `@radix-ui/react-context-menu`
- Cut / copy / paste with multi-select delete confirmation
- Filter (client-side) + ranked search (`fx.search` via `<FileTreeFilter>`)
- Decorations pipeline (`<FileDecorations>` + dual tree / decoration versions)
- VS Code File Icon Theme JSON compat — Seti / Material / vscode-icons drop in
- Drag-and-drop: tree↔tree, OS→tree, tree→chat (MIME `application/vnd.claude.attachment`)
- Git decoration companion (`@vibecook/mille-ui/git`) — host-supplied client
- Agent-rules companion (`@vibecook/mille-ui/agent-rules`) — `.cursor/rules`, `.kiro/steering/`, `CLAUDE.md`, etc.
- WAI-ARIA 1.2 Tree Pattern compliance

### Deferred to v0.2

- Decoration protocol frame for the port client (host-to-client provider forwarding)
- Real libgit2 integration (v0.1 ships a stub)
- Material Icon Theme bundle
- Playwright perf guardrail + visual regression baselines
- Full Logic-hook + View split per SPEC §4.9

### Contributors

- James Yong
