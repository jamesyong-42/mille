//! In-memory undo journal for explorer mutations (Phase 4.4).
//!
//! Tracks create / rename / move / soft-delete operations so `undo()` can
//! reverse the most recent undoable action. Permanent deletes are recorded
//! as non-undoable descriptors for diagnostics only (they do not occupy the
//! undo stack).

use std::collections::VecDeque;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use mille_core::EntryId;
use napi_derive::napi;

const DEFAULT_CAPACITY: usize = 64;

#[derive(Clone, Debug)]
pub(crate) enum JournalKind {
    Create {
        entry_id: EntryId,
        path: PathBuf,
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
    /// Soft-delete into workspace `.mille-trash` — fully restorable.
    SoftDelete {
        original_path: PathBuf,
        recycle_path: PathBuf,
        parent_id: EntryId,
        name: String,
        was_dir: bool,
        recursive: bool,
    },
}

#[derive(Clone, Debug)]
pub(crate) struct JournalEntry {
    pub id: u64,
    pub kind: JournalKind,
    pub label: String,
    pub timestamp_ms: u64,
}

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
    next_id: u64,
    capacity: usize,
}

impl OperationJournal {
    pub fn new() -> Self {
        Self {
            stack: VecDeque::new(),
            next_id: 1,
            capacity: DEFAULT_CAPACITY,
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

    fn push(&mut self, kind: JournalKind, label: String) -> u64 {
        let id = self.next_id();
        self.stack.push_back(JournalEntry {
            id,
            kind,
            label,
            timestamp_ms: Self::now_ms(),
        });
        while self.stack.len() > self.capacity {
            self.stack.pop_front();
        }
        id
    }

    pub fn push_create(&mut self, entry_id: EntryId, path: PathBuf) -> u64 {
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.to_string_lossy().into_owned());
        self.push(
            JournalKind::Create { entry_id, path },
            format!("Create {name}"),
        )
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
        self.push(
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
        self.push(
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
    ) -> u64 {
        let label = format!("Delete {name}");
        self.push(
            JournalKind::SoftDelete {
                original_path,
                recycle_path,
                parent_id,
                name,
                was_dir,
                recursive,
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

    pub fn pop(&mut self) -> Option<JournalEntry> {
        self.stack.pop_back()
    }

    pub fn clear(&mut self) {
        self.stack.clear();
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

/// Workspace-relative soft-trash root directory name.
pub(crate) const MILLE_TRASH_DIR: &str = ".mille-trash";
