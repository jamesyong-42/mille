// Phase 5.1 — `@vibecook/mille-ui/editor-state` barrel.

export type {
  EditorPathFlags,
  EditorStateClient,
  EditorStateSnapshot,
  EditorTabState,
} from './types.js';
export {
  editorPathFromIdentity,
  editorTabIdentityKey,
  normalizeEditorState,
} from './types.js';

export type {
  CreateMapEditorStateClientOptions,
  MapEditorStateClient,
} from './map-client.js';
export { createMapEditorStateClient } from './map-client.js';

export type {
  EditorStateDecorationsHandle,
  EngineDecorationProvider,
  FileExplorerLike,
  RegisterEditorStateDecorationsOptions,
} from './provider.js';
export {
  DEFAULT_EDITOR_STATE_COLORS,
  formatEditorStateBadge,
  formatEditorStateTooltip,
  registerEditorStateDecorations,
} from './provider.js';
