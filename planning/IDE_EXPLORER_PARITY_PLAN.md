# IDE Explorer Parity Implementation Plan

**Status:** active — Phase 0 complete, Phases 1–2 in progress
**Created:** 2026-07-21  
**Baseline assessment:**
[IDE_EXPLORER_PARITY_ASSESSMENT.md](./IDE_EXPLORER_PARITY_ASSESSMENT.md)

## Objective

Bring Mille's reference file explorer to mature-IDE quality in correctness,
responsiveness, core file-management behavior, workspace configuration,
accessibility, and host integration while preserving the library's headless and
embeddable architecture.

The plan deliberately separates three products that must all succeed:

1. **Engine:** disk state, watches, mutations, snapshots, and reconciliation.
2. **Tree component:** rendering, navigation, selection, motion, and accessible
   interaction.
3. **Reference explorer integration:** workspace settings, editor following,
   source control, diagnostics, terminal/OS actions, persistence, and recovery.

A primitive in the engine or component does not count as a finished explorer
feature until the reference playground demonstrates the end-to-end behavior.

## Delivery principles

- Correctness before animation or feature breadth.
- Preserve identity, focus, selection, expansion, and scroll position across
  unrelated filesystem changes.
- Prefer deltas and scoped invalidation; reserve full rebuilds for explicit
  recovery.
- Measure event-to-visible-paint, not merely event receipt or React commit.
- Every benchmark intended as a guard must fail on regression.
- Every mutation needs a clear success, failure, partial-success, and recovery
  story.
- Keep host-only capabilities explicit in types and documentation.
- Respect `prefers-reduced-motion` and never require motion to understand state.
- Treat macOS, Windows, Linux, case sensitivity, symlinks, and Unicode as design
  inputs rather than cleanup work.

## Provisional quality budgets

Phase 1 will establish reference hardware and ratify these numbers. Until then,
they are targets rather than release claims.

| Signal                            | Target                                                                        |
| --------------------------------- | ----------------------------------------------------------------------------- |
| Mixed external-operation soak     | 10,000 operations, zero missed final states                                   |
| Watcher test repeatability        | 20 consecutive clean runs per supported CI OS                                 |
| Event-to-mirror latency           | p95 at or below 100 ms with 40 ms debounce                                    |
| Event-to-visible-paint latency    | p95 at or below 150 ms; p99 at or below 250 ms                                |
| Keyboard interaction latency      | p95 input-to-commit at or below 50 ms                                         |
| Expand a known 1,000-child folder | p95 visible commit at or below 100 ms                                         |
| Continuous scroll                 | At least 55 fps over a 30-second large-tree trace                             |
| Long tasks during normal churn    | No task above 100 ms; fewer than 1 per 10 seconds above 50 ms                 |
| Structural update invariants      | Zero unintended focus, selection, expansion, or scroll-anchor changes         |
| Accessibility                     | No critical axe findings; keyboard + VoiceOver/NVDA acceptance scenarios pass |

Latency reports must include the debounce configuration, operation mix, tree
size, expansion set, machine class, OS, Electron version, and build identity.

## Phase overview

| Phase                                | Outcome                                                                          | Depends on |
| ------------------------------------ | -------------------------------------------------------------------------------- | ---------- |
| 0. Reproducible correctness baseline | Clean build, green watcher tests, runtime build identity                         | None       |
| 1. Real end-to-end quality harness   | Browser/Electron latency, frame, state, and soak regression gates                | Phase 0    |
| 2. Stable high-churn UI              | No flicker, focus loss, scroll jumps, or avoidable row work                      | Phase 1    |
| 3. Explorer settings and navigation  | Workspace roots, sorting, exclusions, nesting, persistence, active-editor reveal | Phase 2    |
| 4. Production file operations        | Import, collision handling, progress, cancellation, undo/recovery                | Phases 0-3 |
| 5. IDE workflow integration          | SCM, diagnostics, views/scopes, history, terminal/OS, content-search hooks       | Phases 3-4 |
| 6. Provider and platform depth       | Remote/virtual filesystems and full accessibility/platform matrix                | Phases 1-5 |

