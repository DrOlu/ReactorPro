import { invoke } from "@liveagent/app/shims/tauriCore";
import type { MentionComposerApp } from "@liveagent/ui/components/chat/MentionComposer";
import { isCuaDriverServer } from "@liveagent/ui/contracts/mcpServerDefaults";
import { registerAppMentionIcons } from "@liveagent/ui/lib/chat/appMentionIcons";
import type { McpServerConfig } from "@liveagent/ui/lib/settings/types";
import { useEffect, useMemo, useState } from "react";

type InstalledApp = {
  name: string;
  bundleId: string;
  path: string;
  iconDataUrl?: string;
};

const EMPTY_APPS: MentionComposerApp[] = [];

/**
 * App candidates for the composer's @ mention (computer use operation targets).
 *
 * The gating matches cua-driver's connection status: it enumerates only when the
 * current conversation's workspace resources carry cua-driver (judged by id or command,
 * the same decision as the approval default/self-reference gate, see
 * contracts/mcpServerDefaults.ts) and the mode is agent; otherwise it returns an empty
 * array and the @ popup behaves exactly as before.
 *
 * The list is fetched once when the gate is first satisfied and cached for the whole
 * conversation lifetime — the installed-app set changes far less often than a
 * conversation lives, so real-time freshness is not worth rescanning the disk every
 * time the popup opens. After a failed enumeration sets fetched, it is not retried
 * within this mount cycle (only a component remount rescans), avoiding repeated disk
 * scans when the gate flips back and forth. The host itself is already filtered out on
 * the Rust side (cuaSelfGuard rejects operations targeting the host).
 *
 * Shared by both ends: `invoke` is resolved per host via `@liveagent/app/shims/tauriCore`
 * — the GUI connects directly to the Tauri command `cua_driver_list_installed_apps`;
 * the WebUI shim relays the same-named command through the Gateway passthrough to the
 * connected desktop Agent (the installed_apps_list arm), listing installed apps on the
 * **desktop host machine**, consistent with the model where the remote conversation runs
 * on the desktop and cua-driver operates the desktop screen.
 *
 * Platform narrowing: the enumeration implementation is in
 * services/cua_driver/installed_apps.rs — macOS scans the applications directory,
 * Windows scans Start Menu shortcuts, and other platforms (Linux, etc.) return an empty
 * list, so no app group appears in the @ popup.
 */
export function useMentionApps(mcpServers: readonly McpServerConfig[], isAgentMode: boolean) {
  const cuaEnabled = useMemo(
    () => isAgentMode && mcpServers.some((server) => isCuaDriverServer(server)),
    [isAgentMode, mcpServers],
  );
  const [apps, setApps] = useState<MentionComposerApp[]>(EMPTY_APPS);
  const [fetched, setFetched] = useState(false);

  useEffect(() => {
    if (!cuaEnabled || fetched) return;
    let cancelled = false;
    invoke<InstalledApp[]>("cua_driver_list_installed_apps")
      .then((installed) => {
        if (cancelled) return;
        setFetched(true);
        const mapped = installed.map((app) => ({
          name: app.name,
          bundleId: app.bundleId || undefined,
          path: app.path,
          iconDataUrl: app.iconDataUrl || undefined,
        }));
        // The chip and user bubble fetch the logo by identity from the registry (the
        // data URL is not serialized); registering once when the list is materialized
        // covers all three display surfaces.
        registerAppMentionIcons(mapped);
        setApps(mapped);
      })
      .catch(() => {
        // A failed enumeration degrades to "no app candidates"; see the retry semantics in the module comment.
        if (!cancelled) setFetched(true);
      });
    return () => {
      cancelled = true;
    };
  }, [cuaEnabled, fetched]);

  return cuaEnabled ? apps : EMPTY_APPS;
}
