# @mille/file-explorer

High-performance file explorer library for Electron IDEs. A native Rust core
(walker, watcher, ignore matcher, snapshot + crash-resume, fuzzy search) is
exposed to Node via NAPI-RS; per-platform prebuilt binaries ship through
`optionalDependencies`, so `npm install @mille/file-explorer` resolves the
right binary for the host automatically.

The package exposes a typed `FileExplorer` wrapper, a renderer-side
`ViewportMirror` with frozen snapshots, a React hook
(`useFileExplorerSnapshot`), and a host/client pair
(`createFileExplorerHost` + `connectFileExplorer`) for the recommended
UtilityProcess architecture.

## Integration guide

See [**EMBEDDING.md**](./EMBEDDING.md) for the full integration walkthrough:
minimum-viable Node usage, the Electron UtilityProcess + MessagePort pattern
(main / utility host / preload / renderer end-to-end), React +
`@tanstack/react-virtual` viewports, decoration providers, error handling,
`electron-builder` packaging, performance tuning, and troubleshooting.

The public API surface is declared in [`api.d.ts`](./api.d.ts).

## Supported platforms

| Platform          | Optional dependency |
| ---               | --- |
| macOS arm64       | `@mille/file-explorer-darwin-arm64` |
| macOS x64         | `@mille/file-explorer-darwin-x64` |
| Windows x64       | `@mille/file-explorer-win32-x64-msvc` |
| Windows arm64     | `@mille/file-explorer-win32-arm64-msvc` |
| Linux x64 glibc   | `@mille/file-explorer-linux-x64-gnu` |
| Linux arm64 glibc | `@mille/file-explorer-linux-arm64-gnu` |
| Linux x64 musl    | `@mille/file-explorer-linux-x64-musl` |
| Linux arm64 musl  | `@mille/file-explorer-linux-arm64-musl` |

## License

MIT
