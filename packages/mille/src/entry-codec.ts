// Binary codec for viewport-hydrated ClientEntry records.
//
// The layout is bincode 2 standard-config `Vec<ClientEntry>` and matches the
// Entry prefix of the native EnrichedRow codec in decode.ts. Keeping the wire
// shape aligned lets a future native encoder replace this TypeScript writer
// without changing the renderer decoder or protocol version.

import { BincodeDecodeError, BincodeReader } from './decode.js';
import type { ClientEntry } from './mirror.js';

const VARINT_U16 = 251;
const VARINT_U32 = 252;
const VARINT_U64 = 253;
const textEncoder = new TextEncoder();

class BincodeWriter {
  private bytes = new Uint8Array(256);
  private view = new DataView(this.bytes.buffer);
  private pos = 0;

  private ensure(length: number): void {
    const required = this.pos + length;
    if (required <= this.bytes.length) return;
    let capacity = this.bytes.length;
    while (capacity < required) capacity *= 2;
    const grown = new Uint8Array(capacity);
    grown.set(this.bytes);
    this.bytes = grown;
    this.view = new DataView(grown.buffer);
  }

  writeU8(value: number): void {
    this.ensure(1);
    this.view.setUint8(this.pos, value);
    this.pos += 1;
  }

  writeBool(value: boolean): void {
    this.writeU8(value ? 1 : 0);
  }

  writeVarintU64(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`bincode: expected non-negative safe integer, received ${value}`);
    }
    const big = BigInt(value);
    if (big < BigInt(VARINT_U16)) {
      this.writeU8(value);
    } else if (big <= 0xffffn) {
      this.ensure(3);
      this.view.setUint8(this.pos, VARINT_U16);
      this.view.setUint16(this.pos + 1, value, true);
      this.pos += 3;
    } else if (big <= 0xffff_ffffn) {
      this.ensure(5);
      this.view.setUint8(this.pos, VARINT_U32);
      this.view.setUint32(this.pos + 1, value, true);
      this.pos += 5;
    } else {
      this.ensure(9);
      this.view.setUint8(this.pos, VARINT_U64);
      this.view.setBigUint64(this.pos + 1, big, true);
      this.pos += 9;
    }
  }

  writeVarintI64(value: number): void {
    if (!Number.isSafeInteger(value)) {
      throw new RangeError(`bincode: expected safe integer, received ${value}`);
    }
    const big = BigInt(value);
    const zigzag = big >= 0 ? big * 2n : -big * 2n - 1n;
    if (zigzag < BigInt(VARINT_U16)) {
      this.writeU8(Number(zigzag));
    } else if (zigzag <= 0xffffn) {
      this.ensure(3);
      this.view.setUint8(this.pos, VARINT_U16);
      this.view.setUint16(this.pos + 1, Number(zigzag), true);
      this.pos += 3;
    } else if (zigzag <= 0xffff_ffffn) {
      this.ensure(5);
      this.view.setUint8(this.pos, VARINT_U32);
      this.view.setUint32(this.pos + 1, Number(zigzag), true);
      this.pos += 5;
    } else {
      this.ensure(9);
      this.view.setUint8(this.pos, VARINT_U64);
      this.view.setBigUint64(this.pos + 1, zigzag, true);
      this.pos += 9;
    }
  }

  writeString(value: string): void {
    const encoded = textEncoder.encode(value);
    this.writeVarintU64(encoded.byteLength);
    this.ensure(encoded.byteLength);
    this.bytes.set(encoded, this.pos);
    this.pos += encoded.byteLength;
  }

  writeOption<T>(value: T | null, writeSome: (value: T) => void): void {
    if (value === null) {
      this.writeU8(0);
      return;
    }
    this.writeU8(1);
    writeSome(value);
  }

  finish(): ArrayBuffer {
    const out = new Uint8Array(this.pos);
    out.set(this.bytes.subarray(0, this.pos));
    return out.buffer;
  }
}

function writeClientEntry(writer: BincodeWriter, entry: ClientEntry): void {
  writer.writeVarintU64(entry.id);
  writer.writeOption(entry.parentId, (id) => writer.writeVarintU64(id));
  writer.writeString(entry.name);
  writer.writeU8(entry.kind);
  writer.writeVarintU64(entry.size);
  writer.writeVarintI64(entry.mtimeMs);
  writer.writeVarintI64(entry.ctimeMs);
  writer.writeOption(entry.symlinkTargetIsDir, (value) => writer.writeBool(value));
  writer.writeOption(entry.pathSegments, (segments) => {
    writer.writeVarintU64(segments.length);
    for (const segment of segments) writer.writeString(segment);
  });
  writer.writeBool(entry.isIgnored);
  writer.writeBool(entry.isReadonly);
  writer.writeBool(entry.isHidden);
}

function readClientEntry(reader: BincodeReader): ClientEntry {
  return {
    id: reader.readVarintU64AsNumber(),
    parentId: reader.readOption((r) => r.readVarintU64AsNumber()),
    name: reader.readString(),
    kind: reader.readU8(),
    size: reader.readVarintU64AsNumber(),
    mtimeMs: reader.readVarintI64AsNumber(),
    ctimeMs: reader.readVarintI64AsNumber(),
    symlinkTargetIsDir: reader.readOption((r) => r.readBool()),
    pathSegments: reader.readOption((r) => r.readVec((rr) => rr.readString())),
    isIgnored: reader.readBool(),
    isReadonly: reader.readBool(),
    isHidden: reader.readBool(),
  };
}

/** Encode a bincode-compatible `Vec<ClientEntry>` into an exact ArrayBuffer. */
export function encodeClientEntries(entries: readonly ClientEntry[]): ArrayBuffer {
  const writer = new BincodeWriter();
  writer.writeVarintU64(entries.length);
  for (const entry of entries) writeClientEntry(writer, entry);
  return writer.finish();
}

/** Decode a bincode-compatible `Vec<ClientEntry>` and reject schema drift. */
export function decodeClientEntries(buffer: ArrayBuffer | Uint8Array): ClientEntry[] {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const reader = new BincodeReader(bytes);
  const length = reader.readVarintU64AsNumber();
  const entries = new Array<ClientEntry>(length);
  for (let index = 0; index < length; index++) entries[index] = readClientEntry(reader);
  if (reader.remaining !== 0) {
    throw new BincodeDecodeError(
      `bincode: ${reader.remaining} trailing bytes after decoding ${length} entries`,
    );
  }
  return entries;
}
