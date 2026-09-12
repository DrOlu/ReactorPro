// ReactorPro Browser Bridge — MV3 service worker.
//
// Reverse-connection bridge service to the ReactorPro desktop app
// (ws://127.0.0.1:19222, see services/browser/bridge.rs on the Rust side); it
// relays CDP inside the user's everyday browser:
//   - browser-level commands (Target.*) are emulated by this file — only the
//     automation tabs created by ReactorPro are exposed, and the user's other
//     tabs are invisible to the desktop app;
//   - session-level commands are forwarded to chrome.debugger.sendCommand via a
//     sessionId → tabId mapping;
//   - chrome.debugger.onEvent is forwarded back as CDP event frames.
// The wire format matches native CDP, so the desktop side's CdpConnection/
// PageSession needs no awareness of the difference.

const BRIDGE_URL = "ws://127.0.0.1:19222";
const RECONNECT_ALARM = "liveagent-bridge-reconnect";
const KEEPALIVE_INTERVAL_MS = 20_000; // MV3 SW is reclaimed after 30s idle; a 20s heartbeat holds it up.
const DEBUGGER_PROTOCOL_VERSION = "1.3";

let socket = null;
let keepaliveTimer = null;

// Automation tab registry: targetId → { tabId, sessionId|null }.
// targetId/sessionId are numbers minted by this extension; they only need to be
// self-consistent within this connection.
const targets = new Map();
let nextOrdinal = 1;

function targetForSession(sessionId) {
  for (const [targetId, entry] of targets) {
    if (entry.sessionId === sessionId) return { targetId, ...entry };
  }
  return null;
}

function targetForTab(tabId) {
  for (const [targetId, entry] of targets) {
    if (entry.tabId === tabId) return { targetId, ...entry };
  }
  return null;
}

function send(frame) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(frame));
  }
}

function sendResult(id, result) {
  send({ id, result });
}

function sendError(id, message) {
  send({ id, error: { message: String(message) } });
}

// ---- browser-level command emulation ----------------------------------------

async function handleGetTargets(id) {
  // Only report automation tabs that are still alive; once the user closes a tab
  // manually it is not found here, and the desktop side's target_alive probe
  // considers the session dead and rebuilds it.
  const targetInfos = [];
  for (const [targetId, entry] of targets) {
    try {
      const tab = await chrome.tabs.get(entry.tabId);
      targetInfos.push({
        targetId,
        type: "page",
        title: tab.title ?? "",
        url: tab.url ?? "",
        attached: entry.sessionId !== null,
      });
    } catch {
      targets.delete(targetId);
    }
  }
  sendResult(id, { targetInfos });
}

async function handleCreateTarget(id, params) {
  const url = typeof params?.url === "string" && params.url ? params.url : "about:blank";
  const tab = await chrome.tabs.create({ url, active: true });
  const targetId = `la-target-${nextOrdinal++}`;
  targets.set(targetId, { tabId: tab.id, sessionId: null });
  sendResult(id, { targetId });
}

async function handleAttachToTarget(id, params) {
  const targetId = params?.targetId;
  const entry = targets.get(targetId);
  if (!entry) {
    sendError(id, `unknown targetId ${targetId}: only tabs created by ReactorPro can be attached`);
    return;
  }
  await chrome.debugger.attach({ tabId: entry.tabId }, DEBUGGER_PROTOCOL_VERSION);
  const sessionId = `la-session-${targetId}`;
  entry.sessionId = sessionId;
  sendResult(id, { sessionId });
}

async function handleCloseTarget(id, params) {
  const entry = targets.get(params?.targetId);
  if (entry) {
    targets.delete(params.targetId);
    try {
      await chrome.tabs.remove(entry.tabId);
    } catch {
      // The user already closed it manually; treat as success.
    }
  }
  sendResult(id, { success: true });
}

// ---- frame dispatch ---------------------------------------------------------

async function handleFrame(raw) {
  let frame;
  try {
    frame = JSON.parse(raw);
  } catch {
    return;
  }
  const { id, method, params, sessionId } = frame;
  if (typeof id !== "number" || typeof method !== "string") return;

  try {
    if (sessionId) {
      const entry = targetForSession(sessionId);
      if (!entry) {
        sendError(id, `unknown sessionId ${sessionId}`);
        return;
      }
      const result = await chrome.debugger.sendCommand(
        { tabId: entry.tabId },
        method,
        params ?? {},
      );
      sendResult(id, result ?? {});
      return;
    }
    switch (method) {
      case "Target.getTargets":
        await handleGetTargets(id);
        break;
      case "Target.createTarget":
        await handleCreateTarget(id, params);
        break;
      case "Target.attachToTarget":
        await handleAttachToTarget(id, params);
        break;
      case "Target.closeTarget":
        await handleCloseTarget(id, params);
        break;
      default:
        sendError(id, `browser-level method ${method} is not supported by the extension bridge`);
    }
  } catch (error) {
    sendError(id, error?.message ?? error);
  }
}

// chrome.debugger events → CDP event frames (with the sessionId mapped back).
chrome.debugger.onEvent.addListener((source, method, params) => {
  const entry = targetForTab(source.tabId);
  if (!entry || !entry.sessionId) return;
  send({ method, params: params ?? {}, sessionId: entry.sessionId });
});

// The debugger was detached (the user clicked the "Cancel" banner, or the tab
// crashed): unregister it, and the desktop side notices on its next action via
// Target.getTargets and rebuilds the session.
chrome.debugger.onDetach.addListener((source) => {
  const entry = targetForTab(source.tabId);
  if (entry) targets.get(entry.targetId).sessionId = null;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const entry = targetForTab(tabId);
  if (entry) targets.delete(entry.targetId);
});

// ---- connection lifecycle ---------------------------------------------------

function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  try {
    socket = new WebSocket(BRIDGE_URL);
  } catch {
    return;
  }
  socket.onopen = () => {
    // The heartbeat frame only extends the SW lifetime; the desktop side ignores
    // it as an "unknown event without an id".
    clearInterval(keepaliveTimer);
    keepaliveTimer = setInterval(() => send({ method: "ReactorPro.ping" }), KEEPALIVE_INTERVAL_MS);
  };
  socket.onmessage = (event) => handleFrame(event.data);
  socket.onclose = () => {
    clearInterval(keepaliveTimer);
    socket = null;
  };
  socket.onerror = () => {
    // onclose will fire right after; reconnection is left to the alarm.
  };
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 0.5 });
  connect();
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 0.5 });
  connect();
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM) connect();
});

// Every time the SW is woken (event-driven), try to reconnect.
connect();
