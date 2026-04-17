//! fx-bench — shared fixture generators for the criterion benches.
//!
//! Phase 2.7 populates this with a tree generator used by walker benches.
//! Phase 3.11 adds watcher-storm fixtures; Phase 10.3 adds search corpora.

use std::fs;
use std::path::Path;

use tempfile::TempDir;

/// Create a balanced tree with `dirs_per_level × files_per_dir` entries per
/// directory, up to `depth` levels. Returns the TempDir plus the total count.
///
/// Example: `build_tree(3, 10, 10)` → 3-deep tree where every dir has 10
/// subdirs + 10 files. Total entries ≈ dirs_per_level × depth levels of
/// branching plus leaves.
pub fn build_tree(
    depth: usize,
    dirs_per_level: usize,
    files_per_dir: usize,
) -> (TempDir, usize) {
    let td = TempDir::new().expect("tempdir");
    let mut total = 0;
    build_recursive(td.path(), depth, dirs_per_level, files_per_dir, &mut total);
    (td, total)
}

fn build_recursive(
    dir: &Path,
    depth: usize,
    dirs_per_level: usize,
    files_per_dir: usize,
    total: &mut usize,
) {
    for f in 0..files_per_dir {
        let p = dir.join(format!("file_{:03}.txt", f));
        fs::write(&p, b"x").expect("write");
        *total += 1;
    }
    if depth == 0 {
        return;
    }
    for d in 0..dirs_per_level {
        let sub = dir.join(format!("dir_{:03}", d));
        fs::create_dir(&sub).expect("mkdir");
        *total += 1;
        build_recursive(&sub, depth - 1, dirs_per_level, files_per_dir, total);
    }
}

/// Small tree: ~220 entries. Useful for fast micro-benchmarks.
pub fn small_tree() -> (TempDir, usize) {
    build_tree(2, 5, 10)
}

/// Medium tree: ~1500 entries. Realistic workspace proxy for walker+store
/// integration benches without paying huge setup cost.
pub fn medium_tree() -> (TempDir, usize) {
    build_tree(3, 5, 10)
}
