//! Minimal Box2D subset translated from the game's JS Box2D
//! (`game_core/js/f1a5ef972c273fb89a098cb50b0f22e7.js`).
//!
//! The translation intentionally mirrors the JS implementation line-by-line
//! for the supported feature subset.  Public API names are Rustic; internal
//! function and field names keep the JS flavour so the diff is easy to review.

#![allow(clippy::needless_return)]
#![allow(clippy::too_many_arguments)]
#![allow(clippy::approx_constant)]

use std::f64::consts::PI;

// ---------------------------------------------------------------------------
// b2Settings constants (from Box2D.postDefs in the JS file)
// ---------------------------------------------------------------------------

pub const B2_LINEAR_SLOP: f64 = 0.005;
pub const B2_ANGULAR_SLOP: f64 = 2.0 / 180.0 * PI;
pub const B2_POLYGON_RADIUS: f64 = 2.0 * B2_LINEAR_SLOP;
pub const B2_MAX_MANIFOLD_POINTS: usize = 2;
pub const B2_MAX_TRANSLATION: f64 = 2.0;
pub const B2_MAX_TRANSLATION_SQUARED: f64 = B2_MAX_TRANSLATION * B2_MAX_TRANSLATION;
pub const B2_MAX_ROTATION: f64 = 0.5 * PI;
pub const B2_MAX_ROTATION_SQUARED: f64 = B2_MAX_ROTATION * B2_MAX_ROTATION;
pub const B2_CONTACT_BAUMGARTE: f64 = 0.2;
pub const B2_MAX_LINEAR_CORRECTION: f64 = 0.2;
pub const B2_VELOCITY_THRESHOLD: f64 = 1.0;

/// JS `Number.MIN_VALUE` (smallest positive subnormal).  The JS code compares
/// squared lengths against this in several places.
pub const JS_NUMBER_MIN_VALUE: f64 = 5e-324;

// Body types, matching `Box2D.Dynamics.b2Body.b2_*`.
pub const B2_STATIC_BODY: i32 = 0;
pub const B2_KINEMATIC_BODY: i32 = 1;
pub const B2_DYNAMIC_BODY: i32 = 2;

// Manifold types, matching `Box2D.Collision.b2Manifold.e_*`.
pub const MANIFOLD_E_CIRCLES: i32 = 1;
pub const MANIFOLD_E_FACE_A: i32 = 2;
pub const MANIFOLD_E_FACE_B: i32 = 4;

// Shape types, matching `Box2D.Collision.Shapes.b2Shape.e_*`.
pub const SHAPE_CIRCLE: i32 = 0;
pub const SHAPE_POLYGON: i32 = 1;

// Body flags, matching `Box2D.Dynamics.b2Body.e_*`.
const BODY_E_AWAKE_FLAG: u32 = 2;
const BODY_E_ALLOW_SLEEP_FLAG: u32 = 4;
const BODY_E_BULLET_FLAG: u32 = 8;
const BODY_E_FIXED_ROTATION_FLAG: u32 = 16;
const BODY_E_ACTIVE_FLAG: u32 = 32;

// ---------------------------------------------------------------------------
// b2Vec2 / b2Mat22 / b2Transform / b2Sweep
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Vec2 {
    pub x: f64,
    pub y: f64,
}

impl Vec2 {
    pub const ZERO: Vec2 = Vec2 { x: 0.0, y: 0.0 };

