// Phase 6.3 — throttled live-region announcer.
//
// Prevents event storms (bulk delete, rename floods) from flooding
// screen readers. Coalesces messages within a window and enforces a
// minimum interval between announcements.
//
// DOM mount is lazy (first announce), never during React render.

export type LivePoliteness = 'polite' | 'assertive';

export interface LiveAnnouncerOptions {
  /** Default politeness. Default 'polite'. */
  readonly politeness?: LivePoliteness;
  /** Minimum ms between spoken announcements. Default 500. */
  readonly minIntervalMs?: number;
  /**
   * When multiple messages arrive inside this window, only the latest
   * (or a coalesced summary) is announced. Default 100.
   */
  readonly coalesceWindowMs?: number;
  /**
   * Inject a live region element. Defaults to creating a visually-hidden
   * `role="status"` node under `document.body` when available.
   * Called lazily on the first announcement, not at construction.
   */
  readonly mount?: (el: HTMLElement) => void;
  /** Override document (tests). */
  readonly document?: Document;
  /**
   * Clock for tests. Defaults to `Date.now`.
   */
  readonly now?: () => number;
  /**
   * Timer injection for tests. Defaults to global setTimeout/clearTimeout.
   */
  readonly setTimeout?: typeof globalThis.setTimeout;
  readonly clearTimeout?: typeof globalThis.clearTimeout;
}

export interface LiveAnnouncer {
  /** Queue a message for announcement. */
  announce(message: string, politeness?: LivePoliteness): void;
  /**
   * Announce a bulk summary instead of N individual events.
   * Example: `announceMany('Deleted', 12)` → "Deleted 12 items".
   */
  announceMany(verb: string, count: number, politeness?: LivePoliteness): void;
  /**
   * Flush pending using the normal min-interval gate (does **not** bypass
   * throttling). Use for tests that advance fake timers instead.
   */
  flush(): void;
  /**
   * Test-only: flush immediately, ignoring min-interval. Prefer real timer
   * tests for throttle behavior.
   */
  flushForce?(): void;
  dispose(): void;
  /** Whether the live region has been mounted (lazy). */
  readonly mounted: boolean;
}

/**
 * Create a storm-safe live announcer for create/rename/delete/move
 * feedback without flooding AT during bulk operations.
 */
export function createLiveAnnouncer(
  options: LiveAnnouncerOptions = {},
): LiveAnnouncer {
  const minIntervalMs = options.minIntervalMs ?? 500;
  const coalesceWindowMs = options.coalesceWindowMs ?? 100;
  const defaultPoliteness = options.politeness ?? 'polite';
  const doc =
    options.document ??
    (typeof document !== 'undefined' ? document : undefined);
  const now = options.now ?? (() => Date.now());
  const schedule = options.setTimeout ?? globalThis.setTimeout.bind(globalThis);
  const cancel = options.clearTimeout ?? globalThis.clearTimeout.bind(globalThis);

  let region: HTMLElement | null = null;
  let disposed = false;
  let lastAnnounceAt = 0;
  let pending: { message: string; politeness: LivePoliteness } | null = null;
  let coalesceTimer: ReturnType<typeof setTimeout> | null = null;
  let intervalTimer: ReturnType<typeof setTimeout> | null = null;

  function ensureMounted(): HTMLElement | null {
    if (region || !doc || disposed) return region;
    region = doc.createElement('div');
    region.setAttribute('role', 'status');
    region.setAttribute('aria-live', defaultPoliteness);
    region.setAttribute('aria-atomic', 'true');
    region.setAttribute('data-mille-live-announcer', '');
    region.style.position = 'absolute';
    region.style.width = '1px';
    region.style.height = '1px';
    region.style.padding = '0';
    region.style.margin = '-1px';
    region.style.overflow = 'hidden';
    region.style.clip = 'rect(0, 0, 0, 0)';
    region.style.whiteSpace = 'nowrap';
    region.style.border = '0';
    if (options.mount) options.mount(region);
    else doc.body?.appendChild(region);
    return region;
  }

  function speak(message: string, politeness: LivePoliteness): void {
    const el = ensureMounted();
    if (!el || !message) return;
    el.setAttribute('aria-live', politeness);
    el.textContent = '';
    void el.offsetHeight;
    el.textContent = message;
    lastAnnounceAt = now();
  }

  function scheduleFlush(): void {
    if (coalesceTimer !== null) return;
    coalesceTimer = schedule(() => {
      coalesceTimer = null;
      flushPending(false);
    }, coalesceWindowMs) as ReturnType<typeof setTimeout>;
  }

  function flushPending(force: boolean): void {
    if (disposed || !pending) return;
    const elapsed = now() - lastAnnounceAt;
    const wait = minIntervalMs - elapsed;
    if (!force && wait > 0) {
      if (intervalTimer !== null) return;
      intervalTimer = schedule(() => {
        intervalTimer = null;
        flushPending(false);
      }, wait) as ReturnType<typeof setTimeout>;
      return;
    }
    const job = pending;
    pending = null;
    speak(job.message, job.politeness);
  }

  const api: LiveAnnouncer = {
    get mounted() {
      return region !== null;
    },
    announce(message, politeness = defaultPoliteness) {
      if (disposed || !message.trim()) return;
      pending = { message: message.trim(), politeness };
      scheduleFlush();
    },
    announceMany(verb, count, politeness = defaultPoliteness) {
      if (count <= 0) return;
      if (count === 1) {
        api.announce(`${verb} 1 item`, politeness);
        return;
      }
      api.announce(`${verb} ${count} items`, politeness);
    },
    flush() {
      if (coalesceTimer !== null) {
        cancel(coalesceTimer);
        coalesceTimer = null;
      }
      flushPending(false);
    },
    flushForce() {
      if (coalesceTimer !== null) {
        cancel(coalesceTimer);
        coalesceTimer = null;
      }
      if (intervalTimer !== null) {
        cancel(intervalTimer);
        intervalTimer = null;
      }
      flushPending(true);
    },
    dispose() {
      disposed = true;
      if (coalesceTimer !== null) cancel(coalesceTimer);
      if (intervalTimer !== null) cancel(intervalTimer);
      coalesceTimer = null;
      intervalTimer = null;
      pending = null;
      if (region?.parentNode) region.parentNode.removeChild(region);
      region = null;
    },
  };

  return api;
}
