// Three-state tool approval policy control (allow/ask/deny). Extracted for in-place reuse by the system tools settings page and MCP Hub,
// guaranteeing a consistent appearance everywhere.
// Both ends reuse this shared component directly.

import type { ToolPolicy } from "@liveagent/app/lib/settings";
import { useLocale } from "@liveagent/ui/i18n/index";
import { cn } from "../../lib/shared/utils";

const POLICY_ORDER: readonly ToolPolicy[] = ["allow", "ask", "deny"];

const POLICY_ACTIVE_STYLE: Record<ToolPolicy, string> = {
  allow: "bg-emerald-500 text-white",
  ask: "bg-amber-500 text-white",
  deny: "bg-red-500 text-white",
};

/**
 * Three-state approval policy toggle. value is the currently effective policy, onChange reports the selection. ariaLabel provides the accessible
 * locator (tool name / server id / group name). size="sm" is for compact scenarios inline next to a card.
 */
export function ToolPolicyToggle(props: {
  value: ToolPolicy;
  ariaLabel: string;
  onChange: (next: ToolPolicy) => void;
  size?: "sm" | "md";
}) {
  const { value, ariaLabel, onChange, size = "md" } = props;
  const { t } = useLocale();
  const buttonPad = size === "sm" ? "px-2 py-0.5" : "px-2.5 py-1";
  return (
    <fieldset
      // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: ARIA in HTML allows fieldset to serve as radiogroup; the mutually exclusive radio semantics need to be expressed to screen readers.
      role="radiogroup"
      aria-label={ariaLabel}
      className="inline-flex min-w-0 shrink-0 items-center rounded-lg border border-border/60 bg-muted/40 p-0.5"
    >
      {POLICY_ORDER.map((option) => {
        const active = value === option;
        return (
          // biome-ignore lint/a11y/useSemanticElements: the segmented control keeps button styling; exclusivity is expressed with radio, and switching to native radio inputs would require a visual rework.
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(option)}
            className={cn(
              "rounded-md text-[11px] font-medium leading-none transition-colors",
              buttonPad,
              active ? POLICY_ACTIVE_STYLE[option] : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t(`settings.toolPolicy.${option}`)}
          </button>
        );
      })}
    </fieldset>
  );
}
