package mesh

// The streaming half of the task lifecycle.
//
// A task's state events answer "how is it going". Chunks answer "what is it
// saying": the assistant text's growth, as the desktop commits conversation
// snapshots, published as ordered chunks on mesh.event.task.<id>.chunk and
// kept in a small ring so a late or reconnecting listener can read the tail
// through task.get.
//
// Streaming is opt-in per task (invoke input "stream": true) and shares the
// plaintext posture of the rest of the mesh: a dispatch's prompt and reply are
// already visible to whoever can subscribe the NATS, and chunks are no wider
// than that. A task that does not opt in emits state events only, exactly as
// before — results never ride events uninvited.

import (
	"context"
	"strings"
	"unicode/utf8"
)

// TaskChunk is one ordered piece of a streamed task's assistant text. Seq is
// per-task and starts at 1; Last marks the terminal chunk (which may carry
// empty text — its job is to say the stream is over).
type TaskChunk struct {
	Seq  int    `json:"seq"`
	Text string `json:"text"`
	Last bool   `json:"last"`
}

// taskChunkEvent is the wire payload published on mesh.event.task.<id>.chunk.
type taskChunkEvent struct {
	TaskID string `json:"task_id"`
	Seq    int    `json:"seq"`
	Text   string `json:"text"`
	Last   bool   `json:"last"`
}

// TaskWithChunks is a task plus its recent chunk tail, the shape task.get
// answers with when a tail is requested. Embedding keeps the plain task's
// field names, so a tail-less read is the same object as before.
type TaskWithChunks struct {
	Task
	Chunks []TaskChunk `json:"chunks,omitempty"`
}

const (
	// taskChunkMinRunes coalesces snapshot growth into chunks worth waking a
	// listener for. Snapshots arrive at the desktop's checkpoint cadence; a
	// slow turn would otherwise dribble single-character chunks.
	taskChunkMinRunes = 48
	// taskChunkRingMax bounds the per-task tail ring. The full text lives in
	// the task's result; the ring exists for progress views and reconnects.
	taskChunkRingMax = 128
	// taskChunkTasksMax bounds how many tasks keep a ring at all, so a busy
	// edge cannot accumulate one per task ever created. Oldest task out.
	taskChunkTasksMax = 256
)

// taskChunkStream turns the session layer's raw growth deltas into ordered,
// bounded chunks and the terminal tail. The emitter state lives here; the
// manager owns publication and the ring.
type taskChunkStream struct {
	seq     int
	emitted string
	buffer  string
}

// feed accumulates a growth delta and flushes a chunk when it is big enough.
func (s *taskChunkStream) feed(delta string, flush func(seq int, text string, last bool)) {
	s.buffer += delta
	if utf8.RuneCountInString(s.buffer) < taskChunkMinRunes {
		return
	}
	s.seq++
	flush(s.seq, s.buffer, false)
	s.emitted += s.buffer
	s.buffer = ""
}

// close emits the terminal chunk: the stream's unflushed buffer plus whatever
// the canonical result adds beyond everything streamed. When the result is not
// an extension of the stream — capRemoteTaskOutput truncated it, or the
// projection rewrote — the last chunk closes the stream without repeating
// content: task.result is the truth, and the chunk stream is a progress view.
func (s *taskChunkStream) close(resultText string, flush func(seq int, text string, last bool)) {
	streamed := s.emitted + s.buffer
	tail := s.buffer
	if strings.HasPrefix(resultText, streamed) {
		tail += resultText[len(streamed):]
	}
	s.seq++
	flush(s.seq, tail, true)
}

// startTaskStream registers the emitter for a task that opted into streaming.
func (m *Manager) startTaskStream(caller, taskID string) *taskChunkStream {
	key := taskKey(caller, taskID)
	stream := &taskChunkStream{}
	m.taskMu.Lock()
	defer m.taskMu.Unlock()
	if m.taskStreams == nil {
		m.taskStreams = map[string]*taskChunkStream{}
	}
	m.taskStreams[key] = stream
	return stream
}

// taskStreamFor returns the task's emitter, or nil when it did not opt in.
func (m *Manager) taskStreamFor(caller, taskID string) *taskChunkStream {
	m.taskMu.Lock()
	defer m.taskMu.Unlock()
	return m.taskStreams[taskKey(caller, taskID)]
}

// closeTaskStream finishes a stream: the terminal chunk (see close), then the
// emitter goes away. The ring stays for tail reads until it is bounded out.
func (m *Manager) closeTaskStream(caller, taskID, resultText string) {
	stream := m.taskStreamFor(caller, taskID)
	if stream == nil {
		return
	}
	m.taskMu.Lock()
	delete(m.taskStreams, taskKey(caller, taskID))
	m.taskMu.Unlock()
	stream.close(resultText, func(seq int, text string, last bool) {
		m.emitTaskChunk(caller, taskID, seq, text, last)
	})
}

// emitTaskChunk records a chunk in the tail ring and publishes it.
func (m *Manager) emitTaskChunk(caller, taskID string, seq int, text string, last bool) {
	key := taskKey(caller, taskID)
	m.taskMu.Lock()
	if m.taskChunks == nil {
		m.taskChunks = map[string][]TaskChunk{}
		m.taskChunkOrder = nil
	}
	ring, seen := m.taskChunks[key]
	if !seen {
		m.taskChunkOrder = append(m.taskChunkOrder, key)
	}
	ring = append(ring, TaskChunk{Seq: seq, Text: text, Last: last})
	if len(ring) > taskChunkRingMax {
		ring = ring[len(ring)-taskChunkRingMax:]
	}
	m.taskChunks[key] = ring
	// Bound the number of tasks with rings: oldest out. Deletion removes the
	// map entry; stale keys in the order slice are skipped when reached.
	for len(m.taskChunkOrder) > taskChunkTasksMax {
		oldest := m.taskChunkOrder[0]
		m.taskChunkOrder = m.taskChunkOrder[1:]
		if _, still := m.taskChunks[oldest]; still && oldest != key {
			delete(m.taskChunks, oldest)
		}
	}
	m.taskMu.Unlock()

	if agent, err := m.requireAgent(); err == nil {
		if err := agent.Emit(context.Background(), "task."+taskID+".chunk", taskChunkEvent{
			TaskID: taskID,
			Seq:    seq,
			Text:   text,
			Last:   last,
		}); err != nil {
			m.logger.Warn("could not publish a task chunk", "task", taskID, "seq", seq, "error", err)
		}
	}
}

// taskTail returns the last `limit` chunks of a task's ring, oldest first.
func (m *Manager) taskTail(caller, taskID string, limit int) []TaskChunk {
	if limit <= 0 {
		return nil
	}
	m.taskMu.Lock()
	defer m.taskMu.Unlock()
	ring := m.taskChunks[taskKey(caller, taskID)]
	if len(ring) > limit {
		ring = ring[len(ring)-limit:]
	}
	if len(ring) == 0 {
		return nil
	}
	out := make([]TaskChunk, len(ring))
	copy(out, ring)
	return out
}
