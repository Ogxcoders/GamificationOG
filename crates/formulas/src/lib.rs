//! GamificationOG — Formula Engine (Section 14).
//! Deterministic, sandboxed expression evaluation — no eval.
//! Grammar (precedence low → high), mirroring the TypeScript engine:
//!
//! ```text
//! expression     := ternary
//! ternary        := compare ("?" ternary ":" ternary)?
//! compare        := additive (("=="|"!="|">"|"<"|">="|"<="|"and"|"or") additive)*
//! additive       := multiplicative (("+"|"-") multiplicative)*
//! multiplicative := unary (("*"|"/"|"%") unary)*
//! unary          := ("-"|"not")? power
//! power          := primary ("^" unary)?
//! primary        := number | string | variable | function "(" args ")" | "(" expression ")"
//! ```
//!
//! Functions: min, max, floor, ceil, round, abs, clamp, sqrt, pow, if.
//! Variables are dot-namespaced: `user.level`, `event.payload.count`, …

use serde_json::Value;
use std::collections::HashMap;

#[derive(Debug, thiserror::Error)]
pub enum FormulaError {
    #[error("parse error: {0}")]
    Parse(String),
    #[error("unknown variable: {0}")]
    UnknownVariable(String),
    #[error("unknown function: {0}")]
    UnknownFunction(String),
    #[error("invalid argument: {0}")]
    InvalidArg(String),
}

pub type FormulaResult<T> = Result<T, FormulaError>;

// ---------------------------------------------------------------------------
// Values — number-or-string like the TS engine
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub enum Val {
    Num(f64),
    Str(String),
}

impl Val {
    fn truthy(&self) -> bool {
        match self {
            Val::Num(n) => *n != 0.0 && !n.is_nan(),
            Val::Str(s) => !s.is_empty() && s != "false",
        }
    }
}

fn to_num(v: &Val) -> f64 {
    match v {
        Val::Num(n) => *n,
        Val::Str(s) => s.parse::<f64>().unwrap_or(f64::NAN),
    }
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    Number(f64),
    Str(String),
    Ident(String),
    Op(String),
    LParen,
    RParen,
    Comma,
    Question,
    Colon,
}

fn tokenize(input: &str) -> FormulaResult<Vec<Tok>> {
    let chars: Vec<char> = input.chars().collect();
    let mut toks = Vec::new();
    let mut i = 0;
    let n = chars.len();

    let ops2: [&str; 4] = ["==", "!=", ">=", "<="];
    let ops1: [&str; 9] = ["<", ">", "%", "^", "(", ")", ",", "?", ":"];

    while i < n {
        let ch = chars[i];
        if ch.is_whitespace() {
            i += 1;
            continue;
        }
        let two: String = chars[i..(i + 2).min(n)].iter().collect();
        if ops2.contains(&two.as_str()) {
            toks.push(Tok::Op(two));
            i += 2;
            continue;
        }
        if ch == '+' || ch == '-' || ch == '*' || ch == '/' {
            toks.push(Tok::Op(ch.to_string()));
            i += 1;
            continue;
        }
        if ops1.contains(&ch.to_string().as_str()) {
            let t = match ch {
                '(' => Tok::LParen,
                ')' => Tok::RParen,
                ',' => Tok::Comma,
                '?' => Tok::Question,
                ':' => Tok::Colon,
                _ => Tok::Op(ch.to_string()),
            };
            toks.push(t);
            i += 1;
            continue;
        }
        if ch == '"' || ch == '\'' {
            let mut s = String::new();
            i += 1;
            while i < n && chars[i] != '"' && chars[i] != '\'' {
                s.push(chars[i]);
                i += 1;
            }
            if i >= n {
                return Err(FormulaError::Parse("unterminated string".into()));
            }
            i += 1;
            toks.push(Tok::Str(s));
            continue;
        }
        if ch.is_ascii_digit() || (ch == '.' && i + 1 < n && chars[i + 1].is_ascii_digit()) {
            let mut s = String::new();
            while i < n && (chars[i].is_ascii_digit() || chars[i] == '.') {
                s.push(chars[i]);
                i += 1;
            }
            let num: f64 = s
                .parse()
                .map_err(|_| FormulaError::Parse(format!("invalid number \"{}\"", s)))?;
            toks.push(Tok::Number(num));
            continue;
        }
        if ch.is_alphabetic() || ch == '_' {
            let mut s = String::new();
            while i < n && (chars[i].is_alphanumeric() || chars[i] == '_' || chars[i] == '.') {
                s.push(chars[i]);
                i += 1;
            }
            toks.push(Tok::Ident(s));
            continue;
        }
        return Err(FormulaError::Parse(format!("unexpected character '{}'", ch)));
    }
    Ok(toks)
}

