# @mille/file-explorer

High-performance file explorer library for Electron IDEs. Native Rust core (walker, watcher, ignore matcher, sum-tree snapshot) exposed to Node via NAPI-RS, with per-platform prebuilt binaries distributed through `optionalDependencies`. Install with `npm install @mille/file-explorer` (or the pnpm/yarn equivalent) — the right binary is resolved for your platform automatically. See the main repository README at <https://github.com/jamesyong-42/mille> for architecture, roadmap, and the full public API surface in `api.d.ts`.

## Integration guide

See [**EMBEDDING.md**](./EMBEDDING.md) for the one-stop integration guide: minimum-viable Node usage, the Electron UtilityProcess + MessagePort pattern (main / utility host / preload / renderer end-to-end), React + `@tanstack/react-virtual` viewports, decoration providers, error handling, electron-builder packaging, performance tuning, and troubleshooting.
