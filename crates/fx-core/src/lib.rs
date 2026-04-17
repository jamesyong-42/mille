//! fx-core — pure-Rust core for the file-explorer library.
//!
//! This crate deliberately has **no** dependency on `napi`. The NAPI surface
//! lives in `fx-binding`. Keeping the engine napi-free lets us:
//!
//! - Unit-test on any target (no Node needed).
//! - Swap bindings later (WASM, CLI, alternate FFI).
//!
//! Module layout mirrors SPEC §4.1. Each module is stubbed and filled out
//! phase-by-phase per PLAN.md.

// TODO: Phase 1 — Entry, EntryKind, EntryId, Capability types
pub mod entry;

// TODO: Phase 1–2 — EntryStore (sum-tree, id allocator, path index)
pub mod store;

// TODO: Phase 2 — jwalk-based walker + coalescer
pub mod walker;

// TODO: Phase 2 — ripgrep `ignore` crate wrapper
pub mod ignore;

// TODO: Phase 3 — notify + debouncer + rename pairing + volatile throttling
pub mod watcher;

// TODO: Phase 10 — nucleo fuzzy search adapter
pub mod search;

// TODO: Phase 4 — writeSnapshot / eventsSince
pub mod snapshot;

// TODO: Phase 2 — compact-folders computation
pub mod compact;

// TODO: Phase 1 — FxError + ErrorCode mapping
pub mod error;
