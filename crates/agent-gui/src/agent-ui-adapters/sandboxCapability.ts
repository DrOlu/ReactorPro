import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

export type SandboxCapability = {
  supported: boolean;
  mechanism: string;
  platform: string;
  /**
   * Whether the offline variant (sandboxOffline) is supported. macOS/Linux are
   * true when supported; Windows depends on runtime probing (whether an
   * AppContainer SID can be derived).
   */
  network_control: boolean;
  reason?: string;
};

let cachedCapability: SandboxCapability | null = null;

/** Desktop: probe the local OS sandbox availability (macOS Seatbelt / Linux bwrap / Windows restricted-token write fence). */
export function useSandboxCapability(): SandboxCapability | null {
  const [capability, setCapability] = useState<SandboxCapability | null>(cachedCapability);

  useEffect(() => {
    if (cachedCapability) return;
    let disposed = false;
    invoke<SandboxCapability>("system_sandbox_capability")
      .then((result) => {
        cachedCapability = result;
        if (!disposed) setCapability(result);
      })
      .catch((error) => {
        console.warn("system_sandbox_capability failed", error);
      });
    return () => {
      disposed = true;
    };
  }, []);

  return capability;
}
