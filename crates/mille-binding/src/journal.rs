//! In-memory undo journal for explorer mutations (Phase 4.4).
//!
//! Tracks create / rename / move / soft-delete operations so `undo()` can
//! reverse the most recent **undoable** action. Permanent deletes and other
//! non-undoable mutations are recorded in `last_mutation` for reporting.
//!
//! Undo identity is stronger than size alone: we journal filesystem object
//! identity (device + inode / file index) plus size, timestamps, and kind so
//! replacing a created/renamed entry with an unrelated same-size file cannot
//! be undone as if it were the original. Directory create-undo refuses when
//! the directory has gained descendants.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use mille_core::EntryId;
use napi_derive::napi;

const DEFAULT_CAPACITY: usize = 64;

/// On-disk identity of a path at journal time.
///
/// `dev` + `ino` identify the filesystem object (Unix inode / Windows file
/// index). Size and timestamps are secondary guards; directories do not rely
/// on size for content safety — undo-create requires an empty directory.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct FsIdentity {
    pub size: u64,
    pub mtime_ms: i64,
    pub ctime_ms: i64,
    /// 0 = file, 1 = directory (symlink-to-dir is not create-journaled as dir).
    pub kind: u8,
    pub dev: u64,
    pub ino: u64,
}

impl FsIdentity {
    /// Capture identity from `std::fs::Metadata` (prefer `symlink_metadata`).
    pub fn from_metadata(meta: &std::fs::Metadata, kind: u8) -> Self {
        let (dev, ino) = file_id_from_metadata(meta);
        let mtime_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let ctime_ms = creation_ms(meta);
        Self {
            size: meta.len(),
            mtime_ms,
            ctime_ms,
            kind,
            dev,
            ino,
        }
    }

    /// True when `disk` is still the same journaled object (and, for files,
    /// has not grown / shrunk). Directories ignore size for matching because
    /// directory "size" is platform-defined; emptiness is checked separately.
    pub fn matches_disk(&self, disk: &FsIdentity) -> bool {
        if self.kind != disk.kind {
            return false;
        }
        // Prefer filesystem object identity when available.
        if self.ino != 0 || self.dev != 0 {
            if self.dev != disk.dev || self.ino != disk.ino {
                return false;
            }
            // Same inode: still refuse if file length changed (in-place write).
            if self.kind == 0 && self.size != disk.size {
                return false;
            }
            return true;
        }
        // Fallback when platform cannot supply a stable file id: require size
        // and both timestamps. Weaker than inode, but better than size alone.
        if self.size != disk.size {
            return false;
        }
        if self.mtime_ms != disk.mtime_ms || self.ctime_ms != disk.ctime_ms {
            return false;
        }
        true
    }
}

#[derive(Clone, Debug)]
pub(crate) struct CreateIdentity {
    pub entry_id: EntryId,
    pub path: PathBuf,
    pub fs: FsIdentity,
    /// Open handle to the created file, held for the life of the journal
    /// entry.
    ///
    /// `(dev, ino)` is only an identity if the number cannot be handed to a
    /// different object: POSIX lets an inode be reused the moment its last
    /// link goes away, and ext4 gives the just-freed inode to the next create
    /// in that directory. An open descriptor keeps the inode allocated, so
    /// while this handle lives no other file can present the same number —
    /// which is what makes the comparison in `pinned_matches_disk` sound.
    ///
    /// `None` when the handle could not be opened; undo then refuses rather
    /// than trusting a number that may have been recycled. Directories are
    /// not pinned: their safety comes from the emptiness check.
    pub pin: Option<Arc<std::fs::File>>,
}

impl CreateIdentity {
    /// Whether `disk` is the object this entry created.
    ///
    /// With a pin, identity is exact. Without one we cannot distinguish a
    /// recycled inode from the original, so the answer is "no" — undo may
    /// delete a file, and deleting the wrong file is unrecoverable.
    pub fn pinned_matches_disk(&self, disk: &FsIdentity) -> bool {
        if self.fs.kind == 1 {
            // Directory: emptiness is the real guard, keep the metadata check.
            return self.fs.matches_disk(disk);
        }
        let Some(pin) = self.pin.as_ref() else {
            return false;
        };
        let Ok(meta) = pin.metadata() else {
            return false;
        };
        let pinned = FsIdentity::from_metadata(&meta, self.fs.kind);
        if pinned.dev == 0 && pinned.ino == 0 {
            // Platform gave us no file id, so the pin proves nothing about
            // which object the path names. Comparing the ids here would
            // reduce to "same size" — fall back to the recorded metadata,
            // which at least also requires both timestamps to match.
            return self.fs.matches_disk(disk);
        }
        // The pinned inode cannot have been reused, so equal ids here mean
        // the path still resolves to the very object we created.
        pinned.dev == disk.dev && pinned.ino == disk.ino && pinned.size == disk.size
    }
}

