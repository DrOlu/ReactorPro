const MODEL_GENERATING_STATUS_PATTERN = /^Round\s*\d+:\s*model generating\.\.\.$/i;

export const VIBING_STATUS = "Vibing...";

export function normalizeLiveToolStatus(status: string | null) {
  if (status && MODEL_GENERATING_STATUS_PATTERN.test(status)) return VIBING_STATUS;
  return status;
}
