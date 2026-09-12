// System tool settings: show the built-in tools auto-registered in Agent mode and set an approval
// policy for each tool (allow = execute directly / ask = ask before executing / deny = refuse
// outright). Pure settings read/write (settings.system.toolPolicies), synced naturally to WebUI by
// settings sync; adjudication happens on the desktop in resolveToolPolicy. Both clients reuse this
// settings section directly.
//
// Note: per-server MCP tool policies and per-tool plugin policies are inlined next to their
// respective Hub cards (they need runtime data) and are not in this section; this section focuses
// on built-in tools, closing the gap that built-in tools previously could not be governed.

import {
  BROWSER_AUTOMATION_MODES,
  type BrowserAutomationMode,
  type ToolPolicy,
  updateSystem,
} from "@liveagent/app/lib/settings";
import type { SettingsSectionProps } from "@liveagent/app/pages/settings/types";
import { invoke } from "@liveagent/app/shims/tauriCore";
import { Wrench } from "@liveagent/ui/components/IconSet";
import { useLocale } from "@liveagent/ui/i18n/index";
import { useEffect, useMemo, useState } from "react";
import { ToolPolicyToggle } from "../../components/hub/ToolPolicyToggle";
import {
  BUILTIN_TOOL_CATALOG,
  BUILTIN_TOOL_CATEGORIES,
  type BuiltinToolCatalogEntry,
} from "../../lib/tools/builtinToolCatalog";

type BrowserExtensionInstallInfo = {
  connected: boolean;
  extensionDir?: string | null;
};

/**
 * Browser mode selection + extension install guidance for the Browser tool.
 * The extension status query is a desktop command; when the WebUI shim does not implement it,
 * invoke throws, which is swallowed and info is set to null — mode selection still works (the
 * setting takes effect on the desktop via sync), and the guidance area is hidden.
 */
