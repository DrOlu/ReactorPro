package agentd

// The provider client: one OpenAI-compatible chat-completions endpoint. The
// agentd holds its own key, so the gateway keeps its "no model keys, ever"
// property. Only the subset of the API a tool-using turn needs is modelled —
// a provider's extra fields are ignored on read and never sent.
//
// Rounds are streamed: the model's answer arrives as server-sent events, so
// a slow provider is visibly slow rather than looking dead — the outage
// class where a non-streaming call sits headerless until the client's total
// timeout kills a turn that was still generating. The timeout model follows:
// the configured request timeout is the IDLE timeout (the longest the
// provider may stay silent between bytes, before or after headers) and a
// generous hard cap bounds the round even when keepalive comments trickle
// in forever. A provider that answers a streamed request with a plain JSON
// completion (streaming ignored or unsupported) is still served.

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"sync/atomic"
	"time"
)

// providerHardCap bounds one streamed round no matter how chatty the
// provider is. Keepalive comments can keep a stuck generation "alive" at the
// byte level; this is the backstop that still ends the round.
const providerHardCap = 15 * time.Minute

// Provider talks to an OpenAI-compatible /chat/completions endpoint.
type Provider struct {
	baseURL     string
	apiKey      string
	model       string
	maxTokens   int
	idleTimeout time.Duration
	client      *http.Client
}

// NewProvider builds the client. baseURL is everything before
// /chat/completions (e.g. https://api.openai.com/v1). idleTimeout is the
// longest the provider may stay silent between bytes within one round; the
// round itself is capped at providerHardCap.
func NewProvider(baseURL, apiKey, model string, maxTokens int, idleTimeout time.Duration) *Provider {
	// The default transport pools at 2 idle conns per host — fine for one
	// turn at a time, thrash for a worker whose every round (across all its
	// concurrent turns) hits the same provider host. Widen the pool so
	// rounds ride warm connections: fewer handshakes, sooner first byte.
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.MaxIdleConnsPerHost = 64
	transport.MaxIdleConns = 256
	transport.IdleConnTimeout = 90 * time.Second
	return &Provider{
		baseURL:     strings.TrimRight(strings.TrimSpace(baseURL), "/"),
		apiKey:      strings.TrimSpace(apiKey),
		model:       strings.TrimSpace(model),
		maxTokens:   maxTokens,
		idleTimeout: idleTimeout,
		// No total timeout: a streaming round may legitimately run for as
		// long as it keeps making progress (see streamWatchdog).
		client: &http.Client{Transport: transport},
	}
}

// ToolCall is one call the model wants made, in the provider's format.
type ToolCall struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}

// Message is one turn-history entry. Tool results use Role "tool" with the
// call id; an assistant message that requested tools carries ToolCalls.
type Message struct {
	Role       string     `json:"role"`
	Content    string     `json:"content"`
	ToolCallID string     `json:"tool_call_id,omitempty"`
	ToolCalls  []ToolCall `json:"tool_calls,omitempty"`
}

// completionRequest is the request body; tools are the enabled descriptors.
type completionRequest struct {
	Model     string        `json:"model"`
	Messages  []Message     `json:"messages"`
	Tools     []interface{} `json:"tools,omitempty"`
	MaxTokens int           `json:"max_tokens,omitempty"`
	Stream    bool          `json:"stream"`
}

type completionResponse struct {
	Choices []struct {
		FinishReason string `json:"finish_reason"`
		Message      struct {
			Role      string     `json:"role"`
			Content   string     `json:"content"`
			ToolCalls []ToolCall `json:"tool_calls"`
		} `json:"message"`
	} `json:"choices"`
	Error *struct {
		Message string `json:"message"`
		Type    string `json:"type"`
	} `json:"error"`
}

// streamChunk is one server-sent-event payload from a streamed completion.
// Deltas accumulate: content appends to the text, tool calls arrive indexed
// and fragmented (the id and name once, arguments in pieces).
type streamChunk struct {
	Choices []struct {
		FinishReason string `json:"finish_reason"`
		Delta        struct {
			Content   string `json:"content"`
			ToolCalls []struct {
				Index    int    `json:"index"`
				ID       string `json:"id"`
				Type     string `json:"type"`
				Function struct {
					Name      string `json:"name"`
					Arguments string `json:"arguments"`
				} `json:"function"`
			} `json:"tool_calls"`
		} `json:"delta"`
	} `json:"choices"`
	Error *struct {
		Message string `json:"message"`
		Type    string `json:"type"`
	} `json:"error"`
}

// Completion is one provider answer: text, requested tool calls, or both.
type Completion struct {
	Text       string
	ToolCalls  []ToolCall
	FinishFlow bool // true when the provider ended the turn (stop)
}

