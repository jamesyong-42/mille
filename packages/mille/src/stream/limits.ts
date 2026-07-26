// Wire constants and bounds for the framed stream codec (SPEC §11.2, §11.6).
//
// Every limit here exists to make a malformed or hostile frame cheap to
// reject. The decoder validates the header against these *before* it
// allocates anything or waits for more bytes, so an attacker-supplied
// length field can never make us reserve memory proportional to it.

/** ASCII "MLLE" — rejects accidental or cross-protocol traffic. */
export const WIRE_MAGIC = Uint8Array.from([0x4d, 0x4c, 0x4c, 0x45]);

/** Breaking frame-format version. Unknown major is fatal. */
export const WIRE_MAJOR = 1;

/** Backward-compatible additions. A higher minor is accepted. */
export const WIRE_MINOR = 0;

/** magic(4) + major(1) + minor(1) + flags(2) + 3 × u32 lengths. */
export const HEADER_BYTES = 20;

/**
 * No flag bits are defined in Phase 1. Compression reserves one, but
 * neither side may set it — receiving any active flag is a protocol error
 * rather than something to ignore, so a future codec cannot be silently
 * misread by an old peer.
 */
export const KNOWN_FLAGS = 0;

export interface FramedStreamLimits {
  /** Max UTF-8 JSON metadata per frame. Default 4 MiB. */
  readonly maxMetadataBytes: number;
  /** Max binary attachments per frame. Default 32. */
  readonly maxAttachments: number;
  /** Max total frame size, header included. Default 32 MiB. */
  readonly maxFrameBytes: number;
  /** Queued-but-unwritten bytes past which callers should await drain(). Default 8 MiB. */
  readonly outboundSoftBytes: number;
  /** Queued-but-unwritten bytes that close the channel outright. Default 32 MiB. */
  readonly outboundHardBytes: number;
}

const MiB = 1024 * 1024;

export const DEFAULT_LIMITS: FramedStreamLimits = {
  maxMetadataBytes: 4 * MiB,
  maxAttachments: 32,
  maxFrameBytes: 32 * MiB,
  outboundSoftBytes: 8 * MiB,
  outboundHardBytes: 32 * MiB,
};

export type FramedStreamLimitsInput = Partial<FramedStreamLimits>;

function positiveInt(name: string, value: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer, got ${String(value)}`);
  }
  return value;
}

/**
 * Apply defaults and reject incoherent combinations.
 *
 * Two of these bounds depend on another: metadata cannot exceed the frame
 * it lives in, and the soft watermark is meaningless above the hard limit.
 * Lowering the outer bound alone is the common case — a remote policy may
 * only ever *reduce* a maximum (§22.2) — so an unspecified inner bound
 * clamps down to follow it rather than erroring. Specifying both
 * explicitly in an incoherent order is a configuration bug, and throws.
 */
export function resolveLimits(input?: FramedStreamLimitsInput): FramedStreamLimits {
  const maxFrameBytes = positiveInt(
    'maxFrameBytes',
    input?.maxFrameBytes as number,
    DEFAULT_LIMITS.maxFrameBytes,
  );
  const maxAttachments = positiveInt(
    'maxAttachments',
    input?.maxAttachments as number,
    DEFAULT_LIMITS.maxAttachments,
  );
  const outboundHardBytes = positiveInt(
    'outboundHardBytes',
    input?.outboundHardBytes as number,
    DEFAULT_LIMITS.outboundHardBytes,
  );

  const maxMetadataBytes =
    input?.maxMetadataBytes === undefined
      ? Math.min(DEFAULT_LIMITS.maxMetadataBytes, maxFrameBytes)
      : positiveInt('maxMetadataBytes', input.maxMetadataBytes, DEFAULT_LIMITS.maxMetadataBytes);

  const outboundSoftBytes =
    input?.outboundSoftBytes === undefined
      ? Math.min(DEFAULT_LIMITS.outboundSoftBytes, outboundHardBytes)
      : positiveInt('outboundSoftBytes', input.outboundSoftBytes, DEFAULT_LIMITS.outboundSoftBytes);

  if (maxMetadataBytes > maxFrameBytes) {
    throw new RangeError('maxMetadataBytes cannot exceed maxFrameBytes');
  }
  if (outboundSoftBytes > outboundHardBytes) {
    throw new RangeError('outboundSoftBytes cannot exceed outboundHardBytes');
  }
  return {
    maxMetadataBytes,
    maxAttachments,
    maxFrameBytes,
    outboundSoftBytes,
    outboundHardBytes,
  };
}

/** Thrown for any frame that violates the wire format or the limits. */
export class FrameProtocolError extends Error {
  override readonly name = 'FrameProtocolError';
  constructor(message: string) {
    super(message);
  }
}