function BrowserModeRow(props: {
  mode: BrowserAutomationMode;
  onChange: (next: BrowserAutomationMode) => void;
}) {
  const { mode, onChange } = props;
  const { t } = useLocale();
  const [info, setInfo] = useState<BrowserExtensionInstallInfo | null>(null);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const next = await invoke<BrowserExtensionInstallInfo>(
          "browser_extension_install_info",
          {},
        );
        if (disposed) return;
        setInfo(next);
      } catch {
        if (disposed) return;
        setInfo(null);
        return; // WebUI / command unavailable: stop polling.
      }
      // In the guidance scenario the user should see the status turn green immediately after
      // installing the extension; a 5s poll is responsive enough and low-cost.
      timer = setTimeout(poll, 5_000);
    };
    void poll();
    return () => {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, []);

  const needsExtension = mode !== "isolated";
  const showGuide = needsExtension && info !== null && !info.connected;

  return (
    <div className="space-y-2 bg-muted/20 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="text-xs text-muted-foreground">{t("settings.browserMode.label")}</span>
        <fieldset
          // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: same as ToolPolicyToggle — the mutually exclusive radio semantic must be expressed to screen readers.
          role="radiogroup"
          aria-label={t("settings.browserMode.label")}
          className="inline-flex min-w-0 shrink-0 items-center rounded-lg border border-border/60 bg-muted/40 p-0.5"
        >
          {BROWSER_AUTOMATION_MODES.map((option) => {
            const active = mode === option;
            return (
              // biome-ignore lint/a11y/useSemanticElements: same as ToolPolicyToggle — the segmented control keeps button styling.
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => onChange(option)}
                className={
                  active
                    ? "rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium leading-none text-primary-foreground transition-colors"
                    : "rounded-md px-2.5 py-1 text-[11px] font-medium leading-none text-muted-foreground transition-colors hover:text-foreground"
                }
              >
                {t(`settings.browserMode.${option}`)}
              </button>
            );
          })}
        </fieldset>
        {needsExtension && info !== null ? (
          <span
            className={
              info.connected
                ? "rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] leading-none text-emerald-500"
                : "rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] leading-none text-amber-500"
            }
          >
            {t(
              info.connected
                ? "settings.browserMode.extensionConnected"
                : "settings.browserMode.extensionMissing",
            )}
          </span>
        ) : null}
      </div>
      <p className="text-[11px] leading-relaxed text-muted-foreground/80">
        {t(`settings.browserMode.${mode}.desc`)}
      </p>
      {showGuide ? (
        <div className="space-y-1.5 rounded-lg border border-amber-500/30 bg-amber-500/5 px-2.5 py-2">
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {t("settings.browserMode.installGuide")}
          </p>
          {info.extensionDir ? (
            <div className="flex flex-wrap items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded bg-muted/60 px-1.5 py-1 font-mono text-[10px] leading-none text-muted-foreground">
                {info.extensionDir}
              </code>
              <button
                type="button"
                className="shrink-0 rounded-md border border-border/60 px-2 py-1 text-[11px] font-medium leading-none text-foreground transition-colors hover:bg-muted/60"
                onClick={() => {
                  void invoke("browser_extension_reveal_dir", {}).catch(() => {});
                }}
              >
                {t("settings.browserMode.openExtensionDir")}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function SystemToolsSection(props: SettingsSectionProps) {
  const { settings, setSettings } = props;
  const { t } = useLocale();

  const policies = settings.system.toolPolicies ?? {};

  const groups = useMemo(
    () =>
      BUILTIN_TOOL_CATEGORIES.map((category) => ({
        category,
        entries: BUILTIN_TOOL_CATALOG.filter((entry) => entry.categoryId === category.id),
      })).filter((group) => group.entries.length > 0),
    [],
  );

  // Read-only tools have no side effects and are always allowed (consistent with resolveToolPolicy's
  // default); no toggle is offered. A non-read-only tool's default comes from the catalog's
  // defaultPolicy (e.g. Browser defaults to ask), so the default display and the runtime
  // adjudication do not diverge.
  function effectivePolicy(entry: BuiltinToolCatalogEntry): ToolPolicy {
    if (entry.isReadOnly) return "allow";
    return policies[entry.toolName] ?? entry.defaultPolicy ?? "allow";
  }

  function setPolicy(entry: BuiltinToolCatalogEntry, next: ToolPolicy) {
    setSettings((prev) => {
      const current = { ...(prev.system.toolPolicies ?? {}) };
      // Explicitly writing the tool's own default value is meaningless → delete the key to keep the
      // config lean; selecting a non-default value (including changing Browser's ask default to
      // allow) must be written explicitly, otherwise resolveToolPolicy falls back to the default
      // branch and the user's choice is silently reverted.
      const fallback: ToolPolicy = entry.defaultPolicy ?? "allow";
      if (next === fallback) {
        delete current[entry.toolName];
      } else {
        current[entry.toolName] = next;
      }
      return updateSystem(prev, {
        toolPolicies: Object.keys(current).length > 0 ? current : undefined,
      });
    });
  }

  const overriddenCount = Object.keys(policies).length;

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10">
          <Wrench className="h-[18px] w-[18px] text-primary" />
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{t("settings.systemTools")}</h3>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            {t("settings.systemToolsDesc")}
          </p>
        </div>
        {overriddenCount > 0 ? (
          <span className="ml-auto shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium leading-none text-primary">
            {t("settings.toolPermissionsOverridden").replace("{count}", String(overriddenCount))}
          </span>
        ) : null}
      </div>

      <div className="space-y-4">
        {groups.map(({ category, entries }) => (
          <div key={category.id} className="space-y-1.5">
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
              {t(category.labelKey)}
            </div>
            <div className="divide-y divide-border/40 overflow-hidden rounded-xl border border-border/50 bg-background/60">
              {entries.map((entry) => {
                const policy = effectivePolicy(entry);
                return (
                  <div key={entry.id}>
                    <div className="flex items-center gap-3 px-3 py-2.5">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                          <span className="text-sm font-medium">
                            {t(`settings.builtinTool.${entry.id}.name`)}
                          </span>
                          <code className="rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] leading-none text-muted-foreground">
                            {entry.toolName}
                          </code>
                          {entry.isReadOnly ? (
                            <span className="rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] leading-none text-emerald-500">
                              {t("settings.toolDetailReadOnly")}
                            </span>
                          ) : null}
                        </div>
                        <div className="mt-0.5 truncate text-xs leading-relaxed text-muted-foreground">
                          {t(`settings.builtinTool.${entry.id}.desc`)}
                        </div>
                      </div>
                      {entry.isReadOnly ? (
                        <span className="shrink-0 text-[11px] text-muted-foreground/60">
                          {t("settings.toolPolicy.allow")}
                        </span>
                      ) : (
                        <ToolPolicyToggle
                          value={policy}
                          ariaLabel={entry.toolName}
                          onChange={(next) => setPolicy(entry, next)}
                        />
                      )}
                    </div>
                    {entry.id === "browser" ? (
                      <BrowserModeRow
                        mode={settings.system.browserAutomationMode}
                        onChange={(next) =>
                          setSettings((prev) => updateSystem(prev, { browserAutomationMode: next }))
                        }
                      />
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
