package mcp

import (
        "bytes"
        "encoding/json"
        "net/http"
        "net/http/httptest"
        "strings"
        "testing"
)

func TestInitialize(t *testing.T) {
        s := NewServer("http://localhost:3000", "gog_test")
        res := s.Handle(&Request{JSONRPC: "2.0", ID: json.RawMessage("1"), Method: "initialize"})
        if res == nil || res.Error != nil {
                t.Fatalf("expected result, got %+v", res)
        }
        var parsed map[string]any
        json.Unmarshal(res.Result, &parsed)
        if parsed["protocolVersion"] != "2024-11-05" {
                t.Fatalf("unexpected protocol: %v", parsed["protocolVersion"])
        }
}

func TestToolsList(t *testing.T) {
        s := NewServer("http://x", "")
        res := s.Handle(&Request{JSONRPC: "2.0", ID: json.RawMessage("2"), Method: "tools/list"})
        var parsed struct {
                Tools []Tool `json:"tools"`
        }
        if err := json.Unmarshal(res.Result, &parsed); err != nil {
                t.Fatal(err)
        }
        if len(parsed.Tools) < 9 {
                t.Fatalf("expected 9 tools, got %d", len(parsed.Tools))
        }
        names := map[string]bool{}
        for _, tool := range parsed.Tools {
                names[tool.Name] = true
        }
        for _, want := range []string{"list_rules", "get_user_state", "simulate_event", "evaluate_formula", "leaderboard"} {
                if !names[want] {
                        t.Fatalf("missing tool %q", want)
                }
        }
}

func TestToolsCallValidation(t *testing.T) {
        s := NewServer("http://x", "")
        res := s.Handle(&Request{
                JSONRPC: "2.0", ID: json.RawMessage("3"), Method: "tools/call",
                Params: json.RawMessage(`{"name":"get_user_state","arguments":{}}`),
        })
        if res == nil || res.Error == nil {
                t.Fatal("expected error for missing user argument")
        }
        if !strings.Contains(res.Error.Message, "required") {
                t.Fatalf("unexpected message: %s", res.Error.Message)
        }
}

func TestUnknownTool(t *testing.T) {
        s := NewServer("http://x", "")
        res := s.Handle(&Request{
                JSONRPC: "2.0", ID: json.RawMessage("4"), Method: "tools/call",
                Params: json.RawMessage(`{"name":"explode","arguments":{}}`),
        })
        if res == nil || res.Error == nil || !strings.Contains(res.Error.Message, "unknown tool") {
                t.Fatal("expected unknown tool error")
        }
}

func TestUnknownMethod(t *testing.T) {
        s := NewServer("http://x", "")
        res := s.Handle(&Request{JSONRPC: "2.0", ID: json.RawMessage("5"), Method: "resources/list"})
        if res == nil || res.Error == nil {
                t.Fatal("expected -32601")
        }
}

func TestServeStdioRoundTrip(t *testing.T) {
        // upstream stub returning user state
        upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                if r.URL.Path != "/api/v1/users/ada/state" {
                        http.NotFound(w, r)
                        return
                }
                if r.Header.Get("Authorization") != "Bearer gog_key" {
                        http.Error(w, `{"error":{"code":"API_KEY_REQUIRED","message":"key required"}}`, 401)
                        return
                }
                w.Write([]byte(`{"user":{"external_id":"ada"},"progression":[{"xp":350,"level":4}]}`))
        }))
        defer upstream.Close()

        s := NewServer(upstream.URL, "gog_key")
        input := bytes.NewBufferString(
                `{"jsonrpc":"2.0","id":"a","method":"initialize"}` + "\n" +
                        `{"jsonrpc":"2.0","id":"b","method":"tools/call","params":{"name":"get_user_state","arguments":{"user":"ada"}}}` + "\n",
        )
        var out bytes.Buffer
        if err := s.ServeStdio(input, &out); err != nil {
                t.Fatal(err)
        }
        lines := strings.Split(strings.TrimSpace(out.String()), "\n")
        if len(lines) != 2 {
                t.Fatalf("expected 2 responses, got %d", len(lines))
        }
        var callRes Response
        if err := json.Unmarshal([]byte(lines[1]), &callRes); err != nil {
                t.Fatal(err)
        }
        if callRes.Error != nil {
                t.Fatalf("tool call failed: %v", callRes.Error)
        }
        if !strings.Contains(string(callRes.Result), "ada") {
                t.Fatalf("expected ada state, got %s", callRes.Result)
        }
}

