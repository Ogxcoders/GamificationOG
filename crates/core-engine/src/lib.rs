//! GamificationOG — Core Engine facade + CLI.
//! The Rust "brain" (Section 87): formulas, rules, progression, ranking
//! and deterministic simulation, usable as a library or CLI for parity
//! checks, batch evaluation, and pre-publish simulation.

pub use gog_common;
pub use gog_formulas;
pub use gog_progression;
pub use gog_ranking;
pub use gog_rules;
pub use gog_simulation;

use gog_common::{CanonicalEvent, ProgressionTrack, Rule};
use gog_simulation::Simulator;
use serde_json::Value;

/// One-shot: evaluate a formula with a JSON variable map.
pub fn eval_formula(expr: &str, variables: &Value) -> Result<f64, String> {
    let map = variables.as_object().cloned().unwrap_or_default();
    gog_formulas::Engine::new(map).evaluate(expr).map_err(|e| e.to_string())
}

/// One-shot: simulate events through a rule set (deterministic).
pub fn simulate(rules: &[Rule], track: &ProgressionTrack, custom_formula: Option<String>, events: &[CanonicalEvent]) -> Value {
    let sim = Simulator::new(rules.to_vec(), track.clone(), custom_formula);
    let report = sim.run(events);
    serde_json::to_value(&report).unwrap_or(Value::Null)
}

/// Dense-rank a score list ("100,100,90,80" → [1,1,2,3]).
pub fn rank_scores(scores: &[f64], lowest_wins: bool) -> Vec<u32> {
    let mut lb = gog_ranking::Leaderboard::new(
        "cli",
        if lowest_wins { gog_ranking::Algorithm::Lowest } else { gog_ranking::Algorithm::Highest },
        None,
    );
    for (i, s) in scores.iter().enumerate() {
        lb.submit(&format!("u{}", i), *s, i as i64);
    }
    // map back to input order
    let ranked = lb.ranked();
    let mut by_user = std::collections::HashMap::new();
    for r in &ranked {
        by_user.insert(r.user.clone(), r.rank);
    }
    scores
        .iter()
        .enumerate()
        .map(|(i, _)| by_user.get(&format!("u{}", i)).copied().unwrap_or(0))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn facade_formula() {
        let vars = serde_json::json!({ "x": 30.0 });
        assert_eq!(eval_formula("min(x * 2, 60)", &vars).unwrap(), 60.0);
    }

    #[test]
    fn facade_ranking() {
        assert_eq!(rank_scores(&[100.0, 100.0, 90.0, 80.0], false), vec![1, 1, 2, 3]);
        assert_eq!(rank_scores(&[40.0, 50.0, 60.0], true), vec![1, 2, 3]);
    }
}
