import { useSandboxCapability } from "@liveagent/adapters/sandboxCapability";
import type { CommandSafetyMode } from "@liveagent/app/lib/settings";
import { Check, Hand, Shield, ShieldOff, Zap } from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@liveagent/ui/components/ui/dropdown-menu";
import { useLocale } from "@liveagent/ui/i18n/index";
import { COMPOSER_CONTROL_TRIGGER_CLASS } from "@liveagent/ui/lib/chat/composerControlStyles";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { useState } from "react";

const MODE_I18N_KEYS: Record<CommandSafetyMode, string> = {
  ask: "chat.safety.ask",
  auto: "chat.safety.auto",
  sandbox: "chat.safety.sandbox",
  sandboxOffline: "chat.safety.sandboxOffline",
};

const MODE_DESC_I18N_KEYS: Record<CommandSafetyMode, string> = {
  ask: "chat.safety.askDesc",
  auto: "chat.safety.autoDesc",
  sandbox: "chat.safety.sandboxDesc",
  sandboxOffline: "chat.safety.sandboxOfflineDesc",
};

const SAFETY_MODES = ["ask", "auto", "sandbox", "sandboxOffline"] as const;

/**
 * Read masking is a platform/backend-specific capability and cannot be an affirmative
 * cross-platform promise (P2#7). macOS masks with `(deny file-read* (subpath …))` and Linux with
 * `--tmpfs`, so the wording holds there; Windows' networked backend is a WRITE_RESTRICTED
 * restricted token -- the restricting SID only participates in "write" decisions, read/execute
 * skip the second pass, and write ACEs are grant-only with no revocation, so there is **no read
 * masking at all**. Reusing the same "sensitive directories are unreadable" line would lead
 * Windows users to believe their credentials are protected and run untrusted code in sandbox mode,
 * when in fact this is a networked backend (~/.ssh, %USERPROFILE%\.aws\credentials, and provider
 * keys in config.sqlite are all readable and exfiltratable). So that platform uses wording without
 * the read-masking promise.
 * The offline backend (AppContainer) denies reads by default and gains masking incidentally, so
 * the sandboxOffline wording is unaffected.
 */
const MECHANISMS_WITHOUT_READ_MASKING: ReadonlySet<string> = new Set(["restricted-token"]);

function isCommandSafetyMode(value: unknown): value is CommandSafetyMode {
  return value === "ask" || value === "auto" || value === "sandbox" || value === "sandboxOffline";
}

function modeIcon(mode: CommandSafetyMode, className: string) {
  if (mode === "ask") return <Hand className={className} />;
  if (mode === "auto") return <Zap className={className} />;
  if (mode === "sandboxOffline") return <ShieldOff className={className} />;
  return <Shield className={className} />;
}

function triggerIconClass(mode: CommandSafetyMode) {
  if (mode === "sandbox" || mode === "sandboxOffline") {
    return "h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400";
  }
  if (mode === "ask") return "h-4 w-4 shrink-0 text-sky-600 dark:text-sky-400";
  return "h-4 w-4 shrink-0 text-muted-foreground";
}

export function CommandSafetyModeSelector(props: {
  value: CommandSafetyMode;
  disabled?: boolean;
  onChange: (mode: CommandSafetyMode) => void;
}) {
  const { value, disabled, onChange } = props;
  const { t } = useLocale();
  const [menuOpen, setMenuOpen] = useState(false);
  const capability = useSandboxCapability();
  // Write fence (sandbox): disabled when the platform does not support it. Before the desktop
  // probe returns (null) it is optimistically enabled, with fail-closed as the backstop in the
  // execution layer; the WebUI execution side's platform is unknown, likewise left to fail-closed.
  const sandboxUnavailable = capability !== null && !capability.supported;
  // Offline (sandboxOffline): additionally requires that the platform can go offline. When the
  // probe determines network_control=false (for example, Windows cannot derive an AppContainer
  // SID), only this item is disabled; sandbox remains available.
  const offlineUnavailable =
    sandboxUnavailable || (capability !== null && !capability.network_control);
  // Explanation wording when disabled: overall unavailability takes priority, otherwise "offline only is unavailable".
  const disabledHint = sandboxUnavailable
    ? t("chat.safety.sandboxUnavailable")
    : t("chat.safety.sandboxOfflineUnavailable");
  // Whether the networked write-fence backend lacks read masking (Windows restricted token);
  // when missing, the sandbox item uses wording that does not promise "sensitive directories are
  // unreadable". Before the probe returns (null), and on the WebUI (which never gets the desktop
  // mechanism), conservatively treat it as missing to avoid making too strong a promise up front.
  const sandboxLacksReadMasking =
    capability === null ? true : MECHANISMS_WITHOUT_READ_MASKING.has(capability.mechanism);
  const modeDescKey = (mode: CommandSafetyMode) =>
    mode === "sandbox" && sandboxLacksReadMasking
      ? "chat.safety.sandboxDescNoReadMask"
      : MODE_DESC_I18N_KEYS[mode];
  // When the current value itself is unavailable (for example, settings synced from macOS while
  // this machine is Windows) it is still shown but flagged in red, with the execution layer's error
  // as the backstop; no silent rewriting happens here, avoiding settings write-back churn.
  const selected = isCommandSafetyMode(value) ? value : "auto";
  const selectedLabel = t(MODE_I18N_KEYS[selected]);

  return (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            disabled={disabled}
            className={cn(
              COMPOSER_CONTROL_TRIGGER_CLASS,
              "composer-safety-trigger w-8 justify-center gap-0 px-0 data-[popup-open]:bg-muted/60",
            )}
          />
        }
        title={selectedLabel}
        aria-label={`${t("chat.safety.label")}: ${selectedLabel}`}
      >
        {modeIcon(selected, triggerIconClass(selected))}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        className="composer-safety-dropdown flex w-72 flex-col gap-1 overflow-hidden p-1"
        side="top"
        align="start"
      >
        {SAFETY_MODES.map((mode) => {
          const entryDisabled =
            mode === "sandbox"
              ? sandboxUnavailable
              : mode === "sandboxOffline"
                ? offlineUnavailable
                : false;
          const isSelected = mode === selected;
          return (
            <DropdownMenuItem
              key={mode}
              disabled={entryDisabled}
              onSelect={() => onChange(mode)}
              className={cn(
                "composer-safety-item items-start gap-2 whitespace-normal rounded-md py-1.5 text-xs",
                isSelected &&
                  "bg-foreground/[0.07] font-medium data-[highlighted]:bg-foreground/[0.09]",
              )}
            >
              {modeIcon(mode, "mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground")}
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="font-medium leading-5">{t(MODE_I18N_KEYS[mode])}</span>
                <span className="text-[11px] font-normal leading-4 text-muted-foreground">
                  {entryDisabled ? disabledHint : t(modeDescKey(mode))}
                </span>
              </span>
              {isSelected ? (
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              ) : (
                <span className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              )}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
