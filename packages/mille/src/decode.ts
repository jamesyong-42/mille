// Bincode decoder for EnrichedRow — the bulk wire format emitted by
// `MirrorSnapshot.visibleRowsBin` (see fx-binding/src/bulk.rs +
// fx-binding/src/snapshot.rs::EnrichedRow).
//
// SPEC §4.8 trades struct-by-struct NAPI marshaling for a single
// Buffer containing a bincode-encoded `Vec<EnrichedRow>` once the
// viewport exceeds ~100 rows. This module is the pair to that encoder.
//
// Encoding conventions (bincode 2.0.1 `config::standard()`):
//
//   - Little-endian byte order.
//   - Integers use bincode's varint scheme:
//       * value < 251 : one byte (the value)
//       * else        : marker byte + fixed-width LE integer, where
//                       marker ∈ {251=u16, 252=u32, 253=u64, 254=u128}.
//   - Signed integers zigzag first, then apply the unsigned varint:
//       encode: n >= 0 → 2n, n < 0 → !n * 2 + 1  (= -2n - 1)
//       decode: u → (u >> 1) XOR -(u & 1)
//   - bool is a single u8 (0 or 1).
//   - Option<T> is 0-byte for None, 1-byte + T for Some.
//   - String is varint-length prefixed UTF-8.
//   - Vec<T> / sequences are varint-length prefixed element stream.
//   - Structs have no length prefix; fields serialize in declaration
//     order.
//
// We keep this hand-rolled rather than depending on a JS bincode
// library to avoid pulling in an extra dependency for what's a
// tightly-scoped wire format. If bincode's standard config changes
// in a future major, we catch it here and bump the decoder.

const VARINT_U16 = 251;
const VARINT_U32 = 252;
const VARINT_U64 = 253;
const VARINT_U128 = 254;

// u64 values above Number.MAX_SAFE_INTEGER (2^53 - 1) can't round-trip
// through JS number without precision loss. fx-core's EntryId allocator
// caps at 2^53 exactly, so any incoming id beyond that ceiling is a bug
// on the Rust side. Sizes can in principle exceed 2^53 for huge files,
// but in practice filesystems cap at well below that (ext4 ~16 TiB, NTFS
// ~256 TiB); if we do hit one, fail loud rather than silently truncate.
const MAX_SAFE_U64 = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Decoded row from `visibleRowsBin`. Field names are camelCase'd from
 * the Rust `EnrichedRow` struct for JS ergonomics. Integer fields land
 * as `number` (u64 asserted to fit Number.MAX_SAFE_INTEGER) so callers
 * don't need to branch on bigint vs number.
 */
export interface VisibleRow {
  id: number;
  parentId: number | null;
  name: string;
  /** EntryKind as u8: File=0, Directory=1, Symlink=2, Unknown=3. */
  kind: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  symlinkTargetIsDir: boolean | null;
  pathSegments: string[] | null;
  isIgnored: boolean;
  isReadonly: boolean;
  isHidden: boolean;
  depth: number;
  hasChildren: boolean;
  isExpanded: boolean;
}

/**
 * Reader over a Buffer positioned at the start of a bincode stream.
 * Exposes one primitive per Rust type we need; the decoder in
 * {@link decodeBulkRows} composes these.
 *
 * Reads throw {@link BincodeDecodeError} on truncation; the caller is
 * responsible for surfacing those as a proper FileSystemError if they
 * ever reach user code (in practice this only happens on a binding
 * bug, not user input).
 */
export class BincodeReader {
  private readonly view: DataView;
  private readonly bytes: Uint8Array;
  private pos: number;

  constructor(buffer: Uint8Array) {
    // Use the underlying ArrayBuffer but slice the view to the exact
    // bytes passed in (Buffers may be sub-views of a larger pool).
    this.bytes = buffer;
    this.view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    this.pos = 0;
  }

  get position(): number {
    return this.pos;
  }

  get remaining(): number {
    return this.bytes.byteLength - this.pos;
  }

  private ensure(n: number): void {
    if (this.pos + n > this.bytes.byteLength) {
      throw new BincodeDecodeError(
        `bincode: truncated buffer (need ${n} bytes at offset ${this.pos}, ` +
          `have ${this.bytes.byteLength - this.pos})`,
      );
    }
  }

  readU8(): number {
    this.ensure(1);
    const v = this.view.getUint8(this.pos);
    this.pos += 1;
    return v;
  }

  readBool(): boolean {
    const b = this.readU8();
    if (b !== 0 && b !== 1) {
      throw new BincodeDecodeError(
        `bincode: invalid bool byte 0x${b.toString(16)} at offset ${this.pos - 1}`,
      );
    }
    return b === 1;
  }

