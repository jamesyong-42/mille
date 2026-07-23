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

| Area                                 | Score | Current assessment                                                                                                                                                                     |
| ------------------------------------ | ----: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Filesystem and renderer architecture |   8.8 | Strong native walker, roots-only handshake, packed ordered lazy hydration, bounded viewport mirror, windowed React rendering, exact positions, and ID-only projections                 |
| Core tree interaction                |   7.4 | Windowed navigation, scalable multi-selection, reliable deep reveal, resilient inline rename, create/delete, clipboard, filtering, context menus, and drag/drop                        |
| Visual behavior                      |   7.4 | Viewport, focus, selection, and rename drafts survive churn; animation is row-scoped, storm-bounded, and reduced-motion aware; broader theme/sticky-root scenarios remain              |
| Accessibility                        |   6.0 | Good ARIA tree semantics and keyboard tests; no real assistive-technology matrix                                                                                                       |
| Reliability and recovery             |   5.5 | Deterministic soak gates converge, but repeated Electron watcher stalls and direct native startup misses remain unresolved; crash/platform stress also remains                         |
| Performance confidence               |   7.8 | Million-sibling structure, binary-wire, bounded-hydration, windowed 500,000-row UI, Criterion, and Electron gates cover payload, paint, projection, navigation, and retention          |
| Explorer workflow breadth            |   4.0 | Versioned settings, native sort/visibility/exclusion/compaction/nesting, and durable navigation exist; workspace, editor, source-control, history, and remote workflows remain shallow |

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
sandbox. The harness now preflights the host watch facility by requiring a real
event. Unavailable environments emit `status: "unavailable"` diagnostics and
exit 2, while product/quality failures remain exit 1. On this restricted runner
the Electron launcher now stops before launch with an explicit `EMFILE` report
instead of producing operation misses. Reports also identify the exact native
and TypeScript artifacts, so an environmental failure or stale binding no
longer masquerades as a source defect. A watch-capable real-browser pass is
still outstanding.

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

Expanded child order now uses a packed binary channel too. Normal allocator IDs
remain as zero-copy `Uint32Array` views in the renderer rather than a cloned JS
array, and structural identities no longer duplicate themselves in the
session's hydrated-record set. The million-sibling gate retains the complete
order in 4,000,024 bytes (**4.000 bytes/id**) with zero full records hydrated;
packed reducer application measured 0.02 ms median versus 2.44 ms for the
legacy cloned-array path (**99.1% lower**). Encoding remains an O(n), 22.59 ms
median host cost at that deliberately extreme width.

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

The subsequent engine-fallback pass keeps the first 512 local rows responsive,
then replaces the renderer-side full-wrap scan with one payload-free native or
host query. The 500,000-row miss now materializes 806 rows including focus and
viewport probes instead of 500,256 (**99.84% fewer row payloads**) and uses one
engine query; the current timing reporter was 11.29 ms versus the preceding
32.29 ms baseline. Native Criterion measures the full approximately 1,500-entry
miss at 129.21-129.74 microseconds. The engine traversal is still O(n), but it
is off the renderer hot path and returns at most one identity plus a bounded
ancestor hydration chain. Current UI validation is 318/318 tests, including a
far-match focus-and-scroll regression.

Deep imperative reveal now uses a snapshot exact-position contract across the
native and port implementations. It holds a pending stable id across ancestor
expansion/hydration, then focuses and scrolls to the exact fixed-height offset.
The gate caught the prior focus-without-scroll behavior and now requires one
position query plus at most 100 rematerialized viewport rows. Revealing row
400,000 consistently used one query and 38 rows; five standalone runs ranged
from 43.17 to 47.12 ms with a 45.79 ms median. The native last-row query on the
approximately 1,500-entry fixture measured 87.273-88.166 microseconds. This
removes repeated offset scans and N-API row payloads, but the production query
is still one O(n) traversal in the worst case. Current validation is 312/312 UI
tests and 12/12 playground harness tests.

Select All and long-range selection now consume an ID-only projection instead
of materializing complete row objects. On 500,000 rows, Select All makes one
request for the unavoidable 500,000 identities and zero complete row payloads;
five runs ranged from 53.08 to 58.14 ms with a 56.51 ms median. Shift+End from
row 100,000 selects 400,000 identities through two exact-position queries, one
ID-only request, and 49 complete viewport rows; five runs ranged from 47.63 to
62.76 ms with a 54.61 ms median. Native medium-fixture ID traversal measured
79.989-82.850 microseconds versus 126.23-127.73 microseconds for full native row projections, a
36.1% median-time reduction. The selection set itself remains necessarily O(k)
in selected identities. Current validation is 314/314 UI tests, 12/12
playground tests, 160/160 non-watcher core tests, and 41/41 focused native/port
tests.

