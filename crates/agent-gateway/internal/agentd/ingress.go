package agentd

// The reliable chat ingress, from the producing side. This is the exact
// contract the gateway's session layer enforces (internal/session/
// conversation_reliable_ingress.go), mirrored here rather than invented:
//
//   - every record consumes exactly one logical sequence number; batches must
//     be contiguous (first_seq == committed_through + 1);
//   - a checkpoint's covers_through_seq must equal its own producer seq minus
//     one, and revisions must advance monotonically per run;
//   - the projection payload is the entries JSON, zstd-compressed, with its
//     sha256 and uncompressed size;
//   - a delta's event_json must be a JSON object with a "type"; the lifecycle
//     types (run_started, run_finished, run_content_snapshot, done, error) are
//     reserved and must not ride a delta; "run_heartbeat" is a liveness touch
//     that keeps a long run from being judged stale;
//   - terminal states are exactly completed, failed, cancelled.
//
// The entries JSON is the same ChatEntry shape the desktop's transcript uses
// ({"id", "kind", "text"}), because the gateway's answer extraction — and
// therefore the mesh's task results — reads that shape.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sync"

	"github.com/klauspost/compress/zstd"
	"github.com/liveagent/agent-gateway/internal/proto/v2"
)

// Entry is one transcript entry in the desktop's ChatEntry shape.
type Entry struct {
	ID   string `json:"id"`
	Kind string `json:"kind"`
	Text string `json:"text"`
	// Attachments rides on user entries as an empty array. It is load-bearing
	// for the webui: its snapshot validation requires an attachments ARRAY on
	// every user entry and silently discards the whole projection when one is
	// missing — the desktop's entries have always carried it, so a worker's
	// minimal entries rendered as a prompt with no answer. A pointer with
	// omitempty keeps every other entry byte-identical to today.
	Attachments *[]any `json:"attachments,omitempty"`
}

// userEntry builds the turn's user record with the empty attachments array
// the webui's projection validation requires (see Entry.Attachments).
func userEntry(id, text string) Entry {
	attachments := []any{}
	return Entry{ID: id, Kind: KindUser, Text: text, Attachments: &attachments}
}

// Entry kinds, matching the desktop transcript's vocabulary so a conversation
// an agentd ran renders correctly in the gateway's own tooling.
const (
	KindUser       = "user"
	KindAssistant  = "assistant"
	KindToolCall   = "tool_call"
	KindToolResult = "tool_result"
)

// encoder is the process-level zstd encoder; one is enough and it is safe for
// concurrent use.
var zstdEncoder *zstd.Encoder

func init() {
	zstdEncoder, _ = zstd.NewWriter(nil)
}

// projection is one compressible snapshot of a run's transcript.
type projection struct {
	compressed []byte
	sha256Hex  string
	raw        []byte
}

// newProjection compresses the entries JSON and records its hash and size —
// the three fields the gateway verifies before it trusts a payload.
func newProjection(entries []Entry) (projection, error) {
	raw, err := json.Marshal(entries)
	if err != nil {
		return projection{}, err
	}
	compressed := zstdEncoder.EncodeAll(raw, nil)
	sum := sha256.Sum256(raw)
	return projection{
		compressed: compressed,
		sha256Hex:  hex.EncodeToString(sum[:]),
		raw:        raw,
	}, nil
}

// ingress is the per-run writer. It enforces the sequence discipline by
// construction: one mutex, one cursor, and the record is BUILT with the
// sequence number it will carry — under the same lock — because the gateway
// validates covers_through_seq against the record's own position. The turn
// goroutine and the heartbeat goroutine both emit through here; the lock is
// what makes them one disciplined producer instead of two racing ones
// (duplicate sequence numbers were a real bug here, caught by the e2e suite).
type ingress struct {
	mu             sync.Mutex
	runID          string
	conversationID string
	nextSeq        uint64
	revision       uint64
	send           func(seq uint64, record *gatewayv2.ChatIngressRecord) error
}

func newIngress(runID, conversationID string, send func(seq uint64, record *gatewayv2.ChatIngressRecord) error) *ingress {
	return &ingress{
		runID:          runID,
		conversationID: conversationID,
		nextSeq:        1,
		send:           send,
	}
}

// emit claims the next sequence number and sends the record built with it.
// An error here is a turn-ending failure: the gateway can no longer be told
// about the run's progress, so continuing would produce a run that ends
// nowhere.
func (i *ingress) emit(build func(seq, revision uint64) *gatewayv2.ChatIngressRecord) error {
	i.mu.Lock()
	defer i.mu.Unlock()
	seq := i.nextSeq
	i.nextSeq++
	i.revision++
	return i.send(seq, build(seq, i.revision))
}

// heartbeat is the liveness record: it consumes a sequence number (every
// record does) but touches no transcript content.
func (i *ingress) heartbeat() error {
	return i.emit(func(_, _ uint64) *gatewayv2.ChatIngressRecord {
		return &gatewayv2.ChatIngressRecord{
			Payload: &gatewayv2.ChatIngressRecord_Heartbeat{
				Heartbeat: &gatewayv2.ChatIngressHeartbeat{},
			},
		}
	})
}

// checkpoint publishes the transcript as it stands — the record the gateway
// turns into a content_snapshot conversation event, which is what the mesh's
// task streaming derives its chunks from. A turn that checkpoints as it grows
// streams; a turn that only terminals arrives whole.
func (i *ingress) checkpoint(entries []Entry) error {
	snap, err := newProjection(entries)
	if err != nil {
		return err
	}
	return i.emit(func(seq, revision uint64) *gatewayv2.ChatIngressRecord {
		return &gatewayv2.ChatIngressRecord{
			Payload: &gatewayv2.ChatIngressRecord_Checkpoint{
				Checkpoint: &gatewayv2.ChatIngressCheckpoint{
					// Covers exactly through the record before this one —
					// the gateway validates that as seq-1.
					CoversThroughSeq:     seq - 1,
					Revision:             revision,
					CompressedProjection: snap.compressed,
					UncompressedBytes:    uint64(len(snap.raw)),
					Sha256:               snap.sha256Hex,
				},
			},
		}
	})
}

// terminal is the run's one authoritative ending record. Same covers rule as
// a checkpoint, computed under the same lock so a heartbeat can never wedge
// itself between the arithmetic and the send.
func (i *ingress) terminal(entries []Entry, state, errorCode, errorMessage string) error {
	snap, err := newProjection(entries)
	if err != nil {
		return err
	}
	return i.emit(func(seq, revision uint64) *gatewayv2.ChatIngressRecord {
		return &gatewayv2.ChatIngressRecord{
			Payload: &gatewayv2.ChatIngressRecord_Terminal{
				Terminal: &gatewayv2.ChatIngressTerminal{
					CoversThroughSeq:     seq - 1,
					Revision:             revision,
					CompressedProjection: snap.compressed,
					UncompressedBytes:    uint64(len(snap.raw)),
					Sha256:               snap.sha256Hex,
					ContentComplete:      true,
					State:                state,
					ErrorCode:            errorCode,
					ErrorMessage:         errorMessage,
				},
			},
		}
	})
}

// terminalStates are the only terminal states the gateway accepts; kept here
// so the runner cannot invent one.
const (
	TerminalCompleted = "completed"
	TerminalFailed    = "failed"
	TerminalCancelled = "cancelled"
)
