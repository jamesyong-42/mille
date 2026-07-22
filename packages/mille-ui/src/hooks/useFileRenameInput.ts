// useFileRenameInput — logic hook behind `<FileRenameInput>`.
//
// Phase B8 of V0_2_PLAN.md. The styled `<FileRenameInput>` previously
// carried ARIA, Enter/Esc handling, blur-commit semantics, local
// validation, external-error suppression, and ext-aware initial
// selection inside one ~300-line component. This hook isolates all
// that logic so the `/headless` entry can expose it without bundling
// the input / tooltip JSX.
//
// Contract (ported from MILLE_UI_SPEC.md §4.7 + §6.5):
//   - Auto-focus on mount.
//   - Initial selection: files with a `.` select [0, lastDot];
//     no-ext files + directories select the whole string.
//   - Enter → `onCommit(trimmed)` (blocked if validator rejects).
//   - Escape → `onCancel()`.
//   - Blur → `commit` if value changed, else `cancel` (VS Code match).
//   - `validator` runs on every keystroke; non-null output shows a
//     tooltip and blocks commit.
//   - `errorTooltip` (engine-side error) shows until the user types.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent as ReactChangeEvent,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type RefCallback,
} from 'react';

export interface UseFileRenameInputOptions {
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
  readonly errorTooltip?: string | null;
  /** Changes for repeated engine failures whose message text is identical. */
  readonly errorRevision?: number;
  /**
   * Whether losing focus (blur) triggers a commit when the value
   * changed, or always cancels. Default `true` — matches VS Code.
   */
  readonly commitOnBlur?: boolean;
}

/**
 * Prop bundle for the `<input>` element. Spread onto any controlled
 * input-like component.
 */
export interface UseFileRenameInputInputProps {
  readonly ref: RefCallback<HTMLInputElement>;
  readonly type: 'text';
  readonly value: string;
  readonly onChange: (e: ReactChangeEvent<HTMLInputElement>) => void;
  readonly onKeyDown: (e: ReactKeyboardEvent<HTMLInputElement>) => void;
  readonly onBlur: (e: ReactFocusEvent<HTMLInputElement>) => void;
  readonly onClick: (e: ReactMouseEvent<HTMLInputElement>) => void;
  readonly onMouseDown: (e: ReactMouseEvent<HTMLInputElement>) => void;
  readonly 'aria-label': 'File name';
  readonly 'aria-invalid'?: true;
  readonly spellCheck: false;
  readonly autoCapitalize: 'off';
  readonly autoCorrect: 'off';
  readonly autoComplete: 'off';
}

/**
 * Prop bundle for the tooltip node. `null` when no tooltip should
 * render. When non-null, contains the `role`, class/data attrs, and
 * the text to display.
 */
export interface UseFileRenameInputTooltipProps {
  readonly role: 'tooltip';
  readonly 'data-mille-rename-tooltip': '';
  readonly children: string;
}

export interface UseFileRenameInputResult {
  readonly inputProps: UseFileRenameInputInputProps;
  readonly tooltipProps: UseFileRenameInputTooltipProps | null;
  /** `true` while a validator or external error is on screen. */
  readonly isInvalid: boolean;
  /** Imperative commit — use when wiring from an external button. */
  readonly commit: () => void;
  /** Imperative cancel — same deal. */
  readonly cancel: () => void;
}

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
  const lastDot = name.lastIndexOf('.');
  if (lastDot <= 0) {
    return { start: 0, end: name.length };
  }
  return { start: 0, end: lastDot };
}

export function useFileRenameInput(
  options: UseFileRenameInputOptions,
): UseFileRenameInputResult {
  const {
    initialName,
    kind,
    onCommit,
    onCancel,
    validator,
    errorTooltip = null,
    errorRevision = 0,
    commitOnBlur = true,
  } = options;

  const inputRef = useRef<HTMLInputElement | null>(null);
  const [value, setValue] = useState<string>(initialName);
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
  let tooltipText: string | null = null;
  if (localError !== null) {
    tooltipText = localError;
  } else if (
    !externalErrorSuppressed &&
    typeof errorTooltip === 'string' &&
    errorTooltip.length > 0
  ) {
    tooltipText = errorTooltip;
  }

  // Reset the "suppressed" flag when a brand-new external error arrives.
  const prevExternalRef = useRef({
    text: errorTooltip ?? null,
    revision: errorRevision,
  });
  useEffect(() => {
    const prev = prevExternalRef.current;
    const next = { text: errorTooltip ?? null, revision: errorRevision };
    if (next.text !== prev.text || next.revision !== prev.revision) {
      prevExternalRef.current = next;
      setExternalErrorSuppressed(false);
      // The async attempt has settled; allow retrying the same draft.
      committedRef.current = false;
    }
  }, [errorTooltip, errorRevision]);

  const onChange = useCallback((e: ReactChangeEvent<HTMLInputElement>) => {
    setValue(e.target.value);
    setExternalErrorSuppressed(true);
    committedRef.current = false;
  }, []);

  const doCommit = useCallback(
    (trimmed: string) => {
      if (committedRef.current) return;
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

  const inputProps: UseFileRenameInputInputProps = {
    ref: (el) => {
      inputRef.current = el;
    },
    type: 'text',
    value,
    onChange,
    onKeyDown,
    onBlur,
    onClick,
    onMouseDown,
    'aria-label': 'File name',
    ...(tooltipText !== null ? { 'aria-invalid': true as const } : null),
    spellCheck: false,
    autoCapitalize: 'off',
    autoCorrect: 'off',
    autoComplete: 'off',
  };

  const tooltipProps: UseFileRenameInputTooltipProps | null =
    tooltipText !== null
      ? {
          role: 'tooltip',
          'data-mille-rename-tooltip': '',
          children: tooltipText,
        }
      : null;

  const commit = useCallback(() => {
    doCommit(value.trim());
  }, [doCommit, value]);

  return {
    inputProps,
    tooltipProps,
    isInvalid: tooltipText !== null,
    commit,
    cancel: doCancel,
  };
}
