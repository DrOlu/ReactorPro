# Skills Hub Bulk Selection Interaction Spec v2

Scope: `crates/agent-ui/src/pages/skills-hub/SkillsHubPage.tsx`. GUI/WebUI render through the same shared page, and platform capabilities are provided by their respective `src/agent-ui-adapters/`.

## 0. Core Principles

1. **Selection and enabled are two independent states.**
   - Enabled state = `settings.skills.selected`, expressed by the card's green background/border, kept visible in any mode (preserving the status quo).
   - Bulk selection state = the newly added temporary `bulkSelection: Set<string>` (component-internal state, not persisted), expressed by the top-left checkbox + primary-color ring; it can overlay the green enabled style without the two interfering.
2. In bulk mode, clicking a card **only changes bulkSelection, and never directly changes the enabled state or triggers preview**.
3. Deletion is irreversible and must go through confirmation; enable/disable is reversible and goes through the Undo snackbar (reusing the existing bulkUndo mechanism).

## 1. Entering / Exiting Bulk Mode

- Keep the top "Bulk Select" toggle button as the explicit entry point.
- Add an implicit entry (Google Photos style): in non-bulk mode, when hovering a card a circular checkbox fades in at the top-left; clicking the checkbox automatically enters bulk mode and selects that card. On touch devices (no hover), the checkbox is always shown semi-transparent.
- Exit:
  - `Esc` first press: clear bulkSelection (if non-empty); second press: exit bulk mode.
  - Switching views (installed/store/import) or clicking the "Done" button after bulkSelection is cleared exits.
  - On exit, clear bulkSelection and the shift anchor.

## 2. Card Interaction (in bulk mode)

- Clicking the whole card = toggle selection; `Shift+click` = range selection (keep the existing anchor logic, applied to bulkSelection).
- `Ctrl/Cmd+A` (when focus is not in an input) = select all current filter results. Only the installed page has this semantic; the other views do not intercept the browser default Ctrl+A.
- Selected style: `ring-2 ring-primary` + a solid check in the top-left checkbox; the green enabled style is kept as usual.
- In bulk mode the preview drawer is not opened; the original single delete button at the bottom-right of the card is hidden (to avoid confusion with the dual bulk delete channel).
- Always-enabled skills (alwaysEnabled) show a disabled checkbox in bulk mode (not selectable), with a tooltip explaining the reason.

## 3. Bottom Floating Action Bar (replacing the existing top three-button group)

- When bulkSelection.size > 0, a floating bar slides in from the bottom (reusing the existing bulkUndo snackbar container style):
  `N selected │ Select all (current filter) · Clear │ Enable · Disable · Delete │ ✕ Done`
