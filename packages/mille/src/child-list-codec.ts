// Compact wire codec for authoritative expanded-folder child order.
//
// The renderer needs every child identity to project arbitrary viewport
// windows, but it does not need a full Entry record for every child. This
// format keeps that unavoidable identity index in one packed ArrayBuffer and
// lets the reducer retain zero-copy typed-array views into the cloned buffer.
//
// Layout (little endian, every record starts on an 8-byte boundary):
//
//   u32 magic "MCL1"
//   u32 parent count
//   repeated:
//     f64 parent id
//     u32 child count
//     u8  child width (4 or 8)
//     u8[3] reserved
//     child ids as u32[] or f64[]
//     zero padding to the next 8-byte boundary

import { BincodeDecodeError } from './decode.js';
import type { ChildIdList } from './mirror.js';

const MAGIC = 0x314c_434d;
const HEADER_BYTES = 8;
const RECORD_HEADER_BYTES = 16;
const UINT32_BYTES = 4;
const FLOAT64_BYTES = 8;
const MAX_UINT32 = 0xffff_ffff;

function assertId(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label}: expected a non-negative safe integer, received ${value}`);
  }
}

function align8(value: number): number {
  return Math.ceil(value / 8) * 8;
}

/** Encode parent → authoritative child order into one exact ArrayBuffer. */
export function encodeChildLists(lists: ReadonlyMap<number, readonly number[]>): ArrayBuffer {
  const records: Array<{
    parentId: number;
    ids: readonly number[];
    width: typeof UINT32_BYTES | typeof FLOAT64_BYTES;
  }> = [];
  let byteLength = HEADER_BYTES;

  for (const [parentId, ids] of lists) {
    assertId(parentId, 'child-list parent id');
    let width: typeof UINT32_BYTES | typeof FLOAT64_BYTES = UINT32_BYTES;
    for (const id of ids) {
      assertId(id, 'child-list child id');
      if (id > MAX_UINT32) width = FLOAT64_BYTES;
    }
    const recordBytes = RECORD_HEADER_BYTES + ids.length * width;
    byteLength += align8(recordBytes);
    records.push({ parentId, ids, width });
  }

  const buffer = new ArrayBuffer(byteLength);
  const view = new DataView(buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, records.length, true);
  let offset = HEADER_BYTES;

  for (const record of records) {
    view.setFloat64(offset, record.parentId, true);
    view.setUint32(offset + 8, record.ids.length, true);
    view.setUint8(offset + 12, record.width);
    let childOffset = offset + RECORD_HEADER_BYTES;
    for (const id of record.ids) {
      if (record.width === UINT32_BYTES) view.setUint32(childOffset, id, true);
      else view.setFloat64(childOffset, id, true);
      childOffset += record.width;
    }
    offset += align8(RECORD_HEADER_BYTES + record.ids.length * record.width);
  }
  return buffer;
}

function exactAlignedBytes(buffer: ArrayBuffer | Uint8Array): Uint8Array {
  if (buffer instanceof ArrayBuffer) return new Uint8Array(buffer);
  if (buffer.byteOffset % 8 === 0 && buffer.byteLength === buffer.buffer.byteLength) return buffer;
  return new Uint8Array(buffer);
}

/** Decode to typed-array views that retain the packed buffer without copying. */
export function decodeChildLists(buffer: ArrayBuffer | Uint8Array): Map<number, ChildIdList> {
  const bytes = exactAlignedBytes(buffer);
  if (bytes.byteLength < HEADER_BYTES) {
    throw new BincodeDecodeError('child-list: truncated header');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== MAGIC) {
    throw new BincodeDecodeError('child-list: invalid magic');
  }

  const parentCount = view.getUint32(4, true);
  const lists = new Map<number, ChildIdList>();
  let offset = HEADER_BYTES;
  for (let index = 0; index < parentCount; index++) {
    if (offset + RECORD_HEADER_BYTES > bytes.byteLength) {
      throw new BincodeDecodeError(`child-list: truncated record ${index}`);
    }
    const parentId = view.getFloat64(offset, true);
    if (!Number.isSafeInteger(parentId) || parentId < 0) {
      throw new BincodeDecodeError(`child-list: invalid parent id ${parentId}`);
    }
    const count = view.getUint32(offset + 8, true);
    const width = view.getUint8(offset + 12);
    if (width !== UINT32_BYTES && width !== FLOAT64_BYTES) {
      throw new BincodeDecodeError(`child-list: invalid id width ${width}`);
    }
    const recordBytes = RECORD_HEADER_BYTES + count * width;
    const nextOffset = offset + align8(recordBytes);
    if (nextOffset > bytes.byteLength) {
      throw new BincodeDecodeError(`child-list: truncated children for parent ${parentId}`);
    }
    const childByteOffset = bytes.byteOffset + offset + RECORD_HEADER_BYTES;
    let ids: ChildIdList;
    if (width === UINT32_BYTES) {
      ids = new Uint32Array(bytes.buffer, childByteOffset, count);
    } else {
      const values = new Float64Array(bytes.buffer, childByteOffset, count);
      for (const id of values) {
        if (!Number.isSafeInteger(id) || id < 0) {
          throw new BincodeDecodeError(`child-list: invalid child id ${id}`);
        }
      }
      ids = values;
    }
    if (lists.has(parentId)) {
      throw new BincodeDecodeError(`child-list: duplicate parent ${parentId}`);
    }
    lists.set(parentId, ids);
    offset = nextOffset;
  }
  if (offset !== bytes.byteLength) {
    throw new BincodeDecodeError(`child-list: ${bytes.byteLength - offset} trailing bytes`);
  }
  return lists;
}
