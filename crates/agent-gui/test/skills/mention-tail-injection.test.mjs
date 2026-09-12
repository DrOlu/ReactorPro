// End-to-end verification of skills "explicit mentions" appended to the tail of the user message.
//
// Three things matter:
//  1. On the turn where the user types `/skill-name` and the following turn, the systemPrompt bytes must be unchanged;
//  2. When there is no mention, no extra content is produced (not even an array reference change);
//  3. A block that has been attached is replayed verbatim in subsequent turns, without moving a single byte of history.

import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const skills = loader.loadModule("@liveagent/ui/lib/skills/index.ts");
const { skillMentionInjection } = loader.loadModule("src/lib/chat/skills/mentionInjection.ts");
const { capturePrefixShape, comparePrefixShape } = loader.loadModule(
  "src/lib/debug/prefixCacheShape.ts",
);
const { buildPreparedContext } = loader.loadModule(
  "src/pages/chat/runtime/conversationContextBuilders.ts",
);
const { normalizeConversationState } = loader.loadModule(
  "src/lib/chat/conversation/conversationState.ts",
);
const { attachMemoryTurnUpdates } = loader.loadModule("src/lib/memory/prompts/turnInjection.ts");

const BASE_SYSTEM_PROMPT = "base system prompt";
const TOOLS = [{ name: "SkillsManager", description: "skills", parameters: { type: "object" } }];

const enabledSkills = [
  {
    name: "code-review",
    description: "Review local code changes",
    skillFile: "code-review/SKILL.md",
    baseDir: "code-review",
  },
  {
    name: "release_notes",
    description: "Prepare release notes",
    skillFile: "release_notes/SKILL.md",
    baseDir: "release_notes",
  },
];

const SKILLS_PROMPT = skills.buildSkillsSystemPrompt({
  rootDir: "/skills",
  selected: enabledSkills,
});

function stateOf(messages) {
  return normalizeConversationState({
    meta: {
      systemPrompt: BASE_SYSTEM_PROMPT,
      tools: TOOLS,
      totalSegmentCount: 1,
      totalMessageCount: messages.length,
    },
    segments: [
      {
        segmentIndex: 0,
        segmentId: "s0",
        messages,
        messageCount: messages.length,
        createdAt: 1,
        updatedAt: messages.length + 1,
      },
    ],
  });
}

function contextFor(conversationId, messages) {
  return buildPreparedContext({
    state: stateOf(messages),
    tools: TOOLS,
    activeAgentPrompt: "",
    skillsPrompt: SKILLS_PROMPT,
    skillMentionUpdates: skillMentionInjection.getMessageUpdates(conversationId),
  });
}

/** Replicates the send path: resolve mentions -> render the block -> record it on that turn's user message. */
function sendTurn(conversationId, turn, text) {
  const explicit = skills.resolveExplicitSkillMentions({ text, enabledSkills });
  skillMentionInjection.record({
    conversationId,
    messageId: `u${turn}`,
    block: skills.formatExplicitSkillMentions(explicit),
  });
}

function userTurn(index, text) {
  return { role: "user", id: `u${index}`, content: text, timestamp: index * 10 };
}

function assistantTurn(index) {
  return {
    role: "assistant",
    content: [{ type: "text", text: `reply ${index}` }],
    stopReason: "stop",
    timestamp: index * 10 + 1,
  };
}

