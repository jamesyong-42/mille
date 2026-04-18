//! Crash-resume: disk-serialization of `StoreSnapshot`.
//!
//! Pairs with `snapshot.rs` (in-memory types live there). SPEC §9.4:
//! mirror of @parcel/watcher's writeSnapshot + getEventsSince pattern, but
//! file-format and walk use our own crates. Phase 4.4 (next commit) adds
//! the resume-diff walker that reconciles a loaded snapshot against the
//! current on-disk state.
//!
//! Write path is tmp-file + fsync + atomic rename so a mid-crash partial
//! write never replaces a valid snapshot. Format-version gate rejects
//! future-version snapshots with FxError::Unsupported rather than silently
//! misinterpreting bytes.

use std::collections::BTreeMap;
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use bincode::config as bincode_config;
use serde::{Deserialize, Serialize};

use crate::entry::{Entry, EntryId};
use crate::error::{ErrorCode, FxError};
use crate::snapshot::StoreSnapshot;

/// Bump when the on-disk shape changes in a way that makes older readers
/// unsafe. Callers get `FxError::Unsupported` on mismatch.
pub const CURRENT_FORMAT_VERSION: u32 = 1;

/// Stable bincode config. The workspace is pinned to bincode 2.x; the
/// `standard()` preset is the same one `entry.rs` already round-trips with,
/// so Entry encoding stays byte-compatible.
fn bincode_cfg() -> bincode_config::Configuration {
    bincode_config::standard()
}

/// Per-root stat snapshot used by `events_since` to detect changes since
/// the snapshot was taken. We capture mtime at root granularity; per-entry
/// diffing happens against the `entries` map directly.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct RootStat {
    pub path: PathBuf,
    pub mtime_ms: i64,
}

/// On-disk snapshot format. Versioned so future format bumps fail loudly
/// rather than silently. Shape mirrors `StoreSnapshot` but with plain
/// owned containers (no Arc, no SmallVec) so serde/bincode can drive it
/// mechanically.
#[derive(Serialize, Deserialize, Debug)]
pub struct ResumeSnapshot {
    pub format_version: u32,
    pub mille_version: String,
    pub created_ms: i64,
    pub tree_version: u64,
    pub roots: Vec<EntryId>,
    pub entries: BTreeMap<EntryId, Entry>,
    pub children: BTreeMap<EntryId, Vec<EntryId>>,
    pub direct_child_counts: BTreeMap<EntryId, u32>,
    pub descendant_visible_counts: BTreeMap<EntryId, u32>,
    pub descendant_total_sizes: BTreeMap<EntryId, u64>,
    /// The next EntryId the allocator would have returned. Callers seed
    /// their id_counter with this on restore.
    pub next_entry_id: u64,
    pub root_stats: Vec<RootStat>,
}

/// Convert an in-memory `StoreSnapshot` + allocator/root-stat metadata
/// into the serde-ready `ResumeSnapshot`. Deref Arc<Entry> into owned
/// `Entry` so bincode can encode without chasing pointers.
pub(crate) fn snapshot_to_resume(
    snap: &StoreSnapshot,
    next_entry_id: u64,
    root_stats: &[RootStat],
) -> ResumeSnapshot {
    let mut entries: BTreeMap<EntryId, Entry> = BTreeMap::new();
    for (id, arc) in snap.entries_iter() {
        entries.insert(id, (**arc).clone());
    }

    let mut children: BTreeMap<EntryId, Vec<EntryId>> = BTreeMap::new();
    let mut direct_child_counts: BTreeMap<EntryId, u32> = BTreeMap::new();
    let mut descendant_visible_counts: BTreeMap<EntryId, u32> = BTreeMap::new();
    let mut descendant_total_sizes: BTreeMap<EntryId, u64> = BTreeMap::new();

    for (id, _) in snap.entries_iter() {
        let kids = snap.children_of(id);
        if !kids.is_empty() {
            children.insert(id, kids.to_vec());
        }
        if let Some(c) = snap.direct_child_count(id) {
            direct_child_counts.insert(id, c);
        }
        descendant_visible_counts.insert(id, snap.subtree_visible_count(id));
        descendant_total_sizes.insert(id, snap.subtree_total_size(id));
    }

    ResumeSnapshot {
        format_version: CURRENT_FORMAT_VERSION,
        mille_version: env!("CARGO_PKG_VERSION").to_string(),
        created_ms: now_ms(),
        tree_version: snap.tree_version(),
        roots: snap.roots().to_vec(),
        entries,
        children,
        direct_child_counts,
        descendant_visible_counts,
        descendant_total_sizes,
        next_entry_id,
        root_stats: root_stats.to_vec(),
    }
}

