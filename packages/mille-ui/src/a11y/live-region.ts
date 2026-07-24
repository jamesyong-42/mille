// Phase 6.3 — throttled live-region announcer.
//
// Prevents event storms (bulk delete, rename floods) from flooding
// screen readers. Coalesces messages within a window and enforces a
// minimum interval between announcements. Messages dropped by that
// throttle are still counted, and the next spoken message carries an
// "(and N more)" suffix — a storm reports its size instead of leaving
// the user with one arbitrary filename.
//
// Two regions are mounted, one per politeness, because assistive tech
// latches politeness at insertion time; flipping `aria-live` on a single
// shared node is unreliable.
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
  /**
   * Queue a message for announcement. When throttling drops earlier queued
   * messages, the next spoken one is suffixed with `(and N more)`.
   */
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

  // Two regions, each with a politeness fixed at mount. Assistive tech
  // latches a live region's politeness when it is inserted, so flipping
  // `aria-live` on one shared node is unreliable — and `role="status"`
  // (implicitly polite) contradicts `aria-live="assertive"` outright.
  let politeRegion: HTMLElement | null = null;
  let assertiveRegion: HTMLElement | null = null;
  let disposed = false;
  let lastAnnounceAt = 0;
  let pending: { message: string; politeness: LivePoliteness } | null = null;
  /** Messages replaced before they were ever spoken (storm suppression). */
  let suppressed = 0;
  let coalesceTimer: ReturnType<typeof setTimeout> | null = null;
  let intervalTimer: ReturnType<typeof setTimeout> | null = null;

  function createRegion(politeness: LivePoliteness): HTMLElement | null {
    if (!doc) return null;
    const el = doc.createElement('div');
    // role=status is implicitly polite; role=alert is implicitly assertive.
    el.setAttribute('role', politeness === 'assertive' ? 'alert' : 'status');
    el.setAttribute('aria-live', politeness);
    el.setAttribute('aria-atomic', 'true');
    el.setAttribute('data-mille-live-announcer', politeness);
    el.style.position = 'absolute';
    el.style.width = '1px';
    el.style.height = '1px';
    el.style.padding = '0';
    el.style.margin = '-1px';
    el.style.overflow = 'hidden';
    el.style.clip = 'rect(0, 0, 0, 0)';
    el.style.whiteSpace = 'nowrap';
    el.style.border = '0';
    if (options.mount) options.mount(el);
    else doc.body?.appendChild(el);
    return el;
  }

  /** Mount both regions on first use so their order in the DOM is stable. */
  function ensureMounted(politeness: LivePoliteness): HTMLElement | null {
    if (!doc || disposed) return null;
    if (politeRegion === null && assertiveRegion === null) {
      politeRegion = createRegion('polite');
      assertiveRegion = createRegion('assertive');
    }
    return politeness === 'assertive' ? assertiveRegion : politeRegion;
  }

  function speak(message: string, politeness: LivePoliteness): void {
    const el = ensureMounted(politeness);
    if (!el || !message) return;
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
    // Report what the storm swallowed instead of dropping it silently: the
    // point of a bulk operation is the count, not the last filename.
    const extra = suppressed;
    suppressed = 0;
    speak(
      extra > 0 ? `${job.message} (and ${extra} more)` : job.message,
      job.politeness,
    );
  }

  const api: LiveAnnouncer = {
    get mounted() {
      return politeRegion !== null || assertiveRegion !== null;
    },
    announce(message, politeness = defaultPoliteness) {
      if (disposed || !message.trim()) return;
      // The message being replaced was never spoken — count it.
      if (pending !== null) suppressed += 1;
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
      suppressed = 0;
      for (const el of [politeRegion, assertiveRegion]) {
        if (el?.parentNode) el.parentNode.removeChild(el);
      }
      politeRegion = null;
      assertiveRegion = null;
    },
  };

  return api;
}
