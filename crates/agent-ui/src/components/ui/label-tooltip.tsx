import type { ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

/**
 * Plain-text label tooltip (Base UI): the composer runtime controls and the context usage ring
 * share the same visuals. Uncontrolled by default (shown on hover); touch-tap-driven callers (the
 * context usage ring) pass open/onOpenChange for controlled mode and disable closeOnClick -- the
 * trigger's press-to-close happens on pointerdown, earlier than the caller's click-stage toggle
 * decision, and keeping it would break the two-stage tap criterion.
 */
export function LabelTooltip(props: {
  label: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  closeOnClick?: boolean;
  children: ReactNode;
}) {
  const { onOpenChange } = props;
  return (
    <Tooltip
      open={props.open}
      onOpenChange={onOpenChange ? (open) => onOpenChange(open) : undefined}
    >
      <TooltipTrigger
        delay={0}
        closeOnClick={props.closeOnClick ?? true}
        render={<span className="inline-flex shrink-0">{props.children}</span>}
      />
      <TooltipContent className="label-tooltip-popup rounded-xl px-3 py-2">
        {props.label}
      </TooltipContent>
    </Tooltip>
  );
}
