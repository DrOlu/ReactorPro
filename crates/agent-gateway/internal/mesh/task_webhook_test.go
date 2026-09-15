package mesh

// Unit coverage for task webhooks: URL resolution (per-task over the gateway
// default, and nowhere when neither is set), the once-only gate, and the
// recipient's verification function over a signed body. The end-to-end POST
// (headers, retries, the receiver actually receiving) is pinned in
// task_integration_test.go against a real HTTP server.

import (
	"encoding/json"
	"testing"
	"time"
)

func TestResolveTaskWebhookPrefersThePerTaskURL(t *testing.T) {
	manager := invokeTestManager(t, invokeAgents(), func(c *Config) {
		c.TaskWebhook = "https://ops.example.com/tasks"
	})

	stub := TaskStub{TaskID: "t1", State: TaskCompleted}
	if got := manager.resolveTaskWebhook(stub); got != "https://ops.example.com/tasks" {
		t.Fatalf("without a per-task URL the gateway default applies, got %q", got)
	}
	stub.NotifyURL = "https://hooks.example.com/bmc-1"
	if got := manager.resolveTaskWebhook(stub); got != "https://hooks.example.com/bmc-1" {
		t.Fatalf("a per-task URL overrides the default, got %q", got)
	}

	plain := invokeTestManager(t, invokeAgents(), nil)
	if got := plain.resolveTaskWebhook(TaskStub{TaskID: "t1", State: TaskCompleted}); got != "" {
		t.Fatalf("no URL anywhere means no notification, got %q", got)
	}
}

func TestNotifyTaskTerminalFiresOncePerTaskAndURL(t *testing.T) {
	manager := invokeTestManager(t, invokeAgents(), nil)
	terminal := TaskStub{TaskID: "once-1", State: TaskCompleted, NotifyURL: "http://127.0.0.1:1/nowhere"}

	// The delivery goroutine launches per call; the once-only gate is what is
	// under test, so count launches by counting the fired set's growth.
	for i := 0; i < 3; i++ {
		manager.notifyTaskTerminal(terminal)
	}
	manager.taskMu.Lock()
	fired := len(manager.webhookFired)
	manager.taskMu.Unlock()
	if fired != 1 {
		t.Fatalf("a terminal stub notifies once, not %d times", fired)
	}

	// A different URL for the same task is a different notification.
	otherURL := terminal
	otherURL.NotifyURL = "http://127.0.0.1:2/elsewhere"
	manager.notifyTaskTerminal(otherURL)
	manager.taskMu.Lock()
	fired = len(manager.webhookFired)
	manager.taskMu.Unlock()
	if fired != 2 {
		t.Fatalf("a second URL is a second notification, saw %d", fired)
	}

	// A non-terminal state never notifies, whatever the URL.
	manager.notifyTaskTerminal(TaskStub{TaskID: "live-1", State: TaskWorking, NotifyURL: "http://127.0.0.1:3/x"})
	manager.taskMu.Lock()
	fired = len(manager.webhookFired)
	manager.taskMu.Unlock()
	if fired != 2 {
		t.Fatalf("a working task must not notify, saw %d", fired)
	}
}

func TestVerifySignedBodyChecksSignatureAndFingerprint(t *testing.T) {
	identity, err := GenerateIdentity("acme/lagos/edge-1")
	if err != nil {
		t.Fatalf("GenerateIdentity: %v", err)
	}
	body, err := json.Marshal(TaskStub{TaskID: "bmc-1", State: TaskCompleted,
		Result: json.RawMessage(`{"text":"Q3 is up."}`), UpdatedAt: time.Now().UTC()})
	if err != nil {
		t.Fatalf("marshal body: %v", err)
	}
	signature := identity.SignBytes(body)

	// The honest receipt verifies.
	if err := VerifySignedBody(identity.AgentID, identity.Fingerprint,
		identity.PublicKeyPEM, body, signature); err != nil {
		t.Fatalf("a genuine webhook body must verify: %v", err)
	}

	// A tampered body does not: a different payload under the same signature.
	tampered, err := json.Marshal(TaskStub{TaskID: "bmc-1", State: TaskFailed,
		UpdatedAt: time.Now().UTC()})
	if err != nil {
		t.Fatalf("marshal tampered: %v", err)
	}
	if err := VerifySignedBody(identity.AgentID, identity.Fingerprint,
		identity.PublicKeyPEM, tampered, signature); err == nil {
		t.Fatal("a different body under the same signature must not verify")
	}

	// A fingerprint claimed under someone else's key is refused: the binding
	// the trio exists for.
	if err := VerifySignedBody(identity.AgentID, "sha256:dead0000beef0000",
		identity.PublicKeyPEM, body, signature); err == nil {
		t.Fatal("a mismatched claimed fingerprint must not verify")
	}
}

