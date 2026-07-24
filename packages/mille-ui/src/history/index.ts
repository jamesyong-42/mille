// Phase 5.3 — `@vibecook/mille-ui/history` barrel.

export type {
  FileHistoryClient,
  FileHistoryQuery,
  FileHistoryRevision,
  ScmActionHooks,
  ScmClient,
  ScmCompareRequest,
  ScmCompareResult,
  ScmCompareSide,
  ScmProgressEvent,
  ScmProgressPhase,
} from './types.js';
export { ScmActionError } from './types.js';

export {
  runFileHistory,
  runScmCompare,
  runScmRevert,
  type RunScmActionOptions,
} from './actions.js';

export type { MapFileHistoryClient, MapScmClient } from './map-client.js';
export {
  createMapFileHistoryClient,
  createMapScmClient,
} from './map-client.js';

export type { ScmHostHooks } from './commands.js';
export { scmHistoryCommands } from './commands.js';
