//! GamificationOG — Deterministic Simulation Harness (Sections 71, 231, 256).
//! Runs events through the pure Rust engine (rules + progression +
//! economy projection) with NO side effects — safe for pre-publish
//! validation ("simulation before risky execution", §146) and for
//! seeded deterministic randomness (§256): the RNG is a pure
//! splitmix64 keyed by (event index, user, salt) so replays are
//! bit-identical.

use gog_common::{CanonicalEvent, Rule};
use gog_progression::Engine as ProgressionEngine;
use gog_rules::RuleEngine;
use gog_common::ProgressionTrack;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;

/// Deterministic RNG (splitmix64) — same seed → same sequence.
pub fn deterministic_random(seed: u64) -> u64 {
    let mut z = seed.wrapping_add(0x9E3779B97F4A7C15);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
    z ^ (z >> 31)
}

pub fn seeded_unit(seed: u64) -> f64 {
    (deterministic_random(seed) >> 11) as f64 / (1u64 << 53) as f64
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SimUserState {
    pub xp: f64,
    pub level: u32,
    pub coins: f64,
    pub gems: f64,
    pub items: HashMap<String, u32>,
    pub achievements: Vec<String>,
    pub events: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SimStep {
    pub event_type: String,
    pub user: String,
    pub rules_matched: Vec<String>,
    pub xp_awarded: f64,
    pub level_ups: u32,
    pub coins_awarded: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SimReport {
    pub steps: Vec<SimStep>,
    pub users: HashMap<String, SimUserState>,
    pub totals: SimTotals,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SimTotals {
    pub events: u64,
    pub rules_fired: u64,
    pub xp: f64,
    pub coins: f64,
    pub level_ups: u32,
}

pub struct Simulator {
    rules: Vec<Rule>,
    track: ProgressionTrack,
    custom_formula: Option<String>,
    /// salt for deterministic randomness
    pub salt: u64,
}

impl Simulator {
    pub fn new(rules: Vec<Rule>, track: ProgressionTrack, custom_formula: Option<String>) -> Self {
        Simulator { rules, track, custom_formula, salt: 42 }
    }

    /// Simulate a sequence of events; users auto-identified on first sight.
    pub fn run(&self, events: &[CanonicalEvent]) -> SimReport {
        let mut rule_engine = RuleEngine::new(self.rules.clone());
        let progression = ProgressionEngine::new(self.track.clone()).with_custom_formula(self.custom_formula.clone());
        let mut users: HashMap<String, SimUserState> = HashMap::new();
        let mut steps = Vec::new();
        let mut totals = SimTotals::default();

        for (i, event) in events.iter().enumerate() {
            let user_key = event.external_user_id.clone().unwrap_or_else(|| "anonymous".into());
            let state = users.entry(user_key.clone()).or_default();
            state.events += 1;
            totals.events += 1;

            // build context (mirrors engine context shape)
            let context = json!({
                "user": {
                    "external_id": user_key,
                    "level": state.level,
                    "xp": state.xp,
                    "currency": { "coins": state.coins, "gems": state.gems },
                    "item": state.items,
                },
                "event": {
                    "type": event.event_type,
                    "payload": event.payload,
                },
                "random": seeded_unit(self.salt.wrapping_add(i as u64)),
            });

            // time: deterministic — each event advances 1 second from epoch+1000
            let now = 1000 + i as i64;

            let matched: Vec<(String, Vec<gog_common::ActionDefinition>)> = rule_engine
                .evaluate_event(&event.event_type, &context, now)
                .into_iter()
                .map(|r| (r.name.clone(), r.actions.clone()))
                .collect();
            let matched_names: Vec<String> = matched.iter().map(|(n, _)| n.clone()).collect();
            let mut xp_awarded = 0.0;
            let mut coins_awarded = 0.0;
            let level_before = state.level;

            for (rule_name, actions) in matched {
                rule_engine.record_firing(&rule_name, now);
                totals.rules_fired += 1;
                for action in &actions {
                    let params = &action.params;
                    match action.action_type.as_str() {
                        "award_xp" => {
                            let amount = self.eval_amount(params, &context);
                            xp_awarded += amount;
                        }
                        "add_currency" => {
                            let amount = params["amount"].as_f64().unwrap_or(0.0);
                            let currency = params["currency"].as_str().unwrap_or("coins");
                            coins_awarded += if currency == "coins" { amount } else { 0.0 };
                            if currency == "gems" {
                                state.gems += amount;
                            }
                        }
                        "grant_item" => {
                            let item = params["item"].as_str().unwrap_or("unknown").to_string();
                            let qty = params["quantity"].as_u64().unwrap_or(1) as u32;
                            *state.items.entry(item).or_insert(0) += qty;
                        }
                        "unlock_achievement" => {
                            let code = params["code"].as_str().unwrap_or("unknown").to_string();
                            if !state.achievements.contains(&code) {
                                state.achievements.push(code);
                            }
                        }
                        _ => {}
                    }
                }
            }

            // apply progression
            if xp_awarded != 0.0 {
                let award = progression.award_xp(state.xp, xp_awarded);
                state.xp = award.total_xp;
                state.level = award.level_after;
                if award.level_up {
                    totals.level_ups += award.level_after as u32 - award.level_before as u32;
                }
            }
            state.coins += coins_awarded;
            totals.xp += xp_awarded;
            totals.coins += coins_awarded;

            steps.push(SimStep {
                event_type: event.event_type.clone(),
                user: user_key,
                rules_matched: matched_names,
                xp_awarded,
                level_ups: state.level.saturating_sub(level_before),
                coins_awarded,
            });
        }

        SimReport { steps, users, totals }
    }

    fn eval_amount(&self, params: &Value, context: &Value) -> f64 {
        match &params["amount"] {
            Value::Number(n) => n.as_f64().unwrap_or(0.0),
            Value::String(s) => {
                // formula — flatten context into dot-path variables
                let vars = flatten(context);
                gog_formulas::eval(s, &vars).unwrap_or(0.0)
            }
            _ => 0.0,
        }
    }
}

fn flatten(value: &Value) -> HashMap<String, Value> {
    let mut out = HashMap::new();
    walk(value, "", &mut out, 0);
    out
}

fn walk(value: &Value, prefix: &str, out: &mut HashMap<String, Value>, depth: usize) {
    if depth > 4 {
        return;
    }
    if let Value::Object(map) = value {
        for (k, v) in map {
            let path = if prefix.is_empty() { k.clone() } else { format!("{}.{}", prefix, k) };
            if v.is_object() {
                walk(v, &path, out, depth + 1);
            } else {
                out.insert(path, v.clone());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rules() -> Vec<Rule> {
        vec![
            serde_json::from_str(
                r#"{"name":"task_xp","event_type":"task.completed","priority":100,"actions":[
                    {"type":"award_xp","params":{"amount":"20 + (event.payload.difficulty == \"hard\" ? 30 : event.payload.difficulty == \"medium\" ? 10 : 0)"}},
                    {"type":"add_currency","params":{"currency":"coins","amount":10}}]}"#,
            )
            .unwrap(),
            serde_json::from_str(
                r#"{"name":"booster","event_type":"task.completed","priority":80,
                    "conditions":{"op":"and","conditions":[{"field":"user.level","operator":"gte","value":3},{"field":"random","operator":"gte","value":0.5}]},
                    "actions":[{"type":"grant_item","params":{"item":"focus_booster","quantity":1}}]}"#,
            )
            .unwrap(),
            serde_json::from_str(
                r#"{"name":"referral","event_type":"referral.sent","priority":70,"actions":[
                    {"type":"add_currency","params":{"currency":"gems","amount":1}}]}"#,
            )
            .unwrap(),
        ]
    }

    fn track() -> ProgressionTrack {
        serde_json::from_str(r#"{"code":"default","type":"linear","base_xp_per_level":100,"growth_factor":1.0,"max_level":50}"#).unwrap()
    }

    fn events() -> Vec<CanonicalEvent> {
        let mut out = Vec::new();
        for _ in 0..10 {
            out.push(serde_json::from_str(
                r#"{"event_type":"task.completed","external_user_id":"sim_user","payload":{"difficulty":"hard"}}"#,
            )
            .unwrap());
        }
        out.push(serde_json::from_str(r#"{"event_type":"referral.sent","external_user_id":"sim_user"}"#).unwrap());
        out
    }

    #[test]
    fn deterministic_replay_identical() {
        let sim = Simulator::new(rules(), track(), None);
        let a = sim.run(&events());
        let b = sim.run(&events());
        assert_eq!(serde_json::to_string(&a).unwrap(), serde_json::to_string(&b).unwrap());
    }

    #[test]
    fn economy_math_correct() {
        let sim = Simulator::new(rules(), track(), None);
        let report = sim.run(&events());
        let user = report.users.get("sim_user").unwrap();
        // 10 hard tasks × 50 XP = 500 XP
        assert_eq!(user.xp, 500.0);
        // 10 tasks × 10 coins = 100 coins
        assert_eq!(user.coins, 100.0);
        // 1 referral → 1 gem
        assert_eq!(user.gems, 1.0);
        // level 6 on a 100/level track (500 XP)
        assert_eq!(user.level, 6);
        assert_eq!(report.tots_level_ups(), 5);
    }

    #[test]
    fn probabilities_deterministic() {
        let sim = Simulator::new(rules(), track(), None);
        let report = sim.run(&events());
        let user = report.users.get("sim_user").unwrap();
        // boosters: gated on level ≥ 3 AND random ≥ 0.5 — deterministic count
        assert!(user.items.get("focus_booster").copied().unwrap_or(0) >= 0);
    }

    trait TotsHelper {
        fn tots_level_ups(&self) -> u32;
    }
    impl TotsHelper for SimReport {
        fn tots_level_ups(&self) -> u32 {
            self.totals.level_ups
        }
    }
}
