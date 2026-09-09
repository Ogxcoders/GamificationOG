package gateway

import (
        "net/http"
        "net/http/httptest"
        "testing"
        "time"
)

func TestRateLimiterAllowsBurstThenLimits(t *testing.T) {
        rl := NewRateLimiter(1.0, 3.0) // 1/sec, burst 3
        for i := 0; i < 3; i++ {
                if !rl.Allow("key") {
                        t.Fatalf("expected burst allow #%d", i+1)
                }
        }
        if rl.Allow("key") {
                t.Fatal("expected 4th request to be limited")
        }
        if !rl.Allow("other") {
                t.Fatal("other key must have its own bucket")
        }
}

func TestRateLimiterRefillsOverTime(t *testing.T) {
        rl := NewRateLimiter(100.0, 1.0) // fast refill
        rl.Allow("k")
        time.Sleep(30 * time.Millisecond)
        if !rl.Allow("k") {
                t.Fatal("expected refill after elapsed time")
        }
}

func TestCircuitBreakerOpensAfterThreshold(t *testing.T) {
        cb := NewCircuitBreaker(3, 10*time.Millisecond)
        for i := 0; i < 3; i++ {
                cb.Allow()
                cb.Record(false)
        }
        if cb.State() != "open" {
                t.Fatalf("expected open, got %s", cb.State())
        }
        if cb.Allow() {
                t.Fatal("open breaker must block")
        }
        time.Sleep(15 * time.Millisecond)
        if !cb.Allow() {
                t.Fatal("breaker should half-open after cooldown")
        }
        cb.Record(true)
        if cb.State() != "closed" {
                t.Fatalf("expected closed after successful probe, got %s", cb.State())
        }
}

func TestExtractAPIKey(t *testing.T) {
        r := httptest.NewRequest("GET", "/api/v1/events", nil)
        r.Header.Set("Authorization", "Bearer gog_test")
        if got := extractAPIKey(r); got != "gog_test" {
                t.Fatalf("got %q", got)
        }
        r2 := httptest.NewRequest("GET", "/api/v1/events", nil)
        r2.Header.Set("X-Api-Key", "gog_header")
        if got := extractAPIKey(r2); got != "gog_header" {
                t.Fatalf("got %q", got)
        }
}

func newTestGateway(t *testing.T, upstream *httptest.Server) *Gateway {
        t.Helper()
        g, err := New(upstream.URL, 1000, 1000, 5)
        if err != nil {
                t.Fatalf("gateway: %v", err)
        }
        return g
}

func TestProxyForwardsAndAddsRequestID(t *testing.T) {
        upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                if r.Header.Get("x-gog-request-id") == "" {
                        t.Error("upstream should receive a correlation id")
                }
                w.Header().Set("content-type", "application/json")
                w.Write([]byte(`{"ok":true}`))
        }))
        defer upstream.Close()

        g := newTestGateway(t, upstream)
        rec := httptest.NewRecorder()
        g.ServeHTTP(rec, httptest.NewRequest("GET", "/", nil))
        if rec.Code != 200 {
                t.Fatalf("code %d", rec.Code)
        }
        if rec.Header().Get("x-gog-request-id") == "" {
                t.Fatal("response must carry request id")
        }
}

func TestAPIKeyEnforcedOnV1(t *testing.T) {
        upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                // keyed requests are EXPECTED to be proxied; only keyless ones must never arrive
                if r.Header.Get("Authorization") == "" && r.Header.Get("X-Api-Key") == "" {
                        t.Error("upstream should not be reached without a key")
                        return
                }
                w.Header().Set("content-type", "application/json")
                w.Write([]byte(`{"ok":true}`))
        }))
        defer upstream.Close()

        g := newTestGateway(t, upstream)
        rec := httptest.NewRecorder()
        g.ServeHTTP(rec, httptest.NewRequest("GET", "/api/v1/users/x/state", nil))
        if rec.Code != http.StatusUnauthorized {
                t.Fatalf("expected 401, got %d", rec.Code)
        }

        rec2 := httptest.NewRecorder()
        req := httptest.NewRequest("GET", "/api/v1/users/x/state", nil)
        req.Header.Set("Authorization", "Bearer gog_valid")
        g.ServeHTTP(rec2, req)
        if rec2.Code != 200 {
                t.Fatalf("with key expected 200, got %d", rec2.Code)
        }
}

func TestRateLimitedResponse(t *testing.T) {
        upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                w.Write([]byte("ok"))
        }))
        defer upstream.Close()

        g, _ := New(upstream.URL, 0.0001, 2, 5) // tiny rate + burst 2
        var last int
        for i := 0; i < 4; i++ {
                rec := httptest.NewRecorder()
                req := httptest.NewRequest("GET", "/", nil)
                req.RemoteAddr = "10.0.0.1:1234"
                g.ServeHTTP(rec, req)
                last = rec.Code
        }
        if last != http.StatusTooManyRequests {
                t.Fatalf("expected eventual 429, got %d", last)
        }
}
