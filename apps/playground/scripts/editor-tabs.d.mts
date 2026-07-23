import type { FileOpenMode } from '@vibecook/mille-ui';

export interface EditorTab {
  readonly id: string;
  readonly title: string;
  readonly kind: 'file' | 'welcome';
  readonly entryId?: number;
  readonly body: string;
  readonly highlighted: boolean;
  readonly preview: boolean;
}

export interface EditorEntry {
  readonly id: number;
  readonly name: string;
}

export interface EditorTabOpenPlan {
  readonly tabs: readonly EditorTab[];
  readonly activeTabId: string;
  readonly shouldLoad: boolean;
}

export function planEditorTabOpen(
  tabs: readonly EditorTab[],
  entry: EditorEntry,
  mode: FileOpenMode,
): EditorTabOpenPlan;

export function settleEditorTabLoad(
  tabs: readonly EditorTab[],
  tabId: string,
  body: string,
  highlighted: boolean,
  requestRevision: number,
  currentRevision: number | undefined,
): readonly EditorTab[];
