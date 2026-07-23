export type FileOpenMode = 'preview' | 'permanent';

export type FileOpenSource =
  | 'singleClick'
  | 'doubleClick'
  | 'keyboard'
  | 'search'
  | 'command';

export interface FileOpenEvent {
  readonly mode: FileOpenMode;
  readonly source: FileOpenSource;
}

export interface FileOpenBehavior {
  /** Single-click files only select by default; opt into preview opening. */
  readonly singleClick?: 'select' | 'preview';
  /** Double-click permanently opens by default. */
  readonly doubleClick?: FileOpenMode;
}

export const PERMANENT_KEYBOARD_OPEN: FileOpenEvent = Object.freeze({
  mode: 'permanent',
  source: 'keyboard',
});

export const PERMANENT_SEARCH_OPEN: FileOpenEvent = Object.freeze({
  mode: 'permanent',
  source: 'search',
});

export function commandOpenEvent(args: unknown): FileOpenEvent {
  const record =
    typeof args === 'object' && args !== null
      ? (args as { mode?: unknown; source?: unknown })
      : {};
  const mode =
    record.mode === 'preview' || record.mode === 'permanent'
      ? record.mode
      : 'permanent';
  const source: FileOpenSource =
    record.source === 'singleClick' ||
    record.source === 'doubleClick' ||
    record.source === 'keyboard' ||
    record.source === 'search' ||
    record.source === 'command'
      ? record.source
      : 'command';
  return Object.freeze({ mode, source });
}
