// useFileTreeRef — convenience constructor for a `FileTreeRef` ref slot.
//
// v0.2 B6. `<FileTree>` is `forwardRef`-wrapped; the imperative surface
// (`revealPath`, `revealId`, `scrollToRow`, `clearSelection`,
// `clearFilter`, `clearClipboard`, `focusFilter`, `reset`) lives on the
// `FileTreeRef` interface in `components/types.ts`.
//
// Consumers that want to drive the tree imperatively can either:
//
//   1. `const ref = useRef<FileTreeRef | null>(null)` themselves, or
//   2. `const ref = useFileTreeRef()` — this hook.
//
// Both are equivalent. The hook exists mainly so callers don't need to
// import `FileTreeRef` separately for the type parameter.

import { useRef, type RefObject } from 'react';
import type { FileTreeRef } from '../components/types.js';

/**
 * Convenience hook: allocates a ref cell typed for `FileTreeRef`.
 *
 * ```tsx
 * const treeRef = useFileTreeRef();
 * return <FileTree ref={treeRef} ariaLabel="Files" />;
 * ```
 *
 * The returned ref is the standard mutable-ref object `useRef` returns —
 * callers can attach it directly to `<FileTree ref={ref}>`, read
 * `ref.current` to invoke imperative methods, or `null`-check before
 * calling to tolerate mount/unmount races.
 */
export function useFileTreeRef(): RefObject<FileTreeRef | null> {
  return useRef<FileTreeRef | null>(null);
}

export type { FileTreeRef };
