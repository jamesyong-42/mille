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

use std::collections::{BTreeMap, HashMap, HashSet};
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

// ============================================================================
// events_since — resume-diff walk (commit 4.4).
// ============================================================================

/// Event kinds emitted by the resume walk. Shaped to match
/// `watcher::FsChangeEvent` semantically so callers can forward into the
/// same downstream pipeline.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResumeEvent {
    /// Path exists now but didn't in the snapshot.
    Appeared { path: PathBuf },
    /// Path was in the snapshot but no longer exists.
    Disappeared { path: PathBuf },
    /// Path exists in both but mtime / size differs.
    Modified { path: PathBuf },
    /// Root itself disappeared — caller should treat subtree as gone.
    RootDisappeared { root: PathBuf },
}

/// Materialize the absolute path of an entry by walking up its parent chain
/// until we hit a root. Snapshots store the root's on-disk path on
/// `RootStat`; intermediate entries only carry their segment name, so we
/// join `root_stats[idx].path + segment-chain`.
///
/// Returns None if the id isn't in the snapshot, or if the ancestor chain
/// is cyclic / terminates in a non-root (shouldn't happen for snapshots
/// produced by `write_snapshot`).
fn entry_path(snap: &ResumeSnapshot, id: EntryId) -> Option<PathBuf> {
    // Depth cap mirrors snapshot::MAX_ANCESTOR_WALK — defends against cycles.
    const MAX_HOPS: usize = 128;

    // Walk up, collecting segments child→root. Stop when we hit an entry
    // whose parent_id is None (a root in the store sense).
    let mut segments: Vec<&str> = Vec::new();
    let mut cur = id;
    let mut root_id: Option<EntryId> = None;
    for _ in 0..MAX_HOPS {
        let entry = snap.entries.get(&cur)?;
        segments.push(entry.name.as_str());
        match entry.parent_id {
            None => {
                root_id = Some(cur);
                break;
            }
            Some(p) => cur = p,
        }
    }
    let root_id = root_id?;

    // Find the on-disk path of this root via its position in snap.roots.
    let root_pos = snap.roots.iter().position(|&r| r == root_id)?;
    let root_path = snap.root_stats.get(root_pos).map(|rs| rs.path.clone())?;

    // segments is child→root-segment. Drop the root segment (last pushed) —
    // its on-disk path comes from RootStat, not from the entry's own name.
    segments.pop();
    segments.reverse();

    let mut out = root_path;
    for seg in segments {
        out.push(seg);
    }
    Some(out)
}

