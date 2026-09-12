# Chat Runtime Architecture

## Execution Mode

| Mode | Entry | Tools | Typical Use |
|---|---|---|---|
| `text` | `runTextConversationTurn.ts` | Local tools not enabled | Pure model chat, low-privilege text answers. |
| `tools` | `runAgentConversationTurn.ts` | Enables the builtin tool registry | Regular Agent mode, supporting files, Shell, MCP, Skills, Memory, Cron, etc. |
| `agent-dev` | `runAgentConversationTurn.ts` | Enables tools and shows more debug/usage/silent memory detail | Agent mode with more development debugging and observability. |

## Main Flow

| Step | Description | Key Modules |
|---:|---|---|
| 1 | Collect user input, attachments, selected model, execution mode, workdir, system tools. | `ChatPage.tsx`, `agent-ui/src/pages/chat/ChatComposerBar.tsx` |
| 2 | Load Skills prompt, Memory overview, hooks, historical context, and the current active segment. | `useChatSkills.ts`, `memoryPrompt.ts`, `conversationState.ts` |
| 3 | Build the model request context, triggering pre-send compaction first if necessary. | `conversationContextBuilders.ts`, `compaction/*` |
| 4 | In text mode, stream the assistant directly; tools/agent-dev builds the tool registry and enters the tool loop. | `llm.ts`, `builtinRegistry.ts`, `runAgentConversationTurn.ts` |
| 5 | Streaming token/thinking/hosted search/tool status updates the transcript and publishes Gateway events. | `liveTranscriptStore.ts`, `gatewayBridgeEvents.ts` |
| 6 | Tool calls are dispatched through the registry to the corresponding executor, and results are fed back into the model context. | `lib/tools/*`, `lib/chat/conversation/run/*` |
| 7 | After the turn ends, write to chat history, generate a title, and trigger silent memory extraction and hooks. | `chat_history.rs`, `conversationTitleJob.ts`, `silentMemoryExtraction.ts` |

## Model Layer

`src/lib/providers/llm.ts` maps the application's internal providers to actual APIs:

| Provider | Main API | Features |
|---|---|---|
| `claude_code` | Anthropic Messages compatible | thinking, cache control, toolChoice, Anthropic native web search. |
| `codex` | OpenAI Responses or Completions | Responses storage, hosted search probe, OpenAI tool/search event aggregation. |
| `gemini` | Google Generative AI | Gemini thinking runtime, Gemini auth header, provider native search. |
| custom provider | Mapped by `ProviderId` and request format | baseUrl/apiKey/model config/reasoning/cache etc. are determined by settings. |

## Context Construction

| Context block | Source |
|---|---|
| system prompt | Default system prompt, user system settings, Skills prompt, Memory overview, compaction summary. |
| messages | user/assistant/toolResult history in the current active segment, after the sanitizer. |
| tools | Empty in text mode; in agent mode comes from the builtin registry and dynamic MCP tools. |
| attachments | uploaded files are converted into model-visible text/image references, with image bytes sanitized per the context policy. |
| hosted search | search blocks captured by the provider or probe enter the message content and UI. |

## Tool Hints and File Change Tracking

- `runAssistantWithTools` generates runtime tool rules based on the tools actually available in the current turn, and appends them to the base system prompt at each provider request boundary. Dynamic rules are not written to conversation history or compaction state, avoiding repeated stacking after restore or compaction.
- Intentional file/directory deletion in the workspace or in an enabled Skill must call the structured `Delete`; it must not be replaced by Bash, ManagedProcess, shell scripts, or deletion-type CLIs. To stage a Git-tracked workspace deletion, call `Delete` first, then use `git add -u -- <exact workspace-relative path>` to stage only that path.
- The "edited files" and compaction file ledger at the end of a GUI/WebUI reply trust only successful `Write` / `Edit` / `Delete` tool results. Bash commands have indirect side effects across shells, pipes, and scripts, so specific paths cannot be reliably recovered, and thus no guesswork tracking is done.

