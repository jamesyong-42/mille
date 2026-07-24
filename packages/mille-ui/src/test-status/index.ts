// Phase 5.1 — `@vibecook/mille-ui/test-status` barrel.

export type {
  TestResult,
  TestStatus,
  TestStatusClient,
  TestStatusCounts,
} from './types.js';
export {
  TEST_STATUS_RANK,
  ZERO_TEST_COUNTS,
  addTestCounts,
  countsFromResult,
  countsFromStatus,
  maxStatusFromCounts,
  maxTestStatus,
  totalTestCount,
} from './types.js';

export type {
  CreateMapTestStatusClientOptions,
  MapTestStatusClient,
} from './map-client.js';
export { createMapTestStatusClient } from './map-client.js';

export type {
  EngineDecorationProvider,
  FileExplorerLike,
  RegisterTestStatusDecorationsOptions,
  TestStatusDecorationsHandle,
} from './provider.js';
export {
  DEFAULT_TEST_STATUS_COLORS,
  MUTED_TEST_STATUS_COLORS,
  formatTestStatusBadge,
  formatTestStatusTooltip,
  registerTestStatusDecorations,
} from './provider.js';
