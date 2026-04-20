// FileTreeDragIndicator — a thin 2 px line rendered at the top or
// bottom edge of a row to show where a drop "above" / "below" will
// land. Phase 11 uses CSS pseudo-elements on the row itself (see
// `theme/focus.css`), but exposes this React component for consumers
// who want to render a portal-hosted overlay or replace the default
// visuals with their own. The default `<FileTreeRow>` does not mount
// this; the data attrs drive the CSS fallback.

import type { CSSProperties, ReactElement } from 'react';
import type { DropPosition } from '../hooks/useFileTreeDragDrop.js';

export interface FileTreeDragIndicatorProps {
  readonly position: DropPosition;
  readonly className?: string;
  readonly style?: CSSProperties;
}

const BASE_STYLE: CSSProperties = {
  position: 'absolute',
  left: 0,
  right: 0,
  height: '2px',
  pointerEvents: 'none',
  background: 'var(--mille-accent-bg, #0969da)',
};

/**
 * Render a 2 px indicator line at the top or bottom of the positioned
 * parent (typically the row element). `position === 'self'` renders an
 * outline; the default CSS handles this case too, so the component is
 * mostly useful for consumers rolling their own row renderer.
 */
export function FileTreeDragIndicator(
  props: FileTreeDragIndicatorProps,
): ReactElement | null {
  const { position, className, style } = props;

  if (position === 'self') {
    const selfStyle: CSSProperties = {
      position: 'absolute',
      inset: 0,
      pointerEvents: 'none',
      outline: '1px dashed var(--mille-accent-bg, #0969da)',
      outlineOffset: '-1px',
      ...style,
    };
    return (
      <div
        data-mille-drag-indicator="self"
        className={className}
        style={selfStyle}
      />
    );
  }

  const edgeStyle: CSSProperties = {
    ...BASE_STYLE,
    ...(position === 'above' ? { top: 0 } : { bottom: 0 }),
    ...style,
  };

  return (
    <div
      data-mille-drag-indicator={position}
      className={className}
      style={edgeStyle}
    />
  );
}
FileTreeDragIndicator.displayName = 'FileTreeDragIndicator';
