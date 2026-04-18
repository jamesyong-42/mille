//! FileExplorer `#[napi]` class — Phase 5 commit 5.1 skeleton.
//!
//! Construction, capabilities bitmask, tree-version read, and an async
//! dispose stub. Later waves fill in snapshot/mutation/event methods.

use std::path::PathBuf;
use std::sync::Arc;

use napi::bindgen_prelude::Result;
use napi::Error;
use napi_derive::napi;

use fx_core::{EntryStore, Watcher};

use crate::snapshot::MirrorSnapshot;

/// Local-mode capability bitmask advertised in Phase 5 wave 1.
/// ReadWrite (1) | CaseSensitive (2) | Watch (32) = 35.
/// Keep in sync with api.d.ts `Capability` when later waves expand.
const LOCAL_CAPABILITIES: u32 = 0b10_0011;

/// Options passed from JS when constructing FileExplorer. Mirrors
/// `ExplorerOptions` in api.d.ts. Optional fields are `Option<T>`.
#[napi(object)]
pub struct ExplorerOptionsJs {
    /// Workspace roots. Each is a `file://` URI — for Phase 5 we accept
    /// absolute filesystem paths as strings and resolve `file://` in TS.
    pub roots: Vec<String>,
    pub respect_ignore: Option<bool>,
    /// "smart" | "true" | "false". Defaults to "smart" when unset.
    pub follow_symlinks: Option<String>,
    pub walker_concurrency: Option<u32>,
    pub watch_debounce_ms: Option<u32>,
    pub compact_folders: Option<bool>,
    pub exclude_globs: Option<Vec<String>>,
    pub snapshot_path: Option<String>,
    pub max_cached_entries: Option<u32>,
}

/// Resolved form of ExplorerOptionsJs with defaults applied.
#[derive(Clone)]
pub(crate) struct ResolvedOptions {
    pub respect_ignore: bool,
    pub follow_symlinks: fx_core::SymlinkPolicy,
    pub walker_concurrency: usize,
    pub watch_debounce_ms: u64,
    pub compact_folders: bool,
    pub exclude_globs: Vec<String>,
    pub snapshot_path: Option<PathBuf>,
    pub max_cached_entries: usize,
}

/// The in-process FileExplorer. Phase 5 builds it out method by method.
#[napi]
pub struct FileExplorer {
    pub(crate) store: Arc<EntryStore>,
    pub(crate) watcher: Arc<std::sync::Mutex<Option<Watcher>>>,
    pub(crate) roots: Vec<PathBuf>,
    pub(crate) options: ResolvedOptions,
}

#[napi]
impl FileExplorer {
    #[napi(constructor)]
    pub fn new(options: ExplorerOptionsJs) -> Result<Self> {
        let roots: Vec<PathBuf> = options.roots.iter().map(PathBuf::from).collect();
        if roots.is_empty() {
            return Err(Error::from_reason(
                "FileExplorer requires at least one root",
            ));
        }
        for r in &roots {
            if !r.is_absolute() {
                return Err(Error::from_reason(format!(
                    "root must be absolute: {:?}",
                    r
                )));
            }
        }

        let resolved = ResolvedOptions {
            respect_ignore: options.respect_ignore.unwrap_or(true),
            follow_symlinks: match options.follow_symlinks.as_deref() {
                Some("true") => fx_core::SymlinkPolicy::Always,
                Some("false") => fx_core::SymlinkPolicy::Never,
                _ => fx_core::SymlinkPolicy::Smart,
            },
            walker_concurrency: options
                .walker_concurrency
                .map(|n| n as usize)
                .unwrap_or_else(num_cpus_or_8),
            watch_debounce_ms: options.watch_debounce_ms.unwrap_or(75) as u64,
            compact_folders: options.compact_folders.unwrap_or(true),
            exclude_globs: options.exclude_globs.unwrap_or_default(),
            snapshot_path: options.snapshot_path.map(PathBuf::from),
            max_cached_entries: options
                .max_cached_entries
                .map(|n| n as usize)
                .unwrap_or(500_000),
        };

        Ok(Self {
            store: Arc::new(EntryStore::new()),
            watcher: Arc::new(std::sync::Mutex::new(None)),
            roots,
            options: resolved,
        })
    }

    /// Local-mode baseline capabilities. Phase 5 wave 3+ will recompute
    /// this from provider registration once the dispatcher lands.
    #[napi(getter)]
    pub fn capabilities(&self) -> u32 {
        LOCAL_CAPABILITIES
    }

    /// Phase 5.3 replaces with ChangeSet drain + TSFN invocation.
    /// For now: returns the current store tree-version.
    #[napi(js_name = "getTreeVersion")]
    pub fn get_tree_version(&self) -> u32 {
        self.store.tree_version() as u32
    }

    /// Capture an immutable view of the tree. The inner Arc is stable
    /// between deltas, so identity comparison holds on the JS side.
    #[napi(js_name = "getSnapshot")]
    pub fn get_snapshot(&self) -> MirrorSnapshot {
        MirrorSnapshot {
            inner: self.store.snapshot(),
        }
    }

    /// Teardown. Phase 5 wave 7 wires to a real shutdown sequence.
    #[napi]
    pub async fn dispose(&self) -> Result<()> {
        // TODO: Phase 5.4+ — stop watcher, flush pending changes, write snapshot.
        Ok(())
    }
}

/// SPEC §4.3 caps the walker budget at 8 threads. `std` has no num_cpus,
/// so approximate via `available_parallelism`.
fn num_cpus_or_8() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get().min(8))
        .unwrap_or(4)
}