Accessibility, documentation, telemetry, and cross-platform testing are
cross-cutting requirements in every phase rather than a final cleanup pass.

## Phase 0 — Reproducible correctness baseline

### Goal

Make a clean checkout produce a known native binding, deterministic test result,
and trustworthy watcher lifecycle before optimizing any higher layer.

### Work

#### 0.1 Identify the implementation under test

- Add a diagnostic API returning the native core version, binding build profile,
  target triple, protocol version, and TypeScript package version.
- Log that identity once in playground development and benchmark modes.
- Make tests fail clearly when source, generated declarations, `dist`, and native
  bindings are incompatible.
- Document which local `.node` artifact wins resolution and how to perform a
  clean native rebuild.

#### 0.2 Reproduce and fix watcher failures

- Start with the three currently failing external-change tests.
- Verify watcher initialization ordering relative to `populateFromRoots`, host
  attachment, and roots-only hydration.
- Trace native event receipt, debounce/coalescing, store reconciliation,
  ChangeSet generation, host delta creation, mirror reduction, and UI emission.
- Distinguish a missing native event from an event lost at a later stage.
- Add actionable diagnostics on timeout: last native events, batches, tree
  version, pending reconciliation roots, and snapshot children.

#### 0.3 Expand correctness coverage

- File create, modify, append, truncate, metadata change, rename, delete.
- Directory create, deep population, rename, move, and recursive delete.
- Burst and concurrent operations with deterministic seeds.
- Changes under collapsed, expanded, ignored, evicted, and volatile subtrees.
- Case-only rename where supported, Unicode normalization, symlinks, and broken
  symlinks.
- Watch overflow and explicit subtree resync.
- Dispose, restart, suspend/resume simulation, and host/client reconnect.

#### 0.4 Put the baseline in CI

- Run watcher integration tests on macOS, Windows, and Linux.
- Separate true platform limitations with explicit skip reasons and issue links.
- Run a short repeated watcher job on pull requests and a longer scheduled soak.
- Preserve diagnostic reports and operation seeds when a run fails.

### Exit criteria

- All existing engine and UI tests pass from a clean checkout.
- The watcher integration suite passes 20 consecutive times locally and in each
  supported CI OS class.
- A 1,000-operation headless mixed workload has zero final-state misses.
- Test output records the exact native and TypeScript build identity.
- No watcher callback or filesystem event is delivered after disposal.

## Phase 1 — Real end-to-end quality harness

### Goal

Turn the existing playground benchmark into a repeatable quality gate that
measures what a user sees and catches both correctness and responsiveness
regressions.

### First measured optimization

The initial 2,000-file/120-operation Electron run measured paint p95 1,597.0
ms, React-duration p95 203.4 ms, maximum sampled frame interval 433.3 ms, and
1.2 operations/s. Snapshot-local child-order caching and projection reuse for
virtualizer keys moved the identical workload to paint p95 136.4 ms,
React-duration p95 16.2 ms, maximum frame interval 42.1 ms, and 10.0
operations/s, with zero misses. CI now runs this workload under explicit
150/25/50 ms paint-p95/React-p95/frame-max budgets and retains the report.

Implemented in this slice:

- deterministic reference-tree seeding plus complete plan serialization and a
  SHA-256 plan identity;
- operation-to-mirror-to-React correlation using timestamps and the exact
  mirror tree version, followed by two animation-frame boundaries;
- build/runtime provenance covering native, TypeScript UI, Node, Electron,
  Chrome, platform, and architecture; and
- non-zero automated exits for convergence misses or explicit paint, React,
  and frame-budget violations, with retained CI reports.

Runner hardening result (2026-07-21): seeded runs now wait for the complete
reference projection and settled expansion discovery across two frames rather
than a fixed 750 ms delay. Fatal paths preserve stage/operation diagnostics in
the report. The launcher derives its exit status from that flushed report and
terminates the Electron development-server wrapper, eliminating successful CI
hangs. A two-cycle verification completed 24/24 operations with zero misses
(paint p95 130.2 ms, React-duration p95 18.2 ms), and a deliberate frame-budget
violation wrote its report and exited 1 automatically.

