import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const gatewayAppViewSource = readFileSync(
  new URL("../src/app/GatewayAppView.tsx", import.meta.url),
  "utf8",
);
const baseChatStyles = readFileSync(
  new URL("../src/styles/base-chat.css", import.meta.url),
  "utf8",
);
const responsiveStyles = readFileSync(
  new URL("../src/styles/responsive.css", import.meta.url),
  "utf8",
);

test("gateway mounts workbench chrome outside the shared application view", () => {
  assert.match(gatewayAppViewSource, /<main className="gateway-main-shell">/);
  assert.match(
    gatewayAppViewSource,
    /<AppWorkbenchChrome[\s\S]*?<ApplicationView/,
  );
  assert.doesNotMatch(gatewayAppViewSource, /chat=\{\{[\s\S]*?headerOverlay:/);
  assert.match(baseChatStyles, /\.gateway-main-shell \{[\s\S]*?display: flex;[\s\S]*?flex-direction: column;/);
});

test("gateway shows the conversation view switcher in chrome only after an assistant reply", () => {
  const chromeIndex = gatewayAppViewSource.indexOf("<AppWorkbenchChrome");
  const tabsIndex = gatewayAppViewSource.indexOf("<ConversationViewTabs");
  const applicationViewIndex = gatewayAppViewSource.indexOf("<ApplicationView");

  assert.ok(chromeIndex >= 0);
  assert.ok(tabsIndex > chromeIndex);
  assert.ok(tabsIndex < applicationViewIndex);
  assert.equal(gatewayAppViewSource.match(/<ConversationViewTabs/g)?.length, 1);
  assert.match(
    gatewayAppViewSource,
    /const hasConversationReply =[\s\S]*?displayedConversationId !== "" &&[\s\S]*?!isLocalDraftConversationId\(displayedConversationId\)[\s\S]*?trajectoryMessages\.some\(\(message\) => message\.role === "assistant"\)/,
  );
  assert.match(gatewayAppViewSource, /activeView === "chat" && hasConversationReply/);
  assert.match(
    gatewayAppViewSource,
    /useConversationViewState\(displayedConversationId\)/,
  );
  assert.doesNotMatch(gatewayAppViewSource, /useState<ConversationViewId>/);
  assert.match(
    gatewayAppViewSource,
    /hidden=\{renderedConversationView === "trajectory"\}/,
  );
  assert.match(
    baseChatStyles,
    /\.gateway-composer-layer\.hidden\s*\{\s*display: none;\s*\}/,
  );
});

test("web composer column clamps the clarify panel so new turns scroll inside it", () => {
  // The composer layer is absolutely pinned to the bottom and the chat area is
  // overflow-hidden: in a short pane, the panel's max-h-[40vh] may be clipped by
  // the outer container before it even hits its cap, so the inner
  // overflow-y-auto never takes effect. The column must be a capped flex
  // column and allow [data-clarify-panel] to shrink.
  assert.match(
    baseChatStyles,
    /\.gateway-composer-layer \{[\s\S]*?max-height: 100%;/,
  );
  assert.match(
    baseChatStyles,
    /\.gateway-composer-layer > \.gateway-chat-column \{[\s\S]*?display: flex;[\s\S]*?min-height: 0;[\s\S]*?max-height: 100%;[\s\S]*?flex-direction: column;[\s\S]*?justify-content: flex-end;/,
  );
  assert.match(
    baseChatStyles,
    /\.gateway-composer-layer \[data-clarify-panel\] \{[\s\S]*?flex-shrink: 1;[\s\S]*?min-height: 0;/,
  );
});

test("mobile sidebar stays above the interactive workbench header", () => {
  assert.match(
    responsiveStyles,
    /@media \(max-width: 820px\) \{[\s\S]*?\.gateway-main-shell \[data-app-workbench-chrome\] \{\s*z-index: var\(--layer-raised\);/,
  );
  assert.match(
    responsiveStyles,
    /@media \(max-width: 820px\) \{[\s\S]*?\.gateway-editor-host > \.chat-history-sidebar \{[\s\S]*?z-index: var\(--layer-panel\);/,
  );
});
