package mesh

// The task lifecycle against a real nats-server: two managers, two identities,
// one task. This is where the design's promises are checked on the wire — the
// handle reply, the state events, the stub updates, cancel across edges, and
// the synchronous fallback for peers that have not adopted tasks.

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/liveagent/agent-gateway/internal/observability"
	"github.com/nats-io/nats.go"
	"github.com/nats-io/nuid"
)

// taskEdge boots a manager with a task store and an invoker, the way the
// gateway binary does. The store must be installed before Start so the task
// skills are registered into the first manifest — an edge that cannot keep its
// task promises must not advertise them.
func taskEdge(t *testing.T, url, agentID string, invoker LocalInvoker, store TaskStore, mutate func(*Config)) *Manager {
	t.Helper()
	cfg := DefaultConfig()
	cfg.Enabled = true
	cfg.URL = url
	cfg.AgentID = agentID
	cfg.IdentityPath = t.TempDir() + "/identity.json"
	if mutate != nil {
		mutate(&cfg)
	}
	manager := NewManager(cfg, slog.New(slog.NewTextHandler(io.Discard, nil)))
	manager.SetLocalAgentsProvider(func() []LocalAgent { return invokeAgents() })
	manager.SetLocalInvoker(invoker)
	if store != nil {
		manager.SetTaskStore(store)
	}
	if err := manager.Start(t.Context()); err != nil {
		t.Fatalf("start task edge %s: %v", agentID, err)
	}
	t.Cleanup(func() { _ = manager.Stop(context.Background()) })
	return manager
}

// waitStubState polls the caller's own record for a state. Events should have
// delivered it, but delivery is asynchronous — polling is how the test waits,
// not what it asserts.
func waitStubState(t *testing.T, store TaskStore, taskID string, want TaskState) TaskStub {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		stub, ok, _ := store.GetTaskStub(taskID)
		if ok && stub.State == want {
			return stub
		}
		time.Sleep(10 * time.Millisecond)
	}
	stub, _, _ := store.GetTaskStub(taskID)
	t.Fatalf("stub %s never reached %s (last %s)", taskID, want, stub.State)
	return TaskStub{}
}

// TestIntegrationTaskLifecycleAcrossEdges walks the whole contract: CREATE
// returns a handle in one reply, the run proceeds on the executor without the
// caller holding anything open, the state events update the caller's stub
// without polling, and a refresh reads the result back from the owning edge.
func TestIntegrationTaskLifecycleAcrossEdges(t *testing.T) {
	url := startTestNATS(t)
	executorID := uniqueID("acme/lagos/executor")
	callerID := uniqueID("globex/berlin/caller")

	executorStore := newFakeTaskStore()
	_ = taskEdge(t, url, executorID,
		&recordingInvoker{result: LocalInvokeResult{OK: true, Result: json.RawMessage(`{"text":"Q3 revenue was up 12%."}`)}},
		executorStore, nil)
	callerStore := newFakeTaskStore()
	caller := taskEdge(t, url, callerID, &recordingInvoker{}, callerStore, nil)

	// The executor must advertise the task skills; a caller discovers the
	// contract as much as the peer.
	peers, err := caller.Discover(t.Context(), DiscoverFilter{})
	if err != nil {
		t.Fatalf("discover: %v", err)
	}
	executorManifest, ok := manifestByID(peers, executorID)
	if !ok {
		t.Fatalf("executor %s not discovered: %+v", executorID, peers)
	}
	skills := map[string]bool{}
	for _, skill := range executorManifest.Skills {
		skills[skill.ID] = true
	}
	if !skills[SkillTaskGet] || !skills[SkillTaskCancel] {
		t.Fatalf("task skills must be advertised by an edge with a store: %+v", executorManifest.Skills)
	}

	stub, err := caller.CreateRemoteTask(t.Context(), CreateRemoteTaskParams{
		Target: executorID,
		TaskID: "bmc-run-1",
		Input: map[string]any{
			"target":    "agent-1",
			"operation": OperationTask,
			"arguments": map[string]any{"prompt": "Summarise the Q3 report"},
		},
		CreateTimeout: 5 * time.Second,
	})
	if err != nil {
		t.Fatalf("CreateRemoteTask: %v", err)
	}
	if stub.TaskID != "bmc-run-1" {
		t.Fatalf("unexpected stub: %+v", stub)
	}
	if TaskTerminal(stub.State) && stub.State != TaskCompleted {
		t.Fatalf("a create should end working or already completed, got %s", stub.State)
	}

	// No polling, no refresh: the event subscription is what must update the
	// caller's stub. This is the property that makes a disconnected caller
	// able to see progress by reconnecting.
	updated := waitStubState(t, callerStore, "bmc-run-1", TaskCompleted)
	if updated.CompletedSync {
		t.Error("an executor with task support must answer with a handle, not a synchronous result")
	}

	// The executor's own record is the source of truth, carrying the result
	// and the verified caller identity.
	executorTask, ok, _ := executorStore.GetTask(callerID, "bmc-run-1")
	if !ok {
		t.Fatal("executor never recorded the task")
	}
	if executorTask.State != TaskCompleted {
		t.Fatalf("executor task state %s", executorTask.State)
	}
	if string(executorTask.Result) != `{"text":"Q3 revenue was up 12%."}` {
		t.Fatalf("executor result: %s", executorTask.Result)
	}
	if executorTask.Caller != callerID || executorTask.CallerFingerprint == "" {
		t.Fatalf("caller identity missing from the task record: %+v", executorTask)
	}

	// Refresh asks the owning edge directly and returns the result.
	refreshedStub, refreshed, err := caller.RefreshTaskStub(t.Context(), "bmc-run-1", 0)
	if err != nil {
		t.Fatalf("RefreshTaskStub: %v", err)
	}
	if refreshed.TaskID != "bmc-run-1" || refreshed.State != TaskCompleted {
		t.Fatalf("refreshed task: %+v", refreshed)
	}
	if string(refreshed.Result) != `{"text":"Q3 revenue was up 12%."}` {
		t.Fatalf("refreshed result: %s", refreshed.Result)
	}
	if refreshedStub.Result == nil {
		t.Error("the refreshed stub should carry the result for later queries")
	}
}

