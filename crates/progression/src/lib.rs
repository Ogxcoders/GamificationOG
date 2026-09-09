//! GamificationOG — Progression Engine (Section 20).
//! XP → level resolution with exact TypeScript parity:
//!   linear:       level = floor(xp / base_xp_per_level) + 1
//!   exponential:  cumulative walk, level cost = base * growth^(n-1)
//!   custom:       level = floor(formula(xp)) — formula receives { xp }
//! xp_into_level and xp_for_next_level mirror the TS state snapshot.

use gog_common::{ProgressionTrack, TrackType};
use std::collections::HashMap;

#[derive(Debug, Clone)]
pub struct Engine {
    pub track: ProgressionTrack,
    custom_formula: Option<String>,
}

impl Engine {
    pub fn new(track: ProgressionTrack) -> Self {
        Engine { track, custom_formula: None }
    }

    pub fn with_custom_formula(mut self, formula: Option<String>) -> Self {
        self.custom_formula = formula;
        self
    }

    /// Resolve the level for a total XP amount (TS parity).
    pub fn level_for_xp(&self, xp: f64) -> u32 {
        let t = &self.track;
        let base = if t.base_xp_per_level > 0.0 { t.base_xp_per_level } else { 1.0 };
        let mut level: u32 = 1;
        match t.track_type {
            TrackType::Linear => {
                level = (xp / base).floor() as u32 + 1;
            }
            TrackType::Exponential => {
                let growth = if t.growth_factor > 1.0 { t.growth_factor } else { 1.15 };
                let mut required = t.base_xp_per_level;
                let mut cumulative = 0.0;
                while cumulative + required <= xp && level < t.max_level {
                    cumulative += required;
                    required = (required * growth).round();
                    level += 1;
                }
            }
            TrackType::Custom => {
                let formula = match &self.custom_formula {
                    Some(f) => f.clone(),
                    None => String::new(),
                };
                if formula.is_empty() {
                    level = (xp / base).floor() as u32 + 1;
                } else {
                    let mut vars = HashMap::new();
                    vars.insert("xp".to_string(), serde_json::json!(xp));
                    let computed = gog_formulas::eval(&formula, &vars).unwrap_or(xp / base);
                    level = computed.floor().max(1.0) as u32;
                }
            }
        }
        level.clamp(1, t.max_level)
    }

    /// Cumulative XP needed to reach a level (inverse mapping, linear exact).
    pub fn total_xp_for_level(&self, level: u32) -> f64 {
        let t = &self.track;
        let level = level.clamp(1, t.max_level);
        match t.track_type {
            TrackType::Linear => (level as f64 - 1.0) * t.base_xp_per_level,
            TrackType::Exponential => {
                let growth = if t.growth_factor > 1.0 { t.growth_factor } else { 1.15 };
                let mut total = 0.0;
                let mut required = t.base_xp_per_level;
                for _ in 1..level {
                    total += required;
                    required = (required * growth).round();
                }
                total
            }
            TrackType::Custom => {
                // binary search on level_for_xp for the custom curve
                let mut lo = 0.0f64;
                let mut hi = 1e12f64;
                for _ in 0..80 {
                    let mid = (lo + hi) / 2.0;
                    if self.level_for_xp(mid) < level {
                        lo = mid;
                    } else {
                        hi = mid;
                    }
                }
                hi
            }
        }
    }

    /// XP required to advance from the current level to the next.
    pub fn xp_for_next_level(&self, current_level: u32) -> f64 {
        if current_level >= self.track.max_level {
            return f64::INFINITY;
        }
        self.total_xp_for_level(current_level + 1) - self.total_xp_for_level(current_level)
    }

    /// Full state snapshot (TS parity: level, xp_into, xp_for_next, %).
    pub fn resolve(&self, total_xp: f64) -> LevelState {
        let level = self.level_for_xp(total_xp.max(0.0));
        let level_base = self.total_xp_for_level(level);
        let xp_into = (total_xp.max(0.0) - level_base).max(0.0);
        let need = self.xp_for_next_level(level);
        let percent = if need.is_finite() && need > 0.0 {
            ((xp_into / need) * 100.0).clamp(0.0, 100.0)
        } else {
            100.0
        };
        LevelState { level, xp_into_level: xp_into, xp_for_next_level: need, progress_percent: percent }
    }

