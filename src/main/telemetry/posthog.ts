import { PostHogTraceExporter } from '@posthog/ai/otel';

import type { SpanExporter } from '@opentelemetry/sdk-trace-base';
import type { SettingsData } from '@common/types';

import { getEffectiveEnvironmentVariable } from '@/utils/environment';
import logger from '@/logger';

export const initializePostHogExporter = (): SpanExporter | undefined => {
  const posthogApiKey = getEffectiveEnvironmentVariable('POSTHOG_API_KEY');
  const posthogHost = getEffectiveEnvironmentVariable('POSTHOG_HOST');

  if (posthogApiKey) {
    logger.info('Initializing PostHog Trace Exporter...');
    const exporter = new PostHogTraceExporter({
      projectToken: posthogApiKey.value,
      host: posthogHost?.value || 'https://us.i.posthog.com',
    });
    // PostHogTraceExporter extends OTLPTraceExporter from
    // @opentelemetry/exporter-trace-otlp-http 0.x, which doesn't satisfy the
    // shutdown() requirement of SpanExporter from @opentelemetry/sdk-trace-base 2.x.
    // Delegate export/shutdown to bridge the interface gap. The parent
    // OTLPTraceExporter does have shutdown() at runtime; the type gap is from
    // the 0.x → 2.x SDK version mismatch.
    const delegate = exporter as unknown as { shutdown?: () => Promise<void> };
    return {
      export: exporter.export.bind(exporter),
      shutdown: async () => {
        await delegate.shutdown?.();
      }
    };
  }

  return undefined;
};

export const getPostHogAiderEnvironmentVariables = (baseDir: string, settings: SettingsData): Record<string, unknown> => {
  return {
    POSTHOG_API_KEY: getEffectiveEnvironmentVariable('POSTHOG_API_KEY', settings, baseDir)?.value,
    POSTHOG_API_URL: getEffectiveEnvironmentVariable('POSTHOG_HOST', settings, baseDir)?.value,
  };
};
