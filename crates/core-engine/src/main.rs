//! gog-engine CLI — Rust core engine operations.
//!
//! ```text
//! gog-engine formula "min(x * 2, 60)" --var x=30
//! gog-engine progression --xp 350 --base 100 --max 50
//! gog-engine rank "100,100,90,80" [--lowest]
//! gog-engine simulate --rules rules.json --events events.json
//! gog-engine validate-formula "user.level * 2"
//! ```

use std::collections::HashMap;
use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() {
        print_help();
        return ExitCode::from(2);
    }
    let cmd = args[0].as_str();
    let rest = &args[1..];

    let result: Result<String, String> = match cmd {
        "formula" => cmd_formula(rest),
        "validate-formula" => cmd_validate(rest),
        "progression" => cmd_progression(rest),
        "rank" => cmd_rank(rest),
        "simulate" => cmd_simulate(rest),
        "help" | "--help" | "-h" => {
            print_help();
            return ExitCode::SUCCESS;
        }
        _ => Err(format!("unknown command \"{}\"", cmd)),
    };

    match result {
        Ok(out) => {
            println!("{}", out);
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("error: {}", e);
            ExitCode::from(1)
        }
    }
}

fn flag_value<'a>(rest: &'a [String], name: &str) -> Option<&'a str> {
    rest.iter().position(|a| a == name).and_then(|i| rest.get(i + 1)).map(|s| s.as_str())
}

fn cmd_formula(rest: &[String]) -> Result<String, String> {
    let expr = rest.first().ok_or("usage: formula <expr> [--var name=value ...]")?;
    let mut vars = HashMap::new();
    let mut i = 0;
    while i < rest.len() {
        if rest[i] == "--var" {
            let kv = rest.get(i + 1).ok_or("--var needs name=value")?;
            let (k, v) = kv.split_once('=').ok_or("--var needs name=value")?;
            let value = serde_json::from_str::<serde_json::Value>(v)
                .unwrap_or(serde_json::Value::String(v.to_string()));
            vars.insert(k.to_string(), value);
            i += 2;
        } else {
            i += 1;
        }
    }
    gog_formulas::eval(expr, &vars).map(|n| format_number(n)).map_err(|e| e.to_string())
}

fn cmd_validate(rest: &[String]) -> Result<String, String> {
    let expr = rest.first().ok_or("usage: validate-formula <expr>")?;
    gog_formulas::validate(expr).map(|_| "valid".to_string()).map_err(|e| e.to_string())
}

fn cmd_progression(rest: &[String]) -> Result<String, String> {
    let xp: f64 = flag_value(rest, "--xp").and_then(|v| v.parse().ok()).ok_or("--xp <number> required")?;
    let base: f64 = flag_value(rest, "--base").and_then(|v| v.parse().ok()).unwrap_or(100.0);
    let max: u32 = flag_value(rest, "--max").and_then(|v| v.parse().ok()).unwrap_or(50);
    let track = gog_common::ProgressionTrack {
        code: "default".into(),
        track_type: gog_common::TrackType::Linear,
        base_xp_per_level: base,
        growth_factor: 1.0,
        max_level: max,
    };
    let engine = gog_progression::Engine::new(track);
    let s = engine.resolve(xp);
    let next_total = s.xp_for_next_level + engine.total_xp_for_level(s.level);
    Ok(format!(
        "level={} xp_into_level={} xp_for_next={} total_for_next={} progress={:.1}%",
        s.level,
        format_number(s.xp_into_level),
        format_number(s.xp_for_next_level),
        format_number(next_total),
        s.progress_percent
    ))
}

fn cmd_rank(rest: &[String]) -> Result<String, String> {
    let list = rest.first().ok_or("usage: rank \"100,100,90\" [--lowest]")?;
    let scores: Vec<f64> = list
        .split(',')
        .map(|s| s.trim().parse::<f64>())
        .collect::<Result<_, _>>()
        .map_err(|_| "scores must be numbers separated by commas".to_string())?;
    let lowest = rest.iter().any(|a| a == "--lowest");
    let ranks = gog_core_engine::rank_scores(&scores, lowest);
    Ok(ranks.iter().map(|r| r.to_string()).collect::<Vec<_>>().join(","))
}

fn cmd_simulate(rest: &[String]) -> Result<String, String> {
    let rules_path = flag_value(rest, "--rules").ok_or("--rules <file.json> required")?;
    let events_path = flag_value(rest, "--events").ok_or("--events <file.json> required")?;
    let rules_json = std::fs::read_to_string(rules_path).map_err(|e| format!("read {}: {}", rules_path, e))?;
    let events_json = std::fs::read_to_string(events_path).map_err(|e| format!("read {}: {}", events_path, e))?;
    let rules: Vec<gog_common::Rule> =
        serde_json::from_str(&rules_json).map_err(|e| format!("rules json: {}", e))?;
    let events: Vec<gog_common::CanonicalEvent> =
        serde_json::from_str(&events_json).map_err(|e| format!("events json: {}", e))?;
    let track: gog_common::ProgressionTrack =
        serde_json::from_str(r#"{"code":"default","type":"linear","base_xp_per_level":100,"max_level":50}"#).unwrap();
    let out = gog_core_engine::simulate(&rules, &track, None, &events);
    serde_json::to_string_pretty(&out).map_err(|e| e.to_string())
}

fn format_number(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e15 {
        format!("{}", n as i64)
    } else {
        format!("{}", n)
    }
}

fn print_help() {
    println!(
        "gog-engine — GamificationOG Rust core engine

USAGE:
  gog-engine formula <expr> [--var name=value ...]   evaluate a formula
  gog-engine validate-formula <expr>                 validate syntax
  gog-engine progression --xp <n> [--base <n>] [--max <n>]
  gog-engine rank \"100,100,90\" [--lowest]            dense ranks
  gog-engine simulate --rules <file> --events <file> deterministic simulation"
    );
}