// ---------------------------------------------------------------------------
// Parser + evaluator (single-pass recursive descent)
// ---------------------------------------------------------------------------

pub struct Engine {
    variables: HashMap<String, Value>,
}

impl Engine {
    pub fn new(variables: serde_json::Map<String, Value>) -> Self {
        let mut map = HashMap::new();
        for (k, v) in variables {
            map.insert(k, v);
        }
        Engine { variables: map }
    }

    /// Resolve a variable by exact key or dotted path from flat keys.
    /// Mirrors the TS engine: flat dot-path keys first, then nested lookup.
    fn var(&self, name: &str) -> FormulaResult<Val> {
        if let Some(v) = self.variables.get(name) {
            return Ok(json_to_val(v));
        }
        // nested walk: user.level -> { "user": { "level": n } }
        let parts: Vec<&str> = name.split('.').collect();
        let mut current = None;
        for (k, v) in self.variables.iter() {
            if k == parts[0] {
                current = Some(v.clone());
                break;
            }
        }
        if let Some(mut cur) = current {
            for part in &parts[1..] {
                match cur {
                    Value::Object(ref mut m) => {
                        cur = m.get(*part).cloned().unwrap_or(Value::Null);
                    }
                    _ => {
                        cur = Value::Null;
                    }
                }
            }
            if !cur.is_null() {
                return Ok(json_to_val(&cur));
            }
        }
        Err(FormulaError::UnknownVariable(name.to_string()))
    }

    fn call_function(&self, name: &str, args: &[Val]) -> FormulaResult<Val> {
        let nums: Vec<f64> = args.iter().map(to_num).collect();
        let out = match name {
            "min" => nums.iter().cloned().fold(f64::INFINITY, f64::min),
            "max" => nums.iter().cloned().fold(f64::NEG_INFINITY, f64::max),
            "floor" => nums[0].floor(),
            "ceil" => nums[0].ceil(),
            "round" => nums[0].round(),
            "abs" => nums[0].abs(),
            "sqrt" => nums[0].sqrt(),
            "pow" => nums[0].powf(nums[1]),
            "clamp" => nums[0].clamp(nums[1], nums[2]),
            "if" => {
                let cond = args.first().map(|v| v.truthy()).unwrap_or(false);
                return Ok(if cond {
                    args.get(1).cloned().unwrap_or(Val::Num(0.0))
                } else {
                    args.get(2).cloned().unwrap_or(Val::Num(0.0))
                })
            }
            _ => return Err(FormulaError::UnknownFunction(name.to_string())),
        };
        Ok(Val::Num(out))
    }

    // -- expression := ternary --
    fn expression(&self, toks: &[Tok], pos: &mut usize) -> FormulaResult<Val> {
        self.ternary(toks, pos)
    }

    // -- ternary := compare ("?" ternary ":" ternary)? --
    fn ternary(&self, toks: &[Tok], pos: &mut usize) -> FormulaResult<Val> {
        let cond = self.compare(toks, pos)?;
        if *pos < toks.len() && toks[*pos] == Tok::Question {
            *pos += 1;
            let a = self.ternary(toks, pos)?;
            if *pos >= toks.len() || toks[*pos] != Tok::Colon {
                return Err(FormulaError::Parse("expected ':' in ternary".into()));
            }
            *pos += 1;
            let b = self.ternary(toks, pos)?;
            return Ok(if cond.truthy() { a } else { b });
        }
        Ok(cond)
    }

    // -- compare := additive (op additive)* --
    fn compare(&self, toks: &[Tok], pos: &mut usize) -> FormulaResult<Val> {
        let mut left = self.additive(toks, pos)?;
        loop {
            let op = match toks.get(*pos) {
                Some(Tok::Op(o)) if ["==", "!=", ">", "<", ">=", "<="].contains(&o.as_str()) => o.clone(),
                Some(Tok::Ident(id)) if id == "and" || id == "or" => id.clone(),
                _ => break,
            };
            *pos += 1;
            let right = self.additive(toks, pos)?;
            let result = match op.as_str() {
                "==" => match (&left, &right) {
                    (Val::Str(a), Val::Str(b)) => (a == b) as i32 as f64,
                    _ => (to_num(&left) == to_num(&right)) as i32 as f64,
                },
                "!=" => match (&left, &right) {
                    (Val::Str(a), Val::Str(b)) => (a != b) as i32 as f64,
                    _ => (to_num(&left) != to_num(&right)) as i32 as f64,
                },
                ">" => (to_num(&left) > to_num(&right)) as i32 as f64,
                "<" => (to_num(&left) < to_num(&right)) as i32 as f64,
                ">=" => (to_num(&left) >= to_num(&right)) as i32 as f64,
                "<=" => (to_num(&left) <= to_num(&right)) as i32 as f64,
                "and" => (left.truthy() && right.truthy()) as i32 as f64,
                "or" => (left.truthy() || right.truthy()) as i32 as f64,
                _ => unreachable!(),
            };
            left = Val::Num(result);
        }
        Ok(left)
    }

