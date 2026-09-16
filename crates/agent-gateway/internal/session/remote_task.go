package session

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

// Remote task execution reuses the ordinary chat machinery rather than adding a
// parallel execution surface: the edge submits a chat command to the target
// desktop exactly as the browser does, the desktop's TypeScript runtime runs a
// real tool-using agent turn, and the result comes back through the existing
// reliable chat ingress. The desktop therefore needs no execution surface of its
// own, and every invariant of the chat pipeline (reliable terminal projection,
// run settling, subscription cleanup) applies unchanged.
//
// This file owns only the orchestration: ids, registration, subscription, the
// wait, and the extraction of the assistant's text from the terminal projection.
// It deliberately knows nothing about the mesh — the caller maps the result onto
// its own error vocabulary.

// Id prefixes for the synthetic conversation a remote task runs in. They keep a
// remote task unmistakable in logs and in the conversation stream, and keep its
// ids from colliding with browser-issued commands on the same agent.
const (
	RemoteTaskRunPrefix          = "remote-task-run-"
	RemoteTaskConversationPrefix = "remote-task-conv-"
	RemoteTaskRequestPrefix      = "remote-task-req-"
)

// RemoteTaskCancelCommandType is the wire string that cancels a run.
//
// Exported and pinned by a test because remote_task.go builds this command
// itself rather than calling chatcmd (see remoteTaskCancelCommand for why), so
// the value is duplicated and the test is what stops the two copies drifting.
const RemoteTaskCancelCommandType = "chat.cancel"

// Failure codes returned in RemoteTaskResult.ErrorCode.
//
// These are the codes internal/mesh/invoke.go already understands: the invoker
// hands them to the mesh untouched and mesh.invokeResponseCode maps them onto
// the mesh's own code table. Reusing that vocabulary is deliberate — inventing
// new spellings would silently collapse to 5001 on the peer.
const (
	RemoteTaskCodeTimeout        = "timeout"
	RemoteTaskCodeUnsupported    = "unsupported_operation"
	RemoteTaskCodeDenied         = "denied"
	RemoteTaskCodeInvalidRequest = "invalid_request"
	RemoteTaskCodeAgentOffline   = "agent_offline"
	RemoteTaskCodeOverloaded     = "overloaded"
	// RemoteTaskCodeInternal marks a gateway-side failure the agent did not
	// report a code for. The mesh maps it to INTERNAL_ERROR rather than guessing
	// a more specific, and possibly wrong, retryability.
	RemoteTaskCodeInternal = "internal"
)

// remoteTaskOutputMaxBytes bounds the assistant text returned to a remote peer.
//
// The mesh envelope budget is 1 MiB by default (mesh.DefaultMaxEnvelopeBytes),
// and the reply carries this text inside a JSON object inside another envelope.
// Half the budget leaves ample room for that framing while keeping a runaway
// projection from producing a reply too large to deliver. Truncation is explicit
// in the returned text so a caller is never handed a silent cut.
const remoteTaskOutputMaxBytes = 512 << 10

// remoteTaskMaxResubscribes bounds how many times an overflowing subscription is
// re-established before the task is abandoned. In practice a reader this fast
// never overflows; the bound exists so a pathology cannot spin forever.
const remoteTaskMaxResubscribes = 4

// remoteTaskCancelTimeout bounds the best-effort cancel sent when this edge stops
// waiting. Short because the caller has already given up: a cancel that hangs
// would delay the peer's refusal for no benefit.
const remoteTaskCancelTimeout = 5 * time.Second

// RemoteTaskResult is the outcome of one task run on a desktop agent.
type RemoteTaskResult struct {
	OK           bool
	Output       json.RawMessage
	ErrorCode    string
	ErrorMessage string
	// ConversationID is the conversation the run happened in. The caller
	// persists it so a follow-up — the answer to a question the agent asked —
	// resumes in place instead of starting a context-free second conversation.
	ConversationID string
}

// SubmitRemoteTask runs one task on a desktop agent and returns the assistant's
// text once the run settles.
//
// A transport failure (the agent is not attached, the caller's context expires,
// the send cannot complete) is returned as an error so the caller can classify
// it; a run that actually reached a terminal is returned as a RemoteTaskResult,
// successes and refusals alike. Every exit path unsubscribes and settles the
// command bookkeeping, so a long-running edge does not accumulate subscriptions
// or run records for remote tasks that never completed.
func (m *Manager) SubmitRemoteTask(ctx context.Context, agentID, prompt string) (RemoteTaskResult, error) {
	return m.SubmitRemoteTaskProgress(ctx, agentID, prompt, nil)
}