// Complete performs one chat-completions call, streaming the answer.
func (p *Provider) Complete(ctx context.Context, messages []Message, tools []Tool) (Completion, error) {
	return p.complete(ctx, messages, toolDescriptors(tools), nil)
}

// CompleteStream performs one streamed call, invoking onDelta with each
// content delta as it arrives — the hook a live viewer's token stream is
// built from. The answer itself is unchanged: onDelta observes the stream,
// it never alters the completion. A nil onDelta behaves exactly like
// Complete.
func (p *Provider) CompleteStream(ctx context.Context, messages []Message, tools []Tool, onDelta func(string)) (Completion, error) {
	return p.complete(ctx, messages, toolDescriptors(tools), onDelta)
}

// complete is the machinery behind both entries; descriptors arrive
// pre-derived so a turn that already knows its tools does not re-derive
// them per round.
func (p *Provider) complete(ctx context.Context, messages []Message, descriptors []interface{}, onDelta func(string)) (Completion, error) {
	request := completionRequest{
		Model:    p.model,
		Messages: messages,
		Stream:   true,
	}
	if p.maxTokens > 0 {
		request.MaxTokens = p.maxTokens
	}
	if len(descriptors) > 0 {
		request.Tools = descriptors
	}
	body, err := json.Marshal(request)
	if err != nil {
		return Completion{}, err
	}
	watchdog, wctx := newStreamWatchdog(ctx, p.idleTimeout)
	defer watchdog.cancel()
	req, err := http.NewRequestWithContext(wctx, http.MethodPost, p.baseURL+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return Completion{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+p.apiKey)
	response, err := p.client.Do(req)
	if err != nil {
		return Completion{}, fmt.Errorf("provider request: %w", watchdog.annotate(err))
	}
	defer func() { _ = response.Body.Close }()
	if response.StatusCode >= 400 {
		raw, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
		if err != nil {
			return Completion{}, fmt.Errorf("provider response: %w", err)
		}
		return Completion{}, fmt.Errorf("provider status %s: %s", response.Status, capString(string(raw), 512))
	}
	if !strings.Contains(strings.ToLower(response.Header.Get("Content-Type")), "text/event-stream") {
		// The provider answered the streamed request with a plain JSON
		// completion (streaming ignored or unsupported) — serve it. There
		// are no deltas to observe on this path: the answer arrives whole.
		return p.completeFromJSON(response)
	}
	return p.consumeStream(response, watchdog, onDelta)
}

// completeFromJSON parses a whole-body completion — the legacy shape, kept
// for providers that ignore the stream flag.
func (p *Provider) completeFromJSON(response *http.Response) (Completion, error) {
	raw, err := io.ReadAll(io.LimitReader(response.Body, 8<<20))
	if err != nil {
		return Completion{}, fmt.Errorf("provider response: %w", err)
	}
	var parsed completionResponse
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return Completion{}, fmt.Errorf("provider response is not valid JSON: %w", err)
	}
	if parsed.Error != nil {
		return Completion{}, fmt.Errorf("provider error: %s", parsed.Error.Message)
	}
	if len(parsed.Choices) == 0 {
		return Completion{}, errors.New("provider returned no choices")
	}
	choice := parsed.Choices[0]
	return Completion{
		Text:       strings.TrimSpace(choice.Message.Content),
		ToolCalls:  choice.Message.ToolCalls,
		FinishFlow: choice.FinishReason == "stop" || choice.FinishReason == "length",
	}, nil
}

