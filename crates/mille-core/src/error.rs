//! Error taxonomy (SPEC §4.7). ErrorCode mirrors api.d.ts; FxError is the
//! internal Rust error. The NAPI binding stamps `__fx_code` on thrown
//! exceptions so the TS side can reconstruct a FileSystemError.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Stable error code mirroring `api.d.ts` ErrorCode union.
#[derive(Copy, Clone, Eq, PartialEq, Debug, Serialize, Deserialize)]
pub enum ErrorCode {
    EACCES,
    ENOENT,
    EEXIST,
    EISDIR,
    ENOTDIR,
    ELOOP,
    ENOSPC,
    EROFS,
    EBUSY,
    EINVAL,
    ECANCELED,
    EUNSUPPORTED,
    EUNKNOWN,
}

impl ErrorCode {
    /// String variant name — the payload shipped across the NAPI boundary
    /// as `__fx_code` (SPEC §4.7).
    pub fn as_str(&self) -> &'static str {
        match self {
            ErrorCode::EACCES => "EACCES",
            ErrorCode::ENOENT => "ENOENT",
            ErrorCode::EEXIST => "EEXIST",
            ErrorCode::EISDIR => "EISDIR",
            ErrorCode::ENOTDIR => "ENOTDIR",
            ErrorCode::ELOOP => "ELOOP",
            ErrorCode::ENOSPC => "ENOSPC",
            ErrorCode::EROFS => "EROFS",
            ErrorCode::EBUSY => "EBUSY",
            ErrorCode::EINVAL => "EINVAL",
            ErrorCode::ECANCELED => "ECANCELED",
            ErrorCode::EUNSUPPORTED => "EUNSUPPORTED",
            ErrorCode::EUNKNOWN => "EUNKNOWN",
        }
    }

    /// Build an `FxError::Io` from a `std::io::Error` + the path we were
    /// operating on. Use this at every call site that knows the path; the
    /// bare `From<io::Error>` fallback uses an empty path.
    pub fn from_io_error(err: &std::io::Error, path: PathBuf) -> FxError {
        let code = io_error_code(err);
        // Clone the io::Error through its raw_os_error / kind since io::Error
        // itself isn't Clone.
        let source = clone_io_error(err);
        FxError::Io { code, path, source }
    }
}