// SubmitRemoteTaskProgress is SubmitRemoteTask with a live view of the run.
//
// onDelta receives the GROWTH of the assistant's text each time the desktop
// commits a conversation snapshot, so a caller that stays connected can watch
// the answer build instead of waiting for the whole terminal. The deltas are
// derived from the same projections the terminal result comes from — there is
// no second channel to the desktop — and append-only growth is the only thing
// emitted: a projection that rewrote already-delivered text (a retracted entry,
// an error placeholder swap) yields no delta rather than a duplicated one. The
// terminal result stays the canonical text; the delta stream is a progress view.
func (m *Manager) SubmitRemoteTaskProgress(
	ctx context.Context,
	agentID string,
	prompt string,
	onDelta func(delta string),
) (RemoteTaskResult, error) {
	return m.submitRemoteTask(ctx, agentID, "", prompt, onDelta)
}

// SubmitRemoteTaskInConversation is SubmitRemoteTaskProgress in an existing
// conversation — the resume path for an answered input-required task. The
// desktop's chat log replays from the start and the accumulator filters by the
// new run id, so prior turns are visible to the agent but never double-counted
// as this run's output.
func (m *Manager) SubmitRemoteTaskInConversation(
	ctx context.Context,
	agentID string,
	conversationID string,
	prompt string,
	onDelta func(delta string),
) (RemoteTaskResult, error) {
	return m.submitRemoteTask(ctx, agentID, conversationID, prompt, onDelta)
}

// submitRemoteTask is the one implementation: an empty conversationID mints a
// fresh conversation (the ordinary path), a provided one resumes it.
func (m *Manager) submitRemoteTask(
	ctx context.Context,
	agentID string,
	conversationID string,
	prompt string,
	onDelta func(delta string),
) (RemoteTaskResult, error) {
	agentID = strings.TrimSpace(agentID)
	prompt = strings.TrimSpace(prompt)
	conversationID = strings.TrimSpace(conversationID)
	if agentID == "" {
		return RemoteTaskResult{}, ErrAgentOffline
	}
	if prompt == "" {
		return RemoteTaskResult{
			OK:           false,
			ErrorCode:    RemoteTaskCodeInvalidRequest,
			ErrorMessage: "a remote task requires a prompt",
		}, nil
	}
	// Fail before touching any state when the caller has already given up.
	if err := ctx.Err(); err != nil {
		return RemoteTaskResult{}, err
	}
	if !m.IsOnline(agentID) {
		return RemoteTaskResult{}, ErrAgentOffline
	}

	runID := RemoteTaskRunPrefix + uuid.NewString()
	resuming := conversationID != ""
	if conversationID == "" {
		conversationID = RemoteTaskConversationPrefix + uuid.NewString()
	}
	clientRequestID := RemoteTaskRequestPrefix + uuid.NewString()

	// A headless worker has no history of its own: every turn starts from a
	// blank slate, so a resumed conversation would otherwise continue in name
	// only. Rehydrating the prior turns into the prompt gives the run its
	// memory — the desktop needs no such help because its runtime keeps the
	// conversation itself.
	if resuming && m.AgentSupportsCapability(agentID, HeadlessWorkerCapability) {
		prompt = m.HeadlessResumePrompt(agentID, conversationID, prompt)
	}

	// Register the run before anything else so the gateway can correlate the
	// ingress that comes back. A non-empty conversation id binds the run
	// immediately (no pending draft state to reconcile).
	start := m.StartChatCommand(
		agentID,
		runID,
		conversationID,
		"",
		clientRequestID,
		[]map[string]any{remoteTaskUserMessage(prompt)},
	)
	if start.RunID == "" {
		return RemoteTaskResult{
			OK:           false,
			ErrorCode:    RemoteTaskCodeInternal,
			ErrorMessage: "the gateway could not register the remote task",
		}, nil
	}
	if start.Deduped {
		// The generated request id collided with an existing command. Do not run
		// someone else's command under this task's name; refuse and let the
		// generated-id collision (vanishingly unlikely) surface as a retry.
		m.FailChatCommand(start.AgentID, start.RunID, RemoteTaskCodeInvalidRequest,
			"the remote task id collided with an existing command")
		return RemoteTaskResult{
			OK:           false,
			ErrorCode:    RemoteTaskCodeInvalidRequest,
			ErrorMessage: "the remote task could not be uniquely registered",
		}, nil
	}
	runID = start.RunID
	conversationID = start.ConversationID

	// Deliver first, then subscribe. The subscription replays the conversation
	// log, so a run that settles before the subscribe is still read in full —
	// there is no window where a fast terminal can be missed.
	envelope := remoteTaskCommandEnvelope(runID, conversationID, clientRequestID, prompt)
	if err := m.SendToAgentContext(ctx, agentID, envelope); err != nil {
		m.FailChatCommand(agentID, runID, remoteTaskDeliveryErrorCode(err),
			"the remote task could not be delivered to the desktop agent")
		return RemoteTaskResult{}, err
	}

	outcome, waitErr := m.awaitRemoteTask(ctx, agentID, runID, conversationID, onDelta)

	// When the run never reached a terminal this call consumed, settle the
	// bookkeeping so it does not linger. awaitRemoteTask always releases its own
	// subscription, including on the error paths.
	if waitErr != nil {
		// Tell the desktop to stop before settling our own bookkeeping. A peer
		// that gave up must not leave a turn running on someone's machine: it
		// would keep spending that user's provider quota on behalf of a caller who
		// is no longer listening, and a peer could repeat that deliberately.
		m.cancelRemoteTask(agentID, conversationID, runID)
		m.FailChatCommand(agentID, runID, RemoteTaskCodeTimeout,
			"the remote task did not settle before the invocation deadline")
		return RemoteTaskResult{}, waitErr
	}

	result := outcome.result()
	result.ConversationID = conversationID
	return result, nil
}

