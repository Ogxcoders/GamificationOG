#!/usr/bin/env python3
"""Patch mcp.go: replace remaining placeholder tool implementations with
real v1 API calls. Idempotent: skips edits already applied."""
import re
import sys

PATH = "/home/z/my-project/services/mcp-server/mcp.go"
src = open(PATH, encoding="utf-8").read()
orig = src

# 1. evaluate_formula tool description (exact line replace)
old_desc = '''{Name: "evaluate_formula", Description: "Evaluate a formula expression with variables (safe, sandboxed)", InputSchema: map[string]any{"type": "object", "properties": map[string]any{"expr": map[string]any{"type": "string"}, "vars": map[string]any{"type": "object"}}, "required": []string{"expr"}}},'''
new_desc = '''{Name: "evaluate_formula", Description: "Evaluate a formula expression through the platform's sandboxed deterministic engine (same engine as rule rewards). Variables use dotted paths, e.g. {\\"event.payload.difficulty\\": \\"hard\\"}. Scope: formulas:eval", InputSchema: map[string]any{"type": "object", "properties": map[string]any{"expr": map[string]any{"type": "string", "description": "expression, e.g. 20 + (user.level * 5)"}, "vars": map[string]any{"type": "object", "description": "variable values keyed by dotted path"}}, "required": []string{"expr"}}},'''
if old_desc in src:
    src = src.replace(old_desc, new_desc, 1)
    print("✓ evaluate_formula description updated")
else:
    print("- evaluate_formula description already updated or not found")

# 2. imports: add net/url
old_imports = '''import (
        "bytes"
        "encoding/json"
        "fmt"
        "io"
        "net/http"
        "strings"
        "time"
)'''
new_imports = '''import (
        "bytes"
        "encoding/json"
        "fmt"
        "io"
        "net/http"
        "net/url"
        "strings"
        "time"
)'''
if old_imports in src:
    src = src.replace(old_imports, new_imports, 1)
    print("✓ imports: net/url added")
else:
    print("- imports already include net/url")

# 3. list_rules case → q helper + real call
old_rules = '''        switch p.Name {
        case "list_rules":
                return s.platformCall("GET", "/api/v1/flags?user=ada", nil) // placeholder replaced below'''
new_rules = '''        q := func(base string, extra map[string]string) string {
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
                return s.platformCall("GET", q("/api/v1/rules", extra), nil)'''
if old_rules in src:
    src = src.replace(old_rules, new_rules, 1)
    print("✓ list_rules case implemented")
else:
    print("- list_rules case already implemented")

# 4. list_events case
old_events = '''        case "list_events":
                limit := 20.0
                if v, ok := args["limit"].(float64); ok {
                        limit = v
                }
                return s.platformCall("GET", fmt.Sprintf("/api/v1/flags?user=ada&limit=%d", int(limit)), nil) // placeholder'''
new_events = '''        case "list_events":
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
                return s.platformCall("GET", q("/api/v1/events", extra), nil)'''
if old_events in src:
    src = src.replace(old_events, new_events, 1)
    print("✓ list_events case implemented")
else:
    print("- list_events case already implemented")

# 5. evaluate_formula case body
old_eval = '''                // evaluate via the Rust core engine CLI
                return map[string]any{"note": "evaluate via gog-engine CLI", "expr": expr, "vars": vars}, nil'''
new_eval = '''                return s.platformCall("POST", "/api/v1/formulas/evaluate", map[string]any{"expr": expr, "vars": vars})'''
if old_eval in src:
    src = src.replace(old_eval, new_eval, 1)
    print("✓ evaluate_formula case implemented")
else:
    print("- evaluate_formula case already implemented")

# 6. list_capabilities case
old_caps = '''        case "list_capabilities":
                return s.platformCall("GET", "/api/admin/registry/list", nil)'''
new_caps = '''        case "list_capabilities":
                return s.platformCall("GET", "/api/v1/capabilities", nil)'''
if old_caps in src:
    src = src.replace(old_caps, new_caps, 1)
    print("✓ list_capabilities case implemented")
else:
    print("- list_capabilities case already implemented")

# sanity: no placeholders remain
leftovers = re.findall(r"placeholder|gog-engine CLI|api/admin/registry", src)
if leftovers:
    print(f"⚠️ leftover markers: {leftovers}", file=sys.stderr)
    sys.exit(1)

if src != orig:
    open(PATH, "w", encoding="utf-8").write(src)
    print("wrote patched mcp.go")
else:
    print("no changes needed")
