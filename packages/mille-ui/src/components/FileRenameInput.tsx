// FileRenameInput — inline rename input that replaces the row's name
// span during a rename.
//
// Phase-5. Matches MILLE_UI_SPEC.md §4.7 + §6.5:
//
//   - Auto-focuses on mount.
//   - Initial selection: for files with a `.`, select only the name
//     portion before the last dot (extension pre-selected for easy
//     replace if the user types). For no-ext files or folders, select
//     the whole name.
//   - Enter → `onCommit(trimmed)`.
//   - Escape → `onCancel()`.
//   - Blur → commit if value differs, cancel otherwise (matches
//     VS Code). Configurable via `commitOnBlur` (default `true`).
//   - When `validator` returns non-null on change, show the error
//     string as a tooltip and block commit.
//   - When `errorTooltip` is set (engine-side error), show it until
//     the user types again (which re-runs `validator`).
//
// Styling: `.mille-rename-input` and `.mille-rename-tooltip` classes
// plus inline layout basics. Full look comes from `tokens.css`.

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ChangeEvent as ReactChangeEvent,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
} from 'react';

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

/**
 * Compute the initial selection range:
 *   - For files with an extension (a `.` that's not at index 0), select
 *     just the name portion [0, lastDotIndex].
 *   - Otherwise, select the whole string.
 */
function computeInitialSelection(
  name: string,
  kind: 'file' | 'directory',
): { readonly start: number; readonly end: number } {
  if (kind === 'directory') {
    return { start: 0, end: name.length };
  }
  // Files: find the last dot, ignoring leading dots (dotfiles).
  const lastDot = name.lastIndexOf('.');
  if (lastDot <= 0) {
    return { start: 0, end: name.length };
  }
  return { start: 0, end: lastDot };
}

function FileRenameInputImpl(props: FileRenameInputProps): ReactElement {
  const {
    initialName,
    kind,
    onCommit,
    onCancel,
    validator,
    errorTooltip = null,
    commitOnBlur = true,
    className,
    style,
  } = props;

  const inputRef = useRef<HTMLInputElement | null>(null);
  const [value, setValue] = useState<string>(initialName);

  // When the user starts typing, suppress the externally-supplied error
  // tooltip so the new keystrokes aren't drowned out by a stale message.
  const [externalErrorSuppressed, setExternalErrorSuppressed] = useState(false);

  // Blur-guarding: when Enter or Esc fires, we may programmatically
  // blur the input (or React remounts us). Guard against double-firing
  // onCommit / onCancel from the blur handler.
  const committedRef = useRef(false);

  // Auto-focus + initial selection on mount. `useLayoutEffect` so the
  // focus ring renders before the browser paints.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    const { start, end } = computeInitialSelection(initialName, kind);
    try {
      el.setSelectionRange(start, end);
    } catch {
      /* some browsers / happy-dom may reject on type=text idempotently;
         selection is cosmetic, never critical. */
    }
    // Only run once for the initial mount — subsequent renames re-mount
    // the component fresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const localError = useMemo<string | null>(() => {
    if (validator) return validator(value);
    return null;
  }, [validator, value]);

  // Precedence: local validator error > external engine error (once the
  // user has typed, external is suppressed).
  const tooltipText: string | null = (() => {
    if (localError !== null) return localError;
    if (!externalErrorSuppressed && typeof errorTooltip === 'string' && errorTooltip.length > 0) {
      return errorTooltip;
    }
    return null;
  })();

  // Reset the "suppressed" flag when a brand-new external error arrives.
  const prevExternalRef = useRef<string | null>(errorTooltip ?? null);
  useEffect(() => {
    const prev = prevExternalRef.current;
    const next = errorTooltip ?? null;
    if (next !== prev) {
      prevExternalRef.current = next;
      setExternalErrorSuppressed(false);
    }
  }, [errorTooltip]);

  const onChange = useCallback(
    (e: ReactChangeEvent<HTMLInputElement>) => {
      setValue(e.target.value);
      setExternalErrorSuppressed(true);
    },
    [],
  );

  const doCommit = useCallback(
    (trimmed: string) => {
      if (committedRef.current) return;
      // Local validator has final say — if it rejects, don't commit.
      if (validator && validator(trimmed) !== null) {
        return;
      }
      committedRef.current = true;
      onCommit(trimmed);
    },
    [onCommit, validator],
  );

  const doCancel = useCallback(() => {
    if (committedRef.current) return;
    committedRef.current = true;
    onCancel();
  }, [onCancel]);

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        doCommit(value.trim());
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        doCancel();
        return;
      }
      // Prevent bubbling: the tree's onKeyDown handler would otherwise
      // pick up ArrowDown/ArrowUp/Home/End/etc. while the input is
      // focused. The input has its own caret movement semantics.
      e.stopPropagation();
    },
    [doCommit, doCancel, value],
  );

  const onBlur = useCallback(
    (_e: ReactFocusEvent<HTMLInputElement>) => {
      if (committedRef.current) return;
      if (!commitOnBlur) {
        doCancel();
        return;
      }
      const trimmed = value.trim();
      if (trimmed === initialName || trimmed.length === 0) {
        doCancel();
      } else {
        doCommit(trimmed);
      }
    },
    [commitOnBlur, doCancel, doCommit, value, initialName],
  );

  // Swallow click events on the input so they don't toggle selection
  // on the underlying row.
  const onClick = useCallback((e: ReactMouseEvent<HTMLInputElement>) => {
    e.stopPropagation();
  }, []);

  const onMouseDown = useCallback((e: ReactMouseEvent<HTMLInputElement>) => {
    e.stopPropagation();
  }, []);

  const wrapperClass = className
    ? `mille-rename-input-wrapper ${className}`
    : 'mille-rename-input-wrapper';

  return (
    <span
      className={wrapperClass}
      data-mille-rename-wrapper=""
      style={style ? { ...WRAPPER_STYLE, ...style } : WRAPPER_STYLE}
    >
      <input
        ref={inputRef}
        type="text"
        className="mille-rename-input"
        data-mille-rename-input=""
        value={value}
        onChange={onChange}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
        onClick={onClick}
        onMouseDown={onMouseDown}
        aria-label="File name"
        aria-invalid={tooltipText !== null ? true : undefined}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        style={INPUT_STYLE}
      />
      {tooltipText !== null ? (
        <span
          role="tooltip"
          className="mille-rename-tooltip"
          data-mille-rename-tooltip=""
          style={TOOLTIP_STYLE}
        >
          {tooltipText}
        </span>
      ) : null}
    </span>
  );
}

export const FileRenameInput = memo(FileRenameInputImpl);
FileRenameInput.displayName = 'FileRenameInput';
