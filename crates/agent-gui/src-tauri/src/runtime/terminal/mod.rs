//! Terminal runtime module (split from the original single-file terminal.rs, code migrated
//! verbatim, behavior unchanged).
//!
//! - [`types`]: external DTOs / event payloads and response structures
//! - [`state`]: internal session state (session entries, SSH session runtime, pending prompts, etc.)
//! - [`output`]: output ring buffer, echo detection and tail reads
//! - [`registry`]: `TerminalSessionRegistry` core lifecycle (create/list/input/resize/close/subscribe)
//! - [`ssh_session`]: SSH session orchestration (create/prompt reply/reconnect/delay/exec)
//! - [`tabs`]: SSH terminal tab snapshots and cleanup
//! - [`events`]: event broadcast and terminal stream dispatch
//! - [`ssh_connect`]: SSH transport establishment and HTTP/SOCKS5 proxy
//! - [`ssh_auth`]: SSH auth material parsing, identity path expansion and keyboard-interactive auth
//! - [`ssh_channel`]: SSH shell/exec/SFTP channels
//! - [`ssh_io`]: SSH session IO pump and reconnect executor
//! - [`shell`]: local shell parsing, PTY environment and process cleanup
//! - [`util`]: small helper functions

use std::collections::HashMap;
use std::sync::atomic::AtomicUsize;
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;
use tauri::AppHandle;

mod events;
mod output;
mod registry;
mod shell;
mod ssh_auth;
mod ssh_channel;
mod ssh_connect;
mod ssh_io;
mod ssh_local_forward;
mod ssh_session;
mod state;
mod tabs;
#[cfg(test)]
mod tests;
mod types;
mod util;

pub(crate) use output::*;
pub use shell::terminal_shell_options;
pub(crate) use shell::*;
pub(crate) use ssh_auth::*;
pub(crate) use ssh_channel::*;
pub(crate) use ssh_connect::*;
pub(crate) use ssh_io::*;
pub(crate) use ssh_local_forward::*;
pub(crate) use state::*;
pub use types::*;
pub(crate) use util::*;

pub(crate) const DEFAULT_ROWS: u16 = 24;
pub(crate) const DEFAULT_COLS: u16 = 80;
pub(crate) const MAX_RING_CHUNKS: usize = 4096;
pub(crate) const MAX_TAIL_BYTES: usize = 256 * 1024;
pub(crate) const SSH_PROMPT_TIMEOUT: Duration = Duration::from_secs(120);
pub(crate) const SSH_RECONNECT_MAX_ATTEMPTS: u8 = 3;
pub(crate) const SSH_RECONNECT_DELAYS: [Duration; 3] = [
    Duration::from_secs(2),
    Duration::from_secs(5),
    Duration::from_secs(10),
];
pub(crate) const SSH_RECONNECT_ATTEMPT_TIMEOUT: Duration = Duration::from_secs(20);
pub(crate) const SSH_KEEPALIVE_INTERVAL: Duration = Duration::from_secs(30);
pub(crate) const SSH_KEEPALIVE_MAX_MISSES: usize = 3;
pub(crate) const SSH_STATUS_CONNECTED: &str = "connected";
pub(crate) const SSH_STATUS_RECONNECTING: &str = "reconnecting";
pub(crate) const SSH_STATUS_DISCONNECTED: &str = "disconnected";
pub const TERMINAL_EVENT_NAME: &str = "terminal:event";
pub const TERMINAL_STREAM_EVENT_NAME: &str = "terminal:stream";
pub const SSH_LOCAL_FORWARD_EVENT_NAME: &str = "terminal:ssh-local-forward";
pub(crate) const SSH_LOCAL_FORWARD_CHANNEL_OPEN_TIMEOUT: Duration = Duration::from_secs(10);
pub(crate) const SSH_LOCAL_FORWARD_MAX_PER_SESSION: usize = 8;
pub(crate) const SSH_LOCAL_FORWARD_MAX_CONNECTIONS: usize = 32;
pub(crate) const SSH_LOCAL_FORWARD_MAX_GLOBAL_CONNECTIONS: usize = 128;
pub(crate) const SSH_EXEC_DEFAULT_MAX_BYTES: usize = 64 * 1024;
pub(crate) const SSH_EXEC_MAX_BYTES: usize = 256 * 1024;
pub(crate) const SSH_EXEC_DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);
pub(crate) const SSH_EXEC_MAX_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Default)]
pub struct TerminalSessionRegistry {
    sessions: Mutex<HashMap<String, Arc<TerminalSessionEntry>>>,
    pending_ssh_prompts: Mutex<HashMap<String, PendingSshPrompt>>,
    ssh_terminal_tabs_tx: Mutex<()>,
    ssh_terminal_tabs: Mutex<HashMap<String, SshTerminalTabsState>>,
    app_handle: Mutex<Option<AppHandle>>,
    subscribers: Arc<Mutex<HashMap<usize, mpsc::Sender<TerminalEvent>>>>,
    stream_subscribers: Arc<Mutex<HashMap<usize, mpsc::Sender<TerminalStreamEvent>>>>,
    echo_dispatch: Mutex<HashMap<String, TerminalEchoDispatchState>>,
    ssh_local_forwards: SshLocalForwardRegistry,
    next_subscriber_id: AtomicUsize,
}

impl Drop for TerminalSessionRegistry {
    fn drop(&mut self) {
        self.ssh_local_forwards.cancel_all();
        if let Ok(sessions) = self.sessions.get_mut() {
            for entry in sessions.values() {
                terminate_terminal_entry(entry);
            }
            sessions.clear();
        }
    }
}