func TestServeHTTPTransport(t *testing.T) {
        s := NewServer("http://x", "")
        rec := httptest.NewRecorder()
        req := httptest.NewRequest("POST", "/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"ping"}`))
        s.ServeHTTP(rec, req)
        if rec.Code != 200 {
                t.Fatalf("code %d", rec.Code)
        }
        if !strings.Contains(rec.Body.String(), "pong") {
                t.Fatalf("body: %s", rec.Body.String())
        }
}

// stubUpstream — asserts method, path and bearer auth, returns a canned body.
func stubUpstream(t *testing.T, wantMethod, wantPath, key, reply string) *httptest.Server {
        t.Helper()
        return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                if r.Method != wantMethod {
                        http.Error(w, `{"error":{"message":"wrong method"}}`, 400)
                        return
                }
                // r.URL.Path never carries the query string — reconstruct the full
                // target so wantPath may assert query parameters too
                full := r.URL.Path
                if r.URL.RawQuery != "" {
                        full += "?" + r.URL.RawQuery
                }
                if full != wantPath {
                        http.Error(w, `{"error":{"message":"wrong path: `+full+`"}}`, 400)
                        return
                }
                if key != "" && r.Header.Get("Authorization") != "Bearer "+key {
                        http.Error(w, `{"error":{"message":"bad key"}}`, 401)
                        return
                }
                w.Header().Set("content-type", "application/json")
                w.Write([]byte(reply))
        }))
}

func callTool(t *testing.T, s *Server, name, arguments string) (string, *RPCError) {
        t.Helper()
        res := s.Handle(&Request{
                JSONRPC: "2.0", ID: json.RawMessage("9"), Method: "tools/call",
                Params: json.RawMessage(`{"name":"` + name + `","arguments":` + arguments + `}`),
        })
        if res == nil {
                t.Fatal("nil response")
        }
        if res.Error != nil {
                return "", res.Error
        }
        return string(res.Result), nil
}

func TestListRulesTool(t *testing.T) {
        up := stubUpstream(t, "GET", "/api/v1/rules", "gog_key",
                `{"rules":[{"name":"task_xp","when":"task.completed","priority":100}],"scope":{}}`)
        defer up.Close()
        s := NewServer(up.URL, "gog_key")
        out, err := callTool(t, s, "list_rules", `{}`)
        if err != nil {
                t.Fatal(err)
        }
        if !strings.Contains(out, "task_xp") {
                t.Fatalf("expected rules payload, got %s", out)
        }
}

func TestListRulesToolWithFilters(t *testing.T) {
        // filter args must be forwarded as query params
        up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                if r.URL.Path != "/api/v1/rules" || r.URL.Query().Get("status") != "active" || r.URL.Query().Get("type") != "task.completed" {
                        http.Error(w, `{"error":{"message":"filters not forwarded"}}`, 400)
                        return
                }
                w.Write([]byte(`{"rules":[]}`))
        }))
        defer up.Close()
        s := NewServer(up.URL, "gog_key")
        if _, err := callTool(t, s, "list_rules", `{"status":"active","type":"task.completed"}`); err != nil {
                t.Fatal(err)
        }
}

func TestListEventsTool(t *testing.T) {
        up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                if r.URL.Path != "/api/v1/events" || r.URL.Query().Get("limit") != "5" {
                        http.Error(w, `{"error":{"message":"limit not forwarded"}}`, 400)
                        return
                }
                w.Write([]byte(`{"events":[],"typeCounts":[]}`))
        }))
        defer up.Close()
        s := NewServer(up.URL, "gog_key")
        if _, err := callTool(t, s, "list_events", `{"limit":5}`); err != nil {
                t.Fatal(err)
        }
}

func TestEvaluateFormulaTool(t *testing.T) {
        up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                if r.Method != "POST" || r.URL.Path != "/api/v1/formulas/evaluate" {
                        http.Error(w, `{"error":{"message":"wrong endpoint"}}`, 400)
                        return
                }
                var body map[string]any
                json.NewDecoder(r.Body).Decode(&body)
                if body["expr"] != "2 + 2" {
                        http.Error(w, `{"error":{"message":"expr not forwarded"}}`, 400)
                        return
                }
                w.Write([]byte(`{"expr":"2 + 2","value":4}`))
        }))
        defer up.Close()
        s := NewServer(up.URL, "gog_key")
        out, err := callTool(t, s, "evaluate_formula", `{"expr":"2 + 2"}`)
        if err != nil {
                t.Fatal(err)
        }
        if !strings.Contains(out, "4") {
                t.Fatalf("expected value 4, got %s", out)
        }
}

