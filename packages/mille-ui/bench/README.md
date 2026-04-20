# mille-ui perf bench

A minimal, scripted perf harness for `@vibecook/mille-ui`. Runs under
Node + happy-dom; **not** a browser. Numbers are indicative only — use
them to catch order-of-magnitude regressions between phases, not to
validate against SPEC §12 frame budgets.

The SPEC §12 guardrail (Playwright + real layout + 60 fps frame budget)
is deferred to v0.2.

## Run

```bash
pnpm --filter @vibecook/mille-ui bench
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
(`createFakeEngine()`), and times three operations with
`performance.now()`:

| Scenario | What happens |
|---|---|
| **initial render** | First paint with the full 500k snapshot. Virtualizer windows down to ~40 treeitems. |
| **scroll shift** | Moves `scrollTop` by 1000 × rowHeight and times the next commit. |
| **expand 1000 children** | Emits a delta that inserts 1000 rows under the root folder. |

Output is a small markdown table to stdout. Exit code is 0 regardless
of numbers — this is a reporter, not a guard.

## Why happy-dom

Same reason the test suite uses it: fast, deterministic, no browser
install. The trade-off is that layout cost, paint cost, and frame
scheduling are all absent, so timings reflect React + virtualizer
bookkeeping only. Expect real-browser numbers to be slower on initial
paint (real layout) and faster per-frame (batched raf + compositor).

## When to upgrade

A Playwright-driven harness is the right home for SPEC §12 assertions:
real layout, real frame budget, regression gating. That work is
tracked under Phase 16.4 and intentionally deferred to v0.2 — shipping
v0.1 doesn't require it, and standing up Playwright + snapshot storage
is a larger investment than this close-out can absorb.

Until then, run `pnpm bench` before and after any perf-sensitive
change and eyeball the diff.