### Work

#### 1.1 Make workloads reproducible

- Give each operation plan a seed and serialize the complete plan in its report.
- Verify file contents, metadata, path identity, and absence—not only row names.
- Add configurable workloads for steady changes, bursts, rename storms, deep
  subtrees, large directories, ignored files, and mixed internal/external
  mutations.
- Add warm-up, cool-down, reference tree size, and expansion-state controls.

#### 1.2 Instrument every stage

- Timestamp operation completion in the worker.
- Timestamp native event receipt, reconciled ChangeSet, host delta, mirror
  application, React commit, and the next animation frame containing the state.
- Use a stable correlation identifier from operation through paint.
- Report p50, p95, p99, maximum, throughput, coalescing ratio, and misses.
- Record render counts and changed row ids for each committed delta.

#### 1.3 Add browser behavior scenarios

- Scroll continuously while mutations arrive.
- Expand/collapse folders during create and rename storms.
- Maintain range selection and focus while siblings are inserted and removed.
- Rename a row while unrelated updates arrive.
- Keep the active row anchored when items above it change.
- Run with default, Material, and minimal icon themes.
- Run with decorations changing independently of tree structure.
- Verify reduced-motion mode.

#### 1.4 Make it a gate

- Drive the packaged Electron playground through Playwright.
- Save JSON, trace, screenshots, frame data, and console errors as artifacts.
- Compare against versioned thresholds and fail on correctness or performance
  regression.
- Keep a manual observable mode for product inspection.
- Add a small pull-request scenario and a larger scheduled scenario.

### Exit criteria

- The harness measures operation-to-visible-paint in a real Electron renderer.
- A failed expectation or exceeded ratified budget exits non-zero.
- Reports contain enough data to locate delay in native, host, mirror, React, or
  paint stages.
- The 10,000-operation scheduled soak has zero missed final states.
- State-invariant scenarios report zero unintended focus, selection, expansion,
  or scroll-anchor changes.

## Phase 2 — Stable high-churn UI

### Goal

Make filesystem changes visually quiet and interaction-safe. Updates should feel
immediate without making the entire tree appear to move.

### Work

#### 2.1 Preserve structural identity

- Audit entry identity across rename, move, delete/recreate, and reconciliation.
- Apply scoped child-list diffs instead of rebuilding unrelated visible rows.
- Preserve arrays and snapshot views when their visible content is unchanged.
- Ensure decoration-only updates never alter tree structure or expansion state.

#### 2.2 Anchor the viewport

- Capture a stable row id and offset before structural changes.
- Restore its visual offset after insertions or removals above the viewport.
- Define behavior when the anchor is deleted or moved into a collapsed subtree.
- Test sticky roots and multiple workspace roots.

First implementation result (2026-07-21): fixed-height trees now preserve the
top visible row and its sub-row pixel offset across structural tree versions.
If that row is deleted, the next surviving row retains its former pixel
position, falling back backward only when necessary. The 500,000-row invariant
bench inserts 1,000 rows above the viewport: the uncorrected geometric drift is
22,000 px and measured corrected drift is 0.00 px, under a CI-enforced 0.5 px
limit. Transform animation is suppressed for the corrective tree version so it
cannot fight the scroll adjustment.

#### 2.3 Budget animation

- Animate only entered, removed, and materially repositioned visible rows.
- Avoid animating event storms as hundreds of independent transitions.
- Batch compatible mutations into one visual transaction.
- Use compositor-friendly properties and cancel stale transitions.
- Disable nonessential motion under `prefers-reduced-motion`.

