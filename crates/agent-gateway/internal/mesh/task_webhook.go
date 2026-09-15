package mesh

// Task webhooks: push notification for the async lifecycle.
//
// Polling exists (GET /api/mesh/tasks/{id}); a webhook is what lets a mobile
// backend or a serverless function go to sleep. When a task this gateway
// CREATED goes terminal, the stub's notify URL — per-task from the REST
// create, else the gateway's -mesh-task-webhook default — receives one POST:
// the task stub as JSON, signed with this gateway's Ed25519 identity in the
// same trio mesh envelopes carry (sig + pub + fp headers), so a recipient
// verifies with VerifySignedBody and pins the fingerprint from a prior
// verified contact exactly as it would a peer.
//
// The URL never comes from the wire. A notifyUrl supplied by a remote peer
// would be a serverless-request-forgery vector — anything that can dispatch a
// task could make this gateway POST to an internal address — so the only
// sources are the local operator's REST create (bearer token) and the
// operator's own flag. A peer cannot aim this gateway anywhere.
//
// Delivery is best-effort with retries, and deliberately no more: a persistent
// outbound queue would need its own durability story and would eventually be
// a second mailbox. The task record is the durable truth; the webhook is a
// nudge. Failures are counted (mesh_task_webhook_failed_total) and logged.

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/liveagent/agent-gateway/internal/observability"
)

// Webhook header names: the payload's identity, in the envelope's vocabulary.
// The public key travels BASE64-encoded: a PEM block contains newlines, and an
// HTTP header value cannot carry CR/LF — raw PEM in this header fails every
// request at the transport, before a single byte is delivered (caught by the
// webhook integration test, which is the only tier that goes through
// http.Header at all). The recipient base64-decodes before verifying.
const (
	WebhookHeaderAgent       = "X-ReactorPro-Agent"
	WebhookHeaderFingerprint = "X-ReactorPro-Fingerprint"
	WebhookHeaderPublicKey   = "X-ReactorPro-Public-Key"
	WebhookHeaderSignature   = "X-ReactorPro-Signature"
	WebhookHeaderTaskID      = "X-ReactorPro-Task-ID"
	WebhookHeaderTaskState   = "X-ReactorPro-Task-State"
)

const (
	// webhookAttempts bounds delivery. Three tries covers a receiver's
	// deploy blip without making a dead endpoint anyone's problem.
	webhookAttempts = 3
	// webhookAttemptTimeout bounds one POST. A notification that takes longer
	// than this is not worth waiting for; the task stays queryable.
	webhookAttemptTimeout = 10 * time.Second
	// webhookRetryDelay separates attempts: long enough for a cold serverless
	// instance to come up, short enough not to linger.
	webhookRetryDelay = 5 * time.Second
	// webhookFiredCap bounds the once-only set. Task ids are operator-chosen
	// and a webhook per task is a one-shot, so the set only grows with tasks;
	// the cap keeps a pathological flow bounded anyway.
	webhookFiredCap = 4096
)

// webhookFiredKey is the URL-scoped identity of a notification: the same task
// notified at two different URLs (per-task changed mid-life) is two deliveries,
// but the same (task, url, class) fires once. The class separates a terminal
// push from an input-required push, so both may go to the same URL — and the
// input class is cleared when the task resumes, so a task that asks twice
// notifies twice.
func webhookFiredKey(taskID, url, class string) string {
	return taskID + "\x00" + url + "\x00" + class
}

const (
	// webhookClassTerminal is the one-per-task "it finished" push.
	webhookClassTerminal = "terminal"
	// webhookClassInput is the "it needs a human" push, re-armed on resume.
	webhookClassInput = "input"
)

// markWebhookFired claims a notification slot: true when this call is the one
// that should deliver, false when the notification already went out.
func (m *Manager) markWebhookFired(key string) bool {
	m.taskMu.Lock()
	defer m.taskMu.Unlock()
	if m.webhookFired == nil {
		m.webhookFired = map[string]bool{}
		m.webhookFiredOrder = nil
	}
	if m.webhookFired[key] {
		return false
	}
	m.webhookFired[key] = true
	m.webhookFiredOrder = append(m.webhookFiredOrder, key)
	for len(m.webhookFiredOrder) > webhookFiredCap {
		oldest := m.webhookFiredOrder[0]
		m.webhookFiredOrder = m.webhookFiredOrder[1:]
		delete(m.webhookFired, oldest)
	}
	return true
}

