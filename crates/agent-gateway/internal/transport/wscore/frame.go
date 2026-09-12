// Package wscore provides the connection runtime shared by the v2 WebSocket protocol (dual
// priority-queue write pump, dual frame-count/byte limits, idle eviction and heartbeat).
// It is agnostic to frame format: frames are enqueued as already-encoded bytes, and the
// protocol layer is responsible for encoding and declaring the congestion policy (Frame.Class);
// the first underlying write error immediately closes the connection and hands off to reconnect recovery.
package wscore

import "errors"

// ErrWriteQueueFull indicates a frame was dropped due to sustained congestion; the protocol layer can use this to degrade and recover a single stream without sacrificing the whole connection.
var ErrWriteQueueFull = errors.New("write queue full")

// ErrWriteFrameTooLarge indicates a single frame itself already exceeds its queue's byte budget, and continuing to wait will not recover it.
var ErrWriteFrameTooLarge = errors.New("write frame exceeds queue byte limit")

// FrameClass determines a frame's enqueue queue and congestion policy.
type FrameClass uint8

const (
	// FrameData is droppable event/broadcast data: goes through the data queue, and is dropped with ErrWriteQueueFull under sustained congestion.
	FrameData FrameClass = iota
	// FrameControl is a best-effort control frame: goes through the priority queue past data backlog; under sustained congestion it is dropped with an error but does not close the connection.
	FrameControl
	// FramePing is a periodic heartbeat: goes through the priority queue, and is silently dropped when the queue is full (replaced next period).
	FramePing
	// FrameResponse is a request-correlated response: silent dropping would hang the client until timeout, so sustained congestion closes the connection to force a reconnect retry.
	FrameResponse
)

// Frame is a single-frame description carried by the write pump, with an already-encoded byte payload.
type Frame struct {
	Class FrameClass
	// RequestID is the request id of the correlated response, used for diagnostics only.
	RequestID string
	// Kind is the frame type label (v2 oneof arm name / v2 oneof arm name), used only for drop logs and test assertions.
	Kind string
	// MessageType is websocket.TextMessage or websocket.BinaryMessage.
	MessageType int
	// Data is the complete already-encoded frame payload.
	Data []byte
}
