// useControlledState — helper for reconciling controlled / uncontrolled
// props on a component. Matches the pattern used by Radix, React Aria,
// and countless others.
//
// If `value` is `undefined`, the hook is uncontrolled: state is tracked
// internally, seeded from `defaultValue`. `onChange` is still called on
// every update. If `value` is anything else (including `null`), the hook
// is controlled: the setter calls `onChange` and never writes to its
// internal state.
//
// Dev-only warning on controlled ↔ uncontrolled transition, matching
// React's own warning style. Production builds skip the warning.

import { useCallback, useRef, useState } from 'react';

export interface UseControlledStateOptions<T> {
  /** When defined, component is controlled; state lives outside. */
  readonly value?: T | undefined;
  /** Initial value for the uncontrolled branch. Ignored if `value` is set. */
  readonly defaultValue: T;
  /** Called on every setter invocation (controlled + uncontrolled). */
  readonly onChange?: (next: T) => void;
}

/**
 * Returns `[current, setCurrent]`. If controlled, `current` mirrors `value`
 * and `setCurrent(next)` fires `onChange(next)` without touching internal
 * state. If uncontrolled, `current` comes from internal state, and
 * `setCurrent(next)` updates both internal state and calls `onChange(next)`.
 */
export function useControlledState<T>(
  options: UseControlledStateOptions<T>,
): readonly [T, (next: T) => void] {
  const { value, defaultValue, onChange } = options;
  const isControlled = value !== undefined;

  const [internal, setInternal] = useState<T>(defaultValue);

  // Track the controlled/uncontrolled mode at mount to warn on
  // unintentional transitions. React's own warning is emitted elsewhere
  // (for native inputs); we warn symmetrically for our own state.
  const wasControlledRef = useRef<boolean | null>(null);
  if (wasControlledRef.current === null) {
    wasControlledRef.current = isControlled;
  } else if (wasControlledRef.current !== isControlled) {
    // Dev-only warning; the condition is cheap and only fires on change.
    if (typeof process !== 'undefined' && process.env && process.env.NODE_ENV !== 'production') {
      // eslint-disable-next-line no-console
      console.warn(
        wasControlledRef.current
          ? 'useControlledState: component changing from controlled to uncontrolled. ' +
              'Provide a stable value prop or omit it entirely for the lifetime of the component.'
          : 'useControlledState: component changing from uncontrolled to controlled. ' +
              'Provide a stable value prop from mount or rely on defaultValue.',
      );
    }
    wasControlledRef.current = isControlled;
  }

  const set = useCallback(
    (next: T) => {
      if (!isControlled) {
        setInternal(next);
      }
      if (onChange) {
        onChange(next);
      }
    },
    [isControlled, onChange],
  );

  const current = isControlled ? (value as T) : internal;
  return [current, set] as const;
}