func TestRetryTaskOnlyAcceptsFailedOrCanceledTasks(t *testing.T) {
	invoker := &recordingInvoker{result: LocalInvokeResult{OK: true, Result: json.RawMessage(`{"text":"recovered."}`)}}
	manager, store := taskTestManager(t, invoker, nil)
	meta := verifiedCaller()

	// A completed task refuses the retry: it needs nothing.
	if _, err := manager.startAsyncTask(asyncInput("done-1"), meta, LocalAgent{ID: "agent-1"}); err != nil {
		t.Fatalf("startAsyncTask: %v", err)
	}
	pollTask(t, store, meta.From, "done-1", TaskCompleted)
	if _, err := manager.RetryTask(meta.From, "done-1"); codeOf(t, err) != CodeGovernanceDenied {
		t.Fatalf("retrying a completed task should be refused, got %v", err)
	}

	// A failed task retries under the same id: the record resets to queued,
	// the invoker runs again, and the task completes.
	failInvoker := &recordingInvoker{err: &codedError{code: CodeInternalError, reason: "the desktop fell over"}}
	manager.mu.Lock()
	invokerField := manager.localInvoker
	_ = invokerField
	manager.mu.Unlock()
	manager.mu.Lock()
	manager.localInvoker = failInvoker
	manager.mu.Unlock()
	if _, err := manager.startAsyncTask(asyncInput("flaky-1"), meta, LocalAgent{ID: "agent-1"}); err != nil {
		t.Fatalf("startAsyncTask flaky: %v", err)
	}
	pollTask(t, store, meta.From, "flaky-1", TaskFailed)

	// Swap back to the working invoker and retry.
	manager.mu.Lock()
	manager.localInvoker = invoker
	manager.mu.Unlock()
	retried, err := manager.RetryTask(meta.From, "flaky-1")
	if err != nil {
		t.Fatalf("RetryTask: %v", err)
	}
	if retried.State != TaskQueued {
		t.Fatalf("a retry requeues, got %s", retried.State)
	}
	final := pollTask(t, store, meta.From, "flaky-1", TaskCompleted)
	if len(final.Result) == 0 {
		t.Fatal("the retried run should record its result under the same id")
	}

	// Another tenant cannot retry this caller's task — same isolation as get
	// and cancel.
	if _, err := manager.RetryTask("rival/berlin/edge-1", "flaky-1"); codeOf(t, err) != CodeSkillNotFound {
		t.Fatalf("a rival retrying another tenant's task should be told it does not exist, got %v", err)
	}
}

func TestNotifyTaskInputRequiredFiresOnceAndRearms(t *testing.T) {
	manager := invokeTestManager(t, invokeAgents(), nil)
	question := Task{TaskID: "ask-1", Caller: "acme/lagos/edge-1",
		State: TaskInputRequired, PendingInput: "which quarter?"}
	const url = "http://127.0.0.1:1/inputs"

	// The same entry into input-required notifies once.
	for i := 0; i < 3; i++ {
		manager.notifyTaskInputRequired(question, url)
	}
	manager.taskMu.Lock()
	fired := len(manager.webhookFired)
	manager.taskMu.Unlock()
	if fired != 1 {
		t.Fatalf("one entry into input-required notifies once, not %d times", fired)
	}

	// A terminal push for the same task at the same URL is a different
	// notification — the class is part of the key, so the receiver can be
	// told "finished" and "needs input" of the same task.
	manager.notifyTaskTerminal(TaskStub{TaskID: "ask-1", State: TaskCompleted, NotifyURL: url})
	manager.taskMu.Lock()
	fired = len(manager.webhookFired)
	manager.taskMu.Unlock()
	if fired != 2 {
		t.Fatalf("input and terminal are different notifications, saw %d", fired)
	}

	// Leaving input-required re-arms the input class, so a second question
	// notifies again: the clear forgets the claim (back to the terminal one
	// alone), and the same state fires afresh.
	manager.clearWebhookFired("ask-1", url, webhookClassInput)
	manager.taskMu.Lock()
	fired = len(manager.webhookFired)
	manager.taskMu.Unlock()
	if fired != 1 {
		t.Fatalf("clearing re-arms by forgetting the input claim, saw %d", fired)
	}
	manager.notifyTaskInputRequired(question, url)
	manager.taskMu.Lock()
	fired = len(manager.webhookFired)
	manager.taskMu.Unlock()
	if fired != 2 {
		t.Fatalf("a re-armed input notification fires again, saw %d", fired)
	}
}

func TestNotifyTaskInputRequiredIgnoresEmptyURLAndUnknownPayloads(t *testing.T) {
	manager := invokeTestManager(t, invokeAgents(), nil)
	manager.notifyTaskInputRequired(Task{TaskID: "ask-2", State: TaskInputRequired}, "")
	manager.notifyTaskInputRequired("not a task", "http://127.0.0.1:1/x")
	manager.taskMu.Lock()
	fired := len(manager.webhookFired)
	manager.taskMu.Unlock()
	if fired != 0 {
		t.Fatalf("nothing should have been claimed, saw %d", fired)
	}
}
