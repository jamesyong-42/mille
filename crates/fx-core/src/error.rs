// Stub for commit 1.1 — only the EntryIdExhausted variant is used today.
// Commit 1.2 replaces this with the full taxonomy per SPEC §4.7.

#[derive(Debug)]
pub enum FxError {
    EntryIdExhausted,
}
