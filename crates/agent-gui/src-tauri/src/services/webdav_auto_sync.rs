//! Automatic config sync: coalesces consecutive config changes into a single WebDAV upload.
//!
//! **Upload only, never download.** Automatically pulling the remote would overwrite local config
//! without the user noticing; that failure direction is unacceptable, so pulling is always a manual
//! action.

use std::sync::{
    atomic::{AtomicUsize, Ordering},
    OnceLock,
};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::{sync::mpsc, time::Duration};

/// Wait this long with no new change after a change before uploading.
const DEBOUNCE: Duration = Duration::from_secs(1);
/// Hard upper bound on debouncing. Continuous editing (e.g. typing an API key character by
/// character) keeps refreshing the debounce window, and without a bound the upload could be
/// postponed indefinitely.
const MAX_WAIT: Duration = Duration::from_secs(10);

/// Auto-sync result event. The success or failure of a manual sync is reported to the frontend
/// synchronously via the command's return value and does not go through this event -- so receiving
/// this event always means "background auto-sync".
const STATUS_EVENT: &str = "backup-sync-status-updated";

static DIRTY_TX: OnceLock<mpsc::Sender<()>> = OnceLock::new();
static SUPPRESSION: AtomicUsize = AtomicUsize::new(0);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AutoSyncStatus {
    /// Millisecond timestamp; only set on success.
    last_sync_at: Option<i64>,
    last_error: Option<String>,
}

/// RAII handle for the suppression counter.
pub struct AutoSyncSuppressionGuard;

impl Drop for AutoSyncSuppressionGuard {
    fn drop(&mut self) {
        SUPPRESSION.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Must be held while downloading and applying a remote snapshot.
///
/// Applying a snapshot goes through each config domain's `save_*`, which marks the config dirty;
/// without suppression, the data just pulled from the remote would be pushed straight back.
pub fn suppress() -> AutoSyncSuppressionGuard {
    SUPPRESSION.fetch_add(1, Ordering::SeqCst);
    AutoSyncSuppressionGuard
}

/// Marks the config as changed. It is a no-op when the auto-sync task has not been started (as in
/// the unit-test environment).
pub fn mark_dirty() {
    if suppressed() {
        return;
    }
    if let Some(tx) = DIRTY_TX.get() {
        // Capacity 1: drop directly when an unprocessed dirty signal already exists; the debounce
        // window would coalesce them into a single upload anyway.
        let _ = tx.try_send(());
    }
}

fn suppressed() -> bool {
    SUPPRESSION.load(Ordering::SeqCst) > 0
}

pub fn start(app: AppHandle) {
    let (tx, rx) = mpsc::channel(1);
    if DIRTY_TX.set(tx).is_err() {
        return;
    }
    tauri::async_runtime::spawn(run(app, rx));
}

async fn run(app: AppHandle, mut rx: mpsc::Receiver<()>) {
    loop {
        // Block here while idle; the first dirty signal opens a debounce window.
        if rx.recv().await.is_none() {
            return;
        }

        let cap = tokio::time::sleep(MAX_WAIT);
        tokio::pin!(cap);
        loop {
            tokio::select! {
                // Quiet for a full DEBOUNCE: all changes in the window coalesce into the single
                // upload below.
                _ = tokio::time::sleep(DEBOUNCE) => break,
                // Must not wait forever when new changes keep arriving.
                _ = &mut cap => break,
                signal = rx.recv() => {
                    if signal.is_none() {
                        return;
                    }
                }
            }
        }

        sync_once(&app).await;
    }
}

async fn sync_once(app: &AppHandle) {
    // During debouncing the user may have started a manual download, so confirm once more here.
    //
    // Returning directly would discard the dirty signal already consumed by `rx.recv()` (channel
    // capacity 1, and `mark_dirty` is a no-op during suppression, so no new signal would come in),
    // meaning every local change accumulated during the suppression window would never get another
    // upload. Re-mark dirty once: SUPPRESSION has not dropped to zero yet, so `mark_dirty` would
    // still be blocked, so deliver directly, bypassing it.
    //
    // The cost is that during suppression this spins once per DEBOUNCE (1s) until the guard is
    // released. A download is a second-scale operation, and a few extra purely in-memory
    // re-deliveries are not worth introducing extra machinery like a condition variable.
    if suppressed() {
        if let Some(tx) = DIRTY_TX.get() {
            let _ = tx.try_send(());
        }
        return;
    }

    match crate::commands::settings::auto_upload_backup_snapshot().await {
        // Auto-sync is off or credentials are incomplete; skip silently without disturbing the user.
        Ok(None) => {}
        Ok(Some(last_sync_at)) => emit_status(
            app,
            AutoSyncStatus {
                last_sync_at: Some(last_sync_at),
                last_error: None,
            },
        ),
        // Auto-sync failure must not block any operation; just push an event so the UI shows a
        // banner.
        Err(error) => emit_status(
            app,
            AutoSyncStatus {
                last_sync_at: None,
                last_error: Some(error),
            },
        ),
    }
}

fn emit_status(app: &AppHandle, status: AutoSyncStatus) {
    if let Err(error) = app.emit(STATUS_EVENT, status) {
        eprintln!("failed to emit backup sync status: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Entering/nesting/exiting suppression are combined into one case: `SUPPRESSION` is a
    /// process-wide global, so splitting it into multiple cases would make them stomp on each other
    /// under parallel testing.
    #[test]
    fn suppression_is_reference_counted_and_gates_dirty_marks() {
        assert!(!suppressed(), "initial state should not be suppressed");

        let outer = suppress();
        assert!(suppressed());
        // Marking dirty must have no effect during suppression, otherwise applying a remote snapshot
        // would immediately push the data back to the remote.
        mark_dirty();

        {
            let _inner = suppress();
            assert!(suppressed());
        }
        // Releasing the inner guard must not lift the outer suppression early.
        assert!(suppressed(), "must stay suppressed while an outer guard is still alive");

        drop(outer);
        assert!(!suppressed(), "marking dirty should resume after all guards are released");
    }

    /// A capacity-1 channel compresses multiple changes in the window into one signal -- this is the
    /// basis of debounce coalescing.
    #[test]
    fn dirty_channel_coalesces_bursts_into_one_signal() {
        let (tx, mut rx) = mpsc::channel::<()>(1);
        for _ in 0..5 {
            let _ = tx.try_send(());
        }
        assert!(rx.try_recv().is_ok());
        assert!(rx.try_recv().is_err(), "5 changes should leave only 1 pending signal");
    }
}
