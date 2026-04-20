// FileTreeFilter — the filename-scoped filter input shipped alongside
// `<FileTree>`. Phase 8.
//
// Per MILLE_UI_SPEC.md §4.8:
//
//   - Renders `<input type="search">` with `role="searchbox"`.
//   - Optional "Filter | Search" mode toggle (buttons by default).
//   - Esc clears the filter.
//   - Controlled-aware via `value` + `onChange`; uncontrolled via
//     `defaultValue`.
//
// The input is **not** coupled to `<FileTree>` by layout — consumers
// place it wherever fits their host chrome. Phase 8 wires `Mod+F` to
// focus this input via a ref; see `FileTree.filterInputRef` prop.

import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useRef,
  type ChangeEvent as ReactChangeEvent,
  type CSSProperties,
  type ForwardedRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
} from 'react';
import { useFilterState } from '../hooks/useFilterState.js';

export type FileTreeFilterMode = 'filter' | 'search';

export interface FileTreeFilterProps {
  /** Current mode. Default `'filter'`. */
  readonly mode?: FileTreeFilterMode;
  /** Controlled value; leave unset for uncontrolled. */
  readonly value?: string;
  /** Initial value for uncontrolled mode. Ignored when `value` is set. */
  readonly defaultValue?: string;
  onChange?(next: string): void;
  onModeChange?(next: FileTreeFilterMode): void;
  readonly placeholder?: string;
  readonly autoFocus?: boolean;
  /** Show the inline Filter | Search segmented toggle. Default `true`. */
  readonly showModeToggle?: boolean;
  readonly className?: string;
  readonly style?: CSSProperties;
  /** Forwarded to the `<input>` as `aria-label`. Default 'Filter files'. */
  readonly ariaLabel?: string;
}

export interface FileTreeFilterHandle {
  focus(): void;
  select(): void;
  clear(): void;
}

const WRAPPER_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '4px',
  width: '100%',
  boxSizing: 'border-box',
};

const INPUT_STYLE: CSSProperties = {
  flex: '1 1 auto',
  minWidth: 0,
  height: '24px',
  padding: '0 6px',
  boxSizing: 'border-box',
  border: '1px solid var(--mille-filter-input-border, currentColor)',
  background: 'var(--mille-filter-input-bg, Canvas)',
  color: 'inherit',
  font: 'inherit',
  borderRadius: '2px',
  outline: 'none',
};

const TOGGLE_STYLE: CSSProperties = {
  display: 'inline-flex',
  gap: '0',
  border: '1px solid var(--mille-filter-toggle-border, currentColor)',
  borderRadius: '2px',
  overflow: 'hidden',
};

const TOGGLE_BUTTON_STYLE: CSSProperties = {
  padding: '0 6px',
  height: '24px',
  background: 'transparent',
  border: 'none',
  color: 'inherit',
  font: 'inherit',
  fontSize: '12px',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

const TOGGLE_BUTTON_ACTIVE_STYLE: CSSProperties = {
  ...TOGGLE_BUTTON_STYLE,
  background: 'var(--mille-filter-toggle-active-bg, color-mix(in oklch, currentColor 14%, transparent))',
  fontWeight: 600,
};

function FileTreeFilterImpl(
  props: FileTreeFilterProps,
  forwardedRef: ForwardedRef<FileTreeFilterHandle>,
): ReactElement {
  const {
    mode = 'filter',
    value,
    defaultValue,
    onChange,
    onModeChange,
    placeholder,
    autoFocus,
    showModeToggle = true,
    className,
    style,
    ariaLabel = 'Filter files',
  } = props;

  const filter = useFilterState(
    value !== undefined
      ? {
          controlled: {
            value,
            onChange: (next: string) => {
              if (onChange) onChange(next);
            },
          },
        }
      : {
          ...(defaultValue !== undefined ? { defaultValue } : {}),
        },
  );

  // If uncontrolled, we still want to forward changes to any caller
  // observer. The controlled branch above already does that; here we
  // bridge the uncontrolled path.
  const handleInputChange = useCallback(
    (e: ReactChangeEvent<HTMLInputElement>) => {
      const next = e.target.value;
      filter.setFilter(next);
      if (value === undefined && onChange) onChange(next);
    },
    [filter, onChange, value],
  );

  const inputRef = useRef<HTMLInputElement | null>(null);

  useImperativeHandle(
    forwardedRef,
    () => ({
      focus: () => {
        inputRef.current?.focus();
      },
      select: () => {
        inputRef.current?.select();
      },
      clear: () => {
        filter.clear();
        if (value === undefined && onChange) onChange('');
      },
    }),
    [filter, onChange, value],
  );

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        filter.clear();
        if (value === undefined && onChange) onChange('');
        return;
      }
      // Stop tree keyboard handlers from receiving these while focus is
      // in the input — typeahead and arrow nav in particular would fight
      // the caret.
      e.stopPropagation();
    },
    [filter, onChange, value],
  );

  const setMode = useCallback(
    (next: FileTreeFilterMode) => {
      if (next === mode) return;
      if (onModeChange) onModeChange(next);
    },
    [mode, onModeChange],
  );

  const wrapperClass = className
    ? `mille-filter ${className}`
    : 'mille-filter';

  const resolvedPlaceholder =
    placeholder ?? (mode === 'search' ? 'Search files...' : 'Filter visible...');

  return (
    <div
      className={wrapperClass}
      data-mille-filter=""
      data-mille-filter-mode={mode}
      style={style ? { ...WRAPPER_STYLE, ...style } : WRAPPER_STYLE}
    >
      <input
        ref={inputRef}
        type="search"
        role="searchbox"
        className="mille-filter-input"
        data-mille-filter-input=""
        value={filter.filter}
        onChange={handleInputChange}
        onKeyDown={onKeyDown}
        placeholder={resolvedPlaceholder}
        aria-label={ariaLabel}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        {...(autoFocus ? { autoFocus: true } : null)}
        style={INPUT_STYLE}
      />
      {showModeToggle ? (
        <div
          className="mille-filter-toggle"
          data-mille-filter-toggle=""
          role="group"
          aria-label="Filter mode"
          style={TOGGLE_STYLE}
        >
          <button
            type="button"
            data-mille-filter-mode-btn="filter"
            data-mille-filter-mode-active={mode === 'filter' ? 'true' : undefined}
            aria-pressed={mode === 'filter'}
            onClick={() => setMode('filter')}
            style={mode === 'filter' ? TOGGLE_BUTTON_ACTIVE_STYLE : TOGGLE_BUTTON_STYLE}
          >
            Filter
          </button>
          <button
            type="button"
            data-mille-filter-mode-btn="search"
            data-mille-filter-mode-active={mode === 'search' ? 'true' : undefined}
            aria-pressed={mode === 'search'}
            onClick={() => setMode('search')}
            style={mode === 'search' ? TOGGLE_BUTTON_ACTIVE_STYLE : TOGGLE_BUTTON_STYLE}
          >
            Search
          </button>
        </div>
      ) : null}
    </div>
  );
}

export const FileTreeFilter = forwardRef<FileTreeFilterHandle, FileTreeFilterProps>(
  FileTreeFilterImpl,
);
FileTreeFilter.displayName = 'FileTreeFilter';
