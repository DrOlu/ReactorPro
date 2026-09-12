import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import "katex/dist/katex.min.css";
import "streamdown/styles.css";
import { inferRuntimePlatform } from "./lib/runtimePlatform";
import { installWebviewNavigationGuard } from "./lib/system/webviewNavigationGuard";

// Built-in webview browser actions such as F5/Ctrl+R would refresh/navigate the whole
// app as if it were a web page -- install the guard before React mounts. In dev the
// reload chords are allowed through, keeping a local full-page-reload debugging tool.
installWebviewNavigationGuard({
  isMac: inferRuntimePlatform() === "macos",
  allowReloadChords: import.meta.env.DEV,
});

if (import.meta.env.DEV) {
  // Dev console hook for transcript perf work: window.__seedLongConversation()
  void import("./lib/debug/seedLongConversation").then(({ seedLongConversation }) => {
    const devWindow = window as Window & { __seedLongConversation?: typeof seedLongConversation };
    devWindow.__seedLongConversation = seedLongConversation;
  });
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