fn now_ms() -> i64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_millis() as i64,
        Err(e) => -(e.duration().as_millis() as i64),
    }
}

/// Serialize a `StoreSnapshot` to disk at `path`. Atomic: writes to
/// `path.tmp`, fsyncs, renames over `path`. A crash mid-write leaves the
/// previous valid snapshot intact; the tmp file is best-effort cleaned up
/// on any failure.
pub fn write_snapshot(
    snap: &StoreSnapshot,
    next_entry_id: u64,
    root_stats: &[RootStat],
    path: &Path,
) -> Result<(), FxError> {
    // Require parent to exist — creating it would silently mask a misconfigured
    // caller-supplied path.
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            return Err(FxError::Io {
                code: ErrorCode::ENOENT,
                path: parent.to_path_buf(),
                source: std::io::Error::from(std::io::ErrorKind::NotFound),
            });
        }
    }

    let resume = snapshot_to_resume(snap, next_entry_id, root_stats);
    let bytes = bincode::serde::encode_to_vec(&resume, bincode_cfg())
        .map_err(|e| FxError::InternalBug(format!("bincode encode: {e}")))?;

    let tmp_path = path.with_extension("tmp");

    // Cleanup-on-failure closure: best-effort unlink of the tmp file.
    let cleanup = || {
        let _ = std::fs::remove_file(&tmp_path);
    };

    let write_result = (|| -> Result<(), FxError> {
        let mut f =
            File::create(&tmp_path).map_err(|e| ErrorCode::from_io_error(&e, tmp_path.clone()))?;
        f.write_all(&bytes)
            .map_err(|e| ErrorCode::from_io_error(&e, tmp_path.clone()))?;
        f.sync_all()
            .map_err(|e| ErrorCode::from_io_error(&e, tmp_path.clone()))?;
        Ok(())
    })();

    if let Err(e) = write_result {
        cleanup();
        return Err(e);
    }

    if let Err(e) = std::fs::rename(&tmp_path, path) {
        let err = ErrorCode::from_io_error(&e, path.to_path_buf());
        cleanup();
        return Err(err);
    }

    Ok(())
}

