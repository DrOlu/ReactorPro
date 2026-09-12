import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("../../../agent-ui/src/components/chat/ToolApprovalBar.tsx", import.meta.url),
  "utf8",
);

test("the approval bar yields focus only to an editable element that is still rendered", () => {
  // When the approval bar appears the input card is hidden, but at submit time
  // document.activeElement still points at that textarea (the browser's focus fixup
  // happens after React's commit). If the guard only looked at the tag name, an
  // approval arriving right after sending would fail to grab focus and the
  // Enter/Escape shortcuts would stop working. Only an editable element that is still
  // rendered (sidebar rename, new-group draft) deserves to yield.
  assert.match(source, /const activeIsEditable =/);
  assert.match(source, /activeIsEditable && active\.getClientRects\(\)\.length > 0/);
  assert.match(source, /panelRef\.current\?\.focus\(\{ preventScroll: true \}\)/);
});