    // -- additive --
    fn additive(&self, toks: &[Tok], pos: &mut usize) -> FormulaResult<Val> {
        let mut left = self.multiplicative(toks, pos)?;
        loop {
            let op = match toks.get(*pos) {
                Some(Tok::Op(o)) if o == "+" || o == "-" => o.clone(),
                _ => break,
            };
            *pos += 1;
            let right = self.multiplicative(toks, pos)?;
            left = match (op.as_str(), &left, &right) {
                // string concatenation parity with TS "+" on strings
                ("+", Val::Str(a), Val::Str(b)) => Val::Str(format!("{}{}", a, b)),
                ("+", Val::Str(a), r) => Val::Str(format!("{}{}", a, num_display(to_num(r)))),
                ("+", l, Val::Str(b)) => Val::Str(format!("{}{}", num_display(to_num(l)), b)),
                _ => {
                    let (l, r) = (to_num(&left), to_num(&right));
                    Val::Num(if op == "+" { l + r } else { l - r })
                }
            };
        }
        Ok(left)
    }

    // -- multiplicative --
    fn multiplicative(&self, toks: &[Tok], pos: &mut usize) -> FormulaResult<Val> {
        let mut left = self.unary(toks, pos)?;
        loop {
            let op = match toks.get(*pos) {
                Some(Tok::Op(o)) if o == "*" || o == "/" || o == "%" => o.clone(),
                _ => break,
            };
            *pos += 1;
            let right = self.unary(toks, pos)?;
            let (l, r) = (to_num(&left), to_num(&right));
            left = Val::Num(match op.as_str() {
                "*" => l * r,
                "/" => {
                    if r == 0.0 {
                        return Err(FormulaError::InvalidArg("division by zero".into()));
                    }
                    l / r
                }
                "%" => l % r,
                _ => unreachable!(),
            });
        }
        Ok(left)
    }

    // -- unary := ("-"|"not")? power --
    fn unary(&self, toks: &[Tok], pos: &mut usize) -> FormulaResult<Val> {
        if let Some(Tok::Op(o)) = toks.get(*pos) {
            if o == "-" {
                *pos += 1;
                let v = self.power(toks, pos)?;
                return Ok(Val::Num(-to_num(&v)));
            }
        }
        if let Some(Tok::Ident(id)) = toks.get(*pos) {
            if id == "not" {
                *pos += 1;
                let v = self.power(toks, pos)?;
                return Ok(Val::Num(!v.truthy() as i32 as f64));
            }
        }
        self.power(toks, pos)
    }

    // -- power := primary ("^" unary)? --
    fn power(&self, toks: &[Tok], pos: &mut usize) -> FormulaResult<Val> {
        let base = self.primary(toks, pos)?;
        if let Some(Tok::Op(o)) = toks.get(*pos) {
            if o == "^" {
                *pos += 1;
                let exp = self.unary(toks, pos)?;
                return Ok(Val::Num(to_num(&base).powf(to_num(&exp))));
            }
        }
        Ok(base)
    }

    // -- primary --
    fn primary(&self, toks: &[Tok], pos: &mut usize) -> FormulaResult<Val> {
        match toks.get(*pos) {
            Some(Tok::Number(n)) => {
                let v = Val::Num(*n);
                *pos += 1;
                Ok(v)
            }
            Some(Tok::Str(s)) => {
                let v = Val::Str(s.clone());
                *pos += 1;
                Ok(v)
            }
            Some(Tok::LParen) => {
                *pos += 1;
                let v = self.expression(toks, pos)?;
                if toks.get(*pos) != Some(&Tok::RParen) {
                    return Err(FormulaError::Parse("expected ')'".into()));
                }
                *pos += 1;
                Ok(v)
            }
            Some(Tok::Ident(name)) => {
                let name = name.clone();
                *pos += 1;
                if toks.get(*pos) == Some(&Tok::LParen) {
                    *pos += 1;
                    let mut args = Vec::new();
                    if toks.get(*pos) != Some(&Tok::RParen) {
                        loop {
                            args.push(self.expression(toks, pos)?);
                            match toks.get(*pos) {
                                Some(Tok::Comma) => {
                                    *pos += 1;
                                }
                                _ => break,
                            }
                        }
                    }
                    if toks.get(*pos) != Some(&Tok::RParen) {
                        return Err(FormulaError::Parse("expected ')' after function args".into()));
                    }
                    *pos += 1;
                    return self.call_function(&name, &args);
                }
                self.var(&name)
            }
            other => Err(FormulaError::Parse(format!("unexpected token {:?}", other))),
        }
    }

