// Capability helpers — advertise, query, and explain unsupported ops.
//
// Capability bits alone are not enough: optional methods must exist on the
// provider instance or the operation is treated as unsupported (EUNSUPPORTED),
// never a raw TypeError from calling `undefined`.

import { FileSystemError } from '../errors.js';
import {
  Capability,
  type FileSystemProvider,
  type ProviderOperation,
  type UnsupportedOperationInfo,
} from './types.js';

const OP_REQUIREMENTS: Readonly<
  Record<ProviderOperation, { bits: number; label: string }>
> = {
  stat: { bits: Capability.None, label: 'stat' },
  readDirectory: { bits: Capability.None, label: 'read directory' },
  readFile: { bits: Capability.None, label: 'read file' },
  writeFile: { bits: Capability.ReadWrite, label: 'write file' },
  createDirectory: { bits: Capability.ReadWrite, label: 'create directory' },
  delete: { bits: Capability.ReadWrite, label: 'delete' },
  rename: { bits: Capability.ReadWrite, label: 'rename' },
  copy: { bits: Capability.Clone | Capability.ReadWrite, label: 'copy' },
  watch: { bits: Capability.Watch, label: 'watch' },
  stream: { bits: Capability.Stream, label: 'stream read' },
  trash: { bits: Capability.Trash, label: 'move to trash' },
  atomicWrite: { bits: Capability.AtomicWrite, label: 'atomic write' },
};

/** Map operations to the FileSystemProvider method that implements them. */
const OP_METHOD: Readonly<
  Partial<Record<ProviderOperation, keyof FileSystemProvider>>
> = {
  writeFile: 'writeFile',
  createDirectory: 'createDirectory',
  delete: 'delete',
  rename: 'rename',
  copy: 'copy',
  watch: 'watch',
  stream: 'readFileStream',
};

export function hasCapability(capabilities: number, bit: number): boolean {
  if (bit === Capability.None) return true;
  return (capabilities & bit) === bit;
}

export function hasAnyCapability(capabilities: number, bits: number): boolean {
  if (bits === Capability.None) return true;
  return (capabilities & bits) !== 0;
}

export function isReadonlyProvider(capabilities: number): boolean {
  return hasCapability(capabilities, Capability.Readonly);
}

export function isCaseSensitiveProvider(capabilities: number): boolean {
  return hasCapability(capabilities, Capability.CaseSensitive);
}

/**
 * Whether capability bits alone allow `operation` (ignores method presence).
 */
export function capabilityBitsAllow(
  capabilities: number,
  operation: ProviderOperation,
): boolean {
  const req = OP_REQUIREMENTS[operation];
  if (
    operation === 'stat' ||
    operation === 'readDirectory' ||
    operation === 'readFile'
  ) {
    return true;
  }
  if (isReadonlyProvider(capabilities)) {
    if (
      operation === 'writeFile' ||
      operation === 'createDirectory' ||
      operation === 'delete' ||
      operation === 'rename' ||
      operation === 'copy' ||
      operation === 'trash' ||
      operation === 'atomicWrite'
    ) {
      return false;
    }
  }
  if (operation === 'copy') {
    return (
      hasCapability(capabilities, Capability.Clone) ||
      hasCapability(capabilities, Capability.ReadWrite)
    );
  }
  if (operation === 'trash') {
    // Trash is a delete mode; needs Trash bit (and typically delete method).
    return hasCapability(capabilities, Capability.Trash);
  }
  if (operation === 'atomicWrite') {
    return hasCapability(capabilities, Capability.AtomicWrite);
  }
  return hasCapability(capabilities, req.bits);
}

/**
 * Whether the provider instance implements the method for `operation`.
 * Core methods (stat/readDirectory/readFile) always count as present.
 */