First animation-budget result (2026-07-21): structural motion is now planned
from the mounted virtual window rather than the complete visible projection.
Only newly entered rows and mounted rows whose pixel offset materially changed
receive animation markers. Anchored corrections, reduced-motion sessions, a
second update during an active transaction, and commits affecting more than 64
mounted rows suppress motion entirely. The markers expire after 170 ms, which
also removes `will-change`; ordinary scroll and unrelated tree versions create
no compositor work. The 500,000-row gate observes 37 animated rows for a normal
1,000-child expansion, zero for a 130-mounted-row storm, and zero for an
anchored 1,000-row insertion. Published CSS additionally disables disclosure
chevron transitions under `prefers-reduced-motion`.

#### 2.4 Reduce render and allocation work

- Profile the 500,000-row and high-churn fixtures with browser tooling.
- Stabilize event handler identities where it materially affects row memoization.
- Avoid repeated sorting and O(n) parent-child reconstruction on hot paths.
- Pin viewport entries in the mirror and measure eviction/re-fetch behavior.
- Make icon and decoration resolution cache behavior visible in profiles.

First projection/allocation result (2026-07-21): decoration-only snapshots now
reuse the structural projection whenever `treeVersion` and expansion identity
are unchanged. This removes both the O(n) visible-row count and the full row
allocation from badge/status updates. The fake engine also publishes decoration
versions as persistent overlays instead of rebuilding its structural maps,
keeping the harness representative of the production mirror. On the 500,000-row
fixture, a one-row decoration update moved from 113.16 ms to 51.23 ms (about 55%
faster), with CI-enforced counts of zero projection materializations, exactly one
row render, and zero animation markers. The virtualizer now publishes its exact
mounted range through `setViewport`; scroll tests and the 500,000-row gate assert
that UI-to-host contract.

Second viewport-retention result (2026-07-21): `setViewport` now produces an
authoritative host patch instead of only recording the hint. The client mirror
pins roots, expanded and pending folders, and the latest viewport IDs; moving
the viewport releases the old window to LRU eviction. Overlapping moves transfer
only newly entered rows, and structural tree versions refresh the viewport even
when its pixel range is unchanged. The end-to-end gate re-fetches five rows that
an eight-entry mirror evicted, then proves a one-row shift transfers exactly one
entry. A separate 50,000-entry, 4,096-cap harness moves a 64-row viewport 200
times: patch reducer p50 is 0.69 ms, p95 1.10 ms, max 3.15 ms, with a hard 4,096
peak and verified cold-window eviction.

Third bounded-hydration result (2026-07-21): the initial handshake now ships
only roots; a 256-file gate reduced the snapshot from 257 full entry records to
one. Expansion publishes the complete, stable child order as compact ids while
full entry records remain limited to the mounted viewport; the 16-row gate
transfers at most 15 child records. Structural deltas refresh the active viewport
without waiting for a scroll event, and `projectionVersion` rematerializes rows
when placeholders hydrate at an unchanged tree version. The updated 50,000-row
harness reports root handshake 0.29 ms, structure seed 2.30 ms, and viewport
patch reducer p50 0.64 ms, p95 0.92 ms, max 2.07 ms while holding the 4,096-entry
cap exactly. The Electron watch bench observed 24/24 operations with zero misses,
mirror p95 115.4 ms, paint p95 126.7 ms, and React p95 18.2 ms. Binary viewport
patches were the next open transport item.

Fourth binary-transport result (2026-07-22): root and viewport entry records now
use a bincode-compatible `Vec<ClientEntry>` ArrayBuffer, with JSON retained only
as a protocol-v1 compatibility fallback. The codec round-trips every field and
rejects truncated or schema-drifted payloads. Across 200 64-row moves, average
payload size fell from 12,336 bytes to 1,920 bytes (**84.4% smaller**); binary
encode p50/p95 was 0.048/0.093 ms and reducer decode+apply p50/p95/max was
0.74/1.06/2.60 ms. A production-shaped MessageChannel benchmark cloned and
decoded 2,000 patches in 43.19 ms versus 55.18 ms for JSON (**21.7% faster**).
The Electron watch gate proved the ArrayBuffer path across the real
UtilityProcess/renderer boundary with 24/24 operations and zero misses. O(n) id
metadata for extremely wide expanded folders and avoiding the full visible-row
React projection remained open Phase 2.4 work.

