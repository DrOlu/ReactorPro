package agentd

// Streaming provider tests. The provider asks for server-sent events so a
// slow model is visibly slow instead of a headerless hang; these pin the
// three properties that make that safe: fragments assemble into exactly the
// completion the non-streaming path produced, silence (before or mid-stream)
// fails fast with a diagnostic, and a stream that keeps sending keepalives
// while genuinely working is never cut.

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// sseHandler serves server-sent events with a flush after each, so chunks
// really arrive as separate reads.
func sseHandler(events ...string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		flusher, _ := w.(http.Flusher)
		for _, event := range events {
			fmt.Fprintf(w, "%s\n\n", event)
			if flusher != nil {
				flusher.Flush()
			}
		}
	}
}

func TestProviderStreamsContentDeltasIntoOneAnswer(t *testing.T) {
	server := httptest.NewServer(sseHandler(
		`data: {"choices":[{"delta":{"role":"assistant","content":"Hel"}}]}`,
		`data: {"choices":[{"delta":{"content":"lo, "}}]}`,
		`data: {"choices":[{"delta":{"content":"world"}}]}`,
		`data: {"choices":[{"delta":{},"finish_reason":"stop"}]}`,
		"data: [DONE]",
	))
	t.Cleanup(server.Close)

	provider := NewProvider(server.URL, "test-key", "test-model", 64, 5*time.Second)
	completion, err := provider.Complete(t.Context(), []Message{{Role: "user", Content: "hi"}}, nil)
	if err != nil {
		t.Fatalf("Complete: %v", err)
	}
	if completion.Text != "Hello, world" {
		t.Fatalf("text = %q, want the assembled deltas", completion.Text)
	}
	if !completion.FinishFlow {
		t.Fatalf("finish flow = false, want true for finish_reason stop")
	}
	if len(completion.ToolCalls) != 0 {
		t.Fatalf("tool calls = %+v, want none", completion.ToolCalls)
	}
}

func TestProviderStreamsFragmentedToolCalls(t *testing.T) {
	// One call fragmented across three chunks (id/name/type once, arguments
	// in pieces) plus a second call interleaved on another index — the
	// assembly must reconstruct both, in order, byte-identical to what the
	// non-streaming response shape would have carried.
	server := httptest.NewServer(sseHandler(
		`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"write_file","arguments":"{\"pa"}}]}}]}`,
		`data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call-2","type":"function","function":{"name":"list_dir","arguments":"{\""}}]}}]}`,
		`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\":\"out.txt\",\"content\":\"x\"}"}}]}}]}`,
		`data: {"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"arguments":"path\":\".\"}"}}]}}]}`,
		`data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}`,
		"data: [DONE]",
	))
	t.Cleanup(server.Close)

	provider := NewProvider(server.URL, "test-key", "test-model", 64, 5*time.Second)
	completion, err := provider.Complete(t.Context(), []Message{{Role: "user", Content: "hi"}}, nil)
	if err != nil {
		t.Fatalf("Complete: %v", err)
	}
	if len(completion.ToolCalls) != 2 {
		t.Fatalf("tool calls = %+v, want two", completion.ToolCalls)
	}
	first := completion.ToolCalls[0]
	if first.ID != "call-1" || first.Type != "function" || first.Function.Name != "write_file" {
		t.Fatalf("first call = %+v, want the assembled call-1 write_file", first)
	}
	if want := `{"path":"out.txt","content":"x"}`; first.Function.Arguments != want {
		t.Fatalf("first arguments = %q, want %q", first.Function.Arguments, want)
	}
	second := completion.ToolCalls[1]
	if second.ID != "call-2" || second.Function.Name != "list_dir" {
		t.Fatalf("second call = %+v, want the assembled call-2 list_dir", second)
	}
	if want := `{"path":"."}`; second.Function.Arguments != want {
		t.Fatalf("second arguments = %q, want %q", second.Function.Arguments, want)
	}
	if completion.FinishFlow {
		t.Fatalf("finish flow = true, want false for finish_reason tool_calls")
	}
	if completion.Text != "" {
		t.Fatalf("text = %q, want none", completion.Text)
	}
}