/// Walk each root in the snapshot and diff it against the current on-disk
/// state. Returns the set of events a just-resumed watcher would need to
/// emit to bring subscribers up to date. Output is sorted by (variant,
/// path) so replay into the event pipeline is deterministic.
pub fn events_since(snap: &ResumeSnapshot) -> Result<Vec<ResumeEvent>, FxError> {
    use crate::walker::{walk, WalkOptions};

    let mut out: Vec<ResumeEvent> = Vec::new();

    // Build the snapshot path-set once: (mtime_ms, size) keyed by absolute
    // path. Entries whose path can't be materialized (unreachable from any
    // root) are skipped — they can't be diffed against disk either way.
    let mut snap_paths: HashMap<PathBuf, (i64, u64)> =
        HashMap::with_capacity(snap.entries.len());
    for (id, entry) in snap.entries.iter() {
        if let Some(p) = entry_path(snap, *id) {
            snap_paths.insert(p, (entry.mtime_ms, entry.size));
        }
    }

    for root_stat in &snap.root_stats {
        let root = &root_stat.path;

        // Root-gone short-circuit: before walking, check the root itself.
        // Missing root → emit RootDisappeared and skip per-entry diffing for
        // this subtree (would otherwise flood with Disappeared events).
        if !root.exists() {
            out.push(ResumeEvent::RootDisappeared { root: root.clone() });
            continue;
        }

        let walked = match walk(
            root,
            WalkOptions {
                include_hidden: true,
                include_root: true,
                ..WalkOptions::default()
            },
        ) {
            Ok(w) => w,
            Err(FxError::Io { code: ErrorCode::ENOENT, .. }) => {
                out.push(ResumeEvent::RootDisappeared { root: root.clone() });
                continue;
            }
            Err(e) => return Err(e),
        };

        // Collect the disk view keyed by absolute path.
        let mut disk_paths: HashMap<PathBuf, (i64, u64)> =
            HashMap::with_capacity(walked.len());
        for w in &walked {
            disk_paths.insert(w.path.clone(), (w.mtime_ms, w.size));
        }

        // Scope the snapshot-side path-set to this root's subtree so we
        // don't mis-flag entries from sibling roots as Disappeared here.
        let snap_subtree: HashSet<&PathBuf> = snap_paths
            .keys()
            .filter(|p| p.starts_with(root))
            .collect();

        // Appeared: on disk, not in snapshot.
        for p in disk_paths.keys() {
            if !snap_paths.contains_key(p) {
                out.push(ResumeEvent::Appeared { path: p.clone() });
            }
        }

        // Disappeared + Modified.
        for snap_p in snap_subtree {
            match disk_paths.get(snap_p) {
                None => out.push(ResumeEvent::Disappeared { path: snap_p.clone() }),
                Some(&(disk_mtime, disk_size)) => {
                    let (snap_mtime, snap_size) = snap_paths[snap_p];
                    if disk_mtime != snap_mtime || disk_size != snap_size {
                        out.push(ResumeEvent::Modified { path: snap_p.clone() });
                    }
                }
            }
        }
    }

    // Deterministic output so replay into the event pipeline is stable.
    out.sort_by(|a, b| {
        fn key(e: &ResumeEvent) -> (u8, &Path) {
            match e {
                ResumeEvent::Appeared { path } => (0, path),
                ResumeEvent::Disappeared { path } => (1, path),
                ResumeEvent::Modified { path } => (2, path),
                ResumeEvent::RootDisappeared { root } => (3, root),
            }
        }
        key(a).cmp(&key(b))
    });

    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entry::{Entry, EntryId, EntryKind};
    use crate::store::EntryStore;
    use crate::walker::{walk, WalkOptions};
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};
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

    // ===== events_since tests (commit 4.4) =====

    /// Walk a real directory, populate an EntryStore, build a ResumeSnapshot.
    fn snapshot_of_real_dir(root: &Path) -> ResumeSnapshot {
        let store = EntryStore::new();
        let walked = walk(
            root,
            WalkOptions {
                include_hidden: true,
                include_root: true,
                ..WalkOptions::default()
            },
        )
        .unwrap();
        crate::walker::populate_store(&store, root, &walked, None).unwrap();

        // populate_store drained the id counter; the next_entry_id we report
        // is the count of entries allocated (ids 0, 1, ... N-1).
        let counter = AtomicU64::new(walked.len() as u64);

        let snap = store.snapshot();
        let root_mtime = fs::metadata(root)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let root_stats = vec![RootStat {
            path: root.to_path_buf(),
            mtime_ms: root_mtime,
        }];

        snapshot_to_resume(&snap, counter.load(Ordering::Relaxed), &root_stats)
    }

    #[test]
    fn events_since_empty_when_nothing_changed() {
        let td = TempDir::new().unwrap();
        fs::write(td.path().join("a.txt"), b"hi").unwrap();
        fs::create_dir(td.path().join("sub")).unwrap();
        fs::write(td.path().join("sub").join("b.txt"), b"world").unwrap();

        let snap = snapshot_of_real_dir(td.path());
        let events = events_since(&snap).unwrap();
        assert!(
            events.is_empty(),
            "unchanged tree must not emit events, got {events:?}"
        );
    }

    #[test]
    fn events_since_detects_new_file() {
        let td = TempDir::new().unwrap();
        fs::write(td.path().join("keep.txt"), b"hi").unwrap();
        let snap = snapshot_of_real_dir(td.path());

        fs::write(td.path().join("fresh.txt"), b"new!").unwrap();

        let events = events_since(&snap).unwrap();
        let appeared: Vec<&PathBuf> = events
            .iter()
            .filter_map(|e| match e {
                ResumeEvent::Appeared { path } => Some(path),
                _ => None,
            })
            .collect();
        assert!(
            appeared.iter().any(|p| p.ends_with("fresh.txt")),
            "expected Appeared(fresh.txt), got {events:?}"
        );
    }

    #[test]
    fn events_since_detects_deleted_file() {
        let td = TempDir::new().unwrap();
        fs::write(td.path().join("goner.txt"), b"bye").unwrap();
        fs::write(td.path().join("keeper.txt"), b"still here").unwrap();
        let snap = snapshot_of_real_dir(td.path());

        fs::remove_file(td.path().join("goner.txt")).unwrap();

        let events = events_since(&snap).unwrap();
        let gone: Vec<&PathBuf> = events
            .iter()
            .filter_map(|e| match e {
                ResumeEvent::Disappeared { path } => Some(path),
                _ => None,
            })
            .collect();
        assert!(
            gone.iter().any(|p| p.ends_with("goner.txt")),
            "expected Disappeared(goner.txt), got {events:?}"
        );
    }

    #[test]
    fn events_since_detects_modified_file() {
        let td = TempDir::new().unwrap();
        let f = td.path().join("mut.txt");
        fs::write(&f, b"v1").unwrap();
        let snap = snapshot_of_real_dir(td.path());

        // Alter size (always flags Modified even on coarse mtime filesystems).
        // Brief sleep improves mtime-diff coverage on sub-second granularity.
        std::thread::sleep(std::time::Duration::from_millis(10));
        fs::write(&f, b"v2-longer-content").unwrap();

        let events = events_since(&snap).unwrap();
        let modified: Vec<&PathBuf> = events
            .iter()
            .filter_map(|e| match e {
                ResumeEvent::Modified { path } => Some(path),
                _ => None,
            })
            .collect();
        assert!(
            modified.iter().any(|p| p.ends_with("mut.txt")),
            "expected Modified(mut.txt), got {events:?}"
        );
    }

    #[test]
    fn events_since_detects_root_gone() {
        let td = TempDir::new().unwrap();
        let root = td.path().join("doomed");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("a.txt"), b"bye").unwrap();

        let snap = snapshot_of_real_dir(&root);

        fs::remove_dir_all(&root).unwrap();

        let events = events_since(&snap).unwrap();
        let root_gone: Vec<&PathBuf> = events
            .iter()
            .filter_map(|e| match e {
                ResumeEvent::RootDisappeared { root } => Some(root),
                _ => None,
            })
            .collect();
        assert_eq!(
            root_gone.len(),
            1,
            "expected one RootDisappeared, got {events:?}"
        );
        assert_eq!(*root_gone[0], root);
        // No per-entry Disappeared spam — the whole subtree is folded.
        let per_entry_gone: Vec<_> = events
            .iter()
            .filter(|e| matches!(e, ResumeEvent::Disappeared { .. }))
            .collect();
        assert!(
            per_entry_gone.is_empty(),
            "root-gone short-circuits per-entry Disappeared, got {per_entry_gone:?}"
        );
    }

    #[test]
    fn events_since_handles_multiple_roots() {
        let td_a = TempDir::new().unwrap();
        let td_b = TempDir::new().unwrap();
        fs::write(td_a.path().join("a.txt"), b"A").unwrap();
        fs::write(td_b.path().join("b.txt"), b"B").unwrap();

        // Populate both roots into one EntryStore so they share the entries map.
        let store = EntryStore::new();
        for root in [td_a.path(), td_b.path()] {
            let walked = walk(
                root,
                WalkOptions {
                    include_hidden: true,
                    include_root: true,
                    ..WalkOptions::default()
                },
            )
            .unwrap();
            crate::walker::populate_store(&store, root, &walked, None).unwrap();
        }

        let snap = store.snapshot();
        let root_stats = vec![
            RootStat {
                path: td_a.path().to_path_buf(),
                mtime_ms: 0,
            },
            RootStat {
                path: td_b.path().to_path_buf(),
                mtime_ms: 0,
            },
        ];
        let resume = snapshot_to_resume(&snap, 0, &root_stats);

        // Mutate only root A; root B stays untouched.
        fs::write(td_a.path().join("new.txt"), b"x").unwrap();

        let events = events_since(&resume).unwrap();
        let in_b: Vec<_> = events
            .iter()
            .filter(|e| match e {
                ResumeEvent::Appeared { path }
                | ResumeEvent::Disappeared { path }
                | ResumeEvent::Modified { path } => path.starts_with(td_b.path()),
                ResumeEvent::RootDisappeared { root } => root.starts_with(td_b.path()),
            })
            .collect();

        assert!(
            events.iter().any(|e| matches!(
                e,
                ResumeEvent::Appeared { path } if path.ends_with("new.txt")
            )),
            "expected Appeared(new.txt) in root A, got {events:?}"
        );
        assert!(in_b.is_empty(), "root B should have no events, got {in_b:?}");
    }
}
