# IDE Explorer Parity Assessment

**Assessment date:** 2026-07-21  
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

| Area                                 | Score | Current assessment                                                                                                                                               |
| ------------------------------------ | ----: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Filesystem and renderer architecture |   7.5 | Strong native walker, lazy hydration, deltas, bounded client mirror, and virtualized rendering                                                                   |
| Core tree interaction                |   7.0 | Keyboard navigation, multi-selection, create/rename/delete, clipboard, filtering, context menus, and drag/drop                                                   |
| Visual behavior                      |   6.2 | Mutation churn now has a real-Electron paint/frame gate; scroll, focus, selection, theme, and reduced-motion scenarios are still missing                         |
| Accessibility                        |   6.0 | Good ARIA tree semantics and keyboard tests; no real assistive-technology matrix                                                                                 |
| Reliability and recovery             |   5.5 | Live watcher tests are green and a deterministic 1,000-operation soak now gates exact convergence; crash/restart and platform stress coverage remain incomplete  |
| Performance confidence               |   5.8 | Headless and Electron gates enforce correctness, paint, React-duration, and frame budgets with retained build-identified reports; scenario breadth is incomplete |
| Explorer workflow breadth            |   3.5 | Important workspace, settings, editor, source-control, history, and remote-filesystem behavior is absent or host-only                                            |

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

## What is already strong

### Engine and host architecture

- Rust-backed walking, watching, ignore handling, snapshots, fuzzy search, and
  mutations.
- UtilityProcess/MessagePort separation suitable for Electron.
- Roots-only initial hydration with children fetched on expansion.
- Delta fan-out instead of shipping a complete tree on every update.
- A bounded client mirror with roots and pending expansions pinned.
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
