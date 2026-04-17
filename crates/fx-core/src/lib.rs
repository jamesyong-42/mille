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
pub use entry::{Capability, Entry, EntryId, EntryKind};

// TODO: Phase 1 — Fs trait + InMemoryFs (Phase 2 adds RealFs)
pub mod fs;
pub use fs::{DirEntry, Fs, FsMetadata, InMemoryFs, RealFs};

// TODO: Phase 1–2 — EntryStore (sum-tree, id allocator, path index)
pub mod store;
pub use store::EntryStore;

// TODO: Phase 4 — writeSnapshot / eventsSince (here now so store can use it)
pub mod snapshot;
pub use snapshot::{StoreSnapshot, VisibleRowCount, VisibleRowOut, VisibleRowsQuery};

// TODO: Phase 2 — jwalk-based walker + coalescer
pub mod walker;
pub use walker::{
    build_ignore_matcher_from_walk, populate_store, walk, SymlinkPolicy, WalkOptions,
    WalkedEntry,
};

// TODO: Phase 2 — ripgrep `ignore` crate wrapper
pub mod ignore;
pub use crate::ignore::{IgnoreMatcher, IGNORE_FILE_NAMES};

// Phase 3 — notify + debouncer + rename pairing + volatile throttling
pub mod watcher;
pub use watcher::{RawEvent, Watcher, WatcherOptions};

// TODO: Phase 10 — nucleo fuzzy search adapter
pub mod search;

// TODO: Phase 2 — compact-folders computation
pub mod compact;
pub use compact::{compact_chain_for, is_compacted_intermediate};

// TODO: Phase 1 — FxError + ErrorCode mapping
pub mod error;
pub use error::{ErrorCode, FxError};
