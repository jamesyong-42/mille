// Phase 13.3 — batching / coalescing for decoration updates.
//
// git hosts emit storms of change events: a single `git pull` can
// produce dozens of `onChange` callbacks in tens of milliseconds. The
// companion absorbs those into one `onDidChange(ids)` per debounce
// window so React does a single commit instead of N.
//
// Semantics mirror the common trailing-debounce + max-wait model:
//   - `enqueue(id)` schedules a flush `debounceMs` after the last call.
//   - If the first enqueue in a burst is older than `maxWaitMs`, we
//     flush anyway. Prevents pathological "one enqueue every
//     debounceMs-1 ms" livelock.
//   - `flush()` forces an immediate drain, bypassing both timers.
//   - `dispose()` clears timers and drops the pending set; further
//     enqueues are no-ops.

import type { EntryId } from '@vibecook/mille';

export interface BatchOptions {
  /** Quiet window after the last enqueue before flushing. Default: 50 ms. */
  readonly debounceMs?: number;
  /** Hard ceiling from the *first* enqueue in a burst. Default: 500 ms. */
  readonly maxWaitMs?: number;
}

export interface Batcher {
  /** Add an id to the pending set. Schedules a flush per the timing rules. */
  enqueue(id: EntryId): void;
  /** Drain the pending set immediately. No-op when empty or disposed. */
  flush(): void;
  /** Drop pending ids and timers without invoking the work callback. */
  cancel(): void;
  /** Stop scheduling; drop pending ids. */
  dispose(): void;
}

/**
 * Coalesce many `enqueue(id)` calls into a single `work(ids)` call.
 *
 * The callback receives a fresh `Set<EntryId>` each firing. The
 * batcher does not retain the set after the callback returns.
 */
export function createBatcher(
  work: (changedIds: Set<EntryId>) => void,
  opts: BatchOptions = {},
): Batcher {
  const debounceMs = opts.debounceMs ?? 50;
  const maxWaitMs = opts.maxWaitMs ?? 500;

  let pending = new Set<EntryId>();
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let maxWaitTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  function clearTimers(): void {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (maxWaitTimer !== null) {
      clearTimeout(maxWaitTimer);
      maxWaitTimer = null;
    }
  }

  function drain(): void {
    if (disposed) return;
    if (pending.size === 0) {
      clearTimers();
      return;
    }
    const ids = pending;
    pending = new Set<EntryId>();
    clearTimers();
    work(ids);
  }

  return {
    enqueue(id: EntryId): void {
      if (disposed) return;
      pending.add(id);
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(drain, debounceMs);
      // First enqueue in the burst starts the max-wait timer.
      if (maxWaitTimer === null) {
        maxWaitTimer = setTimeout(drain, maxWaitMs);
      }
    },
    flush(): void {
      if (disposed) return;
      drain();
    },
    cancel(): void {
      if (disposed) return;
      clearTimers();
      pending.clear();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      clearTimers();
      pending.clear();
    },
  };
}
