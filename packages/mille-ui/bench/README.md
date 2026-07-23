# mille-ui perf bench

A minimal, scripted perf harness for `@vibecook/mille-ui`. Runs under Node +
happy-dom; **not** a browser. Timing numbers are indicative only, while the
viewport, interaction, and animation-work assertions are deterministic and exit
non-zero. Real paint and frame budgets are enforced separately by
`pnpm bench:watch`.

## Run

```bash
pnpm --filter @vibecook/mille-ui bench
# or, from the repository root:
pnpm bench:ui
# or, from the package dir:
node bench/scroll-expand.mjs
```

The script builds the package's `dist/` first. If you've never built:

```bash
pnpm --filter @vibecook/mille-ui build
```

## What it measures

The harness builds a synthetic 500,000-row snapshot with 1,000
pre-expanded folders, mounts `<FileTree>` against a fake engine
(`createFakeEngine()`), and times fourteen operations with
`performance.now()`:

| Scenario | What happens |
|---|---|
| **initial render** | First paint with the 500k snapshot. Both row materialization and DOM stay windowed to ~40 treeitems. |
| **scroll shift** | Moves `scrollTop` by 1000 × rowHeight and times the next commit. |
| **expand 1000 children** | Emits a delta that inserts 1000 rows under the root folder. |
| **decoration-only viewport update** | Updates one visible badge without rematerializing the 500k structural projection; requires exactly one row render. |
| **budget 1000-row visible storm** | Uses a tall virtual window to prove a commit affecting more than the 64-row animation budget produces zero transition markers. |
| **rename during 1000-row tail churn** | Keeps the exact input node, draft text, and focus while unrelated rows arrive outside the viewport. |
| **ArrowDown in 500k-row tree** | Moves focus by one logical row without materializing the complete order; fails above 256 rows per read or 512 rows total. |
| **Select All** | Selects all 500k visible identities through one ID-only request while keeping complete row payloads bounded to the viewport. |
| **Shift+End long range** | Selects rows 100k through 500k through two exact-position queries and one ID-only range request. |
| **typeahead near match** | Finds and focuses the next nearby prefix match through bounded windows; fails above 256 rows per read or 1,024 rows total. |
| **typeahead full-wrap miss** | Scans the complete order without one giant allocation, preserves focus, and requires every read to remain at or below 256 rows. |
| **reveal row 400k** | Expands the target's ancestors, focuses it, and requests a deep scroll through one exact-position query plus a bounded viewport read. |
| **reveal path to row 400k** | Resolves a workspace-relative path through one indexed engine query, then performs the same bounded exact-position reveal. |
| **insert 1000 above viewport** | Preserves the top row's pixel offset, focus, and selection; fails above 0.5 px drift, on interaction-state loss, or if anchor lookup reads more than 256 rows at once / 4,096 rows total. |

Output is a small markdown table. Timing numbers are reporters; virtualization,
viewport-anchor, interaction-state, and animation-budget failures exit non-zero.
Decoration-only work additionally fails if it rebuilds the structural projection
or renders anything other than the changed row. Scroll fails unless the mounted
virtual range is published through `setViewport`, the prerequisite for future
host-side viewport retention. Initial render, scroll, and expansion additionally
fail if React materializes more than 100 rows for their mounted windows. The
insert-above scenario separately proves that deep viewport anchoring stays
windowed instead of materializing the complete 500,000-row order. The keyboard
scenario applies the same hard allocation signal to ordinary local navigation.
Select All must issue exactly one ID-only query carrying the 500,000 unavoidable
selection identities while materializing at most 100 complete viewport rows.
The long-range scenario separately requires two exact endpoint queries, one
ID-only request for the 400,000 selected identities, and at most 100 complete
row payloads.
The paired typeahead scenarios expose both the responsive nearby-match path and
the intentionally expensive worst-case full-wrap miss instead of hiding it.
The deep reveal scenario requires exactly one snapshot position query, at most
100 rematerialized viewport rows, and verifies that focus and scrolling complete
after expansion. The native Criterion suite separately measures the query's
worst-position DFS cost, because happy-dom cannot represent native traversal
work.
Path reveal additionally requires exactly one indexed path query and rejects any
fallback that scans the complete visible projection.

## Why happy-dom

Same reason the test suite uses it: fast, deterministic, no browser
install. The trade-off is that layout cost, paint cost, and frame
scheduling are all absent, so timings reflect React + virtualizer
bookkeeping only. Expect real-browser numbers to be slower on initial
paint (real layout) and faster per-frame (batched raf + compositor).

For real layout and frame scheduling, use the Electron playground benchmark;
it retains JSON observations and exits non-zero on ratified paint, React, or
frame-budget regressions.
