// Phase 6.1 — `@vibecook/mille/provider` barrel.

export type {
  CapabilityBit,
  Disposable,
  EntryKind,
  EventListener,
  FileSystemEvent,
  FileSystemEventType,
  FileSystemProvider,
  ProviderEntry,
  ProviderOperation,
  UnsupportedOperationInfo,
  Uri,
  WatchOptions,
  Watcher,
} from './types.js';
export { Capability, EntryKind as ProviderEntryKind } from './types.js';

export {
  capabilityBitsAllow,
  capabilityLabels,
  describeUnsupported,
  hasAnyCapability,
  hasCapability,
  isCaseSensitiveProvider,
  isReadonlyProvider,
  providerHasMethod,
  providerSupports,
  providerSupportsOperation,
  requireCapability,
} from './capabilities.js';

export {
  createProviderRegistry,
  type ProviderRegistration,
  type ProviderRegistry,
} from './registry.js';

export {
  createMemoryFileSystemProvider,
  isPathUnder,
  type MemoryFileSystemOptions,
} from './memfs.js';

export {
  hardenProvider,
  withCapabilityGate,
  withLatency,
  withOfflineGate,
  type LatencyOptions,
  type OfflineController,
} from './wrap.js';

export {
  createProviderTreeSession,
  providerRowsToVisibleRows,
  type ProviderTreeFlatRow,
  type ProviderTreeNode,
  type ProviderTreeSession,
  type ProviderTreeSessionOptions,
  type ProviderTreeSnapshot,
} from './tree.js';

export {
  basenameUriPath,
  createUri,
  dirnameUriPath,
  formatUri,
  joinUriPath,
  normalizeUriPath,
  uriEquals,
} from './uri.js';

export {
  defaultCaseSensitive,
  isUncPath,
  isWindowsDrivePath,
  normalizeFileName,
  parsePlatformPath,
  pathsEqual,
  segmentsEscapeRoot,
  type ParsedPlatformPath,
  type PathPlatform,
} from './path-platform.js';
