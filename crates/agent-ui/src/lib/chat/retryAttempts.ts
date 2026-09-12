export type RetryAttemptRecord = {
  attempt: number;
  maxAttempts: number;
  errorMessage: string;
  /** The backoff duration about to be applied (milliseconds); older events lack this field. */
  plannedDelayMs?: number;
  /** The candidate label that produced this retry ("Provider · model"); distinguishes candidates under failover. */
  providerLabel?: string;
};
