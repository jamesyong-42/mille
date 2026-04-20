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

  return (
    <span
      className={className ? `mille-decorations ${className}` : 'mille-decorations'}
      data-mille-decorations=""
      style={WRAPPER_STYLE}
      {...(tooltip !== undefined ? { title: tooltip } : null)}
    >
      {letter !== undefined ? (
        <span
          className="mille-decoration-letter"
          data-mille-decoration-letter={letter}
          style={letterStyle}
        >
          {letter}
        </span>
      ) : null}
      {badge !== undefined ? (
        <span
          className="mille-decoration-badge"
          data-mille-decoration-badge={badge}
          style={badgeStyle}
        >
          {badge}
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
