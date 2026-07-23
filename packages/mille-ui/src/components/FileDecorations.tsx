// FileDecorations — renders the merged decoration overlay for one row.
//
// See MILLE_UI_SPEC.md §4.5 and §7. The row passes down a
// `MergedDecoration` whose reference is identity-stable between
// unchanged renders (the engine's `getDecorations` is frozen per
// snapshot; the UI-side fold caches on that array reference). This
// component is `memo`-wrapped on props reference equality — callers
// are responsible for not spreading the decoration record into a new
// reference each render.

import { memo, type CSSProperties, type ReactElement } from 'react';
import type { MergedDecoration } from './types.js';

export interface FileDecorationsProps {
  readonly decorations: MergedDecoration;
  readonly className?: string;
}

const WRAPPER_STYLE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '4px',
  flex: '0 0 auto',
};

// Letter / badge glyph layout. Kept flat so hosts can override with
// CSS on the class names.
const LETTER_STYLE: CSSProperties = {
  fontSize: '0.85em',
  fontWeight: 600,
  lineHeight: 1,
  minWidth: '0.9em',
  textAlign: 'center',
  fontVariantNumeric: 'tabular-nums',
};

const BADGE_STYLE: CSSProperties = {
  fontSize: '0.75em',
  fontWeight: 500,
  lineHeight: 1,
  padding: '0 4px',
  borderRadius: '4px',
  background: 'var(--mille-decoration-badge-bg, transparent)',
};

/**
 * Accessible label for a decoration overlay. Prefers the host-supplied
 * tooltip (diagnostics already format "2 errors, 1 warning"); falls
 * back to letter/badge glyphs so bare SCM letters remain named.
 */
export function decorationAccessibleLabel(
  decorations: MergedDecoration,
): string | undefined {
  if (decorations.tooltip !== undefined && decorations.tooltip.length > 0) {
    // Use the first line only — multi-line tooltips may append source
    // messages that are noisy for AT; the first line is the summary.
    const first = decorations.tooltip.split('\n')[0]?.trim();
    if (first !== undefined && first.length > 0) return first;
  }
  const parts: string[] = [];
  if (decorations.letter !== undefined) {
    parts.push(`status ${decorations.letter}`);
  }
  if (decorations.badge !== undefined) {
    // Numeric badges (diagnostics) read as "N problems".
    if (/^\d+\+?$/.test(decorations.badge)) {
      parts.push(
        decorations.badge === '1'
          ? '1 problem'
          : `${decorations.badge} problems`,
      );
    } else {
      parts.push(`badge ${decorations.badge}`);
    }
  }
  return parts.length > 0 ? parts.join(', ') : undefined;
}

function FileDecorationsImpl(props: FileDecorationsProps): ReactElement | null {
  const { decorations, className } = props;
  const { badge, letter, color, tooltip } = decorations;

  // Nothing to render — return null so the row DOM stays lean.
  if (
    badge === undefined &&
    letter === undefined &&
    color === undefined &&
    tooltip === undefined
  ) {
    return null;
  }

  const letterStyle: CSSProperties = color !== undefined
    ? { ...LETTER_STYLE, color }
    : LETTER_STYLE;
  const badgeStyle: CSSProperties = color !== undefined
    ? { ...BADGE_STYLE, color }
    : BADGE_STYLE;

  const accessibleLabel = decorationAccessibleLabel(decorations);

  return (
    <span
      className={className ? `mille-decorations ${className}` : 'mille-decorations'}
      data-mille-decorations=""
      style={WRAPPER_STYLE}
      {...(tooltip !== undefined ? { title: tooltip } : null)}
      {...(accessibleLabel !== undefined
        ? { 'aria-label': accessibleLabel, role: 'img' }
        : null)}
    >
      {letter !== undefined ? (
        <span
          className="mille-decoration-letter"
          data-mille-decoration-letter={letter}
          style={letterStyle}
          aria-hidden="true"
        >
          {letter}
        </span>
      ) : null}
      {badge !== undefined ? (
        <span
          className="mille-decoration-badge"
          data-mille-decoration-badge={badge}
          style={badgeStyle}
          aria-hidden="true"
        >
          {badge}
        </span>
      ) : null}
      {/* Visually hidden duplicate for AT that ignore aria-label on generic spans. */}
      {accessibleLabel !== undefined ? (
        <span
          className="mille-decoration-sr-only"
          style={{
            position: 'absolute',
            width: 1,
            height: 1,
            padding: 0,
            margin: -1,
            overflow: 'hidden',
            clip: 'rect(0, 0, 0, 0)',
            whiteSpace: 'nowrap',
            border: 0,
          }}
        >
          {accessibleLabel}
        </span>
      ) : null}
    </span>
  );
}

/**
 * `memo`-wrapped on props reference equality. The caller (the row, the
 * tree) guarantees a stable `decorations` reference across renders when
 * the underlying merged record hasn't changed.
 */
export const FileDecorations = memo(FileDecorationsImpl, (prev, next) => {
  return (
    prev.decorations === next.decorations &&
    prev.className === next.className
  );
});
FileDecorations.displayName = 'FileDecorations';
