package mesh

import (
	"sync"
	"time"
)

// idleBucketTTL is how long a sender's bucket is kept after its last message
// before it becomes eligible for eviction.
const idleBucketTTL = 2 * time.Minute

// senderLimiter is a per-sender token bucket with a bounded population.
//
// The bound is the point. The map is keyed by a value the remote peer chooses,
// so an unbounded map is a memory-exhaustion vector: a sender looping over
// random message ids would grow it without limit. Here the population is capped,
// expired buckets are swept, and once the cap is reached during a flood the
// limiter fails closed and refuses unknown senders rather than growing.
//
// Failing closed is deliberate: under a flood the alternative is to keep serving
// everyone, which is the outcome the limiter exists to prevent.
type senderLimiter struct {
	rate  float64
	burst float64
	max   int

	mu        sync.Mutex
	buckets   map[string]*tokenBucket
	lastSweep time.Time
	now       func() time.Time
}

type tokenBucket struct {
	tokens   float64
	lastSeen time.Time
}

func newSenderLimiter(cfg RateLimitConfig, max int) *senderLimiter {
	if max <= 0 {
		max = DefaultMaxSenderStates
	}
	return &senderLimiter{
		rate:    cfg.PerSecond,
		burst:   float64(cfg.Burst),
		max:     max,
		buckets: make(map[string]*tokenBucket),
		now:     func() time.Time { return time.Now().UTC() },
	}
}

// allow reports whether a message from sender may proceed, consuming a token.
func (l *senderLimiter) allow(sender string) bool {
	if l == nil {
		return true
	}
	now := l.now()

	l.mu.Lock()
	defer l.mu.Unlock()

	bucket, seen := l.buckets[sender]
	if !seen {
		if len(l.buckets) >= l.max {
			// Sweep at most once per sweepInterval so a flood of distinct
			// senders cannot make every message cost a full scan.
			if now.Sub(l.lastSweep) >= sweepInterval {
				l.sweepLocked(now)
				l.lastSweep = now
			}
			if len(l.buckets) >= l.max {
				return false
			}
		}
		bucket = &tokenBucket{tokens: l.burst, lastSeen: now}
		l.buckets[sender] = bucket
	}

	// Refill by elapsed time, capped at the burst size.
	if elapsed := now.Sub(bucket.lastSeen).Seconds(); elapsed > 0 {
		bucket.tokens = min(bucket.tokens+elapsed*l.rate, l.burst)
	}
	bucket.lastSeen = now

	if bucket.tokens < 1 {
		return false
	}
	bucket.tokens--
	return true
}

// sweepInterval bounds how often the expired-bucket scan may run.
const sweepInterval = time.Second

func (l *senderLimiter) sweepLocked(now time.Time) {
	for sender, bucket := range l.buckets {
		if now.Sub(bucket.lastSeen) > idleBucketTTL {
			delete(l.buckets, sender)
		}
	}
}

// size reports the tracked population. Used by tests and by the status surface.
func (l *senderLimiter) size() int {
	if l == nil {
		return 0
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.buckets)
}
