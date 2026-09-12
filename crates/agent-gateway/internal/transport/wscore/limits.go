package wscore

import (
	"sync"
	"time"
)

// DispatchLimiter limits the number of in-flight dispatches on a single connection:
// if the read loop's TryAcquire fails, the request is rejected immediately (never
// block the read loop -- blocking would stall pong/liveness checks); Release is
// called when the handling goroutine finishes. Without it, slow pass-through
// requests (which can block until requestTimeout) would accumulate goroutines
// without bound as the request rate rises.
type DispatchLimiter struct {
	slots chan struct{}
}

func NewDispatchLimiter(limit int) *DispatchLimiter {
	if limit <= 0 {
		limit = 16
	}
	return &DispatchLimiter{slots: make(chan struct{}, limit)}
}

func (l *DispatchLimiter) TryAcquire() bool {
	select {
	case l.slots <- struct{}{}:
		return true
	default:
		return false
	}
}

func (l *DispatchLimiter) Release() {
	select {
	case <-l.slots:
	default:
	}
}

// InboundRateLimiter is a token bucket for inbound frames on a single connection:
// fast frames (answered locally, parsed and discarded) are not constrained by the
// dispatch semaphore and can still saturate the CPU (one Unmarshal + dispatch per
// frame); the token bucket covers that gap. Exceeding the threshold of consecutive
// violations classifies the client as out of control, and the caller should close
// the connection.
type InboundRateLimiter struct {
	mu         sync.Mutex
	tokens     float64
	burst      float64
	perSecond  float64
	lastRefill time.Time

	violations    int
	maxViolations int
}

func NewInboundRateLimiter(perSecond, burst float64, maxViolations int) *InboundRateLimiter {
	if perSecond <= 0 {
		perSecond = 100
	}
	if burst <= 0 {
		burst = perSecond * 2
	}
	if maxViolations <= 0 {
		maxViolations = 3
	}
	return &InboundRateLimiter{
		tokens:        burst,
		burst:         burst,
		perSecond:     perSecond,
		lastRefill:    time.Now(),
		maxViolations: maxViolations,
	}
}

// Allow consumes one token. The second return value being true means the
// consecutive violation count exceeded the threshold and the connection should be closed.
func (l *InboundRateLimiter) Allow() (ok bool, exceeded bool) {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := time.Now()
	l.tokens += now.Sub(l.lastRefill).Seconds() * l.perSecond
	if l.tokens > l.burst {
		l.tokens = l.burst
	}
	l.lastRefill = now

	if l.tokens >= 1 {
		l.tokens -= 1
		l.violations = 0
		return true, false
	}
	l.violations += 1
	return false, l.violations >= l.maxViolations
}
