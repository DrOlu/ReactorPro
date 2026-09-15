package agentd

// The run manager: turns arrive as chat commands, execute under a bounded
// concurrency semaphore, and everything they produce flows back through the
// reliable ingress. This is where the agentd keeps its one promise the
// desktop cannot: several turns at once, each independent.

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/liveagent/agent-gateway/internal/proto/v2"
)

// CommandSink is the transport the runner pushes ingress through.
type CommandSink interface {
	// SendIngress delivers one chat-ingress record at its logical sequence
	// number. A non-nil error means the run can no longer be reported —
	// the caller fails the run rather than continue unreported work.
	SendIngress(runID, conversationID string, seq uint64, record *gatewayv2.ChatIngressRecord) error
}

// Runner executes chat commands as agent turns.
type Runner struct {
	cfg      *Config
	provider *Provider
	tools    *Toolset
	sink     CommandSink
	logger   *slog.Logger

	// jobs is the polite queue: work beyond the concurrency cap waits here
	// instead of being refused — a peer's burst becomes a line, not an error.
	jobs           chan job
	byConversation map[string]context.CancelFunc
	mu             sync.Mutex
	activeRuns     atomic.Int32
}

// job is one accepted chat command.
type job struct {
	runID           string
	conversationID  string
	clientRequestID string
	prompt          string
}

// NewRunner wires the executor. Call Start to begin consuming.
func NewRunner(cfg *Config, provider *Provider, tools *Toolset, sink CommandSink, logger *slog.Logger) *Runner {
	return &Runner{
		cfg:            cfg,
		provider:       provider,
		tools:          tools,
		sink:           sink,
		logger:         logger,
		jobs:           make(chan job, 1024),
		byConversation: map[string]context.CancelFunc{},
	}
}

// Start launches the worker pool. Each worker holds one concurrency slot for
// the whole duration of a turn, so the configured cap is a real cap.
func (r *Runner) Start(parent context.Context, workers int) {
	for i := 0; i < workers; i++ {
		go r.worker(parent)
	}
}

func (r *Runner) worker(parent context.Context) {
	for {
		select {
		case <-parent.Done():
			return
		case next := <-r.jobs:
			r.execute(parent, next)
		}
	}
}

// SubmitChatCommand accepts a chat.submit for execution. The run id is the
// gateway envelope's request id — the run registry and every ingress batch
// key on it. Runs are one per conversation, the same rule the desktop lives
// by: a second command for a conversation with a live run is refused rather
// than racing it (the gateway's watchdog fails it honestly as never started).
func (r *Runner) SubmitChatCommand(runID string, command *gatewayv2.ChatCommandRequest) {
	request := command.GetRequest()
	if request == nil || strings.TrimSpace(request.GetMessage()) == "" {
		r.logger.Warn("agentd ignored a chat command without a message")
		return
	}
	runID = strings.TrimSpace(runID)
	conversationID := strings.TrimSpace(request.GetConversationId())
	if runID == "" || conversationID == "" {
		r.logger.Warn("agentd ignored a chat command without a run or conversation id")
		return
	}

	r.mu.Lock()
	if _, busy := r.byConversation[conversationID]; busy {
		r.mu.Unlock()
		r.logger.Warn("agentd refused a second concurrent command for a conversation",
			"conversation", conversationID)
		return
	}
	r.mu.Unlock()

	next := job{
		runID:           runID,
		conversationID:  conversationID,
		clientRequestID: strings.TrimSpace(request.GetClientRequestId()),
		prompt:          strings.TrimSpace(request.GetMessage()),
	}
	select {
	case r.jobs <- next:
	default:
		// A full queue is an operator-sizing problem, and refusing is the
		// honest move: the gateway fails the run as never started rather
		// than the peer waiting on a phantom.
		r.logger.Warn("agentd run queue is full; command refused",
			"conversation", conversationID, "queue", cap(r.jobs))
	}
}