// cancelRemoteTask asks the desktop to stop a run this edge has given up on.
//
// Best-effort by design, and deliberately not blocking: the caller has already
// stopped waiting and is about to answer the peer, and SendToAgentContext blocks
// until the desktop's outbound queue drains. Sending inline would therefore make
// a peer wait *longer* the moment it gave up, which is backwards. The state flip
// is synchronous because it is local bookkeeping; only the delivery is detached,
// and its context is bounded so the send cannot outlive its usefulness.
//
// It goes through the same command the browser's cancel uses, so the desktop
// takes its ordinary cancellation path (abort the in-flight turn) rather than a
// special one that only remote tasks exercise — and therefore only remote tasks
// would break.
func (m *Manager) cancelRemoteTask(agentID, conversationID, runID string) {
	agentID = strings.TrimSpace(agentID)
	conversationID = strings.TrimSpace(conversationID)
	if agentID == "" || conversationID == "" {
		return
	}

	// Flip the activity state first: the edge's own bookkeeping should agree the
	// run is going away even if the desktop never acknowledges. A run that is no
	// longer active has already finished, so there is nothing to cancel.
	cancelRunID, active := m.MarkConversationCancelling(agentID, conversationID, runID)
	if !active {
		return
	}

	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), remoteTaskCancelTimeout)
		defer cancel()
		_ = m.SendToAgentContext(ctx, agentID, &gatewayv2.GatewayEnvelope{
			RequestId: cancelRunID,
			Timestamp: time.Now().Unix(),
			Payload:   remoteTaskCancelCommand(conversationID),
		})
	}()
}

// remoteTaskCancelCommand builds the cancel command the desktop understands.
//
// This duplicates chatcmd.BuildCancelCommandPayload rather than calling it,
// because chatcmd imports handler and handler imports session — importing chatcmd
// from here is an import cycle. The duplication is two field assignments against
// an append-only wire format; if the cancel command's shape ever changes, both
// sites must change together, which is why this note exists. A test pins the
// type string so a silent drift is caught.
func remoteTaskCancelCommand(conversationID string) *gatewayv2.GatewayEnvelope_ChatCommand {
	return &gatewayv2.GatewayEnvelope_ChatCommand{
		ChatCommand: &gatewayv2.ChatCommandRequest{
			Type: RemoteTaskCancelCommandType,
			Cancel: &gatewayv2.CancelChatRequest{
				ConversationId: strings.TrimSpace(conversationID),
			},
		},
	}
}