/// Internal error type. All variants have an `ErrorCode` available via `code()`.
#[derive(Error, Debug)]
pub enum FxError {
    #[error("io error ({code:?}) at {path:?}: {source}")]
    Io {
        code: ErrorCode,
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    #[error("unsupported: {0}")]
    Unsupported(String),

    #[error("cancelled")]
    Cancelled,

    #[error("invalid input: {0}")]
    InvalidInput(String),

    #[error("internal bug: {0}")]
    InternalBug(String),

    #[error("EntryId space exhausted (2^53 cap)")]
    EntryIdExhausted,
}

impl FxError {
    /// The ErrorCode that crosses the NAPI boundary for this error.
    pub fn code(&self) -> ErrorCode {
        match self {
            FxError::Io { code, .. } => *code,
            FxError::Unsupported(_) => ErrorCode::EUNSUPPORTED,
            FxError::Cancelled => ErrorCode::ECANCELED,
            FxError::InvalidInput(_) => ErrorCode::EINVAL,
            FxError::InternalBug(_) => ErrorCode::EUNKNOWN,
            FxError::EntryIdExhausted => ErrorCode::EUNKNOWN,
        }
    }
}

impl From<std::io::Error> for FxError {
    /// Path-less fallback; prefer `ErrorCode::from_io_error(err, path)` when
    /// the path is known at the call site.
    fn from(err: std::io::Error) -> Self {
        ErrorCode::from_io_error(&err, PathBuf::new())
    }
}

#[cfg(unix)]
fn io_error_code(err: &std::io::Error) -> ErrorCode {
    if let Some(errno) = err.raw_os_error() {
        return match errno {
            13 => ErrorCode::EACCES,
            2 => ErrorCode::ENOENT,
            17 => ErrorCode::EEXIST,
            21 => ErrorCode::EISDIR,
            20 => ErrorCode::ENOTDIR,
            // ELOOP is 40 on Linux, 62 on macOS/BSD.
            40 | 62 => ErrorCode::ELOOP,
            28 => ErrorCode::ENOSPC,
            // EROFS is 30 on Linux, 30 on macOS too.
            30 => ErrorCode::EROFS,
            16 => ErrorCode::EBUSY,
            22 => ErrorCode::EINVAL,
            125 => ErrorCode::ECANCELED,
            _ => io_kind_code(err),
        };
    }
    io_kind_code(err)
}

#[cfg(windows)]
fn io_error_code(err: &std::io::Error) -> ErrorCode {
    // Windows errno mapping is less granular; lean on ErrorKind.
    io_kind_code(err)
}

/// Fallback: map `io::ErrorKind` to an ErrorCode. Used on Windows and when
/// `raw_os_error()` is unrecognized on Unix.
fn io_kind_code(err: &std::io::Error) -> ErrorCode {
    use std::io::ErrorKind as K;
    match err.kind() {
        K::PermissionDenied => ErrorCode::EACCES,
        K::NotFound => ErrorCode::ENOENT,
        K::AlreadyExists => ErrorCode::EEXIST,
        K::NotADirectory => ErrorCode::ENOTDIR,
        K::IsADirectory => ErrorCode::EISDIR,
        K::InvalidInput | K::InvalidData => ErrorCode::EINVAL,
        K::TimedOut | K::Interrupted => ErrorCode::EBUSY,
        K::Unsupported => ErrorCode::EUNSUPPORTED,
        _ => ErrorCode::EUNKNOWN,
    }
}

/// `std::io::Error` isn't Clone; reconstruct one that preserves whichever
/// signal we actually use (raw_os_error or ErrorKind + message).
fn clone_io_error(err: &std::io::Error) -> std::io::Error {
    if let Some(errno) = err.raw_os_error() {
        std::io::Error::from_raw_os_error(errno)
    } else {
        std::io::Error::new(err.kind(), err.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_code_as_str_roundtrip() {
        let all = [
            (ErrorCode::EACCES, "EACCES"),
            (ErrorCode::ENOENT, "ENOENT"),
            (ErrorCode::EEXIST, "EEXIST"),
            (ErrorCode::EISDIR, "EISDIR"),
            (ErrorCode::ENOTDIR, "ENOTDIR"),
            (ErrorCode::ELOOP, "ELOOP"),
            (ErrorCode::ENOSPC, "ENOSPC"),
            (ErrorCode::EROFS, "EROFS"),
            (ErrorCode::EBUSY, "EBUSY"),
            (ErrorCode::EINVAL, "EINVAL"),
            (ErrorCode::ECANCELED, "ECANCELED"),
            (ErrorCode::EUNSUPPORTED, "EUNSUPPORTED"),
            (ErrorCode::EUNKNOWN, "EUNKNOWN"),
        ];
        for (code, name) in all {
            assert_eq!(code.as_str(), name);
        }
    }

    #[test]
    fn fx_error_code_per_variant() {
        let io =
            ErrorCode::from_io_error(&std::io::Error::from_raw_os_error(13), PathBuf::from("/x"));
        assert_eq!(io.code(), ErrorCode::EACCES);

        assert_eq!(
            FxError::Unsupported("x".into()).code(),
            ErrorCode::EUNSUPPORTED
        );
        assert_eq!(FxError::Cancelled.code(), ErrorCode::ECANCELED);
        assert_eq!(FxError::InvalidInput("x".into()).code(), ErrorCode::EINVAL);
        assert_eq!(FxError::InternalBug("x".into()).code(), ErrorCode::EUNKNOWN);
        assert_eq!(FxError::EntryIdExhausted.code(), ErrorCode::EUNKNOWN);
    }

    #[cfg(unix)]
    #[test]
    fn io_error_errno_mapping_unix() {
        let cases = [
            (13, ErrorCode::EACCES),
            (2, ErrorCode::ENOENT),
            (17, ErrorCode::EEXIST),
            (21, ErrorCode::EISDIR),
            (20, ErrorCode::ENOTDIR),
            (28, ErrorCode::ENOSPC),
            (30, ErrorCode::EROFS),
            (16, ErrorCode::EBUSY),
            (22, ErrorCode::EINVAL),
        ];
        for (errno, expected) in cases {
            let err = std::io::Error::from_raw_os_error(errno);
            let fx = ErrorCode::from_io_error(&err, PathBuf::from("/tmp/x"));
            assert_eq!(fx.code(), expected, "errno {errno}");
        }
    }

    #[test]
    fn io_error_kind_fallback() {
        // An error without a raw_os_error still maps via ErrorKind.
        let err = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "denied");
        let fx = ErrorCode::from_io_error(&err, PathBuf::from("/x"));
        assert_eq!(fx.code(), ErrorCode::EACCES);

        let err = std::io::Error::new(std::io::ErrorKind::NotFound, "nope");
        let fx = ErrorCode::from_io_error(&err, PathBuf::from("/x"));
        assert_eq!(fx.code(), ErrorCode::ENOENT);

        let err = std::io::Error::new(std::io::ErrorKind::AlreadyExists, "boom");
        let fx = ErrorCode::from_io_error(&err, PathBuf::from("/x"));
        assert_eq!(fx.code(), ErrorCode::EEXIST);

        let err = std::io::Error::new(std::io::ErrorKind::NotADirectory, "not a directory");
        let fx = ErrorCode::from_io_error(&err, PathBuf::from("/x"));
        assert_eq!(fx.code(), ErrorCode::ENOTDIR);

        let err = std::io::Error::new(std::io::ErrorKind::IsADirectory, "is a directory");
        let fx = ErrorCode::from_io_error(&err, PathBuf::from("/x"));
        assert_eq!(fx.code(), ErrorCode::EISDIR);
    }

    #[test]
    fn from_io_error_fallback_has_empty_path() {
        let err = std::io::Error::from_raw_os_error(2);
        let fx: FxError = err.into();
        match fx {
            FxError::Io { code, path, .. } => {
                assert_eq!(code, ErrorCode::ENOENT);
                assert_eq!(path, PathBuf::new());
            }
            _ => panic!("expected Io variant"),
        }
    }
}
