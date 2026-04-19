//! Bincode bulk-return path (Phase 5 commit 5.10).
//!
//! Rationale (SPEC §4.8): per-entry NAPI struct marshaling walks the
//! JS object allocator once per field, per row. For wide-viewport reads
//! (10k+ rows), the aggregate cost dominates the actual tree work. A
//! single `Buffer` carrying a bincode-encoded `Vec<T>` crosses NAPI in
//! one hop; decoding on the TS side is a tight loop over a typed view.
//! Empirically (SPEC measurement) the crossover is ~100 entries — below
//! that, struct-marshaling is still faster because bincode decode is
//! O(rows) with a non-trivial constant.
//!
//! The infra here is the encoder side; call sites opt in per-method
//! (the first being `MirrorSnapshot::visibleRowsBin`). Phase 6 lands
//! the matching TS decoder as part of the wrapper.

use napi::bindgen_prelude::{Buffer, Result};
use serde::Serialize;

use crate::error::fx_error_to_napi;

/// Threshold above which a caller *should* take the bincode path. This
/// is the provisional value from SPEC §4.8; Phase 12 benches will
/// confirm (or tune) once real workloads are wired up.
pub const BINCODE_THRESHOLD: usize = 100;

/// True if `items` is large enough to justify bincode encoding instead
/// of per-row struct marshaling. Thin helper so call sites can read as
/// `if bulk_threshold_reached(&rows) { ... }` without repeating the
/// constant.
pub(crate) fn bulk_threshold_reached<T>(items: &[T]) -> bool {
    items.len() > BINCODE_THRESHOLD
}

/// Encode a serde-serializable value into bincode and return as a
/// `Buffer`. Uses `bincode::config::standard()` — the same config used
/// by `mille_core::resume::{write_snapshot, read_snapshot}`, so the two
/// paths agree on endianness and integer encoding.
pub(crate) fn encode_bulk<T: Serialize>(value: &T) -> Result<Buffer> {
    let bytes = bincode::serde::encode_to_vec(value, bincode::config::standard())
        .map_err(|e| {
            fx_error_to_napi(mille_core::FxError::InternalBug(format!(
                "bincode encode failed: {}",
                e
            )))
        })?;
    Ok(Buffer::from(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn threshold_is_strict_greater_than() {
        let at_threshold = vec![0u8; BINCODE_THRESHOLD];
        let over_threshold = vec![0u8; BINCODE_THRESHOLD + 1];
        assert!(!bulk_threshold_reached(&at_threshold));
        assert!(bulk_threshold_reached(&over_threshold));
    }

    #[test]
    fn encode_bulk_roundtrips_via_standard_config() {
        let items = vec![1u32, 2, 3, 4];
        let buf = encode_bulk(&items).expect("encode");
        let (decoded, _): (Vec<u32>, usize) =
            bincode::serde::decode_from_slice(buf.as_ref(), bincode::config::standard())
                .expect("decode");
        assert_eq!(decoded, items);
    }
}