// clearWebhookFired re-arms a notification (used when a task leaves
// input-required, so its next question pushes again). A no-op when nothing
// was fired or the URL is unset.
func (m *Manager) clearWebhookFired(taskID, url, class string) {
	if taskID == "" || url == "" {
		return
	}
	m.taskMu.Lock()
	delete(m.webhookFired, webhookFiredKey(taskID, url, class))
	m.taskMu.Unlock()
}

// resolveTaskWebhook decides where a terminal stub notifies: the stub's own
// URL when the operator set one on the create, else the gateway-wide default.
// Empty means "nowhere" — most tasks notify nobody, and that must cost nothing.
func (m *Manager) resolveTaskWebhook(stub TaskStub) string {
	if stub.NotifyURL != "" {
		return stub.NotifyURL
	}
	return m.Config().TaskWebhook
}

// notifyTaskTerminal fires the webhook for a stub that has just gone terminal,
// at most once per (task, URL). The caller passes the stub AS ALREADY SAVED —
// the payload must reflect what a poll would return, not a stale copy.
func (m *Manager) notifyTaskTerminal(stub TaskStub) {
	if !TaskTerminal(stub.State) {
		return
	}
	url := m.resolveTaskWebhook(stub)
	if url == "" {
		return
	}
	if !m.markWebhookFired(webhookFiredKey(stub.TaskID, url, webhookClassTerminal)) {
		return
	}
	go m.deliverTaskWebhook(stub, url)
}

// notifyTaskInputRequired fires the webhook for a task that just entered
// input-required. The payload is the task itself on the executing edge (the
// operator there is being told a peer's work needs a human answer) or the
// stub on the creating edge (its operator is being told the same thing about
// work it handed out). Once per entry into the state; the resume path re-arms.
func (m *Manager) notifyTaskInputRequired(payload any, url string) {
	if url == "" {
		return
	}
	taskID := ""
	switch value := payload.(type) {
	case Task:
		taskID = value.TaskID
	case TaskStub:
		taskID = value.TaskID
	}
	if taskID == "" {
		return
	}
	if !m.markWebhookFired(webhookFiredKey(taskID, url, webhookClassInput)) {
		return
	}
	go m.deliverTaskInputWebhook(payload, url)
}

// deliverTaskInputWebhook marshals and POSTs an input-required notification.
// A stub payload may predate the question (the state event carries no content
// by design), so the question is fetched from the owning edge first — a
// notification that says "input needed" without the question sends the
// receiver straight back to polling, which is what the webhook exists to
// avoid. A task payload already carries it.
func (m *Manager) deliverTaskInputWebhook(payload any, url string) {
	if stub, ok := payload.(TaskStub); ok && stub.PendingInput == "" && !stub.CompletedSync {
		if refreshed, _, err := m.RefreshTaskStub(context.Background(), stub.TaskID, 0); err == nil {
			stub = refreshed
			payload = stub
		} else {
			m.logger.Warn("task input webhook could not fetch the question before delivery",
				"task", stub.TaskID, "error", err)
		}
	}
	taskID, state := "", TaskInputRequired
	switch value := payload.(type) {
	case Task:
		taskID, state = value.TaskID, value.State
	case TaskStub:
		taskID, state = value.TaskID, value.State
	}
	body, err := json.Marshal(payload)
	if err != nil {
		m.logger.Warn("task webhook payload could not be encoded", "task", taskID, "error", err)
		return
	}
	m.deliverWebhookBody(body, taskID, state, url)
}

