// Sequential jwalk-based walker (Phase 2.3).
//
// Produces lightweight `WalkedEntry` records; the coalescer (2.4) converts
// these into `Entry` with allocated IDs and pushes them into `EntryStore`.
// No ignore parsing here (2.5), no parallelism (2.4), no rename/compact (2.6).

use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use jwalk::{Parallelism, WalkDir};

use crate::entry::EntryKind;
use crate::error::{ErrorCode, FxError};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SymlinkPolicy {
    /// Never descend into symlinked directories.
    Never,
    /// Always descend (risk of cycles — not recommended for real trees).
    Always,
    /// Phase 2.3: behaviorally equivalent to Never. PLAN 13.1 adds (dev,inode)
    /// dedup + ancestor-cycle detection to make this the correct default.
    Smart,
}

impl Default for SymlinkPolicy {
    fn default() -> Self {
        SymlinkPolicy::Smart
    }
}

#[derive(Clone, Debug)]
pub struct WalkOptions {
    /// Max tree depth (None = unlimited). Root is depth 0.
    pub max_depth: Option<usize>,
    pub follow_symlinks: SymlinkPolicy,
    /// When false, entries whose name starts with `.` are skipped.
    pub include_hidden: bool,
    /// If true, the walk root is returned as the first result.
    pub include_root: bool,
}

impl Default for WalkOptions {
    fn default() -> Self {
        Self {
            max_depth: None,
            follow_symlinks: SymlinkPolicy::default(),
            include_hidden: true,
            include_root: false,
        }
    }
}

#[derive(Clone, Debug)]
pub struct WalkedEntry {
    pub path: PathBuf,
    /// None only for the walk root when `include_root` is true.
    pub parent_path: Option<PathBuf>,
    pub name: String,
    pub kind: EntryKind,
    pub size: u64,
    pub mtime_ms: i64,
    pub ctime_ms: i64,
    pub is_symlink: bool,
    pub is_readonly: bool,
    pub is_hidden: bool,
    pub depth: u16,
}

pub fn walk(root: &Path, options: WalkOptions) -> Result<Vec<WalkedEntry>, FxError> {
    if !root.exists() {
        return Err(FxError::Io {
            code: ErrorCode::ENOENT,
            path: root.to_path_buf(),
            source: io::Error::from(io::ErrorKind::NotFound),
        });
    }

    let follow = matches!(options.follow_symlinks, SymlinkPolicy::Always);
    let mut builder = WalkDir::new(root)
        .parallelism(Parallelism::Serial)
        .follow_links(follow)
        .sort(true);
    if let Some(d) = options.max_depth {
        builder = builder.max_depth(d);
    }

    let mut out = Vec::new();

    for result in builder {
        let dent = match result {
            Ok(d) => d,
            // Permission-denied on a subtree: skip it and continue the walk.
            Err(_) => continue,
        };

        let depth = dent.depth();
        let is_walk_root = depth == 0;
        if is_walk_root && !options.include_root {
            continue;
        }

        let name = match dent.file_name().to_str() {
            Some(s) => s.to_string(),
            None => continue,
        };

        let is_hidden = name.starts_with('.') && !is_walk_root;
        if is_hidden && !options.include_hidden {
            continue;
        }

        let meta = match dent.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let ft = meta.file_type();
        let is_symlink = ft.is_symlink();
        let kind = if ft.is_file() {
            EntryKind::File
        } else if ft.is_dir() {
            EntryKind::Directory
        } else if is_symlink {
            EntryKind::Symlink
        } else {
            EntryKind::Unknown
        };

        let size = if ft.is_file() { meta.len() } else { 0 };
        let mtime_ms = meta
            .modified()
            .ok()
            .and_then(system_time_ms)
            .unwrap_or(0);
        let ctime_ms = ctime_ms_from_metadata(&meta).unwrap_or(mtime_ms);
        let is_readonly = meta.permissions().readonly();

        let path = dent.path();
        let parent_path = if is_walk_root {
            None
        } else {
            path.parent().map(|p| p.to_path_buf())
        };

        out.push(WalkedEntry {
            path,
            parent_path,
            name,
            kind,
            size,
            mtime_ms,
            ctime_ms,
            is_symlink,
            is_readonly,
            is_hidden,
            depth: depth as u16,
        });
    }

    Ok(out)
}

fn system_time_ms(t: SystemTime) -> Option<i64> {
    match t.duration_since(UNIX_EPOCH) {
        Ok(d) => Some(d.as_millis() as i64),
        Err(e) => Some(-(e.duration().as_millis() as i64)),
    }
}

#[cfg(unix)]
fn ctime_ms_from_metadata(m: &std::fs::Metadata) -> Option<i64> {
    use std::os::unix::fs::MetadataExt;
    let secs = m.ctime();
    let nanos = m.ctime_nsec();
    Some(secs.saturating_mul(1_000) + (nanos / 1_000_000) as i64)
}

