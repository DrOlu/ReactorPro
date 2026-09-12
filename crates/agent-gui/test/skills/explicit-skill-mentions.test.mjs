import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const skills = loader.loadModule("@liveagent/ui/lib/skills/index.ts");

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

test("extractSkillMentionNamesFromText finds explicit skill tokens without treating common env vars as skills", () => {
  assert.deepEqual(
    skills.extractSkillMentionNamesFromText(
      "Use /code-review and /release_notes, keep /usr/bin literal and ignore price/tags.",
    ),
    ["code-review", "release_notes"],
  );
  assert.deepEqual(skills.extractSkillMentionNamesFromText("/liveagent-code-review"), [
    "liveagent-code-review",
  ]);
  // "$" is no longer a skill mention marker.
  assert.deepEqual(
    skills.extractSkillMentionNamesFromText("Use $code-review and $release_notes."),
    [],
  );
});

test("resolveExplicitSkillMentions only returns enabled skills and deduplicates structured/text mentions", () => {
  assert.deepEqual(
    skills.resolveExplicitSkillMentions({
      text: "/disabled /release_notes /code-review /code-review",
      structured: [
        {
          name: "code-review",
          skillFile: "code-review/SKILL.md",
          baseDir: "code-review",
        },
      ],
      enabledSkills,
    }),
    [enabledSkills[0], enabledSkills[1]],
  );
});

test("buildSkillsSystemPrompt no longer carries per-turn explicit mentions", () => {
  const prompt = skills.buildSkillsSystemPrompt({
    rootDir: "/skills",
    selected: enabledSkills,
  });

  // Explicit mentions have moved out of the system prompt: they are only valid
  // for the current turn, and keeping them here would add a section this turn and
  // remove it the next, invalidating the cache prefix twice per `/skill-name`.
  assert.doesNotMatch(prompt, /Explicitly mentioned/);
  assert.doesNotMatch(prompt, /<skill-mentions>/);
  assert.match(prompt, /skill:\/\/<baseDir>\/\.\.\./);
  assert.doesNotMatch(prompt, /root=["']skills["']/);
  assert.doesNotMatch(prompt, /Read\(root=/);
});

test("buildSkillsSystemPrompt stays byte-identical across a mention turn and the next turn", () => {
  // The user types `/code-review` this turn and nothing the next: the skills
  // system prompt must not differ by a single byte between the two turns, or the
  // system block would be invalidated along with all the history after it.
  const mentionTurn = skills.buildSkillsSystemPrompt({
    rootDir: "/skills",
    selected: enabledSkills,
  });
  const nextTurn = skills.buildSkillsSystemPrompt({
    rootDir: "/skills",
    selected: enabledSkills,
  });

  assert.equal(mentionTurn, nextTurn);
});

test("formatExplicitSkillMentions renders the resolved mentions and stays empty without any", () => {
  const block = skills.formatExplicitSkillMentions([enabledSkills[0]]);

  assert.match(block, /^<skill-mentions>\n/);
  assert.match(block, /\n<\/skill-mentions>$/);
  assert.match(block, /- code-review \(skillFile: code-review\/SKILL\.md, baseDir: code-review\)/);
  assert.ok(block.includes("`/` mentions never grant access to disabled Skills"));
  assert.ok(
    block.includes("Treat these mentions as user intent to prioritize those Skills."),
    "the prioritization instruction must survive the move out of the system prompt",
  );

  // Without any mention, nothing is produced — the empty block is the only signal for "attach nothing".
  assert.equal(skills.formatExplicitSkillMentions([]), "");
});

test("formatExplicitSkillMentions never lists skills that resolveExplicitSkillMentions filtered out", () => {
  // Mention resolution remains the sole admission gate: disabled Skills are filtered out at this step and never reach the render layer.
  const resolved = skills.resolveExplicitSkillMentions({
    text: "/disabled /code-review",
    enabledSkills,
  });
  const block = skills.formatExplicitSkillMentions(resolved);

  assert.match(block, /- code-review \(/);
  // Only entry lines represent "authorized and available"; the "disabled Skills" phrase in the boilerplate line is wording, not an entry.
  assert.doesNotMatch(block, /- disabled \(/);
  assert.doesNotMatch(block, /disabled\/SKILL\.md/);
});
