package agentd

// The provider client: one OpenAI-compatible chat-completions endpoint. The
// agentd holds its own key, so the gateway keeps its "no model keys, ever"
// property. Only the subset of the API a tool-using turn needs is modelled —
// a provider's extra fields are ignored on read and never sent.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// Provider talks to an OpenAI-compatible /chat/completions endpoint.
type Provider struct {
	baseURL   string
	apiKey    string
	model     string
	maxTokens int
	client    *http.Client
}

// NewProvider builds the client. baseURL is everything before
// /chat/completions (e.g. https://api.openai.com/v1).
func NewProvider(baseURL, apiKey, model string, maxTokens int, timeout time.Duration) *Provider {
	return &Provider{
		baseURL:   strings.TrimRight(strings.TrimSpace(baseURL), "/"),
		apiKey:    strings.TrimSpace(apiKey),
		model:     strings.TrimSpace(model),
		maxTokens: maxTokens,
		client:    &http.Client{Timeout: timeout},
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

// Completion is one provider answer: text, requested tool calls, or both.
type Completion struct {
	Text       string
	ToolCalls  []ToolCall
	FinishFlow bool // true when the provider ended the turn (stop)
}

// Complete performs one chat-completions call.
func (p *Provider) Complete(ctx context.Context, messages []Message, tools []Tool) (Completion, error) {
	request := completionRequest{
		Model:    p.model,
		Messages: messages,
	}
	if p.maxTokens > 0 {
		request.MaxTokens = p.maxTokens
	}
	if len(tools) > 0 {
		request.Tools = toolDescriptors(tools)
	}
	body, err := json.Marshal(request)
	if err != nil {
		return Completion{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.baseURL+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return Completion{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+p.apiKey)
	response, err := p.client.Do(req)
	if err != nil {
		return Completion{}, fmt.Errorf("provider request: %w", err)
	}
	defer func() { _ = response.Body.Close() }()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 8<<20))
	if err != nil {
		return Completion{}, fmt.Errorf("provider response: %w", err)
	}
	if response.StatusCode >= 400 {
		return Completion{}, fmt.Errorf("provider status %s: %s", response.Status, capString(string(raw), 512))
	}
	var parsed completionResponse
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return Completion{}, fmt.Errorf("provider response is not valid JSON: %w", err)
	}
	if parsed.Error != nil {
		return Completion{}, fmt.Errorf("provider error: %s", parsed.Error.Message)
	}
	if len(parsed.Choices) == 0 {
		return Completion{}, fmt.Errorf("provider returned no choices")
	}
	choice := parsed.Choices[0]
	return Completion{
		Text:       strings.TrimSpace(choice.Message.Content),
		ToolCalls:  choice.Message.ToolCalls,
		FinishFlow: choice.FinishReason == "stop" || choice.FinishReason == "length",
	}, nil
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
