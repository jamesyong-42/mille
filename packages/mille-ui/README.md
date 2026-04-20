# @vibecook/mille-ui

React file-tree UI companion to [`@vibecook/mille`](../mille).
Virtualized, accessible, VS Code File Icon Theme compatible out of the
box. Designed to drop into an Electron IDE or any React 19 app in an
evening. The engine owns tree structure; this package renders it.

See [`research/file-explorer/MILLE_UI_SPEC.md`](../../research/file-explorer/MILLE_UI_SPEC.md)
for the full design spec and
[`research/file-explorer/EMBEDDING_UI.md`](../../research/file-explorer/EMBEDDING_UI.md)
for the integration guide.

## Install

```bash
pnpm add @vibecook/mille @vibecook/mille-ui react react-dom \
         @tanstack/react-virtual \
         @radix-ui/react-context-menu @radix-ui/react-dialog @radix-ui/react-tooltip
```

The three Radix peers are optional — only needed if you use the styled
default entry. The headless entry (`@vibecook/mille-ui/headless`) has
no runtime style dependencies.

## Quickstart

```tsx
import { FileExplorer } from '@vibecook/mille';
import { FileTree } from '@vibecook/mille-ui';
import '@vibecook/mille-ui/tokens.css';

const fx = new FileExplorer({ roots: ['/path/to/workspace'] });
await fx.populateFromRoots();

export function Sidebar() {
  return <FileTree fx={fx} ariaLabel="Files" rowHeight={22} />;
}
```

## Features

- Virtualized rendering over `MirrorSnapshot` (tested to 500k rows).
- WAI-ARIA 1.2 Tree Pattern: `role="tree"`, roving `tabindex`,
  `aria-selected`, `aria-level`, `aria-expanded`, `aria-setsize`,
  `aria-posinset`.
- Keyboard model: arrow nav, typeahead, Shift-range select, `F2`
  rename, `Delete`, `Cmd+F` search, `Mod+N` new file.
- Inline rename + create flow with error state.
- Context menu via Radix (optional peer).
- Cut / copy / paste with multi-select.
- Client-side filter + server-ranked search (`fx.search`).
- Decorations pipeline — stable identity per-row so Git / lint /
  problems overlays don't re-render rows that didn't change.
- VS Code File Icon Theme JSON compat (Seti, vscode-icons, Material
  all drop in).
- Drag-and-drop: tree↔tree, OS→tree, and tree→chat via
  `application/vnd.claude.attachment`.

## Entry points

| Import                              | What you get                            |
|-------------------------------------|-----------------------------------------|
| `@vibecook/mille-ui`                | Styled default — includes Radix menus.  |
| `@vibecook/mille-ui/headless`       | Structural components + class catalog.  |
| `@vibecook/mille-ui/git`            | Git decoration provider (host-wired).   |
| `@vibecook/mille-ui/agent-rules`    | `.cursor/rules`, `CLAUDE.md`, `.kiro`.  |
| `@vibecook/mille-ui/icons/default`  | Built-in folder + file icon set.        |
| `@vibecook/mille-ui/testing`        | `createFakeEngine` for unit tests.      |

## Status

v0.1.0 — released 2026-04-20. See [CHANGELOG.md](./CHANGELOG.md).

## License

MIT