Path reveal now has an authoritative indexed contract instead of relying on a
URI-shape mismatch or a full visible-order fallback. Known paths use the native
reverse index; a collapsed, unindexed path hydrates only its ancestor chain.
The host sends that depth-bounded chain to the renderer mirror, which pins it
through the reveal handoff without treating it as a complete directory list.
React then waits for the hydrated snapshot before expanding, focusing, and
scrolling. On the 500,000-row gate, revealing row 400,000 used one path query,
one exact-position query, and 38 complete row records; the current run reported
36.86 ms and the preceding five-run median was 35.61 ms. The direct lazy-native
and lazy host/port regression paths pass, with the port round trip measured at
26.38 ms. Current UI validation is 318/318 tests.

The renderer still retains one compact identity per child of an expanded folder;
eliminating that O(n) cardinality requires a paged/ranked projection protocol,
not another representation tweak. Maintained rank and name indexes should land
only if large native traces show their O(n) traversals are material. Current
Criterion evidence is 0.555 ms for last-row rank and 0.746 ms for a full prefix
miss at 8,590 visible entries. The explicit re-open trigger is a production
trace above 100,000 visible rows or a query p95 above 16 ms.

Configurable file nesting is now an engine projection rather than a React
convention. Parent and child rows keep their real entry IDs and filesystem
parents, while projected child lists, rows, counts, indexes, prefix navigation,
host viewports, and the lazy renderer mirror agree on the virtual hierarchy.
Rules are bounded exact-name templates: a parent accepts at most one `*`, child
templates substitute `${capture}`, and deterministic sibling/rule order claims
each child once without recursive chains. Rename-out/rename-back integration
tests prove that the real directory list and expanded virtual parent update in
the same host tick. A 50,001-entry gate with 20,000 nested children initially
measured 59.30 ms median / 61.14 ms p95 for projected children plus a 200-row
viewport. Immutable-snapshot memoization reduced the identical warm path to
2.24 ms median / 2.44 ms p95, with a 35.23 ms cold plan; caches reset on
structural clones, and a retained older snapshot remains internally consistent.

Display settings can now change on a live explorer without rebuilding its
store. One atomic snapshot publication covers sibling order, visibility,
compact folders, and nesting; host deltas update every renderer mirror before
the initiating port resolves. Retained snapshots stay stable and identical
settings do not advance versions or emit changes. The 50,001-entry gate
measured 11.83 ms median / 12.16 ms p95 for the native policy update and
37.97/40.07 ms for the first ready 200-row projection, versus 30,878.05 ms for
the initial filesystem population; idempotent updates measured 0.001 ms p95.

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

- the engine now supports live add/remove/reorder, duplicate-basename identity,
  unavailable-root recovery, and explicit cross-root transfer/collision
  primitives, but the product explorer still needs a root management workflow,
  custom aliases, and overwrite/merge/skip prompting;
- active-editor targets now have distinct row state, lazy optional auto-reveal,
  and reference-playground controls, but single-click preview/permanent-open
  policy is not complete;
- a decoration pipeline exists, but Problems, tests, and source-control states
  are not integrated explorer experiences;
- the command registry is extensible, but the built-in context menu is much
  smaller than a mature IDE's;
- drag-in accepts external file paths, but without `copyFromPath` it can create
  only empty placeholder entries and currently suppresses copy errors.

### 4. Explorer settings and state persistence are incomplete

The versioned global/workspace/root settings record now drives native natural,
locale-aware, type, modified-time, case, folders-on-top, hidden, ignored,
exclude-glob, compact-folder, and file-nesting behavior at explorer
construction and during atomic live updates. Native and renderer-mirror
projections share visibility, compact leaf identities, and authoritative
nested child lists, and exclude globs apply to initial, lazy, and
watcher-reconciliation walks. Repository-ignore and configured-exclude
provenance remain separate. The 50,001-entry exclusion gate changes 20,000
flags per toggle at 43.23/93.73 ms median/p95 and 114.14 ms ready p95. The
30,004-entry locale gate alternates English and Swedish at 19.15/19.79 ms
native-update median/p95 and 20.74/21.59 ms ready p95. Full ICU locale data
adds 1,217,840 bytes to the optimized macOS arm64 binding (45.1%). Remaining
settings gaps include:

- UI controls for locale, hidden/ignored visibility, and exclusion settings;
- dynamic root add/remove/reorder and custom-label controls around the new
  identity-safe, bounded, durably stored navigation state.

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

- configurable single-click preview and permanent-open behavior;
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
