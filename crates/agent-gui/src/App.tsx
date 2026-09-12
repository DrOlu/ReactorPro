import type { Context } from "@earendil-works/pi-ai";
import { AppErrorBoundary } from "@liveagent/ui/components/AppErrorBoundary";
import { Pin } from "@liveagent/ui/components/IconSet";
import { useConfirmDialog } from "@liveagent/ui/components/ui/confirm-dialog";
import { LocaleContext, t as translate, useLocaleContextValue } from "@liveagent/ui/i18n/index";
import {
  applyGatewaySettingsSyncPayload,
  buildGatewaySettingsSyncPayload,
  type GatewaySettingsSyncPayload,
} from "@liveagent/ui/lib/settings/sync";
import { useSettingsOverlay } from "@liveagent/ui/lib/settings/useSettingsOverlay";
import { applyFontFamilies } from "@liveagent/ui/lib/shared/fontFamily";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AppBootShell } from "./components/app/AppBootShell";
import { useNativeInputContextMenu } from "./components/input-context-menu/NativeInputContextMenu";
import { WindowsTitleBar } from "./components/WindowsTitleBar";
import { useAppUpdateController } from "./lib/appUpdates";
import { setRetryErrorExtension } from "./lib/providers/runtime/streamRetry";
import {
  type AppSettings,
  getDefaultSettings,
  getNextTheme,
  normalizeSettings,
  resolveEffectiveTheme,
  resolveWorkspaceProjects,
  subscribeToSystemThemePreference,
  THEME_OPTIONS,
  type Theme,
} from "./lib/settings";
import { getSettingsErrorMessage, SettingsStorageError } from "./lib/settings/errors";
import {
  loadPersistedSettingsWithDefaults,
  persistSettings,
  publishGatewaySettingsSync,
  type SettingsSaveState,
} from "./lib/settings/storage";
import type { SectionId } from "./pages/settings/types";

let chatPageModule: Promise<typeof import("./pages/ChatPage")> | null = null;

function loadChatPage() {
  chatPageModule ??= import("./pages/ChatPage");
  return chatPageModule;
}

const ChatPage = lazy(async () => ({ default: (await loadChatPage()).ChatPage }));
const SettingsPage = lazy(async () => ({
  default: (await import("@liveagent/ui/pages/settings/SettingsPage")).SettingsPage,
}));
const CronPromptRunner = lazy(async () => ({
  default: (await import("./components/cron/CronPromptRunner")).CronPromptRunner,
}));
const MemoryOrganizerHost = lazy(async () => ({
  default: (await import("./components/memory/useMemoryOrganizer")).MemoryOrganizerHost,
}));

function getDefaultContext(): Context {
  return {
    messages: [],
  };
}

function getBootAlignedDefaultSettings(): AppSettings {
  const defaults = getDefaultSettings();
  if (typeof document === "undefined") return defaults;
  return {
    ...defaults,
    theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
  };
}

function interpolateMessage(template: string, values: Record<string, string>) {
  return Object.entries(values).reduce(
    (text, [key, value]) => text.replaceAll(`{${key}}`, value),
    template,
  );
}

const GATEWAY_SETTINGS_SYNC_EVENT = "gateway:settings-sync";

function AppChrome(props: { children: ReactNode }) {
  // Plain inputs get a shared cut/copy/paste menu; everything else keeps the
  // suppressed native menu (surfaces with their own menus opt out upstream).
  const { onRootContextMenu, onRootMouseDownCapture, menu } = useNativeInputContextMenu();
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Root-level pointer handlers only route native input menus and dismissals; child controls own activation semantics.
    <div
      className="relative flex h-full w-full flex-col overflow-hidden bg-background"
      onContextMenu={onRootContextMenu}
      onMouseDownCapture={onRootMouseDownCapture}
    >
      <WindowsTitleBar />
      <div className="relative min-h-0 flex-1 overflow-hidden bg-background">{props.children}</div>
      {menu}
    </div>
  );
}

function hasSettingsSyncChanged(prev: AppSettings, next: AppSettings) {
  return (
    JSON.stringify(buildGatewaySettingsSyncPayload(prev)) !==
    JSON.stringify(buildGatewaySettingsSyncPayload(next))
  );
}

