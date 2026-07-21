# Playground watcher benchmark

This harness measures the path users actually run:

```text
external filesystem operation
  → native notify/debouncer watcher
  → disk reconciliation + EntryStore ChangeSet
  → host tick + MessagePort delta
  → renderer mirror
  → next browser paint
```

It is intentionally different from the Criterion watcher microbenchmarks in `crates/mille-bench`: those measure coalescing and tracking primitives without Electron, while this harness measures observable end-to-end behavior.

## Run it

From the repository root:

```bash
pnpm bench:watch
```

The launcher is also directly runnable as `node scripts/watch-bench.mjs`, which uses only the repository's installed binaries and is useful when Corepack/package-manager version switching is unavailable.

The command builds the current debug native binding and TypeScript package, creates an isolated directory under the OS temporary directory, and opens the Electron playground on that directory. A separate UtilityProcess performs real operations while the normal FileTree renders them. The benchmark HUD shows progress, recent latency samples, mirror p50, paint p50/p95, maximum paint-ready latency, misses, and completed operations per second.

The default run executes 240 operations. Each twelve-operation cycle covers:

- directory creation;
- file create, rewrite, and append;
- file rename, copy, and delete;
- nested directory and file creation;
- nested-directory rename with a child;
- whole-subtree rename; and
- recursive subtree deletion.

Each operation waits until its exact expected state is present in the renderer mirror and two animation frames have elapsed. This prevents debounce coalescing from making intermediate operations look successful when the UI never represented them.

Before measurement begins, an unmeasured create/delete pair must traverse the complete pipeline successfully. This warms the OS watcher and proves the roots-only expansion has settled, preventing cold-start setup from contaminating the first latency sample.

## Options

Pass options after `--`:

```bash
pnpm bench:watch -- --operations 1200 --debounce 25 --timeout 8000 --pause 10
```

- `--operations N`: number of filesystem operations; default `240`.
- `--debounce MS`: native watcher debounce; default `40`.
- `--timeout MS`: maximum time for one exact state to reach the renderer; default `5000`.
- `--pause MS`: additional delay after each observed paint; default `0`.
- `--keep`: retain the temporary workspace and JSON report after the playground exits.
- `--exit`: close the playground automatically after completion; useful for automated smoke runs.

Without `--keep`, the temporary directory is removed when the benchmark launcher exits. The terminal prints both the sandbox and report paths at startup. The JSON report contains the loaded package/native build identity, every observation, and min/mean/p50/p95/p99/max latency summaries.

Close the playground or press Ctrl+C in the launching terminal to stop. The benchmark mode does not open detached DevTools because that materially distorts render timing.

## Reading the numbers

- **Mirror latency** starts immediately after the filesystem syscall completes and ends when the renderer-side `PortFileExplorer` snapshot satisfies the expected state.
- **Paint latency** ends after two `requestAnimationFrame` boundaries, approximating the first paint opportunity after the state reached React. Off-screen rows remain virtualized, so this is paint readiness rather than a guarantee that every row was physically painted.
- **Operations/second** is sequential end-to-end throughput: the worker does not issue the next operation until the previous state has reached the paint-ready boundary.
- **Missed** means the exact expected state failed to converge before `--timeout`; it is never silently counted as a slow success.

For native primitive throughput without Electron, run:

```bash
pnpm bench:core
```

For a deterministic correctness-and-latency gate through the native watcher,
store, and JavaScript snapshot—but without renderer timing—run:

```bash
pnpm bench:watch:soak
```

This rebuilds the current native binding and package, then performs 1,000 real
filesystem operations in an isolated temporary directory. It fails on any
state-convergence miss or when observed p95 latency exceeds 150 ms. Use
`--operations`, `--debounce`, `--timeout`, `--poll`, `--max-p95`, `--report`,
and `--keep` to tune or retain a complete JSON report. A watcher preflight
distinguishes an unavailable host watcher (exit 2) from a Mille correctness or
performance failure (exit 1).
