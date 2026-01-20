# Task 051 - Command Palette & Keyboard Hint Refactor

## Goal
Align the command palette modal and keyboard hint UI with the shared token system, removing bespoke gray/black overlay styling.

## Prerequisites
- Task 050 complete (selector helpers available for reuse).

## Acceptance Criteria
- [ ] `src/components/command-palette.tsx` uses token-backed utilities for overlay, surface, list items, and focus states.
- [ ] `src/components/keyboard-hint.tsx` and any inline `<kbd>` styling leverage reusable helpers (`.kbd` etc.) from `components.css`.
- [ ] Legacy utility combos in these components (`bg-gray-*`, `dark:bg-gray-*`, `text-gray-*`) are eliminated.
- [ ] Palette overlay opacity, search field, section headers, and highlighted items match existing behavior in both themes.

## Steps
1. Extract repeated modal/dropdown patterns into helpers (overlay, surface, list item) if not already present.
2. Update command palette markup to use the helpers and token-aware Tailwind classes.
3. Refactor `keyboard-hint.tsx` to rely on shared `.kbd` styling and tokens.
4. Verify keyboard navigation, highlighted items, and section headers visually.

## Testing Checklist
- [ ] Run `npm run build`.
- [ ] In dev mode, open the command palette, search, navigate with arrow keys, and confirm highlight/focus styling.

## Dependencies
- Depends on Task 050.
- Blocks folder selection advanced settings refactor (which reuses keyboard hints).

## Estimated Time
0.75 hours

## Notes
- Branch suggestion: `feature/task-051-command-palette-refactor`.
- Include GIF/screenshots if overlay opacity or highlight timing needed adjustment.
