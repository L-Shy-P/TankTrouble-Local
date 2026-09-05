//! Headless minimal-decide runner.
//!
//! Reads a JSON object either from stdin or from the first command-line
//! argument (which may be a file path or a literal JSON string), calls
//! `vantage_core::minimal::minimal_decide`, and prints the resulting decision
//! as JSON.
//!
//! The JSON parser is intentionally small and dependency-free; it supports
//! objects, arrays, strings (with escapes), numbers (including negatives and
//! exponents), booleans and null — enough for the fixed input shape and
//! nested per-frame score arrays.

use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::io::{self, Read};
use std::path::Path;
use std::process;

use vantage_core::minimal::{minimal_decide, CandidateInput, MinimalDecision};

#[derive(Debug, Clone, PartialEq)]
enum Json {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<Json>),
    Object(BTreeMap<String, Json>),
}

struct JsonParser<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> JsonParser<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, pos: 0 }
    }

    fn parse(mut self) -> Result<Json, String> {
        let v = self.parse_value()?;
        self.skip_ws();
        if self.pos != self.bytes.len() {
            return Err(format!("trailing bytes at position {}", self.pos));
        }
        Ok(v)
    }

    fn skip_ws(&mut self) {
        while self.pos < self.bytes.len()
            && matches!(self.bytes[self.pos], b' ' | b'\t' | b'\n' | b'\r')
        {
            self.pos += 1;
        }
    }

    fn peek(&self) -> Result<u8, String> {
        self.bytes
            .get(self.pos)
            .copied()
            .ok_or_else(|| "unexpected end of input".to_string())
    }

    fn next(&mut self) -> Result<u8, String> {
        let b = self.peek()?;
        self.pos += 1;
        Ok(b)
    }

    fn expect(&mut self, want: u8) -> Result<(), String> {
        let b = self.next()?;
        if b != want {
            return Err(format!(
                "expected '{}', found '{}'",
                want as char, b as char
            ));
        }
        Ok(())
    }

    fn parse_value(&mut self) -> Result<Json, String> {
        self.skip_ws();
        match self.peek()? {
            b'{' => self.parse_object(),
            b'[' => self.parse_array(),
            b'"' => Ok(Json::String(self.parse_string()?)),
            b't' => self.parse_literal("true", Json::Bool(true)),
            b'f' => self.parse_literal("false", Json::Bool(false)),
            b'n' => self.parse_literal("null", Json::Null),
            b'-' | b'0'..=b'9' => self.parse_number(),
            b => Err(format!(
                "unexpected byte '{}' at position {}",
                b as char, self.pos
            )),
        }
    }

    fn parse_literal(&mut self, literal: &str, value: Json) -> Result<Json, String> {
        for want in literal.bytes() {
            let got = self.next()?;
            if got != want {
                return Err(format!("invalid literal '{}'", literal));
            }
        }
        Ok(value)
    }

    fn parse_object(&mut self) -> Result<Json, String> {
        self.expect(b'{')?;
        let mut map = BTreeMap::new();
        self.skip_ws();
        if self.peek()? == b'}' {
            self.pos += 1;
            return Ok(Json::Object(map));
        }
        loop {
            self.skip_ws();
            let key = self.parse_string()?;
            self.skip_ws();
            self.expect(b':')?;
            let value = self.parse_value()?;
            map.insert(key, value);
            self.skip_ws();
            match self.next()? {
                b',' => continue,
                b'}' => break,
                b => return Err(format!("expected ',' or '}}', found '{}'", b as char)),
            }
        }
        Ok(Json::Object(map))
    }

    fn parse_array(&mut self) -> Result<Json, String> {
        self.expect(b'[')?;
        let mut items = Vec::new();
        self.skip_ws();
        if self.peek()? == b']' {
            self.pos += 1;
            return Ok(Json::Array(items));
        }
        loop {
            items.push(self.parse_value()?);
            self.skip_ws();
            match self.next()? {
                b',' => continue,
                b']' => break,
                b => return Err(format!("expected ',' or ']', found '{}'", b as char)),
            }
        }
        Ok(Json::Array(items))
    }

    fn parse_string(&mut self) -> Result<String, String> {
        self.expect(b'"')?;
        let mut out = String::new();
        loop {
            let b = self.next()?;
            match b {
                b'"' => break,
                b'\\' => {
                    let esc = self.next()?;
                    match esc {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{0008}'),
                        b'f' => out.push('\u{000C}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            let code = self.parse_unicode_escape()?;
                            if let Some(c) = char::from_u32(code) {
                                out.push(c);
                            } else {
                                return Err(format!("invalid unicode escape \\u{:04X}", code));
                            }
                        }
                        _ => return Err(format!("invalid escape '\\{}'", esc as char)),
                    }
                }
                0x00..=0x1F => return Err(format!("unescaped control byte {:#04x}", b)),
                _ => out.push(b as char),
            }
        }
        Ok(out)
    }

    fn parse_unicode_escape(&mut self) -> Result<u32, String> {
        let mut code = 0u32;
        for _ in 0..4 {
            let b = self.next()?;
            let digit = match b {
                b'0'..=b'9' => (b - b'0') as u32,
                b'a'..=b'f' => (b - b'a' + 10) as u32,
                b'A'..=b'F' => (b - b'A' + 10) as u32,
                _ => return Err(format!("invalid hex digit '{}' in \\u escape", b as char)),
            };
            code = (code << 4) | digit;
        }
        Ok(code)
    }

    fn parse_number(&mut self) -> Result<Json, String> {
        let start = self.pos;
        if self.peek()? == b'-' {
            self.pos += 1;
        }

        match self.peek()? {
            b'0' => {
                self.pos += 1;
            }
            b'1'..=b'9' => {
                while self.pos < self.bytes.len() && self.bytes[self.pos].is_ascii_digit() {
                    self.pos += 1;
                }
            }
            _ => return Err(format!("invalid number at position {}", start)),
        }

        if self.pos < self.bytes.len() && self.bytes[self.pos] == b'.' {
            self.pos += 1;
            let frac_start = self.pos;
            while self.pos < self.bytes.len() && self.bytes[self.pos].is_ascii_digit() {
                self.pos += 1;
            }
            if self.pos == frac_start {
                return Err(format!(
                    "invalid fraction in number at position {}",
                    frac_start
                ));
            }
        }

        if self.pos < self.bytes.len() && matches!(self.bytes[self.pos], b'e' | b'E') {
            self.pos += 1;
            if self.pos < self.bytes.len() && matches!(self.bytes[self.pos], b'+' | b'-') {
                self.pos += 1;
            }
            let exp_start = self.pos;
            while self.pos < self.bytes.len() && self.bytes[self.pos].is_ascii_digit() {
                self.pos += 1;
            }
            if self.pos == exp_start {
                return Err(format!(
                    "invalid exponent in number at position {}",
                    exp_start
                ));
            }
        }

        let text = std::str::from_utf8(&self.bytes[start..self.pos])
            .map_err(|e| format!("invalid utf8 in number: {}", e))?;
        let n: f64 = text
            .parse()
            .map_err(|e| format!("invalid number '{}': {}", text, e))?;
        Ok(Json::Number(n))
    }
}