// awaitRemoteTask waits for the run's terminal, replaying the conversation log
// and resuming an overflowing subscription without loss.
func (m *Manager) awaitRemoteTask(
	ctx context.Context,
	agentID string,
	runID string,
	conversationID string,
	onDelta func(delta string),
) (remoteTaskAccumulator, error) {
	acc := remoteTaskAccumulator{runID: runID, onDelta: onDelta}
	afterSeq := int64(0)
	for attempt := 0; attempt < remoteTaskMaxResubscribes; attempt++ {
		subscription := m.SubscribeConversationStream(agentID, conversationID, afterSeq, "")
		if subscription == nil {
			return remoteTaskAccumulator{}, errors.New("could not subscribe to the remote task conversation")
		}
		resume, err := m.drainRemoteTaskEvents(ctx, subscription, &acc, agentID, conversationID)
		subscription.Cleanup()
		if err != nil {
			return remoteTaskAccumulator{}, err
		}
		if acc.settled {
			return acc, nil
		}
		if resume <= afterSeq {
			// The subscriber overflowed but produced no new cursor: re-subscribing
			// would replay the same range forever.
			return remoteTaskAccumulator{}, errors.New("remote task conversation stream overflowed without progress")
		}
		afterSeq = resume
	}
	return remoteTaskAccumulator{}, errors.New("remote task conversation stream overflowed repeatedly")
}

// drainRemoteTaskEvents consumes replay then live events until the run settles,
// the context ends, or the subscription overflows. It returns the highest seq
// observed so an overflowed reader can resume from there.
func (m *Manager) drainRemoteTaskEvents(
	ctx context.Context,
	subscription *ConversationSubscription,
	acc *remoteTaskAccumulator,
	agentID string,
	conversationID string,
) (int64, error) {
	for _, event := range subscription.Events {
		acc.observe(event)
	}
	if acc.settled {
		return acc.lastSeq, nil
	}

	for {
		select {
		case <-ctx.Done():
			// A terminal may have been committed between the last delivery and the
			// cancellation. ChatCommandSettled tells us whether the run ever left
			// the queued phase; only then can a terminal exist to recover.
			if m.ChatCommandSettled(agentID, acc.runID) {
				if recovered, ok := m.replayRemoteTaskTerminal(agentID, conversationID, acc.runID); ok {
					*acc = recovered
					return acc.lastSeq, nil
				}
			}
			return 0, ctx.Err()
		case event, ok := <-subscription.EventCh:
			if !ok {
				// Closed without a terminal: the subscriber overflowed.
				resume := acc.lastSeq
				if subscription.LatestSeq > resume {
					resume = subscription.LatestSeq
				}
				return resume, nil
			}
			acc.observe(event)
			if acc.settled {
				return acc.lastSeq, nil
			}
		}
	}
}

// replayRemoteTaskTerminal re-reads the conversation log for a terminal that
// landed after the live subscription stopped delivering. Bounded and
// non-blocking: it observes only what is already committed.
func (m *Manager) replayRemoteTaskTerminal(
	agentID string,
	conversationID string,
	runID string,
) (remoteTaskAccumulator, bool) {
	acc := remoteTaskAccumulator{runID: runID}
	subscription := m.SubscribeConversationStream(agentID, conversationID, 0, "")
	if subscription == nil {
		return acc, false
	}
	defer subscription.Cleanup()
	for _, event := range subscription.Events {
		acc.observe(event)
	}
	return acc, acc.settled
}

// remoteTaskAccumulator folds the conversation events of one run into the pieces
// the result needs: the latest content projection and the terminal verdict.
type remoteTaskAccumulator struct {
	runID string

	entries    string
	status     string
	errorCode  string
	errMessage string
	settled    bool
	lastSeq    int64
	// onDelta, when set, receives each snapshot's assistant-text growth.
	onDelta  func(delta string)
	streamer remoteTaskDeltaStream
}

// remoteTaskDeltaStream turns successive conversation snapshots into the
// growth of the assistant's text, so a live listener can be fed deltas instead
// of whole projections. Append-only by policy: a projection that rewrote
// already-delivered text yields no delta rather than a duplicated one — the
// terminal result is the canonical text, and the delta stream is a progress
// view. Pure, so the growth rule is testable without a conversation.
type remoteTaskDeltaStream struct {
	prev string
}

