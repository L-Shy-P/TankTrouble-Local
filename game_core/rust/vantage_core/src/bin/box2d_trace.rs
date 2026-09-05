//! Reads the diff-test scene JSON and prints the tank trajectory as JSON.
//!
//! Usage: `cargo run --quiet --bin box2d_trace -- scene.json`

use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::process;

use vantage_core::box2d::{Body, BodyDef, CircleShape, FixtureDef, PolygonShape, Shape, World};

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

fn as_usize(v: &Json, what: &str) -> Result<usize, String> {
    let n = as_f64(v, what)?;
    if n < 0.0 || n.fract() != 0.0 {
        return Err(format!("{} must be a non-negative integer", what));
    }
    Ok(n as usize)
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

fn get_opt_num(obj: &BTreeMap<String, Json>, key: &str, default: f64) -> f64 {
    match obj.get(key) {
        Some(Json::Number(n)) => *n,
        _ => default,
    }
}

fn get_opt_bool(obj: &BTreeMap<String, Json>, key: &str, default: bool) -> bool {
    match obj.get(key) {
        Some(Json::Bool(b)) => *b,
        _ => default,
    }
}

fn get_opt_string(obj: &BTreeMap<String, Json>, key: &str, default: &str) -> String {
    match obj.get(key) {
        Some(Json::String(s)) => s.clone(),
        _ => default.to_string(),
    }
}

struct Scene {
    walls: Vec<(f64, f64, f64, f64)>, // cx, cy, half_w, half_h
    tank: TankScene,
    steps: usize,
    dt: f64,
    velocity_iterations: u32,
    position_iterations: u32,
}

struct TankScene {
    x: f64,
    y: f64,
    angle: f64,
    vx: f64,
    vy: f64,
    angular_velocity: f64,
    shape: String,
    radius: f64,
    half_width: f64,
    half_height: f64,
    bullet: bool,
    friction: f64,
    restitution: f64,
    density: f64,
}

fn parse_scene(json: &Json) -> Result<Scene, String> {
    let root = as_object(json, "root")?;
    let walls_json = as_array(root.get("walls").ok_or("missing field walls")?, "walls")?;
    let mut walls = Vec::with_capacity(walls_json.len());
    for (i, w) in walls_json.iter().enumerate() {
        let obj = as_object(w, &format!("walls[{}]", i))?;
        let cx = get_num(obj, "cx")?;
        let cy = get_num(obj, "cy")?;
        let hw = get_num(obj, "hw")?;
        let hh = get_num(obj, "hh")?;
        walls.push((cx, cy, hw, hh));
    }
    let tank_obj = as_object(root.get("tank").ok_or("missing field tank")?, "tank")?;
    let shape = get_opt_string(tank_obj, "shape", "rectangle");
    let tank = TankScene {
        x: get_num(tank_obj, "x")?,
        y: get_num(tank_obj, "y")?,
        angle: get_num(tank_obj, "angle")?,
        vx: get_num(tank_obj, "vx")?,
        vy: get_num(tank_obj, "vy")?,
        angular_velocity: get_num(tank_obj, "angularVelocity")?,
        radius: get_opt_num(tank_obj, "radius", 0.0),
        half_width: get_opt_num(tank_obj, "halfWidth", 0.0),
        half_height: get_opt_num(tank_obj, "halfHeight", 0.0),
        bullet: get_opt_bool(tank_obj, "bullet", false),
        friction: get_num(tank_obj, "friction")?,
        restitution: get_num(tank_obj, "restitution")?,
        density: get_num(tank_obj, "density")?,
        shape,
    };
    let steps = as_usize(root.get("steps").ok_or("missing field steps")?, "steps")?;
    let dt = get_num(root, "dt")?;
    let velocity_iterations = as_usize(
        root.get("velocityIterations")
            .ok_or("missing field velocityIterations")?,
        "velocityIterations",
    )? as u32;
    let position_iterations = as_usize(
        root.get("positionIterations")
            .ok_or("missing field positionIterations")?,
        "positionIterations",
    )? as u32;

    Ok(Scene {
        walls,
        tank,
        steps,
        dt,
        velocity_iterations,
        position_iterations,
    })
}

fn run_scene(scene: &Scene) -> Result<String, String> {
    let mut world = World::new((0.0, 0.0), true);

    // Static walls.
    for (cx, cy, hw, hh) in &scene.walls {
        let mut bd = BodyDef::new();
        bd.position.x = *cx;
        bd.position.y = *cy;
        let wall = Body::create(&mut world, bd);
        let mut fd = FixtureDef::new();
        fd.shape = Some(Shape::Polygon(PolygonShape::set_as_box(*hw, *hh)));
        fd.friction = 0.3;
        Body::create_fixture(&mut world, wall, fd);
    }

    // Dynamic body (rectangle or circle).
    let mut bd = BodyDef::new();
    bd.body_type = vantage_core::box2d::B2_DYNAMIC_BODY;
    bd.position.x = scene.tank.x;
    bd.position.y = scene.tank.y;
    bd.angle = scene.tank.angle;
    bd.linear_velocity.x = scene.tank.vx;
    bd.linear_velocity.y = scene.tank.vy;
    bd.angular_velocity = scene.tank.angular_velocity;
    bd.bullet = scene.tank.bullet;
    let tank = Body::create(&mut world, bd);
    let mut fd = FixtureDef::new();
    if scene.tank.shape == "circle" {
        if scene.tank.radius <= 0.0 {
            return Err("circle shape requires radius > 0".to_string());
        }
        fd.shape = Some(Shape::Circle(CircleShape::new(scene.tank.radius)));
    } else {
        if scene.tank.half_width <= 0.0 || scene.tank.half_height <= 0.0 {
            return Err("rectangle shape requires halfWidth > 0 and halfHeight > 0".to_string());
        }
        fd.shape = Some(Shape::Polygon(PolygonShape::set_as_box(
            scene.tank.half_width,
            scene.tank.half_height,
        )));
    }
    fd.friction = scene.tank.friction;
    fd.restitution = scene.tank.restitution;
    fd.density = scene.tank.density;
    Body::create_fixture(&mut world, tank, fd);

    let mut frames = String::from("[");
    for frame in 0..scene.steps {
        world.step(
            scene.dt,
            scene.velocity_iterations,
            scene.position_iterations,
        );
        let (x, y) = world.body_position(tank);
        let angle = world.body_angle(tank);
        if frame > 0 {
            frames.push(',');
        }
        frames.push_str(&format!(
            "[{},{},{}]",
            json_number(x),
            json_number(y),
            json_number(angle)
        ));
    }
    frames.push(']');
    Ok(frames)
}

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() < 2 {
        eprintln!("usage: box2d_trace <scene.json>");
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

    // Top-level `scenes` array prints an array of trajectories; otherwise
    // keep the original single-scene JSON shape working.
    let root = match as_object(&json, "root") {
        Ok(o) => o,
        Err(e) => {
            eprintln!("invalid scene: {}", e);
            process::exit(2);
        }
    };

    let mut outputs: Vec<String> = Vec::new();
    if let Some(scenes_json) = root.get("scenes") {
        let scenes_json = match as_array(scenes_json, "scenes") {
            Ok(a) => a,
            Err(e) => {
                eprintln!("invalid scene: {}", e);
                process::exit(2);
            }
        };
        for (i, s) in scenes_json.iter().enumerate() {
            let scene = match parse_scene(s) {
                Ok(sc) => sc,
                Err(e) => {
                    eprintln!("invalid scene {}: {}", i, e);
                    process::exit(2);
                }
            };
            match run_scene(&scene) {
                Ok(t) => outputs.push(t),
                Err(e) => {
                    eprintln!("failed to run scene {}: {}", i, e);
                    process::exit(2);
                }
            }
        }
        println!("[{}]", outputs.join(","));
    } else {
        let scene = match parse_scene(&json) {
            Ok(sc) => sc,
            Err(e) => {
                eprintln!("invalid scene: {}", e);
                process::exit(2);
            }
        };
        match run_scene(&scene) {
            Ok(t) => println!("{}", t),
            Err(e) => {
                eprintln!("failed to run scene: {}", e);
                process::exit(2);
            }
        }
    }
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
