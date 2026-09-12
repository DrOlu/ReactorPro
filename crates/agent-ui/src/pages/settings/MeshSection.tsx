import { meshClient } from "@liveagent/app/lib/mesh/meshClient";
import type { SettingsSectionProps } from "@liveagent/app/pages/settings/types";
import {
  Check,
  Cloud,
  Copy,
  Radio,
  RefreshCw,
  Server,
  Shield,
  Wifi,
  WifiOff,
} from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import { Input } from "@liveagent/ui/components/ui/input";
import { useLocale } from "@liveagent/ui/i18n/index";
import { emptyMeshStatus, type MeshAgent, type MeshStatus } from "@liveagent/ui/lib/mesh/types";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { SettingsGroup, SettingsRow } from "@liveagent/ui/pages/settings/shared";
import { type ReactNode, useCallback, useEffect, useState } from "react";

/**
 * SettingsGroup renders only a title, so group-level prose and actions live in
 * a leading note row and an explicit action row instead.
 */
function GroupNote({ text }: { text: string }) {
  return (
    <p className="border-b border-border/60 px-5 py-3 text-xs leading-relaxed text-muted-foreground">
      {text}
    </p>
  );
}

function ActionRow({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return <SettingsRow title={title} description={description} control={children} />;
}

/**
 * Settings → Mesh.
 *
 * The bridge itself runs in the gateway, so this section is a view onto the
 * gateway API rather than a local setting: it reports the bridge state and
 * offers the mesh operations the gateway exposes.
 */
export function MeshSection(_props: SettingsSectionProps) {
  const { t } = useLocale();
  const [status, setStatus] = useState<MeshStatus>(emptyMeshStatus);
  const [agents, setAgents] = useState<MeshAgent[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [subscribeSubject, setSubscribeSubject] = useState("");
  const [eventType, setEventType] = useState("");
  const [eventData, setEventData] = useState("{}");
  const [operator, setOperator] = useState("operator");

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      setStatus(await meshClient.status());
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = useCallback(async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
      setError("");
      setStatus(await meshClient.status());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, []);

  const discover = useCallback(async () => {
    setBusy(true);
    try {
      setAgents(await meshClient.discover());
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, []);

  const copyFingerprint = useCallback(async () => {
    if (!status.fingerprint) return;
    try {
      await navigator.clipboard.writeText(status.fingerprint);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setError(t("settings.meshCopyFailed"));
    }
  }, [status.fingerprint, t]);

  const connectionLabel = !status.enabled
    ? t("settings.meshDisabled")
    : status.connected
      ? t("settings.meshConnected")
      : t("settings.meshDisconnected");

  return (
    <div className="space-y-4">
      <SettingsGroup title={t("settings.meshTitle")}>
        <GroupNote text={t("settings.meshDescription")} />
        <ActionRow title={t("settings.meshRefresh")}>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void refresh()}
            disabled={busy}
          >
            <RefreshCw className={cn("h-3.5 w-3.5", busy && "animate-spin")} />
            {t("settings.meshRefresh")}
          </Button>
        </ActionRow>
        <SettingsRow
          title={t("settings.meshStatus")}
          description={status.url || t("settings.meshNoUrl")}
          control={
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium",
                status.connected
                  ? "border-emerald-500/40 text-emerald-600"
                  : "border-border text-muted-foreground",
              )}
              data-testid="mesh-connection"
            >
              {status.connected ? (
                <Wifi className="h-3.5 w-3.5" />
              ) : (
                <WifiOff className="h-3.5 w-3.5" />
              )}
              {connectionLabel}
            </span>
          }
        />
        <SettingsRow
          title={t("settings.meshAgentId")}
          description={t("settings.meshAgentIdHint")}
          control={
            <span className="font-mono text-xs text-muted-foreground">
              {status.agentId || t("settings.meshNotMinted")}
            </span>
          }
        />
        <SettingsRow
          title={t("settings.meshFingerprint")}
          description={t("settings.meshFingerprintHint")}
          control={
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void copyFingerprint()}
              disabled={!status.fingerprint}
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {status.fingerprint || t("settings.meshNoIdentity")}
            </Button>
          }
        />
        <SettingsRow
          title={t("settings.meshSkills")}
          description={t("settings.meshSkillsHint")}
          control={
            <span className="text-xs text-muted-foreground">
              {status.skills.length > 0 ? status.skills.join(", ") : t("settings.meshNoSkills")}
            </span>
          }
        />
      </SettingsGroup>

      {error ? (
        <div
          className="rounded-lg border border-destructive/40 px-3 py-2 text-xs text-destructive"
          role="alert"
        >
          {error}
        </div>
      ) : null}

      <SettingsGroup title={t("settings.meshActions")}>
        <GroupNote text={t("settings.meshActionsHint")} />
        <ActionRow title={t("settings.meshRegister")} description={t("settings.meshAgentIdHint")}>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void run(() => meshClient.register())}
            disabled={busy}
          >
            <Server className="h-3.5 w-3.5" />
            {t("settings.meshRegister")}
          </Button>
        </ActionRow>
        <ActionRow title={t("settings.meshDiscover")} description={t("settings.meshAgentsHint")}>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void discover()}
            disabled={busy}
          >
            <Radio className="h-3.5 w-3.5" />
            {t("settings.meshDiscover")}
          </Button>
        </ActionRow>
        <SettingsRow
          title={t("settings.meshSubscribe")}
          description={t("settings.meshSubscribeHint")}
          control={
            <div className="flex items-center gap-2">
              <Input
                value={subscribeSubject}
                onChange={(event) => setSubscribeSubject(event.target.value)}
                placeholder={t("settings.meshSubscribePlaceholder")}
                className="h-8 w-[220px] text-xs"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy || !subscribeSubject.trim()}
                onClick={() => void run(() => meshClient.subscribe(subscribeSubject.trim()))}
              >
                {t("settings.meshSubscribeAction")}
              </Button>
            </div>
          }
        />
        <SettingsRow
          title={t("settings.meshEmit")}
          description={t("settings.meshEmitHint")}
          control={
            <div className="flex items-center gap-2">
              <Input
                value={eventType}
                onChange={(event) => setEventType(event.target.value)}
                placeholder={t("settings.meshEmitTypePlaceholder")}
                className="h-8 w-[160px] text-xs"
              />
              <Input
                value={eventData}
                onChange={(event) => setEventData(event.target.value)}
                placeholder="{}"
                className="h-8 w-[180px] font-mono text-xs"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy || !eventType.trim()}
                onClick={() =>
                  void run(async () => {
                    let parsed: unknown = {};
                    const raw = eventData.trim();
                    if (raw) {
                      try {
                        parsed = JSON.parse(raw);
                      } catch {
                        throw new Error(t("settings.meshEmitInvalidJson"));
                      }
                    }
                    await meshClient.emit(eventType.trim(), parsed);
                  })
                }
              >
                {t("settings.meshEmitAction")}
              </Button>
            </div>
          }
        />
        {status.subscriptions.length > 0 ? (
          <SettingsRow
            title={t("settings.meshSubscriptions")}
            description={t("settings.meshSubscriptionsHint")}
            control={
              <span className="font-mono text-xs text-muted-foreground">
                {status.subscriptions
                  .map((item) => `${item.subject} (${item.received})`)
                  .join(", ")}
              </span>
            }
          />
        ) : null}
      </SettingsGroup>

      <SettingsGroup title={t("settings.meshAgents")}>
        <GroupNote text={t("settings.meshAgentsHint")} />
        {agents.length === 0 ? (
          <div className="px-5 py-4 text-xs text-muted-foreground">
            {t("settings.meshAgentsEmpty")}
          </div>
        ) : (
          agents.map((agent) => (
            <SettingsRow
              key={agent.id}
              title={agent.name || agent.id}
              description={[agent.id, agent.availability, agent.capabilities.join(", ")]
                .filter(Boolean)
                .join(" · ")}
              control={
                <span className="text-xs text-muted-foreground">
                  {agent.skills.length > 0
                    ? agent.skills.map((skill) => skill.id).join(", ")
                    : t("settings.meshNoSkills")}
                </span>
              }
            />
          ))
        )}
      </SettingsGroup>

      {status.pendingApprovals.length > 0 ? (
        <SettingsGroup title={t("settings.meshApprovals")}>
          <GroupNote text={t("settings.meshApprovalsHint")} />
          <SettingsRow
            title={t("settings.meshApprover")}
            description={t("settings.meshApproverHint")}
            control={
              <Input
                value={operator}
                onChange={(event) => setOperator(event.target.value)}
                className="h-8 w-[180px] text-xs"
              />
            }
          />
          {status.pendingApprovals.map((approval) => (
            <SettingsRow
              key={approval.id}
              title={`${approval.skill} → ${approval.target}`}
              description={`${approval.requester} · ${approval.requestedAt}`}
              control={
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy || !operator.trim()}
                    onClick={() =>
                      void run(() => meshClient.decide(approval.id, "approve", operator.trim()))
                    }
                  >
                    {t("settings.meshApprove")}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy || !operator.trim()}
                    onClick={() =>
                      void run(() => meshClient.decide(approval.id, "deny", operator.trim()))
                    }
                  >
                    {t("settings.meshDeny")}
                  </Button>
                </div>
              }
            />
          ))}
        </SettingsGroup>
      ) : null}

      <SettingsGroup title={t("settings.meshReputation")}>
        <GroupNote text={t("settings.meshReputationHint")} />
        {status.reputation.length === 0 ? (
          <div className="px-5 py-4 text-xs text-muted-foreground">
            {t("settings.meshReputationEmpty")}
          </div>
        ) : (
          status.reputation.map((record) => (
            <SettingsRow
              key={record.agentId}
              title={record.agentId}
              description={`${t("settings.meshSuccesses")}: ${record.successes} · ${t("settings.meshFailures")}: ${record.failures}`}
              control={
                <span className="inline-flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
                  <Shield className="h-3.5 w-3.5" />
                  {record.score.toFixed(3)}
                </span>
              }
            />
          ))
        )}
      </SettingsGroup>

      {status.lastError ? (
        <div className="rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground">
          <Cloud className="mr-1.5 inline h-3.5 w-3.5" />
          {t("settings.meshLastError")}: {status.lastError}
        </div>
      ) : null}
    </div>
  );
}
