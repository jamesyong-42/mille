// Phase 5.1 — `@vibecook/mille-ui/diagnostics` barrel.
//
// Public surface of the diagnostics decoration companion. Hosts supply a
// `DiagnosticsClient` (LSP, ESLint, TypeScript language service, …);
// this package stays dep-free of any language-server stack.

export type {
  Diagnostic,
  DiagnosticCounts,
  DiagnosticSeverity,
  DiagnosticsClient,
} from './types.js';
export {
  DIAGNOSTIC_SEVERITY_RANK,
  ZERO_COUNTS,
  addCounts,
  countDiagnostics,
  maxSeverityFromCounts,
  totalDiagnosticCount,
} from './types.js';

export type {
  DiagnosticsDecorationsHandle,
  EngineDecorationProvider,
  FileExplorerLike,
  RegisterDiagnosticsDecorationsOptions,
} from './provider.js';
export {
  DEFAULT_DIAGNOSTIC_COLORS,
  MUTED_DIAGNOSTIC_COLORS,
  decorationEquals,
  formatDiagnosticBadge,
  formatDiagnosticTooltip,
  isSafeWorkspaceRelativePath,
  mapPool,
  registerDiagnosticsDecorations,
} from './provider.js';

export type {
  CreateMapDiagnosticsClientOptions,
  MapDiagnosticsClient,
} from './map-client.js';
export { createMapDiagnosticsClient } from './map-client.js';