// consumeStream assembles one completion from server-sent events. Every read
// resets the watchdog's silence clock, so keepalive comments from a slow
// provider keep the round alive while it is genuinely still working. onDelta
// observes each content delta as it folds in — nil when nobody is watching.
func (p *Provider) consumeStream(response *http.Response, watchdog *streamWatchdog, onDelta func(string)) (Completion, error) {
	var (
		out    Completion
		finish string
	)
	calls := make(map[int]*ToolCall)
	scanner := bufio.NewScanner(&progressReader{reader: response.Body, watchdog: watchdog})
	scanner.Buffer(make([]byte, 64*1024), 1<<20)
	for scanner.Scan() {
		line := strings.TrimSuffix(scanner.Text(), "\r")
		if line == "" || strings.HasPrefix(line, ":") {
			continue // SSE comment (keepalive) or blank separator
		}
		if !strings.HasPrefix(line, "data:") {
			continue // not a data event; ignore
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "[DONE]" {
			break
		}
		var chunk streamChunk
		if err := json.Unmarshal([]byte(data), &chunk); err != nil {
			continue // tolerate a provider's non-JSON noise on the stream
		}
		if chunk.Error != nil {
			return Completion{}, fmt.Errorf("provider error mid-stream: %s", chunk.Error.Message)
		}
		if len(chunk.Choices) == 0 {
			continue // usage-only or role-only chunks carry nothing to fold in
		}
		choice := chunk.Choices[0]
		if choice.FinishReason != "" {
			finish = choice.FinishReason
		}
		out.Text += choice.Delta.Content
		if onDelta != nil && choice.Delta.Content != "" {
			onDelta(choice.Delta.Content)
		}
		for _, call := range choice.Delta.ToolCalls {
			slot, ok := calls[call.Index]
			if !ok {
				slot = &ToolCall{Type: "function"}
				calls[call.Index] = slot
			}
			if call.ID != "" {
				slot.ID = call.ID
			}
			if call.Type != "" {
				slot.Type = call.Type
			}
			if call.Function.Name != "" {
				slot.Function.Name += call.Function.Name
			}
			slot.Function.Arguments += call.Function.Arguments
		}
	}
	if err := scanner.Err(); err != nil {
		return Completion{}, fmt.Errorf("provider response: %w", watchdog.annotate(err))
	}
	if finish == "" && out.Text == "" && len(calls) == 0 {
		return Completion{}, errors.New("provider returned no choices")
	}
	if len(calls) > 0 {
		out.ToolCalls = orderedToolCalls(calls)
	}
	out.Text = strings.TrimSpace(out.Text)
	out.FinishFlow = finish == "stop" || finish == "length"
	return out, nil
}

// orderedToolCalls renders the index-keyed accumulation back into the
// provider's list order.
func orderedToolCalls(calls map[int]*ToolCall) []ToolCall {
	indexes := make([]int, 0, len(calls))
	for index := range calls {
		indexes = append(indexes, index)
	}
	sort.Ints(indexes)
	out := make([]ToolCall, 0, len(indexes))
	for _, index := range indexes {
		out = append(out, *calls[index])
	}
	return out
}

// streamWatchdog cancels a provider round when the upstream goes silent for
// longer than the idle timeout (headers never arriving, or a mid-stream
// stall) or when the hard cap passes. Every byte received resets the
// silence clock, so an active stream is never cut.
type streamWatchdog struct {
	cancel   context.CancelFunc
	idle     time.Duration
	lastRead atomic.Int64 // unix nanos of the most recent byte
	started  time.Time
	reason   atomic.Value // string, set right before a watchdog cancel
}

// newStreamWatchdog derives a cancellable context from ctx and starts the
// watchdog goroutine. cancel must be called when the round ends.
func newStreamWatchdog(ctx context.Context, idle time.Duration) (*streamWatchdog, context.Context) {
	w := &streamWatchdog{idle: idle, started: time.Now()}
	w.lastRead.Store(time.Now().UnixNano())
	wctx, cancel := context.WithCancel(ctx)
	w.cancel = cancel
	interval := idle / 8
	if interval < 20*time.Millisecond {
		interval = 20 * time.Millisecond
	}
	if interval > time.Second {
		interval = time.Second
	}
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		hardAt := w.started.Add(providerHardCap)
		for {
			select {
			case <-wctx.Done():
				return // round ended (or the caller cancelled) before any limit
			case <-ticker.C:
				if idle > 0 {
					if silent := time.Since(time.Unix(0, w.lastRead.Load())); silent > idle {
						w.reason.Store(fmt.Sprintf("stalled: no data from the provider for %s (idle timeout)", silent.Truncate(time.Second)))
						w.cancel()
						return
					}
				}
				if time.Now().After(hardAt) {
					w.reason.Store(fmt.Sprintf("exceeded the per-round hard cap of %s", providerHardCap))
					w.cancel()
					return
				}
			}
		}
	}()
	return w, wctx
}

// mark records that bytes arrived; progress resets the idle clock.
func (w *streamWatchdog) mark() {
	w.lastRead.Store(time.Now().UnixNano())
}

// annotate replaces an opaque context-canceled error with the watchdog's
// reason when the watchdog was what ended the round.
func (w *streamWatchdog) annotate(err error) error {
	if reason, ok := w.reason.Load().(string); ok && reason != "" {
		return fmt.Errorf("provider stream %s", reason)
	}
	return err
}

// progressReader feeds the watchdog on every byte read.
type progressReader struct {
	reader   io.Reader
	watchdog *streamWatchdog
}

func (pr *progressReader) Read(p []byte) (int, error) {
	n, err := pr.reader.Read(p)
	if n > 0 {
		pr.watchdog.mark()
	}
	return n, err
}

// toolDescriptors renders the toolset in the provider's function-calling
// shape.
func toolDescriptors(tools []Tool) []interface{} {
	out := make([]interface{}, 0, len(tools))
	for _, tool := range tools {
		out = append(out, map[string]any{
			"type": "function",
			"function": map[string]any{
				"name":        tool.Name,
				"description": tool.Description,
				"parameters":  tool.Parameters,
			},
		})
	}
	return out
}
