// Transport and service-open failures (SPEC §19.1).
//
// Filesystem failures keep using mille's `FileSystemError` / `ErrorCode`.
// This class is for the layer beneath that: the connection did not open, or
// stopped existing. Keeping them separate matters because callers handle
// them differently — an `ENOENT` is about a file, an `OFFLINE` is about the
// whole workspace.

export type RemoteExplorerErrorCode =
  | 'OFFLINE'
  | 'ACCESS_DENIED'
  | 'PROTOCOL_MISMATCH'
  | 'INVALID_RESPONSE'
  | 'TIMEOUT'
  | 'BACKPRESSURE'
  | 'LIMIT_EXCEEDED'
  | 'SERVER_SHUTTING_DOWN'
  | 'TRANSPORT_ERROR';

export class RemoteExplorerError extends Error {
  override readonly name = 'RemoteExplorerError';
  readonly code: RemoteExplorerErrorCode;

  constructor(code: RemoteExplorerErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
  }
}

export function isRemoteExplorerError(value: unknown): value is RemoteExplorerError {
  return value instanceof RemoteExplorerError;
}
