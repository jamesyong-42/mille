//! File I/O helpers for FileExplorer (Phase 5 commit 5.6).
//!
//! readFile / readText / writeFile. All three resolve an `EntryId` to an
//! absolute path via `resolve_entry_path` (mutations.rs) and route every
//! `std::io::Error` through `io_to_fx` so the TS wrapper sees the same
//! FX-coded errors as mutations do.
//!
//! Encoding scope for v0.1: utf-8 only. Other encodings return EUNSUPPORTED
//! — the TS layer can pre-convert before calling writeFile if needed, and
//! binary files go through readFile/writeFile with raw `Buffer`.
//!
//! Atomic writes use the temp-file + rename pattern against a
//! `<path>.mille.tmp` sibling. It's best-effort — not a full fsync-first
//! crash-safe write — but safe enough for editor save-on-blur ergonomics,
//! and `rename` is atomic on the same filesystem on all supported targets.

use std::path::PathBuf;

use napi::bindgen_prelude::{Buffer, Result};

use fx_core::FxError;

use crate::error::{fx_error_to_napi, io_to_fx};

/// Read the full contents of `path` into a `Buffer`.
/// On the JS side `Buffer` is a zero-copy view for the standard Node build.
pub(crate) async fn read_file(path: PathBuf) -> Result<Buffer> {
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|e| fx_error_to_napi(io_to_fx(e, path.clone())))?;
    Ok(Buffer::from(bytes))
}

/// Read the contents of `path` as a UTF-8 string. `encoding` must be
/// `None`, `"utf-8"`, or `"utf8"`; anything else returns EUNSUPPORTED.
/// Non-UTF-8 bytes yield EINVAL with the decode error attached.
pub(crate) async fn read_text(path: PathBuf, encoding: Option<String>) -> Result<String> {
    let enc = encoding.as_deref().unwrap_or("utf-8").to_ascii_lowercase();
    if enc != "utf-8" && enc != "utf8" {
        return Err(fx_error_to_napi(FxError::Unsupported(format!(
            "encoding {:?} not supported in v0.1 (utf-8 only)",
            enc
        ))));
    }
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|e| fx_error_to_napi(io_to_fx(e, path.clone())))?;
    String::from_utf8(bytes).map_err(|e| {
        fx_error_to_napi(FxError::InvalidInput(format!(
            "file contents are not valid UTF-8: {e}"
        )))
    })
}

/// Write `data` to `path`. When `atomic` is true, write to a sibling
/// `<path>.mille.tmp` first, then `rename` into place — rename is atomic
/// on same-filesystem targets across macOS / Linux / Windows.
pub(crate) async fn write_file(path: PathBuf, data: Vec<u8>, atomic: bool) -> Result<()> {
    if atomic {
        let tmp = tmp_sibling(&path);
        tokio::fs::write(&tmp, &data)
            .await
            .map_err(|e| fx_error_to_napi(io_to_fx(e, tmp.clone())))?;
        tokio::fs::rename(&tmp, &path)
            .await
            .map_err(|e| fx_error_to_napi(io_to_fx(e, path.clone())))?;
    } else {
        tokio::fs::write(&path, &data)
            .await
            .map_err(|e| fx_error_to_napi(io_to_fx(e, path.clone())))?;
    }
    Ok(())
}

/// Pick a sibling temp path that won't collide with a user file. `with_extension`
/// would replace an existing extension (e.g. `foo.txt` → `foo.mille.tmp`,
/// losing `.txt`) — append instead to keep the original extension intact.
fn tmp_sibling(path: &std::path::Path) -> PathBuf {
    let mut name = path
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_default();
    name.push(".mille.tmp");
    match path.parent() {
        Some(parent) => parent.join(name),
        None => PathBuf::from(name),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tmp_sibling_preserves_original_extension() {
        let p = PathBuf::from("/a/b/foo.txt");
        assert_eq!(tmp_sibling(&p), PathBuf::from("/a/b/foo.txt.mille.tmp"));
    }

    #[test]
    fn tmp_sibling_handles_dotfile() {
        let p = PathBuf::from("/a/b/.env");
        assert_eq!(tmp_sibling(&p), PathBuf::from("/a/b/.env.mille.tmp"));
    }
}
