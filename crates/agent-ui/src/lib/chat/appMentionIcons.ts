/**
 * App-mention icon registry --- the process-level source of truth shared by the popover/chip/user bubble.
 *
 * Icons are PNG data URLs of a few KB; writing them into chip DOM attributes or clipboard JSON would
 * blow up the copy payload and draft serialization, so serialization carries only the app identity
 * (name/bundleId/path), and the display layer looks up the icon here by identity at render time. The host
 * (GUI's useMentionApps) registers once after fetching the app list; the WebUI never registers, so every
 * lookup misses and falls back to a placeholder icon --- this is exactly the boundary of "the app list
 * never leaves the desktop host".
 *
 * Subscribe with useSyncExternalStore: registration happens when async enumeration completes, so a bubble
 * chip mounted earlier gets the real logo after the icon is ready via the subscription, instead of staying
 * on the placeholder forever.
 */

import { useSyncExternalStore } from "react";

export type AppMentionIconIdentity = {
  name?: string;
  bundleId?: string;
  path?: string;
};

type AppMentionIconSource = AppMentionIconIdentity & { iconDataUrl?: string };

const iconsByKey = new Map<string, string>();
const listeners = new Set<() => void>();
let version = 0;

/**
 * App identity key, in descending order of stability: bundle id > install path > display name. The icon
 * registry registers/queries by all keys; the recent-use ranking (appMentionRecency) takes the first as
 * the canonical key --- both share this single priority adjudication.
 */
export function identityKeys(identity: AppMentionIconIdentity): string[] {
  const keys: string[] = [];
  const bundleId = identity.bundleId?.trim().toLowerCase();
  const path = identity.path?.trim();
  const name = identity.name?.trim().toLowerCase();
  if (bundleId) keys.push(`bundle:${bundleId}`);
  if (path) keys.push(`path:${path}`);
  if (name) keys.push(`name:${name}`);
  return keys;
}

/** Register a batch of app icons. Anything without a data:image/ prefix is discarded --- the registry feeds <img src>. */
export function registerAppMentionIcons(apps: readonly AppMentionIconSource[]) {
  let changed = false;
  for (const app of apps) {
    const iconDataUrl = app.iconDataUrl;
    if (!iconDataUrl?.startsWith("data:image/")) continue;
    for (const key of identityKeys(app)) {
      if (iconsByKey.get(key) === iconDataUrl) continue;
      iconsByKey.set(key, iconDataUrl);
      changed = true;
    }
  }
  if (!changed) return;
  version += 1;
  for (const listener of listeners) {
    listener();
  }
}

/** Look up an icon by identity: bundle id is the most stable and takes priority, then install path, and finally display name. */
export function getAppMentionIconDataUrl(identity: AppMentionIconIdentity): string | undefined {
  for (const key of identityKeys(identity)) {
    const icon = iconsByKey.get(key);
    if (icon) return icon;
  }
  return undefined;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getVersion() {
  return version;
}

/** React-side subscription: mounted chips re-query the icon once registration arrives. */
export function useAppMentionIcon(identity: AppMentionIconIdentity): string | undefined {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  return getAppMentionIconDataUrl(identity);
}
