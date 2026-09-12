export type SandboxCapability = {
  supported: boolean;
  mechanism: string;
  platform: string;
  /** Whether the offline variant (sandboxOffline) is supported; determined by desktop-side runtime probing. */
  network_control: boolean;
  reason?: string;
};

/** WebUI: the sandbox runs on the desktop side, so the browser cannot probe it; null means the capability is unknown (decided by the desktop side). */
export function useSandboxCapability(): SandboxCapability | null {
  return null;
}
