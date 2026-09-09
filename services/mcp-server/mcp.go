// Package mcp — GamificationOG MCP server (Sections 65, 153, 154).
//
// Exposes the platform to AI agents over JSON-RPC 2.0 (stdio or HTTP):
//
//   - initialize / tools/list / tools/call (MCP core protocol)
//   - Tools: list_rules, get_user_state, simulate_event, list_events,
//     evaluate_formula, leaderboard, list_capabilities
//
// The server is a thin stateless adapter: every tool call translates to
// an authenticated HTTP request against the platform's public v1 API
// (scope-checked per tool), so AI agents inherit the platform's auth,
// audit and idempotency guarantees. The API key passed at construction
// needs scopes: rules:read, state:read, events:write, events:read,
// formulas:eval, registry:read ("*" covers all).
//
// Tool surface (Section 154): read-oriented domain tools. Configuration
// changes stay in the admin dashboard — agents observe and simulate,
// humans approve (Section 65: AI is a control-plane operator, not a
// database administrator).
package mcp

import (
        "bytes"
        "encoding/json"
        "fmt"
        "io"
        "net/http"
        "net/url"
        "strings"
        "time"
)

// Request/Response — JSON-RPC 2.0 envelope.
type Request struct {
        JSONRPC string          `json:"jsonrpc"`
        ID      json.RawMessage `json:"id,omitempty"`
        Method  string          `json:"method"`
        Params  json.RawMessage `json:"params,omitempty"`
}

type Response struct {
        JSONRPC string          `json:"jsonrpc"`
        ID      json.RawMessage `json:"id,omitempty"`
        Result  json.RawMessage `json:"result,omitempty"`
        Error   *RPCError       `json:"error,omitempty"`
}

type RPCError struct {
        Code    int    `json:"code"`
        Message string `json:"message"`
}

func (e *RPCError) Error() string { return fmt.Sprintf("rpc %d: %s", e.Code, e.Message) }

func errorResponse(id json.RawMessage, code int, msg string) *Response {
        return &Response{JSONRPC: "2.0", ID: id, Error: &RPCError{Code: code, Message: msg}}
}

func resultResponse(id json.RawMessage, result any) *Response {
        raw, _ := json.Marshal(result)
        return &Response{JSONRPC: "2.0", ID: id, Result: raw}
}

// Tool — MCP tool definition.
type Tool struct {
        Name        string `json:"name"`
        Description string `json:"description"`
        InputSchema any    `json:"inputSchema"`
}

// Server — the MCP server state.
type Server struct {
        baseURL string
        apiKey  string
        client  *http.Client
        tools   []Tool
}

func NewServer(baseURL, apiKey string) *Server {
        s := &Server{
                baseURL: strings.TrimRight(baseURL, "/"),
                apiKey:  apiKey,
                client:  &http.Client{Timeout: 15 * time.Second},
        }
        s.tools = []Tool{
                {Name: "list_rules", Description: "List gamification rules (WHEN event / IF conditions / THEN actions) configured for the project, highest priority first. Scope: rules:read", InputSchema: map[string]any{"type": "object", "properties": map[string]any{"status": map[string]any{"type": "string", "description": "filter: active | draft | paused | archived"}, "type": map[string]any{"type": "string", "description": "filter by event type, e.g. task.completed"}}}},
                {Name: "get_user_state", Description: "Get a user's full state: XP, level, wallets, inventory, achievements, challenges, streaks, entitlements", InputSchema: map[string]any{"type": "object", "properties": map[string]any{"user": map[string]any{"type": "string", "description": "external user id"}}, "required": []string{"user"}}},
                {Name: "simulate_event", Description: "Send an event through the engine (playground-safe simulation) and return the processing result with state deltas", InputSchema: map[string]any{"type": "object", "properties": map[string]any{"event_type": map[string]any{"type": "string"}, "user": map[string]any{"type": "string"}, "payload": map[string]any{"type": "object"}}, "required": []string{"event_type", "user"}}},
                {Name: "list_events", Description: "Recent ingested events with status and type counts. Scope: events:read", InputSchema: map[string]any{"type": "object", "properties": map[string]any{"limit": map[string]any{"type": "number", "description": "max events (default 20, max 200)"}, "type": map[string]any{"type": "string", "description": "filter by event type"}, "status": map[string]any{"type": "string", "description": "filter: processed | failed | duplicate | ..."}}}},
                {Name: "evaluate_formula", Description: "Evaluate a formula expression through the platform's sandboxed deterministic engine (same engine as rule rewards). Variables use dotted paths, e.g. {\"event.payload.difficulty\": \"hard\"}. Scope: formulas:eval", InputSchema: map[string]any{"type": "object", "properties": map[string]any{"expr": map[string]any{"type": "string", "description": "expression, e.g. 20 + (user.level * 5)"}, "vars": map[string]any{"type": "object", "description": "variable values keyed by dotted path"}}, "required": []string{"expr"}}},
                {Name: "leaderboard", Description: "Fetch a leaderboard with optional around-user context", InputSchema: map[string]any{"type": "object", "properties": map[string]any{"code": map[string]any{"type": "string"}, "user": map[string]any{"type": "string"}}, "required": []string{"code"}}},
                {Name: "list_capabilities", Description: "Capability registry: object types, events, actions, operators, formula functions", InputSchema: map[string]any{"type": "object", "properties": map[string]any{}}},
        }
        return s
}

