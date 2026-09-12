//! Page-level high-level operations: each action maps to a set of CDP calls. The
//! session holds the page target's sessionId and the ref→backendDOMNodeId mapping
//! from the most recent snapshot.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine;
use serde_json::{json, Value};

use super::cdp::CdpConnection;
use super::snapshot::{render_ax_tree, SnapshotOutcome};

/// The snapshot budget is controlled by UTF-8 byte count (not character count):
/// bytes/token is roughly constant across writing systems (ASCII ~1B/char, 4
/// chars/token ≈ 4B/token; CJK ~3B/char, ~1.5 chars/token ≈ 4.5B/token), so 28k
/// bytes ≈ 6-7k tokens, safely under the <8k tokens acceptance line. Counting
/// characters would inflate a CJK page to ~3x tokens and blow past the line.
const SNAPSHOT_MAX_BYTES: usize = 28_000;
const EVAL_RESULT_MAX_CHARS: usize = 8_000;

pub(crate) struct PageSession {
    connection: Arc<CdpConnection>,
    session_id: String,
    target_id: String,
    ref_to_backend_node: HashMap<String, i64>,
}

impl PageSession {
    /// Attach to the first page target and enable the required domains.
    pub(crate) async fn attach(connection: Arc<CdpConnection>) -> Result<Self, String> {
        let timeout = Duration::from_secs(10);
        let targets = connection
            .call(None, "Target.getTargets", json!({}), timeout)
            .await?;
        let target_id = targets
            .get("targetInfos")
            .and_then(Value::as_array)
            .and_then(|infos| {
                infos.iter().find(|info| {
                    info.get("type").and_then(Value::as_str) == Some("page")
                        && info
                            .get("url")
                            .and_then(Value::as_str)
                            .map(|url| !url.starts_with("devtools://"))
                            .unwrap_or(false)
                })
            })
            .and_then(|info| info.get("targetId").and_then(Value::as_str))
            .map(str::to_string)
            .ok_or_else(|| "no attachable page target found".to_string())?;
        Self::attach_target(connection, target_id).await
    }

