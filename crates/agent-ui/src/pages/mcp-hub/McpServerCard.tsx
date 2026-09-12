import {
  type AppSettings,
  type McpServerConfig,
  removeWorkspaceResourceReferences,
  type ToolPolicy,
  updateMcp,
} from "@liveagent/app/lib/settings/index";
import { openUrl } from "@liveagent/app/shims/tauriOpener";
import { ToolPolicyToggle } from "@liveagent/ui/components/hub/ToolPolicyToggle";
import { ExternalLink, Settings, Trash2 } from "@liveagent/ui/components/IconSet";
import { getMcpTransportMeta } from "@liveagent/ui/components/resources/McpTransportMeta";
import { ResourceActivationSwitch } from "@liveagent/ui/components/resources/ResourceActivationSwitch";
import { Badge } from "@liveagent/ui/components/ui/badge";
import { Button } from "@liveagent/ui/components/ui/button";
import { ConfirmDeletePopover } from "@liveagent/ui/components/ui/confirm-action-popover";
import { SearchHighlight } from "@liveagent/ui/components/ui/search-highlight";
import { useLocale } from "@liveagent/ui/i18n/index";
import {
  isOauthServer,
  type McpOauthStatus,
  mcpOauthAuthorize,
  mcpOauthClear,
  mcpOauthStatus,
} from "@liveagent/ui/lib/mcp/oauthApi";
import { resolveMcpDocsHref } from "@liveagent/ui/lib/mcpServerMetadata";
import { isGatewayWebuiRuntime } from "@liveagent/ui/lib/runtimeEnv";
import { memo, useEffect, useState } from "react";

type SetMcpSettingsFn = (updater: (prev: AppSettings) => AppSettings) => void;

function ConfigurationCount(props: { count: number; label: string }) {
  return (
    <span className="inline-flex h-5 items-center gap-1 rounded-full bg-muted px-2 text-[10px] text-muted-foreground ring-1 ring-border/60">
      <span className="font-semibold tabular-nums text-foreground">{props.count}</span>
      <span>{props.label}</span>
    </span>
  );
}

/**
 * OAuth authorization badge + Connect/disconnect (docs/design/mcp-oauth.md §5). The authorization
 * flow can only be initiated on desktop (system browser); the WebUI cannot query authorization
 * status (the invoke channel is unavailable) and only shows a neutral auth-type badge + a "manage on
 * desktop" hint. The token never passes through the frontend; only a status summary is consumed here.
 */
function OauthControls(props: { server: McpServerConfig }) {
  const { server } = props;
  const { t } = useLocale();
  const isWebui = isGatewayWebuiRuntime();
  const [status, setStatus] = useState<McpOauthStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isWebui) return;
    let cancelled = false;
    mcpOauthStatus(server)
      .then((next) => {
        if (!cancelled) setStatus(next);
      })
      .catch(() => {
        // A failed status query is treated as unknown (does not block card rendering).
      });
    return () => {
      cancelled = true;
    };
  }, [isWebui, server]);

  const state = status?.state ?? "none";
  // status null = unknown status: the WebUI's invoke channel does not implement these commands (it
  // can never query them), while on desktop the query has not returned yet/failed. When unknown, only
  // the auth type is labeled, without pretending to be "unauthorized" -- showing "unauthorized" in the
  // WebUI when desktop is actually authorized would be wrong information.
  const statusUnknown = status === null;
  const stateLabel = statusUnknown
    ? t("mcpHub.authOauth")
    : state === "authorized"
      ? t("mcpHub.oauthStatusAuthorized")
      : state === "expired"
        ? t("mcpHub.oauthStatusExpired")
        : t("mcpHub.oauthStatusNone");
  // Design constraint: raw palette classes are banned inside the card; always use Badge semantic
  // variants.
  const badgeVariant =
    state === "authorized" ? "success" : state === "expired" ? "destructive" : "muted";

  async function handleConnect() {
    setBusy(true);
    setError(null);
    try {
      // authorize blocks until the browser callback/timeout; resolving means the latest status has
      // been obtained.
      const next = await mcpOauthAuthorize(server);
      setStatus(next);
    } catch (err) {
      setError(
        `${t("mcpHub.oauthAuthorizeFailed")}: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleDisconnect() {
    setBusy(true);
    setError(null);
    try {
      await mcpOauthClear(server.id);
      setStatus((prev) => (prev ? { ...prev, state: "none", refreshable: false } : prev));
    } catch (err) {
      setError(
        `${t("mcpHub.oauthDisconnectFailed")}: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-1">
      <Badge
        variant={badgeVariant}
        className="h-5 px-1.5 text-[10px]"
        title={
          error ??
          (isWebui
            ? t("mcpHub.oauthDesktopOnly")
            : status?.issuer
              ? `${stateLabel} · ${status.issuer}`
              : stateLabel)
        }
      >
        {stateLabel}
      </Badge>
      {isWebui ? null : (
        <>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-5 rounded-full px-2 text-[10px]"
            disabled={busy}
            onClick={() => void handleConnect()}
          >
            {state === "none" ? t("mcpHub.oauthConnect") : t("mcpHub.oauthReauthorize")}
          </Button>
          {state !== "none" ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-5 rounded-full px-2 text-[10px] text-muted-foreground"
              disabled={busy}
              onClick={() => void handleDisconnect()}
            >
              {t("mcpHub.oauthDisconnect")}
            </Button>
          ) : null}
        </>
      )}
    </span>
  );
}

