// Phase 2.5: ripgrep `ignore` crate integration.
//
// We use the `gitignore::Gitignore` matcher directly rather than
// `ignore::WalkBuilder` — SPEC §4.3 flags WalkBuilder's API as awkward and
// hides controls we need. IgnoreMatcher is a thin stack: one Gitignore per
// `.gitignore` / `.ignore` / `.rgignore` file we've seen, checked in order.

use std::path::{Path, PathBuf};

use ignore::gitignore::{Gitignore, GitignoreBuilder};

use crate::error::{ErrorCode, FxError};

/// Filenames we treat as gitignore-format ignore files.
pub const IGNORE_FILE_NAMES: &[&str] = &[".gitignore", ".ignore", ".rgignore"];

#[derive(Default)]
pub struct IgnoreMatcher {
    matchers: Vec<(PathBuf, Gitignore)>,
}

impl IgnoreMatcher {
    pub fn new() -> Self {
        Self::default()
    }

    /// Load an ignore file from disk. `root` is the directory the ignore file
    /// lives in — paths in the file are resolved relative to it.
    pub fn add_from_file(&mut self, ignore_file: &Path) -> Result<(), FxError> {
        let root = ignore_file.parent().ok_or_else(|| FxError::InvalidInput(
            format!("ignore file {:?} has no parent directory", ignore_file),
        ))?;
        let mut builder = GitignoreBuilder::new(root);
        if let Some(e) = builder.add(ignore_file) {
            return Err(FxError::Io {
                code: ErrorCode::EINVAL,
                path: ignore_file.to_path_buf(),
                source: std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string()),
            });
        }
        let gi = builder.build().map_err(|e| FxError::Io {
            code: ErrorCode::EINVAL,
            path: ignore_file.to_path_buf(),
            source: std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string()),
        })?;
        self.matchers.push((root.to_path_buf(), gi));
        Ok(())
    }

    /// Load ignore rules from a string. Primarily for tests and callers who
    /// compute ignores programmatically. `root` is the anchor directory.
    pub fn add_from_string(&mut self, root: &Path, patterns: &str) -> Result<(), FxError> {
        let mut builder = GitignoreBuilder::new(root);
        for line in patterns.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                continue;
            }
            builder.add_line(None, trimmed).map_err(|e| FxError::Io {
                code: ErrorCode::EINVAL,
                path: root.to_path_buf(),
                source: std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string()),
            })?;
        }
        let gi = builder.build().map_err(|e| FxError::Io {
            code: ErrorCode::EINVAL,
            path: root.to_path_buf(),
            source: std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string()),
        })?;
        self.matchers.push((root.to_path_buf(), gi));
        Ok(())
    }

    /// True when any stacked matcher reports `path` as ignored. Gitignore
    /// semantics: a matcher only applies to paths under its anchor directory;
    /// `matched_path_or_any_parents` walks the path's ancestors so nested dir
    /// matches don't miss.
    pub fn is_ignored(&self, path: &Path, is_dir: bool) -> bool {
        for (root, gi) in &self.matchers {
            if !path.starts_with(root) {
                continue;
            }
            let m = gi.matched_path_or_any_parents(path, is_dir);
            if m.is_ignore() {
                return true;
            }
            if m.is_whitelist() {
                return false;
            }
        }
        false
    }

    pub fn matcher_count(&self) -> usize {
        self.matchers.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn empty_matcher_does_not_ignore() {
        let m = IgnoreMatcher::new();
        assert!(!m.is_ignored(Path::new("/tmp/foo.txt"), false));
    }

    #[test]
    fn string_pattern_ignores_match() {
        let td = TempDir::new().unwrap();
        let mut m = IgnoreMatcher::new();
        m.add_from_string(td.path(), "*.log\nnode_modules/\n").unwrap();
        assert!(m.is_ignored(&td.path().join("debug.log"), false));
        assert!(m.is_ignored(&td.path().join("node_modules"), true));
        assert!(m.is_ignored(&td.path().join("node_modules/react"), true));
        assert!(!m.is_ignored(&td.path().join("src/main.rs"), false));
    }

    #[test]
    fn negation_whitelist_takes_effect_at_same_level() {
        // Gitignore semantics: within one file, `!pattern` overrides earlier
        // rules. Across stacked matchers we respect whichever fires first;
        // this test keeps everything inside a single matcher to avoid
        // depending on that ordering subtlety.
        let td = TempDir::new().unwrap();
        let mut m = IgnoreMatcher::new();
        m.add_from_string(td.path(), "*.log\n!keep.log\n").unwrap();
        assert!(m.is_ignored(&td.path().join("x.log"), false));
        assert!(!m.is_ignored(&td.path().join("keep.log"), false));
    }

    #[test]
    fn loads_from_real_gitignore_file() {
        let td = TempDir::new().unwrap();
        let gi = td.path().join(".gitignore");
        fs::write(&gi, "target/\n*.bak\n").unwrap();

        let mut m = IgnoreMatcher::new();
        m.add_from_file(&gi).unwrap();
        assert!(m.is_ignored(&td.path().join("target"), true));
        assert!(m.is_ignored(&td.path().join("src/foo.bak"), false));
        assert!(!m.is_ignored(&td.path().join("src/foo.rs"), false));
    }

    #[test]
    fn stacked_matchers_each_apply_under_their_root() {
        let td = TempDir::new().unwrap();
        let sub = td.path().join("sub");
        fs::create_dir(&sub).unwrap();

        let mut m = IgnoreMatcher::new();
        m.add_from_string(td.path(), "top-secret.txt\n").unwrap();
        m.add_from_string(&sub, "sub-secret.txt\n").unwrap();

        // Top-level matcher applies everywhere under td.
        assert!(m.is_ignored(&td.path().join("top-secret.txt"), false));
        assert!(m.is_ignored(&sub.join("top-secret.txt"), false));
        // Sub-level matcher applies only under sub.
        assert!(!m.is_ignored(&td.path().join("sub-secret.txt"), false));
        assert!(m.is_ignored(&sub.join("sub-secret.txt"), false));
    }

    #[test]
    fn missing_ignore_file_returns_error() {
        let td = TempDir::new().unwrap();
        let missing = td.path().join(".gitignore-not-here");
        let mut m = IgnoreMatcher::new();
        let err = m.add_from_file(&missing).unwrap_err();
        assert_eq!(err.code(), ErrorCode::EINVAL);
    }
}
