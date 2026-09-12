package wscore

import (
	"errors"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"

	"github.com/liveagent/agent-gateway/internal/observability"
)

// Write-pump behaviour constants; keep the existing stable values.
const (
	// DefaultQueueSize is the default capacity of the data queue.
	DefaultQueueSize = 512
	// DefaultCtrlQueueSize is the default capacity of the control queue.
	DefaultCtrlQueueSize = 64
	// DefaultQueueBytes / DefaultCtrlQueueBytes bound the queues by both frame count and byte count.
	DefaultQueueBytes     = 8 * 1024 * 1024
	DefaultCtrlQueueBytes = 256 * 1024

	defaultHeartbeatPeriod  = 15 * time.Second
	heartbeatGraceFloor     = 5 * time.Second
	defaultControlWriteWait = 10 * time.Second
	// writeLoopBatchSize is the maximum number of frames written back-to-back per wake-up
	// (control frames are interleaved with priority).
	writeLoopBatchSize = 64
)

// Config holds the behaviour parameters of a connection runtime; zero-valued fields fall back to defaults.
type Config struct {
	// WriteTimeout is used both as the per-frame write timeout and as the upper bound on enqueue waits.
	WriteTimeout time.Duration
	// QueueSize / CtrlQueueSize are the capacities of the two queues.
	QueueSize     int
	CtrlQueueSize int
	// QueueBytes / CtrlQueueBytes are the memory limits of the two queues.
	QueueBytes     int64
	CtrlQueueBytes int64
	// HeartbeatPeriod / HeartbeatGrace determine the heartbeat period and the idle-eviction window
	// (IdleTimeout = 3*period + grace).
	HeartbeatPeriod time.Duration
	HeartbeatGrace  time.Duration
	// Remote is the peer identifier used in dropped-frame logs (usually RemoteAddr).
	Remote string
	// OnClose is invoked exactly once when the connection closes (done is already closed, the
	// underlying ws is not yet), letting the protocol layer clean up subscriptions and other resources.
	OnClose func()
}

// Conn is the transport runtime of a single WebSocket connection. Outbox/CtrlOutbox are produced by
// any goroutine via Enqueue and consumed by the single write-pump goroutine; the two channels are
// exported only for white-box tests, and business code always goes through Enqueue.
type Conn struct {
	// Outbox is the data queue (consumed exclusively by the write pump; do not read or write it directly outside tests).
	Outbox chan Frame
	// CtrlOutbox is the control queue; the write pump consumes it first so congestion cannot starve
	// heartbeats and stream-recovery signals.
	CtrlOutbox chan Frame

	ws  *websocket.Conn
	cfg Config

	writeMu            sync.Mutex
	droppedFrames      atomic.Int64
	writerCloses       atomic.Int64
	queueByteOverflows atomic.Int64
	dataBytes          atomic.Int64
	controlBytes       atomic.Int64
	dataFreed          chan struct{}
	controlFreed       chan struct{}
	writeOverride      func(Frame) error

	closeOnce sync.Once
	done      chan struct{}

	// authorized is set only after successful authentication; before that, inbound activity does not
	// refresh the read deadline — the client has a single IdleTimeout window to complete authentication.
	authorized atomic.Bool

	lastInboundMu sync.Mutex
	lastInboundAt time.Time

	writeLoopOnce sync.Once
	heartbeatOnce sync.Once
}

// NewConn builds a connection runtime. ws may be nil (for unit tests of enqueue semantics only).
func NewConn(ws *websocket.Conn, cfg Config) *Conn {
	if cfg.QueueSize <= 0 {
		cfg.QueueSize = DefaultQueueSize
	}
	if cfg.CtrlQueueSize <= 0 {
		cfg.CtrlQueueSize = DefaultCtrlQueueSize
	}
	if cfg.QueueBytes <= 0 {
		cfg.QueueBytes = DefaultQueueBytes
	}
	if cfg.CtrlQueueBytes <= 0 {
		cfg.CtrlQueueBytes = DefaultCtrlQueueBytes
	}
	return &Conn{
		Outbox:       make(chan Frame, cfg.QueueSize),
		CtrlOutbox:   make(chan Frame, cfg.CtrlQueueSize),
		ws:           ws,
		cfg:          cfg,
		done:         make(chan struct{}),
		dataFreed:    make(chan struct{}, 1),
		controlFreed: make(chan struct{}, 1),
	}
}

// Done returns the connection-close signal channel.
func (c *Conn) Done() <-chan struct{} {
	return c.done
}

// Close idempotently closes the connection: publish done first, run the OnClose cleanup
// callback, and finally close the underlying ws.
func (c *Conn) Close() {
	c.closeOnce.Do(func() {
		close(c.done)
		if c.cfg.OnClose != nil {
			c.cfg.OnClose()
		}
		if c.ws != nil {
			_ = c.ws.Close()
		}
	})
}

// SetAuthorized marks authentication as complete; from then on inbound activity refreshes the read deadline.
func (c *Conn) SetAuthorized() {
	c.authorized.Store(true)
}

