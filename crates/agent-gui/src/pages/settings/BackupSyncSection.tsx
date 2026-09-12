import {
  AlertTriangle,
  ArchiveRestore,
  Brain,
  CheckCircle2,
  CircleHelp,
  Cloud,
  CloudDownload,
  Download,
  FileText,
  HardDrive,
  Key,
  Layers,
  Loader2,
  Lock,
  McpLogo,
  MessageSquare,
  Plug,
  Save,
  ScrollText,
  Server,
  Settings2,
  Shield,
  SkillIcon,
  Upload,
  XCircle,
  Zap,
} from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import { useConfirmDialog } from "@liveagent/ui/components/ui/confirm-dialog";
import { Input } from "@liveagent/ui/components/ui/input";
import { Label } from "@liveagent/ui/components/ui/label";
import { LabelTooltip } from "@liveagent/ui/components/ui/label-tooltip";
import { Switch } from "@liveagent/ui/components/ui/switch";
import { useLocale } from "@liveagent/ui/i18n/index";
import { listen } from "@tauri-apps/api/event";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import {
  applyBackupImport,
  BACKUP_SYNC_STATUS_EVENT,
  type BackupDomainCounts,
  type BackupManifest,
  type BackupSyncConfigView,
  type BackupSyncStatusEvent,
  downloadBackup,
  exportBackup,
  fetchRemoteInfo,
  loadSyncConfig,
  peekBackupImport,
  saveSyncConfig,
  testSyncConnection,
  uploadBackup,
} from "../../lib/backup";
import {
  applySyncStatusEvent,
  canTestSyncConnection,
  detectPreset,
  emptyForm,
  formFromView,
  isAutoSyncSuccess,
  isDirty,
  type PresetId,
  SYNC_PRESETS,
  type SyncForm,
} from "./backupSyncForm";
import type { SettingsSectionProps } from "./types";

type Status = { kind: "ok" | "error"; text: string } | null;

type SyncBusy = "load" | "test" | "save" | "upload" | "download" | null;

/** Errors returned by the backend are already display-ready text. */
function errorText(error: unknown): string {
  if (error instanceof Error) return error.message.trim();
  return String(error ?? "").trim();
}

/** manifest.createdAt is RFC3339 UTC, displayed in the local timezone. */
function formatCreatedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

/** lastSyncAt is a millisecond timestamp. */
function formatTimestamp(value: number): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function summarizeDomains(counts: BackupDomainCounts, t: (key: string) => string): string {
  return [
    `${t("settings.backupDomainProviders")} ${counts.providers}`,
    `${t("settings.backupDomainMcp")} ${counts.mcp}`,
    `${t("settings.backupDomainSystem")} ${counts.system}`,
    `${t("settings.backupDomainAgents")} ${counts.agents}`,
    `${t("settings.backupDomainModelFailover")} ${counts.modelFailover}`,
  ].join(" · ");
}

function describeSource(manifest: BackupManifest, t: (key: string) => string) {
  const rows: [string, string][] = [
    [t("settings.backupSourceDevice"), manifest.deviceName],
    [t("settings.backupSourceTime"), formatCreatedAt(manifest.createdAt)],
    [t("settings.backupSourceVersion"), manifest.appVersion],
  ];
  return (
    <div className="space-y-1">
      {rows.map(([label, value]) => (
        <div key={label} className="flex gap-2">
          <span className="shrink-0 opacity-70">{label}</span>
          <span className="break-all font-medium">{value}</span>
        </div>
      ))}
      <div className="pt-1">{summarizeDomains(manifest.domains, t)}</div>
    </div>
  );
}

/** Immediate feedback strip: green on success / red on failure, replacing bare text. */
function FeedbackStrip({ status }: { status: Status }) {
  if (!status) return null;
  const ok = status.kind === "ok";
  return (
    <div
      className={`flex items-start gap-2 rounded-xl border px-3 py-2.5 text-xs leading-relaxed ${
        ok
          ? "border-emerald-600/25 bg-emerald-500/10 text-emerald-700 dark:border-emerald-400/25 dark:text-emerald-300"
          : "border-destructive/30 bg-destructive/10 text-destructive"
      }`}
    >
      {ok ? (
        <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      ) : (
        <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      )}
      <span className="min-w-0 break-all font-medium">{status.text}</span>
    </div>
  );
}