    /// Extension bridging-mode entry point: open a new automation tab in the user's
    /// browser and attach to it. Does not attach to existing tabs — the visible/
    /// controllable scope of automation must be strictly limited to the tab it
    /// created (the extension side likewise only authorizes chrome.debugger on that tab).
    pub(crate) async fn attach_new_tab(connection: Arc<CdpConnection>) -> Result<Self, String> {
        let timeout = Duration::from_secs(10);
        let created = connection
            .call(
                None,
                "Target.createTarget",
                json!({ "url": "about:blank" }),
                timeout,
            )
            .await?;
        let target_id = created
            .get("targetId")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| "Target.createTarget did not return a targetId".to_string())?;
        Self::attach_target(connection, target_id).await
    }

    async fn attach_target(
        connection: Arc<CdpConnection>,
        target_id: String,
    ) -> Result<Self, String> {
        let timeout = Duration::from_secs(10);
        let attached = connection
            .call(
                None,
                "Target.attachToTarget",
                json!({ "targetId": target_id.as_str(), "flatten": true }),
                timeout,
            )
            .await?;
        let session_id = attached
            .get("sessionId")
            .and_then(Value::as_str)
            .ok_or_else(|| "Target.attachToTarget did not return a sessionId".to_string())?
            .to_string();

        let session = Self {
            connection,
            session_id,
            target_id,
            ref_to_backend_node: HashMap::new(),
        };
        for domain in [
            "Page.enable",
            "Runtime.enable",
            "Accessibility.enable",
            "DOM.enable",
        ] {
            session.call(domain, json!({}), timeout).await?;
        }
        Ok(session)
    }

    /// Close the attached page target (extension-mode teardown: close the automation tab).
    pub(crate) async fn close_target(&self) -> Result<(), String> {
        self.connection
            .call(
                None,
                "Target.closeTarget",
                json!({ "targetId": self.target_id.as_str() }),
                Duration::from_secs(5),
            )
            .await
            .map(|_| ())
    }

    async fn call(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        self.connection
            .call(Some(&self.session_id), method, params, timeout)
            .await
    }

    pub(crate) fn is_connected(&self) -> bool {
        !self.connection.is_closed()
    }

    /// Whether the attached page target still exists. When the user closes only the
    /// automation window/tab (the browser-level WS stays up) or the tab crashes, the
    /// session is dead but `is_connected` is still true, so this probe is needed. It
    /// uses browser-level commands and is unaffected by page JS hangs; any probe
    /// failure is treated as invalidated.
    pub(crate) async fn target_alive(&self) -> bool {
        let Ok(targets) = self
            .connection
            .call(None, "Target.getTargets", json!({}), Duration::from_secs(3))
            .await
        else {
            return false;
        };
        targets
            .get("targetInfos")
            .and_then(Value::as_array)
            .map(|infos| {
                infos.iter().any(|info| {
                    info.get("targetId").and_then(Value::as_str) == Some(self.target_id.as_str())
                })
            })
            .unwrap_or(false)
    }

    pub(crate) async fn current_url_and_title(&self) -> Result<(String, String), String> {
        let result = self
            .call(
                "Runtime.evaluate",
                json!({
                    "expression": "JSON.stringify({url: location.href, title: document.title})",
                    "returnByValue": true
                }),
                Duration::from_secs(5),
            )
            .await?;
        let raw = result
            .pointer("/result/value")
            .and_then(Value::as_str)
            .unwrap_or("{}");
        let parsed: Value = serde_json::from_str(raw).unwrap_or(Value::Null);
        Ok((
            parsed
                .get("url")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            parsed
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
        ))
    }

    pub(crate) async fn navigate(&mut self, url: &str, timeout: Duration) -> Result<(), String> {
        let normalized = if url.contains("://") {
            url.to_string()
        } else {
            format!("https://{url}")
        };
        // Only http/https is allowed: file:// can bypass the app's file permission
        // model to read arbitrary local files, and privileged pages like chrome:// and
        // devtools:// are the same, so all are rejected (fail-closed).
        let scheme_allowed = {
            let lower = normalized.trim_start().to_ascii_lowercase();
            lower.starts_with("https://") || lower.starts_with("http://")
        };
        if !scheme_allowed {
            return Err(format!(
                "only http/https URLs are supported; refusing to open \"{normalized}\" (local or privileged schemes such as file:// and chrome:// are unavailable)"
            ));
        }
        let result = self
            .call("Page.navigate", json!({ "url": normalized }), timeout)
            .await?;
        if let Some(error_text) = result.get("errorText").and_then(Value::as_str) {
            if !error_text.is_empty() {
                return Err(format!("navigation failed: {error_text}"));
            }
        }
        // loaderId precisely binds this navigation: completion is when the document
        // for that loader has committed and is ready, rather than relying on
        // Page.loadEventFired — an event waiter matched by (method, session) can be
        // falsely triggered by a late load event from an old navigation, and reading
        // readyState before commit would read the old document. Same-document
        // navigations (anchors, etc.) produce no new loader (no loaderId returned) and
        // complete immediately.
        if let Some(loader_id) = result.get("loaderId").and_then(Value::as_str) {
            let loader_id = loader_id.to_string();
            self.wait_for_navigation_commit(&loader_id, timeout).await?;
        }
        self.ref_to_backend_node.clear();
        Ok(())
    }

    /// Wait for the specified loader's document to commit (the frame's current
    /// loaderId matches) and readyState to reach interactive/complete.
    async fn wait_for_navigation_commit(
        &self,
        loader_id: &str,
        timeout: Duration,
    ) -> Result<(), String> {
        let started = Instant::now();
        loop {
            let frame_tree = self
                .call("Page.getFrameTree", json!({}), Duration::from_secs(5))
                .await?;
            let committed = frame_tree
                .pointer("/frameTree/frame/loaderId")
                .and_then(Value::as_str)
                == Some(loader_id);
            if committed && self.ready_state_ok().await? {
                return Ok(());
            }
            if started.elapsed() >= timeout {
                return Err("timed out waiting for page load".to_string());
            }
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
    }

    async fn ready_state_ok(&self) -> Result<bool, String> {
        let result = self
            .call(
                "Runtime.evaluate",
                json!({ "expression": "document.readyState", "returnByValue": true }),
                Duration::from_secs(5),
            )
            .await?;
        Ok(matches!(
            result.pointer("/result/value").and_then(Value::as_str),
            Some("interactive") | Some("complete")
        ))
    }

    async fn wait_for_ready_state(&self, timeout: Duration) -> Result<(), String> {
        let started = Instant::now();
        loop {
            if self.ready_state_ok().await? {
                return Ok(());
            }
            if started.elapsed() >= timeout {
                return Err("timed out waiting for page load".to_string());
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }

    pub(crate) async fn snapshot(&mut self, timeout: Duration) -> Result<String, String> {
        let tree = self
            .call("Accessibility.getFullAXTree", json!({}), timeout)
            .await?;
        let nodes = tree
            .get("nodes")
            .and_then(Value::as_array)
            .ok_or_else(|| "Accessibility.getFullAXTree did not return nodes".to_string())?;
        let SnapshotOutcome {
            text,
            ref_to_backend_node,
        } = render_ax_tree(nodes, SNAPSHOT_MAX_BYTES);
        self.ref_to_backend_node = ref_to_backend_node;
        Ok(text)
    }

    fn backend_node_for_ref(&self, ref_id: &str) -> Result<i64, String> {
        self.ref_to_backend_node
            .get(ref_id.trim().trim_start_matches("ref="))
            .copied()
            .ok_or_else(|| format!("unknown ref \"{ref_id}\": run snapshot first to get the latest ref list"))
    }

    /// ref → viewport coordinates of the element center; scrolls it into view first when needed.
    async fn center_of_ref(&self, ref_id: &str, timeout: Duration) -> Result<(f64, f64), String> {
        let backend_node_id = self.backend_node_for_ref(ref_id)?;
        let _ = self
            .call(
                "DOM.scrollIntoViewIfNeeded",
                json!({ "backendNodeId": backend_node_id }),
                timeout,
            )
            .await;
        let box_model = self
            .call(
                "DOM.getBoxModel",
                json!({ "backendNodeId": backend_node_id }),
                timeout,
            )
            .await
            .map_err(|e| format!("element is not visible or was removed from the page ({e})"))?;
        let quad = box_model
            .pointer("/model/content")
            .and_then(Value::as_array)
            .ok_or_else(|| "DOM.getBoxModel did not return a content quad".to_string())?;
        let numbers: Vec<f64> = quad.iter().filter_map(Value::as_f64).collect();
        if numbers.len() < 8 {
            return Err("content quad data is incomplete".to_string());
        }
        let center_x = (numbers[0] + numbers[2] + numbers[4] + numbers[6]) / 4.0;
        let center_y = (numbers[1] + numbers[3] + numbers[5] + numbers[7]) / 4.0;
        Ok((center_x, center_y))
    }

    pub(crate) async fn click(&mut self, ref_id: &str, timeout: Duration) -> Result<(), String> {
        let (x, y) = self.center_of_ref(ref_id, timeout).await?;
        for (event_type, click_count) in [("mousePressed", 1), ("mouseReleased", 1)] {
            self.call(
                "Input.dispatchMouseEvent",
                json!({
                    "type": event_type,
                    "x": x,
                    "y": y,
                    "button": "left",
                    "clickCount": click_count
                }),
                timeout,
            )
            .await?;
        }
        Ok(())
    }

    pub(crate) async fn type_text(
        &mut self,
        ref_id: &str,
        text: &str,
        submit: bool,
        timeout: Duration,
    ) -> Result<(), String> {
        self.click(ref_id, timeout).await?;
        // Clear existing content first (select all, then overwrite by inserting).
        let backend_node_id = self.backend_node_for_ref(ref_id)?;
        let _ = self
            .call(
                "DOM.focus",
                json!({ "backendNodeId": backend_node_id }),
                timeout,
            )
            .await;
        self.call(
            "Runtime.evaluate",
            json!({
                "expression": "document.execCommand('selectAll', false, null)",
                "returnByValue": true
            }),
            timeout,
        )
        .await?;
        if text.is_empty() {
            // Empty text = clear the field: Input.insertText with an empty string is a
            // no-op, so delete the selected content instead.
            self.call(
                "Runtime.evaluate",
                json!({
                    "expression": "document.execCommand('delete', false, null)",
                    "returnByValue": true
                }),
                timeout,
            )
            .await?;
        } else {
            self.call("Input.insertText", json!({ "text": text }), timeout)
                .await?;
        }
        if submit {
            // keyDown must carry text to produce keypress semantics: without text CDP
            // dispatches it as rawKeyDown and most forms/search boxes will not trigger
            // implicit submit (Puppeteer likewise sends text:"\r" for Enter). keyUp
            // does not carry text.
            for (event_type, key_text) in [("keyDown", Some("\r")), ("keyUp", None)] {
                let mut params = json!({
                    "type": event_type,
                    "key": "Enter",
                    "code": "Enter",
                    "windowsVirtualKeyCode": 13,
                    "nativeVirtualKeyCode": 13
                });
                if let Some(key_text) = key_text {
                    params["text"] = Value::String(key_text.to_string());
                    params["unmodifiedText"] = Value::String(key_text.to_string());
                }
                self.call("Input.dispatchKeyEvent", params, timeout).await?;
            }
        }
        Ok(())
    }

    pub(crate) async fn screenshot(&self, timeout: Duration) -> Result<(String, String), String> {
        let result = self
            .call(
                "Page.captureScreenshot",
                json!({ "format": "jpeg", "quality": 80 }),
                timeout,
            )
            .await?;
        let data = result
            .get("data")
            .and_then(Value::as_str)
            .ok_or_else(|| "Page.captureScreenshot did not return data".to_string())?;
        // Validate the base64 to keep bad data out of the chat rendering path.
        base64::engine::general_purpose::STANDARD
            .decode(data)
            .map_err(|e| format!("screenshot base64 decode failed: {e}"))?;
        Ok((data.to_string(), "image/jpeg".to_string()))
    }

    pub(crate) async fn eval(&self, expression: &str, timeout: Duration) -> Result<String, String> {
        let result = self
            .call(
                "Runtime.evaluate",
                json!({
                    "expression": expression,
                    "returnByValue": true,
                    "awaitPromise": true
                }),
                timeout,
            )
            .await?;
        // Any exceptionDetails means failure. Take the message by availability: an Error
        // has description; a thrown primitive (throw "..."/Promise.reject(42)) only has
        // value; fall back to the text field last.
        if let Some(details) = result.get("exceptionDetails") {
            let message = details
                .pointer("/exception/description")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| {
                    details
                        .pointer("/exception/value")
                        .map(|value| value.to_string())
                })
                .or_else(|| {
                    details
                        .get("text")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .unwrap_or_else(|| "unknown".to_string());
            return Err(format!("eval threw an exception: {message}"));
        }
        let value = result
            .pointer("/result/value")
            .cloned()
            .unwrap_or(Value::Null);
        let mut rendered = match value {
            Value::String(text) => text,
            other => serde_json::to_string(&other).unwrap_or_default(),
        };
        if rendered.chars().count() > EVAL_RESULT_MAX_CHARS {
            rendered = rendered.chars().take(EVAL_RESULT_MAX_CHARS).collect();
            rendered.push_str("…(truncated)");
        }
        Ok(rendered)
    }

    pub(crate) async fn wait_for_selector(
        &self,
        selector: &str,
        timeout: Duration,
    ) -> Result<(), String> {
        let started = Instant::now();
        let escaped = serde_json::to_string(selector).unwrap_or_else(|_| "\"\"".to_string());
        loop {
            let result = self
                .call(
                    "Runtime.evaluate",
                    json!({
                        "expression": format!("document.querySelector({escaped}) !== null"),
                        "returnByValue": true
                    }),
                    Duration::from_secs(5),
                )
                .await?;
            if result.pointer("/result/value").and_then(Value::as_bool) == Some(true) {
                return Ok(());
            }
            if started.elapsed() >= timeout {
                return Err(format!("timed out waiting for selector: {selector}"));
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }

    pub(crate) async fn back(&mut self, timeout: Duration) -> Result<(), String> {
        let history = self
            .call("Page.getNavigationHistory", json!({}), timeout)
            .await?;
        let current_index = history
            .get("currentIndex")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        if current_index <= 0 {
            return Err("no history entry to go back to".to_string());
        }
        let entries = history
            .get("entries")
            .and_then(Value::as_array)
            .ok_or_else(|| "Page.getNavigationHistory did not return entries".to_string())?;
        let entry_id = entries
            .get((current_index - 1) as usize)
            .and_then(|entry| entry.get("id"))
            .and_then(Value::as_i64)
            .ok_or_else(|| "history entry is missing its id".to_string())?;
        let load_event = self
            .connection
            .wait_event("Page.loadEventFired", Some(&self.session_id));
        self.call(
            "Page.navigateToHistoryEntry",
            json!({ "entryId": entry_id }),
            timeout,
        )
        .await?;
        // The load event is only a fast-path signal (same-document back navigation
        // produces no load event), waiting at most 3s; either way readyState is used to
        // re-verify — the event waiter can be falsely triggered by a late event from an
        // old navigation, and slow pages are covered by readyState polling within the
        // full timeout.
        let _ = tokio::time::timeout(timeout.min(Duration::from_secs(3)), load_event).await;
        self.wait_for_ready_state(timeout).await?;
        self.ref_to_backend_node.clear();
        Ok(())
    }
}