## Context Compaction

| Trigger | Effect |
|---|---|
| pre-send | Estimate context before sending; if over budget, compact old history first. |
| mid-stream | Interrupt-style compaction when the streaming or tool chain finds the budget insufficient. |
| post-tool | Compact before the next round when the context expands after a tool call. |

The compaction product is written into a new history segment as a summary checkpoint. The UI shows context checkpoints; subsequent requests merge the summary into the system prompt and carry only the message window not yet covered.

## Hooks Lifecycle

| Event | Trigger Semantics |
|---|---|
| `agent_start` / `agent_end` | Start and end of a main conversation request. |
| `turn_start` / `turn_end` | Start and end of each model processing round. |
| `message_start` / `message_update` / `message_end` | Assistant message streaming generation phase. |
| `tool_execution_start` / `tool_execution_update` / `tool_execution_end` | Actual tool execution phase. |

Hooks support shell scripts and HTTP requests; the shared settings UI is in `agent-ui`, configuration syncs between both ends via Gateway, and actual execution happens on the desktop.

## Upload and Resend

| Capability | Semantics |
|---|---|
| File upload | Available only in tools-type modes; files are temporarily stored in `~/.liveagent/uploads` (outside the workspace, GC'd by 30-day age on startup), and the model accesses them read-only via absolute paths. |
| Image preview | GUI/WebUI both support previewing user attachments, Image tool images, and inline tool result images. |
| Edit and resend | Truncate from the target user message and resend, keeping history semantics consistent with GUI/WebUI. |
| Attachment-only resend | Supports re-issuing a request using only existing attachments. |

## Interactive Questioning (AskUserQuestion)

| Capability | Semantics |
|---|---|
| Tool shape | A chat-only builtin tool; the model asks at most 4 questions at a time, each with 2-6 options (**the number of options can differ per question**), with at most one "recommended" option that is **always placed first**. |
| Suspension semantics | `execute` waits on the tool suspension table (keyed by toolCallId); it resolves when the user submits, and the stop button settles via AbortSignal as "unanswered" (`details.cancelled`); **if unanswered for 3 minutes it auto-settles to the recommended option (or the first option by default)** (`details.timedOut`), and the card shows a countdown. **The countdown is sourced identically on both ends**: the desktop stamps the authoritative deadline timestamp `__askUserQuestionDeadlineAt` on the tool arguments reported by the gateway (`gatewayToolPreview` stamps uniformly, and execute reuses the same preset value), and WebUI/reconnect scenarios count down using the real remaining time. |
| Card UI | `crates/agent-ui/src/components/chat/AskUserQuestionCard.tsx` (shared implementation): multiple questions switch via top tabs, single-select with a recommended marker, submit after all are answered; after settling, responses are shown read-only. **The whole card appears only after all questions and options are fully generated** (`runAgentConversationTurn` skips tool_call_delta for AskUserQuestion, and neither end does progressive reveal). |
| Both-end answering | GUI calls `answerAskUserQuestion` directly; WebUI goes through `chat_queue.tool_answer` (item_id=toolCallId, request_json=array of selections) and the desktop lands it on the same suspension table, with zero protocol changes; remote answers **validate that conversation_id matches the conversation owning the suspended question**, preventing cross-conversation answers. |
| Result back to model | Standard `ToolResultMessage`: content lists the final selection for each question, and `details.kind = "ask_user_question"` drives history replay rendering. |

## Runtime Observability

| Content | Location |
|---|---|
| Usage | Token usage per assistant round; more prominent in agent-dev. |
| Tool trace | Tool calls/results shown by round and group in `AssistantBubble`. |
| Hosted search | Search blocks enter the transcript, preserving the anchor and aggregation state. |
| Debug JSONL | `system_append_debug_jsonl` can write local debug logs. |
| Gateway stream | WebUI can see remote events such as token/thinking/tool/done/error. |