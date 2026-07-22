# IDE Explorer Parity Assessment

**Assessment date:** 2026-07-22
**Repository baseline:** `476b601` (`perf(ui): smooth live file tree updates`)  
**Target:** the day-to-day reliability, responsiveness, and workflow depth of the
file explorers in mature IDEs such as Visual Studio Code and WebStorm.

## Executive summary

Mille has an IDE-grade file-tree foundation, but it is not yet an IDE-grade
explorer product. The architecture is ahead of the integrated product.

The native walker, lazy host/renderer mirror, virtualized React tree, command
system, decorations, and benchmark playground form a credible base. The largest
remaining gaps are filesystem-event reliability, real-browser performance
proof, persistent explorer settings and state, complete file-operation recovery,
and integration with the editor, workspace, source control, diagnostics, and
history.

This is not one visual-polish pass away from parity. It requires two substantial
layers of work:

1. Make correctness and responsiveness measurable and dependable under real
   filesystem churn.
2. Build the settings and workflow integration that turn a reusable tree control
   into an IDE explorer.

## Current maturity

The scores below are directional, not a claim of mathematical precision. A
mature IDE explorer is the 10/10 reference point.

| Area                                 | Score | Current assessment                                                                                                                                                                |
| ------------------------------------ | ----: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Filesystem and renderer architecture |   8.5 | Strong native walker, roots-only handshake, binary ordered lazy hydration, bounded viewport mirror, windowed React rendering, anchoring, and local keyboard access                |
| Core tree interaction                |   7.2 | Keyboard navigation, multi-selection, resilient inline rename, create/delete, clipboard, filtering, context menus, and drag/drop                                                  |
| Visual behavior                      |   7.4 | Viewport, focus, selection, and rename drafts survive churn; animation is row-scoped, storm-bounded, and reduced-motion aware; broader theme/sticky-root scenarios remain         |
| Accessibility                        |   6.0 | Good ARIA tree semantics and keyboard tests; no real assistive-technology matrix                                                                                                  |
| Reliability and recovery             |   5.5 | Deterministic soak gates converge, but repeated Electron watcher stalls and direct native startup misses remain unresolved; crash/platform stress also remains                    |
| Performance confidence               |   7.3 | Binary-wire, bounded-hydration, windowed 500,000-row UI, and Electron gates cover payload, paint, React duration, projection, anchoring, keyboard access, retention, and eviction |
| Explorer workflow breadth            |   3.5 | Important workspace, settings, editor, source-control, history, and remote-filesystem behavior is absent or host-only                                                             |

As a reusable tree widget, Mille is approximately **6.5-7/10**. As a complete
IDE explorer experience, it is approximately **5/10**.

## Verified baseline

The following commands were run directly against the current checkout on
2026-07-21:

```text
node --test packages/mille-ui/test/*.test.mjs
279 passed, 0 failed

node --test --test-concurrency=4 packages/mille/test/*.test.mjs
208 passed, 3 failed, 1 skipped
```

The three apparent engine failures all timed out waiting for external changes
to reach the snapshot:

- external file creation and subsequent mutation;
- external directory rename and recursive deletion;
- host-to-client propagation across collapse and re-expansion.

Further isolation showed this was a restricted-runner false negative, not an
engine regression: a direct Node `fs.watch` probe failed with `EMFILE` in the
sandbox, while the same watcher tests passed against the same build outside the
sandbox. This is still a harness problem. Watcher suites must preflight the host
watch facility and reports must identify the exact native and TypeScript
artifacts so an environmental failure or stale binding cannot masquerade as a
source defect.

## First optimization result

The first deterministic soak exposed a real defect that the earlier tests did
not: nested and whole-directory renames lost known descendants. Before the fix,
100/120 operations converged and all 20 misses were directory-rename cases;
successful-operation p95 was 67.2 ms.

After preserving descendant identities and path mappings on same-parent
directory renames, reconciling destination subtrees for create-only rename
events, and deriving the correct parent for a walked moved root, the identical
120-operation plan converged 120/120 with p95 65.8 ms. The completion run then
converged **1,000/1,000 with zero misses**, p50 60.5 ms, p95 67.2 ms, p99
68.9 ms, max 75.0 ms, and 16.7 sequential operations/s. The measured fix added
correctness without a latency regression.