func (s *remoteTaskDeltaStream) delta(current string) string {
	defer func() { s.prev = current }()
	if current == "" {
		return ""
	}
	if strings.HasPrefix(current, s.prev) {
		return current[len(s.prev):]
	}
	// A rewrite, not a growth. Swallow it and re-anchor: the listener's view
	// falls behind until the terminal result replaces it wholesale.
	return ""
}

func (a *remoteTaskAccumulator) observe(event *ConversationEvent) {
	if event == nil {
		return
	}
	if event.Seq > a.lastSeq {
		a.lastSeq = event.Seq
	}
	if event.RunID != a.runID {
		return
	}
	switch event.Type {
	case StreamEventContentSnapshot, StreamEventSnapshot:
		raw, _ := event.Payload["entries_json"].(string)
		raw = strings.TrimSpace(raw)
		if raw == "" {
			return
		}
		// A degraded (oversized) projection is relayed as "[]" with the real
		// content withheld. Prefer the newest meaningful projection, but keep a
		// placeholder if that is all there is.
		if raw != "[]" || a.entries == "" {
			a.entries = raw
		}
		// The live view: each meaningful snapshot's assistant-text growth is
		// handed to the delta listener, if there is one, after the entries are
		// recorded (so a terminal snapshot always dominates the stream).
		if a.onDelta != nil && raw != "[]" {
			if text, err := extractRemoteTaskText(raw); err == nil && text != "" {
				if delta := a.streamer.delta(text); delta != "" {
					a.onDelta(delta)
				}
			}
		}
	case StreamEventRunFinished:
		a.settled = true
		a.status, _ = event.Payload["status"].(string)
		a.errorCode, _ = event.Payload["error_code"].(string)
		a.errMessage, _ = event.Payload["message"].(string)
	}
}

// result converts the settled run into the caller-facing outcome.
func (a *remoteTaskAccumulator) result() RemoteTaskResult {
	status := strings.ToLower(strings.TrimSpace(a.status))
	if status != "completed" {
		code, message := remoteTaskFailure(status, a.errorCode, a.errMessage)
		return RemoteTaskResult{OK: false, ErrorCode: code, ErrorMessage: message}
	}

	text, err := extractRemoteTaskText(a.entries)
	if err != nil {
		// The projection was already validated at ingress (it must be a JSON
		// array), so this is a gateway-side surprise, not a caller error.
		return RemoteTaskResult{
			OK:           false,
			ErrorCode:    RemoteTaskCodeInternal,
			ErrorMessage: "the task result could not be decoded",
		}
	}
	output, err := json.Marshal(map[string]string{"text": capRemoteTaskOutput(text)})
	if err != nil {
		return RemoteTaskResult{
			OK:           false,
			ErrorCode:    RemoteTaskCodeInternal,
			ErrorMessage: "the task result could not be encoded",
		}
	}
	return RemoteTaskResult{OK: true, Output: output}
}

// remoteTaskFailure maps a non-completed terminal onto the invoke vocabulary.
//
// The terminal's own error code is preferred, because the desktop knows why it
// failed; the status is the fallback for a terminal that carried no code.
func remoteTaskFailure(status, code, message string) (string, string) {
	code = strings.ToLower(strings.TrimSpace(code))
	message = strings.TrimSpace(message)
	if message == "" {
		switch status {
		case "cancelled":
			message = "the desktop agent cancelled the task"
		default:
			message = "the desktop agent could not complete the task"
		}
	}

	switch code {
	case "agent_offline", "agent_unavailable", "offline":
		return RemoteTaskCodeAgentOffline, message
	case "timeout", "startup_timeout", "cancel_timeout", "stale_run", "desktop_run_lost":
		return RemoteTaskCodeTimeout, message
	case "unsupported_operation", "skill_not_found", "unsupported", "unsupported_task":
		return RemoteTaskCodeUnsupported, message
	case "denied", "governance_denied", "forbidden":
		return RemoteTaskCodeDenied, message
	case "invalid_request", "invalid":
		return RemoteTaskCodeInvalidRequest, message
	case "overloaded", "busy":
		return RemoteTaskCodeOverloaded, message
	}
	if status == "cancelled" {
		// A cancellation is transient from the peer's point of view: the run held
		// no terminal answer, so the caller may reasonably ask again.
		return RemoteTaskCodeTimeout, message
	}
	return RemoteTaskCodeInternal, message
}

