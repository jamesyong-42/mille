# `@vibecook/mille/provider`

Phase 6.1 filesystem provider boundary — URI-first, capability-advertised
backends for non-`file` schemes. Local `FileExplorer` remains the optimized
default for on-disk workspaces; this module is for memfs, remote stubs,
tests, and hosts that need scheme dispatch before native wiring lands.

## Install usage

```ts
import {
  Capability,
  createMemoryFileSystemProvider,
  createProviderRegistry,
  createProviderTreeSession,
  createUri,
  hardenProvider,
  providerSupports,
  withOfflineGate,
  parsePlatformPath,
} from '@vibecook/mille/provider';

const mem = hardenProvider(
  createMemoryFileSystemProvider({
    files: { '/src/main.ts': 'export {}' },
    directories: ['/src'],
  }),
);

// Capability checks drive UI enablement.
if (!providerSupports(mem.capabilities, 'writeFile')) {
  disable('Save');
}

const session = createProviderTreeSession(mem);
const snap = await session.refresh();
const rows = snap.flatten(new Set([/* expanded ids */]));
```

## Surfaces

| Export | Role |
|--------|------|
| `FileSystemProvider` / `Capability` | Contract + bitmask (aligned with `api.d.ts` / Rust) |
| `createMemoryFileSystemProvider` | In-memory non-local provider |
| `createProviderRegistry` | Scheme → provider map |
| `withCapabilityGate` / `hardenProvider` | Throw `EUNSUPPORTED` when not advertised |
| `withLatency` / `withOfflineGate` | Network / reconnect simulation |
| `createProviderTreeSession` | Renderable tree walk + flatten |
| `parsePlatformPath` / `pathsEqual` | Phase 6.2 path helpers (drive, UNC, Unicode) |

## Capability policy

- **Readonly** wins: mutation ops are disabled even if other bits are set.
- **copy** requires `Clone` or `ReadWrite`.
- **trash** / **atomicWrite** / **watch** / **stream** need their bits.
- `describeUnsupported()` returns a stable message for tooltips / menus.

## Native status

`registerProvider` on the native `FileExplorer` is still reserved (scheme
dispatch in Rust). Until that ships, hosts use this TypeScript registry
alongside the local explorer for hybrid workspaces (e.g. `file:` + `memfs:`
demo roots rendered via `ProviderTreeSession`).
