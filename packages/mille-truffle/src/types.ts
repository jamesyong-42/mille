// Public option and information types (SPEC §14.1).

import type { ExplorerOptions } from '@vibecook/mille';
import type { RemoteAccess } from './handshake.js';

export type { RemoteAccess };

export interface MilleExportConfig {
  /** Human-readable name; shown to clients on accept. */
  readonly label: string;
  /** Absolute local paths. Canonicalized once at startup. */
  readonly roots: readonly string[];
  readonly access: RemoteAccess;
  /** Phase 1 remote exports require false (SPEC SEC-003). */
  readonly followSymlinks?: false;
  readonly explorer?: Omit<ExplorerOptions, 'roots' | 'followSymlinks'>;
  /**
   * Tailscale stable node ids permitted to open this export.
   *
   * These are the ids an *inbound* socket reports, which is not the same
   * namespace as the device id seen on an outbound connection — see the
   * plan's identity note. Omit to allow any peer the `authorize` callback
   * accepts.
   */
  readonly allowedPeerIds?: readonly string[];
  /** Per-request file payload cap. Default 16 MiB. */
  readonly maxFileBytes?: number;
  /** Concurrent sessions for this export. Default 16. */
  readonly maxSessions?: number;
}

/** An export after validation and canonicalization. */
export interface ResolvedExport {
  readonly id: string;
  readonly label: string;
  readonly access: RemoteAccess;
  readonly roots: readonly string[];
  readonly explorer: Omit<ExplorerOptions, 'roots' | 'followSymlinks'>;
  readonly allowedPeerIds?: readonly string[];
  readonly maxFileBytes: number;
  readonly maxSessions: number;
  /** Host-cache key material; see `fingerprintExport`. */
  readonly fingerprint: string;
}

/**
 * What the authorize callback is told.
 *
 * Only server-observed identity appears here. Nothing the client asserted
 * about itself is included, because a value the peer chose cannot be an
 * input to whether the peer is allowed in (SPEC §17.3).
 */
export interface AuthorizeMillePeerContext {
  /** Tailscale stable node id from the accepted socket. */
  readonly peerId: string;
  readonly peerName?: string | undefined;
  readonly exportId: string;
  readonly requestedAccess: RemoteAccess;
  readonly configuredAccess: RemoteAccess;
}

export interface MilleRemoteLogger {
  info?(event: string, fields?: Record<string, unknown>): void;
  warn?(event: string, fields?: Record<string, unknown>): void;
  debug?(event: string, fields?: Record<string, unknown>): void;
}

export interface ServeMilleOptions {
  /** Mesh port to listen on. Default 9451 — clear of Truffle's reserved 9417. */
  readonly port?: number;
  readonly exports: Readonly<Record<string, MilleExportConfig>>;
  readonly authorize?: (context: AuthorizeMillePeerContext) => boolean | Promise<boolean>;
  readonly logger?: MilleRemoteLogger;
  /** How long an idle host stays alive after its last session. Default 5 min. */
  readonly hostIdleTimeoutMs?: number;
  readonly maxSessionsPerPeer?: number;
  /** Ping after this much silence. Default 20 s. */
  readonly heartbeatMs?: number;
  /** Close after this long with no inbound frame. Default 60 s. */
  readonly idleTimeoutMs?: number;
  /** Server-side deadline for the open request. Default 10 s. */
  readonly openTimeoutMs?: number;
  /**
   * Reveal *why* an open was refused, instead of a uniform ACCESS_DENIED.
   * Off by default: distinguishing "no such export" from "not for you"
   * turns the service into an export enumerator (SEC-006).
   */
  readonly diagnosticDisclosure?: boolean;
}

export interface RemoteSessionInfo {
  readonly sessionId: string;
  readonly exportId: string;
  readonly peerId: string;
  readonly peerName?: string | undefined;
  readonly access: RemoteAccess;
  readonly workspaceInstanceId: string;
  readonly openedAtMs: number;
}

export interface MilleRemoteServer {
  readonly port: number;
  listSessions(): readonly RemoteSessionInfo[];
  /** Live host count — one per distinct export configuration in use. */
  readonly hostCount: number;
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}
