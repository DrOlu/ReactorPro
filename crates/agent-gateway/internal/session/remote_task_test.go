package session

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

const remoteTaskTestAgentID = "remote-task-agent"

// remoteTaskTestManager builds a manager with one attached desktop agent and
// returns both so a test can read the chat command the manager delivers.
func remoteTaskTestManager(t *testing.T) (*Manager, *AgentSession) {
	t.Helper()
	manager := NewManager()
	agentSession := NewAgentSession(AuthSnapshot{AgentID: remoteTaskTestAgentID, SessionID: "session-1"})
	manager.SetSession(agentSession)
	t.Cleanup(func() { manager.ClearSession(agentSession) })
	return manager, agentSession
}

// delivery is the chat command the manager handed to the fake desktop.
type remoteTaskDelivery struct {
	runID           string
	conversationID  string
	clientRequestID string
	prompt          string
}

// receiveRemoteTaskDelivery reads (and acks) the next chat command so the
// sender's SendToAgentContext returns.
func receiveRemoteTaskDelivery(t *testing.T, agentSession *AgentSession) remoteTaskDelivery {
	t.Helper()
	select {
	case outbound := <-agentSession.Outbound():
		outbound.Ack(nil)
		envelope := outbound.GatewayEnvelope
		command := envelope.GetChatCommand()
		if command == nil {
			t.Fatalf("delivered envelope = %T, want a chat command", envelope.GetPayload())
		}
		if command.GetType() != "chat.submit" {
			t.Fatalf("chat command type = %q, want chat.submit", command.GetType())
		}
		request := command.GetRequest()
		if request == nil {
			t.Fatal("chat command carried no request")
		}
		return remoteTaskDelivery{
			runID:           envelope.GetRequestId(),
			conversationID:  request.GetConversationId(),
			clientRequestID: request.GetClientRequestId(),
			prompt:          request.GetMessage(),
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the manager never delivered a chat command to the agent")
		return remoteTaskDelivery{}
	}
}

// completeRemoteTask feeds the fake desktop's reliable terminal projection and
// settles the run.
func completeRemoteTask(t *testing.T, manager *Manager, delivery remoteTaskDelivery, state string, entriesJSON string) {
	t.Helper()
	terminal := reliableIngressTerminal(reliableIngressProjection(t, entriesJSON), 0, state)
	manager.ingestChatIngressBatch(remoteTaskTestAgentID, &gatewayv2.ChatIngressBatch{
		RunId:          delivery.runID,
		ConversationId: delivery.conversationID,
		FirstSeq:       1,
		Records:        []*gatewayv2.ChatIngressRecord{terminal},
	})
}

// remoteTaskSubscriberCount reads the stream store directly to prove a path
// released its subscription rather than merely stopping reading from it.
// assertRemoteTaskCancelSent proves the desktop was told to stop.
//
// This is the assertion that stops a peer which gives up from leaving a turn
// running on someone's machine, spending that user's provider quota for a caller
// who is no longer listening. Without it the edge would settle its own
// bookkeeping and the desktop would keep working.
func assertRemoteTaskCancelSent(t *testing.T, agentSession *AgentSession, wantConversationID string) {
	t.Helper()
	deadline := time.After(2 * time.Second)
	for {
		select {
		case outbound := <-agentSession.Outbound():
			outbound.Ack(nil)
			command := outbound.GetChatCommand()
			if command == nil || command.GetType() != RemoteTaskCancelCommandType {
				continue
			}
			if got := command.GetCancel().GetConversationId(); got != wantConversationID {
				t.Fatalf("cancel target = %q, want %q", got, wantConversationID)
			}
			return
		case <-deadline:
			t.Fatal("the desktop was never told to cancel; the abandoned turn would keep running")
		}
	}
}

func remoteTaskSubscriberCount(manager *Manager, conversationID string) int {
	store := manager.convStreams
	store.mu.Lock()
	defer store.mu.Unlock()
	stream := store.streams[conversationStreamKey(remoteTaskTestAgentID, conversationID)]
	if stream == nil {
		return 0
	}
	return len(stream.subscribers)
}

func TestSubmitRemoteTaskHappyPath(t *testing.T) {
	manager, agentSession := remoteTaskTestManager(t)

	type outcome struct {
		result RemoteTaskResult
		err    error
	}
	done := make(chan outcome, 1)
	go func() {
		result, err := manager.SubmitRemoteTask(context.Background(), remoteTaskTestAgentID, "summarise the report")
		done <- outcome{result: result, err: err}
	}()

	delivery := receiveRemoteTaskDelivery(t, agentSession)
	if delivery.prompt != "summarise the report" {
		t.Fatalf("delivered prompt = %q, want the task prompt", delivery.prompt)
	}
	if !strings.HasPrefix(delivery.runID, RemoteTaskRunPrefix) ||
		!strings.HasPrefix(delivery.conversationID, RemoteTaskConversationPrefix) ||
		!strings.HasPrefix(delivery.clientRequestID, RemoteTaskRequestPrefix) {
		t.Fatalf("delivery ids = %+v, want the remote-task namespaced ids", delivery)
	}

	completeRemoteTask(t, manager, delivery, "completed",
		`[{"id":"u1","kind":"user","text":"summarise the report"},`+
			`{"id":"t1","kind":"thinking","text":"internal"},`+
			`{"id":"a1","kind":"assistant","text":"the report is fine"}]`)

	select {
	case got := <-done:
		if got.err != nil {
			t.Fatalf("SubmitRemoteTask: %v", got.err)
		}
		if !got.result.OK {
			t.Fatalf("result = %+v, want OK", got.result)
		}
		if string(got.result.Output) != `{"text":"the report is fine"}` {
			t.Fatalf("output = %s, want the assistant text", got.result.Output)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("SubmitRemoteTask did not return after the run settled")
	}

	if count := remoteTaskSubscriberCount(manager, delivery.conversationID); count != 0 {
		t.Fatalf("subscription leaked: %d subscribers remain", count)
	}
}

// A tool-using turn produces more than one assistant entry; the answer is their
// concatenation, and error placeholders are not mistaken for the answer.
func TestSubmitRemoteTaskJoinsAssistantRoundsAndSkipsErrors(t *testing.T) {
	manager, agentSession := remoteTaskTestManager(t)

	done := make(chan RemoteTaskResult, 1)
	go func() {
		result, _ := manager.SubmitRemoteTask(context.Background(), remoteTaskTestAgentID, "do the thing")
		done <- result
	}()

	delivery := receiveRemoteTaskDelivery(t, agentSession)
	completeRemoteTask(t, manager, delivery, "completed",
		`[{"id":"a1","kind":"assistant","text":"checking"},`+
			`{"id":"tr1","kind":"tool_result","text":"ignored","toolResult":{}},`+
			`{"id":"a1:err:0:abc","kind":"assistant","text":"boom"},`+
			`{"id":"a2","kind":"assistant","text":"all done"}]`)

	result := <-done
	if !result.OK {
		t.Fatalf("result = %+v, want OK", result)
	}
	if string(result.Output) != `{"text":"checking\n\nall done"}` {
		t.Fatalf("output = %s, want the joined assistant rounds", result.Output)
	}
	if count := remoteTaskSubscriberCount(manager, delivery.conversationID); count != 0 {
		t.Fatalf("subscription leaked: %d subscribers remain", count)
	}
}

// A completed run whose projection is empty still succeeds: the agent may have
// answered with tool calls only.
func TestSubmitRemoteTaskCompletedWithEmptyProjection(t *testing.T) {
	manager, agentSession := remoteTaskTestManager(t)

	done := make(chan RemoteTaskResult, 1)
	go func() {
		result, _ := manager.SubmitRemoteTask(context.Background(), remoteTaskTestAgentID, "noop")
		done <- result
	}()

	delivery := receiveRemoteTaskDelivery(t, agentSession)
	completeRemoteTask(t, manager, delivery, "completed", `[]`)

	result := <-done
	if !result.OK || string(result.Output) != `{"text":""}` {
		t.Fatalf("result = %+v, want an empty successful result", result)
	}
}

func TestSubmitRemoteTaskTimeoutCleansUp(t *testing.T) {
	manager, agentSession := remoteTaskTestManager(t)

	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()

	done := make(chan error, 1)
	go func() {
		_, err := manager.SubmitRemoteTask(ctx, remoteTaskTestAgentID, "wait forever")
		done <- err
	}()

	delivery := receiveRemoteTaskDelivery(t, agentSession)

	select {
	case err := <-done:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("error = %v, want context.DeadlineExceeded", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("SubmitRemoteTask ignored its deadline")
	}

	if count := remoteTaskSubscriberCount(manager, delivery.conversationID); count != 0 {
		t.Fatalf("subscription leaked on timeout: %d subscribers remain", count)
	}
	// The abandoned run must not linger as active bookkeeping.
	if !manager.ChatCommandSettled(remoteTaskTestAgentID, delivery.runID) {
		t.Fatal("the timed-out run was not settled")
	}
	// Giving up must stop the work, not just stop waiting for it.
	assertRemoteTaskCancelSent(t, agentSession, delivery.conversationID)
}

func TestSubmitRemoteTaskCancellationCleansUp(t *testing.T) {
	manager, agentSession := remoteTaskTestManager(t)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := manager.SubmitRemoteTask(ctx, remoteTaskTestAgentID, "cancel me")
		done <- err
	}()

	delivery := receiveRemoteTaskDelivery(t, agentSession)
	cancel()

	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("error = %v, want context.Canceled", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("SubmitRemoteTask ignored cancellation")
	}

	if count := remoteTaskSubscriberCount(manager, delivery.conversationID); count != 0 {
		t.Fatalf("subscription leaked on cancellation: %d subscribers remain", count)
	}
	assertRemoteTaskCancelSent(t, agentSession, delivery.conversationID)
}

func TestSubmitRemoteTaskAgentOffline(t *testing.T) {
	manager := NewManager()
	_, err := manager.SubmitRemoteTask(context.Background(), "not-attached", "hello")
	if !errors.Is(err, ErrAgentOffline) {
		t.Fatalf("error = %v, want ErrAgentOffline", err)
	}
}

func TestSubmitRemoteTaskDeliveryFailureCleansUp(t *testing.T) {
	manager, agentSession := remoteTaskTestManager(t)

	done := make(chan error, 1)
	go func() {
		_, err := manager.SubmitRemoteTask(context.Background(), remoteTaskTestAgentID, "hello")
		done <- err
	}()

	// Read the command without acking it, then drop the link: the pending send
	// fails rather than the run ever starting.
	var conversationID string
	select {
	case outbound := <-agentSession.Outbound():
		conversationID = outbound.GetChatCommand().GetRequest().GetConversationId()
	case <-time.After(2 * time.Second):
		t.Fatal("the manager never delivered a chat command to the agent")
	}
	agentSession.Close()

	select {
	case err := <-done:
		if !errors.Is(err, ErrAgentOffline) {
			t.Fatalf("error = %v, want ErrAgentOffline", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("SubmitRemoteTask did not fail when the agent went offline")
	}

	if count := remoteTaskSubscriberCount(manager, conversationID); count != 0 {
		t.Fatalf("subscription leaked on delivery failure: %d subscribers remain", count)
	}
}

func TestSubmitRemoteTaskMapsDesktopFailureCodes(t *testing.T) {
	cases := []struct {
		name      string
		state     string
		errorCode string
		wantCode  string
	}{
		{name: "agent offline", state: "failed", errorCode: "agent_offline", wantCode: RemoteTaskCodeAgentOffline},
		{name: "run lost", state: "failed", errorCode: "desktop_run_lost", wantCode: RemoteTaskCodeTimeout},
		{name: "unsupported", state: "failed", errorCode: "unsupported_operation", wantCode: RemoteTaskCodeUnsupported},
		{name: "denied", state: "failed", errorCode: "denied", wantCode: RemoteTaskCodeDenied},
		{name: "invalid", state: "failed", errorCode: "invalid_request", wantCode: RemoteTaskCodeInvalidRequest},
		{name: "cancelled", state: "cancelled", errorCode: "", wantCode: RemoteTaskCodeTimeout},
		{name: "unclassified failure", state: "failed", errorCode: "", wantCode: RemoteTaskCodeInternal},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			manager, agentSession := remoteTaskTestManager(t)

			done := make(chan RemoteTaskResult, 1)
			go func() {
				result, _ := manager.SubmitRemoteTask(context.Background(), remoteTaskTestAgentID, "fail please")
				done <- result
			}()

			delivery := receiveRemoteTaskDelivery(t, agentSession)
			projection := reliableIngressProjection(t, `[]`)
			terminal := reliableIngressTerminal(projection, 0, testCase.state)
			if testCase.errorCode != "" {
				terminal.GetTerminal().ErrorCode = testCase.errorCode
				terminal.GetTerminal().ErrorMessage = "the desktop said no"
			}
			manager.ingestChatIngressBatch(remoteTaskTestAgentID, &gatewayv2.ChatIngressBatch{
				RunId:          delivery.runID,
				ConversationId: delivery.conversationID,
				FirstSeq:       1,
				Records:        []*gatewayv2.ChatIngressRecord{terminal},
			})

			result := <-done
			if result.OK {
				t.Fatalf("result = %+v, want a failure", result)
			}
			if result.ErrorCode != testCase.wantCode {
				t.Fatalf("error code = %q, want %q", result.ErrorCode, testCase.wantCode)
			}
			if result.ErrorMessage == "" {
				t.Fatal("a failure should carry a message for the peer")
			}
			if count := remoteTaskSubscriberCount(manager, delivery.conversationID); count != 0 {
				t.Fatalf("subscription leaked: %d subscribers remain", count)
			}
		})
	}
}

func TestSubmitRemoteTaskRejectsEmptyPrompt(t *testing.T) {
	manager := NewManager()
	result, err := manager.SubmitRemoteTask(context.Background(), remoteTaskTestAgentID, "   ")
	if err != nil {
		t.Fatalf("SubmitRemoteTask: %v", err)
	}
	if result.OK || result.ErrorCode != RemoteTaskCodeInvalidRequest {
		t.Fatalf("result = %+v, want invalid_request", result)
	}
}

// A projection larger than the delivery budget is truncated with a visible
// marker rather than producing a reply the mesh cannot deliver.
func TestSubmitRemoteTaskTruncatesOversizedOutput(t *testing.T) {
	manager, agentSession := remoteTaskTestManager(t)

	done := make(chan RemoteTaskResult, 1)
	go func() {
		result, _ := manager.SubmitRemoteTask(context.Background(), remoteTaskTestAgentID, "big one")
		done <- result
	}()

	delivery := receiveRemoteTaskDelivery(t, agentSession)
	huge := strings.Repeat("x", remoteTaskOutputMaxBytes+4096)
	completeRemoteTask(t, manager, delivery, "completed",
		`[{"id":"a1","kind":"assistant","text":"`+huge+`"}]`)

	result := <-done
	if !result.OK {
		t.Fatalf("result = %+v, want OK", result)
	}
	var output struct {
		Text string `json:"text"`
	}
	if err := json.Unmarshal(result.Output, &output); err != nil {
		t.Fatalf("decode output: %v", err)
	}
	if len(output.Text) > remoteTaskOutputMaxBytes+256 {
		t.Fatalf("truncated text = %d bytes, want at most the cap plus the marker", len(output.Text))
	}
	if !strings.Contains(output.Text, "[truncated:") {
		t.Fatal("an oversized answer must say it was truncated")
	}
}

// The seeded user_message is what makes the run replayable exactly like a
// browser-submitted prompt.
func TestSubmitRemoteTaskSeedsUserMessage(t *testing.T) {
	manager, agentSession := remoteTaskTestManager(t)

	done := make(chan RemoteTaskResult, 1)
	go func() {
		result, _ := manager.SubmitRemoteTask(context.Background(), remoteTaskTestAgentID, "seed me")
		done <- result
	}()

	delivery := receiveRemoteTaskDelivery(t, agentSession)
	completeRemoteTask(t, manager, delivery, "completed",
		`[{"id":"a1","kind":"assistant","text":"done"}]`)
	<-done

	subscription := manager.SubscribeConversationStream(remoteTaskTestAgentID, delivery.conversationID, 0, "")
	defer subscription.Cleanup()
	seeded := false
	for _, event := range subscription.Events {
		if event.Type == "user_message" && event.RunID == delivery.runID {
			if message, _ := event.Payload["message"].(string); message == "seed me" {
				seeded = true
			}
		}
	}
	if !seeded {
		t.Fatal("the remote task prompt was not seeded into the conversation log")
	}
}
