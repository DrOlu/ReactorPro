// crates/agent-ui/src/components/chat/clarify/clarifyPanelScroll.ts
//
// Sticky-bottom follow for the clarify panel's Q&A list: while it grows by streaming, scrollTop
// is written to the end; when the reader scrolls up to review history, following stops and
// resumes once near the end again. The threshold covers DPR rounding (scrollTop is often 1-3px
// short of the physical clamp).

export const CLARIFY_FOLLOW_THRESHOLD_PX = 32;

export type ClarifyScrollBox = {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
};

export function isClarifyListFollowing(
  box: ClarifyScrollBox,
  thresholdPx = CLARIFY_FOLLOW_THRESHOLD_PX,
): boolean {
  return box.scrollHeight - box.clientHeight - box.scrollTop <= thresholdPx;
}

export function pinClarifyListIfFollowing(box: ClarifyScrollBox | null, following: boolean): void {
  if (!box || !following) return;
  box.scrollTop = box.scrollHeight;
}
