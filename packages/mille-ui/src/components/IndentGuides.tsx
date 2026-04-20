// IndentGuides — vertical guide lines at each ancestor depth level.
//
// Pure presentational component. Renders `depth` <span> elements, each
// `var(--mille-indent-size)` wide with a left border using
// `var(--mille-indent-guide)`. The row's own padding-inline-start
// places the icon / name past the guides.

import { memo, type CSSProperties, type ReactElement } from 'react';

export interface IndentGuidesProps {
  readonly depth: number;
  readonly indentSize?: number | string;
  readonly className?: string;
}

const WRAPPER_STYLE: CSSProperties = {
  position: 'absolute',
  top: 0,
  bottom: 0,
  left: 0,
  display: 'flex',
  pointerEvents: 'none',
};

function IndentGuidesImpl(props: IndentGuidesProps): ReactElement | null {
  const { depth, indentSize, className } = props;
  if (depth <= 0) return null;

  const widthExpr =
    typeof indentSize === 'number'
      ? `${indentSize}px`
      : indentSize ?? 'var(--mille-indent-size, 8px)';

  const guides: ReactElement[] = [];
  for (let i = 0; i < depth; i += 1) {
    const guideStyle: CSSProperties = {
      display: 'inline-block',
      width: widthExpr,
      borderInlineStart:
        '1px solid var(--mille-indent-guide, color-mix(in oklch, currentColor 10%, transparent))',
      boxSizing: 'border-box',
    };
    guides.push(
      <span
        key={i}
        data-mille-indent-guide=""
        aria-hidden="true"
        style={guideStyle}
      />,
    );
  }
  return (
    <span className={className} data-mille-indent-guides="" style={WRAPPER_STYLE}>
      {guides}
    </span>
  );
}

export const IndentGuides = memo(IndentGuidesImpl);
IndentGuides.displayName = 'IndentGuides';