// extractRemoteTaskText pulls the assistant's textual output out of a run's
// terminal projection.
//
// Projection entries are the browser's chat entries (see the ChatEntry contract
// consumed by web/src/lib/chat/transcript/transcriptStore.ts): objects with id,
// kind and text. Only kind=="assistant" carries the model's answer; entries whose
// id contains ":err:" are error placeholders the transcript reducer stores under
// the assistant kind, so they are excluded. Multiple assistant entries (one per
// tool-use round) are joined in order.
//
// The extraction is anchored at the LAST user entry: everything the assistant
// said since it was last spoken to is the run's answer, and everything before it
// is prior turns' context. That distinction did not matter when one task meant
// one conversation, but an answered input-required task resumes the SAME
// conversation, and its projection replays the earlier turns too — without the
// anchor, the resumed answer would arrive with the old question prepended. Tool
// results are their own kind ("tool_result"), never "user", so a tool-using
// round cannot move the anchor mid-answer.
func extractRemoteTaskText(entriesJSON string) (string, error) {
	trimmed := strings.TrimSpace(entriesJSON)
	if trimmed == "" || trimmed == "[]" {
		return "", nil
	}
	var entries []struct {
		ID   string `json:"id"`
		Kind string `json:"kind"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal([]byte(trimmed), &entries); err != nil {
		return "", err
	}
	lastUser := -1
	for index, entry := range entries {
		if strings.EqualFold(strings.TrimSpace(entry.Kind), "user") {
			lastUser = index
		}
	}
	parts := make([]string, 0, len(entries))
	for _, entry := range entries[lastUser+1:] {
		if !strings.EqualFold(strings.TrimSpace(entry.Kind), "assistant") {
			continue
		}
		if strings.Contains(entry.ID, ":err:") {
			continue
		}
		if strings.TrimSpace(entry.Text) == "" {
			continue
		}
		parts = append(parts, entry.Text)
	}
	return strings.Join(parts, "\n\n"), nil
}

// capRemoteTaskOutput truncates on a rune boundary and says so in the text, so
// an oversized answer degrades to a delivered partial rather than an
// undeliverable envelope.
func capRemoteTaskOutput(text string) string {
	if len(text) <= remoteTaskOutputMaxBytes {
		return text
	}
	cut := remoteTaskOutputMaxBytes
	for cut > 0 && !utf8.RuneStart(text[cut]) {
		cut--
	}
	return text[:cut] + "\n\n[truncated: the task output exceeded the gateway's " +
		strconv.Itoa(remoteTaskOutputMaxBytes) + "-byte delivery limit]"
}

// remoteTaskDeliveryErrorCode classifies a failed send for the gateway's own
// command bookkeeping. It is not the peer-facing code — the mesh classifies the
// returned error — but an abandoned command should still be settled with an
// honest reason.
func remoteTaskDeliveryErrorCode(err error) string {
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		return RemoteTaskCodeTimeout
	}
	return RemoteTaskCodeAgentOffline
}

// remoteTaskUserMessage mirrors the browser's accepted-command payload so the
// run appears in the conversation log exactly as a normal submitted prompt does.
func remoteTaskUserMessage(prompt string) map[string]any {
	return map[string]any{
		"type":                     "user_message",
		"message":                  prompt,
		"uploaded_files":           []any{},
		"referenced_conversations": []any{},
		"execution_mode":           "",
		"workdir":                  "",
		"command_safety_mode":      "",
		"runtime_controls":         nil,
		"selected_model":           nil,
	}
}

// remoteTaskCommandEnvelope builds the chat.submit the desktop runtime already
// knows how to serve, byte-for-byte the shape the browser connection sends.
func remoteTaskCommandEnvelope(runID, conversationID, clientRequestID, prompt string) *gatewayv2.GatewayEnvelope {
	return &gatewayv2.GatewayEnvelope{
		RequestId: runID,
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv2.GatewayEnvelope_ChatCommand{
			ChatCommand: &gatewayv2.ChatCommandRequest{
				Type: "chat.submit",
				Request: &gatewayv2.ChatRequest{
					ConversationId:  conversationID,
					ClientRequestId: clientRequestID,
					Message:         prompt,
					// "auto" is the browser's default: run now, queue politely if
					// the desktop is already busy rather than interrupting a human.
					QueuePolicy: "auto",
				},
			},
		},
	}
}
