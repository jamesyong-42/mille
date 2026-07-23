use crate::{Entry, EntryKind};
use std::cmp::Ordering;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SortBy {
    #[default]
    Name,
    Type,
    Modified,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SiblingOrder {
    pub sort_by: SortBy,
    pub case_sensitive: bool,
    pub folders_on_top: bool,
}

impl Default for SiblingOrder {
    fn default() -> Self {
        Self {
            sort_by: SortBy::Name,
            case_sensitive: false,
            folders_on_top: true,
        }
    }
}

fn is_folder(entry: &Entry) -> bool {
    entry.kind == EntryKind::Directory || entry.symlink_target_is_dir == Some(true)
}

fn extension(name: &str) -> &str {
    let Some((stem, extension)) = name.rsplit_once('.') else {
        return "";
    };
    if stem.is_empty() {
        ""
    } else {
        extension
    }
}

impl SiblingOrder {
    pub fn compare(&self, left: &Entry, right: &Entry) -> Ordering {
        if self.folders_on_top {
            let grouping = (!is_folder(left)).cmp(&(!is_folder(right)));
            if grouping != Ordering::Equal {
                return grouping;
            }
        }
        let primary = match self.sort_by {
            SortBy::Name => Ordering::Equal,
            SortBy::Type => natural_name_cmp_case(
                extension(&left.name),
                extension(&right.name),
                self.case_sensitive,
            ),
            SortBy::Modified => right.mtime_ms.cmp(&left.mtime_ms),
        };
        primary.then_with(|| natural_name_cmp_case(&left.name, &right.name, self.case_sensitive))
    }
}

/// Allocation-free natural comparison for file names. ASCII digit runs compare
/// by numeric magnitude, then leading-zero/run length; non-digits compare
/// case-insensitively with the original byte as a deterministic tie-breaker.
pub fn natural_name_cmp(left: &str, right: &str) -> Ordering {
    natural_name_cmp_case(left, right, false)
}

pub fn natural_name_cmp_case(left: &str, right: &str, case_sensitive: bool) -> Ordering {
    let a = left.as_bytes();
    let b = right.as_bytes();
    let mut ai = 0;
    let mut bi = 0;
    while ai < a.len() && bi < b.len() {
        if a[ai].is_ascii_digit() && b[bi].is_ascii_digit() {
            let a_start = ai;
            let b_start = bi;
            while ai < a.len() && a[ai].is_ascii_digit() {
                ai += 1;
            }
            while bi < b.len() && b[bi].is_ascii_digit() {
                bi += 1;
            }
            let a_sig = (a_start..ai).find(|&index| a[index] != b'0').unwrap_or(ai);
            let b_sig = (b_start..bi).find(|&index| b[index] != b'0').unwrap_or(bi);
            let magnitude = (ai - a_sig).cmp(&(bi - b_sig));
            if magnitude != Ordering::Equal {
                return magnitude;
            }
            let digits = a[a_sig..ai].cmp(&b[b_sig..bi]);
            if digits != Ordering::Equal {
                return digits;
            }
            let run_length = (ai - a_start).cmp(&(bi - b_start));
            if run_length != Ordering::Equal {
                return run_length;
            }
            continue;
        }

        if !case_sensitive {
            let folded = a[ai].to_ascii_lowercase().cmp(&b[bi].to_ascii_lowercase());
            if folded != Ordering::Equal {
                return folded;
            }
        }
        let original = a[ai].cmp(&b[bi]);
        if original != Ordering::Equal {
            return original;
        }
        ai += 1;
        bi += 1;
    }
    a.len().cmp(&b.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_numeric_runs_by_value() {
        let mut names = vec!["file10", "file02", "file1", "file2"];
        names.sort_by(|a, b| natural_name_cmp(a, b));
        assert_eq!(names, vec!["file1", "file2", "file02", "file10"]);
    }

    #[test]
    fn has_deterministic_case_ties() {
        let mut names = vec!["beta", "Alpha", "alpha", "Beta"];
        names.sort_by(|a, b| natural_name_cmp(a, b));
        assert_eq!(names, vec!["Alpha", "alpha", "Beta", "beta"]);
    }

    #[test]
    fn case_sensitive_mode_uses_original_byte_order() {
        assert_eq!(
            natural_name_cmp_case("alpha", "Beta", false),
            Ordering::Less
        );
        assert_eq!(
            natural_name_cmp_case("alpha", "Beta", true),
            Ordering::Greater
        );
    }
}
