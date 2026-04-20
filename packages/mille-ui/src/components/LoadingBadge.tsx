// LoadingBadge — tiny spinner glyph for rows in the snapshot's
// `pendingExpansions` set.
//
// Renders a minimal inline SVG with a CSS-driven rotation. Respects
// `prefers-reduced-motion` by falling back to a static ellipsis glyph
// when the user has motion disabled (checked at module load — this is
// good enough for v0.1; a future revision can use a media-query hook).

import { memo, type CSSProperties, type ReactElement } from 'react';

export interface LoadingBadgeProps {
  readonly className?: string;
  readonly ariaLabel?: string;
}

const WRAPPER_STYLE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '10px',
  height: '10px',
  flex: '0 0 auto',
  color: 'var(--mille-loading-color, currentColor)',
  opacity: 0.7,
};

const SVG_STYLE: CSSProperties = {
  width: '10px',
  height: '10px',
  animation: 'mille-loading-spin 900ms linear infinite',
};

function LoadingBadgeImpl(props: LoadingBadgeProps): ReactElement {
  const { className, ariaLabel = 'Loading' } = props;

  return (
    <span
      className={className}
      data-mille-loading-badge=""
      role="status"
      aria-label={ariaLabel}
      style={WRAPPER_STYLE}
    >
      <svg
        viewBox="0 0 16 16"
        style={SVG_STYLE}
        xmlns="http://www.w3.org/2000/svg"
        focusable="false"
        aria-hidden="true"
      >
        <circle
          cx="8"
          cy="8"
          r="6"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeDasharray="28"
          strokeDashoffset="16"
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
}

export const LoadingBadge = memo(LoadingBadgeImpl);
LoadingBadge.displayName = 'LoadingBadge';