#[derive(Clone, Debug)]
pub(crate) enum JournalKind {
    Create {
        identity: CreateIdentity,
    },
    Rename {
        entry_id: EntryId,
        old_path: PathBuf,
        new_path: PathBuf,
        /// Identity of the entry at `new_path` after the rename.
        fs: FsIdentity,
    },
    Move {
        entry_id: EntryId,
        old_path: PathBuf,
        new_path: PathBuf,
        /// Identity of the entry at `new_path` after the move.
        fs: FsIdentity,
    },
    /// Soft-delete into managed recycle directory outside the workspace.
    SoftDelete {
        original_path: PathBuf,
        recycle_path: PathBuf,
        parent_id: EntryId,
        name: String,
        was_dir: bool,
        recursive: bool,
        /// Filesystem identity of the payload at `recycle_path` after the
        /// soft-delete rename. Undo refuses if the recycle object is replaced.
        fs: FsIdentity,
    },
}

#[derive(Clone, Debug)]
pub(crate) struct JournalEntry {
    pub id: u64,
    pub kind: JournalKind,
    pub label: String,
    pub timestamp_ms: u64,
}

#[derive(Clone)]
#[napi(object)]
pub struct UndoDescriptorJs {
    pub id: i64,
    /// `"create" | "rename" | "move" | "delete"`
    pub kind: String,
    pub label: String,
    pub undoable: bool,
    pub reason: Option<String>,
    pub timestamp_ms: i64,
}

#[napi(object)]
pub struct UndoResultJs {
    pub id: i64,
    pub kind: String,
    pub label: String,
    /// Entry id restored/created by the undo when applicable.
    pub entry_id: Option<i64>,
}

pub(crate) struct OperationJournal {
    stack: VecDeque<JournalEntry>,
    /// Most recent mutation (undoable or not) for reporting.
    last_mutation: Option<UndoDescriptorJs>,
    next_id: u64,
    capacity: usize,
    /// Soft-delete recycle roots still owned by journaled entries.
    recycle_paths: VecDeque<PathBuf>,
}

impl OperationJournal {
    pub fn new() -> Self {
        Self {
            stack: VecDeque::new(),
            last_mutation: None,
            next_id: 1,
            capacity: DEFAULT_CAPACITY,
            recycle_paths: VecDeque::new(),
        }
    }

    fn next_id(&mut self) -> u64 {
        let id = self.next_id;
        self.next_id = self.next_id.saturating_add(1);
        id
    }

    fn now_ms() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }

    fn push_undoable(&mut self, kind: JournalKind, label: String) -> u64 {
        let id = self.next_id();
        let entry = JournalEntry {
            id,
            kind: kind.clone(),
            label: label.clone(),
            timestamp_ms: Self::now_ms(),
        };
        if let JournalKind::SoftDelete { recycle_path, .. } = &kind {
            self.recycle_paths.push_back(recycle_path.clone());
        }
        let desc = entry.descriptor();
        self.last_mutation = Some(desc);
        self.stack.push_back(entry);
        while self.stack.len() > self.capacity {
            if let Some(evicted) = self.stack.pop_front() {
                Self::cleanup_evicted(&evicted);
            }
        }
        id
    }

    fn cleanup_evicted(entry: &JournalEntry) {
        if let JournalKind::SoftDelete { recycle_path, .. } = &entry.kind {
            // Best-effort: remove the recycled payload when journal capacity drops it.
            let _ = std::fs::remove_dir_all(recycle_path);
            if let Some(parent) = recycle_path.parent() {
                let _ = std::fs::remove_dir(parent);
            }
        }
    }

    pub fn record_non_undoable(&mut self, kind: &str, label: String, reason: &str) {
        let id = self.next_id();
        self.last_mutation = Some(UndoDescriptorJs {
            id: id as i64,
            kind: kind.into(),
            label,
            undoable: false,
            reason: Some(reason.to_string()),
            timestamp_ms: Self::now_ms() as i64,
        });
    }

    pub fn push_create(&mut self, identity: CreateIdentity) -> u64 {
        let name = identity
            .path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| identity.path.to_string_lossy().into_owned());
        self.push_undoable(JournalKind::Create { identity }, format!("Create {name}"))
    }

    pub fn push_rename(
        &mut self,
        entry_id: EntryId,
        old_path: PathBuf,
        new_path: PathBuf,
        fs: FsIdentity,
    ) -> u64 {
        let old_name = old_path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let new_name = new_path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        self.push_undoable(
            JournalKind::Rename {
                entry_id,
                old_path,
                new_path,
                fs,
            },
            format!("Rename {old_name} → {new_name}"),
        )
    }

    pub fn push_move(
        &mut self,
        entry_id: EntryId,
        old_path: PathBuf,
        new_path: PathBuf,
        fs: FsIdentity,
    ) -> u64 {
        let name = old_path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        self.push_undoable(
            JournalKind::Move {
                entry_id,
                old_path,
                new_path,
                fs,
            },
            format!("Move {name}"),
        )
    }

    // Mirrors the SoftDelete variant's fields one-for-one.
    #[allow(clippy::too_many_arguments)]
    pub fn push_soft_delete(
        &mut self,
        original_path: PathBuf,
        recycle_path: PathBuf,
        parent_id: EntryId,
        name: String,
        was_dir: bool,
        recursive: bool,
        fs: FsIdentity,
    ) -> u64 {
        let label = format!("Delete {name}");
        self.push_undoable(
            JournalKind::SoftDelete {
                original_path,
                recycle_path,
                parent_id,
                name,
                was_dir,
                recursive,
                fs,
            },
            label,
        )
    }

    pub fn can_undo(&self) -> bool {
        !self.stack.is_empty()
    }

    pub fn peek(&self) -> Option<&JournalEntry> {
        self.stack.back()
    }

    /// Peek without removing — for apply-then-pop undo.
    pub fn peek_owned(&self) -> Option<JournalEntry> {
        self.stack.back().cloned()
    }

    pub fn pop(&mut self) -> Option<JournalEntry> {
        self.stack.pop_back()
    }

    pub fn last_mutation(&self) -> Option<UndoDescriptorJs> {
        self.last_mutation.clone()
    }
}

