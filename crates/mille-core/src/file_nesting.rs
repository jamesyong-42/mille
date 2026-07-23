use std::sync::Arc;

const MAX_RULES: usize = 256;
const MAX_CHILDREN_PER_RULE: usize = 64;
const MAX_PATTERN_BYTES: usize = 1_024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileNestingRule {
    parent_prefix: String,
    parent_suffix: String,
    has_wildcard: bool,
    child_templates: Arc<[String]>,
}

impl FileNestingRule {
    fn compile(parent_pattern: String, child_templates: Vec<String>) -> Option<Self> {
        if parent_pattern.is_empty()
            || parent_pattern.len() > MAX_PATTERN_BYTES
            || parent_pattern.matches('*').count() > 1
        {
            return None;
        }
        let (parent_prefix, parent_suffix, has_wildcard) = match parent_pattern.split_once('*') {
            Some((prefix, suffix)) => (prefix.to_owned(), suffix.to_owned(), true),
            None => (parent_pattern, String::new(), false),
        };
        let child_templates: Vec<String> = child_templates
            .into_iter()
            .filter(|template| {
                !template.is_empty()
                    && template.len() <= MAX_PATTERN_BYTES
                    // Child templates deliberately resolve to an exact sibling
                    // name. This keeps a directory plan O(files × rules),
                    // including in 100k-entry generated/source directories.
                    && !template.contains('*')
            })
            .take(MAX_CHILDREN_PER_RULE)
            .collect();
        if child_templates.is_empty() {
            return None;
        }
        Some(Self {
            parent_prefix,
            parent_suffix,
            has_wildcard,
            child_templates: child_templates.into(),
        })
    }

    pub(crate) fn capture<'a>(&self, name: &'a str, case_sensitive: bool) -> Option<String> {
        let comparable = if case_sensitive {
            name.to_owned()
        } else {
            name.to_lowercase()
        };
        let prefix = if case_sensitive {
            self.parent_prefix.clone()
        } else {
            self.parent_prefix.to_lowercase()
        };
        let suffix = if case_sensitive {
            self.parent_suffix.clone()
        } else {
            self.parent_suffix.to_lowercase()
        };
        if !self.has_wildcard {
            return (comparable == prefix).then(String::new);
        }
        if !comparable.starts_with(&prefix)
            || !comparable.ends_with(&suffix)
            || comparable.len() < prefix.len() + suffix.len()
        {
            return None;
        }
        let end = comparable.len() - suffix.len();
        Some(comparable[prefix.len()..end].to_owned())
    }

    pub(crate) fn child_names<'a>(&'a self, capture: &'a str) -> impl Iterator<Item = String> + 'a {
        self.child_templates
            .iter()
            .map(move |template| template.replace("${capture}", capture))
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FileNestingPolicy {
    rules: Arc<[FileNestingRule]>,
    case_sensitive: bool,
}

impl FileNestingPolicy {
    pub fn new(
        rules: impl IntoIterator<Item = (String, Vec<String>)>,
        case_sensitive: bool,
    ) -> Self {
        let mut normalized: Vec<(String, Vec<String>)> =
            rules.into_iter().take(MAX_RULES).collect();
        normalized.sort_by(|left, right| left.0.cmp(&right.0));
        for (_, children) in &mut normalized {
            children.sort();
            children.dedup();
        }
        let compiled: Vec<FileNestingRule> = normalized
            .into_iter()
            .filter_map(|(parent, children)| FileNestingRule::compile(parent, children))
            .collect();
        Self {
            rules: compiled.into(),
            case_sensitive,
        }
    }

    pub fn is_empty(&self) -> bool {
        self.rules.is_empty()
    }

    pub(crate) fn rules(&self) -> &[FileNestingRule] {
        &self.rules
    }

    pub(crate) fn name_key(&self, name: &str) -> String {
        if self.case_sensitive {
            name.to_owned()
        } else {
            name.to_lowercase()
        }
    }

    pub(crate) fn case_sensitive(&self) -> bool {
        self.case_sensitive
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compiles_capture_templates_and_honors_case_policy() {
        let sensitive =
            FileNestingPolicy::new([("*.ts".into(), vec!["${capture}.test.ts".into()])], true);
        let rule = &sensitive.rules()[0];
        assert_eq!(rule.capture("index.ts", true).as_deref(), Some("index"));
        assert_eq!(rule.capture("index.TS", true), None);
        assert_eq!(
            rule.child_names("index").collect::<Vec<_>>(),
            vec!["index.test.ts"]
        );

        let insensitive =
            FileNestingPolicy::new([("*.TS".into(), vec!["${capture}.JS".into()])], false);
        assert_eq!(
            insensitive.rules()[0].capture("Index.ts", false).as_deref(),
            Some("index")
        );
    }

    #[test]
    fn rejects_unbounded_or_ambiguous_patterns() {
        let policy = FileNestingPolicy::new(
            [
                ("**.ts".into(), vec!["${capture}.js".into()]),
                ("*.js".into(), vec!["${capture}.*.map".into()]),
            ],
            true,
        );
        assert!(policy.is_empty());
    }
}
