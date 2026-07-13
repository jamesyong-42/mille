# mille

**Native file-explorer primitives for Electron IDEs.**

Rust walks, watches, and searches the tree. TypeScript freezes viewport snapshots. React renders hundreds of thousands of rows without breaking a sweat.

**Docs:** [jamesyong-42.github.io/mille](https://jamesyong-42.github.io/mille/) · [API reference](https://jamesyong-42.github.io/mille/api.html) · [npm](https://www.npmjs.com/package/@vibecook/mille)

[![npm](https://img.shields.io/npm/v/%40vibecook%2Fmille?style=flat-square&color=7c9cff&label=%40vibecook%2Fmille)](https://www.npmjs.com/package/@vibecook/mille)
[![npm ui](https://img.shields.io/npm/v/%40vibecook%2Fmille-ui?style=flat-square&color=4ad4b5&label=%40vibecook%2Fmille-ui)](https://www.npmjs.com/package/@vibecook/mille-ui)
[![CI](https://img.shields.io/github/actions/workflow/status/jamesyong-42/mille/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/jamesyong-42/mille/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](./LICENSE)

---

## Packages

| Package | What it is |
| --- | --- |
| [`@vibecook/mille`](https://www.npmjs.com/package/@vibecook/mille) | File-explorer **engine** — Rust core via NAPI, host/renderer split, snapshots, search, decorations |
| [`@vibecook/mille-ui`](https://www.npmjs.com/package/@vibecook/mille-ui) | React **FileTree** — virtualized ARIA tree, icons, Git badges, commands, DnD |

Platform binaries ship as optional deps (`@vibecook/mille-darwin-arm64`, …) and resolve automatically on install.

### Engine highlights

- Parallel walk + gitignore (symlink-aware for pnpm-style `node_modules`)
- Live watch with rename pairing and volatile-dir throttling
- Viewport-virtualized mirror with frozen snapshots for React
- Fuzzy filename search (`nucleo`)
- Decoration pipeline (Git, lint, agent-rules) including port / UtilityProcess fan-out
- Crash-resume via atomic snapshot

### UI highlights

- WAI-ARIA 1.2 tree, keyboard model, multi-select, rename / create
- Soft-duotone, monoline default, and Material icon themes
- Imperative `FileTreeRef` (`revealPath`, `scrollToRow`, …)
- Headless entry under a 13&nbsp;KB gzip budget

## Quickstart

```bash
pnpm add @vibecook/mille @vibecook/mille-ui
# or: npm install @vibecook/mille @vibecook/mille-ui
```

```ts
import { FileExplorer } from '@vibecook/mille';
import { FileTree } from '@vibecook/mille-ui';
import { duotoneIconTheme } from '@vibecook/mille-ui/icons/duotone';
import '@vibecook/mille-ui/tokens.css';

const fx = new FileExplorer({ roots: ['/path/to/workspace'] });
await fx.populateFromRoots();

export function Sidebar() {
  return (
    <FileTree
      fx={fx}
      ariaLabel="Files"
      rowHeight={22}
      iconTheme={duotoneIconTheme}
    />
  );
}
```

For Electron UtilityProcess host/client wiring, packaging, and performance notes see [`packages/mille/EMBEDDING.md`](./packages/mille/EMBEDDING.md).

## Documentation

| | |
| --- | --- |
| **Site** | https://jamesyong-42.github.io/mille/ |
| **API** | https://jamesyong-42.github.io/mille/api.html |
| **Icons** | https://jamesyong-42.github.io/mille/icons-preview.html |
| Embedding | [`packages/mille/EMBEDDING.md`](./packages/mille/EMBEDDING.md) |
| Types | [`packages/mille/api.d.ts`](./packages/mille/api.d.ts) |
| Changelog | [`CHANGELOG.md`](./CHANGELOG.md) |

## Status

**v0.2.1** is on npm. Soft-duotone icons, Project-view explorer fixes (expand ignored roots + directory symlinks), and the static docs site. Earlier v0.2: roots-in-deltas, lazy list-on-expand, decorations over the port, shell Git client, Material icons, `FileTreeRef`.

## Supported platforms

| Platform | Package |
| --- | --- |
| macOS arm64 | `@vibecook/mille-darwin-arm64` |
| macOS x64 | `@vibecook/mille-darwin-x64` |
| Windows x64 | `@vibecook/mille-win32-x64-msvc` |
| Windows arm64 | `@vibecook/mille-win32-arm64-msvc` |
| Linux x64 glibc | `@vibecook/mille-linux-x64-gnu` |
| Linux arm64 glibc | `@vibecook/mille-linux-arm64-gnu` |
| Linux x64 musl | `@vibecook/mille-linux-x64-musl` |
| Linux arm64 musl | `@vibecook/mille-linux-arm64-musl` |

## Repo layout

```
crates/mille-core/        Pure-Rust engine (no NAPI)
crates/mille-binding/     napi-rs bindings (cdylib)
crates/mille-bench/       Criterion benches
packages/mille/           TS client + React adapter + EMBEDDING.md
packages/mille-ui/        React FileTree companion
packages/mille-{triple}/  Per-platform .node binaries
docs/                     GitHub Pages site (index, API, icons)
apps/playground/          Electron playground
```

## Development

```bash
pnpm install
cargo test --workspace --exclude mille-binding
pnpm --filter @vibecook/mille run build:napi:debug
pnpm --filter @vibecook/mille run build:ts
pnpm -r --if-present test
```

### Release

1. Bump versions on publishable packages.
2. Tag and push: `git tag vX.Y.Z && git push origin vX.Y.Z`
3. [Release workflow](./.github/workflows/release.yml) builds all 8 NAPI targets and publishes via **npm Trusted Publishing (OIDC)** — no long-lived token.

## License

MIT
