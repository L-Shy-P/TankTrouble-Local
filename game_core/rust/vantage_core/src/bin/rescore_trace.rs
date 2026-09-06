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

use vantage_core::rescore::{
    rescore_nodes, RescoreConfig, RescoreNodeInput, RescoreThreatInput, TankPoseLike,
    ThreatPathPoint, ThreatTrackPoint,
};
use vantage_core::rollout::{VerificationCache, WallPoly};

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

fn parse_xy(v: &Json, what: &str) -> Result<(f64, f64), String> {
    let a = as_array(v, what)?;
    if a.len() != 2 {
        return Err(format!("{} must have 2 numbers", what));
    }
    Ok((as_f64(&a[0], "x")?, as_f64(&a[1], "y")?))
}

fn parse_pose(v: &Json, what: &str) -> Result<TankPoseLike, String> {
    let a = as_array(v, what)?;
    if a.len() != 3 {
        return Err(format!("{} must have 3 numbers", what));
    }
    Ok(TankPoseLike::new(
        as_f64(&a[0], "x")?,
        as_f64(&a[1], "y")?,
        as_f64(&a[2], "rot")?,
    ))
}

fn parse_bool_or_num(v: &Json) -> Option<bool> {
    match v {
        Json::Bool(b) => Some(*b),
        Json::Number(n) => Some(*n != 0.0),
        _ => None,
    }
}

struct Scene {
    cache_id: u64,
    walls: Vec<WallPoly>,
    nodes: Vec<RescoreNodeInput>,
    threats: Vec<RescoreThreatInput>,
    cfg: RescoreConfig,
}