#[cfg(not(unix))]
fn ctime_ms_from_metadata(m: &std::fs::Metadata) -> Option<i64> {
    m.created().ok().and_then(system_time_ms)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn make_file(dir: &Path, name: &str, contents: &[u8]) {
        fs::write(dir.join(name), contents).unwrap();
    }

    #[test]
    fn walk_empty_dir_returns_nothing() {
        let td = TempDir::new().unwrap();
        let entries = walk(td.path(), WalkOptions::default()).unwrap();
        assert!(entries.is_empty());
    }

    #[test]
    fn walk_flat_dir_returns_three_files() {
        let td = TempDir::new().unwrap();
        make_file(td.path(), "a", b"1");
        make_file(td.path(), "b", b"22");
        make_file(td.path(), "c", b"333");
        let entries = walk(td.path(), WalkOptions::default()).unwrap();
        assert_eq!(entries.len(), 3);
        let names: Vec<_> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["a", "b", "c"]);
    }

    #[test]
    fn walk_nested_tree_preserves_depth_and_parent() {
        let td = TempDir::new().unwrap();
        fs::create_dir_all(td.path().join("a/b")).unwrap();
        make_file(&td.path().join("a/b"), "c.txt", b"hello");

        let entries = walk(td.path(), WalkOptions::default()).unwrap();
        let by_name: std::collections::HashMap<_, _> =
            entries.iter().map(|e| (e.name.clone(), e)).collect();

        assert_eq!(by_name["a"].depth, 1);
        assert_eq!(by_name["b"].depth, 2);
        assert_eq!(by_name["c.txt"].depth, 3);
        assert_eq!(by_name["c.txt"].size, 5);
        assert_eq!(by_name["c.txt"].kind, EntryKind::File);
        assert_eq!(by_name["a"].kind, EntryKind::Directory);
        assert_eq!(by_name["b"].parent_path, Some(td.path().join("a")));
    }

    #[test]
    fn walk_skips_hidden_when_configured() {
        let td = TempDir::new().unwrap();
        make_file(td.path(), ".secret", b"x");
        make_file(td.path(), "visible", b"y");

        let opts = WalkOptions {
            include_hidden: false,
            ..Default::default()
        };
        let entries = walk(td.path(), opts).unwrap();
        let names: Vec<_> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["visible"]);
    }

    #[test]
    fn walk_includes_root_when_configured() {
        let td = TempDir::new().unwrap();
        make_file(td.path(), "a", b"");
        let opts = WalkOptions {
            include_root: true,
            ..Default::default()
        };
        let entries = walk(td.path(), opts).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].depth, 0);
        assert_eq!(entries[0].parent_path, None);
        assert_eq!(entries[0].kind, EntryKind::Directory);
    }

    #[test]
    fn walk_max_depth_excludes_deeper_entries() {
        let td = TempDir::new().unwrap();
        fs::create_dir_all(td.path().join("a/b")).unwrap();
        make_file(&td.path().join("a/b"), "c.txt", b"");

        let opts = WalkOptions {
            max_depth: Some(1),
            ..Default::default()
        };
        let entries = walk(td.path(), opts).unwrap();
        let names: Vec<_> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["a"]);
    }

    #[test]
    fn walk_missing_root_returns_enoent() {
        let td = TempDir::new().unwrap();
        let missing = td.path().join("does-not-exist");
        let err = walk(&missing, WalkOptions::default()).unwrap_err();
        assert_eq!(err.code(), ErrorCode::ENOENT);
    }

    #[test]
    fn walk_output_is_byte_sorted() {
        let td = TempDir::new().unwrap();
        make_file(td.path(), "c", b"");
        make_file(td.path(), "a", b"");
        make_file(td.path(), "b", b"");
        let entries = walk(td.path(), WalkOptions::default()).unwrap();
        let names: Vec<_> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["a", "b", "c"]);
    }

    #[test]
    fn walk_reports_file_size_accurately() {
        let td = TempDir::new().unwrap();
        make_file(
            td.path(),
            "sized",
            b"0123456789012345678901234567890123456789012",
        );
        let entries = walk(td.path(), WalkOptions::default()).unwrap();
        assert_eq!(entries[0].size, 43);
    }

    #[cfg(unix)]
    #[test]
    fn walk_marks_symlink_with_never_policy() {
        use std::os::unix::fs::symlink;
        let td = TempDir::new().unwrap();
        make_file(td.path(), "target", b"x");
        symlink(td.path().join("target"), td.path().join("link")).unwrap();

        let opts = WalkOptions {
            follow_symlinks: SymlinkPolicy::Never,
            ..Default::default()
        };
        let entries = walk(td.path(), opts).unwrap();
        let link = entries
            .iter()
            .find(|e| e.name == "link")
            .expect("link entry");
        assert!(link.is_symlink);
        assert_eq!(link.kind, EntryKind::Symlink);
    }
}