fn as_f64(v: &Json, what: &str) -> Result<f64, String> {
    match v {
        Json::Number(n) => Ok(*n),
        _ => Err(format!("{} must be a number", what)),
    }
}

fn as_i64(v: &Json, what: &str) -> Result<i64, String> {
    let n = as_f64(v, what)?;
    Ok(n as i64)
}

fn as_usize(v: &Json, what: &str) -> Result<usize, String> {
    let n = as_f64(v, what)?;
    if n < 0.0 || n.fract() != 0.0 {
        return Err(format!("{} must be a non-negative integer", what));
    }
    Ok(n as usize)
}

fn as_bool(v: &Json, what: &str) -> Result<bool, String> {
    match v {
        Json::Bool(b) => Ok(*b),
        _ => Err(format!("{} must be a boolean", what)),
    }
}

fn as_string<'a>(v: &'a Json, what: &str) -> Result<&'a str, String> {
    match v {
        Json::String(s) => Ok(s),
        _ => Err(format!("{} must be a string", what)),
    }
}

fn as_array<'a>(v: &'a Json, what: &str) -> Result<&'a [Json], String> {
    match v {
        Json::Array(a) => Ok(a),
        _ => Err(format!("{} must be an array", what)),
    }
}

fn as_object<'a>(v: &'a Json, what: &str) -> Result<&'a BTreeMap<String, Json>, String> {
    match v {
        Json::Object(o) => Ok(o),
        _ => Err(format!("{} must be an object", what)),
    }
}