Fifth windowed-projection result (2026-07-22): the React render path now asks
the snapshot only for the mounted virtual range. Complete ordering remains lazy
and is paid only by discrete commands such as typeahead, range selection,
Select All, reveal, or the deep viewport-anchor fallback. The 500,000-row gate
hard-limits initial render, scroll, and expansion to at most 100 materialized
rows; measured windows were 38, 48, and 38 rows respectively instead of
500,000. Against the immediately preceding baseline, initial render improved
165.79→114.98 ms (**30.6%**), 1,000-row scroll improved 117.20→90.10 ms
(**23.1%**), and 1,000-child expansion improved 161.03→145.36 ms (**9.7%**).
Viewport drift remained 0.00 px, rename identity/focus survived churn, and all
304 UI tests passed. The real Electron gate observed 24/24 operations with zero
misses, mirror p95 121.5 ms, paint p95 137.5 ms, React p95 16.3 ms, and 10.1
ops/s. O(n) ordered-id metadata for extremely wide folders and the intentionally
lazy full-order path used by global commands/deep anchoring remained Phase 2.4
follow-up work.

Sixth bounded-anchor result (2026-07-22): deep viewport anchoring no longer
materializes the complete previous and next visible orders. It captures the
single top row and resolves its stable id through 256-row probes centered on the
prior logical index, with bounded nearest-neighbor recovery when that row is
deleted. On the 500,000-row insert-above gate, adding 1,000 rows preserved the
anchor at 0.00 px drift and retained focus/selection while reading 2,241 rows
total, no more than 256 per request, instead of allocating two 500,000-row
arrays. Runtime was 207.63 ms versus the preceding 203.26 ms result, a neutral
single-run difference in this timing-only happy-dom reporter. Five repeated
validation runs ranged from 259.02 to 387.87 ms with a 269.56 ms median, so no
latency claim is attached to this slice; the deterministic allocation bound is
the improvement. All 308 UI tests passed. Remaining Phase 2.4 scaling work is
the O(n) ordered-id metadata for extremely wide folders and the deliberately
lazy full-order reads used by global commands.

The real Electron follow-up did not produce a clean watcher-convergence signal:
two identical 24-operation runs observed 20/24 and 8/24 operations before the
host watcher stopped converging. Their observed renderer work stayed within the
ratified budgets (worst run: mirror p95 94.9 ms, paint p95 111.7 ms, React p95
17.7 ms), but both correctly exited non-zero for state misses. This matches the
open watcher-readiness/reliability risk and is not counted as an end-to-end pass
for the bounded-anchor slice.

Seventh windowed-keyboard result (2026-07-22): the keyboard hook no longer
materializes the complete visible order before determining the key intent.
Arrow Up/Down, Home/End, Page Up/Down, folder navigation, adjacent range
extension, and container-focus restoration now use count, bounded index lookup,
and row windows; the legacy full-order property remains as a compatibility and
correctness fallback. The regression test first demonstrated that one
`ArrowDown` on a 10,000-row fixture requested 9,999 rows at once. It now passes
from a viewport around row 5,000 with both ArrowDown and PageDown capped at 256
rows per request and 512 total. The 500,000-row gate consistently read 295 rows
total (including the 38-row rerendered viewport), with a 256-row maximum.
Across five runs, ArrowDown ranged from 11.09 to 29.99 ms with a 14.68 ms
median; focus moved to the exact next id in every run. All 309 UI tests and all
12 playground harness tests passed. Remaining global-order consumers are
typeahead, Select All, deliberately long range selection, reveal/path fallback,
and rare recovery when a focused id is far outside the mounted neighborhood.

