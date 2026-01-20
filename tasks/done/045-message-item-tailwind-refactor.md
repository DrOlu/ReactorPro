# Task 045 - Message Item Tailwind Refactor

## Goal
Refactor `MessageItem` to rely on Tailwind utilities and the new token variables instead of bespoke global CSS.

## Prerequisites
- Task 043 complete (color tokens available).
- Task 044 complete (typography baseline available).

## Acceptance Criteria
- [ ] `src/components/message-item.tsx` uses Tailwind utility classes (with CSS variable references where needed) for layout, colors, and typography.
- [ ] Legacy `.message-item*` styles are removed from `src/index.css`.
- [ ] Visual parity in light and dark modes is maintained for queued, sending, error, and generating states.

## Steps
1. Replace `class="message-item ..."` and nested class usage with Tailwind class lists that reference tokens (e.g., `bg-[var(--surface-elevated)]`, `text-[var(--text-secondary)]`).
2. Create any small reusable utility classes (e.g., `.chip`, `.card`) in a new `src/styles/components.css` if repeated patterns arise; keep them token-based.
3. Delete the now-unused `.message-item` block from `src/index.css`.
4. Verify conditional states (queued badge, sending indicator, error block) still render with correct colors/typography.

## Testing Checklist
- [ ] Run `npm run dev` and load a session with mixed message states.
- [ ] Toggle between light/dark themes to confirm token usage.
- [ ] Use dev tools to ensure no stale `.message-item` selectors remain in the DOM.

## Dependencies
- Depends on Tasks 043 and 044.
- Blocks future component refactor tasks (046+).

## Estimated Time
0.75 hours

## Notes
- Capture before/after screenshots (light + dark, streamed message) for review.
- Mention any new utility classes in the PR description so reviewers know where to look.
