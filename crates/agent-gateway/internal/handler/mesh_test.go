package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/liveagent/agent-gateway/internal/mesh"
)

func meshHandlerManager() *mesh.Manager {
	// The shipping configuration: disabled, so nothing connects anywhere.
	return mesh.NewManager(mesh.DefaultConfig(), nil)
}

func perform(t *testing.T, handler http.HandlerFunc, method, body string, pathValues map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	var reader *strings.Reader
	if body == "" {
		reader = strings.NewReader("")
	} else {
		reader = strings.NewReader(body)
	}
	request := httptest.NewRequest(method, "/", reader)
	for key, value := range pathValues {
		request.SetPathValue(key, value)
	}
	recorder := httptest.NewRecorder()
	handler(recorder, request)
	return recorder
}

func decodeBody(t *testing.T, recorder *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var payload map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode body %q: %v", recorder.Body.String(), err)
	}
	return payload
}

func TestMeshStatusReportsDisabledBridge(t *testing.T) {
	recorder := perform(t, MeshStatus(meshHandlerManager()), http.MethodGet, "", nil)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", recorder.Code)
	}
	payload := decodeBody(t, recorder)
	if payload["enabled"] != false {
		t.Fatalf("enabled = %v, want false", payload["enabled"])
	}
	if payload["connected"] != false {
		t.Fatalf("connected = %v, want false", payload["connected"])
	}
}

func TestMeshHealthReportsDisabledBridge(t *testing.T) {
	recorder := perform(t, MeshHealth(meshHandlerManager()), http.MethodGet, "", nil)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", recorder.Code)
	}
	if payload := decodeBody(t, recorder); payload["enabled"] != false {
		t.Fatalf("enabled = %v, want false", payload["enabled"])
	}
}

func TestMeshOperationsReturnServiceUnavailableWhenNotConnected(t *testing.T) {
	manager := meshHandlerManager()
	cases := []struct {
		name    string
		handler http.HandlerFunc
		method  string
		body    string
	}{
		{"discover", MeshDiscover(manager), http.MethodGet, ""},
		{"register", MeshRegister(manager), http.MethodPost, ""},
		{"dispatch", MeshDispatch(manager), http.MethodPost, `{"target":"peer","skill":"ping"}`},
		{"emit", MeshEmit(manager), http.MethodPost, `{"type":"deploy.done"}`},
		{"subscribe", MeshSubscribe(manager), http.MethodPost, `{"subject":"deploy.>"}`},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			recorder := perform(t, testCase.handler, testCase.method, testCase.body, nil)
			if recorder.Code != http.StatusServiceUnavailable {
				t.Fatalf("status = %d, want 503 (body %s)", recorder.Code, recorder.Body.String())
			}
		})
	}
}

func TestMeshDispatchValidatesInput(t *testing.T) {
	manager := meshHandlerManager()
	for _, body := range []string{
		`not json`,
		`{}`,
		`{"target":"peer"}`,
		`{"skill":"ping"}`,
	} {
		recorder := perform(t, MeshDispatch(manager), http.MethodPost, body, nil)
		if recorder.Code != http.StatusBadRequest {
			t.Fatalf("body %q: status = %d, want 400", body, recorder.Code)
		}
	}
}

func TestMeshEmitRequiresAnEventType(t *testing.T) {
	recorder := perform(t, MeshEmit(meshHandlerManager()), http.MethodPost, `{"type":"   "}`, nil)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", recorder.Code)
	}
}

func TestMeshApprovalLifecycle(t *testing.T) {
	manager := meshHandlerManager()

	// Listing starts empty.
	recorder := perform(t, MeshApprovals(manager), http.MethodGet, "", nil)
	if recorder.Code != http.StatusOK {
		t.Fatalf("list status = %d, want 200", recorder.Code)
	}
	if payload := decodeBody(t, recorder); payload["count"] != float64(0) {
		t.Fatalf("count = %v, want 0", payload["count"])
	}

	// Open a request.
	recorder = perform(t, MeshApprovals(manager), http.MethodPost, `{"target":"peer","skill":"deploy"}`, nil)
	if recorder.Code != http.StatusAccepted {
		t.Fatalf("create status = %d, want 202 (body %s)", recorder.Code, recorder.Body.String())
	}
	approvalID, _ := decodeBody(t, recorder)["approvalId"].(string)
	if approvalID == "" {
		t.Fatal("approvalId must be returned")
	}

	recorder = perform(t, MeshApprovals(manager), http.MethodGet, "", nil)
	if payload := decodeBody(t, recorder); payload["count"] != float64(1) {
		t.Fatalf("pending count = %v, want 1", payload["count"])
	}

	// Approve it.
	recorder = perform(t, MeshApprovalDecision(manager), http.MethodPost,
		`{"approver":"operator","decision":"approve","reason":"ok"}`,
		map[string]string{"id": approvalID})
	if recorder.Code != http.StatusOK {
		t.Fatalf("decision status = %d, want 200 (body %s)", recorder.Code, recorder.Body.String())
	}

	// A second decision on the same id conflicts.
	recorder = perform(t, MeshApprovalDecision(manager), http.MethodPost,
		`{"approver":"operator","decision":"approve"}`, map[string]string{"id": approvalID})
	if recorder.Code != http.StatusConflict {
		t.Fatalf("second decision status = %d, want 409", recorder.Code)
	}

	// An unknown id is a 404.
	recorder = perform(t, MeshApprovalDecision(manager), http.MethodPost,
		`{"approver":"operator","decision":"approve"}`, map[string]string{"id": "missing"})
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("unknown id status = %d, want 404", recorder.Code)
	}
}

func TestMeshApprovalDecisionRequiresApprover(t *testing.T) {
	manager := meshHandlerManager()
	recorder := perform(t, MeshApprovals(manager), http.MethodPost, `{"target":"peer","skill":"deploy"}`, nil)
	approvalID, _ := decodeBody(t, recorder)["approvalId"].(string)

	recorder = perform(t, MeshApprovalDecision(manager), http.MethodPost,
		`{"decision":"approve"}`, map[string]string{"id": approvalID})
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", recorder.Code)
	}
}

// Approvals must work even when the bridge itself is not connected: the
// governance queue is local state and the operator decides out of band.
func TestMeshApprovalRejectsUnknownDecisionVerb(t *testing.T) {
	manager := meshHandlerManager()
	recorder := perform(t, MeshApprovals(manager), http.MethodPost, `{"target":"peer","skill":"deploy"}`, nil)
	approvalID, _ := decodeBody(t, recorder)["approvalId"].(string)

	recorder = perform(t, MeshApprovalDecision(manager), http.MethodPost,
		`{"approver":"operator","decision":"maybe"}`, map[string]string{"id": approvalID})
	if recorder.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409", recorder.Code)
	}
}

func TestSplitQueryList(t *testing.T) {
	cases := map[string][]string{
		"":           nil,
		"   ":        nil,
		"a":          {"a"},
		"a,b":        {"a", "b"},
		" a , b ,, ": {"a", "b"},
	}
	for input, want := range cases {
		got := splitQueryList(input)
		if len(got) != len(want) {
			t.Fatalf("splitQueryList(%q) = %v, want %v", input, got, want)
		}
		for index := range want {
			if got[index] != want[index] {
				t.Fatalf("splitQueryList(%q) = %v, want %v", input, got, want)
			}
		}
	}
}