// platformCall — authenticated request to the platform API.
func (s *Server) platformCall(method, path string, body any) (any, error) {
        var payload io.Reader
        if body != nil {
                raw, err := json.Marshal(body)
                if err != nil {
                        return nil, err
                }
                payload = bytes.NewReader(raw)
        }
        req, err := http.NewRequest(method, s.baseURL+path, payload)
        if err != nil {
                return nil, err
        }
        req.Header.Set("content-type", "application/json")
        if s.apiKey != "" {
                req.Header.Set("Authorization", "Bearer "+s.apiKey)
        }
        res, err := s.client.Do(req)
        if err != nil {
                return nil, fmt.Errorf("platform unreachable: %w", err)
        }
        defer res.Body.Close()
        raw, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
        var parsed any
        if err := json.Unmarshal(raw, &parsed); err != nil {
                return map[string]any{"raw": string(raw), "status": res.StatusCode}, nil
        }
        if res.StatusCode >= 400 {
                if obj, ok := parsed.(map[string]any); ok {
                        if errObj, ok := obj["error"].(map[string]any); ok {
                                return nil, fmt.Errorf("platform error %d: %v", res.StatusCode, errObj["message"])
                        }
                }
                return nil, fmt.Errorf("platform error: status %d", res.StatusCode)
        }
        return parsed, nil
}

