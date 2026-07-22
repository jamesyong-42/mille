import type { EntryId } from '@vibecook/mille';

/** Maximum number of mounted rows that one structural commit may animate. */
export const MAX_LAYOUT_ANIMATION_ROWS = 64;

export interface RenderedRowPosition {
  readonly id: EntryId;
  readonly offsetPx: number;
}

export interface LayoutAnimationPlan {
  readonly active: boolean;
  readonly enteringIds: ReadonlySet<EntryId>;
  readonly repositioningIds: ReadonlySet<EntryId>;
  readonly suppressedBy:
    | 'none'
    | 'initial'
    | 'anchored'
    | 'reduced-motion'
    | 'in-flight'
    | 'budget'
    | 'no-visible-change';
}

function idlePlan(suppressedBy: LayoutAnimationPlan['suppressedBy']): LayoutAnimationPlan {
  return {
    active: false,
    enteringIds: new Set<EntryId>(),
    repositioningIds: new Set<EntryId>(),
    suppressedBy,
  };
}

/**
 * Plan one bounded visual transaction from the rows that are actually mounted.
 * This deliberately ignores off-screen rows: animating them would add work but
 * cannot produce a visible result.
 */
export function planLayoutAnimation(
  previousPositions: ReadonlyMap<EntryId, number>,
  nextPositions: readonly RenderedRowPosition[],
  options: {
    readonly viewportAnchored: boolean;
    readonly prefersReducedMotion: boolean;
    readonly animationInFlight: boolean;
    readonly maxAnimatedRows?: number;
  },
): LayoutAnimationPlan {
  if (previousPositions.size === 0) return idlePlan('initial');
  if (options.viewportAnchored) return idlePlan('anchored');
  if (options.prefersReducedMotion) return idlePlan('reduced-motion');
  if (options.animationInFlight) return idlePlan('in-flight');

  const enteringIds = new Set<EntryId>();
  const repositioningIds = new Set<EntryId>();
  const limit = options.maxAnimatedRows ?? MAX_LAYOUT_ANIMATION_ROWS;

  for (const row of nextPositions) {
    const previousOffset = previousPositions.get(row.id);
    if (previousOffset === undefined) {
      enteringIds.add(row.id);
    } else if (Math.abs(previousOffset - row.offsetPx) > 0.5) {
      repositioningIds.add(row.id);
    }

    if (enteringIds.size + repositioningIds.size > limit) {
      return idlePlan('budget');
    }
  }

  if (enteringIds.size === 0 && repositioningIds.size === 0) {
    return idlePlan('no-visible-change');
  }

  return {
    active: true,
    enteringIds,
    repositioningIds,
    suppressedBy: 'none',
  };
}