    /// Award XP and compute level-ups (before → after).
    pub fn award_xp(&self, current_xp: f64, amount: f64) -> XpAward {
        let new_total = (current_xp + amount).max(0.0);
        let before = self.level_for_xp(current_xp.max(0.0));
        let after = self.level_for_xp(new_total);
        XpAward { total_xp: new_total, level_before: before, level_after: after, level_up: after > before }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct LevelState {
    pub level: u32,
    pub xp_into_level: f64,
    pub xp_for_next_level: f64,
    pub progress_percent: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct XpAward {
    pub total_xp: f64,
    pub level_before: u32,
    pub level_after: u32,
    pub level_up: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn linear() -> Engine {
        Engine::new(ProgressionTrack {
            code: "default".into(),
            track_type: TrackType::Linear,
            base_xp_per_level: 100.0,
            growth_factor: 1.0,
            max_level: 50,
        })
    }

    #[test]
    fn linear_parity_with_ts() {
        // TS: level = floor(xp / base) + 1 → 350/100 = level 4
        assert_eq!(linear().level_for_xp(350.0), 4);
        assert_eq!(linear().level_for_xp(0.0), 1);
        assert_eq!(linear().level_for_xp(99.0), 1);
        assert_eq!(linear().level_for_xp(100.0), 2);
        assert_eq!(linear().level_for_xp(299.0), 3);
        assert_eq!(linear().level_for_xp(300.0), 4);
    }

    #[test]
    fn linear_state_snapshot() {
        // 350 XP → level 4, 50 into, next at 400 (TS: xpForNextLevel 400)
        let s = linear().resolve(350.0);
        assert_eq!(s.level, 4);
        assert_eq!(s.xp_into_level, 50.0);
        assert_eq!(s.xp_for_next_level, 100.0);
        assert!((s.progress_percent - 50.0).abs() < 1e-9);
    }

    #[test]
    fn award_triggers_level_up() {
        // 350 + 50 = 400 → level 5
        let r = linear().award_xp(350.0, 50.0);
        assert!(r.level_up);
        assert_eq!(r.level_before, 4);
        assert_eq!(r.level_after, 5);
    }

    #[test]
    fn exponential_walk_parity() {
        let engine = Engine::new(ProgressionTrack {
            code: "exp".into(),
            track_type: TrackType::Exponential,
            base_xp_per_level: 50.0,
            growth_factor: 1.5,
            max_level: 20,
        });
        // level 1 at 0; level 2 at 50; level 3 at 50+75=125; level 4 at 125+113=238
        assert_eq!(engine.level_for_xp(0.0), 1);
        assert_eq!(engine.level_for_xp(50.0), 2);
        assert_eq!(engine.level_for_xp(124.0), 2);
        assert_eq!(engine.level_for_xp(125.0), 3);
        assert_eq!(engine.level_for_xp(238.0), 4);
    }

    #[test]
    fn custom_formula_parity() {
        // TS custom: level = floor(formula(xp)) — formula receives xp
        let engine = Engine::new(ProgressionTrack {
            code: "custom".into(),
            track_type: TrackType::Custom,
            base_xp_per_level: 100.0,
            growth_factor: 1.0,
            max_level: 10,
        })
        .with_custom_formula(Some("1 + xp / 200".into()));
        assert_eq!(engine.level_for_xp(0.0), 1);
        assert_eq!(engine.level_for_xp(200.0), 2);
        assert_eq!(engine.level_for_xp(600.0), 4);
    }

    #[test]
    fn max_level_clamps() {
        let engine = Engine::new(ProgressionTrack {
            code: "cap".into(),
            track_type: TrackType::Linear,
            base_xp_per_level: 10.0,
            growth_factor: 1.0,
            max_level: 3,
        });
        assert_eq!(engine.level_for_xp(10000.0), 3);
        let s = engine.resolve(10000.0);
        assert_eq!(s.progress_percent, 100.0);
        assert!(s.xp_for_next_level.is_infinite());
    }
}
