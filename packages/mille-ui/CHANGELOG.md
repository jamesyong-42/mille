# Changelog

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