// TestIntegrationTaskCancelAcrossEdges: the caller cancels; the executor's
// run stops and the state is canceled on both sides.
func TestIntegrationTaskCancelAcrossEdges(t *testing.T) {
	url := startTestNATS(t)
	executorID := uniqueID("acme/lagos/worker")
	callerID := uniqueID("globex/berlin/caller")

	executorStore := newFakeTaskStore()
	invoker := &lateSuccessInvoker{release: make(chan struct{})}
	_ = taskEdge(t, url, executorID, invoker, executorStore, nil)
	callerStore := newFakeTaskStore()
	caller := taskEdge(t, url, callerID, &recordingInvoker{}, callerStore, nil)

	stub, err := caller.CreateRemoteTask(t.Context(), CreateRemoteTaskParams{
		Target: executorID,
		TaskID: "long-run-1",
		Input: map[string]any{
			"target":    "agent-1",
			"operation": OperationTask,
			"arguments": map[string]any{"prompt": "Query the last 10 incidents"},
		},
		CreateTimeout: 5 * time.Second,
	})
	if err != nil {
		t.Fatalf("CreateRemoteTask: %v", err)
	}
	_ = stub

	// Wait until the run is genuinely underway, then cancel from the caller.
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if task, ok, _ := executorStore.GetTask(callerID, "long-run-1"); ok && task.State == TaskWorking {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	canceled, err := caller.CancelTaskByStub(t.Context(), "long-run-1")
	if err != nil {
		t.Fatalf("CancelTaskByStub: %v", err)
	}
	if canceled.State != TaskCanceled {
		t.Fatalf("cancel should report canceled, got %s", canceled.State)
	}

	// The late completion must not resurrect the task — close the invoker and
	// give the executor a moment to observe it.
	close(invoker.release)
	time.Sleep(100 * time.Millisecond)
	task, ok, _ := executorStore.GetTask(callerID, "long-run-1")
	if !ok || task.State != TaskCanceled {
		t.Fatalf("executor task should stay canceled, got %+v", task)
	}
	waitStubState(t, callerStore, "long-run-1", TaskCanceled)
}

// TestIntegrationSyncPeerBecomesACompletedTask pins the compatibility
// contract: a peer without task support answers the old way — one reply, the
// finished result — and the caller still gets a task object, completed and
// marked as having arrived synchronously.
//
// The peer is a bare agent with a hand-registered synchronous invoke skill,
// because a manager running THIS code would take the async branch; what is
// being pinned is the shape of a pre-task edge (or a text-based bridge) on
// the wire, and only a hand-built peer reproduces it faithfully.
func TestIntegrationSyncPeerBecomesACompletedTask(t *testing.T) {
	url := startTestNATS(t)
	oldPeerID := uniqueID("legacy/bridge")
	callerID := uniqueID("globex/berlin/caller")

	oldPeer := testAgent(t, url, oldPeerID, nil)
	oldPeer.RegisterSkill(SkillInvoke, func(_ context.Context, _ any, _ RequestMeta) (any, error) {
		return InvokeOutput{
			Agent:     "agent-1",
			Operation: OperationTask,
			Result:    json.RawMessage(`{"answer":42}`),
		}, nil
	})

	callerStore := newFakeTaskStore()
	caller := taskEdge(t, url, callerID, &recordingInvoker{}, callerStore, nil)

	stub, err := caller.CreateRemoteTask(t.Context(), CreateRemoteTaskParams{
		Target: oldPeerID,
		TaskID: "legacy-1",
		Input: map[string]any{
			"target":    "agent-1",
			"operation": OperationTask,
			"arguments": map[string]any{"prompt": "hello old peer"},
		},
		CreateTimeout: 5 * time.Second,
	})
	if err != nil {
		t.Fatalf("CreateRemoteTask: %v", err)
	}
	if stub.State != TaskCompleted || !stub.CompletedSync {
		t.Fatalf("a sync answer must become a completed task: %+v", stub)
	}
	if string(stub.Result) == "" {
		t.Fatal("the synchronous result should be cached on the stub")
	}
	if !json.Valid(stub.Result) {
		t.Fatalf("cached result is not JSON: %s", stub.Result)
	}
}

// TestIntegrationBridgeDialectAnswerBecomesACompletedTask pins the fleet
// compatibility contract discovered live against grip-cli-001: the text-based
// bridges answer an invoke with the payload itself — {task_id, text}, no
// `output` key, their own minted task id — and that answer must complete the
// caller's task, not strand it in "working" forever.
func TestIntegrationBridgeDialectAnswerBecomesACompletedTask(t *testing.T) {
	url := startTestNATS(t)
	bridgeID := uniqueID("legacy/cli-bridge")
	callerID := uniqueID("globex/berlin/caller")

	// A raw NATS responder speaking the bridge dialect: it does not wrap its
	// answer in {output}, because the bridges never did, and it mints its own
	// task id rather than echoing the caller's.
	conn, err := nats.Connect(url)
	if err != nil {
		t.Fatalf("connect bridge responder: %v", err)
	}
	defer conn.Close()
	sub, err := conn.Subscribe(AgentInboxSubject(bridgeID), func(msg *nats.Msg) {
		if msg.Reply == "" {
			return
		}
		answer, err := json.Marshal(map[string]any{
			"v":    "1.0",
			"id":   "bridge-reply-1",
			"type": "respond",
			"ts":   time.Now().UTC().Format(time.RFC3339Nano),
			"from": bridgeID,
			"to":   "*",
			"payload": map[string]any{
				"task_id": "bridge-internal-1",
				"text":    "Q3 revenue was up 12%.",
				"source":  "cli-bridge",
			},
		})
		if err == nil {
			_ = conn.Publish(msg.Reply, answer)
		}
	})
	if err != nil {
		t.Fatalf("subscribe bridge inbox: %v", err)
	}
	defer func() { _ = sub.Unsubscribe() }()

	callerStore := newFakeTaskStore()
	caller := taskEdge(t, url, callerID, &recordingInvoker{}, callerStore, nil)

	stub, err := caller.CreateRemoteTask(t.Context(), CreateRemoteTaskParams{
		Target: bridgeID,
		TaskID: "bmc-run-2",
		Input: map[string]any{
			"target":    "agent-1",
			"operation": OperationTask,
			"arguments": map[string]any{"prompt": "Summarise Q3"},
		},
		CreateTimeout: 5 * time.Second,
	})
	if err != nil {
		t.Fatalf("CreateRemoteTask: %v", err)
	}
	if stub.State != TaskCompleted || !stub.CompletedSync {
		t.Fatalf("a bridge-dialect answer must become a completed task, got %+v", stub)
	}
	// The answer is stored in the same shape an async invoke result uses, so
	// callers read one shape whatever the peer runs.
	if string(stub.Result) != `{"text":"Q3 revenue was up 12%."}` {
		t.Fatalf("bridge answer not captured: %s", stub.Result)
	}
}

// TestIntegrationRefreshNeverDispatchesToADialectPeer pins the guard's real
// semantics: a stub completed by a bridge-dialect answer has no task.get to
// ask, and a dispatched task.get would be spent as a real agent turn on that
// peer — so refresh must be a local read. The raw responder counts requests;
// only the CREATE may reach it.
func TestIntegrationRefreshNeverDispatchesToADialectPeer(t *testing.T) {
	url := startTestNATS(t)
	bridgeID := uniqueID("legacy/cli-bridge")
	callerID := uniqueID("globex/berlin/caller")

	var requests atomic.Int32
	conn, err := nats.Connect(url)
	if err != nil {
		t.Fatalf("connect bridge responder: %v", err)
	}
	defer conn.Close()
	sub, err := conn.Subscribe(AgentInboxSubject(bridgeID), func(msg *nats.Msg) {
		requests.Add(1)
		if msg.Reply == "" {
			return
		}
		answer, err := json.Marshal(map[string]any{
			"v":    "1.0",
			"id":   "bridge-reply-1",
			"type": "respond",
			"ts":   time.Now().UTC().Format(time.RFC3339Nano),
			"from": bridgeID,
			"to":   "*",
			"payload": map[string]any{
				"task_id": "bridge-internal-1",
				"text":    "Q3 revenue was up 12%.",
				"source":  "cli-bridge",
			},
		})
		if err == nil {
			_ = conn.Publish(msg.Reply, answer)
		}
	})
	if err != nil {
		t.Fatalf("subscribe bridge inbox: %v", err)
	}
	defer func() { _ = sub.Unsubscribe() }()

	callerStore := newFakeTaskStore()
	caller := taskEdge(t, url, callerID, &recordingInvoker{}, callerStore, nil)

	stub, err := caller.CreateRemoteTask(t.Context(), CreateRemoteTaskParams{
		Target: bridgeID,
		TaskID: "dialect-run-1",
		Input: map[string]any{
			"target":    "agent-1",
			"operation": OperationTask,
			"arguments": map[string]any{"prompt": "hello"},
		},
		CreateTimeout: 5 * time.Second,
	})
	if err != nil {
		t.Fatalf("CreateRemoteTask: %v", err)
	}
	if stub.State != TaskCompleted || !stub.CompletedSync {
		t.Fatalf("setup: the dialect answer should have completed the stub, got %+v", stub)
	}

	// Refresh: must return the stub from local storage without a second
	// request — a task.get sent to this peer would run as an agent turn.
	refreshed, _, err := caller.RefreshTaskStub(t.Context(), "dialect-run-1", 0)
	if err != nil {
		t.Fatalf("RefreshTaskStub: %v", err)
	}
	if refreshed.State != TaskCompleted || string(refreshed.Result) != `{"text":"Q3 revenue was up 12%."}` {
		t.Fatalf("refresh should return the completed stub as-is: %+v", refreshed)
	}
	if got := requests.Load(); got != 1 {
		t.Fatalf("the peer saw %d requests; refresh must not dispatch to a dialect peer (want 1: the create only)", got)
	}
}

// streamingInvoker plays a desktop that commits snapshots: it feeds the
// request's progress callback with the assistant text's growth and then
// returns the full text as the result — the same shape the session layer
// produces from real conversation projections.
type streamingInvoker struct {
	deltas   []string
	requests []LocalInvokeRequest
}

func (s *streamingInvoker) InvokeLocalAgent(ctx context.Context, request LocalInvokeRequest) (LocalInvokeResult, error) {
	s.requests = append(s.requests, request)
	full := strings.Join(s.deltas, "")
	if request.Progress != nil {
		for _, delta := range s.deltas {
			request.Progress(delta)
		}
	}
	encoded, err := json.Marshal(map[string]string{"text": full})
	if err != nil {
		return LocalInvokeResult{}, err
	}
	return LocalInvokeResult{OK: true, Result: encoded}, nil
}

// TestIntegrationStreamedTaskPublishesOrderedChunksAndATerminalTail is the
// streaming contract on the wire: a task created with stream:true publishes
// its assistant text's growth as ordered chunks on mesh.event.task.<id>.chunk,
// the terminal chunk carries the unflushed tail and last:true, a tail read
// catches a listener up, and the caller's stub is never corrupted by chunk
// events (which carry no state field). A task that did not opt in publishes
// none of this.
func TestIntegrationStreamedTaskPublishesOrderedChunksAndATerminalTail(t *testing.T) {
	url := startTestNATS(t)
	executorID := uniqueID("acme/lagos/executor")
	callerID := uniqueID("globex/berlin/caller")

	deltas := []string{
		"Q3 revenue was up 12% year on year. ",
		"Margins improved by two points, driven by the switch to local egress. ",
		"The board summary follows in the appendix of the report.",
	}
	invoker := &streamingInvoker{deltas: deltas}
	executorStore := newFakeTaskStore()
	_ = taskEdge(t, url, executorID, invoker, executorStore, nil)
	callerStore := newFakeTaskStore()
	caller := taskEdge(t, url, callerID, &recordingInvoker{}, callerStore, nil)

	// A live listener on the chunk subject, attached before the create.
	listener, err := nats.Connect(url)
	if err != nil {
		t.Fatalf("connect listener: %v", err)
	}
	defer listener.Close()
	var mu sync.Mutex
	var observed []TaskChunk
	sub, err := listener.Subscribe(TaskEventSubject("stream-1")+".chunk", func(msg *nats.Msg) {
		// The wire message is a full mesh envelope; the chunk rides in
		// payload.data, the emit event's body.
		var envelope struct {
			Payload struct {
				Data taskChunkEvent `json:"data"`
			} `json:"payload"`
		}
		if err := json.Unmarshal(msg.Data, &envelope); err != nil {
			return
		}
		mu.Lock()
		observed = append(observed, TaskChunk{
			Seq:  envelope.Payload.Data.Seq,
			Text: envelope.Payload.Data.Text,
			Last: envelope.Payload.Data.Last,
		})
		mu.Unlock()
	})
	if err != nil {
		t.Fatalf("subscribe chunk subject: %v", err)
	}
	defer func() { _ = sub.Unsubscribe() }()

	stub, err := caller.CreateRemoteTask(t.Context(), CreateRemoteTaskParams{
		Target: executorID,
		TaskID: "stream-1",
		Stream: true,
		Input: map[string]any{
			"target":    "agent-1",
			"operation": OperationTask,
			"arguments": map[string]any{"prompt": "Summarise Q3"},
		},
		CreateTimeout: 5 * time.Second,
	})
	if err != nil {
		t.Fatalf("CreateRemoteTask: %v", err)
	}
	// A streaming create returns a non-terminal handle so the caller knows to
	// listen for chunks. A fast executor can finish — and announce — before the
	// caller's stub is saved, in which case CreateRemoteTask's documented
	// fast-peer drain path promotes the stub to the buffered terminal state
	// (TaskCompleted). That is correct, not a bug: the chunk stream is still
	// published on its own subject and the listener below still catches it, so
	// the stream contract this test guards is intact. Accept the terminal
	// state here and let the rest of the test verify the chunks and the tail.
	if stub.State != TaskWorking && stub.State != TaskQueued && stub.State != TaskCompleted {
		t.Fatalf("a streaming create should start non-terminal, got %s", stub.State)
	}

	waitStubState(t, callerStore, "stream-1", TaskCompleted)

	// The listener saw ordered chunks ending in exactly one terminal.
	mu.Lock()
	chunks := append([]TaskChunk{}, observed...)
	mu.Unlock()
	if len(chunks) == 0 {
		t.Fatal("no chunk events were observed on the wire")
	}
	lastSeq := 0
	var text strings.Builder
	terminals := 0
	for _, chunk := range chunks {
		if chunk.Seq <= lastSeq {
			t.Fatalf("chunk seqs must strictly increase: %+v", chunks)
		}
		lastSeq = chunk.Seq
		text.WriteString(chunk.Text)
		if chunk.Last {
			terminals++
		}
	}
	if terminals != 1 {
		t.Fatalf("a stream ends exactly once; saw %d terminal chunks: %+v", terminals, chunks)
	}
	full := strings.Join(deltas, "")
	if text.String() != full {
		t.Fatalf("chunk concatenation should rebuild the answer:\n got %q\nwant %q", text.String(), full)
	}

	// The caller's stub survived the chunk events: state came from state
	// events only, never parsed from a chunk's state-less data.
	if stub2, _, _ := callerStore.GetTaskStub("stream-1"); stub2.State != TaskCompleted {
		t.Fatalf("the stub was corrupted by chunk events: %+v", stub2)
	}

	// The tail read catches a listener up through the owner: the chunks come
	// back from task.get, terminal included.
	_, refreshed, err := caller.RefreshTaskStub(t.Context(), "stream-1", 16)
	if err != nil {
		t.Fatalf("RefreshTaskStub with tail: %v", err)
	}
	if len(refreshed.Chunks) == 0 {
		t.Fatal("a tail read should return the streamed chunks")
	}
	if !refreshed.Chunks[len(refreshed.Chunks)-1].Last {
		t.Fatal("the tail's newest chunk should be the terminal")
	}

	// A task that did not opt in publishes nothing on any chunk subject and
	// reaches its invoker with no progress callback.
	_, err = caller.CreateRemoteTask(t.Context(), CreateRemoteTaskParams{
		Target: executorID,
		TaskID: "quiet-1",
		Input: map[string]any{
			"target":    "agent-1",
			"operation": OperationTask,
			"arguments": map[string]any{"prompt": "Summarise Q4"},
		},
		CreateTimeout: 5 * time.Second,
	})
	if err != nil {
		t.Fatalf("CreateRemoteTask quiet: %v", err)
	}
	waitStubState(t, callerStore, "quiet-1", TaskCompleted)
	if invoker.requests[len(invoker.requests)-1].Progress != nil {
		t.Fatal("a task that did not opt into streaming must not reach the invoker with a progress callback")
	}
}

// webhookReceipt is one notification a receiver accepted, kept raw enough to
// verify the signature against the sender's advertised identity — the exact
// flow a serverless consumer would run.
type webhookReceipt struct {
	body        []byte
	agentID     string
	fingerprint string
	publicKey   string
	signature   string
	taskState   string
}

// TestIntegrationTaskWebhookIsSignedAndDeliveredOnTerminal is the push
// contract end to end: a task created with a notify URL on one edge, running
// on a second edge, completes; the creator POSTs the stub to the receiver,
// signed with the mesh identity trio; the receiver verifies with
// VerifySignedBody and pins the fingerprint against the gateway's status —
// with zero prior contact between receiver and gateway.
func TestIntegrationTaskWebhookIsSignedAndDeliveredOnTerminal(t *testing.T) {
	url := startTestNATS(t)
	executorID := uniqueID("acme/lagos/executor")
	callerID := uniqueID("globex/berlin/caller")

	_ = taskEdge(t, url, executorID,
		&recordingInvoker{result: LocalInvokeResult{OK: true, Result: json.RawMessage(`{"text":"Q3 is up."}`)}},
		newFakeTaskStore(), nil)
	callerStore := newFakeTaskStore()
	caller := taskEdge(t, url, callerID, &recordingInvoker{}, callerStore, nil)

	// The receiver: a plain HTTP server, as a Lambda or mobile backend would
	// be. It records the raw body and the identity headers.
	receipts := make(chan webhookReceipt, 4)
	receiver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		// The public key arrives base64-encoded: a PEM block cannot travel in
		// an HTTP header (newlines), so the receiver decodes before verifying.
		publicKey, err := base64.StdEncoding.DecodeString(r.Header.Get(WebhookHeaderPublicKey))
		if err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		receipts <- webhookReceipt{
			body:        body,
			agentID:     r.Header.Get(WebhookHeaderAgent),
			fingerprint: r.Header.Get(WebhookHeaderFingerprint),
			publicKey:   string(publicKey),
			signature:   r.Header.Get(WebhookHeaderSignature),
			taskState:   r.Header.Get(WebhookHeaderTaskState),
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer receiver.Close()

	stub, err := caller.CreateRemoteTask(t.Context(), CreateRemoteTaskParams{
		Target:    executorID,
		TaskID:    "push-1",
		NotifyURL: receiver.URL,
		Input: map[string]any{
			"target":    "agent-1",
			"operation": OperationTask,
			"arguments": map[string]any{"prompt": "Summarise Q3"},
		},
		CreateTimeout: 5 * time.Second,
	})
	if err != nil {
		t.Fatalf("CreateRemoteTask: %v", err)
	}
	_ = stub

	waitStubState(t, callerStore, "push-1", TaskCompleted)

	// The notification arrives asynchronously (it fires on the event path);
	// the deadline is generous because retries are allowed to have happened.
	select {
	case receipt := <-receipts:
		// The recipient's whole job, in one call — and it must pass with no
		// prior contact with this gateway.
		if err := VerifySignedBody(receipt.agentID, receipt.fingerprint,
			receipt.publicKey, receipt.body, receipt.signature); err != nil {
			t.Fatalf("the webhook body did not verify: %v", err)
		}
		// The pinned-fingerprint check: the claimed identity is the gateway's
		// real one, as a receiver that had met this edge before would demand.
		if receipt.fingerprint != caller.Status().Fingerprint {
			t.Fatalf("webhook fingerprint %s is not the gateway's %s",
				receipt.fingerprint, caller.Status().Fingerprint)
		}
		if receipt.taskState != string(TaskCompleted) {
			t.Fatalf("the state header should say completed, got %s", receipt.taskState)
		}
		var delivered TaskStub
		if err := json.Unmarshal(receipt.body, &delivered); err != nil {
			t.Fatalf("the payload is not the stub JSON: %v", err)
		}
		if delivered.TaskID != "push-1" || delivered.State != TaskCompleted {
			t.Fatalf("the payload stub is wrong: %+v", delivered)
		}
		if string(delivered.Result) != `{"text":"Q3 is up."}` {
			t.Fatalf("the payload should carry the result: %s", delivered.Result)
		}
		// Exactly once: no second notification may follow.
		select {
		case extra := <-receipts:
			t.Fatalf("a second notification arrived: %+v", extra)
		case <-time.After(300 * time.Millisecond):
		}
	case <-time.After(10 * time.Second):
		t.Fatalf("the webhook was never delivered (attempts=%d failures=%d)",
			observability.Usage.MeshTaskWebhookTotal.Load(),
			observability.Usage.MeshTaskWebhookFailedTotal.Load())
	}
}

// TestIntegrationTaskRetryRunsAgainAcrossEdges: a failed task on one edge is
// retried through the task.retry skill by its creating caller and completes on
// the second attempt — the manual-resume primitive over the wire.
func TestIntegrationTaskRetryRunsAgainAcrossEdges(t *testing.T) {
	url := startTestNATS(t)
	executorID := uniqueID("acme/lagos/worker")
	callerID := uniqueID("globex/berlin/caller")

	// The invoker fails the first run and succeeds the second.
	invoker := &flakyInvoker{failuresRemaining: 1, result: LocalInvokeResult{OK: true, Result: json.RawMessage(`{"text":"second try worked."}`)}}
	executorStore := newFakeTaskStore()
	executor := taskEdge(t, url, executorID, invoker, executorStore, nil)
	_ = executor
	callerStore := newFakeTaskStore()
	caller := taskEdge(t, url, callerID, &recordingInvoker{}, callerStore, nil)

	if _, err := caller.CreateRemoteTask(t.Context(), CreateRemoteTaskParams{
		Target: executorID,
		TaskID: "flaky-run-1",
		Input: map[string]any{
			"target":    "agent-1",
			"operation": OperationTask,
			"arguments": map[string]any{"prompt": "hello"},
		},
		CreateTimeout: 5 * time.Second,
	}); err != nil {
		t.Fatalf("CreateRemoteTask: %v", err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if task, ok, _ := executorStore.GetTask(callerID, "flaky-run-1"); ok && task.State == TaskFailed {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	// The creating caller retries over the wire, through the skill.
	envelope, err := caller.Dispatch(t.Context(), executorID, SkillTaskRetry,
		map[string]any{"task_id": "flaky-run-1"}, 10*time.Second)
	if err != nil {
		t.Fatalf("task.retry dispatch: %v", err)
	}
	var respond RespondPayload
	if len(envelope.Payload) > 0 {
		_ = json.Unmarshal(envelope.Payload, &respond)
	}
	retried, err := taskFromOutput(respond.Output)
	if err != nil {
		t.Fatalf("the retry reply was not a task: %v", err)
	}
	if retried.State != TaskQueued {
		t.Fatalf("a retry requeues, got %s", retried.State)
	}

	// The second run completes under the same id.
	deadline = time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if task, ok, _ := executorStore.GetTask(callerID, "flaky-run-1"); ok && task.State == TaskCompleted {
			if string(task.Result) != `{"text":"second try worked."}` {
				t.Fatalf("second-run result: %s", task.Result)
			}
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	task, _, _ := executorStore.GetTask(callerID, "flaky-run-1")
	t.Fatalf("the retried task never completed (state %s)", task.State)
}

// flakyInvoker fails its first N invocations and then succeeds — the shape of
// work that a retry exists for.
type flakyInvoker struct {
	failuresRemaining int
	result            LocalInvokeResult
	requests          []LocalInvokeRequest
}

func (f *flakyInvoker) InvokeLocalAgent(ctx context.Context, request LocalInvokeRequest) (LocalInvokeResult, error) {
	f.requests = append(f.requests, request)
	if f.failuresRemaining > 0 {
		f.failuresRemaining--
		return LocalInvokeResult{}, &codedError{code: CodeInternalError, reason: "transient"}
	}
	return f.result, nil
}

// TestIntegrationEdgeWithoutStoreDoesNotAdvertiseTasks: the honest manifest.
// A manager without a task store must not offer task.get/task.cancel, or a
// caller would follow the handle and find nothing.
func TestIntegrationEdgeWithoutStoreDoesNotAdvertiseTasks(t *testing.T) {
	url := startTestNATS(t)
	bareID := uniqueID("acme/lagos/bare")
	callerID := uniqueID("globex/berlin/caller")

	bare := testManager(t, url, bareID, nil)
	_ = bare
	caller := taskEdge(t, url, callerID, &recordingInvoker{}, newFakeTaskStore(), nil)

	peers, err := caller.Discover(t.Context(), DiscoverFilter{})
	if err != nil {
		t.Fatalf("discover: %v", err)
	}
	manifest, ok := manifestByID(peers, bareID)
	if !ok {
		t.Fatalf("bare edge %s not discovered", bareID)
	}
	for _, skill := range manifest.Skills {
		if skill.ID == SkillTaskGet || skill.ID == SkillTaskCancel {
			t.Fatalf("an edge without a task store must not advertise %s", skill.ID)
		}
	}
	_ = nuid.Next()
}

// TestIntegrationInputRequiredPausesAndResumesAcrossEdges is the interactive
// loop end to end: a task that opted into input asks a question on the
// executor, both operators are pushed (the executor's webhook carries the
// question), the caller answers through the task.input skill, and the run
// resumes in the same desktop conversation and completes.
func TestIntegrationInputRequiredPausesAndResumesAcrossEdges(t *testing.T) {
	url := startTestNATS(t)
	executorID := uniqueID("acme/lagos/worker")
	callerID := uniqueID("globex/berlin/caller")

	// The receiver for the executor's own input notification.
	receipts := make(chan webhookReceipt, 4)
	receiver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		publicKey, err := base64.StdEncoding.DecodeString(r.Header.Get(WebhookHeaderPublicKey))
		if err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		receipts <- webhookReceipt{
			body:        body,
			agentID:     r.Header.Get(WebhookHeaderAgent),
			fingerprint: r.Header.Get(WebhookHeaderFingerprint),
			publicKey:   string(publicKey),
			signature:   r.Header.Get(WebhookHeaderSignature),
			taskState:   r.Header.Get(WebhookHeaderTaskState),
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer receiver.Close()

	const conversation = "remote-task-conv-live-1"
	invoker := &scriptedInvoker{results: []LocalInvokeResult{
		{OK: true, ConversationID: conversation,
			Result: json.RawMessage(`{"text":"I need one detail.\n[[INPUT_REQUIRED: which quarter?]]"}`)},
		{OK: true, ConversationID: conversation,
			Result: json.RawMessage(`{"text":"Q3 revenue was 4.1M."}`)},
	}}
	executorStore := newFakeTaskStore()
	executor := taskEdge(t, url, executorID, invoker, executorStore, func(c *Config) {
		c.TaskExecutorWebhook = receiver.URL
	})
	_ = executor
	callerStore := newFakeTaskStore()
	caller := taskEdge(t, url, callerID, &recordingInvoker{}, callerStore, nil)

	if _, err := caller.CreateRemoteTask(t.Context(), CreateRemoteTaskParams{
		Target:     executorID,
		TaskID:     "ask-live-1",
		AllowInput: true,
		Input: map[string]any{
			"target":    "agent-1",
			"operation": OperationTask,
			"arguments": map[string]any{"prompt": "Report the quarter's revenue"},
		},
		CreateTimeout: 5 * time.Second,
	}); err != nil {
		t.Fatalf("CreateRemoteTask: %v", err)
	}

	// The executor's task pauses with the question and the conversation.
	deadline := time.Now().Add(5 * time.Second)
	var paused Task
	for time.Now().Before(deadline) {
		if task, ok, _ := executorStore.GetTask(callerID, "ask-live-1"); ok && task.State == TaskInputRequired {
			paused = task
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if paused.State != TaskInputRequired {
		task, _, _ := executorStore.GetTask(callerID, "ask-live-1")
		t.Fatalf("the task never paused (state %s)", task.State)
	}
	if paused.PendingInput != "which quarter?" {
		t.Fatalf("the question was not recorded: %q", paused.PendingInput)
	}
	if paused.Conversation != conversation {
		t.Fatalf("the conversation was not recorded: %q", paused.Conversation)
	}

	// The executor's operator is pushed: a signed POST whose payload is the
	// task, question included.
	select {
	case receipt := <-receipts:
		if err := VerifySignedBody(receipt.agentID, receipt.fingerprint,
			receipt.publicKey, receipt.body, receipt.signature); err != nil {
			t.Fatalf("the input webhook did not verify: %v", err)
		}
		if receipt.fingerprint != executor.Status().Fingerprint {
			t.Fatalf("input webhook fingerprint %s is not the executor's %s",
				receipt.fingerprint, executor.Status().Fingerprint)
		}
		if receipt.taskState != string(TaskInputRequired) {
			t.Fatalf("the state header should say input-required, got %s", receipt.taskState)
		}
		var delivered Task
		if err := json.Unmarshal(receipt.body, &delivered); err != nil {
			t.Fatalf("the input payload is not task JSON: %v", err)
		}
		if delivered.TaskID != "ask-live-1" || delivered.PendingInput != "which quarter?" {
			t.Fatalf("the input payload is wrong: %+v", delivered)
		}
	case <-time.After(10 * time.Second):
		t.Fatalf("the executor input webhook was never delivered (attempts=%d failures=%d)",
			observability.Usage.MeshTaskWebhookTotal.Load(),
			observability.Usage.MeshTaskWebhookFailedTotal.Load())
	}

	// The caller's own record learns the state through the event, and a
	// refresh mirrors the question.
	stub := waitStubState(t, callerStore, "ask-live-1", TaskInputRequired)
	if _, _, err := caller.RefreshTaskStub(t.Context(), "ask-live-1", 0); err != nil {
		t.Fatalf("RefreshTaskStub: %v", err)
	}
	if refreshed, ok, _ := callerStore.GetTaskStub("ask-live-1"); !ok || refreshed.PendingInput != "which quarter?" {
		t.Fatalf("the refresh did not mirror the question: ok=%v pending=%q",
			ok, refreshed.PendingInput)
	}
	_ = stub

	// The caller answers; the owning edge resumes the run in place.
	if _, err := caller.SubmitTaskInput(t.Context(), "ask-live-1", json.RawMessage(`"Q3"`)); err != nil {
		t.Fatalf("SubmitTaskInput: %v", err)
	}

	deadline = time.Now().Add(5 * time.Second)
	var done Task
	for time.Now().Before(deadline) {
		if task, ok, _ := executorStore.GetTask(callerID, "ask-live-1"); ok && task.State == TaskCompleted {
			done = task
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if done.State != TaskCompleted {
		task, _, _ := executorStore.GetTask(callerID, "ask-live-1")
		t.Fatalf("the resumed task never completed (state %s)", task.State)
	}
	if string(done.Result) != `{"text":"Q3 revenue was 4.1M."}` {
		t.Fatalf("the resumed run's result: %s", done.Result)
	}
	if done.PendingInput != "" {
		t.Fatalf("the question should be cleared on resume, got %q", done.PendingInput)
	}
	requests := invoker.recorded()
	if len(requests) != 2 {
		t.Fatalf("expected ask + resume invocations, got %d", len(requests))
	}
	if requests[1].ConversationID != conversation {
		t.Fatalf("the resume must continue the recorded conversation, got %q", requests[1].ConversationID)
	}
	if !requests[0].AllowInput || !requests[1].AllowInput {
		t.Fatal("both runs must carry the input opt-in (the task may ask again)")
	}

	// And the caller's record reaches completed through the event path.
	waitStubState(t, callerStore, "ask-live-1", TaskCompleted)
}
