//! FxError → napi::Error mapping (SPEC §4.7).
//!
//! The orphan rule forbids `impl From<FxError> for napi::Error` (both types
//! are foreign), so we expose a free function `fx_error_to_napi` and use
//! the `.map_err(fx_error_to_napi)` idiom at every call site.
//!
//! Wire format on the `reason` string: `FX|<code>|<path>|<message>`.
//! - `FX` prefix lets the TS wrapper distinguish our errors from plain JS.
//! - `|` separator: code and path rarely contain `|`; paths that do will
//!   see cosmetic splitting in the parsed `path` field. Acceptable per
//!   SPEC §4.7 — the `code` is the load-bearing field for behaviour.
//! - Phase 6's TS wrapper parses this back into `FileSystemError { code,
//!   path, message }` and re-throws with the stack preserved.

use std::path::PathBuf;

use napi::bindgen_prelude::{Error, Status};

use mille_core::{ErrorCode, FxError};

/// Wrap a `std::io::Error` in an `FxError::Io`, preserving the path we were
/// operating on. Use at mutation call sites where the path is already known.
pub(crate) fn io_to_fx(err: std::io::Error, path: PathBuf) -> FxError {
    ErrorCode::from_io_error(&err, path)
}

/// Encode an `FxError` as a `napi::Error` whose `reason` carries the
/// structured payload the TS wrapper unpacks.
pub(crate) fn fx_error_to_napi(err: FxError) -> Error {
    let code = err.code();
    let (path, message) = match &err {
        FxError::Io { path, .. } => (path.to_string_lossy().into_owned(), err.to_string()),
        _ => (String::new(), err.to_string()),
    };
    let reason = format!("FX|{}|{}|{}", code.as_str(), path, message);
    Error::new(Status::GenericFailure, reason)
}

/// Parse a `FX|...` reason string back into `(code, path, message)`.
/// Kept `pub(crate)` for symmetry with the TS parser — used here for
/// tests; the production parser lives in the Phase 6 TS wrapper.
#[cfg(test)]
pub(crate) fn parse_fx_reason(reason: &str) -> Option<(&str, &str, &str)> {
    let rest = reason.strip_prefix("FX|")?;
    // Three segments after the FX prefix: code, path, message.
    // Message may itself contain `|`, so splitn keeps it intact.
    let mut it = rest.splitn(3, '|');
    let code = it.next()?;
    let path = it.next()?;
    let message = it.next()?;
    Some((code, path, message))
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use mille_core::{ErrorCode, FxError};

    use super::*;

    #[test]
    fn io_error_encodes_code_and_path() {
        let fx = ErrorCode::from_io_error(
            &std::io::Error::from_raw_os_error(2),
            PathBuf::from("/a/b"),
        );
        let napi_err = fx_error_to_napi(fx);
        let reason = napi_err.reason.as_str();
        assert!(reason.starts_with("FX|ENOENT|/a/b|"), "got {reason}");
    }

    #[test]
    fn unsupported_has_empty_path() {
        let napi_err = fx_error_to_napi(FxError::Unsupported("x".into()));
        let reason = napi_err.reason.as_str();
        assert!(reason.starts_with("FX|EUNSUPPORTED||"), "got {reason}");
    }

    #[test]
    fn entry_id_exhausted_maps_to_eunknown() {
        let napi_err = fx_error_to_napi(FxError::EntryIdExhausted);
        let reason = napi_err.reason.as_str();
        assert!(reason.starts_with("FX|EUNKNOWN||"), "got {reason}");
    }

    #[test]
    fn reason_roundtrips_through_parser() {
        let fx = ErrorCode::from_io_error(
            &std::io::Error::from_raw_os_error(13),
            PathBuf::from("/x/y"),
        );
        let napi_err = fx_error_to_napi(fx);
        let (code, path, msg) =
            parse_fx_reason(napi_err.reason.as_str()).expect("well-formed reason");
        assert_eq!(code, "EACCES");
        assert_eq!(path, "/x/y");
        assert!(!msg.is_empty());
    }

    #[test]
    fn cancelled_and_invalid_input_encode_correctly() {
        let c = fx_error_to_napi(FxError::Cancelled);
        assert!(c.reason.starts_with("FX|ECANCELED||"));

        let i = fx_error_to_napi(FxError::InvalidInput("bad".into()));
        assert!(i.reason.starts_with("FX|EINVAL||"));
    }

    #[test]
    fn status_is_generic_failure() {
        // Phase 6 TS wrapper keys off the `FX|` prefix, not the Status,
        // so GenericFailure is fine for every variant.
        let napi_err = fx_error_to_napi(FxError::Cancelled);
        assert_eq!(napi_err.status, Status::GenericFailure);
    }
}
