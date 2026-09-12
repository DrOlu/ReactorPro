import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const implementations = [
  {
    label: "GUI",
    loader: createTsModuleLoader(),
  },
  {
    label: "WebUI",
    loader: createTsModuleLoader({
      rootDir: fileURLToPath(new URL("../../../agent-gateway/web/", import.meta.url)),
    }),
  },
];

for (const { label, loader } of implementations) {
  const triggerHint = loader.loadModule("@liveagent/ui/lib/skills/skillTriggerHint.ts");
  const cardIdentity = loader.loadModule("@liveagent/ui/lib/skills/skillCardIdentity.ts");
  const cardMetadata = loader.loadModule("@liveagent/ui/lib/skills/skillCardMetadata.ts");

  test(`${label} extracts trigger hints, including full-width punctuation`, () => {
    assert.equal(
      triggerHint.getSkillTriggerHint('English guidance。Trigger："review my code"、"write docs"。Other notes。'),
      '"review my code"、"write docs"',
    );
    assert.equal(
      triggerHint.getSkillTriggerHint('Notes——Trigger ：「code review」、 “write docs” ；later notes'),
      '「code review」、 “write docs”',
    );
  });

  test(`${label} extracts English trigger clauses`, () => {
    assert.equal(
      triggerHint.getSkillTriggerHint(
        "Guidance for reviewers. Use when the user asks to review code or write documentation. More details.",
      ),
      "the user asks to review code or write documentation",
    );
    assert.equal(
      triggerHint.getSkillTriggerHint("Triggers on: pull-request review requests!"),
      "pull-request review requests",
    );
    assert.equal(
      triggerHint.getSkillTriggerHint("Trigger：format a Markdown document；other notes"),
      "format a Markdown document",
    );
  });

  test(`${label} omits missing trigger hints and truncates unusually long ones`, () => {
    assert.equal(triggerHint.getSkillTriggerHint("A concise skill description without a cue."), null);
    const hint = triggerHint.getSkillTriggerHint(
      `Trigger：${"a".repeat(triggerHint.MAX_SKILL_TRIGGER_HINT_LENGTH + 12)}`,
    );
    assert.equal(Array.from(hint).length, triggerHint.MAX_SKILL_TRIGGER_HINT_LENGTH);
    assert.equal(hint.endsWith("…"), true);
  });

  test(`${label} caps local card descriptions without splitting Unicode characters`, () => {
    const limit = cardMetadata.LOCAL_SKILL_CARD_DESCRIPTION_MAX_CHARACTERS;
    assert.equal(cardMetadata.truncateLocalSkillCardDescription("  concise description  "), "concise description");
    assert.equal(cardMetadata.truncateLocalSkillCardDescription("é".repeat(limit)), "é".repeat(limit));

    const truncated = cardMetadata.truncateLocalSkillCardDescription(
      `${"é".repeat(limit - 2)}😀tail`,
    );
    assert.equal(Array.from(truncated).length, limit);
    assert.equal(truncated.endsWith("…"), true);
    assert.equal(truncated.includes("�"), false);
  });

  test(`${label} derives stable, distributed card identities`, () => {
    const first = cardIdentity.getInstalledSkillCardIdentity("karpathy-guidelines", "development");
    const repeated = cardIdentity.getInstalledSkillCardIdentity("karpathy-guidelines", "development");
    assert.deepEqual(repeated, first);

    const identities = Array.from({ length: 60 }, (_, index) =>
      cardIdentity.getInstalledSkillCardIdentity(`sample-skill-${index}`, "development"),
    );
    assert.ok(new Set(identities.map((identity) => identity.colorIndex)).size >= 8);
    assert.ok(new Set(identities.map((identity) => identity.iconName)).size >= 4);
  });

  test(`${label} derives source and relative install-time metadata`, () => {
    const now = Date.UTC(2026, 6, 22, 12);
    assert.equal(
      cardMetadata.getInstalledSkillCardSource({
        name: "skills-creator",
        source: { registry: "clawhub", slug: "skills-creator" },
      }),
      "built-in",
    );
    assert.equal(
      cardMetadata.getInstalledSkillCardSource({
        name: "verified-built-in",
        builtIn: true,
        source: null,
      }),
      "built-in",
    );
    assert.equal(
      cardMetadata.getInstalledSkillCardSource({
        name: "registry-skill",
        source: { registry: "ClawHub", slug: "registry-skill" },
      }),
      "clawhub",
    );
    assert.equal(
      cardMetadata.getInstalledSkillCardSource({ name: "local-skill", source: null }),
      "local",
    );
    assert.deepEqual(cardMetadata.getRelativeInstalledAt(now - 3_600_000, now), { kind: "today" });
    assert.deepEqual(cardMetadata.getRelativeInstalledAt(now - 3 * 86_400_000, now), {
      kind: "days-ago",
      days: 3,
    });
    assert.deepEqual(cardMetadata.getRelativeInstalledAt(now - 8 * 86_400_000, now), {
      kind: "date",
      timestamp: now - 8 * 86_400_000,
    });
    assert.equal(cardMetadata.getRelativeInstalledAt(null, now), null);
  });
}
