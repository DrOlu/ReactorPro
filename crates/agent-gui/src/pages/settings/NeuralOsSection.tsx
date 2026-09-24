// Settings -> neuralOS: engine/weights/python resolution, the instance fleet
// with per-instance menu refresh, environment setup, fleet install, and the
// instance generator. Everything here rides the shipped Rust commands —
// no external tooling, no skills.

import { RefreshCw, Server, Wrench } from "@liveagent/ui/components/IconSet";
import { useLocale } from "@liveagent/ui/i18n/index";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";

type InstanceInfo = {
  name: string;
  probes: number;
  hasBridge: boolean;
  path: string;
};

type NeuralOsStatus = {
  enginePath: string | null;
  cactPath: string | null;
  pythonPath: string | null;
  instancesDir: string;
  legacyInstancesDirUsed: boolean;
  instances: InstanceInfo[];
};

const inputClass =
  "w-full rounded-md border border-black/10 bg-transparent px-2 py-1.5 text-sm dark:border-white/15";
const buttonClass =
  "rounded-md border border-black/10 px-3 py-1.5 text-sm hover:bg-black/5 disabled:opacity-50 dark:border-white/15 dark:hover:bg-white/10";
const labelClass = "text-xs font-medium uppercase tracking-wide opacity-60";

function StatusRow({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex items-start gap-2 text-sm">
      <span className={cn("w-24 shrink-0", labelClass)}>{label}</span>
      <span className="min-w-0 break-all font-mono text-xs">{value ?? "not found"}</span>
    </div>
  );
}

export function NeuralOsSection() {
  const { t } = useLocale();
  const [status, setStatus] = useState<NeuralOsStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [installPath, setInstallPath] = useState("");
  const [genName, setGenName] = useState("");
  const [genSource, setGenSource] = useState("");

  const refreshStatus = useCallback(async () => {
    try {
      setError(null);
      setStatus(await invoke<NeuralOsStatus>("neuralos_status"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const run = useCallback(
    async (tag: string, action: () => Promise<string>) => {
      setBusy(tag);
      setNotice(null);
      setError(null);
      try {
        setNotice(await action());
        await refreshStatus();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [refreshStatus],
  );

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6">
      <div>
        <h2 className="text-lg font-semibold">{t("settings.neuralOsTitle")}</h2>
        <p className="mt-1 text-sm opacity-70">{t("settings.neuralOsDesc")}</p>
      </div>

      {error ? (
        <div className="rounded-md border border-red-400/40 bg-red-500/10 p-3 text-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div className="rounded-md border border-emerald-400/40 bg-emerald-500/10 p-3 text-sm text-emerald-700 dark:text-emerald-400">
          {notice}
        </div>
      ) : null}

      <section className="flex flex-col gap-2">
        <h3 className={labelClass}>{t("settings.neuralOsRuntime")}</h3>
        <StatusRow label="Engine" value={status?.enginePath ?? null} />
        <StatusRow label="Weights" value={status?.cactPath ?? null} />
        <StatusRow label="Python" value={status?.pythonPath ?? null} />
        <StatusRow
          label="Instances"
          value={
            status
              ? `${status.instancesDir}${status.legacyInstancesDirUsed ? " (legacy path)" : ""}`
              : null
          }
        />
        <button
          type="button"
          className={cn(buttonClass, "mt-1 flex w-fit items-center gap-2")}
          disabled={busy !== null}
          onClick={() =>
            void run("setup", async () => {
              const result = await invoke<{ python: string; installed: string[] }>(
                "neuralos_setup_environment",
              );
              return `Bridge environment ready: ${result.installed.join(", ")}`;
            })
          }
        >
          <Wrench className="h-3.5 w-3.5" />
          {busy === "setup" ? t("settings.neuralOsSettingUp") : t("settings.neuralOsSetupEnv")}
        </button>
      </section>

      <section className="flex flex-col gap-2">
        <h3 className={labelClass}>{t("settings.neuralOsFleet")}</h3>
        {status?.instances.length ? (
          <div className="flex flex-col gap-1.5">
            {status.instances.map((instance) => (
              <div
                key={instance.name}
                className="flex items-center justify-between gap-3 rounded-md border border-black/10 px-3 py-2 dark:border-white/15"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <Server className="h-3.5 w-3.5 shrink-0 opacity-60" />
                    {instance.name}
                    <span className="text-xs font-normal opacity-60">{instance.probes} probes</span>
                  </div>
                  <div className="truncate font-mono text-[11px] opacity-50">{instance.path}</div>
                </div>
                <button
                  type="button"
                  className={cn(buttonClass, "shrink-0")}
                  disabled={busy !== null || !instance.hasBridge}
                  title={
                    instance.hasBridge ? undefined : "No instance.py — menu refresh unavailable"
                  }
                  onClick={() =>
                    void run(`refresh-${instance.name}`, async () => {
                      const result = await invoke<{ instance: string; probes: number }>(
                        "neuralos_refresh_menu",
                        { instance: instance.name },
                      );
                      return `${result.instance}: menu regenerated (${result.probes} probes)`;
                    })
                  }
                >
                  <RefreshCw
                    className={cn(
                      "h-3.5 w-3.5",
                      busy === `refresh-${instance.name}` && "animate-spin",
                    )}
                  />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm opacity-60">{t("settings.neuralOsNoInstances")}</p>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className={labelClass}>{t("settings.neuralOsInstallTitle")}</h3>
        <div className="flex gap-2">
          <input
            className={inputClass}
            placeholder={t("settings.neuralOsInstallPlaceholder")}
            value={installPath}
            onChange={(event) => setInstallPath(event.target.value)}
          />
          <button
            type="button"
            className={cn(buttonClass, "shrink-0")}
            disabled={busy !== null || installPath.trim().length === 0}
            onClick={() =>
              void run("install", async () => {
                const name = await invoke<string>("neuralos_install_instance", {
                  source: installPath.trim(),
                });
                setInstallPath("");
                return `${name} installed into the managed fleet.`;
              })
            }
          >
            {t("settings.neuralOsInstall")}
          </button>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h3 className={labelClass}>{t("settings.neuralOsGenerateTitle")}</h3>
        <p className="text-xs opacity-60">{t("settings.neuralOsGenerateHint")}</p>
        <div className="flex flex-col gap-2">
          <input
            className={inputClass}
            placeholder={t("settings.neuralOsGenerateNamePlaceholder")}
            value={genName}
            onChange={(event) => setGenName(event.target.value)}
          />
          <input
            className={inputClass}
            placeholder={t("settings.neuralOsGenerateSourcePlaceholder")}
            value={genSource}
            onChange={(event) => setGenSource(event.target.value)}
          />
          <button
            type="button"
            className={cn(buttonClass, "w-fit")}
            disabled={busy !== null || genName.trim().length < 2 || genSource.trim().length === 0}
            onClick={() =>
              void run("generate", async () => {
                const result = await invoke<{ instance: string; probes: number; path: string }>(
                  "neuralos_generate_instance",
                  { name: genName.trim(), source: genSource.trim() },
                );
                setGenName("");
                setGenSource("");
                return `${result.instance} created: ${result.probes} probes at ${result.path}`;
              })
            }
          >
            {busy === "generate"
              ? t("settings.neuralOsGenerating")
              : t("settings.neuralOsGenerate")}
          </button>
        </div>
      </section>
    </div>
  );
}