function FieldLabel({ children, hint }: { children: ReactNode; hint?: string }) {
  return (
    <Label className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
      {children}
      {hint ? (
        <LabelTooltip label={<span className="max-w-64 text-xs leading-relaxed">{hint}</span>}>
          <CircleHelp className="h-3.5 w-3.5 cursor-help text-muted-foreground/60" />
        </LabelTooltip>
      ) : null}
    </Label>
  );
}

/** Top status banner: not configured / ready / auto-sync failed, aggregating the last sync time and the auto-sync toggle state. */
function SyncStatusBanner({
  view,
  loading,
  t,
}: {
  view: BackupSyncConfigView | null;
  loading: boolean;
  t: (key: string) => string;
}) {
  if (loading && !view) {
    return (
      <div className="flex items-center gap-3 rounded-2xl border border-border/60 bg-card px-5 py-4">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        <span className="text-sm text-muted-foreground">{t("settings.backupSyncLoading")}</span>
      </div>
    );
  }

  // When loading fails, view is null: show it as "not configured"; the specific error is given by the feedback strip in the form area.
  const configured = view ? canTestSyncConnection(view) : false;
  const failed = Boolean(view?.lastError);

  const iconWrap = failed
    ? "bg-destructive/10 text-destructive"
    : configured
      ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
      : "bg-muted text-muted-foreground";

  return (
    <div className="rounded-2xl border border-border/60 bg-card px-5 py-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div
          className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${iconWrap}`}
        >
          {failed ? <AlertTriangle className="h-5 w-5" /> : <Cloud className="h-5 w-5" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-foreground">
            {failed
              ? t("settings.backupSyncAutoErrorTitle")
              : configured
                ? t("settings.backupSyncStatusReady")
                : t("settings.backupSyncStatusNotConfigured")}
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {configured
              ? view?.lastSyncAt
                ? `${t("settings.backupSyncLastAt")}${formatTimestamp(view.lastSyncAt)}`
                : t("settings.backupSyncStatusNeverSynced")
              : t("settings.backupSyncStatusNotConfiguredHint")}
          </p>
        </div>
        {configured ? (
          <span
            className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium leading-none ${
              view?.autoSync
                ? "border-emerald-600/25 bg-emerald-500/10 text-emerald-700 dark:border-emerald-400/25 dark:text-emerald-300"
                : "border-border/70 bg-muted/45 text-muted-foreground"
            }`}
          >
            <Zap className="h-3 w-3" />
            {view?.autoSync ? t("settings.backupSyncAutoOn") : t("settings.backupSyncAutoOff")}
          </span>
        ) : null}
      </div>
      {failed && view?.lastError ? (
        <p className="mt-3 break-all rounded-xl bg-destructive/10 px-3 py-2 text-xs leading-relaxed text-destructive/90">
          {view.lastError}
        </p>
      ) : null}
    </div>
  );
}

/** Large action tile for local backup. */
function ActionTile({
  icon,
  busy,
  title,
  hint,
  disabled,
  onClick,
}: {
  icon: ReactNode;
  busy: boolean;
  title: string;
  hint: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="group flex w-full items-center gap-3 rounded-xl border border-border/60 bg-background/60 px-3.5 py-3 text-left transition-colors hover:border-border hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-55"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : icon}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-foreground">{title}</span>
        <span className="mt-0.5 block truncate text-xs text-muted-foreground">{hint}</span>
      </span>
    </button>
  );
}

/**
 * Backup scope item: included entries in normal color, excluded ones dimmed.
 *
 * A compact chip layout that wraps based on content width — once the scope grows to
 * 6+6 entries, a two-column grid of large rows would make the right column taller than
 * the left form and give the whole page a scrollbar.
 */
