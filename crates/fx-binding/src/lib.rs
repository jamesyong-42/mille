//! fx-binding — napi-rs surface for fx-core.
//!
//! Per SPEC §4.1, this crate contains only marshaling. No engine logic.
//! Phase 5 fleshes out the `FileExplorer` `#[napi]` class and related
//! `#[napi(object)]` mirror types.

#[macro_use]
extern crate napi_derive;

pub mod error;
pub mod explorer;
pub mod snapshot;
pub mod types;

/// Module version string. Present so the native module has at least one
/// exported symbol and can be `require()`d end-to-end during Phase 0.
#[napi]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
