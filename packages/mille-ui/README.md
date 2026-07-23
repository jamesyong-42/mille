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
- Bounded, versioned navigation persistence with lazy path-based restore.

## Persist navigation

The tree owns navigation state but leaves the storage location to the host:

```tsx
import {
  FileTree,
  serializeFileTreeNavigationState,
} from '@vibecook/mille-ui';

const storageKey = 'workspace:demo:file-tree';

<FileTree
  fx={fx}
  ariaLabel="Files"
  initialNavigationState={localStorage.getItem(storageKey)}
  onNavigationStateChange={(state) => {
    localStorage.setItem(storageKey, serializeFileTreeNavigationState(state));
  }}
/>;
```

The persisted record uses root-qualified paths, not process-local entry IDs,
and includes expansion, selection, focus, filter text/mode, and scroll anchor.
Missing paths are skipped during restore.

## Follow the active editor

Keep editor state separate from tree focus and selection, with optional
one-shot reveal whenever the editor target changes:

```tsx
<FileTree
  fx={fx}
  ariaLabel="Files"
  activeEntry={activeEntryId}
  autoRevealActiveEntry
/>;
```

`activeEntry` accepts an indexed `EntryId`, a workspace-relative/root-qualified
path, or a descriptor that tags a generated/external target. IDs take the
direct fast path; paths use lazy indexed resolution and hydrate only the
target's ancestor chain. The active row exposes `aria-current="page"` and
`data-mille-active="true"`. Auto-reveal expands and scrolls without changing
tree focus or selection, and it runs only when the target changes, so later
user navigation is not undone by unrelated updates.

Hidden, ignored/excluded, and host-tagged generated targets do not auto-reveal
by default. External targets bypass workspace resolution, and missing targets
have no tree side effect. Hosts can opt into an exception and observe every
decision:

```tsx
<FileTree
  fx={fx}
  activeEntry={{ target: generatedEntryId, origin: 'generated' }}
  autoRevealActiveEntry
  activeEntryPolicy={{ revealGenerated: true }}
  onActiveEntryResolution={({ disposition, autoReveal }) => {
    telemetry.record('explorer.activeEntry', { disposition, autoReveal });
  }}
/>;
```

## Control file opening

The default mouse policy selects on single click and opens permanently on
double click. Opt into IDE-style preview tabs and use the typed intent to keep
preview state in the editor host:

```tsx
import type { Entry } from '@vibecook/mille';
import { FileTree, type FileOpenEvent } from '@vibecook/mille-ui';

function openEditor(entry: Entry, event: FileOpenEvent) {
  editor.open(entry, { preview: event.mode === 'preview' });
}

<FileTree
  fx={fx}
  ariaLabel="Files"
  openBehavior={{ singleClick: 'preview' }}
  onOpen={openEditor}
/>;
```

`onOpen` reports both `mode` (`preview` or `permanent`) and `source`
(`singleClick`, `doubleClick`, `keyboard`, `search`, or `command`). Keyboard,
search, context-menu, and default double-click opens are permanent. A modified
click used for range or multi-selection never opens a preview.

## Entry points

| Import                              | What you get                            |
|-------------------------------------|-----------------------------------------|
| `@vibecook/mille-ui`                | Styled default — includes Radix menus.  |
| `@vibecook/mille-ui/headless`       | Structural components + class catalog.  |
| `@vibecook/mille-ui/git`            | Git decoration provider (host-wired).   |
| `@vibecook/mille-ui/agent-rules`    | `.cursor/rules`, `CLAUDE.md`, `.kiro`.  |
| `@vibecook/mille-ui/icons/default`  | Built-in monoline folder + file set.    |
| `@vibecook/mille-ui/icons/duotone`  | Soft-duotone set (scannable, compact).  |
| `@vibecook/mille-ui/icons/material` | Material Icon Theme bundle (publish-time). |
| `@vibecook/mille-ui/icons/minimal`| Archival text-first set (no glyphs).    |
| `@vibecook/mille-ui/theme/minimal.css` | Minimal paper/ink tree chrome.   |
| `@vibecook/mille-ui/testing`        | `createFakeEngine` for unit tests.      |

## Icon themes

```tsx
import { FileTree } from '@vibecook/mille-ui';
import { duotoneIconTheme } from '@vibecook/mille-ui/icons/duotone';
// or: defaultIconTheme, minimalIconTheme, loadMaterialIconTheme()

<FileTree fx={fx} ariaLabel="Files" iconTheme={duotoneIconTheme} />
```

- **default** — monoline outline set (library default when no theme is set).
- **duotone** — filled folders + language accent chips (product / playground default).
- **material** — full VS Code Material Icon Theme JSON via `loadMaterialIconTheme()`.
- **minimal** — archival text-first tree (no glyphs). Pair with the CSS theme:

```tsx
import '@vibecook/mille-ui/theme/minimal.css';
import { minimalIconTheme } from '@vibecook/mille-ui/icons/minimal';

<div data-mille-theme="minimal">
  <FileTree fx={fx} ariaLabel="Files" iconTheme={minimalIconTheme} />
</div>
```

Any VS Code File Icon Theme–compatible object also works via `iconTheme`.

## Status

v0.2.1 — released 2026-07-12. See [CHANGELOG.md](./CHANGELOG.md).

## License

MIT
