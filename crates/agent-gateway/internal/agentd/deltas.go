package agentd

// The token-delta coalescer: streamed content deltas reach the chat ingress
// as a few small records per second instead of one per token — the cadence
// the desktop's own run mirror uses, so a live viewer of a worker turn sees
// the answer grow exactly like a desktop turn. Coalescing bounds:
//
//   - deltaFlushRunes matches the mesh task-chunk coalescing
//     (taskChunkMinRunes, internal/mesh/task_stream.go) — a viewer watching
//     the mesh chunks and a viewer watching the ingress deltas see the same
//     grain;
//   - the time bound means a slow trickle still flushes about seven times a
//     second, checked per delta (SSE cadence makes a timer redundant);
//   - a round ALWAYS flushes what it buffered before its checkpoint, so the
//     deltas and the snapshot that contains them cannot diverge.
//
// Everything rides the ingress writer's one mutex (sequence discipline by
// construction), and the whole path is best-effort: a failed delta send
// disables deltas for the run (see ingress.delta) while checkpoints and the
// terminal — the authoritative records — carry on untouched.

import (
	"strings"
	"time"
	"unicode/utf8"
)

const (
	// deltaFlushRunes is the rune count that forces a flush: 48, matching
	// the mesh chunk coalescing grain.
	deltaFlushRunes = 48
	// deltaFlushDelay bounds how long buffered deltas may wait: ~7 flushes
	// per second on a slow trickle.
	deltaFlushDelay = 150 * time.Millisecond
)

// deltaCoalescer buffers one round's content deltas and flushes them as
// ingress delta records. A nil coalescer is a no-op — the methods are
// nil-receiver-safe so the runner toggles streaming with one branch.
type deltaCoalescer struct {
	writer   *ingress
	workerID string
	round    int // 1-based, matching the desktop's round field
	buf      strings.Builder
	runes    int
	last     time.Time
}

// add buffers one streamed content delta, flushing when the grain or the
// delay bound is reached.
func (c *deltaCoalescer) add(text string) {
	if c == nil || text == "" {
		return
	}
	c.buf.WriteString(text)
	c.runes += utf8.RuneCountInString(text)
	if c.runes >= deltaFlushRunes || time.Since(c.last) >= deltaFlushDelay {
		c.flush()
	}
}

// flush emits whatever is buffered as one token delta record. Called at
// round end (before the checkpoint) so the deltas and the snapshot that
// contains them stay in order; a no-op when nothing is buffered.
func (c *deltaCoalescer) flush() {
	if c == nil || c.buf.Len() == 0 {
		return
	}
	text := c.buf.String()
	c.buf.Reset()
	c.runes = 0
	c.last = time.Now()
	// Best-effort by design: a failure inside delta disables the run's
	// deltas and returns the error for logging; the round never fails on it.
	_ = c.writer.delta(map[string]any{
		"type":  "token",
		"text":  text,
		"round": c.round,
	}, c.workerID)
}
