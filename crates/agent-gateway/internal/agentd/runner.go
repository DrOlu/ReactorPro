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
	//
	// byConversation maps a conversation to its execution slot. The slot is
	// created at submit time under the runner lock, which makes the one-run-
	// per-conversation check and the registration a single atomic step: the
	// previous shape (check at submit, register in the worker) let two rapid
	// commands both pass the check and then clobber each other's cancel func
	// in the map — two concurrent turns per conversation, each writing
	// ingress sequence numbers the other had already used.
	jobs           chan job
	byConversation map[string]*convSlot
	mu             sync.Mutex
	activeRuns     atomic.Int32
}

// convSlot is one conversation's execution slot, claimed at submit and held
// until the job's worker exits. The cancelled flag covers the queued phase:
// a cancel that lands while the job still waits in the queue is remembered,
// and the worker settles the run as cancelled without spending a provider
// call on it.
type convSlot struct {
	mu        sync.Mutex
	cancelled bool
	cancel    context.CancelFunc
}

// stop marks the slot cancelled and cancels the live run, if one is running.
// Safe to call more than once and from any goroutine.
func (s *convSlot) stop() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cancelled = true
	if s.cancel != nil {
		s.cancel()
	}
}

// job is one accepted chat command.
type job struct {
	runID           string
	conversationID  string
	clientRequestID string
	prompt          string
	slot            *convSlot
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
		byConversation: map[string]*convSlot{},
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
	// Claim the conversation here, under the same lock as the busy check, so
	// the claim cannot race a worker: two rapid commands for one conversation
	// resolve to one accepted run, not two.
	slot := &convSlot{}
	r.byConversation[conversationID] = slot
	r.mu.Unlock()

	next := job{
		runID:           runID,
		conversationID:  conversationID,
		clientRequestID: strings.TrimSpace(request.GetClientRequestId()),
		prompt:          strings.TrimSpace(request.GetMessage()),
		slot:            slot,
	}
	select {
	case r.jobs <- next:
	default:
		// A full queue is an operator-sizing problem, and refusing is the
		// honest move: the gateway fails the run as never started rather
		// than the peer waiting on a phantom. The slot must go back too, or
		// the conversation would read as busy forever.
		r.mu.Lock()
		if r.byConversation[conversationID] == slot {
			delete(r.byConversation, conversationID)
		}
		r.mu.Unlock()
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

	writer := newIngress(next.runID, next.conversationID, func(seq uint64, record *gatewayv2.ChatIngressRecord) error {
		return r.sink.SendIngress(next.runID, next.conversationID, seq, record)
	})

	// Hand the slot this run's cancel, and observe a cancel that arrived while
	// the job was still queued.
	next.slot.mu.Lock()
	cancelledWhileQueued := next.slot.cancelled
	next.slot.cancel = cancel
	next.slot.mu.Unlock()
	defer func() {
		// Release the conversation only if the map still points at this slot:
		// DropAll may have cleared it (and a newer submit re-claimed the
		// conversation) while this job waited in the queue.
		r.mu.Lock()
		if r.byConversation[next.conversationID] == next.slot {
			delete(r.byConversation, next.conversationID)
		}
		r.mu.Unlock()
		next.slot.mu.Lock()
		next.slot.cancel = nil
		next.slot.mu.Unlock()
	}()

	if cancelledWhileQueued {
		// Cancelled before the turn began: settle as cancelled without
		// spending a provider call. A lone terminal is a complete run on the
		// wire — the gateway synthesises the start — so the peer sees a clean
		// cancel instead of a watchdog timeout.
		entries := []Entry{userEntry("u1", next.prompt)}
		_ = writer.terminal(entries, TerminalCancelled, "cancelled", "the run was cancelled")
		return
	}

	r.activeRuns.Add(1)
	defer r.activeRuns.Add(-1)

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
	entries := []Entry{userEntry("u1", next.prompt)}
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
		compacted := false
		if round > 0 {
			// The context budget applies between rounds, before the next
			// provider call: the model's history is shaped, never the
			// transcript (checkpoints keep publishing the full entries).
			messages, compacted = r.compactTurnContext(next.runID, messages, writer)
		}
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
			// A compaction status that fired before this round has done its
			// job once the answer lands; clear it with the same event.
			if compacted {
				_ = writer.delta(map[string]any{
					"type":         "tool_status",
					"status":       nil,
					"isCompaction": true,
				}, r.cfg.AgentID)
			}
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

// compactTurnContext applies the within-turn context budget between rounds:
// over budget, the model-visible history is compacted mechanically (see
// context.go), the compaction is logged, and a best-effort tool_status event
// tells the live viewers what is happening — the same event the desktop's
// compaction surfaces ride, held until the round's answer lands. Under
// budget, or with the module off, this is a no-op. It returns the (possibly
// new) message list and whether a compaction fired.
func (r *Runner) compactTurnContext(runID string, messages []Message, writer *ingress) ([]Message, bool) {
	budget := contextBudgetFromConfig(r.cfg)
	if budget.maxTokens <= 0 {
		return messages, false
	}
	result := compactMessages(messages, budget)
	if result.elidedToolResults == 0 && result.droppedExchanges == 0 {
		return messages, false
	}
	r.logger.Info("agentd compacted turn context",
		"run", runID,
		"tokens_before", result.estimatedBefore,
		"tokens_after", result.estimatedAfter,
		"elided_tool_results", result.elidedToolResults,
		"dropped_exchanges", result.droppedExchanges)
	// Best-effort visibility; a failed status event never touches the turn.
	_ = writer.delta(map[string]any{
		"type":        "tool_status",
		"status":      fmt.Sprintf("Compacting turn context (%d old tool outputs elided, %d exchanges dropped)", result.elidedToolResults, result.droppedExchanges),
		"isCompaction": true,
	}, r.cfg.AgentID)
	return result.messages, true
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

// CancelConversation stops the run of one conversation — a live turn, or a
// job still waiting in the queue (which then settles as cancelled without
// running). If neither exists the cancel is a no-op — the gateway's own
// cancel path is idempotent.
func (r *Runner) CancelConversation(conversationID string) {
	conversationID = strings.TrimSpace(conversationID)
	r.mu.Lock()
	slot := r.byConversation[conversationID]
	r.mu.Unlock()
	if slot != nil {
		slot.stop()
	}
}

// DropAll cancels every live and queued run with a reason — used when the
// connection to the gateway is lost. The map is cleared so a post-reconnect
// submit can re-claim any conversation at once; queued jobs carry their slot
// by pointer, so they still see the cancellation and refuse to run. Runs
// whose terminal cannot be delivered are left to the gateway's honest timeout
// failure; the local cancellation stops the work, which is the part that
// matters (a departed listener must not keep burning this worker's provider
// quota).
func (r *Runner) DropAll(reason string) {
	r.mu.Lock()
	slots := make([]*convSlot, 0, len(r.byConversation))
	for _, slot := range r.byConversation {
		slots = append(slots, slot)
	}
	r.byConversation = map[string]*convSlot{}
	r.mu.Unlock()
	for _, slot := range slots {
		slot.stop()
	}
	if len(slots) > 0 {
		r.logger.Warn("agentd dropped live runs", "count", len(slots), "reason", reason)
	}
}

// ActiveRuns reports the number of executing turns, for status events.
func (r *Runner) ActiveRuns() int { return int(r.activeRuns.Load()) }