Eighth windowed-typeahead result (2026-07-22): prefix navigation retains its
500 ms rolling buffer, case-insensitive matching, next-match behavior, and
ordered wraparound without first allocating the entire visible projection. A
new backward-compatible row-source API scans in 256-row windows; callers using
the original array API keep the prior contract. The deep 10,000-row regression
first failed because a nearby match requested 9,999 rows at once. On the
500,000-row gate, a nearby match now reads 550 rows total (including focus lookup
and the 38-row rerender), while a deliberate full-wrap miss reads 500,256 rows
but never more than 256 in one request and preserves focus. Across five runs,
near-match latency was 11.42-25.90 ms (13.57 ms median) and full-wrap miss
latency was 29.86-33.57 ms (31.32 ms median). All 310 UI tests and all 12
playground harness tests passed. Typeahead no longer requires a full-order
allocation, but worst-case misses remain O(n); Select All, long ranges,
reveal/path fallback, rare off-viewport recovery, and wide-folder ordered-id
metadata remain Phase 2.4 work.

#### 2.5 Define state under deletion and errors

- Move focus to the nearest logical sibling or parent when the focused row is
  deleted.
- Remove deleted rows from selection without clearing unrelated selection.
- Keep an inline rename open when an unrelated delta arrives.
- Give stale rename/move failures a recoverable state rather than closing input.

First interaction-reconciliation result (2026-07-21): structural tree versions
preserve surviving selection IDs, focus, and the range anchor by stable entry
ID. Deleted IDs alone are pruned. If the focused row disappears, focus moves to
the nearest surviving row (forward first, then backward); when it was the sole
selection, that replacement becomes selected. Reconciliation runs before paint
to avoid a transient empty-focus frame. The 500,000-row CI invariant bench now
asserts both 0.5 px viewport stability and focused-selection preservation while
1,000 rows are inserted above the active row.

Rename-recovery result (2026-07-21): unrelated structural versions retain the
exact inline-input DOM node, draft value, and browser focus. Once an observed
target disappears, rename mode is cancelled before paint so a recycled entry ID
cannot resurrect the draft. Every failed engine attempt carries a revision,
making identical `EEXIST`/`ENOENT` failures genuinely retryable without
remounting the editor. Monotonic operation tokens prevent a late async success
or failure from closing a newer rename session. The 500,000-row gate appends
1,000 unrelated rows while editing and reports preserved input identity, draft,
and focus in 118.80 ms with zero animation markers.

### Exit criteria

- Real-browser churn scenarios stay within the ratified frame and latency
  budgets.
- Inserting/removing siblings does not reset unrelated row animations or state.
- Scroll anchoring passes deterministic insert-above and delete-above scenarios.
- Reduced-motion mode has no structural animation.
- Profiling shows work proportional to changed and visible rows for normal
  deltas.

## Phase 3 — Explorer settings and navigation

### Goal

Deliver the baseline configuration and stateful navigation users expect from an
IDE explorer.

### Work

#### 3.1 Introduce an explorer settings model

- Sorting: natural name, type, and modified time.
- Case sensitivity and locale-aware comparison.
- Folders-on-top toggle.
- Hidden files, configurable exclude globs, and Git-ignore visibility.
- Compact folders and configurable file nesting rules.
- Global defaults with per-workspace and per-root overrides.
- Stable serialized schema with migration/version support.

Push sorting/filtering semantics into the engine/snapshot boundary where needed;
do not implement a second incompatible tree model only in React.

#### 3.2 Complete multi-root workspace behavior

- Add, remove, rename-display, and reorder workspace roots.
- Support drag/drop between roots with explicit policy and collision handling.
- Keep roots visually distinct and preserve state per root.
- Handle missing, disconnected, and permission-denied roots.

#### 3.3 Persist navigation state

- Expansion ids/paths per workspace.
- Focus, selection, active filter mode, and scroll anchor where appropriate.
- Restore lazily without forcing an eager full-tree walk.
- Version and bound persisted state so stale workspaces do not grow indefinitely.

#### 3.4 Follow the editor

- Optional always-reveal-active-file behavior.
- Manual Reveal in Explorer command.
- Configurable single-click preview and double-click permanent open.
- Avoid fighting the user when they deliberately navigate elsewhere.
- Define behavior for excluded, hidden, generated, and external files.

#### 3.5 Complete baseline actions

