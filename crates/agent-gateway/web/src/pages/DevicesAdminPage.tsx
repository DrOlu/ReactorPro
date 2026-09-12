import { ArrowLeft } from "@liveagent/ui/components/IconSet";

import { DevicesSection } from "./settings/DevicesSection";

// Retains a directly reachable admin route; the everyday WebUI entry lives inside the settings page and reuses the same content component as here.
export function DevicesAdminPage() {
  return (
    <div className="mx-auto flex min-h-screen max-w-5xl flex-col px-4 py-6 sm:px-6">
      <a
        href="/"
        className="mb-5 flex w-fit items-center gap-2 rounded-md px-2 py-1 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to chat
      </a>
      <DevicesSection />
    </div>
  );
}
