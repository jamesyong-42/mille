//! mille-bench — shared fixture generators for the criterion benches.
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
pub fn build_tree(depth: usize, dirs_per_level: usize, files_per_dir: usize) -> (TempDir, usize) {
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

/// Large query fixture: ~8,600 entries. Big enough to establish the linear
/// slope of rank/name traversals without turning benchmark setup into a
/// filesystem stress test.
pub fn large_query_tree() -> (TempDir, usize) {
    build_tree(4, 5, 10)
}

/// v0.2 B3 — pnpm-class fixture.
///
/// Builds two trees:
/// - `repo`: a ~`repo_entries`-entry workspace with a root `.gitignore`
///   listing `node_modules/` plus a `node_modules` symlink into `store`.
/// - `store`: a ~`store_entries`-entry populated directory, the stand-in
///   for pnpm's central `.pnpm/` hard-linked store.
///
/// Both TempDirs are returned so the caller controls lifetime; dropping
/// either before the walk finishes would yank the fixture. The symlink
/// points at `store` via its absolute path, matching what pnpm does.
#[cfg(unix)]
pub fn pnpm_style_fixture(repo_entries: usize, store_entries: usize) -> (TempDir, TempDir) {
    use std::os::unix::fs::symlink;
    let repo = TempDir::new().expect("repo tempdir");
    let store = TempDir::new().expect("store tempdir");

    // Populate the store with flat files to keep setup fast.
    for i in 0..store_entries {
        let p = store.path().join(format!("store_file_{:06}.js", i));
        fs::write(&p, b"x").expect("write store file");
    }

    // Populate the repo: `.gitignore`, a `src/` dir with repo_entries files,
    // plus the `node_modules` symlink into the store.
    fs::write(repo.path().join(".gitignore"), "node_modules/\n").expect("gitignore");
    let src = repo.path().join("src");
    fs::create_dir(&src).expect("mkdir src");
    for i in 0..repo_entries {
        let p = src.join(format!("mod_{:05}.rs", i));
        fs::write(&p, b"pub fn x() {}").expect("write src file");
    }
    symlink(store.path(), repo.path().join("node_modules")).expect("symlink");
    (repo, store)
}

#[cfg(test)]
mod tests {
    use super::*;
    // Only the `#[cfg(unix)]` timing test below uses this; without the gate it
    // is an unused import on Windows, which `-D warnings` turns into a build
    // failure there.
    #[cfg(unix)]
    use std::time::Instant;

    #[test]
    fn large_query_fixture_has_expected_scale() {
        let (_tree, entries) = large_query_tree();
        assert_eq!(entries, 8_590);
    }

    #[cfg(unix)]
    #[test]
    fn pnpm_style_walk_under_500ms() {
        use mille_core::{walk_with_ignore, IgnoreMatcher, WalkOptions};

        // Small enough to be safe in CI but large enough that a regression
        // (walker descending the symlink into the store) would blow well
        // past the budget. 2k repo entries + 20k store entries ≈ 25×
        // amplification on regression.
        let (repo, _store) = pnpm_style_fixture(2_000, 20_000);
        let mut matcher = IgnoreMatcher::new();
        matcher
            .add_from_file(&repo.path().join(".gitignore"))
            .unwrap();

        let t0 = Instant::now();
        let walked = walk_with_ignore(repo.path(), WalkOptions::default(), &matcher).unwrap();
        let elapsed = t0.elapsed();

        // Confirm we didn't descend the symlink.
        for w in &walked {
            assert!(
                !w.name.starts_with("store_file_"),
                "walker leaked store file: {}",
                w.name
            );
        }

        // Budget: 500ms (SPEC target for vibe-ctl-class walks).
        assert!(
            elapsed.as_millis() < 500,
            "pnpm-style walk took {:?}, expected < 500ms (regression?)",
            elapsed
        );
    }
}
