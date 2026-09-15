package mesh

// Unit coverage for the chunk machinery: the emitter's coalescing and terminal
// tail, the bounded tail ring, and the opt-in rule (a task that did not ask
// for streaming never gets an emitter). The wire behaviour — chunks arriving
// in order on the event subject, the terminal chunk, the stub never corrupted
// by chunk events — lives in task_integration_test.go.

import (
	"strings"
	"testing"
	"time"
)

func TestChunkStreamCoalescesSmallDeltasAndNumbersThem(t *testing.T) {
	var stream taskChunkStream
	var flushed []TaskChunk
	flush := func(seq int, text string, last bool) {
		flushed = append(flushed, TaskChunk{Seq: seq, Text: text, Last: last})
	}

	// Below the coalescing threshold: buffered, nothing flushed.
	stream.feed(strings.Repeat("a", 40), flush)
	if len(flushed) != 0 {
		t.Fatalf("a small delta must buffer, got %d flushes", len(flushed))
	}
	// Crossing the threshold flushes the whole buffer as one chunk.
	stream.feed(strings.Repeat("b", 20), flush)
	if len(flushed) != 1 || flushed[0].Seq != 1 || flushed[0].Text != strings.Repeat("a", 40)+strings.Repeat("b", 20) {
		t.Fatalf("crossing the threshold should flush the whole buffer: %+v", flushed)
	}
	if flushed[0].Last {
		t.Fatal("a growth chunk is never last")
	}
	// The terminal chunk carries the unflushed buffer (empty here: the feed
	// flushed everything) plus the result's tail, and is the only chunk that
	// says last.
	stream.close(strings.Repeat("a", 40)+strings.Repeat("b", 20)+" and that is all.", flush)
	if len(flushed) != 2 {
		t.Fatalf("close should flush exactly the terminal chunk: %+v", flushed)
	}
	if !flushed[1].Last || flushed[1].Text != " and that is all." {
		t.Fatalf("terminal chunk wrong: %+v", flushed[1])
	}
}

func TestChunkStreamTerminalChunkSurvivesARewrittenResult(t *testing.T) {
	// capRemoteTaskOutput can truncate the result, or a projection can rewrite:
	// when the result does not extend the streamed text, the last chunk closes
	// the stream without repeating content — task.result is the truth.
	var stream taskChunkStream
	var last TaskChunk
	stream.feed(strings.Repeat("x", 64), func(seq int, text string, l bool) {
		if l {
			last = TaskChunk{Seq: seq, Text: text, Last: l}
		}
	})
	stream.close("totally different", func(seq int, text string, l bool) {
		if l {
			last = TaskChunk{Seq: seq, Text: text, Last: l}
		}
	})
	if !last.Last || last.Text != "" {
		t.Fatalf("a rewritten result should close with an empty tail, got %+v", last)
	}
}

func TestTaskTailRingReturnsTheLastChunksOldestFirst(t *testing.T) {
	invoker := &recordingInvoker{result: LocalInvokeResult{}}
	manager, _ := taskTestManager(t, invoker, nil)

	for i := 1; i <= 10; i++ {
		manager.emitTaskChunk("caller/1", "ring-1", i, "x", i == 10)
	}
	tail := manager.taskTail("caller/1", "ring-1", 4)
	if len(tail) != 4 {
		t.Fatalf("tail should return the last 4 chunks, got %d", len(tail))
	}
	if tail[0].Seq != 7 || tail[3].Seq != 10 || !tail[3].Last {
		t.Fatalf("tail order/content wrong: %+v", tail)
	}
	// A tenant's ring is not another tenant's, even with the same task id.
	if got := manager.taskTail("caller/2", "ring-1", 4); got != nil {
		t.Fatalf("rings must be per-caller, got %+v", got)
	}
	if got := manager.taskTail("caller/1", "ring-1", 0); got != nil {
		t.Fatalf("a zero tail is no tail, got %+v", got)
	}
}

func TestStreamingIsOptInPerTask(t *testing.T) {
	invoker := &recordingInvoker{result: LocalInvokeResult{OK: true}}
	manager, store := taskTestManager(t, invoker, nil)
	meta := verifiedCaller()

	// Without stream:true there is no emitter and never a chunk.
	request := asyncInput("quiet-1")
	if _, err := manager.startAsyncTask(request, meta, LocalAgent{ID: "agent-1"}); err != nil {
		t.Fatalf("startAsyncTask: %v", err)
	}
	if manager.taskStreamFor(meta.From, "quiet-1") != nil {
		t.Fatal("a task that did not opt in must not get a streamer")
	}
	pollTask(t, store, meta.From, "quiet-1", TaskCompleted)
	if tail := manager.taskTail(meta.From, "quiet-1", 8); tail != nil {
		t.Fatalf("a non-streaming task must leave no chunks, got %+v", tail)
	}

	// With stream:true the emitter exists for the run and is cleaned up at the
	// terminal — a stream ends exactly once. The cleanup runs just after the
	// state write, so wait for it rather than racing.
	request = asyncInput("loud-1")
	request.Stream = true
	if _, err := manager.startAsyncTask(request, meta, LocalAgent{ID: "agent-1"}); err != nil {
		t.Fatalf("startAsyncTask: %v", err)
	}
	pollTask(t, store, meta.From, "loud-1", TaskCompleted)
	deadline := time.Now().Add(2 * time.Second)
	for manager.taskStreamFor(meta.From, "loud-1") != nil && time.Now().Before(deadline) {
		time.Sleep(2 * time.Millisecond)
	}
	if manager.taskStreamFor(meta.From, "loud-1") != nil {
		t.Fatal("a finished task must not keep an emitter")
	}
}