function ScopeItem({
  icon,
  label,
  excluded = false,
}: {
  icon: ReactNode;
  label: string;
  excluded?: boolean;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium leading-none ${
        excluded ? "bg-muted/30 text-muted-foreground/70" : "bg-muted/45 text-foreground/85"
      }`}
    >
      <span
        className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center ${excluded ? "opacity-60" : ""}`}
      >
        {icon}
      </span>
      <span className={excluded ? "line-through decoration-muted-foreground/40" : ""}>{label}</span>
    </span>
  );
}

export function BackupSyncSection(props: SettingsSectionProps) {
  const { reloadSettings } = props;
  const { t } = useLocale();
  const { confirm, dialog } = useConfirmDialog();
  const [busy, setBusy] = useState<"export" | "import" | null>(null);
  const [status, setStatus] = useState<Status>(null);

  const [syncView, setSyncView] = useState<BackupSyncConfigView | null>(null);
  const [form, setForm] = useState<SyncForm>(emptyForm);
  const [preset, setPreset] = useState<PresetId>("custom");
  const [syncBusy, setSyncBusy] = useState<SyncBusy>("load");
  const [syncStatus, setSyncStatus] = useState<Status>(null);

  const dirty = isDirty(form, syncView);
  const syncLocked = syncBusy !== null;

  /**
   * After a restore (import / download) is written to the database, reload the frontend
   * state from SQLite.
   *
   * The consequence of not reloading is not as mild as "showing old values":
   * `persistSettings` diffs per domain, so the next time the user touches any domain it
   * writes the pre-restore in-memory value back to the database, silently rolling back
   * the restore.
   */
  const syncStateAfterRestore = useCallback(async () => {
    await reloadSettings?.();
  }, [reloadSettings]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const view = await loadSyncConfig();
        if (cancelled) return;
        setSyncView(view);
        setForm(formFromView(view));
        setPreset(detectPreset(view.url));
      } catch (error) {
        if (!cancelled) setSyncStatus({ kind: "error", text: errorText(error) });
      } finally {
        if (!cancelled) setSyncBusy(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Results of background auto-sync. Manual sync success/failure is reported in place by
  // the command return value and does not go through this event, so what arrives here is
  // always "a sync that happened when the user did not press the button".
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void listen<BackupSyncStatusEvent>(BACKUP_SYNC_STATUS_EVENT, (event) => {
      setSyncView((prev) => applySyncStatusEvent(prev, event.payload));
      if (isAutoSyncSuccess(event.payload)) {
        setSyncStatus({ kind: "ok", text: t("settings.backupSyncAutoDone") });
      }
    }).then((fn) => {
      // If the component unmounts before listen resolves, unregister the handle as soon as it is obtained, avoiding a leak.
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [t]);

  const patchForm = useCallback((patch: Partial<SyncForm>) => {
    setSyncStatus(null);
    setForm((prev) => ({ ...prev, ...patch }));
  }, []);

  const handlePresetChange = useCallback(
    (value: PresetId) => {
      setPreset(value);
      const matched = SYNC_PRESETS.find((item) => item.id === value);
      // When "Custom" is selected, keep the current URL; only overwrite when a concrete preset is chosen.
      if (matched) patchForm({ url: matched.url });
    },
    [patchForm],
  );

  /**
   * Confirm once before enabling auto-sync.
   *
   * Once the toggle is on, every subsequent config change pushes a snapshot containing
   * the plaintext API Key to the remote, with no per-change prompt. That consequence
   * deserves an explicit nod; turning it off is harmless and takes effect directly.
   */
  const handleAutoSyncChange = useCallback(
    async (checked: boolean) => {
      if (!checked) {
        patchForm({ autoSync: false });
        return;
      }
      const confirmed = await confirm({
        title: t("settings.backupSyncAutoConfirmTitle"),
        subtitle: t("settings.backupSyncAutoConfirmSubtitle"),
        description: t("settings.backupSyncAutoConfirmDesc"),
        confirmLabel: t("settings.backupSyncAutoConfirmAction"),
        cancelLabel: t("settings.backupCancel"),
      });
      if (confirmed) patchForm({ autoSync: true });
    },
    [confirm, patchForm, t],
  );

  /** Test the connection immediately after saving: if the config is wrong, this is the cheapest moment to fix it. */
  const handleSaveSync = useCallback(async () => {
    setSyncBusy("save");
    setSyncStatus(null);
    try {
      const view = await saveSyncConfig({
        url: form.url,
        username: form.username,
        password: form.password,
        passwordTouched: form.passwordTouched,
        remoteDir: form.remoteDir,
        profile: form.profile,
        autoSync: form.autoSync,
      });
      setSyncView(view);
      setForm(formFromView(view));
      setPreset(detectPreset(view.url));

      // With incomplete credentials there is nothing to test; just report a successful save.
      if (!canTestSyncConnection(view)) {
        setSyncStatus({ kind: "ok", text: t("settings.backupSyncSaveDone") });
        return;
      }
      try {
        await testSyncConnection();
        setSyncStatus({ kind: "ok", text: t("settings.backupSyncSaveAndTestDone") });
      } catch (error) {
        // The save itself succeeded; the connection failure is only a warning — the user must not think the config was not stored.
        setSyncStatus({
          kind: "error",
          text: `${t("settings.backupSyncSaveAndTestFailed")}${errorText(error)}`,
        });
      }
    } catch (error) {
      setSyncStatus({
        kind: "error",
        text: errorText(error) || t("settings.backupSyncSaveFailed"),
      });
    } finally {
      setSyncBusy(null);
    }
  }, [form, t]);

  /** Test-connection reads the config in the database, so it is unavailable when unsaved. */
  const handleTestSync = useCallback(async () => {
    setSyncBusy("test");
    setSyncStatus(null);
    try {
      await testSyncConnection();
      setSyncStatus({ kind: "ok", text: t("settings.backupSyncTestDone") });
    } catch (error) {
      setSyncStatus({
        kind: "error",
        text: errorText(error) || t("settings.backupSyncTestFailed"),
      });
    } finally {
      setSyncBusy(null);
    }
  }, [t]);

  const handleUpload = useCallback(async () => {
    setSyncBusy("upload");
    setSyncStatus(null);
    try {
      // When the remote already has a backup, first let the user see what will be overwritten — it may have just been uploaded by another machine.
      const remote = await fetchRemoteInfo();
      if (remote) {
        const confirmed = await confirm({
          title: t("settings.backupSyncUploadConfirmTitle"),
          subtitle: t("settings.backupSyncUploadConfirmSubtitle"),
          description: describeSource(remote.manifest, t),
          confirmLabel: t("settings.backupSyncUpload"),
          cancelLabel: t("settings.backupCancel"),
        });
        if (!confirmed) return;
      }
      const syncedAt = await uploadBackup();
      // The backend cleared last_error on success; sync the view so the banner disappears immediately.
      setSyncView((prev) => (prev ? { ...prev, lastSyncAt: syncedAt, lastError: null } : prev));
      setSyncStatus({ kind: "ok", text: t("settings.backupSyncUploadDone") });
    } catch (error) {
      setSyncStatus({
        kind: "error",
        text: errorText(error) || t("settings.backupSyncUploadFailed"),
      });
    } finally {
      setSyncBusy(null);
    }
  }, [confirm, t]);

  const handleDownload = useCallback(async () => {
    setSyncBusy("download");
    setSyncStatus(null);
    try {
      const remote = await fetchRemoteInfo();
      if (!remote) {
        setSyncStatus({ kind: "error", text: t("settings.backupSyncRemoteEmpty") });
        return;
      }
      const confirmed = await confirm({
        title: t("settings.backupSyncDownloadConfirmTitle"),
        subtitle: t("settings.backupSyncDownloadConfirmSubtitle"),
        description: describeSource(remote.manifest, t),
        confirmLabel: t("settings.backupSyncDownload"),
        cancelLabel: t("settings.backupCancel"),
      });
      if (!confirmed) return;

      const outcome = await downloadBackup();
      await syncStateAfterRestore();
      // A successful download proves this path works; the backend already cleared last_error, so sync the view.
      setSyncView((prev) => (prev ? { ...prev, lastError: null } : prev));
      setSyncStatus({
        kind: "ok",
        text: `${t("settings.backupSyncDownloadDone")}${summarizeDomains(outcome.applied, t)}`,
      });
    } catch (error) {
      setSyncStatus({
        kind: "error",
        text: errorText(error) || t("settings.backupSyncDownloadFailed"),
      });
    } finally {
      setSyncBusy(null);
    }
  }, [confirm, syncStateAfterRestore, t]);

  const handleExport = useCallback(async () => {
    setBusy("export");
    setStatus(null);
    try {
      const path = await exportBackup();
      // Cancelling in the system dialog returns null and does not count as failure.
      if (path) {
        setStatus({ kind: "ok", text: `${t("settings.backupExportDone")}${path}` });
      }
    } catch (error) {
      setStatus({ kind: "error", text: errorText(error) || t("settings.backupExportFailed") });
    } finally {
      setBusy(null);
    }
  }, [t]);

  const handleImport = useCallback(async () => {
    setBusy("import");
    setStatus(null);
    try {
      // Parse and validate only, without writing to the database, so the user can see the source summary before deciding whether to overwrite.
      const preview = await peekBackupImport();
      if (!preview) return;

      const confirmed = await confirm({
        title: t("settings.backupImportConfirmTitle"),
        subtitle: t("settings.backupImportConfirmSubtitle"),
        description: describeSource(preview.manifest, t),
        detail: preview.path,
        confirmLabel: t("settings.backupImportConfirmAction"),
        cancelLabel: t("settings.backupCancel"),
      });
      if (!confirmed) return;

      const outcome = await applyBackupImport(preview.path);
      await syncStateAfterRestore();
      setStatus({
        kind: "ok",
        text: `${t("settings.backupImportDone")}${summarizeDomains(outcome.applied, t)}`,
      });
    } catch (error) {
      setStatus({ kind: "error", text: errorText(error) || t("settings.backupImportFailed") });
    } finally {
      setBusy(null);
    }
  }, [confirm, syncStateAfterRestore, t]);

  const presetOptions: { id: PresetId }[] = [...SYNC_PRESETS, { id: "custom" as const }];

  return (
    <div className="mx-auto w-full max-w-[980px] space-y-5">
      <SyncStatusBanner view={syncView} loading={syncBusy === "load"} t={t} />

      {/* Two columns stretch to equal height (default stretch), keeping the bottom edges of the left and right cards aligned. */}
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
        {/* Left column: WebDAV sync config. The flex layout pins the bottom action area to the bottom edge, leaving a gap in the middle when stretched. */}
        <section className="flex flex-col rounded-2xl border border-border/60 bg-card">
          <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 px-5 py-4">
            <div className="flex items-center gap-2.5">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Cloud className="h-4 w-4" />
              </span>
              <h3 className="text-sm font-semibold text-foreground">
                {t("settings.backupSyncTitle")}
              </h3>
            </div>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-muted/45 px-2.5 py-1 text-[11px] font-medium leading-none text-muted-foreground">
              <Lock className="h-3 w-3" />
              {t("settings.backupSyncCredentialNote")}
            </span>
          </header>

          <div className="flex-1 space-y-4 px-5 py-4">
            <div className="space-y-1.5">
              <FieldLabel>{t("settings.backupSyncPreset")}</FieldLabel>
              <div className="flex flex-wrap gap-1.5">
                {presetOptions.map((item) => {
                  const active = preset === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      disabled={syncLocked}
                      aria-pressed={active}
                      onClick={() => handlePresetChange(item.id)}
                      className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-55 ${
                        active
                          ? "border-primary/40 bg-primary/10 text-primary"
                          : "border-border/70 bg-background/60 text-muted-foreground hover:border-border hover:text-foreground"
                      }`}
                    >
                      {t(`settings.backupSyncPreset_${item.id}`)}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="space-y-1.5">
              <FieldLabel>{t("settings.backupSyncUrl")}</FieldLabel>
              <div className="relative">
                <Server className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60" />
                <Input
                  value={form.url}
                  disabled={syncLocked}
                  placeholder="https://dav.example.com/dav/"
                  className="pl-9"
                  onChange={(event) => patchForm({ url: event.target.value })}
                />
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <FieldLabel>{t("settings.backupSyncUsername")}</FieldLabel>
                <Input
                  value={form.username}
                  disabled={syncLocked}
                  autoComplete="off"
                  onChange={(event) => patchForm({ username: event.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <FieldLabel>{t("settings.backupSyncPassword")}</FieldLabel>
                <div className="relative">
                  <Key className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60" />
                  <Input
                    type="password"
                    value={form.password}
                    disabled={syncLocked}
                    autoComplete="new-password"
                    className="pl-9"
                    placeholder={
                      syncView?.hasPassword && !form.passwordTouched
                        ? t("settings.backupSyncPasswordSaved")
                        : ""
                    }
                    onChange={(event) => {
                      const password = event.target.value;
                      // Clearing the password box is treated as "not touched", not as
                      // "set the password to empty". The backend only adopts a new value
                      // when passwordTouched is set; if an empty string also set it to
                      // true here, a user typing a few characters and then deleting them
                      // would silently wipe the stored password — directly contradicting
                      // this box's own "leave blank to keep unchanged" placeholder hint,
                      // and thereafter auto-sync would be permanently and silently
                      // skipped for incomplete credentials (the credentials branch of
                      // auto_upload). To actually clear the password, turn off sync or
                      // change the username; it should not be triggered by deleting characters.
                      patchForm({ password, passwordTouched: password.length > 0 });
                    }}
                  />
                </div>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <FieldLabel>{t("settings.backupSyncRemoteDir")}</FieldLabel>
                <Input
                  value={form.remoteDir}
                  disabled={syncLocked}
                  placeholder="liveagent"
                  onChange={(event) => patchForm({ remoteDir: event.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <FieldLabel hint={t("settings.backupSyncProfileHint")}>
                  {t("settings.backupSyncProfile")}
                </FieldLabel>
                <Input
                  value={form.profile}
                  disabled={syncLocked}
                  placeholder="default"
                  onChange={(event) => patchForm({ profile: event.target.value })}
                />
              </div>
            </div>

            <div className="flex items-center justify-between gap-3 rounded-xl border border-border/60 bg-background/60 px-3.5 py-3">
              <div className="flex min-w-0 items-center gap-2.5">
                <Zap className="h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <div className="text-xs font-medium text-foreground">
                    {t("settings.backupSyncAuto")}
                  </div>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {t("settings.backupSyncAutoHint")}
                  </p>
                </div>
              </div>
              <Switch
                checked={form.autoSync}
                disabled={syncLocked}
                title={t("settings.backupSyncAuto")}
                aria-label={t("settings.backupSyncAuto")}
                onCheckedChange={(checked) => void handleAutoSyncChange(checked)}
              />
            </div>
          </div>

          <footer className="space-y-3 border-t border-border/60 px-5 py-4">
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" disabled={syncLocked} onClick={() => void handleSaveSync()}>
                {syncBusy === "save" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Save className="h-3.5 w-3.5" />
                )}
                {t("settings.backupSyncSave")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={syncLocked || dirty}
                onClick={() => void handleTestSync()}
              >
                {syncBusy === "test" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Plug className="h-3.5 w-3.5" />
                )}
                {t("settings.backupSyncTest")}
              </Button>
              <div className="mx-1 h-4 w-px bg-border/70" />
              <Button
                variant="outline"
                size="sm"
                disabled={syncLocked || dirty}
                onClick={() => void handleUpload()}
              >
                {syncBusy === "upload" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Upload className="h-3.5 w-3.5" />
                )}
                {t("settings.backupSyncUpload")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={syncLocked || dirty}
                onClick={() => void handleDownload()}
              >
                {syncBusy === "download" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <CloudDownload className="h-3.5 w-3.5" />
                )}
                {t("settings.backupSyncDownload")}
              </Button>
            </div>

            {dirty && !syncLocked ? (
              <div className="flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-300">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                {t("settings.backupSyncDirtyHint")}
              </div>
            ) : null}

            <FeedbackStrip status={syncStatus} />
          </footer>
        </section>

        {/* Right column: local backup + backup scope. The scope card flexes to fill the height, aligning with the left column's bottom edge. */}
        <aside className="flex flex-col gap-5">
          <section className="space-y-3 rounded-2xl border border-border/60 bg-card p-4">
            <div className="flex items-center gap-2.5">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <HardDrive className="h-4 w-4" />
              </span>
              <h3 className="text-sm font-semibold text-foreground">
                {t("settings.backupLocalTitle")}
              </h3>
            </div>

            <div className="space-y-2">
              <ActionTile
                icon={<Download className="h-4 w-4" />}
                busy={busy === "export"}
                title={t("settings.backupExport")}
                hint={t("settings.backupExportHint")}
                disabled={busy !== null}
                onClick={() => void handleExport()}
              />
              <ActionTile
                icon={<Upload className="h-4 w-4" />}
                busy={busy === "import"}
                title={t("settings.backupImport")}
                hint={t("settings.backupImportHint")}
                disabled={busy !== null}
                onClick={() => void handleImport()}
              />
            </div>

            <div className="flex items-start gap-2 text-[11px] leading-relaxed text-muted-foreground">
              <ArchiveRestore className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{t("settings.backupAutoBackupHint")}</span>
            </div>

            <FeedbackStrip status={status} />
          </section>

          <section className="flex-1 space-y-3 rounded-2xl border border-border/60 bg-card p-4">
            <div className="flex items-center gap-2.5">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Shield className="h-4 w-4" />
              </span>
              <h3 className="text-sm font-semibold text-foreground">
                {t("settings.backupScopeTitle")}
              </h3>
            </div>

            <div className="space-y-1.5">
              <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
                {t("settings.backupScopeIncluded")}
              </div>
              <div className="flex flex-wrap gap-1.5">
                <ScopeItem
                  icon={<Server className="h-3.5 w-3.5" />}
                  label={t("settings.backupDomainProviders")}
                />
                <ScopeItem
                  icon={<McpLogo className="h-3.5 w-3.5" />}
                  label={t("settings.backupDomainMcp")}
                />
                <ScopeItem
                  icon={<Settings2 className="h-3.5 w-3.5" />}
                  label={t("settings.backupDomainSystem")}
                />
                <ScopeItem
                  icon={<ScrollText className="h-3.5 w-3.5" />}
                  label={t("settings.backupDomainAgents")}
                />
                <ScopeItem
                  icon={<Layers className="h-3.5 w-3.5" />}
                  label={t("settings.backupDomainModelFailover")}
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
                {t("settings.backupScopeExcluded")}
              </div>
              <div className="flex flex-wrap gap-1.5">
                <ScopeItem
                  excluded
                  icon={<MessageSquare className="h-3.5 w-3.5" />}
                  label={t("settings.backupScopeChat")}
                />
                <ScopeItem
                  excluded
                  icon={<Brain className="h-3.5 w-3.5" />}
                  label={t("settings.backupScopeMemory")}
                />
                <ScopeItem
                  excluded
                  icon={<FileText className="h-3.5 w-3.5" />}
                  label={t("settings.backupScopeUploads")}
                />
                <ScopeItem
                  excluded
                  icon={<Key className="h-3.5 w-3.5" />}
                  label={t("settings.backupScopeSshKeys")}
                />
                <ScopeItem
                  excluded
                  icon={<SkillIcon className="h-3.5 w-3.5" />}
                  label={t("settings.backupScopeSkills")}
                />
                <ScopeItem
                  excluded
                  icon={<HardDrive className="h-3.5 w-3.5" />}
                  label={t("settings.backupScopeDeviceLocal")}
                />
              </div>
            </div>
          </section>
        </aside>
      </div>

      {dialog}
    </div>
  );
}
