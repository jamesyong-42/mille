import type { Entry, EntryId } from '@vibecook/mille';

export type ActiveEntryOrigin = 'workspace' | 'generated' | 'external';

export interface ActiveEntryTarget {
  readonly target: EntryId | string;
  /** Defaults to `workspace`. Generated/external status cannot be inferred. */
  readonly origin?: ActiveEntryOrigin;
}

export type ActiveEntryInput = EntryId | string | ActiveEntryTarget;

export type ActiveEntryDisposition =
  | 'visible'
  | 'hidden'
  | 'ignored'
  | 'generated'
  | 'external'
  | 'missing';

export interface ActiveEntryPolicy {
  /** Attempt auto-reveal even while hidden-file visibility is disabled. */
  readonly revealHidden?: boolean;
  /** Attempt auto-reveal even while ignored/excluded visibility is disabled. */
  readonly revealIgnored?: boolean;
  /** Attempt auto-reveal for a host-tagged generated target. */
  readonly revealGenerated?: boolean;
}

export type ActiveEntryAutoReveal =
  | 'not-requested'
  | 'suppressed'
  | 'attempted'
  | 'failed';

export interface ActiveEntryResolution {
  readonly target: EntryId | string;
  readonly origin: ActiveEntryOrigin;
  readonly entryId: EntryId | null;
  readonly disposition: ActiveEntryDisposition;
  readonly autoReveal: ActiveEntryAutoReveal;
}

export interface ActiveEntryClassificationInput {
  readonly origin: ActiveEntryOrigin;
  readonly entry: Entry | null;
  readonly showHiddenFiles?: boolean | undefined;
  readonly showIgnoredFiles?: boolean | undefined;
}

export function normalizeActiveEntryTarget(input: ActiveEntryInput): {
  readonly target: EntryId | string;
  readonly origin: ActiveEntryOrigin;
} {
  if (typeof input === 'object') {
    return {
      target: input.target,
      origin: input.origin ?? 'workspace',
    };
  }
  return { target: input, origin: 'workspace' };
}

export function classifyActiveEntry(
  input: ActiveEntryClassificationInput,
): ActiveEntryDisposition {
  if (input.origin === 'external') return 'external';
  if (input.entry === null) return 'missing';
  if (input.origin === 'generated') return 'generated';
  if (input.entry.isHidden && input.showHiddenFiles === false) return 'hidden';
  if (input.entry.isIgnored && input.showIgnoredFiles === false) return 'ignored';
  return 'visible';
}

export function shouldAutoRevealActiveEntry(
  disposition: ActiveEntryDisposition,
  policy: ActiveEntryPolicy = {},
): boolean {
  if (disposition === 'visible') return true;
  if (disposition === 'hidden') return policy.revealHidden === true;
  if (disposition === 'ignored') return policy.revealIgnored === true;
  if (disposition === 'generated') return policy.revealGenerated === true;
  return false;
}
