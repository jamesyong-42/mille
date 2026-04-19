//! Pluggable filesystem abstraction (SPEC §4.2). Walker, watcher, and tests
//! all bind to `Fs` so Phase 2's real-fs impl drops in without churn.

use std::collections::BTreeSet;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, Ordering};

use dashmap::DashMap;
use parking_lot::Mutex;

use crate::entry::EntryKind;
use crate::error::{ErrorCode, FxError};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DirEntry {
    pub name: String,
    pub kind: EntryKind,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FsMetadata {
    pub kind: EntryKind,
    pub size: u64,
    pub mtime_ms: i64,
    pub ctime_ms: i64,
    pub is_readonly: bool,
    pub is_symlink: bool,
}

pub trait Fs: Send + Sync {
    fn read_dir(&self, path: &Path) -> Result<Vec<DirEntry>, FxError>;
    fn metadata(&self, path: &Path) -> Result<FsMetadata, FxError>;
    fn read(&self, path: &Path) -> Result<Vec<u8>, FxError>;
    fn write(&self, path: &Path, data: &[u8]) -> Result<(), FxError>;
    fn remove_file(&self, path: &Path) -> Result<(), FxError>;
    fn remove_dir_all(&self, path: &Path) -> Result<(), FxError>;
    fn rename(&self, from: &Path, to: &Path) -> Result<(), FxError>;
    fn create_dir(&self, path: &Path) -> Result<(), FxError>;
    fn create_dir_all(&self, path: &Path) -> Result<(), FxError>;
    fn symlink_metadata(&self, path: &Path) -> Result<FsMetadata, FxError>;
    fn read_link(&self, path: &Path) -> Result<PathBuf, FxError>;
    fn canonicalize(&self, path: &Path) -> Result<PathBuf, FxError>;
    fn exists(&self, path: &Path) -> bool;
}

/// Placeholder for the real filesystem impl; filled in Phase 2.
pub struct RealFs;

impl Fs for RealFs {
    fn read_dir(&self, _path: &Path) -> Result<Vec<DirEntry>, FxError> {
        Err(FxError::Unsupported("RealFs implemented in Phase 2".into()))
    }
    fn metadata(&self, _path: &Path) -> Result<FsMetadata, FxError> {
        Err(FxError::Unsupported("RealFs implemented in Phase 2".into()))
    }
    fn read(&self, _path: &Path) -> Result<Vec<u8>, FxError> {
        Err(FxError::Unsupported("RealFs implemented in Phase 2".into()))
    }
    fn write(&self, _path: &Path, _data: &[u8]) -> Result<(), FxError> {
        Err(FxError::Unsupported("RealFs implemented in Phase 2".into()))
    }
    fn remove_file(&self, _path: &Path) -> Result<(), FxError> {
        Err(FxError::Unsupported("RealFs implemented in Phase 2".into()))
    }
    fn remove_dir_all(&self, _path: &Path) -> Result<(), FxError> {
        Err(FxError::Unsupported("RealFs implemented in Phase 2".into()))
    }
    fn rename(&self, _from: &Path, _to: &Path) -> Result<(), FxError> {
        Err(FxError::Unsupported("RealFs implemented in Phase 2".into()))
    }
    fn create_dir(&self, _path: &Path) -> Result<(), FxError> {
        Err(FxError::Unsupported("RealFs implemented in Phase 2".into()))
    }
    fn create_dir_all(&self, _path: &Path) -> Result<(), FxError> {
        Err(FxError::Unsupported("RealFs implemented in Phase 2".into()))
    }
    fn symlink_metadata(&self, _path: &Path) -> Result<FsMetadata, FxError> {
        Err(FxError::Unsupported("RealFs implemented in Phase 2".into()))
    }
    fn read_link(&self, _path: &Path) -> Result<PathBuf, FxError> {
        Err(FxError::Unsupported("RealFs implemented in Phase 2".into()))
    }
    fn canonicalize(&self, _path: &Path) -> Result<PathBuf, FxError> {
        Err(FxError::Unsupported("RealFs implemented in Phase 2".into()))
    }
    fn exists(&self, _path: &Path) -> bool {
        false
    }
}

#[derive(Debug)]
enum InMemoryNode {
    File {
        data: Vec<u8>,
        mtime_ms: i64,
        ctime_ms: i64,
        readonly: bool,
    },
    Directory {
        children: BTreeSet<OsString>,
        mtime_ms: i64,
        ctime_ms: i64,
        readonly: bool,
    },
    Symlink {
        target: PathBuf,
        mtime_ms: i64,
        ctime_ms: i64,
    },
}

impl InMemoryNode {
    fn kind(&self) -> EntryKind {
        match self {
            InMemoryNode::File { .. } => EntryKind::File,
            InMemoryNode::Directory { .. } => EntryKind::Directory,
            InMemoryNode::Symlink { .. } => EntryKind::Symlink,
        }
    }

    fn metadata(&self) -> FsMetadata {
        match self {
            InMemoryNode::File {
                data,
                mtime_ms,
                ctime_ms,
                readonly,
            } => FsMetadata {
                kind: EntryKind::File,
                size: data.len() as u64,
                mtime_ms: *mtime_ms,
                ctime_ms: *ctime_ms,
                is_readonly: *readonly,
                is_symlink: false,
            },
            InMemoryNode::Directory {
                mtime_ms,
                ctime_ms,
                readonly,
                ..
            } => FsMetadata {
                kind: EntryKind::Directory,
                size: 0,
                mtime_ms: *mtime_ms,
                ctime_ms: *ctime_ms,
                is_readonly: *readonly,
                is_symlink: false,
            },
            InMemoryNode::Symlink {
                mtime_ms,
                ctime_ms,
                ..
            } => FsMetadata {
                kind: EntryKind::Symlink,
                size: 0,
                mtime_ms: *mtime_ms,
                ctime_ms: *ctime_ms,
                is_readonly: false,
                is_symlink: true,
            },
        }
    }
}

/// DashMap-backed filesystem for tests. Per-key locks are fine for unit tests;
/// mutations that touch multiple keys (rename, remove_dir_all) serialize on
/// `tree_lock` to keep parent `children` sets in sync.
pub struct InMemoryFs {
    nodes: DashMap<PathBuf, InMemoryNode>,
    tree_lock: Mutex<()>,
    clock: AtomicI64,
}

impl Default for InMemoryFs {
    fn default() -> Self {
        Self::new()
    }
}

impl InMemoryFs {
    pub fn new() -> Self {
        let fs = InMemoryFs {
            nodes: DashMap::new(),
            tree_lock: Mutex::new(()),
            clock: AtomicI64::new(1),
        };
        let now = fs.now();
        fs.nodes.insert(
            PathBuf::from("/"),
            InMemoryNode::Directory {
                children: BTreeSet::new(),
                mtime_ms: now,
                ctime_ms: now,
                readonly: false,
            },
        );
        fs
    }

    /// Monotonically-increasing fake clock. Avoids relying on wall time in tests.
    fn now(&self) -> i64 {
        self.clock.fetch_add(1, Ordering::Relaxed)
    }

    pub fn mkdir_p(&self, path: &Path) -> Result<(), FxError> {
        self.create_dir_all(path)
    }

    fn parent_of(path: &Path) -> Option<PathBuf> {
        path.parent().map(PathBuf::from)
    }

    fn file_name_os(path: &Path) -> Result<OsString, FxError> {
        path.file_name().map(|s| s.to_os_string()).ok_or_else(|| {
            FxError::InvalidInput(format!("path has no file name: {}", path.display()))
        })
    }

    fn enoent(path: &Path) -> FxError {
        FxError::Io {
            code: ErrorCode::ENOENT,
            path: path.to_path_buf(),
            source: std::io::Error::from_raw_os_error(2),
        }
    }

    fn eexist(path: &Path) -> FxError {
        FxError::Io {
            code: ErrorCode::EEXIST,
            path: path.to_path_buf(),
            source: std::io::Error::from_raw_os_error(17),
        }
    }

    fn eisdir(path: &Path) -> FxError {
        FxError::Io {
            code: ErrorCode::EISDIR,
            path: path.to_path_buf(),
            source: std::io::Error::from_raw_os_error(21),
        }
    }

    fn enotdir(path: &Path) -> FxError {
        FxError::Io {
            code: ErrorCode::ENOTDIR,
            path: path.to_path_buf(),
            source: std::io::Error::from_raw_os_error(20),
        }
    }

    /// Register `name` as a child of `parent`; caller must hold `tree_lock`.
    fn attach_child(&self, parent: &Path, name: &OsString) -> Result<(), FxError> {
        let mut entry = self
            .nodes
            .get_mut(parent)
            .ok_or_else(|| Self::enoent(parent))?;
        match &mut *entry {
            InMemoryNode::Directory {
                children, mtime_ms, ..
            } => {
                children.insert(name.clone());
                *mtime_ms = self.now();
                Ok(())
            }
            _ => Err(Self::enotdir(parent)),
        }
    }

    /// Remove `name` from the parent's children set; caller must hold `tree_lock`.
    fn detach_child(&self, parent: &Path, name: &OsString) -> Result<(), FxError> {
        let mut entry = self
            .nodes
            .get_mut(parent)
            .ok_or_else(|| Self::enoent(parent))?;
        match &mut *entry {
            InMemoryNode::Directory {
                children, mtime_ms, ..
            } => {
                children.remove(name);
                *mtime_ms = self.now();
                Ok(())
            }
            _ => Err(Self::enotdir(parent)),
        }
    }

    fn require_dir(&self, path: &Path) -> Result<(), FxError> {
        let node = self.nodes.get(path).ok_or_else(|| Self::enoent(path))?;
        match &*node {
            InMemoryNode::Directory { .. } => Ok(()),
            _ => Err(Self::enotdir(path)),
        }
    }
}

impl Fs for InMemoryFs {
    fn read_dir(&self, path: &Path) -> Result<Vec<DirEntry>, FxError> {
        let node = self.nodes.get(path).ok_or_else(|| Self::enoent(path))?;
        match &*node {
            InMemoryNode::Directory { children, .. } => {
                let names: Vec<OsString> = children.iter().cloned().collect();
                drop(node);
                let mut out = Vec::with_capacity(names.len());
                for name in names {
                    let child_path = path.join(&name);
                    if let Some(child) = self.nodes.get(&child_path) {
                        out.push(DirEntry {
                            name: name.to_string_lossy().into_owned(),
                            kind: child.kind(),
                        });
                    }
                }
                Ok(out)
            }
            _ => Err(Self::enotdir(path)),
        }
    }

    fn metadata(&self, path: &Path) -> Result<FsMetadata, FxError> {
        let node = self.nodes.get(path).ok_or_else(|| Self::enoent(path))?;
        Ok(node.metadata())
    }

    fn read(&self, path: &Path) -> Result<Vec<u8>, FxError> {
        let node = self.nodes.get(path).ok_or_else(|| Self::enoent(path))?;
        match &*node {
            InMemoryNode::File { data, .. } => Ok(data.clone()),
            InMemoryNode::Directory { .. } => Err(Self::eisdir(path)),
            InMemoryNode::Symlink { .. } => Err(FxError::Unsupported(
                "symlink read not implemented".into(),
            )),
        }
    }

    fn write(&self, path: &Path, data: &[u8]) -> Result<(), FxError> {
        let _guard = self.tree_lock.lock();
        let parent = Self::parent_of(path).ok_or_else(|| {
            FxError::InvalidInput(format!("path has no parent: {}", path.display()))
        })?;
        let name = Self::file_name_os(path)?;
        self.require_dir(&parent)?;

        let now = self.now();
        if let Some(mut existing) = self.nodes.get_mut(path) {
            match &mut *existing {
                InMemoryNode::File {
                    data: d,
                    mtime_ms,
                    ctime_ms,
                    readonly,
                } => {
                    if *readonly {
                        return Err(FxError::Io {
                            code: ErrorCode::EACCES,
                            path: path.to_path_buf(),
                            source: std::io::Error::from_raw_os_error(13),
                        });
                    }
                    *d = data.to_vec();
                    *mtime_ms = now;
                    *ctime_ms = now;
                    return Ok(());
                }
                InMemoryNode::Directory { .. } => return Err(Self::eisdir(path)),
                InMemoryNode::Symlink { .. } => {
                    return Err(FxError::Unsupported(
                        "writing through symlink not implemented".into(),
                    ))
                }
            }
        }

        self.nodes.insert(
            path.to_path_buf(),
            InMemoryNode::File {
                data: data.to_vec(),
                mtime_ms: now,
                ctime_ms: now,
                readonly: false,
            },
        );
        self.attach_child(&parent, &name)?;
        Ok(())
    }

    fn remove_file(&self, path: &Path) -> Result<(), FxError> {
        let _guard = self.tree_lock.lock();
        let parent = Self::parent_of(path).ok_or_else(|| {
            FxError::InvalidInput(format!("path has no parent: {}", path.display()))
        })?;
        let name = Self::file_name_os(path)?;

        let kind = {
            let node = self.nodes.get(path).ok_or_else(|| Self::enoent(path))?;
            node.kind()
        };
        if kind == EntryKind::Directory {
            return Err(Self::eisdir(path));
        }
        self.nodes.remove(path);
        self.detach_child(&parent, &name)?;
        Ok(())
    }

    fn remove_dir_all(&self, path: &Path) -> Result<(), FxError> {
        let _guard = self.tree_lock.lock();
        let parent = Self::parent_of(path).ok_or_else(|| {
            FxError::InvalidInput(format!("path has no parent: {}", path.display()))
        })?;
        let name = Self::file_name_os(path)?;

        let kind = {
            let node = self.nodes.get(path).ok_or_else(|| Self::enoent(path))?;
            node.kind()
        };
        if kind != EntryKind::Directory {
            return Err(Self::enotdir(path));
        }

        // Prefix-scan: collect every descendant key, then drop.
        let prefix = path.to_path_buf();
        let victims: Vec<PathBuf> = self
            .nodes
            .iter()
            .filter_map(|e| {
                let k = e.key();
                if k == &prefix || k.starts_with(&prefix) {
                    Some(k.clone())
                } else {
                    None
                }
            })
            .collect();
        for v in victims {
            self.nodes.remove(&v);
        }
        self.detach_child(&parent, &name)?;
        Ok(())
    }

    fn rename(&self, from: &Path, to: &Path) -> Result<(), FxError> {
        let _guard = self.tree_lock.lock();
        if from == to {
            return Ok(());
        }
        if !self.nodes.contains_key(from) {
            return Err(Self::enoent(from));
        }
        if self.nodes.contains_key(to) {
            return Err(Self::eexist(to));
        }
        let from_parent = Self::parent_of(from).ok_or_else(|| {
            FxError::InvalidInput(format!("from has no parent: {}", from.display()))
        })?;
        let to_parent = Self::parent_of(to).ok_or_else(|| {
            FxError::InvalidInput(format!("to has no parent: {}", to.display()))
        })?;
        self.require_dir(&to_parent)?;

        let from_name = Self::file_name_os(from)?;
        let to_name = Self::file_name_os(to)?;

        // Collect every key under from/ (including from itself), rewrite, reinsert.
        let from_buf = from.to_path_buf();
        let to_buf = to.to_path_buf();
        let movers: Vec<PathBuf> = self
            .nodes
            .iter()
            .filter_map(|e| {
                let k = e.key();
                if k == &from_buf || k.starts_with(&from_buf) {
                    Some(k.clone())
                } else {
                    None
                }
            })
            .collect();

        for old_key in movers {
            let (_, node) = self.nodes.remove(&old_key).expect("key just scanned");
            let new_key = if old_key == from_buf {
                to_buf.clone()
            } else {
                // Strip the from prefix, rebase onto to.
                let suffix = old_key
                    .strip_prefix(&from_buf)
                    .expect("prefix scan guarantees this");
                to_buf.join(suffix)
            };
            self.nodes.insert(new_key, node);
        }

        self.detach_child(&from_parent, &from_name)?;
        self.attach_child(&to_parent, &to_name)?;

        // Bump ctime on the renamed node (metadata change).
        let now = self.now();
        if let Some(mut n) = self.nodes.get_mut(&to_buf) {
            match &mut *n {
                InMemoryNode::File { ctime_ms, .. } => *ctime_ms = now,
                InMemoryNode::Directory { ctime_ms, .. } => *ctime_ms = now,
                InMemoryNode::Symlink { ctime_ms, .. } => *ctime_ms = now,
            }
        }
        Ok(())
    }

    fn create_dir(&self, path: &Path) -> Result<(), FxError> {
        let _guard = self.tree_lock.lock();
        if self.nodes.contains_key(path) {
            return Err(Self::eexist(path));
        }
        let parent = Self::parent_of(path).ok_or_else(|| {
            FxError::InvalidInput(format!("path has no parent: {}", path.display()))
        })?;
        self.require_dir(&parent)?;
        let name = Self::file_name_os(path)?;
        let now = self.now();
        self.nodes.insert(
            path.to_path_buf(),
            InMemoryNode::Directory {
                children: BTreeSet::new(),
                mtime_ms: now,
                ctime_ms: now,
                readonly: false,
            },
        );
        self.attach_child(&parent, &name)?;
        Ok(())
    }

    fn create_dir_all(&self, path: &Path) -> Result<(), FxError> {
        let _guard = self.tree_lock.lock();
        let mut cur = PathBuf::from("/");
        if !self.nodes.contains_key(&cur) {
            let now = self.now();
            self.nodes.insert(
                cur.clone(),
                InMemoryNode::Directory {
                    children: BTreeSet::new(),
                    mtime_ms: now,
                    ctime_ms: now,
                    readonly: false,
                },
            );
        }
        for component in path.components() {
            use std::path::Component;
            match component {
                Component::RootDir => {}
                Component::Normal(name) => {
                    let next = cur.join(name);
                    if let Some(n) = self.nodes.get(&next) {
                        match &*n {
                            InMemoryNode::Directory { .. } => {}
                            _ => return Err(Self::enotdir(&next)),
                        }
                    } else {
                        let now = self.now();
                        self.nodes.insert(
                            next.clone(),
                            InMemoryNode::Directory {
                                children: BTreeSet::new(),
                                mtime_ms: now,
                                ctime_ms: now,
                                readonly: false,
                            },
                        );
                        self.attach_child(&cur, &name.to_os_string())?;
                    }
                    cur = next;
                }
                // CurDir, ParentDir, Prefix: InMemoryFs sticks to absolute canonical paths.
                _ => {
                    return Err(FxError::InvalidInput(format!(
                        "unsupported path component in {}",
                        path.display()
                    )))
                }
            }
        }
        Ok(())
    }

    fn symlink_metadata(&self, path: &Path) -> Result<FsMetadata, FxError> {
        // InMemoryFs doesn't follow symlinks; same as metadata for now.
        self.metadata(path)
    }

    fn read_link(&self, path: &Path) -> Result<PathBuf, FxError> {
        let node = self.nodes.get(path).ok_or_else(|| Self::enoent(path))?;
        match &*node {
            InMemoryNode::Symlink { target, .. } => Ok(target.clone()),
            _ => Err(FxError::InvalidInput(format!(
                "not a symlink: {}",
                path.display()
            ))),
        }
    }

    fn canonicalize(&self, path: &Path) -> Result<PathBuf, FxError> {
        if self.nodes.contains_key(path) {
            Ok(path.to_path_buf())
        } else {
            Err(Self::enoent(path))
        }
    }

    fn exists(&self, path: &Path) -> bool {
        self.nodes.contains_key(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(s: &str) -> PathBuf {
        PathBuf::from(s)
    }

    #[test]
    fn write_then_read_file() {
        let fs = InMemoryFs::new();
        fs.mkdir_p(&p("/a")).unwrap();
        fs.write(&p("/a/hello.txt"), b"hi").unwrap();
        let data = fs.read(&p("/a/hello.txt")).unwrap();
        assert_eq!(data, b"hi");
    }

    #[test]
    fn read_missing_is_enoent() {
        let fs = InMemoryFs::new();
        let err = fs.read(&p("/nope")).unwrap_err();
        assert_eq!(err.code(), ErrorCode::ENOENT);
    }

    #[test]
    fn remove_file_on_dir_is_eisdir() {
        let fs = InMemoryFs::new();
        fs.mkdir_p(&p("/a")).unwrap();
        let err = fs.remove_file(&p("/a")).unwrap_err();
        assert_eq!(err.code(), ErrorCode::EISDIR);
    }

    #[test]
    fn remove_dir_all_on_file_is_enotdir() {
        let fs = InMemoryFs::new();
        fs.mkdir_p(&p("/a")).unwrap();
        fs.write(&p("/a/f"), b"x").unwrap();
        let err = fs.remove_dir_all(&p("/a/f")).unwrap_err();
        assert_eq!(err.code(), ErrorCode::ENOTDIR);
    }

    #[test]
    fn rename_file_moves_data() {
        let fs = InMemoryFs::new();
        fs.mkdir_p(&p("/a")).unwrap();
        fs.mkdir_p(&p("/b")).unwrap();
        fs.write(&p("/a/f"), b"payload").unwrap();
        fs.rename(&p("/a/f"), &p("/b/g")).unwrap();
        assert!(!fs.exists(&p("/a/f")));
        assert_eq!(fs.read(&p("/b/g")).unwrap(), b"payload");
    }

    #[test]
    fn remove_dir_all_drops_descendants() {
        let fs = InMemoryFs::new();
        fs.mkdir_p(&p("/a/b/c")).unwrap();
        fs.write(&p("/a/b/c/f"), b"x").unwrap();
        fs.write(&p("/a/b/g"), b"y").unwrap();
        fs.remove_dir_all(&p("/a")).unwrap();
        assert!(!fs.exists(&p("/a")));
        assert!(!fs.exists(&p("/a/b")));
        assert!(!fs.exists(&p("/a/b/c")));
        assert!(!fs.exists(&p("/a/b/c/f")));
        assert!(!fs.exists(&p("/a/b/g")));
    }

    #[test]
    fn rename_dir_rewrites_all_descendants() {
        let fs = InMemoryFs::new();
        fs.mkdir_p(&p("/src/inner")).unwrap();
        fs.write(&p("/src/inner/leaf.txt"), b"data").unwrap();
        fs.write(&p("/src/root.txt"), b"top").unwrap();
        fs.rename(&p("/src"), &p("/dst")).unwrap();

        assert!(!fs.exists(&p("/src")));
        assert!(fs.exists(&p("/dst")));
        assert!(fs.exists(&p("/dst/inner")));
        assert_eq!(fs.read(&p("/dst/inner/leaf.txt")).unwrap(), b"data");
        assert_eq!(fs.read(&p("/dst/root.txt")).unwrap(), b"top");

        // Parent's children set was rewritten too.
        let listing = fs.read_dir(&p("/")).unwrap();
        let names: Vec<&str> = listing.iter().map(|d| d.name.as_str()).collect();
        assert!(names.contains(&"dst"));
        assert!(!names.contains(&"src"));
    }

    #[test]
    fn read_dir_lists_children() {
        let fs = InMemoryFs::new();
        fs.mkdir_p(&p("/a")).unwrap();
        fs.write(&p("/a/1"), b"").unwrap();
        fs.write(&p("/a/2"), b"").unwrap();
        fs.mkdir_p(&p("/a/sub")).unwrap();
        let mut entries = fs.read_dir(&p("/a")).unwrap();
        entries.sort_by(|a, b| a.name.cmp(&b.name));
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].name, "1");
        assert_eq!(entries[2].kind, EntryKind::Directory);
    }

    #[test]
    fn realfs_stubs_return_unsupported() {
        let fs = RealFs;
        let err = fs.read(&p("/")).unwrap_err();
        assert_eq!(err.code(), ErrorCode::EUNSUPPORTED);
    }

    #[test]
    fn create_dir_eexist_on_duplicate() {
        let fs = InMemoryFs::new();
        fs.create_dir(&p("/a")).unwrap();
        let err = fs.create_dir(&p("/a")).unwrap_err();
        assert_eq!(err.code(), ErrorCode::EEXIST);
    }
}