export const McpServerCard = memo(function McpServerCard(props: {
  server: McpServerConfig;
  idx: number;
  searchQuery: string;
  setSettings: SetMcpSettingsFn;
  onEdit: () => void;
  policy: ToolPolicy;
  onPolicyChange: (next: ToolPolicy) => void;
}) {
  const { server, idx, searchQuery, setSettings, onEdit, policy, onPolicyChange } = props;
  const { t } = useLocale();
  const transport = server.transport || "stdio";
  const isStdio = transport === "stdio";
  const isHttp = transport === "http";
  const { label: transportLabel } = getMcpTransportMeta(transport);
  const enabled = server.enabled;
  const displayName = server.id || `Server ${idx + 1}`;

  const patchServer = (patch: Partial<McpServerConfig>) => {
    setSettings((prev) =>
      updateMcp(prev, {
        servers: prev.mcp.servers.map((item, index) =>
          index === idx ? { ...item, ...patch } : item,
        ),
      }),
    );
  };

  const previewLine = isStdio
    ? [server.command, ...(server.args ?? [])].filter(Boolean).join(" ")
    : server.url || "";
  const previewLabel = isStdio
    ? t("mcpHub.command")
    : isHttp
      ? t("mcpHub.urlHttp")
      : t("mcpHub.urlSse");
  const detailLine = [server.description, previewLine ? `${previewLabel}: ${previewLine}` : null]
    .filter((value): value is string => Boolean(value))
    .join(" · ");
  const argsCount = (server.args ?? []).filter(Boolean).length;
  const envCount = server.env ? Object.keys(server.env).length : 0;
  const headerCount = server.headers ? Object.keys(server.headers).length : 0;
  const docsLink = resolveMcpDocsHref(server.docsUrl);

  return (
    // The container query is attached to the article: when the row width < 520px (phones, or a narrow
    // content area left after a desktop sidebar placeholder), the count/policy/edit/delete group wraps
    // to the second row. Previously only the name column among the four groups could shrink and the
    // rest were all shrink-0, so on a narrow screen the name column was squeezed to 0 width and text
    // overflowed underneath the badges (overlapping).
    <article className="skill-card-enter group @container flex min-h-16 w-full flex-wrap items-center gap-3 bg-card px-4 py-3 text-left transition-colors hover:bg-muted/30">
      <ResourceActivationSwitch
        checked={enabled}
        compact
        label={`${displayName}: ${enabled ? t("settings.disable") : t("settings.enable")}`}
        onCheckedChange={(checked) => patchServer({ enabled: checked })}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-w-0 items-center gap-1.5 @max-[520px]:flex-wrap">
          {/* truncate must be on the button itself: SearchHighlight renders an inline span, and
              overflow/text-overflow have no effect on inline boxes, so text would cross the button
              boundary. */}
          <button
            type="button"
            onClick={onEdit}
            title={t("settings.edit")}
            className="min-w-0 truncate rounded-sm text-left outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          >
            <SearchHighlight
              text={displayName}
              query={searchQuery}
              className="text-[13px] font-semibold text-foreground"
            />
          </button>
          {docsLink ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-5 w-5 shrink-0 text-muted-foreground"
              title={t("mcpHub.storeOpenExternal")}
              aria-label={t("mcpHub.storeOpenExternal")}
              onClick={() => void openUrl(docsLink)}
            >
              <ExternalLink aria-hidden="true" className="h-3 w-3" />
            </Button>
          ) : null}
          <Badge variant="muted" className="h-5 px-1.5 text-[10px] uppercase tracking-wide">
            <SearchHighlight text={transportLabel} query={searchQuery} />
          </Badge>
          {isOauthServer(server) ? <OauthControls server={server} /> : null}
        </div>
        {detailLine ? (
          <button
            type="button"
            onClick={onEdit}
            title={detailLine}
            className="mt-1 min-w-0 truncate rounded-sm text-left text-[11px] text-muted-foreground outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          >
            <SearchHighlight text={detailLine} query={searchQuery} />
          </button>
        ) : null}
      </div>

      {/* On a narrow row basis-full forces the whole group to wrap: counts on the left, actions on the
          right (ml-auto); on a wide row it stays the original one-line four-group layout. The count
          group itself may wrap and is no longer hard-clamped with max-w-48. */}
      <div className="flex shrink-0 items-center gap-3 @max-[520px]:basis-full @max-[520px]:flex-wrap">
        {argsCount > 0 || envCount > 0 || headerCount > 0 ? (
          <div className="flex min-w-0 max-w-48 flex-wrap justify-end gap-1 @max-[520px]:max-w-none @max-[520px]:justify-start">
            {argsCount > 0 ? (
              <ConfigurationCount count={argsCount} label={t("mcpHub.previewArgs")} />
            ) : null}
            {envCount > 0 ? (
              <ConfigurationCount count={envCount} label={t("mcpHub.previewEnv")} />
            ) : null}
            {headerCount > 0 ? (
              <ConfigurationCount count={headerCount} label={t("mcpHub.previewHeaders")} />
            ) : null}
          </div>
        ) : null}

        <div className="grid shrink-0 grid-cols-[auto_2rem_2rem] items-center gap-1.5 @max-[520px]:ml-auto">
          <ToolPolicyToggle
            value={policy}
            ariaLabel={displayName}
            onChange={onPolicyChange}
            size="sm"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onEdit}
            title={t("settings.edit")}
            className="h-8 w-8 text-muted-foreground"
          >
            <Settings className="h-3.5 w-3.5" />
          </Button>
          <ConfirmDeletePopover
            name={server.id || `Server ${idx + 1}`}
            onConfirm={() => {
              // When an OAuth server is deleted, clean up the keychain entry too (best effort; failure
              // does not block deletion but must leave a trace -- the card unmounts with the deletion
              // and has nowhere to attach an error state, so the minimum corresponding to
              // mcpManagerTools' runtimeWarnings is console.warn).
              if (isOauthServer(server) && !isGatewayWebuiRuntime()) {
                void mcpOauthClear(server.id).catch((err: unknown) => {
                  console.warn(
                    `[mcp-hub] failed to clear OAuth credentials for ${server.id}:`,
                    err,
                  );
                });
              }
              setSettings((prev) =>
                removeWorkspaceResourceReferences(
                  updateMcp(prev, {
                    servers: prev.mcp.servers.filter((_, index) => index !== idx),
                  }),
                  { mcpServerIds: [server.id] },
                ),
              );
            }}
          >
            {(open) => (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={open}
                className="h-8 w-8 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                title={t("settings.delete")}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            )}
          </ConfirmDeletePopover>
        </div>
      </div>
    </article>
  );
});