Validation after the change:

```text
Rust workspace (excluding the N-API cdylib): 213 passed, 0 failed; 3 full runs
Mille Node engine: 217 passed, 0 failed, 1 documented skip
Mille UI + playground: 284 passed, 0 failed
TypeScript: all four package/application configs passed
```

## Viewport-retention result

The UI-to-host viewport contract now completes the round trip. The host returns
the authoritative mounted rows, the bounded client mirror pins that window plus
expanded ancestors, and overlapping scrolls transfer only newly entered rows.
An end-to-end port test forces five requested rows out of an eight-entry mirror,
then verifies they are re-fetched and retained; shifting by one row transfers
one entry.

The initial handshake now contains only root entry records. On expansion, the
host publishes complete stable child ordering as compact ids while hydrating
full entry records only for the active viewport. A 256-file integration gate
reduced the handshake from 257 records to one, then bounded a 16-row expansion
to at most 15 child records. The mirror preserves ordering while records are
evicted and rehydrates rows at the same tree version without stale projections.

Root and viewport records now use a bincode-compatible binary codec, retaining
JSON only as a protocol-v1 fallback. The dedicated 50,000-entry harness moved a
64-row viewport 200 times against a 4,096-entry cap. It held the cap exactly,
evicted the first cold window, and reduced the average patch from 12,336 bytes
to 1,920 bytes (**84.4%**). Binary encode p50/p95 was 0.048/0.093 ms and reducer
decode+apply p50/p95/max was 0.74/1.06/2.60 ms. A MessageChannel clone+decode
gate processed 2,000 binary patches in 43.19 ms versus 55.18 ms for JSON, a
**21.7% improvement**.

React now materializes only the mounted virtual range during normal rendering:
the 500,000-row gate measured 38 rows initially, 48 after a 1,000-row scroll,
and 38 during a 1,000-child expansion. Against the prior baseline, initial
render improved 30.6%, scroll 23.1%, and expansion 9.7%. Decoration-only work
remained one row render with zero structural rebuilds, viewport drift remained
0.00 px, and rename identity/focus survived churn. Deep viewport anchoring now
captures one row and resolves it with bounded 256-row probes: the insert-above
gate read 2,241 rows total rather than allocating two 500,000-row arrays, while
preserving 0.00 px drift and interaction state. Full ordering is now reserved
for global operations and rare correctness fallbacks.

The windowed Electron smoke observed 24/24 operations with zero misses, mirror
p95 121.5 ms, paint p95 137.5 ms, React p95 16.3 ms, and 10.1 ops/s. Current
validation passed 225 core tests with one documented skip; three direct native
watcher tests missed events during startup, while the warmed Electron watcher
converged. All 304 UI tests and all 12 playground tests passed.

The bounded-anchor follow-up increased the UI suite to 308 passing tests. Five
repeated insert-above runs ranged from 259.02 to 387.87 ms with a 269.56 ms
median. Since this happy-dom timing reporter is noisy, the material gain is the
deterministic allocation cap rather than a claimed latency win.

Two subsequent real Electron runs kept observed renderer work inside the
ratified budgets (worst run: mirror p95 94.9 ms, paint p95 111.7 ms, React p95
17.7 ms) but failed watcher state convergence at 20/24 and 8/24 operations. The
gate correctly exited non-zero. This is an unresolved integration signal and
reinforces the existing watcher-readiness/reliability gap; it is not counted as
a successful end-to-end validation of the anchor slice.

Local keyboard navigation is windowed as well. Before the change, a single
ArrowDown on a 10,000-row regression fixture requested 9,999 rows. The
500,000-row gate now reads 295 rows total, including the 38-row rerendered
viewport, and caps every request at 256 rows. Five ArrowDown runs ranged from
11.09 to 29.99 ms with a 14.68 ms median and preserved the exact next-row focus.
The deep-viewport test also covers PageDown around row 5,000. Current validation
is 309/309 UI tests and 12/12 playground harness tests.