func TestListCapabilitiesTool(t *testing.T) {
        up := stubUpstream(t, "GET", "/api/v1/capabilities", "gog_key",
                `{"registry":[],"summary":{}}`)
        defer up.Close()
        s := NewServer(up.URL, "gog_key")
        if _, err := callTool(t, s, "list_capabilities", `{}`); err != nil {
                t.Fatal(err)
        }
}

func TestFormulaRequiresExpr(t *testing.T) {
        s := NewServer("http://x", "")
        _, err := callTool(t, s, "evaluate_formula", `{}`)
        if err == nil || !strings.Contains(err.Message, "required") {
                t.Fatalf("expected required-arg error, got %+v", err)
        }
}

func TestToolsListIncludesProposalTools(t *testing.T) {
        s := NewServer("http://x", "")
        res := s.Handle(&Request{JSONRPC: "2.0", ID: json.RawMessage("9"), Method: "tools/list"})
        var parsed struct {
                Tools []Tool `json:"tools"`
        }
        if err := json.Unmarshal(res.Result, &parsed); err != nil {
                t.Fatal(err)
        }
        names := map[string]bool{}
        for _, tool := range parsed.Tools {
                names[tool.Name] = true
        }
        for _, want := range []string{"propose_rule", "list_proposals"} {
                if !names[want] {
                        t.Fatalf("missing tool %q", want)
                }
        }
}

func TestProposeRuleTool(t *testing.T) {
        up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                if r.Method != "POST" || r.URL.Path != "/api/v1/proposals" {
                        http.Error(w, `{"error":{"message":"wrong endpoint"}}`, 400)
                        return
                }
                var body map[string]any
                json.NewDecoder(r.Body).Decode(&body)
                if body["type"] != "rule.create" {
                        http.Error(w, `{"error":{"message":"type not forwarded"}}`, 400)
                        return
                }
                payload, _ := body["payload"].(map[string]any)
                if payload["eventType"] != "task.completed" {
                        http.Error(w, `{"error":{"message":"payload not forwarded"}}`, 400)
                        return
                }
                if body["rationale"] != "engagement lift" {
                        http.Error(w, `{"error":{"message":"rationale not forwarded"}}`, 400)
                        return
                }
                w.Write([]byte(`{"id":"prop_1","type":"rule.create","status":"pending","note":"stored as pending"}`))
        }))
        defer up.Close()
        s := NewServer(up.URL, "gog_key")
        out, err := callTool(t, s, "propose_rule", `{"rule":{"name":"T","eventType":"task.completed","actionsJson":"[]"},"rationale":"engagement lift"}`)
        if err != nil {
                t.Fatal(err)
        }
        if !strings.Contains(out, "pending") {
                t.Fatalf("expected pending proposal, got %s", out)
        }
}

func TestProposeRuleRequiresArgs(t *testing.T) {
        s := NewServer("http://x", "")
        if _, err := callTool(t, s, "propose_rule", `{}`); err == nil || !strings.Contains(err.Message, "required") {
                t.Fatalf("expected required-arg error, got %+v", err)
        }
        if _, err := callTool(t, s, "propose_rule", `{"rule":{"name":"T"}}`); err == nil || !strings.Contains(err.Message, "rationale") {
                t.Fatalf("expected rationale error, got %+v", err)
        }
}

func TestListProposalsTool(t *testing.T) {
        up := stubUpstream(t, "GET", "/api/v1/proposals?status=pending", "gog_key",
                `{"proposals":[{"id":"prop_1","status":"pending"}],"counts":{"pending":1,"total":1}}`)
        defer up.Close()
        s := NewServer(up.URL, "gog_key")
        out, err := callTool(t, s, "list_proposals", `{"status":"pending"}`)
        if err != nil {
                t.Fatal(err)
        }
        if !strings.Contains(out, "prop_1") {
                t.Fatalf("expected proposal list, got %s", out)
        }
}
