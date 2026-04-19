# mille

High-performance native primitives for Electron IDEs.

## Components

### @vibecook/mille

Embeddable file-explorer engine: a Rust core drives walking, watching, and
ignore matching; a thin NAPI binding exposes it to Node; a TypeScript client
package wraps the binding with a host/renderer split, viewport-virtualised
snapshots, and a React adapter.

- Rust + NAPI core
- UtilityProcess host + renderer client split
- Viewport-virtualised mirror with frozen snapshots for React
- File watching via `notify` (debouncer + rename pairing + volatile throttling)
- Crash-resume via atomic snapshot
- Fuzzy filename search via `nucleo`
- Decoration provider API (SCM / lint / problems overlay)

## Status

v0.1 in-development. 401 tests green (204 Rust + 197 TypeScript).
See `SPEC.md`, `PLAN.md`, and `packages/mille/EMBEDDING.md`.

## Quickstart

```bash
npm install @vibecook/mille
```

```ts
import { FileExplorer } from '@vibecook/mille';

const fx = new FileExplorer({ roots: ['/path/to/workspace'] });
await fx.populateFromRoots();
```

## Repo layout

```
crates/mille-core/        Pure-Rust engine (no NAPI)
crates/mille-binding/     napi-rs bindings (cdylib)
crates/mille-bench/       Criterion benches
packages/mille/           TS client + React adapter + EMBEDDING.md
packages/mille-{triple}/  Per-platform .node binaries
research/file-explorer/   SPEC.md, PLAN.md, audit notes
```

## Development

```bash
pnpm install
cargo test --workspace
pnpm -r build
pnpm -r test
```

## Supported platforms

| Platform          | Package |
| ---               | ---     |
| macOS arm64       | `@vibecook/mille-darwin-arm64` |
| macOS x64         | `@vibecook/mille-darwin-x64` |
| Windows x64       | `@vibecook/mille-win32-x64-msvc` |
| Windows arm64     | `@vibecook/mille-win32-arm64-msvc` |
| Linux x64 glibc   | `@vibecook/mille-linux-x64-gnu` |
| Linux arm64 glibc | `@vibecook/mille-linux-arm64-gnu` |
| Linux x64 musl    | `@vibecook/mille-linux-x64-musl` |
| Linux arm64 musl  | `@vibecook/mille-linux-arm64-musl` |

The umbrella package resolves the correct binary via `optionalDependencies`.

## Documentation

- SPEC: `research/file-explorer/SPEC.md`
- PLAN: `research/file-explorer/PLAN.md`
- Embedding guide: `packages/mille/EMBEDDING.md`
- Public API: `packages/mille/api.d.ts`

## License

MIT
