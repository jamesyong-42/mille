use crate::{Entry, EntryKind, FxError};
use icu_collator::{
    options::{CollatorOptions, Strength},
    preferences::CollationNumericOrdering,
    Collator, CollatorBorrowed, CollatorPreferences,
};
use icu_locale_core::Locale;
use std::cmp::Ordering;
use std::fmt;
use std::sync::Arc;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SortBy {
    #[default]
    Name,
    Type,
    Modified,
}

#[derive(Debug)]
struct LocaleCollation {
    locale: String,
    collator: CollatorBorrowed<'static>,
}

#[derive(Clone)]
pub struct SiblingOrder {
    pub sort_by: SortBy,
    pub case_sensitive: bool,
    pub folders_on_top: bool,
    locale_collation: Option<Arc<LocaleCollation>>,
}

impl fmt::Debug for SiblingOrder {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SiblingOrder")
            .field("sort_by", &self.sort_by)
            .field("case_sensitive", &self.case_sensitive)
            .field("folders_on_top", &self.folders_on_top)
            .field("locale", &self.locale())
            .finish()
    }
}

impl PartialEq for SiblingOrder {
    fn eq(&self, other: &Self) -> bool {
        self.sort_by == other.sort_by
            && self.case_sensitive == other.case_sensitive
            && self.folders_on_top == other.folders_on_top
            && self.locale() == other.locale()
    }
}

impl Eq for SiblingOrder {}

impl Default for SiblingOrder {
    fn default() -> Self {
        Self {
            sort_by: SortBy::Name,
            case_sensitive: false,
            folders_on_top: true,
            locale_collation: None,
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
    /// Build an immutable sibling-order policy. A non-null locale must be a
    /// valid BCP-47 locale and creates one compiled-data ICU collator that is
    /// reused for every comparison made with this policy.
    pub fn try_new(
        sort_by: SortBy,
        case_sensitive: bool,
        folders_on_top: bool,
        locale: Option<&str>,
    ) -> Result<Self, FxError> {
        let locale_collation = locale
            .map(|locale| {
                if locale.is_empty() {
                    return Err(FxError::InvalidInput(
                        "locale must be a non-empty BCP-47 locale".into(),
                    ));
                }
                let parsed = locale.parse::<Locale>().map_err(|error| {
                    FxError::InvalidInput(format!("invalid BCP-47 locale {locale:?}: {error}"))
                })?;
                let mut preferences =
                    CollatorPreferences::from_locale_strict(&parsed).map_err(|_| {
                        FxError::InvalidInput(format!(
                            "unsupported collation preference in locale {locale:?}"
                        ))
                    })?;
                preferences.numeric_ordering = Some(CollationNumericOrdering::True);
                let mut options = CollatorOptions::default();
                options.strength = Some(if case_sensitive {
                    Strength::Tertiary
                } else {
                    Strength::Secondary
                });
                let collator = Collator::try_new(preferences, options).map_err(|error| {
                    FxError::InvalidInput(format!(
                        "cannot create collator for locale {locale:?}: {error}"
                    ))
                })?;
                Ok(Arc::new(LocaleCollation {
                    locale: parsed.to_string(),
                    collator,
                }))
            })
            .transpose()?;
        Ok(Self {
            sort_by,
            case_sensitive,
            folders_on_top,
            locale_collation,
        })
    }

    pub fn locale(&self) -> Option<&str> {
        self.locale_collation
            .as_ref()
            .map(|collation| collation.locale.as_str())
    }

    fn compare_names(&self, left: &str, right: &str) -> Ordering {
        match &self.locale_collation {
            Some(collation) => collation
                .collator
                .compare(left, right)
                .then_with(|| natural_name_cmp_case(left, right, self.case_sensitive)),
            None => natural_name_cmp_case(left, right, self.case_sensitive),
        }
    }

    pub fn compare(&self, left: &Entry, right: &Entry) -> Ordering {
        if self.folders_on_top {
            let grouping = (!is_folder(left)).cmp(&(!is_folder(right)));
            if grouping != Ordering::Equal {
                return grouping;
            }
        }
        let primary = match self.sort_by {
            SortBy::Name => Ordering::Equal,
            SortBy::Type => self.compare_names(extension(&left.name), extension(&right.name)),
            SortBy::Modified => right.mtime_ms.cmp(&left.mtime_ms),
        };
        primary.then_with(|| self.compare_names(&left.name, &right.name))
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

    #[test]
    fn locale_collation_keeps_numeric_filename_ordering() {
        let order = SiblingOrder::try_new(SortBy::Name, false, true, Some("en")).unwrap();
        assert_eq!(order.compare_names("file2", "file10"), Ordering::Less);
    }

    #[test]
    fn locale_collation_obeys_swedish_tailoring() {
        let order = SiblingOrder::try_new(SortBy::Name, false, true, Some("sv")).unwrap();
        let mut names = vec!["ö.txt", "z.txt", "å.txt", "ä.txt"];
        names.sort_by(|left, right| order.compare_names(left, right));
        assert_eq!(names, vec!["z.txt", "å.txt", "ä.txt", "ö.txt"]);
    }

    #[test]
    fn locale_collation_obeys_requested_variant() {
        let english = SiblingOrder::try_new(SortBy::Name, false, true, Some("en")).unwrap();
        let traditional_spanish =
            SiblingOrder::try_new(SortBy::Name, false, true, Some("es-u-co-trad")).unwrap();
        assert_eq!(english.compare_names("pollo", "polvo"), Ordering::Less);
        assert_eq!(
            traditional_spanish.compare_names("pollo", "polvo"),
            Ordering::Greater
        );
    }

    #[test]
    fn locale_collation_retains_deterministic_case_ties() {
        let order = SiblingOrder::try_new(SortBy::Name, false, true, Some("en")).unwrap();
        assert_eq!(order.compare_names("Alpha", "alpha"), Ordering::Less);
    }

    #[test]
    fn rejects_invalid_locales() {
        let error =
            SiblingOrder::try_new(SortBy::Name, false, true, Some("not_a_locale")).unwrap_err();
        assert!(matches!(error, FxError::InvalidInput(_)));
    }
}