- Copy absolute path and workspace-relative path.
- Reveal in Finder/Explorer and open containing folder.
- Open terminal at file parent or directory.
- Refresh/resync a subtree and the whole workspace.
- Collapse all and collapse descendants.
- Find in folder and search-with-include/exclude host hooks.

### Exit criteria

- Settings persist and migrate across restarts.
- All sort/exclude/nesting combinations have engine and UI tests.
- Root add/remove/reorder works without restarting the explorer.
- Active-editor reveal works through lazy, collapsed paths without losing user
  scroll unexpectedly.
- The reference playground exposes every baseline action with platform-correct
  behavior or an explicit unsupported state.

## Phase 4 — Production file operations

### Goal

Make every destructive or long-running operation explicit, observable,
recoverable, and safe.

### Work

#### 4.1 Implement real external import

- Add an engine/host `copyFromPath` contract for files and directories.
- Preserve contents and relevant metadata.
- Support multiple paths, recursive directories, and cross-device copies.
- Remove the placeholder-file fallback.
- Surface per-item failure instead of swallowing errors.

#### 4.2 Add collision policy

- Prompt for overwrite, rename, merge, skip, and apply-to-all where relevant.
- Detect self-copy, descendant cycles, case-only conflicts, and cross-root rules.
- Revalidate immediately before mutation to handle external races.

#### 4.3 Add progress and cancellation

- Model long operations with ids, progress, cancellation, and completion status.
- Keep the tree responsive while operations run.
- Define cleanup for partial copies and interrupted moves.
- Coalesce watcher echoes with library-owned mutations without hiding external
  changes.

#### 4.4 Add recovery and undo

- Make trash the safe default where the platform supports it.
- Add an operation journal sufficient to undo rename, move, create, and safe
  delete operations.
- Report when an operation is not undoable.
- Reconcile or rescan affected subtrees after partial or ambiguous failure.

### Exit criteria

- OS drag-in copies actual file and directory contents.
- Errors are visible, attributable to individual items, and never silently
  converted into empty files.
- Large operations expose progress and can be cancelled safely.
- Collision scenarios have deterministic tests on case-sensitive and
  case-insensitive filesystems.
- Supported operations have documented undo semantics.

## Phase 5 — IDE workflow integration

### Goal

Move from a capable filesystem tree to a central IDE navigation surface.

### Work

#### 5.1 First-class decorations and statuses

- Source-control states, including staged/conflicted/renamed combinations.
- Diagnostic severity and aggregate descendant badges.
- Test status and failure decorations.
- Dirty/open/active editor state.
- Excluded, generated, library, and read-only state.

Define merge precedence, accessible text, and update cost for every provider.

#### 5.2 Views and scopes

- Files/Project view.
- Open Files.
- Changed Files.
- Problems.
- Tests or failed tests.
- Host-defined saved scopes.

Reuse the same identity and virtualization primitives rather than forking the
tree component per view.

#### 5.3 History and source-control actions

- File timeline/history provider surface.
- Compare with previous or selected revision.
- Revert/restore hooks with confirmation and progress.
- Context-aware SCM commands.

#### 5.4 Command contribution contract

- Host-contributed commands, submenus, grouping, enablement, and keybindings.
- Commands receive stable selection, workspace, editor, SCM, and diagnostic
  context.
- Async progress, cancellation, failure notification, and telemetry hooks.

### Exit criteria

- The reference playground demonstrates SCM, diagnostics, Open Files, Changed
  Files, and Problems against live data.
- Decoration-only churn remains within the browser performance budget.
- Command contribution is documented and tested without requiring the styled
  entry point.
- Every visual status has equivalent accessible text.

## Phase 6 — Provider and platform depth

### Goal

Remove assumptions that limit Mille to a local desktop filesystem and complete
the accessibility/platform quality matrix.

### Work

#### 6.1 Filesystem provider boundary

- Define URI-first stat, list, read, write, watch, and mutation capabilities.
- Advertise provider capabilities rather than assuming every operation exists.
- Model latency, pagination, reconnect, offline state, and eventual consistency.
- Keep local Rust/native behavior as the optimized default provider.

#### 6.2 Platform matrix

