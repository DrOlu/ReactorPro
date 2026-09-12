package wscore

import (
	"time"

	"github.com/gorilla/websocket"
)

// StartHeartbeat starts the heartbeat and idle-eviction loop (idempotent). Each cycle, in
// order: idle check (closing the connection past IdleTimeout, the sole eviction decision
// point); WS control-frame ping (answered by the browser network process, proving liveness
// even for frozen/throttled tabs); and the application-level ping built by buildPing (the
// only observable inbound activity from page JS, best-effort, dropped frames do not affect
// the eviction decision).
func (c *Conn) StartHeartbeat(buildPing func() (Frame, bool)) {
	c.heartbeatOnce.Do(func() {
		period := c.cfg.HeartbeatPeriod
		if period <= 0 {
			period = defaultHeartbeatPeriod
		}
		go func() {
			ticker := time.NewTicker(period)
			defer ticker.Stop()
			for {
				select {
				case <-c.done:
					return
				case <-ticker.C:
					c.lastInboundMu.Lock()
					lastInbound := c.lastInboundAt
					c.lastInboundMu.Unlock()
					if time.Since(lastInbound) > c.IdleTimeout() {
						c.Close()
						return
					}
					deadline := time.Now().Add(c.ControlWriteTimeout())
					_ = c.ws.WriteControl(websocket.PingMessage, nil, deadline)
					if buildPing != nil {
						if frame, ok := buildPing(); ok {
							_ = c.Enqueue(frame)
						}
					}
				}
			}
		}()
	})
}
