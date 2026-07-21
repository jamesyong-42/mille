//! mille-binding — napi-rs surface for mille-core.
//!
//! Per SPEC §4.1, this crate contains only marshaling. No engine logic.
//! Phase 5 fleshes out the `FileExplorer` `#[napi]` class and related
//! `#[napi(object)]` mirror types.

#[macro_use]
extern crate napi_derive;

pub mod bulk;
pub mod cancel;
pub mod error;
pub mod events;
pub mod explorer;
pub mod io;
pub mod mutations;
pub mod snapshot;
pub mod stream;
pub mod types;
mod watch_runtime;

/// Module version string. Present so the native module has at least one
/// exported symbol and can be `require()`d end-to-end during Phase 0.
#[napi]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Runtime identity for the native artifact that Node actually loaded.
///
/// The npm package and Rust crate are versioned independently today, so a
/// version string alone cannot tell a benchmark whether it is exercising a
/// fresh local debug build or a published release binary. Keep this payload
/// deliberately small and stable so test/benchmark reports can always record
/// the implementation under test.
#[napi(object)]
pub struct NativeBuildInfo {
    pub crate_version: String,
    pub profile: String,
    pub target: String,
}

#[napi(js_name = "buildInfo")]
pub fn build_info() -> NativeBuildInfo {
    NativeBuildInfo {
        crate_version: env!("CARGO_PKG_VERSION").to_string(),
        profile: if cfg!(debug_assertions) {
            "debug".to_string()
        } else {
            "release".to_string()
        },
        target: format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH),
    }
}