- Windows drive and UNC behavior.
- macOS Unicode normalization and case-insensitive defaults.
- Linux case-sensitive and inotify limit behavior.
- Symlink/junction policies and permission boundaries.
- Network and remote-like latency/failure simulation.

#### 6.3 Accessibility validation

- Automated axe checks in the Electron/browser suite.
- VoiceOver on macOS and NVDA on Windows scripted acceptance scenarios.
- High contrast, zoom, reduced motion, and keyboard-only operation.
- Announce create, rename, delete, move, errors, loading, and result counts
  without flooding live regions during event storms.

### Exit criteria

- A non-local test provider renders and supports its advertised mutation set.
- Unsupported provider operations are disabled with an explanation.
- Platform-specific filesystem scenarios pass in CI or a documented hardware
  lane.
- The accessibility acceptance matrix has no critical open failures.

## Cross-cutting test matrix

Each phase must cover the relevant intersections below.

| Dimension     | Required cases                                                                                              |
| ------------- | ----------------------------------------------------------------------------------------------------------- |
| Platform      | macOS arm64/x64 where available, Windows x64, Linux x64; architecture packaging smoke for remaining targets |
| Filesystem    | Case-sensitive, case-insensitive, symlinks/junctions, read-only, permission denied, disk-full simulation    |
| Tree scale    | Empty, small, 10k, 100k, 500k synthetic, large single directory, deep hierarchy                             |
| Update shape  | Single event, coalesced burst, rename storm, recursive subtree, decoration-only, overflow/resync            |
| View state    | Expanded, collapsed, filtered, searched, selected, renaming, dragging, scrolled                             |
| Renderer      | Development and packaged Electron; default and reduced motion; representative icon themes                   |
| Accessibility | Keyboard-only, screen reader, high contrast, zoom, reduced motion                                           |

## Documentation requirements

Every completed phase must update:

- package and embedding documentation;
- public API declarations and examples;
- benchmark methodology and reference thresholds;
- behavior differences by platform/provider;
- migration notes for settings or API changes;
- the assessment scores and remaining-gap inventory.

## Recommended first implementation slice

Start with **Watcher Reliability and Build Identity**, not another UI feature.

Implementation is in progress with a measured first result. The new headless
soak found that nested and whole-directory renames lost descendants: the
baseline converged on 100/120 operations with 20 misses and p95 67.2 ms across
successful operations. Preserving directory descendants during rename and
reconciling create-only rename events moved the identical deterministic plan to
120/120, zero misses, p50 57.8 ms, p95 65.8 ms, p99 71.7 ms, and max 75.3 ms.
The completion run passed 1,000/1,000 with zero misses, p50 60.5 ms, p95
67.2 ms, p99 68.9 ms, max 75.0 ms, and 16.7 sequential operations/s. Full
engine/UI/type validation is green; CI now repeats the live watcher cases 20
times and retains the soak report.

### Scope

1. Add runtime diagnostic identity for native core, target, protocol, binding, and
   TypeScript versions.
2. Establish a clean local rebuild path and prove which `.node` file loads.
3. Distinguish unavailable host watching from engine failures and include
   stage/build diagnostics in reports.
4. Fix the first point where external events disappear.
5. Add a deterministic 1,000-operation headless soak using the playground
   operation-plan library where practical.
6. Add repeated watcher runs to CI and retain reports.

### Explicitly out of scope for the first slice

- new sort, nesting, or workspace settings;
- additional animation tuning;
- source-control or diagnostics views;
- undo or large-operation progress;
- remote filesystem providers.

### First-slice completion gate

- All current engine tests pass or have a documented, justified platform skip.
- The three failing watcher cases pass 20 consecutive local runs.
- The 1,000-operation headless soak has zero final-state misses.
- Test and playground output identify the exact native and TypeScript builds.
- The implementation includes targeted regression tests and updated watcher
  benchmark documentation.

Completing this slice makes later UI optimization trustworthy: if disk, host,
mirror, and renderer state are not known to agree, visual smoothness numbers can
hide correctness failures.