// execute runs one job to a terminal record, whatever happens: completion,
// provider failure, cancellation and connection loss all end in exactly one
// terminal, because a run that never terminals is a run the gateway must fail
// by timeout — the least honest ending available.
func (r *Runner) execute(parent context.Context, next job) {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()

	r.mu.Lock()
	r.byConversation[next.conversationID] = cancel
	r.mu.Unlock()
	defer func() {
		r.mu.Lock()
		delete(r.byConversation, next.conversationID)
		r.mu.Unlock()
	}()

	r.activeRuns.Add(1)
	defer r.activeRuns.Add(-1)

	writer := newIngress(next.runID, next.conversationID, func(seq uint64, record *gatewayv2.ChatIngressRecord) error {
		return r.sink.SendIngress(next.runID, next.conversationID, seq, record)
	})

	// Heartbeats: a long tool round that produces no checkpoints must never
	// look stale to the gateway's reaper. The ticker goroutine stops when
	// the turn ends — turnDone closes before the wait, so a finished turn
	// reclaims its worker immediately (waiting only on ctx would deadlock:
	// cancel() is deferred and runs last).
	turnDone := make(chan struct{})
	heartbeatDone := make(chan struct{})
	go func() {
		defer close(heartbeatDone)
		ticker := time.NewTicker(r.cfg.Heartbeat)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-turnDone:
				return
			case <-ticker.C:
				_ = writer.heartbeat()
			}
		}
	}()
	defer func() {
		close(turnDone)
		<-heartbeatDone
	}()

	// The first checkpoint starts the run inside the gateway's settle window
	// and seeds the transcript with the prompt. This is also what makes the
	// turn stream: each later checkpoint is a content snapshot the mesh's
	// chunk emitter derives from.
	entries := []Entry{{ID: "u1", Kind: KindUser, Text: next.prompt}}
	if err := writer.checkpoint(entries); err != nil {
		r.logger.Warn("agentd could not start a run", "run", next.runID, "error", err)
		return
	}

	answer, runErr := r.runTurn(ctx, next, &entries, writer)
	switch {
	case ctx.Err() != nil && parent.Err() == nil:
		// Cancelled by command or conversation drop, not by shutdown.
		_ = writer.terminal(entries, TerminalCancelled, "cancelled", "the run was cancelled")
	case runErr != nil:
		_ = writer.terminal(entries, TerminalFailed, "internal", runErr.Error())
		r.logger.Warn("agentd turn failed", "run", next.runID, "error", runErr)
	default:
		_ = writer.terminal(entries, TerminalCompleted, "", "")
		r.logger.Info("agentd turn completed", "run", next.runID,
			"conversation", next.conversationID, "characters", len(answer))
	}
}

// runTurn is the agent loop: provider, tools, repeat — bounded rounds, each
// tool round and each assistant segment checkpointed out as it lands. The
// transcript entries are the desktop's shape, so the gateway's answer
// extraction (assistant entries after the last user entry) reads the final
// answer with zero special cases.
func (r *Runner) runTurn(ctx context.Context, next job, entries *[]Entry, writer *ingress) (string, error) {
	entryID := 2
	system := "You are a server-side agent running inside a sandboxed working directory. " +
		"Answer the request directly and completely; use the tools when the answer needs " +
		"files, commands or the network. The requester cannot be asked questions — " +
		"produce the best complete answer you can." + PromptSection(r.tools.Skills())
	messages := []Message{
		{Role: "system", Content: system},
		{Role: "user", Content: next.prompt},
	}
	tools := r.tools.Tools()
	var answers []string

	for round := 0; round < r.cfg.MaxRounds; round++ {
		completion, err := r.provider.Complete(ctx, messages, tools)
		if err != nil {
			return strings.Join(answers, "\n\n"), fmt.Errorf("round %d: %w", round+1, err)
		}
		if completion.Text != "" {
			answers = append(answers, completion.Text)
			*entries = append(*entries, Entry{
				ID:   fmt.Sprintf("a%d", entryID),
				Kind: KindAssistant,
				Text: completion.Text,
			})
			entryID++
			if err := writer.checkpoint(*entries); err != nil {
				return strings.Join(answers, "\n\n"), err
			}
		}
		if len(completion.ToolCalls) == 0 || ctx.Err() != nil {
			return strings.Join(answers, "\n\n"), nil
		}

		// Record the assistant's tool request, then execute and record each
		// call. A failed tool is a result the model sees and can route
		// around — the turn continues.
		assistant := Message{Role: "assistant", Content: completion.Text}
		assistant.ToolCalls = append(assistant.ToolCalls, completion.ToolCalls...)
		messages = append(messages, assistant)

		for _, call := range completion.ToolCalls {
			result := r.executeTool(ctx, call, &entryID, entries, writer)
			messages = append(messages, Message{
				Role:       "tool",
				ToolCallID: call.ID,
				Content:    result,
			})
		}
	}
	// The round bound is a turn-ending condition the gateway sees as a
	// normal completion: the transcript holds everything the turn did.
	return strings.Join(answers, "\n\n"), nil
}