// deliverTaskWebhook signs and POSTs the stub, with retries. The payload is
// the stub as JSON — the same object a poll returns, so a consumer needs one
// parser for both paths.
func (m *Manager) deliverTaskWebhook(stub TaskStub, url string) {
	// The state event that triggered this notification carries no result —
	// results never ride events — and the point of a webhook is that the
	// receiver does not have to poll afterwards. Fetch the answer from the
	// owning edge first (a store read for it, one dispatch for us). A failed
	// fetch still delivers the state: a completion notification with the
	// result one poll away beats no notification, and the refresh caches the
	// result either way.
	if len(stub.Result) == 0 && !stub.CompletedSync && stub.State == TaskCompleted {
		if refreshed, _, err := m.RefreshTaskStub(context.Background(), stub.TaskID, 0); err == nil {
			stub = refreshed
		} else {
			m.logger.Warn("task webhook could not fetch the result before delivery",
				"task", stub.TaskID, "error", err)
		}
	}
	body, err := json.Marshal(stub)
	if err != nil {
		m.logger.Warn("task webhook payload could not be encoded", "task", stub.TaskID, "error", err)
		return
	}
	m.deliverWebhookBody(body, stub.TaskID, stub.State, url)
}

// deliverWebhookBody signs and POSTs one notification, with retries. Identity
// headers are the same trio the envelope protocol carries, so a receiver
// verifies input pushes and terminal pushes with one code path.
func (m *Manager) deliverWebhookBody(body []byte, taskID string, state TaskState, url string) {
	identity := m.Identity()
	if identity == nil {
		return
	}
	signature := identity.SignBytes(body)

	observability.Usage.MeshTaskWebhookTotal.Add(1)
	var lastErr error
	for attempt := 1; attempt <= webhookAttempts; attempt++ {
		if attempt > 1 {
			time.Sleep(webhookRetryDelay)
		}
		ctx, cancel := context.WithTimeout(context.Background(), webhookAttemptTimeout)
		request, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
		if err != nil {
			cancel()
			m.logger.Warn("task webhook URL is not usable", "task", taskID, "url", url, "error", err)
			observability.Usage.MeshTaskWebhookFailedTotal.Add(1)
			return
		}
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set(WebhookHeaderAgent, identity.AgentID)
		request.Header.Set(WebhookHeaderFingerprint, identity.Fingerprint)
		request.Header.Set(WebhookHeaderPublicKey, base64.StdEncoding.EncodeToString([]byte(identity.PublicKeyPEM)))
		request.Header.Set(WebhookHeaderSignature, signature)
		request.Header.Set(WebhookHeaderTaskID, taskID)
		request.Header.Set(WebhookHeaderTaskState, string(state))

		response, err := m.webhookClient().Do(request)
		// Cancel on every path — a returned 2xx must not leak the context's
		// timer for its remaining ten seconds.
		cancel()
		if err == nil {
			_ = response.Body.Close()
			if response.StatusCode >= 200 && response.StatusCode < 300 {
				return
			}
			lastErr = fmt.Errorf("receiver answered %s", http.StatusText(response.StatusCode))
		} else {
			lastErr = err
		}
		m.logger.Warn("task webhook delivery failed",
			"task", taskID, "url", url, "attempt", attempt,
			"of", webhookAttempts, "error", lastErr)
	}
	observability.Usage.MeshTaskWebhookFailedTotal.Add(1)
	m.logger.Warn("task webhook delivery gave up",
		"task", taskID, "url", url, "attempts", webhookAttempts, "error", lastErr)
}

// webhookClient is the one HTTP client webhooks use, so its timebounds are set
// in one place. Built lazily because a manager without a mesh identity (never
// started) must not have sockets lying around.
func (m *Manager) webhookClient() *http.Client {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.webhookHTTP == nil {
		m.webhookHTTP = &http.Client{Timeout: webhookAttemptTimeout}
	}
	return m.webhookHTTP
}

// Identity returns the mesh identity of this gateway, for signing.
func (m *Manager) Identity() *Identity {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.identity
}

// ResetWebhookDelivery clears the once-only set — a test seam, so one manager
// can exercise the same (task, URL) twice across cases.
func (m *Manager) ResetWebhookDelivery() {
	m.taskMu.Lock()
	m.webhookFired = nil
	m.webhookFiredOrder = nil
	m.taskMu.Unlock()
}
