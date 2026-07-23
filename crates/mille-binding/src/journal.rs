//! In-memory undo journal for explorer mutations (Phase 4.4).
//!
//! Tracks create / rename / move / soft-delete operations so `undo()` can
//! reverse the most recent **undoable** action. Permanent deletes and other
//! non-undoable mutations are recorded in `last_mutation` for reporting.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use mille_core::EntryId;
use napi_derive::napi;

const DEFAULT_CAPACITY: usize = 64;

#[derive(Clone, Debug)]
pub(crate) struct CreateIdentity {
    pub entry_id: EntryId,
    pub path: PathBuf,
    pub size: u64,
    pub mtime_ms: i64,
    pub ctime_ms: i64,
    pub kind: u8, // 0 file, 1 dir
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
    },
    Move {
        entry_id: EntryId,
        old_path: PathBuf,
        new_path: PathBuf,
    },
    /// Soft-delete into managed recycle directory outside the workspace.
    SoftDelete {
        original_path: PathBuf,
        recycle_path: PathBuf,
        parent_id: EntryId,
        name: String,
        was_dir: bool,
        recursive: bool,
        size: u64,
        mtime_ms: i64,
        ctime_ms: i64,
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

    pub fn push_rename(&mut self, entry_id: EntryId, old_path: PathBuf, new_path: PathBuf) -> u64 {
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
            },
            format!("Rename {old_name} → {new_name}"),
        )
    }

    pub fn push_move(&mut self, entry_id: EntryId, old_path: PathBuf, new_path: PathBuf) -> u64 {
        let name = old_path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        self.push_undoable(
            JournalKind::Move {
                entry_id,
                old_path,
                new_path,
            },
            format!("Move {name}"),
        )
    }

    pub fn push_soft_delete(
        &mut self,
        original_path: PathBuf,
        recycle_path: PathBuf,
        parent_id: EntryId,
        name: String,
        was_dir: bool,
        recursive: bool,
        size: u64,
        mtime_ms: i64,
        ctime_ms: i64,
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
                size,
                mtime_ms,
                ctime_ms,
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

/// Ensure `path` is under `base` after canonicalizing both when possible.
pub(crate) fn path_is_under(path: &Path, base: &Path) -> bool {
    if path == base || path.starts_with(base) {
        return true;
    }
    match (std::fs::canonicalize(path), std::fs::canonicalize(base)) {
        (Ok(p), Ok(b)) => p == b || p.starts_with(b),
        (Err(_), Ok(b)) => path
            .parent()
            .and_then(|parent| std::fs::canonicalize(parent).ok())
            .map(|parent| {
                let candidate = parent.join(path.file_name().unwrap_or_default());
                candidate == b || candidate.starts_with(&b)
            })
            .unwrap_or(false),
        _ => false,
    }
}