/// Load a `ResumeSnapshot` from disk. Returns `FxError::Unsupported` if the
/// on-disk format_version doesn't match `CURRENT_FORMAT_VERSION`.
pub fn read_snapshot(path: &Path) -> Result<ResumeSnapshot, FxError> {
    let mut f = File::open(path).map_err(|e| ErrorCode::from_io_error(&e, path.to_path_buf()))?;
    let mut bytes = Vec::new();
    f.read_to_end(&mut bytes)
        .map_err(|e| ErrorCode::from_io_error(&e, path.to_path_buf()))?;

    let (resume, _used): (ResumeSnapshot, usize) =
        bincode::serde::decode_from_slice(&bytes, bincode_cfg())
            .map_err(|e| FxError::InternalBug(format!("bincode decode: {e}")))?;

    if resume.format_version != CURRENT_FORMAT_VERSION {
        return Err(FxError::Unsupported(format!(
            "snapshot format v{}, expected v{}",
            resume.format_version, CURRENT_FORMAT_VERSION
        )));
    }

    Ok(resume)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entry::{Entry, EntryId, EntryKind};
    use crate::store::EntryStore;
    use std::fs;
    use tempfile::TempDir;

    // Helper: shove a small tree into a fresh EntryStore. Returns the
    // EntryStore and the allocated root id.
    fn build_small_tree() -> (EntryStore, EntryId) {
        let store = EntryStore::new();
        let root = store
            .insert(
                "/root".into(),
                Entry {
                    id: EntryId(0),
                    parent_id: None,
                    name: "root".into(),
                    kind: EntryKind::Directory,
                    size: 0,
                    mtime_ms: 100,
                    ctime_ms: 100,
                    symlink_target_is_dir: None,
                    path_segments: None,
                    is_ignored: false,
                    is_readonly: false,
                    is_hidden: false,
                },
            )
            .unwrap();
        store
            .insert(
                "/root/a".into(),
                Entry {
                    id: EntryId(0),
                    parent_id: Some(root),
                    name: "a".into(),
                    kind: EntryKind::File,
                    size: 42,
                    mtime_ms: 200,
                    ctime_ms: 200,
                    symlink_target_is_dir: None,
                    path_segments: None,
                    is_ignored: false,
                    is_readonly: false,
                    is_hidden: false,
                },
            )
            .unwrap();
        (store, root)
    }

    #[test]
    fn write_then_read_roundtrip() {
        let (store, _root) = build_small_tree();
        let snap = store.snapshot();
        let td = TempDir::new().unwrap();
        let path = td.path().join("snap.bin");

        let root_stats = vec![RootStat {
            path: "/root".into(),
            mtime_ms: 100,
        }];

        write_snapshot(&snap, 99, &root_stats, &path).unwrap();
        let loaded = read_snapshot(&path).unwrap();

        assert_eq!(loaded.format_version, CURRENT_FORMAT_VERSION);
        assert_eq!(loaded.tree_version, snap.tree_version());
        assert_eq!(loaded.roots, snap.roots().to_vec());
        assert_eq!(loaded.entries.len(), snap.entry_count());
        assert_eq!(loaded.next_entry_id, 99);
        assert_eq!(loaded.root_stats, root_stats);
    }

    #[test]
    fn write_is_atomic_on_rename_success() {
        let (store, _root) = build_small_tree();
        let snap = store.snapshot();
        let td = TempDir::new().unwrap();
        let path = td.path().join("snap.bin");

        write_snapshot(&snap, 0, &[], &path).unwrap();

        assert!(path.exists(), "final snapshot file must exist");
        assert!(
            !path.with_extension("tmp").exists(),
            "tmp must be gone after successful rename"
        );
    }

    #[test]
    fn read_from_missing_path_errors() {
        let td = TempDir::new().unwrap();
        let missing = td.path().join("does-not-exist.bin");
        let err = read_snapshot(&missing).unwrap_err();
        assert_eq!(err.code(), ErrorCode::ENOENT);
    }

    #[test]
    fn read_format_version_mismatch_errors() {
        // Hand-craft a synthetic ResumeSnapshot with a bogus version and
        // write it directly so we can verify the gate.
        let td = TempDir::new().unwrap();
        let path = td.path().join("bogus.bin");

        let resume = ResumeSnapshot {
            format_version: 999,
            mille_version: "fake".into(),
            created_ms: 0,
            tree_version: 0,
            roots: vec![],
            entries: BTreeMap::new(),
            children: BTreeMap::new(),
            direct_child_counts: BTreeMap::new(),
            descendant_visible_counts: BTreeMap::new(),
            descendant_total_sizes: BTreeMap::new(),
            next_entry_id: 0,
            root_stats: vec![],
        };
        let bytes = bincode::serde::encode_to_vec(&resume, bincode_cfg()).unwrap();
        fs::write(&path, bytes).unwrap();

        let err = read_snapshot(&path).unwrap_err();
        assert!(matches!(err, FxError::Unsupported(_)), "got {err:?}");
    }

    #[test]
    fn roundtrip_preserves_tree_version_and_roots() {
        let (store, root) = build_small_tree();
        let snap = store.snapshot();
        let td = TempDir::new().unwrap();
        let path = td.path().join("snap.bin");

        write_snapshot(&snap, 0, &[], &path).unwrap();
        let loaded = read_snapshot(&path).unwrap();

        assert_eq!(loaded.tree_version, snap.tree_version());
        assert_eq!(loaded.roots, vec![root]);
    }

    #[test]
    fn roundtrip_preserves_summary_caches() {
        let (store, root) = build_small_tree();
        let snap = store.snapshot();
        let td = TempDir::new().unwrap();
        let path = td.path().join("snap.bin");

        write_snapshot(&snap, 0, &[], &path).unwrap();
        let loaded = read_snapshot(&path).unwrap();

        // Root subtree: 2 visible (root + a), 42 bytes total.
        assert_eq!(loaded.descendant_visible_counts.get(&root).copied(), Some(2));
        assert_eq!(loaded.descendant_total_sizes.get(&root).copied(), Some(42));
    }

    #[test]
    fn write_to_missing_parent_errors_enoent() {
        let (store, _root) = build_small_tree();
        let snap = store.snapshot();
        let td = TempDir::new().unwrap();
        let path = td.path().join("nope").join("snap.bin");

        let err = write_snapshot(&snap, 0, &[], &path).unwrap_err();
        assert_eq!(err.code(), ErrorCode::ENOENT);
    }
}