- Button semantics (all act on bulkSelection, not the enabled set):
  - **Enable / Disable**: bulk-modify `settings.skills.selected`, then clear the selection and show the Undo snackbar ("Updated N skills · Undo", reusing the existing bulkUndo). Next to the button, show the number that will actually change; e.g. if 3 of 5 selected are already enabled, then "Enable (2)" and "Disable (3)"; when the number is 0 the corresponding button is disabled.
  - **Delete**: ConfirmActionPopover confirmation; the description lists the first 5 skill names, and the remainder is expressed with the i18n key `skillsHubBulkDeleteMore` ("{names} and {count} more"); after confirmation, delete serially (keeping the existing aggregated failure prompt), and remove successful items from the selection set.
  - The top "Bulk Select" button becomes highlighted in the mode and is used only for exiting (or is hidden directly, with exit unified through the floating bar's "Done").
- When bulkSelection is empty but still in bulk mode, the floating bar shows the hint text: "Click a card to select" (muted style).

## 4. Relationship Between Filter/Search and the Selection Set

- Changing the filter term or category does **not clear** bulkSelection (the user may build a batch across several searches).
- The floating bar's "N selected" is the total; if there are selected items not currently visible, append the hint "(M of them are not in the current filter)".
- "Select all" only acts on the current filter results (appended to the selection set); "Clear" clears everything.

## 5. Local Import (import) View

- Reuse the same set: checkbox + bottom floating bar, with the primary action changed to "Import (N)".
- The list header permanently shows the "X / Y selected" count + a "Select all/Deselect all" button (not dependent on bulk mode); both numerator and denominator count only the skills under the current tool that can be imported (not installed).
- Installed external skills: **do not** show them as a "locked check" again; instead use a disabled checkbox + a card corner badge "Installed", to avoid the misreading that they "would be imported again". selectedExternal no longer contains installed items, and they are not counted in any count.
- Import in progress: the floating bar shows progress inline (done/total); on completion, clear the selection and reuse the existing importToast.

## 6. Current Code That Needs Synchronized Cleanup

- `applyBulkInstalledSelection` / `handleBulkInstalledCardClick` change to operate on bulkSelection, no longer writing `settings.skills.selected` directly.
- The target set of `deleteBulkSelectedInstalledSkills` changes from `selected` (the enabled set) to bulkSelection.
- The top toolbar's "Select all/Bulk delete/Exit" three-button group is removed, and the logic moves into the bottom floating bar.
- i18n: both ends' `i18n/config.ts` add/adjust keys synchronously (enable/disable/clear/selection hint, etc.), and both Chinese and English need to be filled in.

## 7. Risk Self-Check (verify one by one after changes)

1. The bulk delete confirmation text matches the actual delete set (no longer "the enabled set").
2. Undo only covers enable/disable, and does not give a false undo implication for delete.
3. Touch (webui mobile) has no hover: the checkbox is always tappable, and the floating bar does not cover the last row of cards (leave padding at the bottom of the list).
4. When lockedByChatMode, the bulk entry is hidden entirely (preserving the status quo).
5. The behavior and styles of the shared SkillsHubPage are consistent on both ends, and the host adapters and each end's i18n text have been checked.

## 8. WebView2 Rendering Rules

Skills Hub must follow these compositing constraints in Windows WebView2:

1. **Do not use backdrop-filter on elements that float or overlay scrollable, animatable content.**
   This includes fixed, sticky and absolute overlays, as well as action bars, hint bars, search and sort controls, drawer masks and drawer panels above a FLIP grid. Tailwind's backdrop-blur-* is likewise within the prohibited scope.
2. **The above elements uniformly use a high-opacity solid background to simulate a frosted-glass layer.**
   In light mode prefer bg-background/95, in dark mode use dark:bg-popover/95, and keep the original border and shadow; mask layers use a solid semi-transparent background without blur.
3. **backdrop-filter is allowed only in scenes where the content behind is completely static.**
   For example the top-of-page HubHeader or a panel that only covers the static HubBackdrop. If the caller may cover a list, a scroll area or animated content, backdrop-filter should not be used by default.
4. **Both ends must be verified.** Shared styles modify only `agent-ui`, and simultaneously check the GUI and WebUI host styles and rendering results, to avoid either end reintroducing an independent compositing layer through local overrides.

Case evidence:

- **Skill card hover halo:** The installed page and store page once used backdrop-blur-xl on every card, while card hover triggered translate layer promotion. After 60+ cards overlaid on the HubBackdrop glow, some WebView2/GPU combinations left vertical green stale-sampling residue bands. The fix was to remove the backdrop-filter from the dynamic card root node, keeping the background, border, shadow, hover displacement and entrance animation.
- **FLIP and bottom floating bar halo:** The sorting feature caused skill cards to be reordered frequently behind the bottom multi-select action bar or Undo bar, and WebView2's backdrop-filter sampling cache could fail and form residue bands above the floating bar. The fix was to have the action bar, Undo, search, sort and drawers covering dynamic pages use a high-opacity solid background, no longer sampling the animated content behind them.