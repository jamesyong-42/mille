//! Async mutation support for FileExplorer (Phase 5 commit 5.5).
//!
//! Each FileExplorer mutation method lives on `FileExplorer` directly, but
//! the supporting helpers (path resolution, stat → Entry conversion,
//! DeleteOptionsJs type) sit here so `explorer.rs` stays focused on the
//! class lifecycle.
//!
//! Design: mutations perform the OS-level operation via `tokio::fs`, then
//! reconcile the in-memory `EntryStore` by insert/rename/remove. Phase 5
//! scope is leaf-only and non-recursive — directory rename/move through
//! subtrees lands with the Phase 2 walker refactor; recursive delete
//! requires an explicit `options.recursive = true`.

use std::path::{Path, PathBuf};

use napi_derive::napi;

use fx_core::{Entry, EntryId, EntryKind, FxError, StoreSnapshot};

/// Options for `FileExplorer.delete`. Mirrors api.d.ts `DeleteOptions`.
/// `trash` is accepted but stubbed until PLAN 13.x adds per-platform trash.
#[napi(object)]
pub struct DeleteOptionsJs {
    pub trash: Option<bool>,
    pub recursive: Option<bool>,
}

/// Walk parent_ids up from `id` to a root, then join the matching root
/// PathBuf with the collected names (in forward order) to rebuild an
/// absolute filesystem path. Returns None if the chain dangles or if the
/// root's name doesn't match any of the explorer's configured roots.
///
/// Ambiguous resolution (multiple roots sharing a basename) takes
/// first-match. v0.1 doesn't store absolute paths per entry; Phase 2's
/// path-index rework will make this O(1) instead of O(depth).
pub(crate) fn resolve_entry_path(
    snap: &StoreSnapshot,
    roots: &[PathBuf],
    id: EntryId,
) -> Option<PathBuf> {
    // Walk up, collecting names. Cap hops to defend against malformed chains.
    const MAX_DEPTH: usize = 256;
    let mut names: Vec<String> = Vec::new();
    let mut cur_id = id;
    let mut root_entry_name: Option<String> = None;
    for _ in 0..MAX_DEPTH {
        let entry = snap.get(cur_id)?.as_ref();
        match entry.parent_id {
            None => {
                // Hit a root. Remember its name for root-path matching.
                root_entry_name = Some(entry.name.clone());
                break;
            }
            Some(parent) => {
                names.push(entry.name.clone());
                cur_id = parent;
            }
        }
    }
    let root_name = root_entry_name?;

    // Find the configured PathBuf root whose basename matches.
    let root_path = roots
        .iter()
        .find(|r| {
            r.file_name()
                .and_then(|n| n.to_str())
                .map(|s| s == root_name)
                .unwrap_or(false)
        })
        .cloned()?;

    // Names were collected child-first; reverse to root-first to join.
    let mut out = root_path;
    for name in names.into_iter().rev() {
        out.push(name);
    }
    Some(out)
}

/// Build an fx-core `Entry` by stat'ing `path`. The returned Entry has
/// `id = EntryId(0)` — the store's insert() overwrites with a fresh id.
pub(crate) async fn stat_to_entry(
    path: &Path,
    parent_id: Option<EntryId>,
    name: String,
) -> Result<Entry, FxError> {
    let meta = tokio::fs::symlink_metadata(path)
        .await
        .map_err(|e| crate::error::io_to_fx(e, path.to_path_buf()))?;

    let kind = if meta.is_dir() {
        EntryKind::Directory
    } else if meta.file_type().is_symlink() {
        EntryKind::Symlink
    } else if meta.is_file() {
        EntryKind::File
    } else {
        EntryKind::Unknown
    };

    let size = if kind == EntryKind::File { meta.len() } else { 0 };
    let mtime_ms = mtime_ms_from_meta(&meta);
    let ctime_ms = ctime_ms_from_meta(&meta);
    let symlink_target_is_dir = if kind == EntryKind::Symlink {
        tokio::fs::metadata(path).await.ok().map(|m| m.is_dir())
    } else {
        None
    };
    let is_readonly = meta.permissions().readonly();
    let is_hidden = name.starts_with('.');

    Ok(Entry {
        id: EntryId(0),
        parent_id,
        name,
        kind,
        size,
        mtime_ms,
        ctime_ms,
        symlink_target_is_dir,
        path_segments: None,
        is_ignored: false,
        is_readonly,
        is_hidden,
    })
}

fn mtime_ms_from_meta(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn ctime_ms_from_meta(meta: &std::fs::Metadata) -> i64 {
    meta.created()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Convert a numeric `kind` from JS (0=File, 1=Directory) into EntryKind.
/// Returns InvalidInput for anything else — create() only accepts leaves
/// and directories; symlink/unknown aren't creatable via this API.
pub(crate) fn kind_from_u8(kind: u8) -> Result<EntryKind, FxError> {
    match kind {
        0 => Ok(EntryKind::File),
        1 => Ok(EntryKind::Directory),
        _ => Err(FxError::InvalidInput(format!(
            "create() kind must be 0 (File) or 1 (Directory), got {kind}"
        ))),
    }
}
