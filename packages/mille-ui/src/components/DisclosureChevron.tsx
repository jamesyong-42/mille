// DisclosureChevron — the row's expand/collapse button.
//
// Inline 12x12 SVG; invisible but space-occupying when `hasChildren`
// is false (so the icon alignment doesn't shift across rows). The
// button has its own click handler and stops propagation so the row
// click (selection) doesn't also fire.

import {
  memo,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
} from 'react';

export interface DisclosureChevronProps {
  readonly expanded: boolean;
  readonly hasChildren: boolean;
  readonly onClick: (e: ReactMouseEvent<HTMLButtonElement>) => void;
  readonly className?: string;
}

const BUTTON_BASE_STYLE: CSSProperties = {
  all: 'unset',
  width: '12px',
  height: '12px',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flex: '0 0 auto',
  cursor: 'pointer',
  color: 'var(--mille-chevron-color, currentColor)',
};

const BUTTON_INVISIBLE_STYLE: CSSProperties = {
  ...BUTTON_BASE_STYLE,
  visibility: 'hidden',
  pointerEvents: 'none',
  cursor: 'default',
};

function DisclosureChevronImpl(props: DisclosureChevronProps): ReactElement {
  const { expanded, hasChildren, onClick, className } = props;

  const handleClick = (e: ReactMouseEvent<HTMLButtonElement>): void => {
    e.stopPropagation();
    onClick(e);
  };

  if (!hasChildren) {
    return (
      <span
        aria-hidden="true"
        data-mille-chevron="placeholder"
        style={BUTTON_INVISIBLE_STYLE}
        className={className}
      />
    );
  }

  // Rotate a 12×12 right-pointing chevron when expanded. `transform` via
  // inline style keeps the component style-sheet-free.
  const svgStyle: CSSProperties = {
    width: '12px',
    height: '12px',
    transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
    transition: 'transform 80ms ease-out',
  };

  return (
    <button
      type="button"
      tabIndex={-1}
      aria-hidden="true"
      data-mille-chevron={expanded ? 'expanded' : 'collapsed'}
      style={BUTTON_BASE_STYLE}
      className={className}
      onClick={handleClick}
    >
      <svg
        viewBox="0 0 12 12"
        style={svgStyle}
        xmlns="http://www.w3.org/2000/svg"
        focusable="false"
      >
        <path
          d="M4.5 2.5 L8 6 L4.5 9.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}

export const DisclosureChevron = memo(DisclosureChevronImpl);
DisclosureChevron.displayName = 'DisclosureChevron';
