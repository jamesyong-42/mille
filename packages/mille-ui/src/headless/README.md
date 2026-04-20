# @vibecook/mille-ui/headless

Unstyled primitives + hooks for consumers who want full styling control.

## What you get

- **All hooks** from `@vibecook/mille-ui` (`useFileTreeSelection`,
  `useFileTreeKeyboard`, `useRenameState`, `useFileTreeDragDrop`, …).
  Hooks are framework-agnostic — they own no CSS.
- **Command registry + when-clause + keybinding parser** from
  `/commands`, plus `defaultCommands`.
- **`FileTreeHeadless` namespace** (`Root`, `Row`, `Icon`, `Decorations`,
  `RenameInput`, `ContextMenu`, `ContextMenuItem`, `Filter`,
  `SearchResults`, `DragIndicator`, `IndentGuides`, `DisclosureChevron`,
  `LoadingBadge`) — the same structural components as the styled entry,
  under a contract that says: **styling is your responsibility.**
- **`milleClassNames`** — the frozen catalog of `className` hooks the
  components emit (`mille-tree`, `mille-row`, `mille-row-name`, …).
  Author your own CSS against these keys for type safety.

## What this does NOT give you

- A full logic-hook / thin-view split per styled component (SPEC §4.9).
  v0.1 ships one layer; v0.2 / Phase 16 refines.
- A stripped-down component tree with zero inline styles. The shipped
  components still carry **layout-critical** inline styles: absolute
  positioning from the virtualizer, `display: flex` on rows, scroller
  `overflow: auto`, 12 × 12 chevron size. Strip these and the tree
  stops rendering.
- A theme. No tokens, no focus ring CSS, no dark-mode mapping. Import
  `@vibecook/mille-ui/tokens.css` (or write your own) alongside
  whatever component CSS you author.

## When to pick `/headless` vs. the styled entry

- **Pick `/headless`** when you ship a design system that clashes with
  mille-ui's defaults, or when bundle size matters and you don't need
  the shipped `tokens.css` / focus styles.
- **Pick `@vibecook/mille-ui`** (the top-level entry) when you want a
  reasonable out-of-the-box look and only need to override via CSS
  variables (`--mille-chevron-color`, `--mille-accent-bg`, …).

Both entries import the same components; the difference is intent.
