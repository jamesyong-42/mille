// FileRenameInput — inline rename input that replaces the row's name
// span during a rename.
//
// Phase B8 (v0.2): thin view on top of `useFileRenameInput`. All ARIA +
// keyboard + blur-commit + validator + ext-aware selection logic lives
// in the hook; this component owns nothing but the wrapper / input /
// tooltip JSX and the load-bearing inline styles.
//
// Styling: `.mille-rename-input` and `.mille-rename-tooltip` classes
// plus inline layout basics. Full look comes from `tokens.css`.

import { memo, type CSSProperties, type ReactElement } from 'react';
import { useFileRenameInput } from '../hooks/useFileRenameInput.js';

export interface FileRenameInputProps {
  readonly initialName: string;
  readonly kind: 'file' | 'directory';
  onCommit(newName: string): void;
  onCancel(): void;
  /**
   * Local validator; returns a human-readable error message string, or
   * `null` on success. Runs on every keystroke. When non-null, Enter
   * does not commit; the message renders as a tooltip.
   */
  validator?(newName: string): string | null;
  /**
   * External (engine-supplied) error tooltip. Typically the `.message`
   * of a `FileSystemError` returned by `fx.rename`. Shown until the
   * user types (which clears the external error and falls back to the
   * local validator's output, if any).
   */
  errorTooltip?: string | null;
  /** Internal revision for retrying repeated engine errors. */
  readonly errorRevision?: number;
  /**
   * Whether losing focus (blur) triggers a commit when the value
   * changed, or always cancels. Default `true` — matches VS Code.
   */
  readonly commitOnBlur?: boolean;
  readonly className?: string;
  readonly style?: CSSProperties;
}

const INPUT_STYLE: CSSProperties = {
  flex: '1 1 auto',
  minWidth: 0,
  height: '100%',
  boxSizing: 'border-box',
  padding: '0 4px',
  margin: 0,
  border: '1px solid var(--mille-rename-input-ring, currentColor)',
  background: 'var(--mille-rename-input-bg, Canvas)',
  color: 'inherit',
  font: 'inherit',
  outline: 'none',
  // Caret renders on top of surrounding transforms cleanly.
  position: 'relative',
  zIndex: 1,
};

const WRAPPER_STYLE: CSSProperties = {
  position: 'relative',
  flex: '1 1 auto',
  minWidth: 0,
  display: 'flex',
  alignItems: 'center',
};

const TOOLTIP_STYLE: CSSProperties = {
  position: 'absolute',
  top: '100%',
  insetInlineStart: 0,
  marginTop: '2px',
  padding: '2px 6px',
  background: 'var(--mille-rename-tooltip-bg, #5a1d1d)',
  color: 'var(--mille-rename-tooltip-fg, #ffffff)',
  font: 'inherit',
  fontSize: '12px',
  borderRadius: '2px',
  pointerEvents: 'none',
  whiteSpace: 'nowrap',
  zIndex: 2,
};

function FileRenameInputImpl(props: FileRenameInputProps): ReactElement {
  const { inputProps, tooltipProps } = useFileRenameInput({
    initialName: props.initialName,
    kind: props.kind,
    onCommit: props.onCommit,
    onCancel: props.onCancel,
    ...(props.validator ? { validator: props.validator } : null),
    ...(props.errorTooltip !== undefined
      ? { errorTooltip: props.errorTooltip }
      : null),
    ...(props.errorRevision !== undefined
      ? { errorRevision: props.errorRevision }
      : null),
    ...(props.commitOnBlur !== undefined
      ? { commitOnBlur: props.commitOnBlur }
      : null),
  });

  const wrapperClass = props.className
    ? `mille-rename-input-wrapper ${props.className}`
    : 'mille-rename-input-wrapper';

  return (
    <span
      className={wrapperClass}
      data-mille-rename-wrapper=""
      style={props.style ? { ...WRAPPER_STYLE, ...props.style } : WRAPPER_STYLE}
    >
      <input
        {...inputProps}
        className="mille-rename-input"
        data-mille-rename-input=""
        style={INPUT_STYLE}
      />
      {tooltipProps !== null ? (
        <span
          {...tooltipProps}
          className="mille-rename-tooltip"
          style={TOOLTIP_STYLE}
        />
      ) : null}
    </span>
  );
}

export const FileRenameInput = memo(FileRenameInputImpl);
FileRenameInput.displayName = 'FileRenameInput';
