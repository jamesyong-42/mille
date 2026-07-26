// Node-only entry point — `@vibecook/mille/node`.
//
// The framed stream channel imports `node:stream`, so it must not be
// reachable from the package root: a renderer or browser bundle that pulls
// in `@vibecook/mille` should never acquire a Node polyfill for it
// (SPEC NFR-007, §11.8). Everything here is additive; the root entry is
// unchanged and stays browser-safe.
//
// Pair this with any Duplex — a PassThrough in tests, a TCP socket, or a
// Truffle mesh socket, which is a `stream.Duplex` with a tailnet-verified
// peer identity attached.

export {
  createFramedStreamHostChannel,
  createFramedStreamClientChannel,
  type FramedStreamChannelOptions,
} from './stream/framed-channel.js';

export {
  DEFAULT_LIMITS,
  FrameProtocolError,
  HEADER_BYTES,
  WIRE_MAGIC,
  WIRE_MAJOR,
  WIRE_MINOR,
  resolveLimits,
  type FramedStreamLimits,
  type FramedStreamLimitsInput,
} from './stream/limits.js';

// Exported for tests and for anyone building a non-Duplex transport on the
// same wire format (a WebSocket, say). Not part of the supported surface
// yet — the framing is versioned, but these signatures are not.
export { encodeFrame, decodeFrame, parseHeader, type FrameHeader } from './stream/codec.js';
export { FrameDecoder } from './stream/decoder.js';
