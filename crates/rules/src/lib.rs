//! GamificationOG — Rule Engine (Section 13).
//! Condition-tree evaluation with the full 17-operator set, context
//! field resolution (dot paths), and rule evaluation with
//! priority ordering, cooldowns, frequency caps and schedules.

use gog_common::{ConditionNode, FieldCondition, GroupOp, Rule};
use serde_json::Value;
use std::collections::HashMap;

/// Resolve a dot-path field against a nested JSON context.
pub fn resolve_field(field: &str, context: &Value) -> Value {
    let mut current = context.clone();
    for part in field.split('.') {
        match current {
            Value::Object(ref map) => {
                current = map.get(part).cloned().unwrap_or(Value::Null);
            }
            Value::Array(ref arr) => {
                if let Ok(idx) = part.parse::<usize>() {
                    current = arr.get(idx).cloned().unwrap_or(Value::Null);
                } else {
                    return Value::Null;
                }
            }
            _ => return Value::Null,
        }
    }
    current
}

fn as_num(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.parse::<f64>().ok(),
        Value::Bool(b) => Some(*b as i32 as f64),
        _ => None,
    }
}

fn as_str(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Bool(b) => b.to_string(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// Evaluate a single field condition (17 operators, Section 13).
pub fn evaluate_field_condition(cond: &FieldCondition, context: &Value) -> bool {
    let actual = resolve_field(&cond.field, context);
    let expected = &cond.value;

    match cond.operator.as_str() {
        "eq" => actual == *expected || as_num(&actual).zip(as_num(expected)).map(|(a, b)| a == b).unwrap_or(false),
        "neq" => !(actual == *expected || as_num(&actual).zip(as_num(expected)).map(|(a, b)| a == b).unwrap_or(false)),
        "gt" => as_num(&actual).zip(as_num(expected)).map(|(a, b)| a > b).unwrap_or(false),
        "gte" => as_num(&actual).zip(as_num(expected)).map(|(a, b)| a >= b).unwrap_or(false),
        "lt" => as_num(&actual).zip(as_num(expected)).map(|(a, b)| a < b).unwrap_or(false),
        "lte" => as_num(&actual).zip(as_num(expected)).map(|(a, b)| a <= b).unwrap_or(false),
        "in" => match expected {
            Value::Array(items) => items.iter().any(|i| i == &actual),
            Value::String(s) => s.split(',').any(|p| p.trim() == as_str(&actual)),
            _ => false,
        },
        "nin" => match expected {
            Value::Array(items) => !items.iter().any(|i| i == &actual),
            Value::String(s) => !s.split(',').any(|p| p.trim() == as_str(&actual)),
            _ => false,
        },
        "contains" => match (&actual, expected) {
            (Value::String(a), Value::String(b)) => a.contains(b),
            (Value::Array(a), e) => a.contains(e),
            (Value::String(a), e) => a.contains(&e.to_string()),
            _ => false,
        },
        "starts_with" => matches!((&actual, expected), (Value::String(a), Value::String(b)) if a.starts_with(b)),
        "ends_with" => matches!((&actual, expected), (Value::String(a), Value::String(b)) if a.ends_with(b)),
        "exists" => !actual.is_null(),
        "not_exists" => actual.is_null(),
        "between" => {
            if let Value::Array(range) = expected {
                if range.len() == 2 {
                    if let (Some(a), Some(lo), Some(hi)) = (as_num(&actual), as_num(&range[0]), as_num(&range[1])) {
                        return a >= lo && a <= hi;
                    }
                }
            }
            false
        }
        "regex" => {
            let pattern = as_str(expected);
            regex::Regex::new(&pattern)
                .map(|re| re.is_match(&as_str(&actual)))
                .unwrap_or(false)
        }
        "is_empty" => match &actual {
            Value::Null => true,
            Value::String(s) => s.is_empty(),
            Value::Array(a) => a.is_empty(),
            _ => false,
        },
        "is_true" => as_num(&actual).map(|a| a != 0.0).unwrap_or(actual == Value::Bool(true)),
        _ => false,
    }
}

/// Evaluate a full condition tree against a context.
pub fn evaluate_condition(node: &ConditionNode, context: &Value) -> bool {
    match node {
        ConditionNode::Leaf(cond) => evaluate_field_condition(cond, context),
        ConditionNode::Group { op, conditions } => match op {
            GroupOp::And => conditions.iter().all(|c| evaluate_condition(c, context)),
            GroupOp::Or => conditions.iter().any(|c| evaluate_condition(c, context)),
            GroupOp::Not => conditions.iter().map(|c| evaluate_condition(c, context)).next().map(|b| !b).unwrap_or(true),
        },
    }
}

/// Rule evaluation bookkeeping (Section 13): per rule last-fired times
/// for cooldowns and frequency caps.
#[derive(Debug, Default, Clone)]
pub struct RuleState {
    /// rule name → unix seconds of last firing
    pub last_fired: HashMap<String, i64>,
    /// rule name → (window start seconds, fire count)
    pub window_counts: HashMap<String, (i64, u64)>,
}

pub struct RuleEngine {
    pub rules: Vec<Rule>,
    pub state: RuleState,
}

impl RuleEngine {
    pub fn new(rules: Vec<Rule>) -> Self {
        let mut rules = rules;
        // priority descending (Section 13: highest priority first)
        rules.sort_by(|a, b| b.priority.cmp(&a.priority));
        RuleEngine { rules, state: RuleState::default() }
    }

    fn status_active(rule: &Rule) -> bool {
        matches!(rule.status.as_deref(), None | Some("active") | Some("published"))
    }

    fn within_cooldown(&self, rule: &Rule, now: i64) -> bool {
        match rule.cooldown_seconds {
            Some(cd) if cd > 0 => match self.state.last_fired.get(&rule.name) {
                Some(last) => now.saturating_sub(*last) < cd as i64,
                None => false,
            },
            _ => false,
        }
    }

    /// Evaluate all rules for one event at a point in time. Returns the
    /// names of rules that matched (in priority order).
    pub fn evaluate_event(&mut self, event_type: &str, context: &Value, now: i64) -> Vec<&Rule> {
        let mut matched = Vec::new();
        for rule in self.rules.iter() {
            if rule.event_type != event_type {
                continue;
            }
            if !Self::status_active(rule) {
                continue;
            }
            if self.within_cooldown(rule, now) {
                continue;
            }
            // frequency cap check requires &mut self — do it on a clone of the name
            let over_cap = {
                let cap = rule.frequency_cap;
                match cap {
                    Some(c) if c > 0 => {
                        let window = now - (now % 86400);
                        let entry = self.state.window_counts.entry(rule.name.clone()).or_insert((window, 0));
                        if entry.0 != window {
                            *entry = (window, 0);
                        }
                        entry.1 >= c
                    }
                    _ => false,
                }
            };
            if over_cap {
                continue;
            }
            let conditions_match = match &rule.conditions {
                None => true,
                Some(tree) if matches!(tree, ConditionNode::Group { conditions, .. } if conditions.is_empty()) => true,
                Some(tree) => evaluate_condition(tree, context),
            };
            if !conditions_match {
                continue;
            }
            matched.push(rule);
        }
        matched
    }

    /// Mark a rule as fired (updates cooldown + frequency state).
    pub fn record_firing(&mut self, rule_name: &str, now: i64) {
        self.state.last_fired.insert(rule_name.to_string(), now);
        let window = now - (now % 86400);
        let entry = self.state.window_counts.entry(rule_name.to_string()).or_insert((window, 0));
        if entry.0 != window {
            *entry = (window, 0);
        }
        entry.1 += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ctx() -> Value {
        json!({
            "user": { "level": 4, "xp": 350, "attribute": { "plan": "pro" } },
            "event": { "type": "task.completed", "payload": { "difficulty": "hard", "count": 3, "tags": ["deep", "focus"] } },
            "time": { "hour_of_day": 21 }
        })
    }

    #[test]
    fn resolves_nested_fields() {
        assert_eq!(resolve_field("user.level", &ctx()), json!(4));
        assert_eq!(resolve_field("event.payload.difficulty", &ctx()), json!("hard"));
        assert_eq!(resolve_field("time.hour_of_day", &ctx()), json!(21));
        assert_eq!(resolve_field("user.missing", &ctx()), Value::Null);
    }

    #[test]
    fn operators_work() {
        let c = ctx();
        let f = |field: &str, op: &str, value: Value| {
            evaluate_field_condition(&FieldCondition { field: field.into(), operator: op.into(), value }, &c)
        };
        assert!(f("user.level", "gte", json!(3)));
        assert!(f("event.payload.difficulty", "eq", json!("hard")));
        assert!(f("event.payload.count", "between", json!([1, 5])));
        assert!(f("event.payload.difficulty", "in", json!(["hard", "extreme"])));
        assert!(f("event.payload.tags", "contains", json!("focus")));
        assert!(f("event.payload.difficulty", "starts_with", json!("ha")));
        assert!(f("user.attribute.plan", "exists", json!(null)));
        assert!(f("user.missing", "not_exists", json!(null)));
        assert!(f("event.payload.difficulty", "regex", json!("^h")));
        assert!(!f("user.level", "lt", json!(3)));
    }

    #[test]
    fn condition_trees_evaluate() {
        let tree: ConditionNode = serde_json::from_str(
            r#"{"op":"and","conditions":[{"field":"user.level","operator":"gte","value":3},{"op":"or","conditions":[{"field":"time.hour_of_day","operator":"gte","value":20},{"field":"time.hour_of_day","operator":"lte","value":4}]}]}"#,
        )
        .unwrap();
        assert!(evaluate_condition(&tree, &ctx()));

        let not_tree: ConditionNode =
            serde_json::from_str(r#"{"op":"not","conditions":[{"field":"user.level","operator":"gte","value":100}]}"#).unwrap();
        assert!(evaluate_condition(&not_tree, &ctx()));
    }

    #[test]
    fn engine_priority_order_and_matching() {
        let rules = vec![
            serde_json::from_str(r#"{"name":"low","event_type":"task.completed","priority":10,"actions":[]}"#).unwrap(),
            serde_json::from_str(
                r#"{"name":"high","event_type":"task.completed","priority":100,"conditions":{"op":"and","conditions":[{"field":"user.level","operator":"gte","value":3}]},"actions":[]}"#,
            )
            .unwrap(),
        ];
        let mut engine = RuleEngine::new(rules);
        let matched = engine.evaluate_event("task.completed", &ctx(), 1000);
        assert_eq!(matched.len(), 2);
        assert_eq!(matched[0].name, "high"); // priority ordering
        assert_eq!(matched[1].name, "low");
    }

    #[test]
    fn cooldown_blocks_refiring() {
        let rules: Vec<Rule> = vec![serde_json::from_str(
            r#"{"name":"gated","event_type":"task.completed","priority":1,"cooldown_seconds":60,"actions":[]}"#,
        )
        .unwrap()];
        let mut engine = RuleEngine::new(rules);
        assert_eq!(engine.evaluate_event("task.completed", &ctx(), 1000).len(), 1);
        engine.record_firing("gated", 1000);
        // within cooldown (1000 + 60)
        assert_eq!(engine.evaluate_event("task.completed", &ctx(), 1050).len(), 0);
        // past cooldown
        assert_eq!(engine.evaluate_event("task.completed", &ctx(), 1100).len(), 1);
    }

    #[test]
    fn frequency_cap_limits_daily() {
        let rules: Vec<Rule> = vec![serde_json::from_str(
            r#"{"name":"capped","event_type":"task.completed","priority":1,"frequency_cap":2,"actions":[]}"#,
        )
        .unwrap()];
        let mut engine = RuleEngine::new(rules);
        let t = 5000;
        for _ in 0..2 {
            assert_eq!(engine.evaluate_event("task.completed", &ctx(), t).len(), 1);
            engine.record_firing("capped", t);
        }
        assert_eq!(engine.evaluate_event("task.completed", &ctx(), t).len(), 0);
    }

    #[test]
    fn inactive_rules_skipped() {
        let rules: Vec<Rule> = vec![serde_json::from_str(
            r#"{"name":"off","event_type":"task.completed","priority":1,"status":"paused","actions":[]}"#,
        )
        .unwrap()];
        let mut engine = RuleEngine::new(rules);
        assert_eq!(engine.evaluate_event("task.completed", &ctx(), 1000).len(), 0);
    }
}