// TouchInboundActivity records inbound activity and (after authentication) pushes back the read
// deadline; the read loop must call it on any received frame and on the WS pong callback.
func (c *Conn) TouchInboundActivity() {
	c.lastInboundMu.Lock()
	c.lastInboundAt = time.Now()
	c.lastInboundMu.Unlock()
	if !c.authorized.Load() || c.ws == nil {
		return
	}
	_ = c.ws.SetReadDeadline(time.Now().Add(c.IdleTimeout()))
}

// IdleTimeout is the idle-eviction window: 3 heartbeat periods plus grace.
func (c *Conn) IdleTimeout() time.Duration {
	period := c.cfg.HeartbeatPeriod
	if period <= 0 {
		period = defaultHeartbeatPeriod
	}
	grace := c.cfg.HeartbeatGrace
	if grace <= 0 {
		grace = heartbeatGraceFloor
	}
	return period*3 + grace
}

// ControlWriteTimeout is the time limit for enqueue waits and control-frame writes.
func (c *Conn) ControlWriteTimeout() time.Duration {
	if c.cfg.WriteTimeout > 0 {
		return c.cfg.WriteTimeout
	}
	return defaultControlWriteWait
}

// DroppedFrames returns the cumulative number of dropped frames (for observability and tests).
func (c *Conn) DroppedFrames() int64 {
	return c.droppedFrames.Load()
}

// WriterCloses returns how many times the write pump closed the connection due to an underlying write error.
func (c *Conn) WriterCloses() int64 {
	return c.writerCloses.Load()
}

// QueueByteOverflows returns how many times a frame or an aggregate queue exceeded the byte budget.
func (c *Conn) QueueByteOverflows() int64 {
	return c.queueByteOverflows.Load()
}

// Enqueue hands a frame to the write pump: control/heartbeat frames use the priority queue;
// data frames are dropped with ErrWriteQueueFull under sustained congestion; dropping a
// FrameResponse closes the connection so the client reconnects and retries instead of hanging
// until timeout.
func (c *Conn) Enqueue(frame Frame) error {
	if frame.Class == FrameControl || frame.Class == FramePing {
		err := c.enqueueControl(frame)
		if errors.Is(err, ErrWriteQueueFull) || errors.Is(err, ErrWriteFrameTooLarge) {
			c.noteDroppedFrame(frame, "control", writeQueueDropReason(err))
		}
		return err
	}
	err := c.enqueueData(frame)
	if errors.Is(err, ErrWriteQueueFull) || errors.Is(err, ErrWriteFrameTooLarge) {
		c.noteDroppedFrame(frame, "data", writeQueueDropReason(err))
		if frame.Class == FrameResponse {
			c.Close()
		}
	}
	return err
}

// enqueueData waits up to ControlWriteTimeout when the data queue is momentarily full; only
// sustained backlog reports ErrWriteQueueFull. The fast path is zero-allocation.
func (c *Conn) enqueueData(frame Frame) error {
	return c.enqueueBounded(frame, "data", c.Outbox, &c.dataBytes, c.cfg.QueueBytes, c.dataFreed)
}

func (c *Conn) enqueueControl(frame Frame) error {
	if frame.Class == FramePing {
		if c.tryEnqueueBounded(frame, "control", c.CtrlOutbox, &c.controlBytes, c.cfg.CtrlQueueBytes) {
			return nil
		}
		select {
		case <-c.done:
			return errors.New("connection closed")
		default:
			// Heartbeats are periodic: when the control queue is full, drop silently since the
			// next period will naturally replace it.
			c.noteDroppedFrame(frame, "control", "queue_full")
			return nil
		}
	}
	return c.enqueueBounded(frame, "control", c.CtrlOutbox, &c.controlBytes, c.cfg.CtrlQueueBytes, c.controlFreed)
}

func (c *Conn) enqueueBounded(
	frame Frame,
	lane string,
	queue chan<- Frame,
	queuedBytes *atomic.Int64,
	byteLimit int64,
	freed <-chan struct{},
) error {
	frameBytes := int64(len(frame.Data))
	if frameBytes > byteLimit {
		c.noteQueueByteOverflow(frameBytes, lane, "frame_too_large")
		return ErrWriteFrameTooLarge
	}
	timer := time.NewTimer(c.ControlWriteTimeout())
	defer timer.Stop()
	for {
		if reserveQueueBytes(queuedBytes, frameBytes, byteLimit) {
			select {
			case <-c.done:
				releaseQueueBytes(queuedBytes, frameBytes, nil)
				return errors.New("connection closed")
			case queue <- frame:
				return nil
			case <-timer.C:
				releaseQueueBytes(queuedBytes, frameBytes, nil)
				return ErrWriteQueueFull
			}
		}
		select {
		case <-c.done:
			return errors.New("connection closed")
		case <-freed:
		case <-timer.C:
			c.noteQueueByteOverflow(frameBytes, lane, "byte_limit")
			return ErrWriteQueueFull
		}
	}
}

