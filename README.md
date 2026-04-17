# mille

High-performance native libraries for Electron-based IDEs. Rust cores, typed JS surfaces, per-platform prebuilt binaries.

## Components

- `@mille/file-explorer` — embeddable file-explorer engine (walker, watcher, gitignore, snapshot/resume, fuzzy search). First component; more to come.

## Status

Pre-alpha. Nothing is published yet. Design and phasing live in `SPEC.md` and `PLAN.md` (currently in a sibling research directory; they will be copied into this repo during Phase 0).

## Repo layout

- `crates/` — Rust workspace: `fx-core` (pure), `fx-binding` (napi-rs), `fx-bench` (Criterion).
- `packages/` — npm workspace: umbrella `file-explorer` + per-platform `file-explorer-<triple>` packages that ship the prebuilt `.node` binaries.
- `.github/` — CI (build matrix across 8 triples) and release pipeline.
- `research/` — design docs (`SPEC.md`, `PLAN.md`, `api.d.ts`). Currently lives outside this repo; to be mirrored in once scaffolding stabilizes.

## Development

**Prerequisites**

- Rust stable (see `rust-toolchain.toml`)
- Node 18+ (20 recommended; CI uses 20)
- pnpm 9+

**Bootstrap**

```bash
pnpm install
cargo check --workspace
pnpm build
pnpm test
```

`pnpm build` invokes `@napi-rs/cli` to produce a `.node` for the host triple and wires it into the umbrella package for local use.

## Platforms

Published per-platform packages (see `SPEC.md` §6.2):

| Triple | Runner |
| --- | --- |
| `aarch64-apple-darwin` | `macos-14` |
| `x86_64-apple-darwin` | `macos-13` |
| `x86_64-pc-windows-msvc` | `windows-latest` |
| `aarch64-pc-windows-msvc` | `windows-latest` (cross) |
| `x86_64-unknown-linux-gnu` | `ubuntu-latest` |
| `aarch64-unknown-linux-gnu` | `ubuntu-latest` (QEMU) |
| `x86_64-unknown-linux-musl` | `ubuntu-latest` (Alpine) |
| `aarch64-unknown-linux-musl` | `ubuntu-latest` (Alpine + QEMU) |

## Release

Releases publish on pushes of `v*` tags via `.github/workflows/release.yml`. The workflow gathers all 8 platform artifacts, runs `napi pre-publish` to stamp `optionalDependencies`, and publishes the umbrella + 8 platform packages under `--access public`. An `NPM_TOKEN` secret is required; a manual `workflow_dispatch` with `dry_run: true` skips the final publish for testing.

## License

MIT — see `LICENSE`.