    pub fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }

    pub fn set(&mut self, x: f64, y: f64) {
        self.x = x;
        self.y = y;
    }

    pub fn set_zero(&mut self) {
        self.x = 0.0;
        self.y = 0.0;
    }

    pub fn set_v(&mut self, v: &Vec2) {
        self.x = v.x;
        self.y = v.y;
    }

    pub fn length_squared(&self) -> f64 {
        self.x * self.x + self.y * self.y
    }

    pub fn length(&self) -> f64 {
        self.length_squared().sqrt()
    }

    pub fn normalize(&mut self) -> f64 {
        let len = self.length();
        if len < JS_NUMBER_MIN_VALUE {
            return 0.0;
        }
        let inv = 1.0 / len;
        self.x *= inv;
        self.y *= inv;
        len
    }

    pub fn dot(&self, other: &Vec2) -> f64 {
        self.x * other.x + self.y * other.y
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Mat22 {
    pub col1: Vec2,
    pub col2: Vec2,
}

impl Mat22 {
    pub fn identity() -> Self {
        Self {
            col1: Vec2::new(1.0, 0.0),
            col2: Vec2::new(0.0, 1.0),
        }
    }

    pub fn set(&mut self, angle: f64) {
        let c = angle.cos();
        let s = angle.sin();
        self.col1.x = c;
        self.col2.x = -s;
        self.col1.y = s;
        self.col2.y = c;
    }

    pub fn set_identity(&mut self) {
        self.col1.x = 1.0;
        self.col2.x = 0.0;
        self.col1.y = 0.0;
        self.col2.y = 1.0;
    }

    pub fn set_zero(&mut self) {
        self.col1.x = 0.0;
        self.col2.x = 0.0;
        self.col1.y = 0.0;
        self.col2.y = 0.0;
    }

    pub fn set_vv(&mut self, col1: &Vec2, col2: &Vec2) {
        self.col1 = *col1;
        self.col2 = *col2;
    }

    pub fn set_m(&mut self, other: &Mat22) {
        self.col1 = other.col1;
        self.col2 = other.col2;
    }

    pub fn from_angle(angle: f64) -> Self {
        let mut m = Mat22::identity();
        m.set(angle);
        m
    }

    pub fn solve(&self, bx: f64, by: f64) -> Vec2 {
        let a11 = self.col1.x;
        let a12 = self.col2.x;
        let a21 = self.col1.y;
        let a22 = self.col2.y;
        let mut det = a11 * a22 - a12 * a21;
        if det != 0.0 {
            det = 1.0 / det;
        }
        Vec2::new(det * (a22 * bx - a12 * by), det * (a11 * by - a21 * bx))
    }

    pub fn get_inverse(&self) -> Mat22 {
        let a = self.col1.x;
        let b = self.col2.x;
        let c = self.col1.y;
        let d = self.col2.y;
        let mut det = a * d - b * c;
        if det != 0.0 {
            det = 1.0 / det;
        }
        Mat22 {
            col1: Vec2::new(det * d, -det * c),
            col2: Vec2::new(-det * b, det * a),
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Transform {
    pub position: Vec2,
    pub r: Mat22,
}

impl Transform {
    pub fn identity() -> Self {
        Self {
            position: Vec2::ZERO,
            r: Mat22::identity(),
        }
    }

    pub fn set_identity(&mut self) {
        self.position.set_zero();
        self.r.set_identity();
    }

    pub fn get_angle(&self) -> f64 {
        self.r.col1.y.atan2(self.r.col1.x)
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Sweep {
    pub local_center: Vec2,
    pub c0: Vec2,
    pub c: Vec2,
    pub a0: f64,
    pub a: f64,
    pub t0: f64,
}

impl Sweep {
    pub fn new() -> Self {
        Self {
            local_center: Vec2::ZERO,
            c0: Vec2::ZERO,
            c: Vec2::ZERO,
            a0: 0.0,
            a: 0.0,
            t0: 0.0,
        }
    }

    pub fn get_transform(&self, xf: &mut Transform, alpha: f64) {
        xf.position.x = (1.0 - alpha) * self.c0.x + alpha * self.c.x;
        xf.position.y = (1.0 - alpha) * self.c0.y + alpha * self.c.y;
        let angle = (1.0 - alpha) * self.a0 + alpha * self.a;
        xf.r.set(angle);
        xf.position.x -= xf.r.col1.x * self.local_center.x + xf.r.col2.x * self.local_center.y;
        xf.position.y -= xf.r.col1.y * self.local_center.x + xf.r.col2.y * self.local_center.y;
    }
}

// ---------------------------------------------------------------------------
// AABB (used by the simplified broad phase)
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug)]
pub struct AABB {
    pub lower_bound: Vec2,
    pub upper_bound: Vec2,
}

impl AABB {
    pub fn new() -> Self {
        Self {
            lower_bound: Vec2::ZERO,
            upper_bound: Vec2::ZERO,
        }
    }

    pub fn test_overlap(&self, other: &AABB) -> bool {
        let d1x = other.lower_bound.x - self.upper_bound.x;
        let d1y = other.lower_bound.y - self.upper_bound.y;
        let d2x = self.lower_bound.x - other.upper_bound.x;
        let d2y = self.lower_bound.y - other.upper_bound.y;
        !(d1x > 0.0 || d1y > 0.0) && !(d2x > 0.0 || d2y > 0.0)
    }

    pub fn combine(&mut self, a: &AABB, b: &AABB) {
        self.lower_bound.x = a.lower_bound.x.min(b.lower_bound.x);
        self.lower_bound.y = a.lower_bound.y.min(b.lower_bound.y);
        self.upper_bound.x = a.upper_bound.x.max(b.upper_bound.x);
        self.upper_bound.y = a.upper_bound.y.max(b.upper_bound.y);
    }

    pub fn contains(&self, aabb: &AABB) -> bool {
        self.lower_bound.x <= aabb.lower_bound.x
            && self.lower_bound.y <= aabb.lower_bound.y
            && aabb.upper_bound.x <= self.upper_bound.x
            && aabb.upper_bound.y <= self.upper_bound.y
    }
}

// ---------------------------------------------------------------------------
// b2Math equivalent free functions
// ---------------------------------------------------------------------------

#[inline]
fn b2_dot(a: &Vec2, b: &Vec2) -> f64 {
    a.x * b.x + a.y * b.y
}

#[inline]
fn b2_cross_vv(a: &Vec2, b: &Vec2) -> f64 {
    a.x * b.y - a.y * b.x
}

#[inline]
fn b2_cross_vf(a: &Vec2, s: f64) -> Vec2 {
    Vec2::new(s * a.y, -s * a.x)
}

#[inline]
fn b2_mul_mv(m: &Mat22, v: &Vec2) -> Vec2 {
    Vec2::new(
        m.col1.x * v.x + m.col2.x * v.y,
        m.col1.y * v.x + m.col2.y * v.y,
    )
}

#[inline]
fn b2_mul_tmv(m: &Mat22, v: &Vec2) -> Vec2 {
    Vec2::new(b2_dot(v, &m.col1), b2_dot(v, &m.col2))
}

#[inline]
fn b2_mul_x(xf: &Transform, v: &Vec2) -> Vec2 {
    let mut out = b2_mul_mv(&xf.r, v);
    out.x += xf.position.x;
    out.y += xf.position.y;
    out
}

#[inline]
fn b2_mul_xt(xf: &Transform, v: &Vec2) -> Vec2 {
    let mut tmp = Vec2::new(v.x - xf.position.x, v.y - xf.position.y);
    let x = tmp.x * xf.r.col1.x + tmp.y * xf.r.col1.y;
    tmp.y = tmp.x * xf.r.col2.x + tmp.y * xf.r.col2.y;
    tmp.x = x;
    tmp
}

#[inline]
fn b2_add_vv(a: &Vec2, b: &Vec2) -> Vec2 {
    Vec2::new(a.x + b.x, a.y + b.y)
}

#[inline]
fn b2_sub_vv(a: &Vec2, b: &Vec2) -> Vec2 {
    Vec2::new(a.x - b.x, a.y - b.y)
}

#[inline]
fn b2_mul_fv(s: f64, v: &Vec2) -> Vec2 {
    Vec2::new(s * v.x, s * v.y)
}

#[inline]
fn b2_clamp(v: f64, lo: f64, hi: f64) -> f64 {
    if v < lo {
        lo
    } else if v > hi {
        hi
    } else {
        v
    }
}

#[inline]
fn b2_sqrt(v: f64) -> f64 {
    v.sqrt()
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub struct PolygonShape {
    pub vertices: Vec<Vec2>,
    pub normals: Vec<Vec2>,
    pub centroid: Vec2,
    pub radius: f64,
}

impl PolygonShape {
    pub fn from_vertices(vertices: &[(f64, f64)]) -> Result<PolygonShape, String> {
        let count = vertices.len();
        if count < 2 {
            return Err("PolygonShape requires at least 2 vertices".to_string());
        }
        let mut shape = PolygonShape {
            vertices: Vec::with_capacity(count),
            normals: Vec::with_capacity(count),
            centroid: Vec2::ZERO,
            radius: B2_LINEAR_SLOP,
        };
        for v in vertices {
            shape.vertices.push(Vec2::new(v.0, v.1));
            shape.normals.push(Vec2::ZERO);
        }
        for i in 0..count {
            let next = if i + 1 < count { i + 1 } else { 0 };
            let edge = b2_sub_vv(&shape.vertices[next], &shape.vertices[i]);
            if edge.length_squared() <= JS_NUMBER_MIN_VALUE {
                return Err(format!("PolygonShape edge {} has zero length", i));
            }
            let mut n = b2_cross_vf(&edge, 1.0);
            n.normalize();
            shape.normals[i] = n;
        }
        shape.centroid = polygon_compute_centroid(&shape.vertices, count);
        Ok(shape)
    }

    pub fn set_as_box(half_width: f64, half_height: f64) -> PolygonShape {
        let mut s = PolygonShape {
            vertices: Vec::with_capacity(4),
            normals: Vec::with_capacity(4),
            centroid: Vec2::ZERO,
            radius: B2_LINEAR_SLOP,
        };
        s.vertices.push(Vec2::new(-half_width, -half_height));
        s.vertices.push(Vec2::new(half_width, -half_height));
        s.vertices.push(Vec2::new(half_width, half_height));
        s.vertices.push(Vec2::new(-half_width, half_height));
        s.normals.push(Vec2::new(0.0, -1.0));
        s.normals.push(Vec2::new(1.0, 0.0));
        s.normals.push(Vec2::new(0.0, 1.0));
        s.normals.push(Vec2::new(-1.0, 0.0));
        s
    }

    pub fn compute_mass(&self, density: f64) -> (f64, Vec2, f64) {
        if self.vertices.len() == 2 {
            return (
                0.0,
                Vec2::new(
                    0.5 * (self.vertices[0].x + self.vertices[1].x),
                    0.5 * (self.vertices[0].y + self.vertices[1].y),
                ),
                0.0,
            );
        }
        let mut area = 0.0;
        let mut cx = 0.0;
        let mut cy = 0.0;
        let mut inertia = 0.0;
        let inv3 = 1.0 / 3.0;
        for i in 0..self.vertices.len() {
            let p1 = self.vertices[i];
            let p2 = if i + 1 < self.vertices.len() {
                self.vertices[i + 1]
            } else {
                self.vertices[0]
            };
            let d = b2_cross_vv(&p1, &p2);
            let triangle_area = 0.5 * d;
            area += triangle_area;
            cx += triangle_area * inv3 * (p1.x + p2.x);
            cy += triangle_area * inv3 * (p1.y + p2.y);
            inertia += d
                * (inv3 * (0.25 * (p1.x * p1.x + p2.x * p1.x + p2.x * p2.x))
                    + inv3 * (0.25 * (p1.y * p1.y + p2.y * p1.y + p2.y * p2.y)));
        }
        let mass = density * area;
        cx *= 1.0 / area;
        cy *= 1.0 / area;
        (mass, Vec2::new(cx, cy), density * inertia)
    }
}

fn polygon_compute_centroid(vertices: &[Vec2], count: usize) -> Vec2 {
    let mut c = Vec2::ZERO;
    let mut area = 0.0;
    let inv3 = 1.0 / 3.0;
    for i in 0..count {
        let p1 = vertices[i];
        let p2 = if i + 1 < count {
            vertices[i + 1]
        } else {
            vertices[0]
        };
        let d = b2_cross_vv(&p1, &p2);
        let triangle_area = 0.5 * d;
        area += triangle_area;
        c.x += triangle_area * inv3 * (p1.x + p2.x);
        c.y += triangle_area * inv3 * (p1.y + p2.y);
    }
    c.x *= 1.0 / area;
    c.y *= 1.0 / area;
    c
}

#[derive(Clone, Debug)]
pub struct CircleShape {
    pub center: Vec2,
    pub radius: f64,
}

impl CircleShape {
    pub fn new(radius: f64) -> Self {
        Self {
            center: Vec2::ZERO,
            radius,
        }
    }

    pub fn compute_mass(&self, density: f64) -> (f64, Vec2, f64) {
        let mass = density * PI * self.radius * self.radius;
        let inertia = mass * (0.5 * self.radius * self.radius + self.center.dot(&self.center));
        (mass, self.center, inertia)
    }
}

#[derive(Clone, Debug)]
pub enum Shape {
    Polygon(PolygonShape),
    Circle(CircleShape),
}

impl Shape {
    pub fn get_type(&self) -> i32 {
        match self {
            Shape::Polygon(_) => SHAPE_POLYGON,
            Shape::Circle(_) => SHAPE_CIRCLE,
        }
    }

    pub fn radius(&self) -> f64 {
        match self {
            Shape::Polygon(p) => p.radius,
            Shape::Circle(c) => c.radius,
        }
    }

    pub fn compute_aabb(&self, xf: &Transform) -> AABB {
        match self {
            Shape::Circle(c) => {
                let center = b2_mul_x(xf, &c.center);
                AABB {
                    lower_bound: Vec2::new(center.x - c.radius, center.y - c.radius),
                    upper_bound: Vec2::new(center.x + c.radius, center.y + c.radius),
                }
            }
            Shape::Polygon(p) => {
                let mut lower;
                let mut upper;
                {
                    let w0 = b2_mul_x(xf, &p.vertices[0]);
                    lower = w0;
                    upper = w0;
                }
                for i in 1..p.vertices.len() {
                    let w = b2_mul_x(xf, &p.vertices[i]);
                    lower.x = lower.x.min(w.x);
                    lower.y = lower.y.min(w.y);
                    upper.x = upper.x.max(w.x);
                    upper.y = upper.y.max(w.y);
                }
                lower.x -= p.radius;
                lower.y -= p.radius;
                upper.x += p.radius;
                upper.y += p.radius;
                AABB {
                    lower_bound: lower,
                    upper_bound: upper,
                }
            }
        }
    }

    pub fn compute_mass(&self, density: f64) -> (f64, Vec2, f64) {
        match self {
            Shape::Polygon(p) => p.compute_mass(density),
            Shape::Circle(c) => c.compute_mass(density),
        }
    }
}

// ---------------------------------------------------------------------------
// Contact ID / manifold / world manifold
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ContactID {
    pub key: u32,
}

impl ContactID {
    pub fn new() -> Self {
        Self { key: 0 }
    }

    pub fn set_reference_edge(&mut self, edge: u8) {
        self.key = (self.key & 0xffffff00) | (edge as u32 & 0xff);
    }

    pub fn set_incident_edge(&mut self, edge: u8) {
        self.key = (self.key & 0xffff00ff) | ((edge as u32 & 0xff) << 8);
    }

    pub fn set_incident_vertex(&mut self, vertex: u8) {
        self.key = (self.key & 0xff00ffff) | ((vertex as u32 & 0xff) << 16);
    }

    pub fn set_flip(&mut self, flip: u8) {
        self.key = (self.key & 0x00ffffff) | ((flip as u32 & 0xff) << 24);
    }
}

#[derive(Clone, Copy, Debug)]
pub struct ManifoldPoint {
    pub local_point: Vec2,
    pub normal_impulse: f64,
    pub tangent_impulse: f64,
    pub id: ContactID,
}

impl ManifoldPoint {
    pub fn new() -> Self {
        Self {
            local_point: Vec2::ZERO,
            normal_impulse: 0.0,
            tangent_impulse: 0.0,
            id: ContactID::new(),
        }
    }
}

#[derive(Clone, Debug)]
pub struct Manifold {
    pub points: Vec<ManifoldPoint>,
    pub local_plane_normal: Vec2,
    pub local_point: Vec2,
    pub manifold_type: i32,
    pub point_count: usize,
}

impl Manifold {
    pub fn new() -> Self {
        Self {
            points: vec![ManifoldPoint::new(); B2_MAX_MANIFOLD_POINTS],
            local_plane_normal: Vec2::ZERO,
            local_point: Vec2::ZERO,
            manifold_type: 0,
            point_count: 0,
        }
    }

    pub fn set(&mut self, other: &Manifold) {
        self.point_count = other.point_count;
        for i in 0..B2_MAX_MANIFOLD_POINTS {
            self.points[i].local_point = other.points[i].local_point;
            self.points[i].normal_impulse = other.points[i].normal_impulse;
            self.points[i].tangent_impulse = other.points[i].tangent_impulse;
            self.points[i].id.key = other.points[i].id.key;
        }
        self.local_plane_normal = other.local_plane_normal;
        self.local_point = other.local_point;
        self.manifold_type = other.manifold_type;
    }
}

#[derive(Clone, Debug)]
pub struct WorldManifold {
    pub normal: Vec2,
    pub points: [Vec2; B2_MAX_MANIFOLD_POINTS],
}

impl WorldManifold {
    pub fn new() -> Self {
        Self {
            normal: Vec2::ZERO,
            points: [Vec2::ZERO; B2_MAX_MANIFOLD_POINTS],
        }
    }

    pub fn initialize(
        &mut self,
        manifold: &Manifold,
        xf_a: &Transform,
        radius_a: f64,
        xf_b: &Transform,
        radius_b: f64,
    ) {
        if manifold.point_count == 0 {
            return;
        }
        match manifold.manifold_type {
            MANIFOLD_E_CIRCLES => {
                let p_a = b2_mul_x(xf_a, &manifold.local_point);
                let p_b = b2_mul_x(xf_b, &manifold.points[0].local_point);
                let d = b2_sub_vv(&p_b, &p_a);
                let len_sq = d.length_squared();
                if len_sq > JS_NUMBER_MIN_VALUE * JS_NUMBER_MIN_VALUE {
                    let len = b2_sqrt(len_sq);
                    self.normal.x = d.x / len;
                    self.normal.y = d.y / len;
                } else {
                    self.normal.x = 1.0;
                    self.normal.y = 0.0;
                }
                let c_a = b2_add_vv(&p_a, &b2_mul_fv(radius_a, &self.normal));
                let c_b = b2_sub_vv(&p_b, &b2_mul_fv(radius_b, &self.normal));
                self.points[0] = b2_mul_fv(0.5, &b2_add_vv(&c_a, &c_b));
            }
            MANIFOLD_E_FACE_A => {
                self.normal = b2_mul_mv(&xf_a.r, &manifold.local_plane_normal);
                let plane_point = b2_mul_x(xf_a, &manifold.local_point);
                for i in 0..manifold.point_count {
                    let clip_point = b2_mul_x(xf_b, &manifold.points[i].local_point);
                    let d = (clip_point.x - plane_point.x) * self.normal.x
                        + (clip_point.y - plane_point.y) * self.normal.y;
                    let k = 0.5 * (radius_a - d - radius_b);
                    self.points[i].x = clip_point.x + k * self.normal.x;
                    self.points[i].y = clip_point.y + k * self.normal.y;
                }
            }
            MANIFOLD_E_FACE_B => {
                self.normal = b2_mul_mv(&xf_b.r, &manifold.local_plane_normal);
                let plane_point = b2_mul_x(xf_b, &manifold.local_point);
                for i in 0..manifold.point_count {
                    let clip_point = b2_mul_x(xf_a, &manifold.points[i].local_point);
                    let d = (clip_point.x - plane_point.x) * self.normal.x
                        + (clip_point.y - plane_point.y) * self.normal.y;
                    let k = 0.5 * (radius_b - d - radius_a);
                    self.points[i].x = clip_point.x + k * self.normal.x;
                    self.points[i].y = clip_point.y + k * self.normal.y;
                }
                self.normal.x *= -1.0;
                self.normal.y *= -1.0;
            }
            _ => {}
        }
    }
}

// ---------------------------------------------------------------------------
// b2Collision functions (polygon-polygon and polygon-circle only)
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug)]
struct ClipVertex {
    v: Vec2,
    id: ContactID,
}

impl ClipVertex {
    fn new() -> Self {
        Self {
            v: Vec2::ZERO,
            id: ContactID::new(),
        }
    }

    fn set(&mut self, other: &ClipVertex) {
        self.v = other.v;
        self.id.key = other.id.key;
    }
}

fn clip_segment_to_line(
    v_out: &mut [ClipVertex; 2],
    v_in: &[ClipVertex; 2],
    normal: &Vec2,
    offset: f64,
) -> usize {
    let mut count = 0;
    let v0 = v_in[0].v;
    let v1 = v_in[1].v;
    let distance0 = normal.x * v0.x + normal.y * v0.y - offset;
    let distance1 = normal.x * v1.x + normal.y * v1.y - offset;

    if distance0 <= 0.0 {
        v_out[count].set(&v_in[0]);
        count += 1;
    }
    if distance1 <= 0.0 {
        v_out[count].set(&v_in[1]);
        count += 1;
    }
    if distance0 * distance1 < 0.0 {
        let interp = distance0 / (distance0 - distance1);
        v_out[count].v.x = v0.x + interp * (v1.x - v0.x);
        v_out[count].v.y = v0.y + interp * (v1.y - v0.y);
        if distance0 > 0.0 {
            v_out[count].id.key = v_in[0].id.key;
        } else {
            v_out[count].id.key = v_in[1].id.key;
        }
        count += 1;
    }
    count
}

fn edge_separation(
    poly1: &PolygonShape,
    xf1: &Transform,
    edge1: usize,
    poly2: &PolygonShape,
    xf2: &Transform,
) -> f64 {
    let vertices1 = &poly1.vertices;
    let normals1 = &poly1.normals;
    let count2 = poly2.vertices.len();
    let vertices2 = &poly2.vertices;

    let normal1_world = b2_mul_mv(&xf1.r, &normals1[edge1]);
    // Transform normal1 into poly2's local frame (transposed rotation of xf2).
    let normal1_local2 = b2_mul_tmv(&xf2.r, &normal1_world);

    let mut min_dot = f64::MAX;
    let mut min_index = 0usize;
    for i in 0..count2 {
        let d = vertices2[i].x * normal1_local2.x + vertices2[i].y * normal1_local2.y;
        if d < min_dot {
            min_dot = d;
            min_index = i;
        }
    }

    let v1_world = b2_mul_x(xf1, &vertices1[edge1]);
    let v2_world = b2_mul_x(xf2, &vertices2[min_index]);
    let d = b2_sub_vv(&v2_world, &v1_world);
    b2_dot(&d, &normal1_world)
}

fn find_max_separation(
    edge_index: &mut usize,
    poly1: &PolygonShape,
    xf1: &Transform,
    poly2: &PolygonShape,
    xf2: &Transform,
) -> f64 {
    let count1 = poly1.vertices.len();
    let normals1 = &poly1.normals;

    // Vector from poly1 centroid to poly2 centroid expressed in poly1 local.
    let d = b2_sub_vv(
        &b2_mul_x(xf2, &poly2.centroid),
        &b2_mul_x(xf1, &poly1.centroid),
    );
    let d_local1 = b2_mul_tmv(&xf1.r, &d);

    let mut best_edge = 0usize;
    let mut best_sep = f64::MIN;
    for i in 0..count1 {
        let sep = normals1[i].x * d_local1.x + normals1[i].y * d_local1.y;
        if sep > best_sep {
            best_sep = sep;
            best_edge = i;
        }
    }

    let mut edge = best_edge;
    let mut sep = edge_separation(poly1, xf1, edge, poly2, xf2);
    let prev_edge = if edge >= 1 { edge - 1 } else { count1 - 1 };
    let sep_prev = edge_separation(poly1, xf1, prev_edge, poly2, xf2);
    let next_edge = if edge + 1 < count1 { edge + 1 } else { 0 };
    let sep_next = edge_separation(poly1, xf1, next_edge, poly2, xf2);

    let mut iteration = 0i32;
    let mut edge1 = edge;
    let mut best_sep1 = sep;

    if sep_prev > sep && sep_prev > sep_next {
        iteration = -1;
        edge1 = prev_edge;
        best_sep1 = sep_prev;
    } else if sep_next > sep {
        iteration = 1;
        edge1 = next_edge;
        best_sep1 = sep_next;
    }

    if iteration == 0 {
        *edge_index = edge;
        return sep;
    }

    loop {
        edge = if iteration == -1 {
            if edge1 >= 1 {
                edge1 - 1
            } else {
                count1 - 1
            }
        } else if edge1 + 1 < count1 {
            edge1 + 1
        } else {
            0
        };
        sep = edge_separation(poly1, xf1, edge, poly2, xf2);
        if sep > best_sep1 {
            edge1 = edge;
            best_sep1 = sep;
        } else {
            break;
        }
    }
    *edge_index = edge1;
    best_sep1
}

fn find_incident_edge(
    incident: &mut [ClipVertex; 2],
    poly1: &PolygonShape,
    xf1: &Transform,
    edge1: usize,
    poly2: &PolygonShape,
    xf2: &Transform,
) {
    let normals1 = &poly1.normals;
    let count2 = poly2.vertices.len();
    let vertices2 = &poly2.vertices;
    let normals2 = &poly2.normals;

    let normal1_world = b2_mul_mv(&xf1.r, &normals1[edge1]);
    let normal1_local2 = b2_mul_tmv(&xf2.r, &normal1_world);

    let mut min_dot = f64::MAX;
    let mut incident_edge = 0usize;
    for i in 0..count2 {
        let dot = normal1_local2.x * normals2[i].x + normal1_local2.y * normals2[i].y;
        if dot < min_dot {
            min_dot = dot;
            incident_edge = i;
        }
    }

    let next = if incident_edge + 1 < count2 {
        incident_edge + 1
    } else {
        0
    };
    incident[0].v = b2_mul_x(xf2, &vertices2[incident_edge]);
    incident[0].id.key = 0;
    incident[0].id.set_reference_edge(edge1 as u8);
    incident[0].id.set_incident_edge(incident_edge as u8);
    incident[0].id.set_incident_vertex(0);

    incident[1].v = b2_mul_x(xf2, &vertices2[next]);
    incident[1].id.key = 0;
    incident[1].id.set_reference_edge(edge1 as u8);
    incident[1].id.set_incident_edge(next as u8);
    incident[1].id.set_incident_vertex(1);
}

fn collide_polygons(
    manifold: &mut Manifold,
    poly_a: &PolygonShape,
    xf_a: &Transform,
    poly_b: &PolygonShape,
    xf_b: &Transform,
) {
    manifold.point_count = 0;
    let total_radius = poly_a.radius + poly_b.radius;

    let mut edge_a = 0usize;
    let sep_a = find_max_separation(&mut edge_a, poly_a, xf_a, poly_b, xf_b);
    if sep_a > total_radius {
        return;
    }

    let mut edge_b = 0usize;
    let sep_b = find_max_separation(&mut edge_b, poly_b, xf_b, poly_a, xf_a);
    if sep_b > total_radius {
        return;
    }

    let (poly1, poly2, xf1, xf2, edge1, flip): (
        &PolygonShape,
        &PolygonShape,
        &Transform,
        &Transform,
        usize,
        u8,
    ) = if sep_b > 0.98 * sep_a + 0.001 {
        (poly_b, poly_a, xf_b, xf_a, edge_b, 1)
    } else {
        (poly_a, poly_b, xf_a, xf_b, edge_a, 0)
    };

    let mut incident = [ClipVertex::new(); 2];
    find_incident_edge(&mut incident, poly1, xf1, edge1, poly2, xf2);

    let count1 = poly1.vertices.len();
    let vertices1 = &poly1.vertices;
    let v11 = vertices1[edge1];
    let v12 = if edge1 + 1 < count1 {
        vertices1[edge1 + 1]
    } else {
        vertices1[0]
    };

    let mut local_tangent = b2_sub_vv(&v12, &v11);
    local_tangent.normalize();
    let local_normal = Vec2::new(local_tangent.y, -local_tangent.x);
    let plane_point = Vec2::new(0.5 * (v11.x + v12.x), 0.5 * (v11.y + v12.y));

    let tangent = b2_mul_mv(&xf1.r, &local_tangent);
    let tangent2 = Vec2::new(-tangent.x, -tangent.y);
    let normal = Vec2::new(tangent.y, -tangent.x);

    let v11_world = b2_mul_x(xf1, &v11);
    let v12_world = b2_mul_x(xf1, &v12);
    let front_offset = normal.x * v11_world.x + normal.y * v11_world.y;
    let side_offset1 = -tangent.x * v11_world.x - tangent.y * v11_world.y + total_radius;
    let side_offset2 = tangent.x * v12_world.x + tangent.y * v12_world.y + total_radius;

    let mut clip_points1 = [ClipVertex::new(); 2];
    let mut clip_points2 = [ClipVertex::new(); 2];

    let count_c1 = clip_segment_to_line(&mut clip_points1, &incident, &tangent2, side_offset1);
    if count_c1 < 2 {
        return;
    }
    let count_c2 = clip_segment_to_line(&mut clip_points2, &clip_points1, &tangent, side_offset2);
    if count_c2 < 2 {
        return;
    }

    manifold.local_plane_normal = local_normal;
    manifold.local_point = plane_point;
    manifold.manifold_type = if flip == 1 {
        MANIFOLD_E_FACE_B
    } else {
        MANIFOLD_E_FACE_A
    };

    let mut point_count = 0usize;
    for i in 0..B2_MAX_MANIFOLD_POINTS {
        let cv = clip_points2[i];
        let separation = normal.x * cv.v.x + normal.y * cv.v.y - front_offset;
        if separation <= total_radius {
            let mp = &mut manifold.points[point_count];
            let local = b2_mul_xt(xf2, &cv.v);
            mp.local_point = local;
            mp.id.key = cv.id.key;
            mp.id.set_flip(flip);
            point_count += 1;
        }
    }
    manifold.point_count = point_count;
}

fn collide_polygon_and_circle(
    manifold: &mut Manifold,
    poly: &PolygonShape,
    xf_poly: &Transform,
    circle: &CircleShape,
    xf_circle: &Transform,
) {
    manifold.point_count = 0;

    let c_world = b2_mul_x(xf_circle, &circle.center);
    let d = b2_sub_vv(&c_world, &xf_poly.position);
    let c_local = b2_mul_tmv(&xf_poly.r, &d);

    let total_radius = poly.radius + circle.radius;
    let vertex_count = poly.vertices.len();
    let vertices = &poly.vertices;
    let normals = &poly.normals;

    let mut normal_index = 0usize;
    let mut separation = f64::MIN;
    for i in 0..vertex_count {
        let s =
            normals[i].x * (c_local.x - vertices[i].x) + normals[i].y * (c_local.y - vertices[i].y);
        if s > total_radius {
            return;
        }
        if s > separation {
            separation = s;
            normal_index = i;
        }
    }

    let vert1 = vertices[normal_index];
    let vert2 = if normal_index + 1 < vertex_count {
        vertices[normal_index + 1]
    } else {
        vertices[0]
    };

    if separation < JS_NUMBER_MIN_VALUE {
        manifold.point_count = 1;
        manifold.manifold_type = MANIFOLD_E_FACE_A;
        manifold.local_plane_normal = normals[normal_index];
        manifold.local_point.x = 0.5 * (vert1.x + vert2.x);
        manifold.local_point.y = 0.5 * (vert1.y + vert2.y);
        manifold.points[0].local_point = circle.center;
        manifold.points[0].id.key = 0;
        return;
    }

    let u1 =
        (c_local.x - vert1.x) * (vert2.x - vert1.x) + (c_local.y - vert1.y) * (vert2.y - vert1.y);
    let u2 =
        (c_local.x - vert2.x) * (vert1.x - vert2.x) + (c_local.y - vert2.y) * (vert1.y - vert2.y);

    if u1 <= 0.0 {
        let dx = c_local.x - vert1.x;
        let dy = c_local.y - vert1.y;
        if dx * dx + dy * dy > total_radius * total_radius {
            return;
        }
        manifold.point_count = 1;
        manifold.manifold_type = MANIFOLD_E_FACE_A;
        let mut n = Vec2::new(dx, dy);
        n.normalize();
        manifold.local_plane_normal = n;
        manifold.local_point = vert1;
        manifold.points[0].local_point = circle.center;
        manifold.points[0].id.key = 0;
    } else if u2 <= 0.0 {
        let dx = c_local.x - vert2.x;
        let dy = c_local.y - vert2.y;
        if dx * dx + dy * dy > total_radius * total_radius {
            return;
        }
        manifold.point_count = 1;
        manifold.manifold_type = MANIFOLD_E_FACE_A;
        let mut n = Vec2::new(dx, dy);
        n.normalize();
        manifold.local_plane_normal = n;
        manifold.local_point = vert2;
        manifold.points[0].local_point = circle.center;
        manifold.points[0].id.key = 0;
    } else {
        let mid = Vec2::new(0.5 * (vert1.x + vert2.x), 0.5 * (vert1.y + vert2.y));
        let s = (c_local.x - mid.x) * normals[normal_index].x
            + (c_local.y - mid.y) * normals[normal_index].y;
        if s > total_radius {
            return;
        }
        manifold.point_count = 1;
        manifold.manifold_type = MANIFOLD_E_FACE_A;
        manifold.local_plane_normal = normals[normal_index];
        manifold.local_plane_normal.normalize();
        manifold.local_point = mid;
        manifold.points[0].local_point = circle.center;
        manifold.points[0].id.key = 0;
    }
}

// ---------------------------------------------------------------------------
// Dynamics: BodyDef / Body / FixtureDef / Fixture / World
// ---------------------------------------------------------------------------

pub type BodyId = usize;
pub type FixtureId = usize;

#[derive(Clone, Debug)]
pub struct BodyDef {
    pub position: Vec2,
    pub angle: f64,
    pub linear_velocity: Vec2,
    pub angular_velocity: f64,
    pub linear_damping: f64,
    pub angular_damping: f64,
    pub allow_sleep: bool,
    pub awake: bool,
    pub fixed_rotation: bool,
    pub bullet: bool,
    pub body_type: i32,
    pub active: bool,
    pub inertia_scale: f64,
}

impl Default for BodyDef {
    fn default() -> Self {
        Self {
            position: Vec2::ZERO,
            angle: 0.0,
            linear_velocity: Vec2::ZERO,
            angular_velocity: 0.0,
            linear_damping: 0.0,
            angular_damping: 0.0,
            allow_sleep: true,
            awake: true,
            fixed_rotation: false,
            bullet: false,
            body_type: B2_STATIC_BODY,
            active: true,
            inertia_scale: 1.0,
        }
    }
}

impl BodyDef {
    pub fn new() -> Self {
        Self::default()
    }
}

#[derive(Clone, Debug)]
pub struct FixtureDef {
    pub shape: Option<Shape>,
    pub friction: f64,
    pub restitution: f64,
    pub density: f64,
    pub is_sensor: bool,
}

impl Default for FixtureDef {
    fn default() -> Self {
        Self {
            shape: None,
            friction: 0.2,
            restitution: 0.0,
            density: 0.0,
            is_sensor: false,
        }
    }
}

impl FixtureDef {
    pub fn new() -> Self {
        Self::default()
    }
}

#[derive(Clone, Debug)]
pub struct Fixture {
    pub shape: Shape,
    pub friction: f64,
    pub restitution: f64,
    pub density: f64,
    pub is_sensor: bool,
    pub body: BodyId,
    pub aabb: AABB,
}

#[derive(Debug)]
pub struct Body {
    pub flags: u32,
    pub body_type: i32,
    pub xf: Transform,
    pub sweep: Sweep,
    pub linear_velocity: Vec2,
    pub angular_velocity: f64,
    pub force: Vec2,
    pub torque: f64,
    pub mass: f64,
    pub inv_mass: f64,
    pub i: f64,
    pub inv_i: f64,
    pub inertia_scale: f64,
    pub linear_damping: f64,
    pub angular_damping: f64,
    pub fixture_ids: Vec<FixtureId>,
    pub sleep_time: f64,
}

impl Body {
    pub fn is_awake(&self) -> bool {
        self.flags & BODY_E_AWAKE_FLAG != 0
    }

    pub fn is_active(&self) -> bool {
        self.flags & BODY_E_ACTIVE_FLAG != 0
    }

    pub fn is_bullet(&self) -> bool {
        self.flags & BODY_E_BULLET_FLAG != 0
    }

    pub fn is_fixed_rotation(&self) -> bool {
        self.flags & BODY_E_FIXED_ROTATION_FLAG != 0
    }

    pub fn synchronize_transform(&mut self) {
        self.xf.r.set(self.sweep.a);
        let r = self.xf.r;
        let lc = self.sweep.local_center;
        self.xf.position.x = self.sweep.c.x - (r.col1.x * lc.x + r.col2.x * lc.y);
        self.xf.position.y = self.sweep.c.y - (r.col1.y * lc.x + r.col2.y * lc.y);
    }

    pub fn reset_mass_data(&mut self) {
        self.mass = 0.0;
        self.inv_mass = 0.0;
        self.i = 0.0;
        self.inv_i = 0.0;
        self.sweep.local_center.set_zero();

        if self.body_type != B2_STATIC_BODY && self.body_type != B2_KINEMATIC_BODY {
            let mut local_center = Vec2::ZERO;
            let mut mass = 0.0;
            let mut inertia = 0.0;
            // Fixture mass accumulation is done by World::create_fixture because
            // it needs the fixture shapes.  See `World::reset_body_mass_data`.
            // (Bodies are always created empty, then fixtures are attached.)
            let _ = (&mut local_center, &mut mass, &mut inertia);
        }
    }
}

// ---------------------------------------------------------------------------
// Contact / time step / solver data
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
struct Contact {
    fixture_a: FixtureId,
    fixture_b: FixtureId,
    manifold: Manifold,
    old_manifold: Manifold,
    touching: bool,
}

impl Contact {
    fn new(fixture_a: FixtureId, fixture_b: FixtureId) -> Self {
        Self {
            fixture_a,
            fixture_b,
            manifold: Manifold::new(),
            old_manifold: Manifold::new(),
            touching: false,
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct TimeStep {
    dt: f64,
    inv_dt: f64,
    velocity_iterations: u32,
    position_iterations: u32,
    warm_starting: bool,
    dt_ratio: f64,
}

#[derive(Clone, Copy, Debug)]
struct BodyVelocity {
    v: Vec2,
    w: f64,
    inv_mass: f64,
    inv_i: f64,
}

#[derive(Clone, Debug)]
struct ContactConstraintPoint {
    local_point: Vec2,
    r_a: Vec2,
    r_b: Vec2,
    normal_impulse: f64,
    tangent_impulse: f64,
    normal_mass: f64,
    tangent_mass: f64,
    equalized_mass: f64,
    velocity_bias: f64,
}

impl ContactConstraintPoint {
    fn new() -> Self {
        Self {
            local_point: Vec2::ZERO,
            r_a: Vec2::ZERO,
            r_b: Vec2::ZERO,
            normal_impulse: 0.0,
            tangent_impulse: 0.0,
            normal_mass: 0.0,
            tangent_mass: 0.0,
            equalized_mass: 0.0,
            velocity_bias: 0.0,
        }
    }
}

#[derive(Clone, Debug)]
struct ContactConstraint {
    body_a: BodyId,
    body_b: BodyId,
    normal: Vec2,
    point_count: usize,
    points: [ContactConstraintPoint; B2_MAX_MANIFOLD_POINTS],
    friction: f64,
    restitution: f64,
    local_plane_normal: Vec2,
    local_point: Vec2,
    radius: f64,
    manifold_type: i32,
    k: Mat22,
    normal_mass: Mat22,
}

impl ContactConstraint {
    fn new() -> Self {
        Self {
            body_a: 0,
            body_b: 0,
            normal: Vec2::ZERO,
            point_count: 0,
            points: [ContactConstraintPoint::new(), ContactConstraintPoint::new()],
            friction: 0.0,
            restitution: 0.0,
            local_plane_normal: Vec2::ZERO,
            local_point: Vec2::ZERO,
            radius: 0.0,
            manifold_type: 0,
            k: Mat22::identity(),
            normal_mass: Mat22::identity(),
        }
    }
}

#[derive(Debug)]
pub struct World {
    gravity: Vec2,
    #[allow(dead_code)]
    allow_sleep: bool,
    bodies: Vec<Body>,
    fixtures: Vec<Fixture>,
    contacts: Vec<Contact>,
    new_fixtures: bool,
    inv_dt0: f64,
    warm_starting: bool,
}

impl World {
    pub fn new(gravity: (f64, f64), do_sleep: bool) -> Self {
        Self {
            gravity: Vec2::new(gravity.0, gravity.1),
            allow_sleep: do_sleep,
            bodies: Vec::new(),
            fixtures: Vec::new(),
            contacts: Vec::new(),
            new_fixtures: false,
            inv_dt0: 0.0,
            warm_starting: true,
        }
    }

    pub fn create_body(&mut self, def: BodyDef) -> BodyId {
        let id = self.bodies.len();
        let mut body = Body {
            flags: 0,
            body_type: def.body_type,
            xf: Transform {
                position: def.position,
                r: Mat22::identity(),
            },
            sweep: Sweep::new(),
            linear_velocity: def.linear_velocity,
            angular_velocity: def.angular_velocity,
            force: Vec2::ZERO,
            torque: 0.0,
            mass: 0.0,
            inv_mass: 0.0,
            i: 0.0,
            inv_i: 0.0,
            inertia_scale: def.inertia_scale,
            linear_damping: def.linear_damping,
            angular_damping: def.angular_damping,
            fixture_ids: Vec::new(),
            sleep_time: 0.0,
        };
        if def.bullet {
            body.flags |= BODY_E_BULLET_FLAG;
        }
        if def.fixed_rotation {
            body.flags |= BODY_E_FIXED_ROTATION_FLAG;
        }
        if def.allow_sleep {
            body.flags |= BODY_E_ALLOW_SLEEP_FLAG;
        }
        if def.awake {
            body.flags |= BODY_E_AWAKE_FLAG;
        }
        if def.active {
            body.flags |= BODY_E_ACTIVE_FLAG;
        }
        body.xf.r.set(def.angle);
        body.sweep.local_center.set_zero();
        body.sweep.t0 = 1.0;
        body.sweep.a0 = def.angle;
        body.sweep.a = def.angle;
        body.sweep.c = b2_mul_x(&body.xf, &body.sweep.local_center);
        body.sweep.c0 = body.sweep.c;
        if body.body_type == B2_DYNAMIC_BODY {
            body.mass = 1.0;
            body.inv_mass = 1.0;
        }
        self.bodies.push(body);
        id
    }

    pub fn create_fixture(&mut self, body_id: BodyId, def: FixtureDef) -> FixtureId {
        let shape = def
            .shape
            .clone()
            .expect("FixtureDef.shape must be set before creating a fixture");
        let xf = self.bodies[body_id].xf;
        let aabb = shape.compute_aabb(&xf);
        let fixture_id = self.fixtures.len();
        self.fixtures.push(Fixture {
            shape,
            friction: def.friction,
            restitution: def.restitution,
            density: def.density,
            is_sensor: def.is_sensor,
            body: body_id,
            aabb,
        });
        self.bodies[body_id].fixture_ids.push(fixture_id);
        if def.density > 0.0 {
            self.reset_body_mass_data(body_id);
        }
        self.new_fixtures = true;
        fixture_id
    }

    fn reset_body_mass_data(&mut self, body_id: BodyId) {
        let fixture_ids = self.bodies[body_id].fixture_ids.clone();
        let body = &mut self.bodies[body_id];

        body.mass = 0.0;
        body.inv_mass = 0.0;
        body.i = 0.0;
        body.inv_i = 0.0;
        body.sweep.local_center.set_zero();

        if body.body_type != B2_STATIC_BODY && body.body_type != B2_KINEMATIC_BODY {
            let mut local_center = Vec2::ZERO;
            let mut mass = 0.0;
            let mut inertia = 0.0;
            for fid in fixture_ids {
                let fixture = &self.fixtures[fid];
                if fixture.density == 0.0 {
                    continue;
                }
                let (fm, fc, fi) = fixture.shape.compute_mass(fixture.density);
                mass += fm;
                local_center.x += fc.x * fm;
                local_center.y += fc.y * fm;
                inertia += fi;
            }
            if mass > 0.0 {
                body.inv_mass = 1.0 / mass;
                local_center.x *= body.inv_mass;
                local_center.y *= body.inv_mass;
            } else {
                body.mass = 1.0;
                body.inv_mass = 1.0;
            }
            if inertia > 0.0 && !body.is_fixed_rotation() {
                inertia -=
                    mass * (local_center.x * local_center.x + local_center.y * local_center.y);
                inertia *= body.inertia_scale;
                body.inv_i = 1.0 / inertia;
                body.i = inertia;
            } else {
                body.i = 0.0;
                body.inv_i = 0.0;
            }
            body.mass = mass;
            let old_c = body.sweep.c;
            body.sweep.local_center = local_center;
            body.sweep.c0 = b2_mul_x(&body.xf, &body.sweep.local_center);
            body.sweep.c = body.sweep.c0;
            body.linear_velocity.x += body.angular_velocity * -(body.sweep.c.y - old_c.y);
            body.linear_velocity.y += body.angular_velocity * (body.sweep.c.x - old_c.x);
        }
    }

    pub fn body_position(&self, body: BodyId) -> (f64, f64) {
        (
            self.bodies[body].xf.position.x,
            self.bodies[body].xf.position.y,
        )
    }

    pub fn body_angle(&self, body: BodyId) -> f64 {
        self.bodies[body].sweep.a
    }

    pub fn body_linear_velocity(&self, body: BodyId) -> (f64, f64) {
        let v = &self.bodies[body].linear_velocity;
        (v.x, v.y)
    }

    pub fn body_angular_velocity(&self, body: BodyId) -> f64 {
        self.bodies[body].angular_velocity
    }

    pub fn set_body_linear_velocity(&mut self, body: BodyId, v: (f64, f64)) {
        if self.bodies[body].body_type != B2_STATIC_BODY {
            self.bodies[body].linear_velocity = Vec2::new(v.0, v.1);
        }
    }

    pub fn set_body_angular_velocity(&mut self, body: BodyId, w: f64) {
        if self.bodies[body].body_type != B2_STATIC_BODY {
            self.bodies[body].angular_velocity = w;
        }
    }
}

impl World {
    pub fn step(&mut self, dt: f64, velocity_iterations: u32, position_iterations: u32) {
        self.update_fixture_aabbs();
        if self.new_fixtures {
            self.find_new_contacts();
            self.new_fixtures = false;
        }

        let step = TimeStep {
            dt,
            inv_dt: if dt > 0.0 { 1.0 / dt } else { 0.0 },
            velocity_iterations,
            position_iterations,
            warm_starting: self.warm_starting,
            dt_ratio: self.inv_dt0 * dt,
        };

        self.collide();

        if dt > 0.0 {
            self.solve(&step);
            self.inv_dt0 = step.inv_dt;
            self.update_fixture_aabbs();
            self.find_new_contacts();
        }
    }

    fn update_fixture_aabbs(&mut self) {
        let n = self.fixtures.len();
        for i in 0..n {
            let body_id = self.fixtures[i].body;
            let xf = self.bodies[body_id].xf;
            let aabb = self.fixtures[i].shape.compute_aabb(&xf);
            self.fixtures[i].aabb = aabb;
        }
    }

    fn should_collide(&self, body_a: BodyId, body_b: BodyId) -> bool {
        if self.bodies[body_a].body_type != B2_DYNAMIC_BODY
            && self.bodies[body_b].body_type != B2_DYNAMIC_BODY
        {
            return false;
        }
        true
    }

    fn find_new_contacts(&mut self) {
        let fixture_count = self.fixtures.len();
        for i in 0..fixture_count {
            for j in i + 1..fixture_count {
                if self.fixtures[i].body == self.fixtures[j].body {
                    continue;
                }
                let body_a = self.fixtures[i].body;
                let body_b = self.fixtures[j].body;
                if !self.should_collide(body_a, body_b) {
                    continue;
                }
                if !self.fixtures[i].aabb.test_overlap(&self.fixtures[j].aabb) {
                    continue;
                }
                let (fa, fb) = orient_pair(i, j, &self.fixtures);
                if self
                    .contacts
                    .iter()
                    .any(|c| c.fixture_a == fa && c.fixture_b == fb)
                {
                    continue;
                }
                self.contacts.push(Contact::new(fa, fb));
            }
        }
    }

    fn collide(&mut self) {
        let mut remove = Vec::new();
        for idx in 0..self.contacts.len() {
            let fa = self.contacts[idx].fixture_a;
            let fb = self.contacts[idx].fixture_b;
            let body_a = self.fixtures[fa].body;
            let body_b = self.fixtures[fb].body;
            if !self.should_collide(body_a, body_b) {
                remove.push(idx);
                continue;
            }
            if !self.fixtures[fa].aabb.test_overlap(&self.fixtures[fb].aabb) {
                remove.push(idx);
                continue;
            }
            self.update_contact(idx);
        }
        for idx in remove.into_iter().rev() {
            self.contacts.remove(idx);
        }
    }

    fn update_contact(&mut self, contact_idx: usize) {
        let fa = self.contacts[contact_idx].fixture_a;
        let fb = self.contacts[contact_idx].fixture_b;

        let (shape_a, xf_a, shape_b, xf_b);
        {
            let fixture_a = &self.fixtures[fa];
            let body_a = fixture_a.body;
            shape_a = fixture_a.shape.clone();
            xf_a = self.bodies[body_a].xf;
            let fixture_b = &self.fixtures[fb];
            let body_b = fixture_b.body;
            shape_b = fixture_b.shape.clone();
            xf_b = self.bodies[body_b].xf;
        }

        let contact = &mut self.contacts[contact_idx];
        let mut old = Manifold::new();
        std::mem::swap(&mut contact.manifold, &mut old);
        contact.old_manifold = old.clone();

        evaluate_manifold(&shape_a, &xf_a, &shape_b, &xf_b, &mut contact.manifold);

        for i in 0..contact.manifold.point_count {
            contact.manifold.points[i].normal_impulse = 0.0;
            contact.manifold.points[i].tangent_impulse = 0.0;
            let new_id = contact.manifold.points[i].id.key;
            for j in 0..contact.old_manifold.point_count {
                if contact.old_manifold.points[j].id.key == new_id {
                    contact.manifold.points[i].normal_impulse =
                        contact.old_manifold.points[j].normal_impulse;
                    contact.manifold.points[i].tangent_impulse =
                        contact.old_manifold.points[j].tangent_impulse;
                    break;
                }
            }
        }
        contact.touching = contact.manifold.point_count > 0;
    }
}

fn orient_pair(i: FixtureId, j: FixtureId, fixtures: &[Fixture]) -> (FixtureId, FixtureId) {
    let type_i = fixtures[i].shape.get_type();
    let type_j = fixtures[j].shape.get_type();
    if type_i == SHAPE_POLYGON && type_j == SHAPE_CIRCLE {
        (i, j)
    } else if type_i == SHAPE_CIRCLE && type_j == SHAPE_POLYGON {
        (j, i)
    } else {
        (i, j)
    }
}

fn evaluate_manifold(
    shape_a: &Shape,
    xf_a: &Transform,
    shape_b: &Shape,
    xf_b: &Transform,
    manifold: &mut Manifold,
) {
    match (shape_a, shape_b) {
        (Shape::Polygon(poly_a), Shape::Polygon(poly_b)) => {
            collide_polygons(manifold, poly_a, xf_a, poly_b, xf_b);
        }
        (Shape::Polygon(poly_a), Shape::Circle(circle_b)) => {
            collide_polygon_and_circle(manifold, poly_a, xf_a, circle_b, xf_b);
        }
        (Shape::Circle(circle_a), Shape::Polygon(poly_b)) => {
            // The contact factory in JS swaps circle/polygon pairs so the
            // polygon is always fixture A.  This branch is only a safety net.
            collide_polygon_and_circle(manifold, poly_b, xf_b, circle_a, xf_a);
        }
        _ => {
            manifold.point_count = 0;
        }
    }
}

impl World {
    fn solve(&mut self, step: &TimeStep) {
        // Integrate forces and damping (exact JS b2Island.Solve order).
        for body in self.bodies.iter_mut() {
            if body.body_type == B2_DYNAMIC_BODY {
                body.linear_velocity.x += step.dt * (self.gravity.x + body.inv_mass * body.force.x);
                body.linear_velocity.y += step.dt * (self.gravity.y + body.inv_mass * body.force.y);
                body.angular_velocity += step.dt * body.inv_i * body.torque;
                let lin_damp = b2_clamp(1.0 - step.dt * body.linear_damping, 0.0, 1.0);
                body.linear_velocity.x *= lin_damp;
                body.linear_velocity.y *= lin_damp;
                body.angular_velocity *= b2_clamp(1.0 - step.dt * body.angular_damping, 0.0, 1.0);
            }
        }

        // Build contact constraints for touching contacts.
        let mut constraints: Vec<(usize, ContactConstraint)> = Vec::new();
        for (ci, contact) in self.contacts.iter().enumerate() {
            if contact.manifold.point_count == 0 {
                continue;
            }
            let constraint = self.build_constraint(ci);
            constraints.push((ci, constraint));
        }

        // Velocity solver uses local body velocities so we can mutate two
        // bodies in one constraint without borrow conflicts.
        let mut vels: Vec<BodyVelocity> = self
            .bodies
            .iter()
            .map(|b| BodyVelocity {
                v: b.linear_velocity,
                w: b.angular_velocity,
                inv_mass: b.inv_mass,
                inv_i: b.inv_i,
            })
            .collect();

        init_velocity_constraints(step, &mut vels, &mut constraints);

        for _ in 0..step.velocity_iterations {
            solve_velocity_constraints(&mut vels, &mut constraints);
        }

        // Write velocities back.
        for (idx, body) in self.bodies.iter_mut().enumerate() {
            body.linear_velocity = vels[idx].v;
            body.angular_velocity = vels[idx].w;
        }

        // Finalize impulses back to contacts.
        for (ci, constraint) in constraints.iter() {
            let manifold = &mut self.contacts[*ci].manifold;
            for j in 0..constraint.point_count {
                manifold.points[j].normal_impulse = constraint.points[j].normal_impulse;
                manifold.points[j].tangent_impulse = constraint.points[j].tangent_impulse;
            }
        }

        // Integrate positions.
        for body in self.bodies.iter_mut() {
            if body.body_type == B2_STATIC_BODY {
                continue;
            }
            let mut v = body.linear_velocity;
            let mut w = body.angular_velocity;
            let dt_v = step.dt * v.x;
            let dt_vy = step.dt * v.y;
            if dt_v * dt_v + dt_vy * dt_vy > B2_MAX_TRANSLATION_SQUARED {
                let len = v.normalize();
                v.x *= B2_MAX_TRANSLATION * step.inv_dt;
                v.y *= B2_MAX_TRANSLATION * step.inv_dt;
                let _ = len;
            }
            let dt_w = step.dt * w;
            if dt_w * dt_w > B2_MAX_ROTATION_SQUARED {
                if w < 0.0 {
                    w = -B2_MAX_ROTATION * step.inv_dt;
                } else {
                    w = B2_MAX_ROTATION * step.inv_dt;
                }
            }
            body.sweep.c0 = body.sweep.c;
            body.sweep.a0 = body.sweep.a;
            body.sweep.c.x += step.dt * v.x;
            body.sweep.c.y += step.dt * v.y;
            body.sweep.a += step.dt * w;
            body.linear_velocity = v;
            body.angular_velocity = w;
            body.synchronize_transform();
        }

        // Position iterations.
        for _ in 0..step.position_iterations {
            let contacts_ok = self.solve_position_constraints(&constraints);
            if contacts_ok {
                break;
            }
        }
    }

    fn build_constraint(&self, contact_idx: usize) -> ContactConstraint {
        let contact = &self.contacts[contact_idx];
        let fixture_a = &self.fixtures[contact.fixture_a];
        let fixture_b = &self.fixtures[contact.fixture_b];
        let body_a = fixture_a.body;
        let body_b = fixture_b.body;
        let b_a = &self.bodies[body_a];
        let b_b = &self.bodies[body_b];
        let manifold = &contact.manifold;

        let friction = (fixture_a.friction * fixture_b.friction).sqrt();
        let restitution = fixture_a.restitution.max(fixture_b.restitution);

        let mut world_manifold = WorldManifold::new();
        world_manifold.initialize(
            manifold,
            &b_a.xf,
            fixture_a.shape.radius(),
            &b_b.xf,
            fixture_b.shape.radius(),
        );

        let mut c = ContactConstraint::new();
        c.body_a = body_a;
        c.body_b = body_b;
        c.normal = world_manifold.normal;
        c.point_count = manifold.point_count;
        c.friction = friction;
        c.restitution = restitution;
        c.local_plane_normal = manifold.local_plane_normal;
        c.local_point = manifold.local_point;
        c.radius = fixture_a.shape.radius() + fixture_b.shape.radius();
        c.manifold_type = manifold.manifold_type;

        let normal = c.normal;
        for j in 0..c.point_count {
            let mp = &manifold.points[j];
            let cp = &mut c.points[j];
            cp.normal_impulse = mp.normal_impulse;
            cp.tangent_impulse = mp.tangent_impulse;
            cp.local_point = mp.local_point;
            cp.r_a = b2_sub_vv(&world_manifold.points[j], &b_a.sweep.c);
            cp.r_b = b2_sub_vv(&world_manifold.points[j], &b_b.sweep.c);

            let rn_a = b2_cross_vv(&cp.r_a, &normal);
            let rn_b = b2_cross_vv(&cp.r_b, &normal);
            let kn =
                b_a.inv_mass + b_b.inv_mass + b_a.inv_i * rn_a * rn_a + b_b.inv_i * rn_b * rn_b;
            cp.normal_mass = 1.0 / kn;

            let k_mass = b_a.mass * b_a.inv_mass
                + b_b.mass * b_b.inv_mass
                + b_a.mass * b_a.inv_i * rn_a * rn_a
                + b_b.mass * b_b.inv_i * rn_b * rn_b;
            cp.equalized_mass = 1.0 / k_mass;

            // Tangent vector is (normal.y, -normal.x) in this Box2D revision.
            let rt_a = b2_cross_vv(&cp.r_a, &Vec2::new(normal.y, -normal.x));
            let rt_b = b2_cross_vv(&cp.r_b, &Vec2::new(normal.y, -normal.x));
            let kt =
                b_a.inv_mass + b_b.inv_mass + b_a.inv_i * rt_a * rt_a + b_b.inv_i * rt_b * rt_b;
            cp.tangent_mass = 1.0 / kt;
            cp.velocity_bias = 0.0;

            let rel_vx =
                b_b.linear_velocity.x - b_b.angular_velocity * cp.r_b.y - b_a.linear_velocity.x
                    + b_a.angular_velocity * cp.r_a.y;
            let rel_vy = b_b.linear_velocity.y + b_b.angular_velocity * cp.r_b.x
                - b_a.linear_velocity.y
                - b_a.angular_velocity * cp.r_a.x;
            let vn = c.normal.x * rel_vx + c.normal.y * rel_vy;
            if vn < -B2_VELOCITY_THRESHOLD {
                cp.velocity_bias += -c.restitution * vn;
            }
        }

        if c.point_count == 2 {
            let p1 = &c.points[0];
            let p2 = &c.points[1];
            let inv_mass_a = b_a.inv_mass;
            let inv_i_a = b_a.inv_i;
            let inv_mass_b = b_b.inv_mass;
            let inv_i_b = b_b.inv_i;
            let rn_a1 = b2_cross_vv(&p1.r_a, &c.normal);
            let rn_b1 = b2_cross_vv(&p1.r_b, &c.normal);
            let rn_a2 = b2_cross_vv(&p2.r_a, &c.normal);
            let rn_b2 = b2_cross_vv(&p2.r_b, &c.normal);
            let k11 = inv_mass_a + inv_mass_b + inv_i_a * rn_a1 * rn_a1 + inv_i_b * rn_b1 * rn_b1;
            let k12 = inv_mass_a + inv_mass_b + inv_i_a * rn_a1 * rn_a2 + inv_i_b * rn_b1 * rn_b2;
            let k22 = inv_mass_a + inv_mass_b + inv_i_a * rn_a2 * rn_a2 + inv_i_b * rn_b2 * rn_b2;
            if k11 * k11 < 100.0 * (k11 * k22 - k12 * k12) {
                c.k = Mat22 {
                    col1: Vec2::new(k11, k12),
                    col2: Vec2::new(k12, k22),
                };
                c.normal_mass = c.k.get_inverse();
            } else {
                c.point_count = 1;
            }
        }
        c
    }
}

fn init_velocity_constraints(
    step: &TimeStep,
    vels: &mut [BodyVelocity],
    constraints: &mut [(usize, ContactConstraint)],
) {
    for (_, c) in constraints.iter_mut() {
        let normal = c.normal;
        let tangent = Vec2::new(normal.y, -normal.x);
        for j in 0..c.point_count {
            let cp = &mut c.points[j];
            if step.warm_starting {
                cp.normal_impulse *= step.dt_ratio;
                cp.tangent_impulse *= step.dt_ratio;
                let px = cp.normal_impulse * normal.x + cp.tangent_impulse * tangent.x;
                let py = cp.normal_impulse * normal.y + cp.tangent_impulse * tangent.y;
                let va = &mut vels[c.body_a];
                va.v.x -= va.inv_mass * px;
                va.v.y -= va.inv_mass * py;
                va.w -= va.inv_i * (cp.r_a.x * py - cp.r_a.y * px);
                let vb = &mut vels[c.body_b];
                vb.v.x += vb.inv_mass * px;
                vb.v.y += vb.inv_mass * py;
                vb.w += vb.inv_i * (cp.r_b.x * py - cp.r_b.y * px);
            } else {
                cp.normal_impulse = 0.0;
                cp.tangent_impulse = 0.0;
            }
        }
    }
}

fn solve_velocity_constraints(
    vels: &mut [BodyVelocity],
    constraints: &mut [(usize, ContactConstraint)],
) {
    for (_, c) in constraints.iter_mut() {
        let normal = c.normal;
        let tangent = Vec2::new(normal.y, -normal.x);
        let friction = c.friction;

        // Friction impulses, one point at a time (JS order).
        for j in 0..c.point_count {
            let cp = &mut c.points[j];
            let (mut va_v, mut va_w, va_inv_mass, va_inv_i) = {
                let va = &vels[c.body_a];
                (va.v, va.w, va.inv_mass, va.inv_i)
            };
            let (mut vb_v, mut vb_w, vb_inv_mass, vb_inv_i) = {
                let vb = &vels[c.body_b];
                (vb.v, vb.w, vb.inv_mass, vb.inv_i)
            };
            let dvx = vb_v.x - vb_w * cp.r_b.y - va_v.x + va_w * cp.r_a.y;
            let dvy = vb_v.y + vb_w * cp.r_b.x - va_v.y - va_w * cp.r_a.x;
            let vt = dvx * tangent.x + dvy * tangent.y;
            let lambda = cp.tangent_mass * -vt;
            let max_friction = friction * cp.normal_impulse;
            let new_impulse = b2_clamp(cp.tangent_impulse + lambda, -max_friction, max_friction);
            let delta = new_impulse - cp.tangent_impulse;
            let px = delta * tangent.x;
            let py = delta * tangent.y;
            va_v.x -= va_inv_mass * px;
            va_v.y -= va_inv_mass * py;
            va_w -= va_inv_i * (cp.r_a.x * py - cp.r_a.y * px);
            vb_v.x += vb_inv_mass * px;
            vb_v.y += vb_inv_mass * py;
            vb_w += vb_inv_i * (cp.r_b.x * py - cp.r_b.y * px);
            cp.tangent_impulse = new_impulse;

            {
                let va = &mut vels[c.body_a];
                va.v = va_v;
                va.w = va_w;
            }
            {
                let vb = &mut vels[c.body_b];
                vb.v = vb_v;
                vb.w = vb_w;
            }
        }

        // Normal impulses.
        if c.point_count == 1 {
            let cp = &mut c.points[0];
            let (mut va_v, mut va_w, va_inv_mass, va_inv_i) = {
                let va = &vels[c.body_a];
                (va.v, va.w, va.inv_mass, va.inv_i)
            };
            let (mut vb_v, mut vb_w, vb_inv_mass, vb_inv_i) = {
                let vb = &vels[c.body_b];
                (vb.v, vb.w, vb.inv_mass, vb.inv_i)
            };
            let dvx = vb_v.x - vb_w * cp.r_b.y - va_v.x + va_w * cp.r_a.y;
            let dvy = vb_v.y + vb_w * cp.r_b.x - va_v.y - va_w * cp.r_a.x;
            let vn = dvx * normal.x + dvy * normal.y;
            let lambda = -cp.normal_mass * (vn - cp.velocity_bias);
            let new_impulse = (cp.normal_impulse + lambda).max(0.0);
            let delta = new_impulse - cp.normal_impulse;
            let px = delta * normal.x;
            let py = delta * normal.y;
            va_v.x -= va_inv_mass * px;
            va_v.y -= va_inv_mass * py;
            va_w -= va_inv_i * (cp.r_a.x * py - cp.r_a.y * px);
            vb_v.x += vb_inv_mass * px;
            vb_v.y += vb_inv_mass * py;
            vb_w += vb_inv_i * (cp.r_b.x * py - cp.r_b.y * px);
            cp.normal_impulse = new_impulse;

            {
                let va = &mut vels[c.body_a];
                va.v = va_v;
                va.w = va_w;
            }
            {
                let vb = &mut vels[c.body_b];
                vb.v = vb_v;
                vb.w = vb_w;
            }
        } else if c.point_count == 2 {
            let (va_v, va_w, va_inv_mass, va_inv_i) = {
                let va = &vels[c.body_a];
                (va.v, va.w, va.inv_mass, va.inv_i)
            };
            let (vb_v, vb_w, vb_inv_mass, vb_inv_i) = {
                let vb = &vels[c.body_b];
                (vb.v, vb.w, vb.inv_mass, vb.inv_i)
            };
            let p1 = &c.points[0];
            let p2 = &c.points[1];
            let vn1 = (vb_v.x - vb_w * p1.r_b.y - va_v.x + va_w * p1.r_a.y) * normal.x
                + (vb_v.y + vb_w * p1.r_b.x - va_v.y - va_w * p1.r_a.x) * normal.y;
            let vn2 = (vb_v.x - vb_w * p2.r_b.y - va_v.x + va_w * p2.r_a.y) * normal.x
                + (vb_v.y + vb_w * p2.r_b.x - va_v.y - va_w * p2.r_a.x) * normal.y;
            let mut x1 = vn1 - p1.velocity_bias;
            let mut x2 = vn2 - p2.velocity_bias;
            x1 -= c.k.col1.x * p1.normal_impulse + c.k.col2.x * p2.normal_impulse;
            x2 -= c.k.col1.y * p1.normal_impulse + c.k.col2.y * p2.normal_impulse;

            let mut impulse1;
            let mut impulse2;
            loop {
                impulse1 = -(c.normal_mass.col1.x * x1 + c.normal_mass.col2.x * x2);
                impulse2 = -(c.normal_mass.col1.y * x1 + c.normal_mass.col2.y * x2);
                if impulse1 >= 0.0 && impulse2 >= 0.0 {
                    break;
                }
                impulse1 = -p1.normal_mass * x1;
                impulse2 = 0.0;
                let v1 = c.k.col1.y * impulse1 + x2;
                if impulse1 >= 0.0 && v1 >= 0.0 {
                    break;
                }
                impulse1 = 0.0;
                impulse2 = -p2.normal_mass * x2;
                let v2 = c.k.col2.x * impulse2 + x1;
                if impulse2 >= 0.0 && v2 >= 0.0 {
                    break;
                }
                impulse1 = 0.0;
                impulse2 = 0.0;
                break;
            }

            let d1 = impulse1 - p1.normal_impulse;
            let d2 = impulse2 - p2.normal_impulse;
            let px = d1 * normal.x + d2 * normal.x;
            let py = d1 * normal.y + d2 * normal.y;
            let mut va_v = va_v;
            let mut va_w = va_w;
            let mut vb_v = vb_v;
            let mut vb_w = vb_w;
            va_v.x -= va_inv_mass * px;
            va_v.y -= va_inv_mass * py;
            va_w -= va_inv_i
                * (p1.r_a.x * (d1 * normal.y) - p1.r_a.y * (d1 * normal.x)
                    + p2.r_a.x * (d2 * normal.y)
                    - p2.r_a.y * (d2 * normal.x));
            vb_v.x += vb_inv_mass * px;
            vb_v.y += vb_inv_mass * py;
            vb_w += vb_inv_i
                * (p1.r_b.x * (d1 * normal.y) - p1.r_b.y * (d1 * normal.x)
                    + p2.r_b.x * (d2 * normal.y)
                    - p2.r_b.y * (d2 * normal.x));
            c.points[0].normal_impulse = impulse1;
            c.points[1].normal_impulse = impulse2;

            {
                let va = &mut vels[c.body_a];
                va.v = va_v;
                va.w = va_w;
            }
            {
                let vb = &mut vels[c.body_b];
                vb.v = vb_v;
                vb.w = vb_w;
            }
        }
    }
}

impl World {
    fn solve_position_constraints(&mut self, constraints: &[(usize, ContactConstraint)]) -> bool {
        let mut min_separation = 0.0f64;
        for (_, c) in constraints.iter() {
            let body_a = c.body_a;
            let body_b = c.body_b;
            let (normal, points, separations) = position_solver_manifold(c, &self.bodies);

            let mass_a = self.bodies[body_a].mass * self.bodies[body_a].inv_mass;
            let inertia_a = self.bodies[body_a].mass * self.bodies[body_a].inv_i;
            let mass_b = self.bodies[body_b].mass * self.bodies[body_b].inv_mass;
            let inertia_b = self.bodies[body_b].mass * self.bodies[body_b].inv_i;

            for j in 0..c.point_count {
                let point = points[j];
                let separation = separations[j];
                min_separation = min_separation.min(separation);

                let impulse = b2_clamp(
                    B2_CONTACT_BAUMGARTE * (separation + B2_LINEAR_SLOP),
                    -B2_MAX_LINEAR_CORRECTION,
                    0.0,
                );
                let lambda = -c.points[j].equalized_mass * impulse;
                let px = lambda * normal.x;
                let py = lambda * normal.y;

                let ra = b2_sub_vv(&point, &self.bodies[body_a].sweep.c);
                let rb = b2_sub_vv(&point, &self.bodies[body_b].sweep.c);

                let (ba, bb) = body_pair_mut(&mut self.bodies, body_a, body_b);
                ba.sweep.c.x -= mass_a * px;
                ba.sweep.c.y -= mass_a * py;
                ba.sweep.a -= inertia_a * (ra.x * py - ra.y * px);
                ba.synchronize_transform();

                bb.sweep.c.x += mass_b * px;
                bb.sweep.c.y += mass_b * py;
                bb.sweep.a += inertia_b * (rb.x * py - rb.y * px);
                bb.synchronize_transform();
            }
        }
        min_separation > -1.5 * B2_LINEAR_SLOP
    }
}

fn position_solver_manifold(
    c: &ContactConstraint,
    bodies: &[Body],
) -> (
    Vec2,
    [Vec2; B2_MAX_MANIFOLD_POINTS],
    [f64; B2_MAX_MANIFOLD_POINTS],
) {
    let mut normal = Vec2::ZERO;
    let mut points = [Vec2::ZERO; B2_MAX_MANIFOLD_POINTS];
    let mut separations = [0.0f64; B2_MAX_MANIFOLD_POINTS];

    let body_a = &bodies[c.body_a];
    let body_b = &bodies[c.body_b];

    match c.manifold_type {
        MANIFOLD_E_CIRCLES => {
            let p_a = b2_mul_x(&body_a.xf, &c.local_point);
            let p_b = b2_mul_x(&body_b.xf, &c.points[0].local_point);
            let d = b2_sub_vv(&p_b, &p_a);
            let len_sq = d.length_squared();
            if len_sq > JS_NUMBER_MIN_VALUE * JS_NUMBER_MIN_VALUE {
                let len = b2_sqrt(len_sq);
                normal.x = d.x / len;
                normal.y = d.y / len;
            } else {
                normal.x = 1.0;
                normal.y = 0.0;
            }
            points[0] = b2_mul_fv(0.5, &b2_add_vv(&p_a, &p_b));
            separations[0] = b2_dot(&d, &normal) - c.radius;
        }
        MANIFOLD_E_FACE_A => {
            normal = b2_mul_mv(&body_a.xf.r, &c.local_plane_normal);
            let plane_point = b2_mul_x(&body_a.xf, &c.local_point);
            for i in 0..c.point_count {
                let clip_point = b2_mul_x(&body_b.xf, &c.points[i].local_point);
                separations[i] = (clip_point.x - plane_point.x) * normal.x
                    + (clip_point.y - plane_point.y) * normal.y
                    - c.radius;
                points[i] = clip_point;
            }
        }
        MANIFOLD_E_FACE_B => {
            normal = b2_mul_mv(&body_b.xf.r, &c.local_plane_normal);
            let plane_point = b2_mul_x(&body_b.xf, &c.local_point);
            for i in 0..c.point_count {
                let clip_point = b2_mul_x(&body_a.xf, &c.points[i].local_point);
                separations[i] = (clip_point.x - plane_point.x) * normal.x
                    + (clip_point.y - plane_point.y) * normal.y
                    - c.radius;
                points[i] = clip_point;
            }
            normal.x *= -1.0;
            normal.y *= -1.0;
        }
        _ => {}
    }
    (normal, points, separations)
}

fn body_pair_mut(bodies: &mut [Body], i: usize, j: usize) -> (&mut Body, &mut Body) {
    assert_ne!(i, j);
    if i < j {
        let (left, right) = bodies.split_at_mut(j);
        (&mut left[i], &mut right[0])
    } else {
        let (left, right) = bodies.split_at_mut(i);
        (&mut right[0], &mut left[j])
    }
}

impl Body {
    pub fn create(world: &mut World, def: BodyDef) -> BodyId {
        world.create_body(def)
    }

    pub fn create_fixture(world: &mut World, body: BodyId, def: FixtureDef) -> FixtureId {
        world.create_fixture(body, def)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dynamic_box(
        world: &mut World,
        pos: (f64, f64),
        angle: f64,
        vel: (f64, f64),
        angular_vel: f64,
        half_w: f64,
        half_h: f64,
    ) -> BodyId {
        let mut bd = BodyDef::new();
        bd.body_type = B2_DYNAMIC_BODY;
        bd.position = Vec2::new(pos.0, pos.1);
        bd.angle = angle;
        bd.linear_velocity = Vec2::new(vel.0, vel.1);
        bd.angular_velocity = angular_vel;
        let body = Body::create(world, bd);
        let mut fd = FixtureDef::new();
        fd.shape = Some(Shape::Polygon(PolygonShape::set_as_box(half_w, half_h)));
        fd.density = 1.0;
        fd.friction = 0.3;
        Body::create_fixture(world, body, fd);
        body
    }

    fn static_box(world: &mut World, pos: (f64, f64), half_w: f64, half_h: f64) {
        let mut bd = BodyDef::new();
        bd.body_type = B2_STATIC_BODY;
        bd.position = Vec2::new(pos.0, pos.1);
        let body = Body::create(world, bd);
        let mut fd = FixtureDef::new();
        fd.shape = Some(Shape::Polygon(PolygonShape::set_as_box(half_w, half_h)));
        Body::create_fixture(world, body, fd);
    }

    #[test]
    fn free_space_linear_motion_matches_analytic() {
        let mut world = World::new((0.0, 0.0), true);
        let body = dynamic_box(&mut world, (5.0, 5.0), 0.4, (3.0, 1.0), 0.0, 1.5, 2.0);
        for _ in 0..75 {
            world.step(0.02, 10, 10);
        }
        let (x, y) = world.body_position(body);
        assert!((x - (5.0 + 3.0 * 75.0 * 0.02)).abs() < 1e-12);
        assert!((y - (5.0 + 1.0 * 75.0 * 0.02)).abs() < 1e-12);
    }

    #[test]
    fn free_space_angular_velocity_matches_analytic() {
        let mut world = World::new((0.0, 0.0), true);
        let body = dynamic_box(&mut world, (5.0, 5.0), 0.4, (0.0, 0.0), 0.5, 1.5, 2.0);
        for _ in 0..75 {
            world.step(0.02, 10, 10);
        }
        let angle = world.body_angle(body);
        assert!((angle - (0.4 + 0.5 * 75.0 * 0.02)).abs() < 1e-12);
    }

    #[test]
    fn empty_world_step_does_not_panic() {
        let mut world = World::new((0.0, 0.0), true);
        world.step(0.02, 10, 10);
        world.step(0.02, 10, 10);
    }

    #[test]
    fn box_hits_wall_and_stays_outside() {
        let mut world = World::new((0.0, 0.0), true);
        // Wall: inner face at x = 10, centered at x=11 with half width 1.
        static_box(&mut world, (11.0, 5.0), 1.0, 10.0);
        // Box starts at x=8 and moves into the wall.
        let body = dynamic_box(&mut world, (8.0, 5.0), 0.0, (2.0, 0.0), 0.0, 1.5, 2.0);
        for _ in 0..75 {
            world.step(0.02, 10, 10);
        }
        let (x, _y) = world.body_position(body);
        let (vx, _vy) = world.body_linear_velocity(body);
        // The right edge of the box must not cross the wall inner face.
        assert!(x + 1.5 <= 10.0 + 1e-6, "box penetrated wall: x={}", x);
        // The wall solver must have removed the penetrating velocity.
        assert!(vx <= 0.1, "box kept penetrating velocity: vx={}", vx);
    }

    #[test]
    fn circle_hits_wall_and_stays_outside() {
        let mut world = World::new((0.0, 0.0), true);
        static_box(&mut world, (11.0, 5.0), 1.0, 10.0);
        let mut bd = BodyDef::new();
        bd.body_type = B2_DYNAMIC_BODY;
        bd.position = Vec2::new(8.0, 5.0);
        bd.linear_velocity = Vec2::new(2.0, 0.0);
        let body = Body::create(&mut world, bd);
        let mut fd = FixtureDef::new();
        fd.shape = Some(Shape::Circle(CircleShape::new(0.8)));
        fd.density = 1.0;
        fd.friction = 0.3;
        Body::create_fixture(&mut world, body, fd);

        for _ in 0..75 {
            world.step(0.02, 10, 10);
        }
        let (x, _y) = world.body_position(body);
        assert!(x + 0.8 <= 10.0 + 1e-6, "circle penetrated wall: x={}", x);
        let (vx, _vy) = world.body_linear_velocity(body);
        assert!(vx <= 0.1, "circle kept penetrating velocity: vx={}", vx);
    }
}
