// Generated-style per-platform loader. The umbrella package's
// optionalDependencies hold the per-triple binaries; we try each
// in turn based on host os + arch + libc.
//
// Convention is modelled on @napi-rs/cli's generated loader. We differ
// in two spots:
//   1. A dev-build fallback: if a `.node` sits next to the package root
//      (monorepo layout, `napi build --output-dir .`), prefer it over
//      the installed per-triple package. This keeps `pnpm run build`
//      → `pnpm test` working without publishing platform packages.
//   2. The musl check relies on `process.report.header.glibcVersionRuntime`
//      being absent; alpine containers set it to an empty string which
//      the absence-check coerces correctly.
//
// The shape of the returned binding is defined by fx-binding's NAPI
// module — `FileExplorer`, `FileReadStream`, `version`. Phase 6's
// higher-level wrappers (commits 6.4+) layer typed surfaces on top.

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function isMusl(): boolean {
  // glibc-linked Node populates `glibcVersionRuntime` in the process
  // report header; musl-linked Node leaves it undefined. This is the
  // same heuristic @napi-rs/cli's loader uses.
  try {
    const report = (
      process as unknown as {
        report?: { getReport(): { header?: { glibcVersionRuntime?: string } } };
      }
    ).report?.getReport();
    return !report?.header?.glibcVersionRuntime;
  } catch {
    return false;
  }
}

export type NativeLoadSource = 'local' | 'platform-package';

interface LoadedNative {
  readonly module: unknown;
  readonly source: NativeLoadSource;
  readonly resolvedPath: string;
}

function loadLocal(): LoadedNative | null {
  // Dev build path: the `.node` is emitted next to api.d.ts (one dir up
  // from dist/). napi-rs names Linux/Windows binaries with an ABI suffix
  // (`-gnu` / `-musl` / `-msvc`); Darwin is just `platform-arch`.
  const base = `mille.${process.platform}-${process.arch}`;
  const names = [
    `${base}.node`,
    `${base}-gnu.node`,
    `${base}-musl.node`,
    `${base}-msvc.node`,
  ];
  const roots = [join(__dirname, '..'), join(__dirname, '..', '..')];
  for (const root of roots) {
    for (const name of names) {
      const c = join(root, name);
      if (existsSync(c)) {
        return { module: require(c), source: 'local', resolvedPath: c };
      }
    }
  }
  return null;
}

function loadFromPlatformPackage(): LoadedNative | null {
  // Order matters only for linux: musl must be probed before gnu
  // because musl binaries can't dlopen into glibc Node and vice versa.
  const triples: Record<string, Record<string, string[]>> = {
    darwin: { arm64: ['darwin-arm64'], x64: ['darwin-x64'] },
    win32: { x64: ['win32-x64-msvc'], arm64: ['win32-arm64-msvc'] },
    linux: {
      x64: isMusl() ? ['linux-x64-musl'] : ['linux-x64-gnu'],
      arm64: isMusl() ? ['linux-arm64-musl'] : ['linux-arm64-gnu'],
    },
  };
  const attempts = triples[process.platform]?.[process.arch] ?? [];
  for (const triple of attempts) {
    try {
      const request = `@vibecook/mille-${triple}`;
      const resolvedPath = require.resolve(request);
      return {
        module: require(resolvedPath),
        source: 'platform-package',
        resolvedPath,
      };
    } catch {
      // Each per-triple package is an optionalDependency, so missing
      // modules are expected on mismatched hosts. Fall through.
    }
  }
  return null;
}

const loadedNative = loadLocal() ?? loadFromPlatformPackage();
if (!loadedNative) {
  throw new Error(
    `@vibecook/mille: failed to load native binary for ` +
      `${process.platform}-${process.arch}. Install the matching ` +
      `@vibecook/mille-* optional dependency or run a local dev build.`,
  );
}

// Raw napi-rs shape. Phase 6's higher-level wrapper (commits 6.4+)
// re-exports these with typed signatures and FX-reason decoding.
// The `any` for classes is deliberate — their full shape is declared
// on the TS-level wrapper and we don't want the loader to lock in a
// type that drifts from the generated d.ts.
export interface NativeBinding {
  version(): string;
  buildInfo?(): {
    readonly crateVersion: string;
    readonly profile: string;
    readonly target: string;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  FileExplorer: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  FileReadStream: any;
}

function readPackageVersion(): string {
  try {
    const packageJson = JSON.parse(
      readFileSync(join(__dirname, '..', 'package.json'), 'utf8'),
    ) as { version?: unknown };
    return typeof packageJson.version === 'string' ? packageJson.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

export const native = loadedNative.module as NativeBinding;

/** Loader-side identity, combined with the native payload by `buildIdentity()`. */
export const nativeLoadInfo = Object.freeze({
  source: loadedNative.source,
  resolvedPath: loadedNative.resolvedPath,
  packageVersion: readPackageVersion(),
});