impl JournalEntry {
    pub fn descriptor(&self) -> UndoDescriptorJs {
        let (kind, undoable, reason) = match &self.kind {
            JournalKind::Create { .. } => ("create", true, None),
            JournalKind::Rename { .. } => ("rename", true, None),
            JournalKind::Move { .. } => ("move", true, None),
            JournalKind::SoftDelete { .. } => ("delete", true, None),
        };
        UndoDescriptorJs {
            id: self.id as i64,
            kind: kind.into(),
            label: self.label.clone(),
            undoable,
            reason: reason.map(str::to_string),
            timestamp_ms: self.timestamp_ms as i64,
        }
    }
}

// ─── Managed recycle base (outside workspace, symlink-safe) ───────────

/// Deterministic recycle root outside any workspace: `$TMPDIR/mille-recycle/<hash>/`.
pub(crate) fn managed_recycle_base(workspace_root: &Path) -> PathBuf {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    workspace_root.hash(&mut hasher);
    let hash = hasher.finish();
    std::env::temp_dir()
        .join("mille-recycle")
        .join(format!("{hash:016x}"))
}

/// Create or open the managed recycle base without following a hijacked
/// symlink, canonicalize it, restrict permissions, and verify it does not
/// live under any workspace root.
///
/// Returns the **canonical** absolute path of the base directory.
pub(crate) fn ensure_managed_recycle_base(
    workspace_root: &Path,
    workspace_roots: &[PathBuf],
) -> Result<PathBuf, String> {
    let temp = std::env::temp_dir();
    let pool = temp.join("mille-recycle");

    // Create the pool directory carefully: refuse if the path is a symlink.
    ensure_real_directory(&pool).map_err(|e| format!("recycle pool: {e}"))?;

    let base = managed_recycle_base(workspace_root);
    ensure_real_directory(&base).map_err(|e| format!("recycle base: {e}"))?;

    // Restrict permissions so other local users cannot plant payloads.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&pool, std::fs::Permissions::from_mode(0o700));
        let _ = std::fs::set_permissions(&base, std::fs::Permissions::from_mode(0o700));
    }

    // Canonicalize after creation; fail closed if we cannot.
    let canon_base = std::fs::canonicalize(&base)
        .map_err(|e| format!("cannot canonicalize recycle base: {e}"))?;
    let canon_temp =
        std::fs::canonicalize(&temp).map_err(|e| format!("cannot canonicalize temp dir: {e}"))?;

    if !(canon_base == canon_temp || canon_base.starts_with(&canon_temp)) {
        return Err(format!(
            "managed recycle base escaped temp dir: {:?}",
            canon_base
        ));
    }

    // Must not live under a workspace root (canonical).
    for r in workspace_roots {
        let Ok(canon_root) = std::fs::canonicalize(r) else {
            // Also check lexical containment as a belt-and-suspenders guard.
            if path_is_under_lexical(&canon_base, r) {
                return Err("managed recycle base must not live under a workspace root".into());
            }
            continue;
        };
        if canon_base == canon_root || canon_base.starts_with(&canon_root) {
            return Err("managed recycle base must not live under a workspace root".into());
        }
    }

    // Final symlink check on the canonical path's own metadata.
    let meta = std::fs::symlink_metadata(&canon_base)
        .map_err(|e| format!("recycle base metadata: {e}"))?;
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return Err("managed recycle base is not a real directory".into());
    }

    Ok(canon_base)
}

