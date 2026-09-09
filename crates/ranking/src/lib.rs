//! GamificationOG — Leaderboard & Ranking Engine (Section 29).
//! Deterministic dense ranking (1, 1, 2, 3…) with tie-breaking by
//! earliest-achieved score, plus windowed snapshots and "around me"
//! pagination — identical semantics to the TypeScript engine.

use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScoreEntry {
    pub user: String,
    pub score: f64,
    /// unix millis when this score was last achieved (tie breaker)
    #[serde(default = "now_millis")]
    pub achieved_at: i64,
}

fn now_millis() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Algorithm {
    Highest,
    Lowest,
}

#[derive(Debug, Clone)]
pub struct Leaderboard {
    pub code: String,
    pub algorithm: Algorithm,
    /// time window in seconds (None = all_time)
    pub window_seconds: Option<u64>,
    entries: Vec<ScoreEntry>,
}

impl Leaderboard {
    pub fn new(code: impl Into<String>, algorithm: Algorithm, window_seconds: Option<u64>) -> Self {
        Leaderboard { code: code.into(), algorithm, window_seconds, entries: Vec::new() }
    }

    /// Submit (or improve) a user's score.
    pub fn submit(&mut self, user: &str, score: f64, at: i64) {
        if let Some(entry) = self.entries.iter_mut().find(|e| e.user == user) {
            let better = match self.algorithm {
                Algorithm::Highest => score >= entry.score,
                Algorithm::Lowest => score <= entry.score,
            };
            if better {
                entry.score = score;
                entry.achieved_at = at;
            }
        } else {
            self.entries.push(ScoreEntry { user: user.into(), score, achieved_at: at });
        }
    }

    /// Deterministic dense ranking: sort by score (algorithm direction),
    /// ties broken by earliest achieved_at, then by user id for total order.
    pub fn ranked(&self) -> Vec<RankedEntry> {
        let mut sorted = self.entries.clone();
        sorted.sort_by(|a, b| {
            let score_ord = match self.algorithm {
                Algorithm::Highest => b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal),
                Algorithm::Lowest => a.score.partial_cmp(&b.score).unwrap_or(std::cmp::Ordering::Equal),
            };
            score_ord
                .then(a.achieved_at.cmp(&b.achieved_at))
                .then(a.user.cmp(&b.user))
        });

        let mut out = Vec::with_capacity(sorted.len());
        let mut current_rank: u32 = 0;
        let mut prev_score: Option<f64> = None;
        for e in sorted {
            if prev_score.map(|p| (p - e.score).abs() > f64::EPSILON).unwrap_or(true) {
                current_rank += 1;
                prev_score = Some(e.score);
            }
            out.push(RankedEntry { rank: current_rank, user: e.user.clone(), score: e.score, achieved_at: e.achieved_at });
        }
        out
    }

    /// Expire entries outside the time window relative to `now`.
    pub fn apply_window(&mut self, now: i64) {
        if let Some(window) = self.window_seconds {
            let cutoff = now - (window as i64 * 1000);
            self.entries.retain(|e| e.achieved_at >= cutoff);
        }
    }

    /// "Around me" view: rank of a user plus their neighbors.
    pub fn around(&self, user: &str, span: usize) -> Option<(usize, Vec<RankedEntry>)> {
        let ranked = self.ranked();
        let idx = ranked.iter().position(|e| e.user == user)?;
        let start = idx.saturating_sub(span);
        let end = (idx + span + 1).min(ranked.len());
        Some((idx, ranked[start..end].to_vec()))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RankedEntry {
    pub rank: u32,
    pub user: String,
    pub score: f64,
    pub achieved_at: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dense_ranking_ties() {
        let mut lb = Leaderboard::new("xp", Algorithm::Highest, None);
        lb.submit("a", 100.0, 1000);
        lb.submit("b", 100.0, 2000);
        lb.submit("c", 90.0, 1500);
        lb.submit("d", 80.0, 500);
        let r = lb.ranked();
        assert_eq!(r[0].rank, 1);
        assert_eq!(r[1].rank, 1); // tie → dense rank
        assert_eq!(r[2].rank, 2);
        assert_eq!(r[3].rank, 3);
        // tie break: earliest achiever first
        assert_eq!(r[0].user, "a");
        assert_eq!(r[1].user, "b");
    }

    #[test]
    fn lowest_wins_algorithm() {
        let mut lb = Leaderboard::new("golf", Algorithm::Lowest, None);
        lb.submit("a", 50.0, 1);
        lb.submit("b", 40.0, 2);
        lb.submit("c", 60.0, 3);
        let r = lb.ranked();
        assert_eq!(r[0].user, "b");
        assert_eq!(r[0].rank, 1);
    }

    #[test]
    fn resubmit_keeps_best() {
        let mut lb = Leaderboard::new("xp", Algorithm::Highest, None);
        lb.submit("a", 100.0, 1);
        lb.submit("a", 50.0, 2); // worse — ignored
        assert_eq!(lb.ranked()[0].score, 100.0);
        lb.submit("a", 150.0, 3); // better — replaces
        assert_eq!(lb.ranked()[0].score, 150.0);
        assert_eq!(lb.ranked().len(), 1);
    }

    #[test]
    fn window_expires_old_scores() {
        let mut lb = Leaderboard::new("daily", Algorithm::Highest, Some(86400));
        lb.submit("old", 500.0, 1_000_000);
        lb.submit("new", 100.0, 200_000_000);
        lb.apply_window(200_000_000);
        let r = lb.ranked();
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].user, "new");
    }

    #[test]
    fn around_me_slice() {
        let mut lb = Leaderboard::new("xp", Algorithm::Highest, None);
        for (i, name) in ["a", "b", "c", "d", "e"].iter().enumerate() {
            lb.submit(name, 100.0 - i as f64, 1000);
        }
        let (idx, view) = lb.around("c", 1).unwrap();
        assert_eq!(idx, 2);
        assert_eq!(view.len(), 3);
        assert_eq!(view[0].user, "b");
        assert_eq!(view[1].user, "c");
        assert_eq!(view[2].user, "d");
    }
}