function hasSensitiveSettingsUpdates(settings: AppSettings) {
  return (
    settings.customProviders.some((provider) => provider.apiKey.trim().length > 0) ||
    settings.customProviders.some(
      (provider) =>
        provider.usageQuery.apiKey.trim().length > 0 ||
        provider.usageQuery.accessToken.trim().length > 0 ||
        provider.usageQuery.secretAccessKey.trim().length > 0,
    ) ||
    settings.ssh.hosts.some(
      (host) => host.password.trim().length > 0 || host.privateKey.trim().length > 0,
    )
  );
}

function hasSensitiveSettingsUpdatesPayload(payload: unknown) {
  const source =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as {
          providerApiKeyUpdates?: unknown;
          providerUsageQuerySecretUpdates?: unknown;
          sshSecretUpdates?: unknown;
        })
      : {};
  const providerUpdates = source.providerApiKeyUpdates;
  if (
    providerUpdates &&
    typeof providerUpdates === "object" &&
    !Array.isArray(providerUpdates) &&
    Object.values(providerUpdates).some(
      (value) => typeof value === "string" && value.trim().length > 0,
    )
  ) {
    return true;
  }
  const usageQueryUpdates = source.providerUsageQuerySecretUpdates;
  if (
    usageQueryUpdates &&
    typeof usageQueryUpdates === "object" &&
    !Array.isArray(usageQueryUpdates) &&
    Object.values(usageQueryUpdates).some((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const update = value as {
        apiKey?: unknown;
        accessToken?: unknown;
        secretAccessKey?: unknown;
      };
      // Explicitly carrying a field (including an empty string = clear the
      // configured secret) counts as a sensitive update and must not be dropped.
      return (
        typeof update.apiKey === "string" ||
        typeof update.accessToken === "string" ||
        typeof update.secretAccessKey === "string"
      );
    })
  ) {
    return true;
  }
  const sshUpdates = source.sshSecretUpdates;
  return Boolean(
    sshUpdates &&
      typeof sshUpdates === "object" &&
      !Array.isArray(sshUpdates) &&
      Object.values(sshUpdates).some((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return false;
        const update = value as { password?: unknown; privateKey?: unknown };
        return (
          (typeof update.password === "string" && update.password.trim().length > 0) ||
          (typeof update.privateKey === "string" && update.privateKey.trim().length > 0)
        );
      }),
  );
}

function applyRuntimeSystemDefaults(settings: AppSettings, defaultWorkdir: string): AppSettings {
  const normalizedDefaultWorkdir = defaultWorkdir.trim();
  const system =
    !normalizedDefaultWorkdir || settings.system.workdir.trim()
      ? settings.system
      : {
          ...settings.system,
          workdir: normalizedDefaultWorkdir,
        };
  return normalizeSettings({
    ...settings,
    system: resolveWorkspaceProjects(system, normalizedDefaultWorkdir),
  });
}

