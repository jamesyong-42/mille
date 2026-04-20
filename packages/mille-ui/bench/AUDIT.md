# mille-ui memoization audit (v0.1)

Snapshot of the re-render hot paths ahead of v0.1 release. Based on
static review of `packages/mille-ui/src/components/*.tsx` plus the
existing render-count assertions in `decorations.test.mjs`,
`provider.test.mjs`, and `commands.test.mjs`.

## Safely memo'd components

| Component              | Memo strategy                                                            |
|------------------------|---------------------------------------------------------------------------|
| `FileTreeRow`          | `memo` + explicit shallow-ish equality on 19 identified props (Phase 10). |
| `DisclosureChevron`    | `memo` default equality — stateless, all primitive props.                 |
| `IndentGuides`         | `memo` default equality — depth + count only.                             |
| `LoadingBadge`         | `memo` default equality.                                                  |
| `FileRenameInput`      | `memo` default equality; commit/cancel handlers stable via closures.      |
| `FileDecorations`      | `memo` with custom equality that dedupes decoration arrays.               |

Render-count spies in `test/decorations.test.mjs` already verify that
a decoration-only `bumpDecorationVersion` does **not** re-render rows
whose decoration arrays are identity-stable — this is the load-bearing
invariant for SPEC §12's "500 modified files < 4 ms" target.

## Potential re-render hazards (v0.1 findings)

1. **`FileTree.tsx` constructs inline row-prop closures per render**
   (`onClick`, `onDoubleClick`, `onContextMenu`, `onExpand`,
   `onCollapse`, `onRenameCommit`, etc.). Each row receives fresh
   function identities every tree commit. `FileTreeRow`'s custom
   equality intentionally **omits** those handlers, so this does not
   cause re-renders today. If anyone adds them to the equality check,
   it will silently break the memo.
   **Action:** already covered by an inline comment; no code change.

2. **`rowStyle` is constructed inline per-row per-commit** (L794–801)
   with `transform: translateY(...)`. Same defense: custom equality
   excludes `style`. Keep it that way.

3. **`scrollerStyle` + `innerStyle` rebuilt every `FileTree` render**
   (L677–689). Small objects on the tree outer only — not per-row —
   so the cost is immaterial. Not worth memoizing for v0.1.

4. **`SearchResultList` renders `<div style={{ padding: '8px' }}>` as
   loading/error/empty placeholders** (L293, L306, L318). New object
   each time, but these branches only render when search is active
   and DOM is tiny. No action for v0.1.

5. **`FileContextMenu`, `ContextMenuItem`, `SearchResultList`,
   `FileTreeDragIndicator`** are not memo'd. They only render once per
   container commit, not per-row, so the cost is bounded. No action.

## Recommended fixes for v0.2

- **Hoist `rowStyle` builder out of the `.map(vItem => ...)` body.**
  A shared factory with fast path for "only the transform changed"
  would save a small allocation per visible row per frame — measurable
  in Playwright.
- **Extract the per-row handler closures into a `useCallback`
  per-tree** that takes `row.id` as an argument at the call site.
  Would allow the row memo equality to eventually include them
  without regressions, and lines up with the Logic-hook / View split
  per SPEC §4.9.
- **Profile with React DevTools** on a 500k-row real-browser fixture
  (blocked on Phase 16 Playwright harness).

## Summary

No bleeding cuts for v0.1. Memoization is conservative but correct;
decoration-only updates stay narrow; scroll commits don't touch rows
that didn't move. Defer the polish to v0.2.
