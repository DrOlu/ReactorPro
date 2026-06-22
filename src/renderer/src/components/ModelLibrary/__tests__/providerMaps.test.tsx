import { describe, it, expect } from 'vitest';
import { AVAILABLE_PROVIDERS } from '@common/agent';

import { PROVIDER_ICON_MAP } from '../ProviderSelection';
import { PROVIDER_PARAMETERS_MAP } from '../ProviderProfileForm';

/**
 * Regression guard for https://github.com/DrOlu/ReactorPro issue: React error #130
 * ("Element type is invalid: got undefined") when opening the Add Provider screen.
 *
 * Root cause was a provider being listed in AVAILABLE_PROVIDERS without a matching
 * entry in PROVIDER_ICON_MAP / PROVIDER_PARAMETERS_MAP, which made React render
 * `<undefined .../>` and crash. These tests ensure every provider surfaced in the
 * UI picker has both an icon and a parameters component wired up, so a future
 * upstream sync or manual edit cannot reintroduce the crash silently.
 */
describe('Provider UI maps cover every AVAILABLE_PROVIDERS entry', () => {
  it('PROVIDER_ICON_MAP has an entry for every AVAILABLE_PROVIDERS item', () => {
    const missing: string[] = [];
    for (const provider of AVAILABLE_PROVIDERS) {
      if (PROVIDER_ICON_MAP[provider] === undefined) {
        missing.push(provider);
      }
    }
    expect(missing, `Missing icons in PROVIDER_ICON_MAP for: ${missing.join(', ')}`).toEqual([]);
  });

  it('PROVIDER_PARAMETERS_MAP has an entry for every AVAILABLE_PROVIDERS item', () => {
    const missing: string[] = [];
    for (const provider of AVAILABLE_PROVIDERS) {
      if (PROVIDER_PARAMETERS_MAP[provider] === undefined) {
        missing.push(provider);
      }
    }
    expect(missing, `Missing parameter components in PROVIDER_PARAMETERS_MAP for: ${missing.join(', ')}`).toEqual([]);
  });

  it('every entry in AVAILABLE_PROVIDERS is unique', () => {
    const duplicates = AVAILABLE_PROVIDERS.filter((p, i, arr) => arr.indexOf(p) !== i);
    expect(duplicates, `Duplicate provider entries: ${duplicates.join(', ')}`).toEqual([]);
  });
});
