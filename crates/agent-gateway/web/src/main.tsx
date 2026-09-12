import { GATEWAY_WEBUI_MARKER } from "@liveagent/ui/lib/runtimeEnv";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { DevicesAdminPage } from "./pages/DevicesAdminPage";
import { StatusDashboardPage } from "./pages/StatusDashboardPage";
import "./index.css";
import "katex/dist/katex.min.css";
import "react-complex-tree/lib/style-modern.css";
import "streamdown/styles.css";
import "./styles.css";

// Write the WebUI runtime marker before rendering (the single authoritative
// write point for isGatewayWebuiRuntime).
document.documentElement.dataset.liveagentWebui = GATEWAY_WEBUI_MARKER;

const dashboardPaths = new Set(["/dashboard", "/status-board", "/observatory"]);
// Standalone admin page: /admin/devices (Agent credential management, REST +
// gateway token).
const Root = dashboardPaths.has(window.location.pathname)
  ? StatusDashboardPage
  : window.location.pathname === "/admin/devices"
    ? DevicesAdminPage
    : App;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
