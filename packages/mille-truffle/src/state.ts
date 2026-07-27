// Connection state machine and reconnect backoff (SPEC §18.1, §18.4).
//
// Pure: no timers, no sockets, no clock. Reconnect logic is the classic
// place where "it worked when I tested it" hides an unbounded loop or a
// terminal error being retried forever, so the decisions live here where
// they can be asserted directly rather than observed through a network.

import type { RemoteExplorerErrorCode } from './errors.js';

export type RemoteConnectionState =
  | 'connecting'
  | 'online'
  | 'stale'
  | 'reconnecting'
  | 'closed';

export interface ReconnectOptions {
  readonly minDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly multiplier?: number;
  /** Fraction of the delay applied as symmetric jitter, 0..1. */
  readonly jitter?: number;
}

export interface ResolvedReconnect {
  readonly minDelayMs: number;
  readonly maxDelayMs: number;
  readonly multiplier: number;
  readonly jitter: number;
}

export const DEFAULT_RECONNECT: ResolvedReconnect = {
  minDelayMs: 500,
  maxDelayMs: 10_000,
  multiplier: 1.8,
  jitter: 0.2,
};

export function resolveReconnect(options?: ReconnectOptions | false): ResolvedReconnect | null {
  if (options === false) return null;
  const r = { ...DEFAULT_RECONNECT, ...(options ?? {}) };
  if (r.minDelayMs <= 0 || r.maxDelayMs < r.minDelayMs) {
    throw new RangeError('reconnect delays must satisfy 0 < minDelayMs <= maxDelayMs');
  }
  if (r.multiplier < 1) throw new RangeError('reconnect multiplier must be >= 1');
  if (r.jitter < 0 || r.jitter > 1) throw new RangeError('reconnect jitter must be within 0..1');
  return r;
}

/**
 * Delay before attempt number `attempt` (0-based).
 *
 * `random` is injected so the schedule is testable; production passes
 * `Math.random`. Jitter is symmetric around the base delay and the result is
 * clamped, so a large jitter cannot push a retry past `maxDelayMs` — an
 * unbounded tail is exactly what backoff exists to prevent.
 */
export function backoffDelay(
  attempt: number,
  r: ResolvedReconnect,
  random: () => number = Math.random,
): number {
  const base = Math.min(r.maxDelayMs, r.minDelayMs * Math.pow(r.multiplier, Math.max(0, attempt)));
  if (r.jitter === 0) return Math.round(base);
  const spread = base * r.jitter;
  const delta = (random() * 2 - 1) * spread;
  return Math.round(Math.min(r.maxDelayMs, Math.max(r.minDelayMs, base + delta)));
}

/**
 * Failures that must not be retried.
 *
 * Retrying these is worse than useless: the answer will not change, and a
 * client that keeps redialling a denial looks like a brute-force attempt to
 * whoever is reading the server's logs.
 */
const TERMINAL_CODES: ReadonlySet<RemoteExplorerErrorCode> = new Set([
  'ACCESS_DENIED',
  'PROTOCOL_MISMATCH',
  'LIMIT_EXCEEDED',
]);

export interface RetryDecision {
  readonly retry: boolean;
  readonly reason: string;
}

export function shouldRetry(
  code: RemoteExplorerErrorCode,
  options: { readonly retryServerShutdown?: boolean } = {},
): RetryDecision {
  if (TERMINAL_CODES.has(code)) {
    return { retry: false, reason: `${code} will not change on retry` };
  }
  if (code === 'SERVER_SHUTTING_DOWN') {
    // The server told us it is going away. Coming straight back is only
    // right when the caller expects it to return (§18.6).
    return options.retryServerShutdown === true
      ? { retry: true, reason: 'configured to retry a restarting server' }
      : { retry: false, reason: 'server is shutting down' };
  }
  return { retry: true, reason: `${code} may be transient` };
}