fn parse_input(json: &Json) -> Result<(Vec<CandidateInput>, f64, usize, usize), String> {
    let root = as_object(json, "root")?;
    let epsilon = as_f64(
        root.get("epsilon").ok_or("missing field epsilon")?,
        "epsilon",
    )?;
    let t_min = as_usize(root.get("tMin").ok_or("missing field tMin")?, "tMin")?;
    let t_max = as_usize(root.get("tMax").ok_or("missing field tMax")?, "tMax")?;
    let arr = as_array(
        root.get("candidates").ok_or("missing field candidates")?,
        "candidates",
    )?;

    let mut candidates = Vec::with_capacity(arr.len());
    for (i, item) in arr.iter().enumerate() {
        let obj = as_object(item, &format!("candidates[{}]", i))?;
        let op_name = as_string(
            obj.get("opName")
                .ok_or_else(|| format!("candidates[{}].opName missing", i))?,
            "opName",
        )?
        .to_string();
        let total_score = as_f64(
            obj.get("totalScore")
                .ok_or_else(|| format!("candidates[{}].totalScore missing", i))?,
            "totalScore",
        )?;
        let dead = as_bool(
            obj.get("dead")
                .ok_or_else(|| format!("candidates[{}].dead missing", i))?,
            "dead",
        )?;
        let death_frame = as_i64(
            obj.get("deathFrame")
                .ok_or_else(|| format!("candidates[{}].deathFrame missing", i))?,
            "deathFrame",
        )?;
        let pfs_json = as_array(
            obj.get("perFrameScores")
                .ok_or_else(|| format!("candidates[{}].perFrameScores missing", i))?,
            "perFrameScores",
        )?;
        let mut pfs = Vec::with_capacity(pfs_json.len());
        for (j, v) in pfs_json.iter().enumerate() {
            pfs.push(as_f64(
                v,
                &format!("candidates[{}].perFrameScores[{}]", i, j),
            )?);
        }
        candidates.push(CandidateInput {
            op_name,
            total_score,
            dead,
            death_frame,
            per_frame_scores: pfs,
        });
    }

    Ok((candidates, epsilon, t_min, t_max))
}

fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

fn json_number(v: f64) -> String {
    if v.is_nan() || v.is_infinite() {
        return "0".to_string();
    }
    let mut s = v.to_string();
    if !s.contains('.') && !s.contains('e') && !s.contains('E') {
        s.push_str(".0");
    }
    s
}

fn render_decision(d: &MinimalDecision) -> String {
    let mut out = String::new();
    out.push_str("{\n");
    out.push_str(&format!("  \"selectedIndex\": {},\n", d.selected_index));
    out.push_str(&format!(
        "  \"selectedOp\": \"{}\",\n",
        json_escape(&d.op_name)
    ));
    out.push_str(&format!("  \"segmentFrames\": {},\n", d.segment_frames));
    out.push_str("  \"candidates\": [\n");
    for (i, c) in d.candidates.iter().enumerate() {
        out.push_str("    {\n");
        out.push_str(&format!("      \"index\": {},\n", c.index));
        out.push_str(&format!(
            "      \"opName\": \"{}\",\n",
            json_escape(&c.op_name)
        ));
        out.push_str(&format!("      \"plannedFrames\": {},\n", c.planned_frames));
        out.push_str(&format!("      \"segmentFrames\": {},\n", c.segment_frames));
        out.push_str(&format!(
            "      \"segmentScore\": {},\n",
            json_number(c.segment_score)
        ));
        out.push_str(&format!(
            "      \"rolloutTotal\": {},\n",
            json_number(c.rollout_total)
        ));
        out.push_str(&format!("      \"status\": {},\n", c.status));
        out.push_str(&format!(
            "      \"fullDeathFrame\": {}\n",
            c.full_death_frame
        ));
        out.push_str("    }");
        if i + 1 != d.candidates.len() {
            out.push(',');
        }
        out.push('\n');
    }
    out.push_str("  ]\n");
    out.push_str("}\n");
    out
}

fn read_input() -> Result<String, String> {
    let args: Vec<String> = env::args().skip(1).collect();
    if let Some(arg) = args.first() {
        let path = Path::new(arg);
        if path.is_file() {
            return fs::read_to_string(path).map_err(|e| format!("failed to read {}: {}", arg, e));
        }
        return Ok(arg.clone());
    }

    let mut buf = String::new();
    io::stdin()
        .read_to_string(&mut buf)
        .map_err(|e| format!("failed to read stdin: {}", e))?;
    Ok(buf)
}

fn run(json_text: &str) -> Result<String, String> {
    let json = JsonParser::new(json_text.as_bytes()).parse()?;
    let (candidates, epsilon, t_min, t_max) = parse_input(&json)?;
    let decision = minimal_decide(&candidates, epsilon, t_min, t_max).ok_or_else(|| {
        "minimal_decide returned no decision (empty candidates or invalid t range)".to_string()
    })?;
    Ok(render_decision(&decision))
}

fn main() {
    let input = match read_input() {
        Ok(s) => s,
        Err(e) => {
            println!("{{\"error\":\"{}\"}}", json_escape(&e));
            process::exit(1);
        }
    };

    match run(&input) {
        Ok(json) => print!("{}", json),
        Err(e) => {
            println!("{{\"error\":\"{}\"}}", json_escape(&e));
            process::exit(1);
        }
    }
}
