//! Reads rollout scene JSON and prints the per-scene results as JSON.
//!
//! Usage: `cargo run --quiet --bin rollout_trace -- scene.json`
//!
//! The top level may be either one scene object or `{ "scenes": [ ... ] }`.
//! All scenes are run sequentially in one process through a single persistent
//! `RolloutCache`, so the warm-starting cache is exercised across scenes.

use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::process;

use vantage_core::rollout::{
    run_rollout_batch, BulletInput, OpInput, RolloutCache, RolloutInput, StartPose, WallPoly,
};

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

fn get_num<'a>(obj: &'a BTreeMap<String, Json>, key: &str) -> Result<f64, String> {
    as_f64(
        obj.get(key)
            .ok_or_else(|| format!("missing field {}", key))?,
        key,
    )
}

fn parse_scene(json: &Json) -> Result<RolloutInput, String> {
    let root = as_object(json, "scene")?;

    let walls_json = as_array(root.get("walls").ok_or("missing field walls")?, "walls")?;
    let mut walls = Vec::with_capacity(walls_json.len());
    for (wi, w) in walls_json.iter().enumerate() {
        let wo = as_object(w, &format!("walls[{}]", wi))?;
        let verts_json = as_array(
            wo.get("verts").ok_or("missing field walls[].verts")?,
            "verts",
        )?;
        let mut verts = Vec::with_capacity(verts_json.len());
        for (vi, v) in verts_json.iter().enumerate() {
            let va = as_array(v, &format!("walls[{}].verts[{}]", wi, vi))?;
            if va.len() != 2 {
                return Err(format!("walls[{}].verts[{}] must have 2 numbers", wi, vi));
            }
            verts.push((as_f64(&va[0], "vx")?, as_f64(&va[1], "vy")?));
        }
        walls.push(WallPoly { vertices: verts });
    }

    let start_json = as_object(
        root.get("startPose").ok_or("missing field startPose")?,
        "startPose",
    )?;
    let start_pose = StartPose {
        x: get_num(start_json, "x")?,
        y: get_num(start_json, "y")?,
        rot: get_num(start_json, "rot")?,
    };

    let ops_json = as_array(root.get("ops").ok_or("missing field ops")?, "ops")?;
    let mut ops = Vec::with_capacity(ops_json.len());
    for (oi, o) in ops_json.iter().enumerate() {
        let oo = as_object(o, &format!("ops[{}]", oi))?;
        ops.push(OpInput {
            speed: get_num(oo, "speed")?,
            rotation_speed: get_num(oo, "rotationSpeed")?,
        });
    }

    let bullets_json = as_array(
        root.get("bullets").ok_or("missing field bullets")?,
        "bullets",
    )?;
    let mut bullets = Vec::with_capacity(bullets_json.len());
    for (bi, b) in bullets_json.iter().enumerate() {
        let bo = as_object(b, &format!("bullets[{}]", bi))?;
        bullets.push(BulletInput {
            x: get_num(bo, "x")?,
            y: get_num(bo, "y")?,
            vx: get_num(bo, "vx")?,
            vy: get_num(bo, "vy")?,
            radius: get_num(bo, "radius")?,
            life_left: get_num(bo, "lifeLeft")?,
            active: match bo.get("active") {
                Some(Json::Bool(b)) => *b,
                _ => true,
            },
        });
    }

    let frames = match root.get("frames") {
        Some(Json::Number(n)) if n.fract() == 0.0 && *n >= 0.0 => *n as u32,
        _ => 75,
    };

    let cache_id = match root.get("cacheId") {
        Some(Json::Number(n)) if n.fract() == 0.0 && *n >= 0.0 => *n as u64,
        _ => 0,
    };

    Ok(RolloutInput {
        start_pose,
        ops,
        duration_frames: frames,
        walls,
        bullets,
        cache_id,
    })
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

fn json_bool(v: bool) -> &'static str {
    if v {
        "true"
    } else {
        "false"
    }
}

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() < 2 {
        eprintln!("usage: rollout_trace <scene.json>");
        process::exit(2);
    }
    let path = &args[1];
    let bytes = match fs::read(path) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("failed to read {}: {}", path, e);
            process::exit(2);
        }
    };
    let json = match JsonParser::new(&bytes).parse() {
        Ok(j) => j,
        Err(e) => {
            eprintln!("failed to parse {}: {}", path, e);
            process::exit(2);
        }
    };

    let scenes: Vec<&Json> = match &json {
        Json::Object(root) => match root.get("scenes") {
            Some(Json::Array(a)) => a.iter().collect(),
            _ => vec![&json],
        },
        _ => {
            eprintln!("invalid scene json: top level must be an object");
            process::exit(2);
        }
    };

    let mut caches: std::collections::HashMap<u64, RolloutCache> = std::collections::HashMap::new();
    let mut outputs: Vec<String> = Vec::with_capacity(scenes.len());

    for (si, scene) in scenes.iter().enumerate() {
        let input = match parse_scene(scene) {
            Ok(inp) => inp,
            Err(e) => {
                eprintln!("invalid scene {}: {}", si, e);
                process::exit(2);
            }
        };
        let cache = caches.entry(input.cache_id).or_default();
        match run_rollout_batch(cache, &input) {
            Ok(out) => {
                let mut parts: Vec<String> = Vec::with_capacity(out.samples.len());
                for op in 0..out.samples.len() {
                    let mut samples = String::from("[");
                    for (fi, s) in out.samples[op].iter().enumerate() {
                        if fi > 0 {
                            samples.push(',');
                        }
                        samples.push_str(&format!(
                            "{{\"t\":{},\"x\":{},\"y\":{},\"rot\":{}}}",
                            json_number(s.t),
                            json_number(s.x),
                            json_number(s.y),
                            json_number(s.rot)
                        ));
                    }
                    samples.push(']');
                    parts.push(samples);
                }
                let mut dead = String::from("[");
                for (i, d) in out.dead.iter().enumerate() {
                    if i > 0 {
                        dead.push(',');
                    }
                    dead.push_str(json_bool(*d));
                }
                dead.push(']');
                let mut death_frame = String::from("[");
                for (i, d) in out.death_frame.iter().enumerate() {
                    if i > 0 {
                        death_frame.push(',');
                    }
                    death_frame.push_str(&d.to_string());
                }
                death_frame.push(']');
                outputs.push(format!(
                    "{{\"ok\":true,\"samples\":[{}],\"dead\":{},\"deathFrame\":{}}}",
                    parts.join(","),
                    dead,
                    death_frame
                ));
            }
            Err(e) => {
                outputs.push(format!("{{\"ok\":false,\"error\":\"{}\"}}", e));
            }
        }
    }

    println!("[{}]", outputs.join(","));
}
