// @vibecook/mille-truffle — serve a mille workspace over a tailnet.
//
// The server half (PR 4). `connectMille` and the reconnect facade land in
// PR 5; nothing here assumes they exist.
//
// Node-only: it builds framed stream channels over `mesh.net` sockets.

export { serveMille } from './server.js';
export type { MeshLike, MeshNetLike, MeshServerLike, TruffleSocketLike } from './server.js';

export { RemoteExplorerError, isRemoteExplorerError } from './errors.js';
export type { RemoteExplorerErrorCode } from './errors.js';

export { ExportConfigError, resolveExport, resolveExports } from './exports.js';

export { authorizePeer, sessionPolicyFor } from './authorize.js';
export type { AuthorizeInput, AuthorizeOutcome } from './authorize.js';

export {
  REMOTE_SERVICE,
  REMOTE_SERVICE_VERSION,
  isRemoteServiceMessage,
  parseOpenRequest,
} from './handshake.js';
export type {
  OpenWorkspaceAccepted,
  OpenWorkspaceLimits,
  OpenWorkspaceRejectCode,
  OpenWorkspaceRejected,
  OpenWorkspaceRequest,
  RemoteAccess,
  RemotePing,
  RemotePong,
  RemoteServiceMessage,
} from './handshake.js';

export type {
  AuthorizeMillePeerContext,
  MilleExportConfig,
  MilleRemoteLogger,
  MilleRemoteServer,
  RemoteSessionInfo,
  ResolvedExport,
  ServeMilleOptions,
} from './types.js';