    /// Evaluate a formula expression with this engine's variables.
    pub fn evaluate(&self, input: &str) -> FormulaResult<f64> {
        let toks = tokenize(input)?;
        if toks.is_empty() {
            return Err(FormulaError::Parse("empty expression".into()));
        }
        let mut pos = 0;
        let val = self.expression(&toks, &mut pos)?;
        if pos != toks.len() {
            return Err(FormulaError::Parse("unexpected trailing tokens".into()));
        }
        Ok(to_num(&val))
    }
}

fn json_to_val(v: &Value) -> Val {
    match v {
        Value::Number(n) => Val::Num(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(s) => Val::Str(s.clone()),
        Value::Bool(b) => Val::Num(*b as i32 as f64),
        Value::Null => Val::Num(0.0),
        other => Val::Str(other.to_string()),
    }
}

fn num_display(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e15 {
        format!("{}", n as i64)
    } else {
        format!("{}", n)
    }
}

/// Validate a formula without variables (admin CRUD parity with TS).
pub fn validate(input: &str) -> FormulaResult<()> {
    let engine = Engine::new(serde_json::Map::new());
    engine.evaluate(input).map(|_| ()).or_else(|e| match e {
        // unknown variables are fine during validation (bound at runtime)
        FormulaError::UnknownVariable(_) => Ok(()),
        other => Err(other),
    })
}

/// Evaluate a formula with a flat variable map.
pub fn eval(input: &str, vars: &HashMap<String, Value>) -> FormulaResult<f64> {
    let engine = Engine::new(
        vars.iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect::<serde_json::Map<String, Value>>(),
    );
    engine.evaluate(input)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn v() -> HashMap<String, Value> {
        let mut m = HashMap::new();
        m.insert("user.level".to_string(), json!(4));
        m.insert("event.payload.difficulty".to_string(), json!("hard"));
        m.insert("event.payload.minutes".to_string(), json!(30));
        m.insert("event.payload.count".to_string(), json!(3));
        m
    }

    #[test]
    fn core_loop_formula() {
        // the seeded Customer Zero rule: 20 + (difficulty == "hard" ? 30 : ...)
        let out = eval(
            "20 + (event.payload.difficulty == \"hard\" ? 30 : event.payload.difficulty == \"medium\" ? 10 : 0)",
            &v(),
        )
        .unwrap();
        assert_eq!(out, 50.0);
    }

    #[test]
    fn focus_minutes_formula() {
        // min(minutes * 2, 60) — the seeded focus rule
        let out = eval("min(event.payload.minutes * 2, 60)", &v()).unwrap();
        assert_eq!(out, 60.0);
    }

    #[test]
    fn precedence_and_power() {
        let out = eval("2 + 3 * 4 ^ 2", &HashMap::new()).unwrap();
        assert_eq!(out, 50.0); // 2 + 3*16
    }

    #[test]
    fn ternary_night_owl() {
        // night-owl style condition
        let out = eval("if(user.level >= 3, 10, 5)", &v()).unwrap();
        assert_eq!(out, 10.0);
    }

    #[test]
    fn clamp_and_round() {
        assert_eq!(eval("clamp(15, 0, 10)", &HashMap::new()).unwrap(), 10.0);
        assert_eq!(eval("round(2.5)", &HashMap::new()).unwrap(), 3.0);
        assert_eq!(eval("floor(2.9)", &HashMap::new()).unwrap(), 2.0);
        assert_eq!(eval("ceil(2.1)", &HashMap::new()).unwrap(), 3.0);
        assert_eq!(eval("abs(-7)", &HashMap::new()).unwrap(), 7.0);
    }

    #[test]
    fn division_by_zero_rejected() {
        assert!(eval("1 / 0", &HashMap::new()).is_err());
    }

    #[test]
    fn unknown_function_rejected() {
        assert!(eval("explode(1)", &HashMap::new()).is_err());
    }

    #[test]
    fn string_equality() {
        let out = eval("\"a\" == \"a\"", &HashMap::new()).unwrap();
        assert_eq!(out, 1.0);
    }

    #[test]
    fn logical_and_or_not() {
        assert_eq!(eval("1 and 2", &HashMap::new()).unwrap(), 1.0);
        assert_eq!(eval("0 or 3", &HashMap::new()).unwrap(), 1.0);
        assert_eq!(eval("not 0", &HashMap::new()).unwrap(), 1.0);
        assert_eq!(eval("not 1", &HashMap::new()).unwrap(), 0.0);
    }

    #[test]
    fn validate_accepts_variables() {
        assert!(validate("user.level * 2").is_ok());
        assert!(validate("2 *** 3").is_err());
    }
}