Typeahead now consumes the same projection through 256-row windows while
preserving case-insensitive next-match and wraparound behavior. A nearby match
in the 500,000-row gate reads 550 rows total; a deliberate miss reads all
500,256 lookup/scan rows but never allocates more than 256 at once and leaves
focus unchanged. Five-run medians were 13.57 ms for the nearby match and 31.32
ms for the full-wrap miss. This removes the full-order allocation, not the
worst-case O(n) scan. Current validation is 310/310 UI tests and 12/12
playground harness tests.

Remaining scaling gaps are O(n) ordered-id metadata for an extremely wide
expanded folder; full-order reads for Select All, long ranges, reveal/path
fallback, and rare off-viewport recovery; and the O(n) worst-case typeahead
scan.

## What is already strong

### Engine and host architecture

- Rust-backed walking, watching, ignore handling, snapshots, fuzzy search, and
  mutations.
- UtilityProcess/MessagePort separation suitable for Electron.
- Roots-only initial hydration with children fetched on expansion.
- Delta fan-out instead of shipping a complete tree on every update.
- A bounded client mirror with roots, expansion state, and the current viewport
  pinned, plus host-driven refill on viewport movement.
- Coalescing and reconciliation concepts for rename storms and volatile
  subtrees.
- Multi-root representation at the engine and protocol level.

### Tree interaction

- Virtualized rendering with a 500,000-row synthetic fixture.
- WAI-ARIA tree roles, roving focus, position metadata, expansion state, and
  selection state.
- Arrow navigation, range selection, typeahead, select-all, and keyboard file
  commands.
- Inline file/folder creation and rename with local and engine error states.
- Multi-select cut, copy, paste, delete, move, and copy.
- Client-side filtering and server-ranked filename search.
- Context menus backed by an extensible command registry.
- Imperative reveal, focus, collapse, reset, and scroll APIs.
- Roots expanded by default while preserving explicit user collapse state.

### Presentation and extensibility

- Stable per-row decoration identities.
- Git and agent-rule decoration providers, plus a generic provider model for
  diagnostics and other status overlays.
- VS Code file icon theme compatibility and bundled visual themes.
- Internal tree drag/drop, external drag metadata, cross-tree attachments, and
  auto-expansion while hovering.
- Reduced file-tree flicker through stable snapshots and short structural
  transitions.

### Test and benchmark assets

- Broad unit and component coverage for navigation, ARIA, commands, selection,
  mutations, search, decorations, and drag/drop.
- A synthetic 500,000-row happy-dom benchmark.
- An Electron playground benchmark that performs external file operations in an
  isolated temporary workspace and records mirror and paint-ready latency.

## Material gaps

### 1. Filesystem reliability is not yet a closed problem

The watcher pipeline is the explorer's foundation. Missing a file event is more
serious than a missing convenience feature. The current failing integration
tests mean release confidence is red until a clean build and repeated soak are
green.

Additional behavior that needs deterministic coverage includes:

- burst creates and deletes;
- rename chains and directory moves;
- changes while a directory is collapsed or evicted from the mirror;
- watcher overflow and explicit subtree reconciliation;
- symlink, ignored-path, Unicode, case-only rename, and permission edge cases;
- process suspension, host restart, and watcher disposal;
- slow or remote-like filesystems.

### 2. Performance is designed well but not proven in the environment users see

The 500,000-row harness runs under happy-dom. It excludes browser layout, paint,
frame scheduling, font/icon rendering, and compositor work. It also reports
numbers without failing when thresholds regress.

The Electron watcher benchmark is the right vertical slice, but it must become a
repeatable regression gate with a fixed fixture, reference hardware profile,
event-to-paint tracing, and pass/fail budgets. It also needs interaction tests
while changes are arriving: scrolling, expanding, selecting, renaming, and
maintaining focus.

### 3. The component API is broader than the finished product behavior

Several features are primitives that require host work rather than complete
end-user behavior:

- the engine represents multiple roots, but there is no add/remove/reorder root
  workflow in the explorer;
- `revealPath` exists, but automatic active-editor synchronization is not a
  product setting;
- a decoration pipeline exists, but Problems, tests, and source-control states
  are not integrated explorer experiences;
- the command registry is extensible, but the built-in context menu is much
  smaller than a mature IDE's;
- drag-in accepts external file paths, but without `copyFromPath` it can create
  only empty placeholder entries and currently suppresses copy errors.