export function providerHasMethod(
  provider: Partial<FileSystemProvider> | null | undefined,
  operation: ProviderOperation,
): boolean {
  if (
    operation === 'stat' ||
    operation === 'readDirectory' ||
    operation === 'readFile'
  ) {
    return true;
  }
  if (operation === 'trash') {
    // Trash is delete({ trash: true }); needs delete method.
    return typeof provider?.delete === 'function';
  }
  if (operation === 'atomicWrite') {
    return typeof provider?.writeFile === 'function';
  }
  const method = OP_METHOD[operation];
  if (method === undefined) return true;
  return typeof provider?.[method] === 'function';
}

/**
 * Whether `operation` is allowed under the capability mask **and** the
 * corresponding method exists when a provider instance is supplied.
 *
 * Prefer `providerSupportsOperation(provider, op)` for real gates.
 */
export function providerSupports(
  capabilities: number,
  operation: ProviderOperation,
  provider?: Partial<FileSystemProvider> | null,
): boolean {
  if (!capabilityBitsAllow(capabilities, operation)) return false;
  if (provider !== undefined && provider !== null) {
    return providerHasMethod(provider, operation);
  }
  return true;
}

/** Full instance-aware support check (bits + method). */
export function providerSupportsOperation(
  provider: Pick<FileSystemProvider, 'capabilities'> &
    Partial<FileSystemProvider>,
  operation: ProviderOperation,
): boolean {
  return providerSupports(provider.capabilities, operation, provider);
}

export function describeUnsupported(
  capabilities: number,
  operation: ProviderOperation,
  provider?: Partial<FileSystemProvider> | null,
): UnsupportedOperationInfo {
  const req = OP_REQUIREMENTS[operation];
  let message: string;
  if (isReadonlyProvider(capabilities) && !capabilityBitsAllow(capabilities, operation)) {
    message = `Provider is read-only; cannot ${req.label}`;
  } else if (
    provider !== undefined &&
    provider !== null &&
    capabilityBitsAllow(capabilities, operation) &&
    !providerHasMethod(provider, operation)
  ) {
    message = `Provider does not implement ${req.label}`;
  } else {
    message = `Provider does not support ${req.label} (missing capability bits 0x${req.bits.toString(16)})`;
  }
  return {
    operation,
    code: 'EUNSUPPORTED',
    message,
    requiredCapabilities: req.bits,
    actualCapabilities: capabilities,
  };
}

/**
 * Throw `FileSystemError(EUNSUPPORTED)` when the operation is not advertised
 * or the method is missing.
 */
export function requireCapability(
  provider: Pick<FileSystemProvider, 'capabilities' | 'scheme'> &
    Partial<FileSystemProvider>,
  operation: ProviderOperation,
): void {
  if (providerSupportsOperation(provider, operation)) return;
  const info = describeUnsupported(
    provider.capabilities,
    operation,
    provider,
  );
  throw new FileSystemError(
    info.code,
    `${info.message} [scheme=${provider.scheme}]`,
  );
}

/** Human labels for bits present in a mask (telemetry / UI tooltips). */
export function capabilityLabels(capabilities: number): readonly string[] {
  const out: string[] = [];
  if (hasCapability(capabilities, Capability.ReadWrite)) out.push('readWrite');
  if (hasCapability(capabilities, Capability.CaseSensitive))
    out.push('caseSensitive');
  if (hasCapability(capabilities, Capability.Readonly)) out.push('readonly');
  if (hasCapability(capabilities, Capability.Trash)) out.push('trash');
  if (hasCapability(capabilities, Capability.AtomicWrite)) out.push('atomicWrite');
  if (hasCapability(capabilities, Capability.Watch)) out.push('watch');
  if (hasCapability(capabilities, Capability.Stream)) out.push('stream');
  if (hasCapability(capabilities, Capability.Clone)) out.push('clone');
  if (hasCapability(capabilities, Capability.Realpath)) out.push('realpath');
  if (hasCapability(capabilities, Capability.FileLock)) out.push('fileLock');
  return out;
}
