use std::cmp::Ordering;

/// Allocation-free natural comparison for file names. ASCII digit runs compare
/// by numeric magnitude, then leading-zero/run length; non-digits compare
/// case-insensitively with the original byte as a deterministic tie-breaker.
pub fn natural_name_cmp(left: &str, right: &str) -> Ordering {
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

        let folded = a[ai].to_ascii_lowercase().cmp(&b[bi].to_ascii_lowercase());
        if folded != Ordering::Equal {
            return folded;
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
}
