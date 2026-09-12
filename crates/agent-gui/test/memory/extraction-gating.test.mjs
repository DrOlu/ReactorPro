import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const gating = loader.loadModule("src/lib/memory/extraction/gating.ts");
const { extractionSkipReason, isShortMemoryConfirmationText, isConfirmationDeferral, graphemeLength } =
  gating;

const base = { hasConfirmableHypothesis: false, now: 1_000_000 };

test("empty and punctuation-only messages are skipped", () => {
  assert.equal(extractionSkipReason({ ...base, latestUserText: "" }), "empty-user-message");
  assert.equal(
    extractionSkipReason({ ...base, latestUserText: "   " }),
    "empty-user-message",
  );
  assert.equal(
    extractionSkipReason({ ...base, latestUserText: "!?...??!" }),
    "punctuation-only-user-message",
  );
});

test("short messages skip, by grapheme count", () => {
  assert.equal(extractionSkipReason({ ...base, latestUserText: "sure" }), "user-message-too-short");
  assert.equal(extractionSkipReason({ ...base, latestUserText: "ok!" }), "user-message-too-short");
  // 6+ graphemes pass the length gate
  assert.equal(
    extractionSkipReason({ ...base, latestUserText: "I will always write code comments in English" }),
    null,
  );
});

test("greetings, thanks, and acks are skipped only when short", () => {
  assert.equal(extractionSkipReason({ ...base, latestUserText: "hello there" }), "greeting");
  assert.equal(
    extractionSkipReason({ ...base, latestUserText: "thanks for your help" }),
    "acknowledgement-thanks",
  );
  assert.equal(
    extractionSkipReason({ ...base, latestUserText: "ok got it" }),
    "acknowledgement-ok",
  );
  // long tail after the ack carries new instructions → must reach the LLM
  assert.equal(
    extractionSkipReason({
      ...base,
      latestUserText:
        "thanks, please answer all my questions in English from now on, including code comments and commit messages",
    }),
    null,
  );
});

test("short confirmations pass only with a confirmable hypothesis", () => {
  const text = "yes";
  assert.equal(
    extractionSkipReason({ latestUserText: text, hasConfirmableHypothesis: false, now: 1 }),
    "user-message-too-short",
  );
  assert.equal(
    extractionSkipReason({ latestUserText: text, hasConfirmableHypothesis: true, now: 1 }),
    null,
  );
  // unknown → deferred, not rejected (controller claims; engine re-checks)
  assert.equal(extractionSkipReason({ latestUserText: text, now: 1 }), null);
});

test("isConfirmationDeferral identifies the deferral shape", () => {
  assert.equal(isConfirmationDeferral("user-message-too-short", "yes"), true);
  assert.equal(isConfirmationDeferral("user-message-too-short", "whatever"), false);
  assert.equal(isConfirmationDeferral(null, "yes"), false);
});

test("min-interval throttle uses injected state", () => {
  const text = "I will always write code comments in English";
  assert.equal(
    extractionSkipReason({ ...base, latestUserText: text, lastRunAt: 995_000 }),
    "throttled-min-interval",
  );
  assert.equal(
    extractionSkipReason({ ...base, latestUserText: text, lastRunAt: 900_000 }),
    null,
  );
});

test("no-new-user-message skips re-extraction of the same turn", () => {
  const text = "I will always write code comments in English";
  assert.equal(
    extractionSkipReason({
      ...base,
      latestUserText: text,
      lastExtractedUserKey: "k1",
      currentUserKey: "k1",
    }),
    "no-new-user-message",
  );
  assert.equal(
    extractionSkipReason({
      ...base,
      latestUserText: text,
      lastExtractedUserKey: "k1",
      currentUserKey: "k2",
    }),
    null,
  );
});

test("confirmation word list is normalized against punctuation", () => {
  assert.equal(isShortMemoryConfirmationText("  yes. "), true);
  assert.equal(isShortMemoryConfirmationText("Yes!"), true);
  assert.equal(isShortMemoryConfirmationText("maybe"), false);
});

test("grapheme length counts emoji clusters as single units", () => {
  assert.equal(graphemeLength("abc"), 3);
  assert.equal(graphemeLength("hi"), 2);
  assert.ok(graphemeLength("👍🏻👍🏻") <= 4);
});