export default function App() {
  const {
    settingsOpen,
    overlay,
    openSettingsOverlay,
    closeSettingsOverlay,
    handleSettingsOverlayTransitionEnd,
  } = useSettingsOverlay();
  const [settingsSection, setSettingsSection] = useState<SectionId>("system");
  const [settingsProviderId, setSettingsProviderId] = useState<string>();
  const [settingsReady, setSettingsReady] = useState(false);
  const [backgroundHostsReady, setBackgroundHostsReady] = useState(false);
  const [settings, setSettingsState] = useState<AppSettings>(() => getBootAlignedDefaultSettings());
  const [settingsSaveState, setSettingsSaveState] = useState<SettingsSaveState>({
    status: "idle",
  });
  const [context, setContext] = useState<Context>(() => getDefaultContext());
  const runningConversationCountRef = useRef(0);
  const { confirm: requestRestartConfirm, dialog: restartConfirmDialog } = useConfirmDialog();

  const saveSequenceRef = useRef(0);
  const saveChainRef = useRef<Promise<unknown>>(Promise.resolve());
  const defaultWorkdirRef = useRef("");
  // Mirrors `settings` so setSettings/queueSettingsSave can read the latest value
  // synchronously without passing a (side-effecting) function into setSettingsState —
  // React 18 StrictMode double-invokes functional state updaters in development,
  // which would otherwise run those side effects (and any non-idempotent work like
  // crypto.randomUUID() inside caller updaters) twice per call.
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const [systemThemeVersion, setSystemThemeVersion] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: The version is an explicit invalidation signal for the system media query, which resolveEffectiveTheme reads outside React.
  const effectiveTheme = useMemo(
    () => resolveEffectiveTheme(settings.theme),
    [settings.theme, systemThemeVersion],
  );

  useEffect(() => {
    if (settings.theme !== "system") return;
    return subscribeToSystemThemePreference(() => {
      setSystemThemeVersion((version) => version + 1);
    });
  }, [settings.theme]);

  // Sync the theme class to the <html> root element
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", effectiveTheme === "dark");
  }, [effectiveTheme]);

  useEffect(() => {
    applyFontFamilies({
      interfaceFontFamily: settings.customSettings.interfaceFontFamily,
      chatFontFamily: settings.customSettings.chatFontFamily,
      codeFontFamily: settings.customSettings.codeFontFamily,
    });
  }, [
    settings.customSettings.interfaceFontFamily,
    settings.customSettings.chatFontFamily,
    settings.customSettings.codeFontFamily,
  ]);

  useEffect(() => {
    if (!settingsReady) return;
    void invoke("app_set_close_window_behavior", {
      behavior: settings.closeWindowBehavior,
    }).catch(() => {
      // Ignore non-Tauri and older desktop shells.
    });
  }, [settingsReady, settings.closeWindowBehavior]);

  // Restore locally saved global shortcuts on startup (desktop-only; ignored
  // automatically inside non-Tauri environments).
  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | undefined;
    void import("./lib/shortcuts/globalShortcuts")
      .then(({ applyStoredGlobalShortcuts, installAppShortcutListener }) => {
        if (disposed) return;
        cleanup = installAppShortcutListener();
        return applyStoredGlobalShortcuts();
      })
      .catch(() => {});
    return () => {
      disposed = true;
      cleanup?.();
    };
  }, []);

  // Window pin state: the Rust side is the single source of truth (both the
  // shortcut and indicator toggles broadcast through it); query once on mount
  // to cover the indicator being lost after a webview reload.
  const [windowPinned, setWindowPinned] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    invoke<boolean>("app_window_pinned")
      .then((pinned) => {
        if (!cancelled) setWindowPinned(Boolean(pinned));
      })
      .catch(() => {
        // Non-Tauri environment or older desktop shell: ignore.
      });
    listen<boolean>("global-shortcut:pin-changed", (event) => {
      setWindowPinned(Boolean(event.payload));
    })
      .then((nextUnlisten) => {
        if (cancelled) {
          nextUnlisten();
          return;
        }
        unlisten = nextUnlisten;
      })
      .catch(() => {
        // Non-Tauri environment: ignore.
      });
    return () => {
      cancelled = true;
      if (unlisten) {
        unlisten();
      }
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function hydrateSettings() {
      try {
        const persistedSettingsPromise = loadPersistedSettingsWithDefaults();
        void loadChatPage();
        const { settings: loaded, defaultWorkdir } = await persistedSettingsPromise;
        if (!cancelled) {
          defaultWorkdirRef.current = defaultWorkdir;
          const loadedWithDefaults = applyRuntimeSystemDefaults(loaded, defaultWorkdir);
          settingsRef.current = loadedWithDefaults;
          setSettingsState(loadedWithDefaults);
          setSettingsSaveState({ status: "saved" });
          void publishGatewaySettingsSync(loadedWithDefaults).catch((error) => {
            console.error("publish gateway settings sync failed", error);
          });
        }
      } catch (error) {
        if (!cancelled) {
          console.error("load persisted settings failed", error);
          const fallback = getDefaultSettings();
          settingsRef.current = fallback;
          setSettingsState(fallback);
          setSettingsSaveState({
            status: "error",
            message: getSettingsErrorMessage(
              error,
              translate("app.settingsLoadFailed", fallback.locale),
              fallback.locale,
              translate,
            ),
          });
        }
      } finally {
        if (!cancelled) {
          setSettingsReady(true);
        }
      }
    }

    void hydrateSettings();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!settingsReady) return;
    const revealBackgroundHosts = () => setBackgroundHostsReady(true);
    if (typeof window.requestIdleCallback === "function") {
      const idleId = window.requestIdleCallback(revealBackgroundHosts, { timeout: 1_000 });
      return () => window.cancelIdleCallback(idleId);
    }
    const timeoutId = window.setTimeout(revealBackgroundHosts, 0);
    return () => window.clearTimeout(timeoutId);
  }, [settingsReady]);

  // Push the user's retry-error classification (preset Cloudflare 5xx toggles +
  // custom substrings) into the stream-retry runtime. The extension is a pure
  // function of settings, so re-running on every change keeps the runtime in
  // sync without any per-call plumbing. The runtime's default already enables
  // every preset, so this is a no-op until the user actually changes something.
  useEffect(() => {
    setRetryErrorExtension({
      statusCodes: settings.retryErrorSettings.presetStatusCodes,
      patterns: settings.retryErrorSettings.customPatterns,
    });
  }, [settings.retryErrorSettings]);

  const queueSettingsSave = useCallback(
    (prev: AppSettings, next: AppSettings, fallback: string, publishSync: boolean) => {
      const saveSequence = ++saveSequenceRef.current;
      setSettingsSaveState({ status: "saving" });

      saveChainRef.current = saveChainRef.current
        .catch(() => undefined)
        .then(() => persistSettings(prev, next))
        .then(async (persistResult) => {
          const publishTarget = normalizeSettings({
            ...next,
            ...(persistResult.ssh ? { ssh: persistResult.ssh } : {}),
          });
          if (persistResult.ssh && saveSequenceRef.current === saveSequence) {
            const merged = normalizeSettings({
              ...settingsRef.current,
              ...(persistResult.ssh ? { ssh: persistResult.ssh } : {}),
            });
            settingsRef.current = merged;
            setSettingsState(merged);
          }
          if (persistResult.conflict) {
            throw new SettingsStorageError(persistResult.conflict);
          }
          if (publishSync) {
            await publishGatewaySettingsSync(publishTarget);
          }
        })
        .then(() => {
          if (saveSequenceRef.current === saveSequence) {
            setSettingsSaveState({ status: "saved" });
          }
        })
        .catch((error) => {
          if (saveSequenceRef.current === saveSequence) {
            console.error("persist settings failed", error);
            setSettingsSaveState({
              status: "error",
              message: getSettingsErrorMessage(error, fallback, next.locale, translate),
            });
          }
        });
    },
    [],
  );

  const setSettings = useCallback(
    (updater: (prev: AppSettings) => AppSettings) => {
      const prev = settingsRef.current;
      const updated = updater(prev);
      if (updated === prev) return;
      const next = applyRuntimeSystemDefaults(
        normalizeSettings(updated),
        defaultWorkdirRef.current,
      );
      settingsRef.current = next;
      setSettingsState(next);
      queueSettingsSave(
        prev,
        next,
        translate("app.settingsSaveFailed", next.locale),
        hasSettingsSyncChanged(prev, next) || hasSensitiveSettingsUpdates(next),
      );
    },
    [queueSettingsSave],
  );

  // Authoritative live read for tool write paths: settingsRef is updated
  // synchronously by setSettings, so read-modify-write sequences that stay in
  // one synchronous segment can never observe a stale snapshot.
  const getMcpSettings = useCallback(() => settingsRef.current.mcp, []);
  const getToolPolicies = useCallback(() => settingsRef.current.system.toolPolicies, []);

  const reloadPersistedSettings = useCallback(async () => {
    await saveChainRef.current.catch(() => undefined);
    const { settings: loaded, defaultWorkdir } = await loadPersistedSettingsWithDefaults();
    defaultWorkdirRef.current = defaultWorkdir;
    const loadedWithDefaults = applyRuntimeSystemDefaults(loaded, defaultWorkdir);
    settingsRef.current = loadedWithDefaults;
    setSettingsState(loadedWithDefaults);
    setSettingsSaveState({ status: "saved" });
  }, []);

  const toggleTheme = useCallback(() => {
    setSettings((prev) => ({
      ...prev,
      theme: getNextTheme(prev.theme),
    }));
  }, [setSettings]);

  // Direct setting from the tray appearance submenu (identity bail-out avoids
  // redundant persistence).
  const setTheme = useCallback(
    (theme: Theme) => {
      setSettings((prev) => (prev.theme === theme ? prev : { ...prev, theme }));
    },
    [setSettings],
  );

  const openSettings = useCallback(
    (section: SectionId = "system", providerId?: string) => {
      setSettingsSection(section);
      setSettingsProviderId(section === "providers" ? providerId : undefined);
      openSettingsOverlay();
      void reloadPersistedSettings().catch((error) => {
        console.error("reload persisted settings failed", error);
        setSettingsSaveState({
          status: "error",
          message: getSettingsErrorMessage(
            error,
            translate("app.settingsReloadFailed", settingsRef.current.locale),
            settingsRef.current.locale,
            translate,
          ),
        });
      });
    },
    [openSettingsOverlay, reloadPersistedSettings],
  );

  const closeSettings = closeSettingsOverlay;

  // Actions owned by App in the action bus (Rust `app:action`): theme / open
  // settings / gateway toggle / check for updates, and on "new conversation"
  // first collapse the settings overlay (the conversation side is handled by
  // ChatPage).
  const closeSettingsRef = useRef(closeSettings);
  closeSettingsRef.current = closeSettings;
  const settingsOpenRef = useRef(settingsOpen);
  settingsOpenRef.current = settingsOpen;
  const openSettingsRef = useRef(openSettings);
  openSettingsRef.current = openSettings;
  const setThemeRef = useRef(setTheme);
  setThemeRef.current = setTheme;
  const runUpdateCheckRef = useRef<() => void>(() => {});
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    listen<{ action: string; id?: string; value?: string }>("app:action", (event) => {
      switch (event.payload.action) {
        case "new-chat": {
          if (settingsOpenRef.current) {
            closeSettingsRef.current();
          }
          break;
        }
        case "set-theme": {
          const theme = event.payload.value;
          if ((THEME_OPTIONS as readonly string[]).includes(theme ?? "")) {
            setThemeRef.current(theme as Theme);
          }
          break;
        }
        case "open-settings": {
          openSettingsRef.current();
          break;
        }
        case "check-updates": {
          openSettingsRef.current("about");
          runUpdateCheckRef.current();
          break;
        }
        case "gateway-toggle": {
          // Same path as the remote toggle on the settings page: the settings save
          // chain persists and calls apply_config, keeping the DB / controller /
          // settings-page toggle consistent (do not change to a direct Rust
          // toggle).
          setSettings((prev) => ({
            ...prev,
            remote: { ...prev.remote, enabled: !prev.remote.enabled },
          }));
          break;
        }
        default:
          break;
      }
    })
      .then((nextUnlisten) => {
        if (cancelled) {
          nextUnlisten();
          return;
        }
        unlisten = nextUnlisten;
      })
      .catch(() => {
        // Non-Tauri environment: ignore.
      });
    return () => {
      cancelled = true;
      if (unlisten) {
        unlisten();
      }
    };
  }, [setSettings]);

  const handleTransitionEnd = handleSettingsOverlayTransitionEnd;

  const localeContextValue = useLocaleContextValue(settings.locale);

  const appUpdateMessages = useMemo(
    () => ({
      checkFailed: translate("settings.aboutUpdateCheckFailed", settings.locale),
      installFailed: translate("settings.aboutUpdateInstallFailed", settings.locale),
      restartFailed: translate("settings.aboutRestartFailed", settings.locale),
    }),
    [settings.locale],
  );

  const beforeAppRestart = useCallback(async () => {
    const count = runningConversationCountRef.current;
    if (count === 0) return true;

    return requestRestartConfirm({
      title: translate("appUpdate.runningTasksTitle", settings.locale),
      description: interpolateMessage(
        translate("appUpdate.runningTasksDescription", settings.locale),
        { count: String(count) },
      ),
      cancelLabel: translate("appUpdate.restartLater", settings.locale),
      confirmLabel: translate("appUpdate.restartAnyway", settings.locale),
      closeLabel: translate("appUpdate.restartLater", settings.locale),
      preferCancel: true,
    });
  }, [requestRestartConfirm, settings.locale]);

  const handleRunningConversationCountChange = useCallback((count: number) => {
    runningConversationCountRef.current = count;
  }, []);

  const appUpdate = useAppUpdateController({
    enabled: settingsReady,
    includePrereleases: settings.updates.includePrereleases,
    messages: appUpdateMessages,
    beforeRestart: beforeAppRestart,
  });
  // Tray "check for updates" action: the controller is created after the
  // listening effect, backfilled via ref.
  runUpdateCheckRef.current = () => {
    void appUpdate.runCheck().catch(() => undefined);
  };

  useEffect(() => {
    if (!settingsReady) return;
    void import("@liveagent/ui/lib/automation/index")
      .then(({ initAutomation }) => initAutomation())
      .catch((error) => {
        console.warn("Failed to initialize automation store", error);
      });
  }, [settingsReady]);

  useEffect(() => {
    if (!settingsReady) {
      return;
    }

    let cancelled = false;
    const unlistenPromise = listen<GatewaySettingsSyncPayload>(
      GATEWAY_SETTINGS_SYNC_EVENT,
      (event) => {
        if (cancelled) {
          return;
        }

        const prev = settingsRef.current;
        const next = applyRuntimeSystemDefaults(
          applyGatewaySettingsSyncPayload(prev, event.payload),
          defaultWorkdirRef.current,
        );
        const publicChanged = hasSettingsSyncChanged(prev, next);
        if (!publicChanged && !hasSensitiveSettingsUpdatesPayload(event.payload)) {
          return;
        }
        settingsRef.current = next;
        setSettingsState(next);
        queueSettingsSave(
          prev,
          next,
          translate("app.gatewaySettingsSyncFailed", next.locale),
          publicChanged,
        );
      },
    );

    return () => {
      cancelled = true;
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, [queueSettingsSave, settingsReady]);

  if (!settingsReady) {
    return (
      <LocaleContext.Provider value={localeContextValue}>
        <AppChrome>
          <AppBootShell loadingLabel={translate("app.loading", settings.locale)} />
        </AppChrome>
      </LocaleContext.Provider>
    );
  }

  const visible = settingsOpen;
  const active = overlay === "open";

  return (
    <LocaleContext.Provider value={localeContextValue}>
      <AppChrome>
        {backgroundHostsReady ? (
          <Suspense fallback={null}>
            <CronPromptRunner settings={settings} />
            <MemoryOrganizerHost settings={settings} setSettings={setSettings} />
          </Suspense>
        ) : null}
        <AppErrorBoundary>
          <Suspense
            fallback={<AppBootShell loadingLabel={translate("app.loading", settings.locale)} />}
          >
            <ChatPage
              settings={settings}
              setSettings={setSettings}
              getMcpSettings={getMcpSettings}
              getToolPolicies={getToolPolicies}
              context={context}
              setContext={setContext}
              onOpenSettings={openSettings}
              onToggleTheme={toggleTheme}
              appUpdate={appUpdate}
              onRunningConversationCountChange={handleRunningConversationCountChange}
            />
          </Suspense>
        </AppErrorBoundary>
        {visible && (
          <div
            className={cn(
              "absolute inset-0 z-50 transition-all duration-300 ease-out",
              active ? "opacity-100 translate-y-0" : "opacity-0 translate-y-6",
            )}
            onTransitionEnd={handleTransitionEnd}
          >
            <AppErrorBoundary>
              <Suspense
                fallback={
                  <div className="flex h-full items-center justify-center bg-background text-sm text-muted-foreground">
                    {translate("app.loading", settings.locale)}
                  </div>
                }
              >
                <SettingsPage
                  settings={settings}
                  setSettings={setSettings}
                  saveState={settingsSaveState}
                  onBack={closeSettings}
                  initialSection={settingsSection}
                  initialProviderId={settingsProviderId}
                  appUpdate={appUpdate}
                  reloadSettings={reloadPersistedSettings}
                />
              </Suspense>
            </AppErrorBoundary>
          </div>
        )}
        {windowPinned && (
          <button
            type="button"
            onClick={() => {
              void invoke("app_toggle_window_pin").catch(() => {});
            }}
            title={translate("app.windowPinnedHint", settings.locale)}
            className="layer-toast absolute top-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary shadow-sm backdrop-blur transition-colors hover:bg-primary/20"
          >
            <Pin className="h-3 w-3" />
            {translate("app.windowPinned", settings.locale)}
          </button>
        )}
        {restartConfirmDialog}
      </AppChrome>
    </LocaleContext.Provider>
  );
}