/// Ensure `path` exists as a real (non-symlink) directory.
///
/// If a symlink is present at `path`, it is removed and replaced with a
/// fresh directory so a hijacker cannot redirect soft-trash.
fn ensure_real_directory(path: &Path) -> Result<(), String> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => {
            // Remove the hijack attempt. `remove_file` works for file and
            // directory symlinks on Unix; fall back to remove_dir.
            if std::fs::remove_file(path).is_err() {
                let _ = std::fs::remove_dir(path);
            }
            std::fs::create_dir(path).map_err(|e| format!("create after symlink remove: {e}"))?;
        }
        Ok(meta) if meta.is_dir() => {
            // Already a real directory.
        }
        Ok(_) => {
            return Err(format!("path exists and is not a directory: {:?}", path));
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // Create parents as real dirs too when missing.
            if let Some(parent) = path.parent() {
                if !parent.as_os_str().is_empty() {
                    ensure_real_directory(parent)?;
                }
            }
            std::fs::create_dir(path).map_err(|e| format!("create_dir: {e}"))?;
        }
        Err(e) => return Err(format!("symlink_metadata: {e}")),
    }

    // Re-check: refuse if something raced us into a symlink.
    let meta = std::fs::symlink_metadata(path).map_err(|e| format!("recheck: {e}"))?;
    if meta.file_type().is_symlink() {
        return Err(format!("path is a symlink after create: {:?}", path));
    }
    if !meta.is_dir() {
        return Err(format!("path is not a directory: {:?}", path));
    }
    Ok(())
}

/// Lexical-only prefix check (no I/O). Prefer `path_is_under` for security.
fn path_is_under_lexical(path: &Path, base: &Path) -> bool {
    path == base || path.starts_with(base)
}

/// Ensure `path` is under `base` using **canonical** paths.
///
/// Does **not** trust a bare lexical `starts_with` alone — a symlink at
/// `base` would otherwise make any child appear "under" base while landing
/// outside. When canonicalization of `path` fails (not yet fully created),
/// we canonicalize the parent and re-join the file name.
pub(crate) fn path_is_under(path: &Path, base: &Path) -> bool {
    let Ok(canon_base) = std::fs::canonicalize(base) else {
        return false;
    };
    // Base itself must not be a symlink masquerading after canonicalize
    // (canonicalize resolves the final component on most platforms).
    if let Ok(meta) = std::fs::symlink_metadata(base) {
        if meta.file_type().is_symlink() {
            return false;
        }
    }

    if let Ok(canon_path) = std::fs::canonicalize(path) {
        return canon_path == canon_base || canon_path.starts_with(&canon_base);
    }

    // Path may not exist yet (destination of rename). Check parent.
    path.parent()
        .and_then(|parent| std::fs::canonicalize(parent).ok())
        .map(|parent| {
            let candidate = parent.join(path.file_name().unwrap_or_default());
            candidate == canon_base || candidate.starts_with(&canon_base)
        })
        .unwrap_or(false)
}

// ─── Platform file identity helpers ───────────────────────────────────

fn file_id_from_metadata(meta: &std::fs::Metadata) -> (u64, u64) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        (meta.dev(), meta.ino())
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        let dev = meta.volume_serial_number().unwrap_or(0) as u64;
        let ino = meta.file_index().unwrap_or(0);
        return (dev, ino);
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = meta;
        (0, 0)
    }
}

fn creation_ms(meta: &std::fs::Metadata) -> i64 {
    meta.created()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Async helper: read identity for a path via symlink_metadata.
pub(crate) async fn capture_fs_identity(
    path: &Path,
    kind: u8,
) -> Result<FsIdentity, std::io::Error> {
    let meta = tokio::fs::symlink_metadata(path).await?;
    Ok(FsIdentity::from_metadata(&meta, kind))
}

/// True when a directory has no entries (`.` / `..` excluded by read_dir).
pub(crate) async fn directory_is_empty(path: &Path) -> Result<bool, std::io::Error> {
    let mut rd = tokio::fs::read_dir(path).await?;
    Ok(rd.next_entry().await?.is_none())
}