  /** Read a bincode varint as BigInt (for full u64 precision). */
  readVarintU64(): bigint {
    const head = this.readU8();
    if (head < VARINT_U16) return BigInt(head);
    switch (head) {
      case VARINT_U16: {
        this.ensure(2);
        const v = this.view.getUint16(this.pos, true);
        this.pos += 2;
        return BigInt(v);
      }
      case VARINT_U32: {
        this.ensure(4);
        const v = this.view.getUint32(this.pos, true);
        this.pos += 4;
        return BigInt(v);
      }
      case VARINT_U64: {
        this.ensure(8);
        const v = this.view.getBigUint64(this.pos, true);
        this.pos += 8;
        return v;
      }
      case VARINT_U128:
        // Not used by EnrichedRow; reject rather than silently mis-reading.
        throw new BincodeDecodeError('bincode: u128 varint unsupported');
      default:
        throw new BincodeDecodeError(`bincode: unknown varint marker ${head}`);
    }
  }

  /**
   * Read a bincode signed varint. Bincode zigzag-encodes signed
   * integers, then applies the unsigned varint to the result.
   * Decode: `u → (u >> 1) XOR -(u & 1)`.
   */
  readVarintI64(): bigint {
    const u = this.readVarintU64();
    return (u >> 1n) ^ -(u & 1n);
  }

  /**
   * Read a u64 varint as a JS number. Asserts < 2^53 so callers can
   * treat the result as an ordinary number without precision concerns.
   * Use `readVarintU64()` if the caller wants full 64-bit precision.
   */
  readVarintU64AsNumber(): number {
    const v = this.readVarintU64();
    if (v > MAX_SAFE_U64) {
      throw new BincodeDecodeError(
        `bincode: u64 value ${v} exceeds Number.MAX_SAFE_INTEGER; ` +
          `caller should read as BigInt`,
      );
    }
    return Number(v);
  }

  /** Read an i64 varint as a JS number, with the same safe-int assertion. */
  readVarintI64AsNumber(): number {
    const v = this.readVarintI64();
    if (v > MAX_SAFE_U64 || v < -MAX_SAFE_U64) {
      throw new BincodeDecodeError(
        `bincode: i64 value ${v} outside Number.MAX_SAFE_INTEGER range`,
      );
    }
    return Number(v);
  }

  readString(): string {
    const len = Number(this.readVarintU64());
    this.ensure(len);
    const slice = this.bytes.subarray(this.pos, this.pos + len);
    this.pos += len;
    // TextDecoder gives us WHATWG-standard UTF-8 handling (replacement
    // char for invalid sequences). Rust never emits invalid UTF-8 via
    // serde/String, so this is defence-in-depth only.
    return new TextDecoder('utf-8').decode(slice);
  }

  readOption<T>(readSome: (r: BincodeReader) => T): T | null {
    const tag = this.readU8();
    if (tag === 0) return null;
    if (tag === 1) return readSome(this);
    throw new BincodeDecodeError(
      `bincode: invalid Option tag 0x${tag.toString(16)} at offset ${this.pos - 1}`,
    );
  }

  readVec<T>(readElem: (r: BincodeReader) => T): T[] {
    const len = Number(this.readVarintU64());
    const out: T[] = new Array(len);
    for (let i = 0; i < len; i++) {
      out[i] = readElem(this);
    }
    return out;
  }
}

/** Thrown on malformed buffers. Internal — signals a binding bug. */
export class BincodeDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BincodeDecodeError';
  }
}

function readEnrichedRow(r: BincodeReader): VisibleRow {
  // Field order must match `EnrichedRow` in fx-binding/src/snapshot.rs.
  const id = r.readVarintU64AsNumber();
  const parentId = r.readOption((rr) => rr.readVarintU64AsNumber());
  const name = r.readString();
  const kind = r.readU8();
  const size = r.readVarintU64AsNumber();
  const mtimeMs = r.readVarintI64AsNumber();
  const ctimeMs = r.readVarintI64AsNumber();
  const symlinkTargetIsDir = r.readOption((rr) => rr.readBool());
  const pathSegments = r.readOption((rr) => rr.readVec((rrr) => rrr.readString()));
  const isIgnored = r.readBool();
  const isReadonly = r.readBool();
  const isHidden = r.readBool();
  // u16 in Rust; bincode varint-encodes all integer widths the same
  // way in standard config, so we use the u64 reader.
  const depth = r.readVarintU64AsNumber();
  const hasChildren = r.readBool();
  const isExpanded = r.readBool();
  return {
    id,
    parentId,
    name,
    kind,
    size,
    mtimeMs,
    ctimeMs,
    symlinkTargetIsDir,
    pathSegments,
    isIgnored,
    isReadonly,
    isHidden,
    depth,
    hasChildren,
    isExpanded,
  };
}

/**
 * Decode the bincode payload from `MirrorSnapshot.visibleRowsBin`
 * into an array of `VisibleRow`. The outer shape is `Vec<EnrichedRow>`,
 * so we read a varint length then that many rows.
 */
export function decodeBulkRows(buffer: Uint8Array): VisibleRow[] {
  const reader = new BincodeReader(buffer);
  const len = Number(reader.readVarintU64());
  const out: VisibleRow[] = new Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = readEnrichedRow(reader);
  }
  if (reader.remaining !== 0) {
    // Not fatal per se — but it means our decoder and the encoder
    // disagree about the field list. Fail loudly so schema drift
    // surfaces in tests rather than silently corrupted rows.
    throw new BincodeDecodeError(
      `bincode: ${reader.remaining} trailing bytes after decoding ${len} rows`,
    );
  }
  return out;
}
