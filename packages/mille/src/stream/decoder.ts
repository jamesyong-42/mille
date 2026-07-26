// Incremental frame parser (SPEC §11.7).
//
// A byte stream splits wherever it likes: one frame can arrive as 40,000
// single-byte chunks, and 40,000 frames can arrive as one chunk. Both must
// work, and neither may let an attacker-declared length drive an allocation.
//
// The buffer is a chunk list rather than one growing Buffer. Appending is
// O(1) and byte-at-a-time delivery stays linear instead of quadratic; the
// only copies are the 20-byte header peek and the completed frame itself.

import { decodeFrame, parseHeader, type FrameHeader } from './codec.js';
import { FrameProtocolError, HEADER_BYTES, type FramedStreamLimits } from './limits.js';

export class FrameDecoder {
  readonly #limits: FramedStreamLimits;
  readonly #chunks: Uint8Array[] = [];
  #buffered = 0;
  /** Header of the frame currently being awaited, once it has validated. */
  #pending: FrameHeader | null = null;

  constructor(limits: FramedStreamLimits) {
    this.#limits = limits;
  }

  /** Bytes held pending a complete frame. */
  get bufferedBytes(): number {
    return this.#buffered;
  }

  /**
   * Feed one chunk and return every message it completed.
   *
   * Throws `FrameProtocolError` on the first malformed frame; the caller is
   * expected to close the channel, so the decoder makes no attempt to
   * resynchronize — a stream that lied once cannot be trusted to frame the
   * next boundary either.
   */
  push(chunk: Uint8Array): unknown[] {
    if (chunk.byteLength > 0) {
      this.#chunks.push(chunk);
      this.#buffered += chunk.byteLength;
    }

    const out: unknown[] = [];
    for (;;) {
      if (this.#pending === null) {
        if (this.#buffered < HEADER_BYTES) break;
        // Validate before committing to wait for the body. A bogus length
        // is rejected here, having allocated only these 20 bytes.
        this.#pending = parseHeader(this.#peek(HEADER_BYTES), this.#limits);
      }
      if (this.#buffered < this.#pending.totalLength) break;

      const header = this.#pending;
      const frame = this.#take(header.totalLength);
      this.#pending = null;
      out.push(decodeFrame(frame, header));
    }
    return out;
  }

  /** Drop everything buffered. Called when the channel closes. */
  reset(): void {
    this.#chunks.length = 0;
    this.#buffered = 0;
    this.#pending = null;
  }

  /** Copy the first `n` buffered bytes without consuming them. */
  #peek(n: number): Uint8Array {
    const first = this.#chunks[0];
    if (first !== undefined && first.byteLength >= n) {
      return first.subarray(0, n);
    }
    const out = new Uint8Array(n);
    let filled = 0;
    for (const chunk of this.#chunks) {
      const take = Math.min(n - filled, chunk.byteLength);
      out.set(chunk.subarray(0, take), filled);
      filled += take;
      if (filled === n) break;
    }
    if (filled < n) {
      throw new FrameProtocolError('peek past the end of the buffer');
    }
    return out;
  }

  /** Remove and return the first `n` buffered bytes. */
  #take(n: number): Uint8Array {
    const out = new Uint8Array(n);
    let filled = 0;
    while (filled < n) {
      const chunk = this.#chunks[0];
      if (chunk === undefined) {
        throw new FrameProtocolError('take past the end of the buffer');
      }
      const take = Math.min(n - filled, chunk.byteLength);
      out.set(chunk.subarray(0, take), filled);
      filled += take;
      if (take === chunk.byteLength) {
        this.#chunks.shift();
      } else {
        // Partially consumed: keep the remainder as the new head.
        this.#chunks[0] = chunk.subarray(take);
      }
    }
    this.#buffered -= n;
    return out;
  }
}
