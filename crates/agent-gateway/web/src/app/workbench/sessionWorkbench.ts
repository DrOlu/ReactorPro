import { createSessionWorkbenchFeature } from "@liveagent/ui/lib/workbench/featureFlags";

// The web and desktop sides share the same escape hatch: VITE_LIVEAGENT_SESSION_WORKBENCH=0 falls back to a single Pane.
export const sessionWorkbench = createSessionWorkbenchFeature(
  import.meta.env.VITE_LIVEAGENT_SESSION_WORKBENCH,
);