func TestProviderFailsFastWhenTheStreamGoesSilent(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, ": keepalive\n\n")
		if flusher, ok := w.(http.Flusher); ok {
			flusher.Flush()
		}
		time.Sleep(3 * time.Second) // the stall this whole change exists for
	}))
	t.Cleanup(server.Close)

	provider := NewProvider(server.URL, "test-key", "test-model", 64, 300*time.Millisecond)
	started := time.Now()
	_, err := provider.Complete(t.Context(), []Message{{Role: "user", Content: "hi"}}, nil)
	if err == nil {
		t.Fatal("Complete succeeded against a stalled stream")
	}
	if !strings.Contains(err.Error(), "stalled") {
		t.Fatalf("error = %v, want a stall diagnostic", err)
	}
	if elapsed := time.Since(started); elapsed > 2*time.Second {
		t.Fatalf("took %s to fail; the idle timeout must fire fast", elapsed)
	}
}

func TestProviderFailsFastWhenHeadersNeverArrive(t *testing.T) {
	// The outage shape exactly: the provider accepts the connection and
	// then never sends a byte. The watchdog covers the pre-header phase too.
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(3 * time.Second)
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	t.Cleanup(server.Close)

	provider := NewProvider(server.URL, "test-key", "test-model", 64, 300*time.Millisecond)
	started := time.Now()
	_, err := provider.Complete(t.Context(), []Message{{Role: "user", Content: "hi"}}, nil)
	if err == nil {
		t.Fatal("Complete succeeded against a provider that never answered")
	}
	if !strings.Contains(err.Error(), "stalled") {
		t.Fatalf("error = %v, want a stall diagnostic", err)
	}
	if elapsed := time.Since(started); elapsed > 2*time.Second {
		t.Fatalf("took %s to fail; the idle timeout must fire fast", elapsed)
	}
}

func TestProviderToleratesKeepalivesOnASlowStream(t *testing.T) {
	// Slow but alive: keepalive comments trickle while the provider works,
	// then the answer streams. The idle timeout must not cut a live stream.
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		flusher, _ := w.(http.Flusher)
		for i := 0; i < 10; i++ {
			fmt.Fprint(w, ": keepalive\n\n")
			if flusher != nil {
				flusher.Flush()
			}
			time.Sleep(60 * time.Millisecond)
		}
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"worth the wait\"}}]}\n\n")
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n")
		fmt.Fprint(w, "data: [DONE]\n\n")
		if flusher != nil {
			flusher.Flush()
		}
	}))
	t.Cleanup(server.Close)

	provider := NewProvider(server.URL, "test-key", "test-model", 64, 500*time.Millisecond)
	completion, err := provider.Complete(t.Context(), []Message{{Role: "user", Content: "hi"}}, nil)
	if err != nil {
		t.Fatalf("Complete: %v (a keepalive-fed stream must not be cut)", err)
	}
	if completion.Text != "worth the wait" {
		t.Fatalf("text = %q, want the streamed answer", completion.Text)
	}
}

func TestProviderServesAPlainJSONCompletion(t *testing.T) {
	// A provider that ignores the stream flag and answers with a whole JSON
	// completion must still work — this is also the shape every existing
	// test stub serves.
	var requestedStream bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			Stream bool `json:"stream"`
		}
		_ = json.NewDecoder(r.Body).Decode(&request)
		requestedStream = request.Stream
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"plain answer","tool_calls":null}}]}`)
	}))
	t.Cleanup(server.Close)

	provider := NewProvider(server.URL, "test-key", "test-model", 64, 5*time.Second)
	completion, err := provider.Complete(t.Context(), []Message{{Role: "user", Content: "hi"}}, nil)
	if err != nil {
		t.Fatalf("Complete: %v", err)
	}
	if !requestedStream {
		t.Fatal("the provider must ask for a streamed completion")
	}
	if completion.Text != "plain answer" || !completion.FinishFlow {
		t.Fatalf("completion = %+v, want the JSON answer with finish flow", completion)
	}
}