// executeTool resolves and runs one tool call, checkpointing the transcript
// around it, and returns the result string for the model.
func (r *Runner) executeTool(ctx context.Context, call ToolCall, entryID *int, entries *[]Entry, writer *ingress) string {
	name := strings.TrimSpace(call.Function.Name)
	arguments := map[string]any{}
	if strings.TrimSpace(call.Function.Arguments) != "" {
		if err := decodeJSON(call.Function.Arguments, &arguments); err != nil {
			return fmt.Sprintf("tool %q: arguments were not valid JSON: %v", name, err)
		}
	}
	*entries = append(*entries, Entry{
		ID:   fmt.Sprintf("t%d", *entryID),
		Kind: KindToolCall,
		Text: fmt.Sprintf("%s(%s)", name, oneLine(call.Function.Arguments, 200)),
	})
	*entryID++

	var tool *Tool
	for _, candidate := range r.tools.Tools() {
		if candidate.Name == name {
			chosen := candidate
			tool = &chosen
			break
		}
	}
	var result string
	switch tool {
	case nil:
		result = fmt.Sprintf("tool %q is not available on this worker", name)
	default:
		output, err := tool.Run(ctx, arguments)
		if err != nil {
			result = "error: " + err.Error()
		} else {
			result = output
		}
	}
	*entries = append(*entries, Entry{
		ID:   fmt.Sprintf("r%d", *entryID),
		Kind: KindToolResult,
		Text: oneLine(result, 512),
	})
	*entryID++
	if err := writer.checkpoint(*entries); err != nil {
		r.logger.Warn("agentd checkpoint after a tool round failed", "error", err)
	}
	return result
}

// CancelConversation stops the live run of one conversation. If none is live
// the cancel is a no-op — the gateway's own cancel path is idempotent.
func (r *Runner) CancelConversation(conversationID string) {
	conversationID = strings.TrimSpace(conversationID)
	r.mu.Lock()
	cancel := r.byConversation[conversationID]
	r.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

// DropAll cancels every live run with a reason — used when the connection to
// the gateway is lost. Runs whose terminal cannot be delivered are left to
// the gateway's honest timeout failure; the local context cancellation stops
// the work, which is the part that matters (a departed listener must not
// keep burning this worker's provider quota).
func (r *Runner) DropAll(reason string) {
	r.mu.Lock()
	cancels := make([]context.CancelFunc, 0, len(r.byConversation))
	for conversationID, cancel := range r.byConversation {
		cancels = append(cancels, cancel)
		delete(r.byConversation, conversationID)
	}
	r.mu.Unlock()
	for _, cancel := range cancels {
		cancel()
	}
	if len(cancels) > 0 {
		r.logger.Warn("agentd dropped live runs", "count", len(cancels), "reason", reason)
	}
}

// ActiveRuns reports the number of executing turns, for status events.
func (r *Runner) ActiveRuns() int { return int(r.activeRuns.Load()) }