### 4. Explorer settings and state persistence are incomplete

The current rendered ordering is effectively directories-first, lexical name
sorting. Missing settings include:

- natural, locale-aware, case-aware sorting;
- sort by name, type, or modified time;
- folders-on-top control;
- file nesting rules;
- configurable compact folders;
- hidden-file, `files.exclude`, and Git-ignore visibility;
- per-workspace-root overrides;
- persisted expansion, selection, focus, filter, and scroll state.

### 5. File operations need product-level recovery

Mature behavior requires more than invoking the mutation:

- collision and overwrite decisions;
- progress and cancellation for large copies and moves;
- actual external file/directory import;
- consistent trash versus permanent-delete semantics;
- undo or an operation journal;
- permission, disk-full, stale-entry, and cross-device error handling;
- clear partial-success behavior for multi-selection operations;
- resync and recovery when the watcher disagrees with an operation result.

### 6. IDE integration breadth is early

Compared with WebStorm's Project tool window and VS Code's Explorer/workspace
model, Mille lacks or delegates most of the following:

- active editor following and configurable single-click preview;
- Open Files, Changed Files, Problems, tests, and custom scope views;
- source-control actions and a file timeline/history surface;
- reveal in Finder/Explorer, open terminal, copy path/relative path, and refresh;
- refactoring and content-search integrations;
- root management, per-root exclusions, and workspace persistence;
- virtual and remote filesystem providers.

Reference behavior:

- [WebStorm Project tool window](https://www.jetbrains.com/help/webstorm/project-tool-window.html)
- [VS Code multi-root workspaces](https://code.visualstudio.com/docs/editing/workspaces/multi-root-workspaces)
- [VS Code user interface and Explorer](https://code.visualstudio.com/docs/editing/userinterface)
- [VS Code search](https://code.visualstudio.com/docs/editing/codebasics)
- [VS Code source control](https://code.visualstudio.com/docs/sourcecontrol/overview)

## Product risks

| Risk                                    | Why it matters                                                  | Current mitigation                                            | Remaining exposure                                                 |
| --------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------ |
| Missed or delayed file events           | The visible tree can disagree with disk                         | Native watcher, coalescing, subtree reconciliation            | Current watcher tests fail; overflow and soak proof are incomplete |
| UI churn under event storms             | Flicker, focus loss, scroll jumps, unusable interactions        | Stable row identity, memoization, virtualization, transitions | No real-browser churn gate                                         |
| Native/TypeScript artifact mismatch     | Tests and shipped behavior can use different implementations    | Platform packages and build scripts                           | Runtime build identity and clean-build verification are weak       |
| Partial external import                 | Data loss or empty placeholder files                            | Fallback makes the drop visible                               | Content copy and error reporting are not implemented               |
| Feature breadth hiding integration cost | A checklist can look complete while host behavior is missing    | Extensible commands, hooks, and decorations                   | No integrated reference host acceptance suite                      |
| Accessibility regressions               | A semantically valid tree can still be difficult with actual AT | ARIA and keyboard unit tests                                  | No VoiceOver/NVDA/browser matrix                                   |

## Definition of parity

Mille should be described as "on par" only when all of the following are true:

1. A deterministic cross-platform watcher and mutation suite passes from a clean
   build, including long-running and burst workloads.
2. Browser/Electron performance budgets gate regressions for large trees and
   high event rates.
3. Core explorer preferences, workspace roots, and navigation state persist and
   behave predictably.
4. File operations provide collision handling, progress, cancellation, error
   feedback, and recovery.
5. Active-editor, search, source-control, diagnostics, terminal/OS, and history
   integrations are present in the reference playground or host contract.
6. Keyboard and assistive-technology behavior is verified in real browsers.
7. The API supports local, multi-root, and provider-backed filesystems without
   hard-coding local native paths into the UI contract.

## Conclusion

Mille has the difficult architectural bones required to reach IDE parity. The
next gains should come from reliability, measurement, stateful explorer behavior,
and integration rather than additional cosmetic effects. Correctness under churn
and a real-browser regression harness are the immediate gates for every later
feature.

The execution roadmap is maintained in
[IDE_EXPLORER_PARITY_PLAN.md](./IDE_EXPLORER_PARITY_PLAN.md).
