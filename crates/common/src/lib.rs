//! GamificationOG — common types (Section 5, 6, 10).
//! Canonical domain primitives shared by every Rust crate: the canonical
//! event, the condition tree, action definitions, progression tracks.
//! Mirrors the TypeScript core types 1:1 for cross-language parity.

use serde::{Deserialize, Serialize};

/// Canonical Event (Section 10) — the universal input contract.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CanonicalEvent {
    pub event_type: String,
    #[serde(default)]
    pub event_version: Option<u32>,
    #[serde(default)]
    pub external_user_id: Option<String>,
    #[serde(default)]
    pub subject_id: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub occurred_at: Option<String>,
    #[serde(default)]
    pub idempotency_key: Option<String>,
    #[serde(default)]
    pub correlation_id: Option<String>,
    #[serde(default)]
    pub causation_id: Option<String>,
    #[serde(default)]
    pub payload: serde_json::Value,
    #[serde(default)]
    pub metadata: serde_json::Value,
}

/// Field condition leaf: `field <op> value`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FieldCondition {
    pub field: String,
    pub operator: String,
    pub value: serde_json::Value,
}

/// Condition tree (Section 13): nested and/or/not with leaf conditions.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ConditionNode {
    Leaf(FieldCondition),
    Group {
        op: GroupOp,
        conditions: Vec<ConditionNode>,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum GroupOp {
    And,
    Or,
    Not,
}

/// Action definition (Section 15): `type` + params.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionDefinition {
    #[serde(rename = "type")]
    pub action_type: String,
    #[serde(default)]
    pub params: serde_json::Value,
}

/// A rule (Section 13): WHEN event → IF conditions → THEN actions,
/// with priority, cooldown, frequency cap, schedule window and status.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Rule {
    pub name: String,
    pub event_type: String,
    #[serde(default)]
    pub priority: i64,
    #[serde(default)]
    pub conditions: Option<ConditionNode>,
    pub actions: Vec<ActionDefinition>,
    #[serde(default)]
    pub cooldown_seconds: Option<u64>,
    #[serde(default)]
    pub frequency_cap: Option<u64>,
    #[serde(default)]
    pub status: Option<String>,
}

/// Progression track curve types (Section 20).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum TrackType {
    Linear,
    Exponential,
    Custom,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProgressionTrack {
    pub code: String,
    #[serde(rename = "type")]
    pub track_type: TrackType,
    #[serde(default = "default_base_xp")]
    pub base_xp_per_level: f64,
    #[serde(default = "default_growth")]
    pub growth_factor: f64,
    #[serde(default = "default_max_level")]
    pub max_level: u32,
}

fn default_base_xp() -> f64 {
    100.0
}
fn default_growth() -> f64 {
    1.0
}
fn default_max_level() -> u32 {
    50
}

/// The 17 comparison operators supported by the condition engine
/// (Section 13) — used by the rules crate for validation.
pub const OPERATORS: &[&str] = &[
    "eq", "neq", "gt", "gte", "lt", "lte", "in", "nin", "contains", "starts_with", "ends_with",
    "exists", "not_exists", "between", "regex", "is_empty", "is_true",
];

/// Engine result of processing one event through a rule set.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProcessingOutcome {
    pub matched_rules: Vec<String>,
    pub executed_actions: Vec<ActionExecution>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionExecution {
    pub rule: String,
    pub action: String,
    pub detail: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_event_parses_minimal() {
        let e: CanonicalEvent = serde_json::from_str(
            r#"{"event_type":"task.completed","payload":{"difficulty":"hard"}}"#,
        )
        .unwrap();
        assert_eq!(e.event_type, "task.completed");
        assert_eq!(e.payload["difficulty"], "hard");
        assert!(e.idempotency_key.is_none());
    }

    #[test]
    fn condition_tree_parses_nested() {
        let tree: ConditionNode = serde_json::from_str(
            r#"{"op":"and","conditions":[{"field":"user.level","operator":"gte","value":3},{"op":"or","conditions":[{"field":"event.payload.difficulty","operator":"eq","value":"hard"}]}]}"#,
        )
        .unwrap();
        match tree {
            ConditionNode::Group { op: GroupOp::And, conditions } => {
                assert_eq!(conditions.len(), 2);
            }
            _ => panic!("expected group"),
        }
    }

    #[test]
    fn rule_parses_with_defaults() {
        let r: Rule = serde_json::from_str(
            r#"{"name":"r","event_type":"task.completed","actions":[{"type":"award_xp","params":{"amount":"20"}}]}"#,
        )
        .unwrap();
        assert_eq!(r.priority, 0);
        assert_eq!(r.actions.len(), 1);
        assert_eq!(r.actions[0].action_type, "award_xp");
    }
}
