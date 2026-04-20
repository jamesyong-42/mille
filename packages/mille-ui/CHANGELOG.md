# Changelog

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