func (c *Conn) tryEnqueueBounded(
	frame Frame,
	lane string,
	queue chan<- Frame,
	queuedBytes *atomic.Int64,
	byteLimit int64,
) bool {
	frameBytes := int64(len(frame.Data))
	if frameBytes > byteLimit {
		c.noteQueueByteOverflow(frameBytes, lane, "frame_too_large")
		return false
	}
	if !reserveQueueBytes(queuedBytes, frameBytes, byteLimit) {
		c.noteQueueByteOverflow(frameBytes, lane, "byte_limit")
		return false
	}
	select {
	case <-c.done:
		releaseQueueBytes(queuedBytes, frameBytes, nil)
		return false
	case queue <- frame:
		return true
	default:
		releaseQueueBytes(queuedBytes, frameBytes, nil)
		return false
	}
}

func reserveQueueBytes(queuedBytes *atomic.Int64, frameBytes, byteLimit int64) bool {
	for {
		current := queuedBytes.Load()
		if frameBytes > byteLimit-current {
			return false
		}
		if queuedBytes.CompareAndSwap(current, current+frameBytes) {
			return true
		}
	}
}

func releaseQueueBytes(queuedBytes *atomic.Int64, frameBytes int64, freed chan<- struct{}) {
	for {
		current := queuedBytes.Load()
		next := current - frameBytes
		if next < 0 {
			next = 0
		}
		if queuedBytes.CompareAndSwap(current, next) {
			break
		}
	}
	if freed != nil {
		select {
		case freed <- struct{}{}:
		default:
		}
	}
}

func (c *Conn) noteDroppedFrame(frame Frame, lane string, reason string) {
	dropped := c.droppedFrames.Add(1)
	// Log only the first and every 100th drop: visible in production without flooding during bursts.
	if dropped == 1 || dropped%100 == 0 {
		slog.Warn("websocket: shed frame for slow client",
			"lane", lane,
			"kind", frame.Kind,
			"request_id", frame.RequestID,
			"remote", c.cfg.Remote,
			"size", len(frame.Data),
			"reason", reason,
		)
	}
}

func (c *Conn) noteQueueByteOverflow(size int64, lane string, reason string) {
	overflows := c.queueByteOverflows.Add(1)
	observability.Usage.WebSocketQueueByteOverflowsTotal.Add(1)
	if overflows == 1 || overflows%100 == 0 {
		slog.Warn("websocket_queue_byte_overflow",
			"lane", lane,
			"remote", c.cfg.Remote,
			"size", size,
			"reason", reason,
		)
	}
}

func writeQueueDropReason(err error) string {
	if errors.Is(err, ErrWriteFrameTooLarge) {
		return "frame_too_large"
	}
	return "queue_full"
}

// StartWriteLoop starts the write pump (idempotent); the protocol layer calls it after successful
// authentication — before that nothing consumes the queues.
func (c *Conn) StartWriteLoop() {
	c.writeLoopOnce.Do(func() {
		go c.writeLoop()
	})
}

// writeLoop drains the control queue before consuming the data queue so congestion cannot starve
// heartbeats and stream-recovery frames.
func (c *Conn) writeLoop() {
	for {
		select {
		case <-c.done:
			return
		case frame := <-c.CtrlOutbox:
			if !c.deliverQueuedFrame(frame, true) {
				return
			}
		case frame := <-c.Outbox:
			if !c.deliverQueuedFrame(frame, false) {
				return
			}
			for drained := 0; drained < writeLoopBatchSize; drained++ {
				select {
				case extra := <-c.CtrlOutbox:
					if !c.deliverQueuedFrame(extra, true) {
						return
					}
					continue
				default:
				}
				select {
				case extra := <-c.Outbox:
					if !c.deliverQueuedFrame(extra, false) {
						return
					}
				default:
					goto batchDone
				}
			}
		batchDone:
		}
	}
}

// deliverQueuedFrame closes the connection immediately on the first write error; reliable recovery
// must happen on a new connection.
func (c *Conn) deliverQueuedFrame(frame Frame, control bool) bool {
	if control {
		defer releaseQueueBytes(&c.controlBytes, int64(len(frame.Data)), c.controlFreed)
	} else {
		defer releaseQueueBytes(&c.dataBytes, int64(len(frame.Data)), c.dataFreed)
	}
	if err := c.writeFrameDirect(frame); err != nil {
		lane := "data"
		if control {
			lane = "control"
		}
		c.writerCloses.Add(1)
		observability.Usage.WebSocketWriterClosesTotal.Add(1)
		slog.Error("websocket_writer_closed",
			"lane", lane,
			"size", len(frame.Data),
			"reason", "write_failed",
		)
		c.Close()
		return false
	}
	return true
}

func (c *Conn) writeFrameDirect(frame Frame) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if c.writeOverride != nil {
		return c.writeOverride(frame)
	}
	if c.ws == nil {
		return errors.New("websocket connection is nil")
	}
	if c.cfg.WriteTimeout > 0 {
		if err := c.ws.SetWriteDeadline(time.Now().Add(c.cfg.WriteTimeout)); err != nil {
			return err
		}
		defer func() {
			_ = c.ws.SetWriteDeadline(time.Time{})
		}()
	}
	return c.ws.WriteMessage(frame.MessageType, frame.Data)
}
