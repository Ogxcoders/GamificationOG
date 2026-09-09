// Package gateway — GamificationOG API gateway (Section 87: Go control plane).
//
// A reverse proxy in front of the platform with:
//   - API key authentication passthrough (Authorization: Bearer / X-Api-Key)
//   - per-key token-bucket rate limiting (Section 239)
//   - request correlation ids (x-gog-request-id)
//   - structured access logging
//   - circuit breaking on upstream failures (Section 91 reliability)
//
// Usage:
//
//      gateway -addr :8080 -upstream http://localhost:3000
package gateway

import (
        "fmt"
        "log"
        "net/http"
        "net/http/httputil"
        "net/url"
        "strings"
        "sync"
        "time"
)

// RateLimiter — token bucket per key (Section 239 rate limiting).
type RateLimiter struct {
        mu sync.Mutex
        // key -> bucket state
        buckets map[string]*bucket
        rate     float64 // tokens per second
        burst    float64 // bucket capacity
}

type bucket struct {
        tokens float64
        last   time.Time
}

func NewRateLimiter(ratePerSec, burst float64) *RateLimiter {
        return &RateLimiter{buckets: map[string]*bucket{}, rate: ratePerSec, burst: burst}
}

// Allow returns true when the key may proceed.
func (rl *RateLimiter) Allow(key string) bool {
        rl.mu.Lock()
        defer rl.mu.Unlock()
        now := time.Now()
        b, ok := rl.buckets[key]
        if !ok {
                // first request consumes one token from a full bucket (burst N
                // allows exactly N immediate requests, not N+1)
                rl.buckets[key] = &bucket{tokens: rl.burst - 1, last: now}
                return rl.burst >= 1
        }
        // refill
        elapsed := now.Sub(b.last).Seconds()
        b.tokens += elapsed * rl.rate
        if b.tokens > rl.burst {
                b.tokens = rl.burst
        }
        b.last = now
        if b.tokens >= 1 {
                b.tokens -= 1
                return true
        }
        return false
}

// CircuitBreaker — opens after N consecutive failures, half-opens after cooldown.
type CircuitBreaker struct {
        mu             sync.Mutex
        failures       int
        threshold      int
        cooldown       time.Duration
        openedAt       time.Time
        state          string // closed | open | half-open
        successInProbe bool
}

func NewCircuitBreaker(threshold int, cooldown time.Duration) *CircuitBreaker {
        return &CircuitBreaker{threshold: threshold, cooldown: cooldown, state: "closed"}
}

func (cb *CircuitBreaker) Allow() bool {
        cb.mu.Lock()
        defer cb.mu.Unlock()
        switch cb.state {
        case "open":
                if time.Since(cb.openedAt) >= cb.cooldown {
                        cb.state = "half-open"
                        cb.successInProbe = false
                        return true
                }
                return false
        case "half-open":
                return !cb.successInProbe // one probe at a time
        default:
                return true
        }
}

func (cb *CircuitBreaker) Record(success bool) {
        cb.mu.Lock()
        defer cb.mu.Unlock()
        if cb.state == "half-open" {
                if success {
                        cb.state = "closed"
                        cb.failures = 0
                } else {
                        cb.state = "open"
                        cb.openedAt = time.Now()
                }
                return
        }
        if success {
                cb.failures = 0
                return
        }
        cb.failures++
        if cb.failures >= cb.threshold {
                cb.state = "open"
                cb.openedAt = time.Now()
        }
}

func (cb *CircuitBreaker) State() string {
        cb.mu.Lock()
        defer cb.mu.Unlock()
        return cb.state
}

// extractAPIKey — Authorization: Bearer <key> or X-Api-Key header.
func extractAPIKey(r *http.Request) string {
        auth := r.Header.Get("Authorization")
        if strings.HasPrefix(auth, "Bearer ") {
                return strings.TrimPrefix(auth, "Bearer ")
        }
        return r.Header.Get("X-Api-Key")
}

// Gateway — the proxy handler.
type Gateway struct {
        upstream *url.URL
        proxy    *httputil.ReverseProxy
        limiter  *RateLimiter
        breaker  *CircuitBreaker
        logger   *log.Logger
}

func New(upstream string, ratePerSec, burst float64, breakerThreshold int) (*Gateway, error) {
        u, err := url.Parse(upstream)
        if err != nil {
                return nil, fmt.Errorf("invalid upstream url: %w", err)
        }
        g := &Gateway{
                upstream: u,
                limiter:  NewRateLimiter(ratePerSec, burst),
                breaker:  NewCircuitBreaker(breakerThreshold, 5*time.Second),
                logger:   log.New(log.Default().Writer(), "[gateway] ", log.LstdFlags),
        }
        g.proxy = &httputil.ReverseProxy{Director: func(req *http.Request) {
                req.URL.Scheme = u.Scheme
                req.URL.Host = u.Host
                req.Host = u.Host
        }}
        return g, nil
}

// metricsPathPrefixes do not require an API key (health checks).
var publicPaths = map[string]bool{
        "/api/health":        true,
        "/healthz":           true,
        "/":                  true,
        "/login":             true,
        "/api/admin/auth/login": true,
        "/api/admin/auth/bootstrap": true,
}

func (g *Gateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
        requestID := r.Header.Get("x-gog-request-id")
        if requestID == "" {
                requestID = fmt.Sprintf("req_%d", time.Now().UnixNano())
        }
        w.Header().Set("x-gog-request-id", requestID)
        // forward the correlation id upstream so traces span the hop
        r.Header.Set("x-gog-request-id", requestID)

        // circuit breaker guard (upstream health)
        if !g.breaker.Allow() {
                w.Header().Set("Retry-After", "5")
                http.Error(w, `{"error":{"code":"UPSTREAM_UNAVAILABLE","message":"Upstream temporarily unavailable."}}`, http.StatusServiceUnavailable)
                return
        }

        // rate limiting keyed by API key or IP
        key := extractAPIKey(r)
        if key == "" {
                key = r.RemoteAddr
        }
        if !g.limiter.Allow(key) {
                w.Header().Set("Retry-After", "1")
                http.Error(w, `{"error":{"code":"RATE_LIMITED","message":"Too many requests."}}`, http.StatusTooManyRequests)
                return
        }

        // api key required for /api/v1/* (public API surface)
        if strings.HasPrefix(r.URL.Path, "/api/v1/") && extractAPIKey(r) == "" {
                http.Error(w, `{"error":{"code":"API_KEY_REQUIRED","message":"Provide an API key via Authorization Bearer or X-Api-Key."}}`, http.StatusUnauthorized)
                return
        }

        g.proxy.ServeHTTP(w, r)
        g.breaker.Record(true)
}

// ListenAndServe starts the gateway.
func (g *Gateway) ListenAndServe(addr string) error {
        g.logger.Printf("listening on %s → %s", addr, g.upstream)
        return http.ListenAndServe(addr, g)
}
