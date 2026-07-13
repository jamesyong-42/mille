//! Streaming file reader for Phase 5 commit 5.11.
//!
//! `FileExplorer.readFileStream(id)` returns a `FileReadStream` #[napi] class.
//! Consumers call `.next()` repeatedly to pull 64KB `Buffer` chunks; `null`
//! signals EOF and `.cancel()` tears down the background Tokio task early.
//!
//! The Phase 6 TS wrapper layers `Symbol.asyncIterator` on top so callers
//! write `for await (const chunk of stream) { ... }`.
//!
//! Design: a `tokio::spawn`ed task opens the file and pushes chunks through
//! an `mpsc::channel(depth=4)`. A `CancellationToken` lets `cancel()` short
//! the task between reads — `AsyncReadExt::read` itself isn't cancellable
//! mid-syscall, matching the advisory semantics used elsewhere in the
//! binding (see `io.rs` / SPEC §4.6).
//!
//! AbortSignal plumbing is deliberately skipped here — same Send-unsafety
//! issue flagged in 5.9 (napi-rs 3.8 `AbortSignal` is `!Send`). Consumers
//! cancel via the explicit `cancel()` method. Tracked as PLAN 13.x.

use std::path::PathBuf;

use napi::bindgen_prelude::{Buffer, Result};
use napi_derive::napi;
use tokio::fs::File;
use tokio::io::AsyncReadExt;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::error::{fx_error_to_napi, io_to_fx};

const CHUNK_SIZE: usize = 64 * 1024;
const CHANNEL_DEPTH: usize = 4;

/// Handle to a streaming file read. Exposed to JS as an opaque class.
#[napi]
pub struct FileReadStream {
    rx: tokio::sync::Mutex<mpsc::Receiver<Result<Buffer>>>,
    cancel: CancellationToken,
}

impl FileReadStream {
    /// Spawn a background reader task and return a handle. The file is
    /// opened inside the task so the outer call stays non-blocking; an
    /// open failure surfaces on the first `next()` call.
    pub(crate) fn open(path: PathBuf) -> Self {
        let (tx, rx) = mpsc::channel::<Result<Buffer>>(CHANNEL_DEPTH);
        let cancel = CancellationToken::new();
        let cancel_bg = cancel.clone();

        tokio::spawn(async move {
            let mut reader = match File::open(&path).await {
                Ok(f) => f,
                Err(e) => {
                    let _ = tx
                        .send(Err(fx_error_to_napi(io_to_fx(e, path.clone()))))
                        .await;
                    return;
                }
            };
            let mut buf = vec![0u8; CHUNK_SIZE];
            loop {
                // Early-out between reads; in-flight reads complete first.
                if cancel_bg.is_cancelled() {
                    break;
                }

                let n = match reader.read(&mut buf).await {
                    Ok(0) => break, // EOF
                    Ok(n) => n,
                    Err(e) => {
                        let _ = tx
                            .send(Err(fx_error_to_napi(io_to_fx(e, path.clone()))))
                            .await;
                        return;
                    }
                };

                let chunk = Buffer::from(buf[..n].to_vec());
                if tx.send(Ok(chunk)).await.is_err() {
                    // Receiver dropped — consumer walked away.
                    break;
                }
            }
            // Dropping tx signals EOF to the consumer.
        });

        Self {
            rx: tokio::sync::Mutex::new(rx),
            cancel,
        }
    }
}

#[napi]
impl FileReadStream {
    /// Next chunk, or `null` on EOF / cancel. IO errors mid-read throw.
    #[napi]
    pub async fn next(&self) -> Result<Option<Buffer>> {
        let mut rx = self.rx.lock().await;
        match rx.recv().await {
            Some(Ok(chunk)) => Ok(Some(chunk)),
            Some(Err(e)) => Err(e),
            None => Ok(None),
        }
    }

    /// Close the stream early. Idempotent.
    #[napi]
    pub fn cancel(&self) {
        self.cancel.cancel();
    }
}
