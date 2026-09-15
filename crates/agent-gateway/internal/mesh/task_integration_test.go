package mesh

// The task lifecycle against a real nats-server: two managers, two identities,
// one task. This is where the design's promises are checked on the wire — the
// handle reply, the state events, the stub updates, cancel across edges, and
// the synchronous fallback for peers that have not adopted tasks.

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"sync/atomic"
	"testing"
	"time"

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
	refreshedStub, refreshed, err := caller.RefreshTaskStub(t.Context(), "bmc-run-1")
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
	refreshed, _, err := caller.RefreshTaskStub(t.Context(), "dialect-run-1")
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
