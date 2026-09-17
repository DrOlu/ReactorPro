package agentd

// The within-turn context manager: mechanical, transparent compaction of the
// message list the MODEL sees. The desktop solves this with LLM
// summarization (crates/agent-gui/src/lib/chat/compaction); a worker needs
// the opposite posture — cheap, deterministic, never a second provider call
// inside a turn. The ladder is therefore:
//
//   1. tool-result elision, oldest first: the newest keepToolResults tool
//      results stay verbatim; older bodies are replaced in place by a marker
//      that says what was elided and how to get it back (re-run the tool).
//      The assistant's tool-call records are kept, so the model still knows
//      what was asked of which tool;
//   2. drop-middle: whole assistant(tool_calls)+tool(result) exchanges are
//      removed from the middle of the turn — never the system prompt, never
//      the first user message (the task), never the newest exchanges, never
//      the current round.
//
// Everything here is a pure function over []Message. The transcript the
// checkpoints publish is NEVER rewritten — compaction shapes the model's
// context, not the human record, and the original tool results stay in the
// transcript and the sandbox either way.

import (
	"fmt"
	"strings"
)

// contextBudget bounds the model-visible history of one turn.
type contextBudget struct {
	// maxTokens is the estimated-token ceiling above which the ladder fires.
	// 0 disables the module entirely.
	maxTokens int
	// keepToolResults is how many of the newest tool results stay verbatim.
	keepToolResults int
	// summarize is a reserved seam: when implemented, over-budget regions
	// would be replaced by a provider-written summary instead of a marker.
	// v0.2 keeps the ladder mechanical — the flag is plumbed so a later
	// agentd can honor configurations written against this one.
	summarize bool
}

// contextBudgetFromConfig resolves the flags once per use.
func contextBudgetFromConfig(cfg *Config) contextBudget {
	return contextBudget{
		maxTokens:       cfg.ContextBudgetTokens,
		keepToolResults: cfg.ContextKeepToolResults,
		summarize:       cfg.ContextSummarize,
	}
}

// The token estimator mirrors the desktop's context usage estimator
// (crates/agent-ui/src/lib/chat/contextUsage.ts): roughly four characters
// per token for Western text, about 0.7 tokens per character for CJK,
// because CJK glyphs are dense. It is an approximation by design — it feeds
// a conservative default budget, not a billing meter — and the exact
// constants match the TS side so the two surfaces budget alike.

const (
	westernTokensPerChar = 0.25 // 1/4: CHARS_PER_TOKEN on the desktop side
	cjkTokensPerChar     = 0.7
	toolCallOverhead     = 8 // role/structure overhead per message, in tokens
)

// isCjkRune mirrors isCjkCodeUnit: the BMP ranges the desktop counts as CJK.
func isCjkRune(r rune) bool {
	switch {
	case r >= 0x2E80 && r <= 0x9FFF, // CJK radicals, unified ideographs, kana
		r >= 0xAC00 && r <= 0xD7AF, // Hangul syllables
		r >= 0x1100 && r <= 0x11FF, // Hangul jamo
		r >= 0xF900 && r <= 0xFAFF, // CJK compatibility ideographs
		r >= 0xFE30 && r <= 0xFE4F, // CJK compatibility forms
		r >= 0xFF00 && r <= 0xFFEF: // fullwidth forms
		return true
	}
	return false
}

// estimateTextTokens approximates the tokens of one string.
func estimateTextTokens(s string) float64 {
	if s == "" {
		return 0
	}
	cjk := 0
	for _, r := range s {
		if isCjkRune(r) {
			cjk++
		}
	}
	runes := float64(len([]rune(s)))
	return (runes-float64(cjk))*westernTokensPerChar + float64(cjk)*cjkTokensPerChar
}

// estimateMessageTokens approximates one history message, including its tool
// calls — the arguments a model re-reads are context too.
func estimateMessageTokens(m Message) float64 {
	total := estimateTextTokens(m.Content) + toolCallOverhead
	for _, call := range m.ToolCalls {
		total += estimateTextTokens(call.Function.Name) +
			estimateTextTokens(call.Function.Arguments) + 4
	}
	return total
}

// estimateMessagesTokens sums a whole message list.
func estimateMessagesTokens(messages []Message) int {
	total := 0.0
	for _, m := range messages {
		total += estimateMessageTokens(m)
	}
	return int(total)
}

// compactResult reports what one compaction pass did — for the log line, and
// for the tests that pin the ladder's behaviour.
type compactResult struct {
	messages          []Message
	estimatedBefore   int
	estimatedAfter    int
	elidedToolResults int
	droppedExchanges  int
}

