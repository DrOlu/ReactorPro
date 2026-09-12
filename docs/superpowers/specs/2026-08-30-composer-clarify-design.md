# Composer Prompt Clarification Feature Design

Date: 2026-08-30
Status: Approved

## Background and Goals

Many users write poor prompts and often are not clear about what they actually want. Goal: provide a "Clarify" button next to the chat input box that uses a lightweight LLM conversation to keep asking the user follow-up questions to clarify their needs, and finally produces an optimized prompt placed back into the input box. The clarification logic is extracted and adapted from superpowers' brainstorming skill.

Confirmed requirement decisions:

- UI form: an inline panel above the input box
- Model: the primary model currently selected for the session
- Coverage: both surfaces at once, the desktop GUI and Web (agent-gateway)
- End timing: the LLM decides on its own when it has asked enough and produces the final draft; the panel has a persistent "Generate now" button as a fallback
- Draft handling: the output replaces only the text segment; attachments and file/code/commit mentions are preserved as-is
- Context awareness: draft + lightweight workspace info (workdir, git branch), without file contents

## Architecture

New shared code lives in `crates/agent-ui/src/components/chat/clarify/`:

```
clarify/
├── ClarifyPanel.tsx        # Inline panel UI: message bubbles + input row + action buttons
├── useClarifySession.ts     # State machine: message list, rounds, loading state, termination
├── clarifyProtocol.ts      # Final-draft protocol parsing + system prompt construction
└── clarifyTypes.ts         # ClarifyMessage / RunClarifyTurn / ClarifyResult types
```

`useClarifySession` state machine:

```
idle → asking(streaming) → asking(waiting for user) → … → synthesizing(generating final draft) → done
```

- Holds the complete message array (system + alternating user/assistant); each round sends the whole thing to the LLM, with no server-side session state.
- "Generate now" button: injects an instruction at the end of the messages so the LLM immediately produces the final draft.
- AbortController throughout: closing the panel or switching sessions cancels in-flight requests.

## Injection Interface

`ChatComposerBarProps` additions:

```ts
runClarifyTurn?: (messages: ClarifyMessage[], signal: AbortSignal) => Promise<string>;
clarifyContext?: { workdir: string; gitBranch?: string };
```

When absent, the button is not rendered (the same gating pattern as props like `mentionApps`).

GUI host (`ConversationPaneHostEnvironment`): wraps the existing
`streamAssistantMessage` (`crates/agent-gui/src/lib/providers/runtime/textOnlyRuntime.ts`),
takes the current value of `resolveEffectiveChatModelSelection` for the model, and
prefixes `sessionId` with `clarify-` to keep it independent of the main session.

Web host (`GatewayAppView`): adds a gateway RPC `clarify_prompt_turn`,
reusing the existing WebSocket client and protobuf envelope; the server performs one
text completion with the current provider configuration and returns the whole thing
(clarification rounds are short, so streaming is unnecessary).

## Interaction

- The button sits in the bottom control row of the input box (next to the model selector), using an existing "question mark/bubble" style icon from IconSet.
- Clicking takes the current draft text as the initial requirement; the button is disabled when the draft is empty.
- While the panel is open the input box itself remains editable, but the send button is disabled (to avoid sending a half-finished draft mid-way).
- After the output lands in the box, the panel closes automatically, focus returns to the input box, and the user can continue editing or send directly.

## Prompt Design

System prompt (`clarifyProtocol.ts` constants, extracted and adapted from superpowers brainstorming):

- Role: a prompt clarification assistant that helps users turn vague ideas into directly executable prompts.
- Rules:
  - Ask only one question at a time.
  - Questions should preferably offer 2-4 options (which the user can select directly) or allow an open answer.
  - Focus on: purpose (what they want to achieve), constraints (technical/scope/style), success criteria (what counts as done).
  - Do not re-ask about parts the draft already makes clear; ask at most 5 rounds, then produce the final draft once enough is known.
  - Reply language follows the language of the user's draft.
- Include the lightweight workspace info from `clarifyContext`.

## Final Draft Protocol

Each assistant reply starts with a single-line marker:

```
[CLARIFY_QUESTION]
The question text for this round……

[CLARIFY_FINAL]
The optimized complete prompt……
```

- During streaming, markers are detected line by line: QUESTION renders the following text as a bubble; FINAL switches to
  `synthesizing`, and after completion the landing flow runs.
- Markers rather than JSON: question text is streamed to the user for display, whereas JSON must be fully parsed before it can render; the marker approach can display from the first token, and no `allowJsonOutput` needs to be enabled.
- Parse-failure fallback: a reply with no marker is treated entirely as a QUESTION, and the flow does not break.

## Final Draft Landing

1. Once the `final` text arrives, the panel shows a completion state.
2. Written via `MentionComposerHandle`: only the `type: "text"` segment is replaced, with mentions and
   attachments preserved as-is; presented with a `typeText` typewriter animation. If the existing API is insufficient to preserve
   chips/attachments, implement `replaceTextSegments(text)` with the principle unchanged.
3. The panel closes and focus returns to the input box.

## Error Handling

| Scenario | Behavior |
|---|---|
| LLM call fails | In-panel error row + "Retry" "Close"; retry resends the same round with history preserved |
| Panel closed / session switched | AbortController cancels in-flight requests, and the session is discarded (not persisted) |
| Reply with no marker | Fallback: rendered as a QUESTION |
| Still asking after 5 rounds | From round 6 the frontend automatically injects the final-draft instruction, forcing a wrap-up |
| Empty draft / no model configured | Button disabled, with title explaining why (reusing the `hasModels` gating pattern) |
| Agent is running | Clarification remains available (independent of the session runtime, does not occupy session context) |
| Web RPC fails | Errors are reported through the same toast channel as `onSttError` |

## i18n

All copy goes through `useLocale`'s `chat.clarify.*` keys, in both Chinese and English.

## Tests

- `clarifyProtocol`: pure-function unit tests for marker parsing (QUESTION/FINAL/no marker/marker cut off mid-stream).
- `useClarifySession`: a fake `runClarifyTurn` drives all state transitions: asking, answering, forced wrap-up, cancel, failure retry.
- GUI host wrapper: mock `streamAssistantMessage` and assert parameter mapping (current model, sessionId prefix, context construction).
- Web RPC: add envelope cases following the existing pattern in `crates/agent-gateway/test/webui/gateway-socket-client.test.mjs`.
- Tests live in `crates/agent-gui/test/` (`.mjs`, per existing convention), with no new test framework introduced.

## Implementation Deviation Log (after Plan 1 landed)

- No model configured: the button is hidden rather than disabled (original table: disabled + title hint). GUI users with zero models cannot clarify anyway, so the impact is low; this will be decided uniformly when wiring up Web (Plan 2).
- Sending while the panel is open: implemented as a guard inside handleComposerSend (Enter/click silently no-ops), with the send button kept visually enabled. This can later be changed to a visual disable.
- clarifyRunner does not pass sessionId (same convention as conversationTitleJob); if the provider proxy isolates by session, a `clarify-` prefix must be added.
- Plan 2 (Web) should reuse the clarifyProtocol marker protocol verbatim; the Web host only needs to implement RunClarifyTurn.