fn parse_scene(json: &Json) -> Result<Scene, String> {
    let root = as_object(json, "scene")?;

    let cache_id = match root.get("cacheId") {
        Some(Json::Number(n)) if n.fract() == 0.0 && *n >= 0.0 => *n as u64,
        _ => 0,
    };

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
            let (x, y) = parse_xy(v, &format!("walls[{}].verts[{}]", wi, vi))?;
            verts.push((x, y));
        }
        walls.push(WallPoly { vertices: verts });
    }

    let nodes_json = as_array(root.get("nodes").ok_or("missing field nodes")?, "nodes")?;
    let mut nodes = Vec::with_capacity(nodes_json.len());
    for (ni, n) in nodes_json.iter().enumerate() {
        let no = as_object(n, &format!("nodes[{}]", ni))?;
        let samples_json = as_array(
            no.get("samples").ok_or("missing field nodes[].samples")?,
            "samples",
        )?;
        let mut samples = Vec::with_capacity(samples_json.len());
        for (si, sv) in samples_json.iter().enumerate() {
            samples.push(parse_pose(sv, &format!("nodes[{}].samples[{}]", ni, si))?);
        }
        let moving = match no.get("moving") {
            Some(v) => {
                parse_bool_or_num(v).ok_or_else(|| format!("nodes[{}].moving must be bool", ni))?
            }
            None => false,
        };
        let start_t = match no.get("startT") {
            Some(v) => as_f64(v, "startT")?,
            None => 0.0,
        };
        let frames = match no.get("frames") {
            Some(Json::Number(f)) if f.fract() == 0.0 && *f >= 0.0 => *f as usize,
            _ => samples.len().saturating_sub(1),
        };
        let previous_scores = match no.get("previousScores") {
            Some(Json::Array(arr)) => {
                if arr.len() > 75 {
                    return Err(format!(
                        "nodes[{}].previousScores must have 0..75 entries",
                        ni
                    ));
                }
                let mut v = Vec::with_capacity(arr.len());
                for (pi, pv) in arr.iter().enumerate() {
                    v.push(as_f64(
                        pv,
                        &format!("nodes[{}].previousScores[{}]", ni, pi),
                    )?);
                }
                Some(v)
            }
            Some(_) => {
                return Err(format!("nodes[{}].previousScores must be an array", ni));
            }
            None => None,
        };
        let node = RescoreNodeInput::new(samples, moving, start_t, frames);
        let node = match previous_scores {
            Some(prev) => node.with_previous_scores(prev),
            None => node,
        };
        nodes.push(node);
    }

    let threats_json = as_array(
        root.get("threats").ok_or("missing field threats")?,
        "threats",
    )?;
    let mut threats = Vec::with_capacity(threats_json.len());
    for (ti, t) in threats_json.iter().enumerate() {
        let to = as_object(t, &format!("threats[{}]", ti))?;
        let id = match to.get("id") {
            Some(Json::Number(n)) if n.fract() == 0.0 => *n as i64,
            _ => ti as i64,
        };
        let track = match to.get("track") {
            Some(Json::Array(arr)) => {
                let mut v = Vec::with_capacity(arr.len());
                for (fi, fp) in arr.iter().enumerate() {
                    let a = as_array(fp, &format!("threats[{}].track[{}]", ti, fi))?;
                    if a.len() != 3 {
                        return Err(format!("threats[{}].track[{}] must have 3 entries", ti, fi));
                    }
                    let alive = parse_bool_or_num(&a[2]).ok_or_else(|| {
                        format!("threats[{}].track[{}].alive must be bool", ti, fi)
                    })?;
                    v.push(ThreatTrackPoint::new(
                        as_f64(&a[0], "tx")?,
                        as_f64(&a[1], "ty")?,
                        alive,
                    ));
                }
                Some(v)
            }
            _ => None,
        };
        let path = match to.get("path") {
            Some(Json::Array(arr)) => {
                let mut v = Vec::with_capacity(arr.len());
                for (fi, fp) in arr.iter().enumerate() {
                    let (x, y) = parse_xy(fp, &format!("threats[{}].path[{}]", ti, fi))?;
                    v.push(ThreatPathPoint::new(x, y));
                }
                Some(v)
            }
            _ => None,
        };
        let speed = match to.get("speed") {
            Some(v) => as_f64(v, "speed")?,
            None => 0.0,
        };
        let anchor_offset = match to.get("anchorOffset") {
            Some(v) => as_f64(v, "anchorOffset")?,
            None => 0.0,
        };
        let bullet_radius = match to.get("bulletRadius") {
            Some(v) => as_f64(v, "bulletRadius")?,
            None => 0.25,
        };
        let life_left_seconds = match to.get("lifeLeftSeconds") {
            Some(v) => as_f64(v, "lifeLeftSeconds")?,
            None => 10.0,
        };
        let is_new = match to.get("isNew") {
            Some(v) => {
                parse_bool_or_num(v).ok_or_else(|| format!("threats[{}].isNew must be bool", ti))?
            }
            None => false,
        };
        threats.push(
            RescoreThreatInput::new(id)
                .with_track(track.unwrap_or_default())
                .with_path(path.unwrap_or_default(), speed)
                .with_anchor_offset(anchor_offset)
                .with_bullet_radius(bullet_radius)
                .with_life_left_seconds(life_left_seconds)
                .with_is_new(is_new),
        );
    }

    let cfg_json = root.get("cfg").ok_or("missing field cfg")?;
    let cgo = as_object(cfg_json, "cfg")?;
    let default_cfg = RescoreConfig::default();
    let cfg = RescoreConfig {
        death_penalty: match cgo.get("deathPenalty") {
            Some(v) => as_f64(v, "deathPenalty")?,
            None => default_cfg.death_penalty,
        },
        stuck_penalty: match cgo.get("stuckPenalty") {
            Some(v) => as_f64(v, "stuckPenalty")?,
            None => default_cfg.stuck_penalty,
        },
        stuck_dist_eps: match cgo.get("stuckDistEps") {
            Some(v) => as_f64(v, "stuckDistEps")?,
            None => default_cfg.stuck_dist_eps,
        },
        stuck_rot_eps: match cgo.get("stuckRotEps") {
            Some(v) => as_f64(v, "stuckRotEps")?,
            None => default_cfg.stuck_rot_eps,
        },
        lane_penalty_ratio: match cgo.get("lanePenaltyRatio") {
            Some(v) => as_f64(v, "lanePenaltyRatio")?,
            None => default_cfg.lane_penalty_ratio,
        },
        spring_rope_enabled: match cgo.get("springRopeEnabled") {
            Some(v) => {
                parse_bool_or_num(v).ok_or_else(|| "springRopeEnabled must be bool".to_string())?
            }
            None => default_cfg.spring_rope_enabled,
        },
    };

    Ok(Scene {
        cache_id,
        walls,
        nodes,
        threats,
        cfg,
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

fn json_u32(v: u32) -> String {
    v.to_string()
}

fn json_i32(v: i32) -> String {
    v.to_string()
}

fn json_f64_array(values: &[f64]) -> String {
    let mut out = String::from("[");
    for (i, v) in values.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str(&json_number(*v));
    }
    out.push(']');
    out
}

fn scene_output_json(scene_index: usize, scene: &Scene, cache: &mut VerificationCache) -> String {
    match rescore_nodes(
        cache,
        &scene.walls,
        &scene.nodes,
        &scene.threats,
        &scene.cfg,
    ) {
        Ok(outputs) => {
            let mut parts = Vec::with_capacity(outputs.len());
            for out in outputs {
                parts.push(format!(
                    "{{\"perFrameScores\":{},\"totalScore\":{},\"deathFrame\":{},\"verifiedFrames\":{},\"ok\":true}}",
                    json_f64_array(&out.per_frame_scores),
                    json_number(out.total_score),
                    json_i32(out.death_frame),
                    json_u32(out.verified_frames)
                ));
            }
            format!("{{\"nodes\":[{}]}}", parts.join(","))
        }
        Err(e) => {
            if matches!(
                e,
                vantage_core::rescore::RescoreError::SpringRopeUnsupported
            ) {
                let mut parts = Vec::with_capacity(scene.nodes.len());
                for _ in &scene.nodes {
                    parts.push(
                        "{\"perFrameScores\":[],\"totalScore\":0.0,\"deathFrame\":-1,\"verifiedFrames\":0,\"ok\":false}"
                            .to_string(),
                    );
                }
                format!("{{\"nodes\":[{}]}}", parts.join(","))
            } else {
                eprintln!("scene {} failed: {}", scene_index, e);
                process::exit(2);
            }
        }
    }
}

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() < 2 {
        eprintln!("usage: rescore_trace <scene.json>");
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

    let mut caches: std::collections::HashMap<u64, VerificationCache> =
        std::collections::HashMap::new();
    let mut outputs: Vec<String> = Vec::with_capacity(scenes.len());

    for (si, scene_json) in scenes.iter().enumerate() {
        let scene = match parse_scene(scene_json) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("invalid scene {}: {}", si, e);
                process::exit(2);
            }
        };
        let cache = caches.entry(scene.cache_id).or_default();
        let bench = std::env::var("RESCORE_BENCH")
            .map(|v| v == "1")
            .unwrap_or(false);
        let t0 = std::time::Instant::now();
        let out = scene_output_json(si, &scene, cache);
        if bench {
            eprintln!(
                "RESCORE_TIMING scene={} nodes={} threats={} ms={:.3}",
                si,
                scene.nodes.len(),
                scene.threats.len(),
                t0.elapsed().as_secs_f64() * 1000.0
            );
        }
        outputs.push(out);
    }

    if scenes.len() == 1 {
        println!("{}", outputs[0]);
    } else {
        println!("[{}]", outputs.join(","));
    }
}