// elisionMarkerPrefix identifies an already-elided tool result, so a second
// pass never rewrites (or re-counts) a marker as if it were content.
const elisionMarkerPrefix = "[agentd context management:"

// elisionMarker builds the in-place replacement for an elided tool result.
// The marker is the transparency: the model sees what was removed, why, and
// the recovery path (the sandbox still holds everything; re-run the tool).
func elisionMarker(bytes int, toolName, callID string) string {
	if toolName == "" {
		toolName = "unknown-tool"
	}
	return fmt.Sprintf("%s elided a %d-byte tool result for %s (call %s); re-run the tool if you need it]",
		elisionMarkerPrefix, bytes, toolName, callID)
}

// toolNameForCall resolves the tool name a tool result answered, by finding
// the assistant message that requested that call id.
func toolNameForCall(messages []Message, callID string) string {
	for _, m := range messages {
		for _, call := range m.ToolCalls {
			if call.ID == callID {
				return call.Function.Name
			}
		}
	}
	return ""
}

// exchange is one assistant(tool_calls) + following tool(result) span.
type exchange struct {
	start int // index of the assistant message with the tool calls
	end   int // index one past the last tool result of the span
}

// compactMessages applies the ladder to one turn's message list and returns
// the (possibly new) list plus what it did. It never mutates the caller's
// slice: the first change copies. Under budget, the input is returned as-is.
func compactMessages(messages []Message, budget contextBudget) compactResult {
	result := compactResult{messages: messages}
	result.estimatedBefore = estimateMessagesTokens(messages)
	if budget.maxTokens <= 0 || result.estimatedBefore <= budget.maxTokens || len(messages) <= 2 {
		result.estimatedAfter = result.estimatedBefore
		return result
	}

	// --- stage 1: elide old tool results, oldest first -------------------
	// The newest keepToolResults tool results stay verbatim; everything
	// older that is still real content becomes a marker.
	toolIdx := make([]int, 0, len(messages))
	for i, m := range messages {
		if m.Role == "tool" {
			toolIdx = append(toolIdx, i)
		}
	}
	if len(toolIdx) > budget.keepToolResults {
		old := toolIdx[:len(toolIdx)-budget.keepToolResults]
		work := append([]Message(nil), messages...) // copy before first write
		for _, i := range old {
			body := work[i].Content
			if body == "" || strings.HasPrefix(body, elisionMarkerPrefix) {
				continue
			}
			work[i].Content = elisionMarker(len(body),
				toolNameForCall(messages, work[i].ToolCallID), work[i].ToolCallID)
			result.elidedToolResults++
		}
		if result.elidedToolResults > 0 {
			messages = work
		}
		result.estimatedAfter = estimateMessagesTokens(messages)
		if result.estimatedAfter <= budget.maxTokens {
			result.messages = messages
			return result
		}
	}

	// --- stage 2: drop-middle of whole exchanges ---------------------------
	// An exchange is one assistant(tool_calls) message plus the tool
	// results that answered it. The newest keepToolResults exchanges —
	// which include the round about to run — are protected, as are the
	// system prompt and the first user message (they are never inside an
	// exchange anyway; stating it keeps the invariant legible). Drops are
	// decided oldest-first against a running estimate, then applied as one
	// filter pass — no index juggling while positions shift.
	var exchanges []exchange
	for i := 0; i < len(messages); i++ {
		if messages[i].Role != "assistant" || len(messages[i].ToolCalls) == 0 {
			continue
		}
		end := i + 1
		for end < len(messages) && messages[end].Role == "tool" {
			end++
		}
		exchanges = append(exchanges, exchange{start: i, end: end})
		i = end - 1 // skip past the span
	}
	if len(exchanges) > budget.keepToolResults {
		droppable := exchanges[:len(exchanges)-budget.keepToolResults]
		current := estimateMessagesTokens(messages)
		if current > budget.maxTokens {
			dropIdx := map[int]bool{}
			for _, ex := range droppable {
				if current <= budget.maxTokens {
					break
				}
				spanTokens := 0.0
				for i := ex.start; i < ex.end; i++ {
					spanTokens += estimateMessageTokens(messages[i])
					dropIdx[i] = true
				}
				current -= int(spanTokens)
				result.droppedExchanges++
			}
			if result.droppedExchanges > 0 {
				work := make([]Message, 0, len(messages))
				for i, m := range messages {
					if !dropIdx[i] {
						work = append(work, m)
					}
				}
				messages = work
			}
		}
	}
	result.estimatedAfter = estimateMessagesTokens(messages)
	result.messages = messages
	return result
}
