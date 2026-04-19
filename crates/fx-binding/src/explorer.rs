//! FileExplorer `#[napi]` class — Phase 5 commit 5.1 skeleton.
//!
//! Construction, capabilities bitmask, tree-version read, and an async
//! dispose stub. Later waves fill in snapshot/mutation/event methods.

use std::path::PathBuf;
use std::sync::Arc;

use napi::bindgen_prelude::{Buffer, Result};
use napi::Error;
use napi_derive::napi;

use fx_core::{EntryId, EntryKind, EntryStore, FxError, Watcher};

use crate::error::{fx_error_to_napi, io_to_fx};
use crate::mutations::{
    kind_from_u8, resolve_entry_path, stat_to_entry, DeleteOptionsJs,
};
use crate::snapshot::MirrorSnapshot;
use crate::types::EntryJs;

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

    /// Create a file or directory under `parent_id`. Phase 5 scope: leaf only.
    #[napi]
    pub async fn create(
        &self,
        parent_id: i64,
        name: String,
        kind: u8,
    ) -> Result<EntryJs> {
        let kind_enum = kind_from_u8(kind).map_err(fx_error_to_napi)?;
        let parent_eid = EntryId(parent_id as u64);

        // Resolve parent path against the current snapshot.
        let snap = self.store.snapshot();
        let parent_path = resolve_entry_path(snap.as_ref(), &self.roots, parent_eid)
            .ok_or_else(|| {
                fx_error_to_napi(FxError::InvalidInput(format!(
                    "parent id {} not found in snapshot",
                    parent_id
                )))
            })?;

        let new_path = parent_path.join(&name);

        match kind_enum {
            EntryKind::Directory => tokio::fs::create_dir(&new_path)
                .await
                .map_err(|e| fx_error_to_napi(io_to_fx(e, new_path.clone())))?,
            EntryKind::File => tokio::fs::write(&new_path, b"")
                .await
                .map_err(|e| fx_error_to_napi(io_to_fx(e, new_path.clone())))?,
            _ => unreachable!("kind_from_u8 already rejected non-File/Directory"),
        }

        // Stat and insert into the store.
        let entry = stat_to_entry(&new_path, Some(parent_eid), name)
            .await
            .map_err(fx_error_to_napi)?;
        let new_id = self
            .store
            .insert(new_path, entry)
            .map_err(fx_error_to_napi)?;

        // Re-read the freshly inserted Entry so id/summary state is current.
        let arc = self
            .store
            .get_by_id(new_id)
            .ok_or_else(|| Error::from_reason("insert succeeded but id vanished"))?;
        Ok(EntryJs::from_core(arc.as_ref()))
    }

    /// Rename a leaf (file or symlink). Directory rename is deferred to the
    /// Phase 2 walker refactor — core returns Unsupported for that case.
    #[napi]
    pub async fn rename(&self, id: i64, new_name: String) -> Result<EntryJs> {
        let eid = EntryId(id as u64);
        let snap = self.store.snapshot();
        let old_path = resolve_entry_path(snap.as_ref(), &self.roots, eid)
            .ok_or_else(|| {
                fx_error_to_napi(FxError::InvalidInput(format!(
                    "id {} not found in snapshot",
                    id
                )))
            })?;
        let parent_path = old_path
            .parent()
            .map(|p| p.to_path_buf())
            .ok_or_else(|| {
                fx_error_to_napi(FxError::InvalidInput(format!(
                    "cannot rename a root: id {}",
                    id
                )))
            })?;
        let new_path = parent_path.join(&new_name);

        tokio::fs::rename(&old_path, &new_path)
            .await
            .map_err(|e| fx_error_to_napi(io_to_fx(e, old_path.clone())))?;

        self.store
            .rename(eid, new_path)
            .map_err(fx_error_to_napi)?;

        let arc = self
            .store
            .get_by_id(eid)
            .ok_or_else(|| Error::from_reason("rename succeeded but id vanished"))?;
        Ok(EntryJs::from_core(arc.as_ref()))
    }

    /// Move an entry under a new parent, optionally renaming in flight.
    /// Phase 5 scope: same leaf-only constraint as rename.
    #[napi(js_name = "move")]
    pub async fn move_entry(
        &self,
        id: i64,
        new_parent_id: i64,
        new_name: Option<String>,
    ) -> Result<EntryJs> {
        let eid = EntryId(id as u64);
        let new_parent_eid = EntryId(new_parent_id as u64);
        let snap = self.store.snapshot();

        let old_path = resolve_entry_path(snap.as_ref(), &self.roots, eid)
            .ok_or_else(|| {
                fx_error_to_napi(FxError::InvalidInput(format!(
                    "id {} not found in snapshot",
                    id
                )))
            })?;
        let new_parent_path =
            resolve_entry_path(snap.as_ref(), &self.roots, new_parent_eid).ok_or_else(
                || {
                    fx_error_to_napi(FxError::InvalidInput(format!(
                        "new_parent id {} not found in snapshot",
                        new_parent_id
                    )))
                },
            )?;

        let effective_name = new_name.unwrap_or_else(|| {
            old_path
                .file_name()
                .and_then(|n| n.to_str())
                .map(|s| s.to_string())
                .unwrap_or_default()
        });
        let new_path = new_parent_path.join(&effective_name);

        tokio::fs::rename(&old_path, &new_path)
            .await
            .map_err(|e| fx_error_to_napi(io_to_fx(e, old_path.clone())))?;

        // Store still only supports leaf rename today; reparenting to a
        // different parent lands with the Phase 2 walker refactor.
        self.store
            .rename(eid, new_path)
            .map_err(fx_error_to_napi)?;

        let arc = self
            .store
            .get_by_id(eid)
            .ok_or_else(|| Error::from_reason("move succeeded but id vanished"))?;
        Ok(EntryJs::from_core(arc.as_ref()))
    }

    /// Delete an entry. Directories with children require recursive: true.
    /// `trash` is accepted but currently falls back to permanent delete.
    #[napi]
    pub async fn delete(
        &self,
        id: i64,
        options: Option<DeleteOptionsJs>,
    ) -> Result<()> {
        let eid = EntryId(id as u64);
        let recursive = options
            .as_ref()
            .and_then(|o| o.recursive)
            .unwrap_or(false);

        let snap = self.store.snapshot();
        let path = resolve_entry_path(snap.as_ref(), &self.roots, eid).ok_or_else(|| {
            fx_error_to_napi(FxError::InvalidInput(format!(
                "id {} not found in snapshot",
                id
            )))
        })?;
        let entry = snap.get(eid).ok_or_else(|| {
            fx_error_to_napi(FxError::InvalidInput(format!("id {} vanished mid-delete", id)))
        })?;

        match entry.kind {
            EntryKind::Directory => {
                if snap.has_children(eid) && !recursive {
                    return Err(fx_error_to_napi(FxError::Unsupported(format!(
                        "delete of non-empty directory {:?} requires recursive: true",
                        path
                    ))));
                }
                if recursive {
                    tokio::fs::remove_dir_all(&path)
                        .await
                        .map_err(|e| fx_error_to_napi(io_to_fx(e, path.clone())))?;
                } else {
                    tokio::fs::remove_dir(&path)
                        .await
                        .map_err(|e| fx_error_to_napi(io_to_fx(e, path.clone())))?;
                }
            }
            _ => {
                tokio::fs::remove_file(&path)
                    .await
                    .map_err(|e| fx_error_to_napi(io_to_fx(e, path.clone())))?;
            }
        }

        // Store removal only covers this id; Phase 2 walker reconciles
        // descendants via the watcher stream.
        self.store.remove(eid);
        Ok(())
    }

    /// Copy an entry under a new parent. Phase 5 scope: file-only; a
    /// recursive directory copy lands with Phase 2's walker-backed
    /// subtree ops.
    #[napi]
    pub async fn copy(
        &self,
        id: i64,
        new_parent_id: i64,
        new_name: Option<String>,
    ) -> Result<EntryJs> {
        let eid = EntryId(id as u64);
        let new_parent_eid = EntryId(new_parent_id as u64);
        let snap = self.store.snapshot();

        let src_path = resolve_entry_path(snap.as_ref(), &self.roots, eid).ok_or_else(|| {
            fx_error_to_napi(FxError::InvalidInput(format!(
                "id {} not found in snapshot",
                id
            )))
        })?;
        let new_parent_path =
            resolve_entry_path(snap.as_ref(), &self.roots, new_parent_eid).ok_or_else(
                || {
                    fx_error_to_napi(FxError::InvalidInput(format!(
                        "new_parent id {} not found in snapshot",
                        new_parent_id
                    )))
                },
            )?;

        let src_entry = snap.get(eid).ok_or_else(|| {
            fx_error_to_napi(FxError::InvalidInput(format!("id {} vanished mid-copy", id)))
        })?;
        if src_entry.kind == EntryKind::Directory {
            return Err(fx_error_to_napi(FxError::Unsupported(
                "recursive directory copy deferred to Phase 2 walker".into(),
            )));
        }

        let effective_name = new_name.unwrap_or_else(|| src_entry.name.clone());
        let dst_path = new_parent_path.join(&effective_name);

        tokio::fs::copy(&src_path, &dst_path)
            .await
            .map_err(|e| fx_error_to_napi(io_to_fx(e, dst_path.clone())))?;

        let entry = stat_to_entry(&dst_path, Some(new_parent_eid), effective_name)
            .await
            .map_err(fx_error_to_napi)?;
        let new_id = self
            .store
            .insert(dst_path, entry)
            .map_err(fx_error_to_napi)?;

        let arc = self
            .store
            .get_by_id(new_id)
            .ok_or_else(|| Error::from_reason("copy succeeded but id vanished"))?;
        Ok(EntryJs::from_core(arc.as_ref()))
    }

    /// Read a file's contents by id. Returns a `Buffer` — JS receives a
    /// zero-copy view over the bytes (standard Node builds).
    #[napi(js_name = "readFile")]
    pub async fn read_file(&self, id: i64) -> Result<Buffer> {
        let path = self.resolve_path_for_id(id)?;
        crate::io::read_file(path).await
    }

    /// Read a file as text. Only UTF-8 is supported in v0.1; pass
    /// `encoding: "utf-8"` (or omit) — anything else returns EUNSUPPORTED.
    #[napi(js_name = "readText")]
    pub async fn read_text(&self, id: i64, encoding: Option<String>) -> Result<String> {
        let path = self.resolve_path_for_id(id)?;
        crate::io::read_text(path, encoding).await
    }

    /// Write `data` to a file by id. When `options.atomic` is true, writes
    /// through a sibling `.mille.tmp` file + rename — safe against partial
    /// writes on same-filesystem targets.
    #[napi(js_name = "writeFile")]
    pub async fn write_file(
        &self,
        id: i64,
        data: Buffer,
        options: Option<WriteFileOptionsJs>,
    ) -> Result<()> {
        let path = self.resolve_path_for_id(id)?;
        let atomic = options.and_then(|o| o.atomic).unwrap_or(false);
        crate::io::write_file(path, data.to_vec(), atomic).await
    }

    /// Teardown. Phase 5 wave 7 wires to a real shutdown sequence.
    #[napi]
    pub async fn dispose(&self) -> Result<()> {
        // TODO: Phase 5.4+ — stop watcher, flush pending changes, write snapshot.
        Ok(())
    }
}

impl FileExplorer {
    /// Shared path-resolution helper for read/write and mutation methods.
    /// Returns a ready-to-fx_error EINVAL when the id isn't in the current
    /// snapshot — same shape mutations use, so the TS wrapper can key off
    /// `FX|EINVAL|...` uniformly.
    pub(crate) fn resolve_path_for_id(&self, id: i64) -> Result<std::path::PathBuf> {
        let eid = EntryId(id as u64);
        let snap = self.store.snapshot();
        resolve_entry_path(snap.as_ref(), &self.roots, eid).ok_or_else(|| {
            fx_error_to_napi(FxError::InvalidInput(format!(
                "id {} not found in snapshot",
                id
            )))
        })
    }
}

/// Mirror of api.d.ts `WriteFileOptions`.
#[napi(object)]
pub struct WriteFileOptionsJs {
    /// When true, write to a sibling temp file and rename into place.
    pub atomic: Option<bool>,
}

/// SPEC §4.3 caps the walker budget at 8 threads. `std` has no num_cpus,
/// so approximate via `available_parallelism`.
fn num_cpus_or_8() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get().min(8))
        .unwrap_or(4)
}