// handleToolCall — dispatch a tools/call request.
func (s *Server) handleToolCall(params json.RawMessage) (any, error) {
        var p struct {
                Name      string          `json:"name"`
                Arguments json.RawMessage `json:"arguments,omitempty"`
        }
        if err := json.Unmarshal(params, &p); err != nil {
                return nil, fmt.Errorf("invalid params: %w", err)
        }
        var args map[string]any
        if len(p.Arguments) > 0 {
                _ = json.Unmarshal(p.Arguments, &args)
        }
        str := func(k string) string {
                v, _ := args[k].(string)
                return v
        }

        q := func(base string, extra map[string]string) string {
                sep := "?"
                for k, v := range extra {
                        base += sep + k + "=" + url.QueryEscape(v)
                        sep = "&"
                }
                return base
        }

        switch p.Name {
        case "list_rules":
                extra := map[string]string{}
                for _, k := range []string{"status", "type"} {
                        if v := str(k); v != "" {
                                extra[k] = v
                        }
                }
                return s.platformCall("GET", q("/api/v1/rules", extra), nil)
        case "get_user_state":
                user := str("user")
                if user == "" {
                        return nil, fmt.Errorf("argument 'user' is required")
                }
                return s.platformCall("GET", "/api/v1/users/"+user+"/state", nil)
        case "simulate_event":
                eventType := str("event_type")
                user := str("user")
                if eventType == "" || user == "" {
                        return nil, fmt.Errorf("arguments 'event_type' and 'user' are required")
                }
                payload, _ := args["payload"].(map[string]any)
                return s.platformCall("POST", "/api/v1/events", map[string]any{
                        "event_type":       eventType,
                        "external_user_id": user,
                        "payload":          payload,
                        "metadata":         map[string]any{"source": "mcp"},
                })
        case "list_events":
                limit := 20.0
                if v, ok := args["limit"].(float64); ok && v > 0 {
                        limit = v
                }
                extra := map[string]string{"limit": fmt.Sprintf("%d", int(limit))}
                for _, k := range []string{"type", "status"} {
                        if v := str(k); v != "" {
                                extra[k] = v
                        }
                }
                return s.platformCall("GET", q("/api/v1/events", extra), nil)
        case "evaluate_formula":
                expr := str("expr")
                if expr == "" {
                        return nil, fmt.Errorf("argument 'expr' is required")
                }
                vars, _ := args["vars"].(map[string]any)
                if vars == nil {
                        vars = map[string]any{}
                }
                return s.platformCall("POST", "/api/v1/formulas/evaluate", map[string]any{"expr": expr, "vars": vars})
        case "leaderboard":
                code := str("code")
                if code == "" {
                        return nil, fmt.Errorf("argument 'code' is required")
                }
                query := "?code=" + url.QueryEscape(code)
                if user := str("user"); user != "" {
                        query += "&user=" + url.QueryEscape(user)
                }
                return s.platformCall("GET", "/api/v1/leaderboards"+query, nil)
        case "list_capabilities":
                return s.platformCall("GET", "/api/v1/capabilities", nil)
        default:
                return nil, fmt.Errorf("unknown tool %q", p.Name)
        }
}

// Handle — process one JSON-RPC request, return one response.
func (s *Server) Handle(req *Request) *Response {
        switch req.Method {
        case "initialize":
                return resultResponse(req.ID, map[string]any{
                        "protocolVersion": "2024-11-05",
                        "serverInfo":      map[string]any{"name": "gamificationog", "version": "1.0.0"},
                        "capabilities":    map[string]any{"tools": map[string]any{"listChanged": false}},
                })
        case "notifications/initialized", "initialized":
                return nil // notification — no response
        case "ping":
                return resultResponse(req.ID, map[string]any{"pong": true})
        case "tools/list":
                return resultResponse(req.ID, map[string]any{"tools": s.tools})
        case "tools/call":
                result, err := s.handleToolCall(req.Params)
                if err != nil {
                        return errorResponse(req.ID, -32000, err.Error())
                }
                return resultResponse(req.ID, map[string]any{"content": []any{map[string]any{"type": "text", "text": mustJSON(result)}}})
        default:
                return errorResponse(req.ID, -32601, "method not found: "+req.Method)
        }
}

func mustJSON(v any) string {
        raw, err := json.Marshal(v)
        if err != nil {
                return fmt.Sprintf("%v", v)
        }
        return string(raw)
}

// ServeStdio — read line-delimited JSON-RPC from stdin, write to stdout.
func (s *Server) ServeStdio(in io.Reader, out io.Writer) error {
        decoder := json.NewDecoder(in)
        encoder := json.NewEncoder(out)
        for {
                var req Request
                if err := decoder.Decode(&req); err != nil {
                        if err == io.EOF {
                                return nil
                        }
                        continue
                }
                res := s.Handle(&req)
                if res == nil {
                        continue
                }
                if err := encoder.Encode(res); err != nil {
                        return err
                }
        }
}

// ServeHTTP — HTTP transport (POST /mcp with a JSON-RPC body).
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
        if r.Method != http.MethodPost {
                http.Error(w, "POST required", http.StatusMethodNotAllowed)
                return
        }
        var req Request
        if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req); err != nil {
                http.Error(w, "invalid json", http.StatusBadRequest)
                return
        }
        res := s.Handle(&req)
        if res == nil {
                w.WriteHeader(http.StatusNoContent)
                return
        }
        w.Header().Set("content-type", "application/json")
        json.NewEncoder(w).Encode(res)
}