test("the mention turn and the next turn keep systemPrompt bytes unchanged, and the block attaches only to the tail of the matching user message", (t) => {
  const conversationId = "conv-skill-mentions";
  t.after(() => skillMentionInjection.dispose(conversationId));

  const messages = [];
  const shapes = [];
  const contexts = [];
  // The user typed `/code-review` on turn 2; the other three turns have no mention at all.
  const texts = ["plain turn", "please run /code-review now", "plain turn", "plain turn"];

  texts.forEach((text, index) => {
    const turn = index + 1;
    messages.push(userTurn(turn, text));
    sendTurn(conversationId, turn, text);
    const context = contextFor(conversationId, messages);
    contexts.push(context);
    shapes.push(capturePrefixShape({ systemPrompt: context.systemPrompt, tools: context.tools }));
    messages.push(assistantTurn(turn));
  });

  // No turn gains an extra message out of nowhere.
  assert.deepEqual(
    contexts.map((context) => context.messages.length),
    [1, 3, 5, 7],
  );

  // Core assertion: both the mention turn (turn 2) and the next turn (turn 3) are judged unchanged.
  const summaries = shapes.map((shape, index) =>
    comparePrefixShape(index === 0 ? null : shapes[index - 1], shape).prefixChangeSummary,
  );
  assert.deepEqual(summaries, ["initial", "unchanged", "unchanged", "unchanged"]);

  // Turn 1 has no mention: no block should appear in the context.
  assert.ok(!JSON.stringify(contexts[0].messages).includes("<skill-mentions>"));

  // Turn 2's block attaches to turn 2's user message, leaving history untouched.
  const mentionUser = contexts[1].messages.find((message) => message.id === "u2");
  assert.ok(mentionUser.content.includes("<skill-mentions>"));
  assert.ok(mentionUser.content.includes("code-review/SKILL.md"));
  assert.ok(
    mentionUser.content.startsWith("please run /code-review now"),
    "the original user text must stay first; the block is only appended at the tail",
  );
  assert.equal(contexts[1].messages[0].content, "plain turn");

  // Turns 3 and 4 replay the same bytes: the history range stays cacheable.
  assert.equal(
    JSON.stringify(contexts[2].messages.slice(0, 3)),
    JSON.stringify(contexts[1].messages),
  );
  assert.equal(
    JSON.stringify(contexts[3].messages.slice(0, 5)),
    JSON.stringify(contexts[2].messages),
  );
});

test("no explicit mention produces no extra content: no state is created and array references are unchanged", (t) => {
  const conversationId = "conv-skill-mentions-empty";
  t.after(() => skillMentionInjection.dispose(conversationId));

  sendTurn(conversationId, 1, "no mentions at all, keep /usr/bin literal");

  // An empty block should not even create state.
  assert.equal(skillMentionInjection.getMessageUpdates(conversationId), undefined);

  const messages = [userTurn(1, "no mentions at all, keep /usr/bin literal")];
  const baseline = buildPreparedContext({
    state: stateOf(messages),
    tools: TOOLS,
    activeAgentPrompt: "",
    skillsPrompt: SKILLS_PROMPT,
  });
  const withEmptyUpdates = contextFor(conversationId, messages);

  assert.equal(
    JSON.stringify(withEmptyUpdates.messages),
    JSON.stringify(baseline.messages),
    "with no mention the context is exactly the same as when updates are not passed",
  );
  assert.ok(!JSON.stringify(withEmptyUpdates.messages).includes("<skill-mentions>"));

  // When nothing is attached it must return the same array reference as-is: the caller's reference-equality short-circuit depends on this.
  const raw = [userTurn(1, "plain"), assistantTurn(1)];
  assert.equal(attachMemoryTurnUpdates(raw, undefined), raw);
  assert.equal(attachMemoryTurnUpdates(raw, new Map()), raw);
  assert.equal(attachMemoryTurnUpdates(raw, new Map([["missing", "BLOCK"]])), raw);
});

test("a missing conversation id or message id drops the mention instead of attaching it to a mismatched message", (t) => {
  t.after(() => {
    skillMentionInjection.dispose("conv-skill-mentions-guard");
    skillMentionInjection.dispose("");
  });

  const block = skills.formatExplicitSkillMentions([enabledSkills[0]]);

  skillMentionInjection.record({ conversationId: "  ", messageId: "u1", block });
  assert.equal(skillMentionInjection.getMessageUpdates(""), undefined);

  skillMentionInjection.record({ conversationId: "conv-skill-mentions-guard", block });
  assert.equal(skillMentionInjection.getMessageUpdates("conv-skill-mentions-guard"), undefined);
});

test("control group: if the same mention still went through the system prompt, the prefix would be judged a system change", () => {
  const block = skills.formatExplicitSkillMentions([enabledSkills[0]]);
  const before = capturePrefixShape({ systemPrompt: SKILLS_PROMPT, tools: TOOLS });
  const after = capturePrefixShape({
    systemPrompt: `${SKILLS_PROMPT}\n\n${block}`,
    tools: TOOLS,
  });

  assert.equal(comparePrefixShape(before, after).prefixChangeSummary, "system");
});
