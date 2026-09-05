//! Prediction-tree core (phase 2).
//!
//! This module mirrors the pure tree-structure parts of
//! `game_core/js/vantage_tree.js` v68:
//! - `probeSegment`
//! - `buildCandidate`
//! - `attachResults`
//! - `pickBestChildByRolloutTotal`
//! - `commitPathOf`
//! - `routeAvgOfLeaf` / `bestRouteLeafInSubtree`
//! - true-dead helpers and `growStep`
//! - the normal segment-end branch of `commit`
//!
//! The module deliberately contains no tank simulation, no NN and no death
//! decision. All rollout data is supplied through [`RolloutProvider`].

use std::f64::consts::PI;

use crate::scoring::{self, TankPose};

/// Frame duration shared with the JS sandbox / scoring (`FRAME_DT`).
pub const FRAME_DT: f64 = 0.02;
/// Evaluation depth used by the JS tree (`EVAL_FRAMES`, default 75).
pub const EVAL_FRAMES: usize = 75;

/// Tank pose used by tree nodes. Reuses the scoring pose so tree does not
/// define a duplicate type.
pub type Pose = TankPose;

// ---------------------------------------------------------------------------
// 1. Data structures
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct NodeId(pub usize);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Inputs {
    pub forward: bool,
    pub back: bool,
    pub left: bool,
    pub right: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Operation {
    pub name: String,
    pub inputs: Inputs,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Sample {
    pub t: f64,
    pub x: f64,
    pub y: f64,
    pub rot: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SimState {
    pub tank: Pose,
    pub t_global: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NodeStatus {
    Pending,
    Alive,
    Dead,
}

impl NodeStatus {
    pub fn is_dead(self) -> bool {
        self == NodeStatus::Dead
    }
}

#[derive(Debug, Clone)]
pub struct Node {
    pub id: NodeId,
    pub parent: Option<NodeId>,
    pub inputs: Inputs,
    pub children: Vec<NodeId>,
    pub sim_state: SimState,
    pub segment_frames: usize,
    pub planned_frames: usize,
    pub segment_score: f64,
    pub base_ext: f64,
    pub rollout_total: f64,
    pub subtree_best: f64,
    pub t_end_sec: f64,
    pub rollout_start_t: f64,
    pub status: NodeStatus,
    pub full_dead: bool,
    pub full_death_frame: i32,
    pub exhausted: bool,
    pub invalid: bool,
    pub next: Option<NodeId>,
    pub rollout_samples: Vec<Sample>,
    /// JS nodes carry `opName`; the spec list omitted it but it is required
    /// for doomed snapshots / events, so it is kept as an extra field.
    pub op_name: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Config {
    pub epsilon: f64,
    pub t_min: usize,
    pub t_max: usize,
    pub horizon_sec: f64,
    pub max_nodes: usize,
    pub lane_penalty_ratio: f64,
    pub spring_rope_enabled: bool,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            epsilon: PI * PI,
            t_min: 3,
            t_max: 30,
            horizon_sec: 8.0,
            max_nodes: 500,
            lane_penalty_ratio: 0.0,
            spring_rope_enabled: false,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TreeStats {
    pub expands: usize,
    pub commits: usize,
    pub retreats: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DoomedSnap {
    pub op_name: String,
    pub t_end_sec: f64,
    pub x: f64,
    pub y: f64,
    pub dead: bool,
}

#[derive(Debug)]
pub struct Tree {
    pub root: NodeId,
    pub commit_node: Option<NodeId>,
    /// Every node ever created in this tree lives here. Detached subtrees are
    /// not removed (ids must stay stable), so the active node count is a DFS
    /// from [`Tree::root`], not `node_storage.len()`.
    pub node_storage: Vec<Node>,
    pub next_id: usize,
    pub root_abs_t: f64,
    pub cfg: Config,
    pub stats: TreeStats,
    /// v68 normal collapse pushes the old-root siblings here (render aid).
    pub doomed_snaps: Vec<DoomedSnap>,
    /// Small event log used by true-dead retreat and commit diagnostics.
    pub events: Vec<String>,
}

/// Rollout provider abstraction. The tree never simulates tanks or decides
/// death; it only consumes these results.
pub trait RolloutProvider {
    fn rollouts(
        &mut self,
        sim_state: &SimState,
        operations: &[Operation],
        threats: &[scoring::Threat],
        frames: usize,
    ) -> Vec<RolloutResult>;
}

#[derive(Debug, Clone, PartialEq)]
pub struct RolloutResult {
    pub total_score: f64,
    pub dead: bool,
    pub death_frame: i32,
    pub per_frame_scores: Vec<f64>,
    pub samples: Vec<Sample>,
    pub op_index: usize,
    pub op_name: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProbeResult {
    pub segment_frames: usize,
    pub t_div: i32,
    pub t_div_found: bool,
    pub spread_curve: Vec<f64>,
    pub spread_peak: f64,
    pub evaluated_frames: usize,
    pub cum: Option<Vec<Vec<f64>>>,
    pub epsilon: f64,
    pub t_min: usize,
    pub t_max: usize,
}

/// The nine JS `VantageSandbox.OPERATIONS`.
pub fn standard_operations() -> Vec<Operation> {
    vec![
        Operation {
            name: "静止".to_string(),
            inputs: Inputs {
                forward: false,
                back: false,
                left: false,
                right: false,
            },
        },
        Operation {
            name: "前".to_string(),
            inputs: Inputs {
                forward: true,
                back: false,
                left: false,
                right: false,
            },
        },
        Operation {
            name: "后".to_string(),
            inputs: Inputs {
                forward: false,
                back: true,
                left: false,
                right: false,
            },
        },
        Operation {
            name: "左".to_string(),
            inputs: Inputs {
                forward: false,
                back: false,
                left: true,
                right: false,
            },
        },
        Operation {
            name: "右".to_string(),
            inputs: Inputs {
                forward: false,
                back: false,
                left: false,
                right: true,
            },
        },
        Operation {
            name: "前左".to_string(),
            inputs: Inputs {
                forward: true,
                back: false,
                left: true,
                right: false,
            },
        },
        Operation {
            name: "前右".to_string(),
            inputs: Inputs {
                forward: true,
                back: false,
                left: false,
                right: true,
            },
        },
        Operation {
            name: "后左".to_string(),
            inputs: Inputs {
                forward: false,
                back: true,
                left: true,
                right: false,
            },
        },
        Operation {
            name: "后右".to_string(),
            inputs: Inputs {
                forward: false,
                back: true,
                left: false,
                right: true,
            },
        },
    ]
}

// ---------------------------------------------------------------------------
// 2. Tree construction helpers
// ---------------------------------------------------------------------------

impl Tree {
    pub fn new(root_pose: Pose) -> Self {
        Self::new_with_config(root_pose, Config::default())
    }

    pub fn new_with_config(root_pose: Pose, cfg: Config) -> Self {
        let mut storage = Vec::new();
        storage.push(Node {
            id: NodeId(0),
            parent: None,
            inputs: Inputs::default(),
            children: Vec::new(),
            sim_state: SimState {
                tank: root_pose,
                t_global: 0.0,
            },
            segment_frames: 0,
            planned_frames: 0,
            segment_score: 0.0,
            base_ext: 0.0,
            rollout_total: 0.0,
            subtree_best: 0.0,
            t_end_sec: 0.0,
            rollout_start_t: 0.0,
            status: NodeStatus::Alive,
            full_dead: false,
            full_death_frame: -1,
            exhausted: false,
            invalid: false,
            next: None,
            rollout_samples: Vec::new(),
            op_name: String::new(),
        });
        Self {
            root: NodeId(0),
            commit_node: None,
            node_storage: storage,
            next_id: 1,
            root_abs_t: 0.0,
            cfg,
            stats: TreeStats::default(),
            doomed_snaps: Vec::new(),
            events: Vec::new(),
        }
    }
}

/// Number of nodes reachable from `tree.root` (JS `tree.nodeCount`).
pub fn active_node_count(tree: &Tree) -> usize {
    fn dfs(tree: &Tree, nid: NodeId) -> usize {
        let mut n = 1;
        let children = tree.node_storage[nid.0].children.clone();
        for cid in children {
            n += dfs(tree, cid);
        }
        n
    }
    dfs(tree, tree.root)
}

fn planned_frames_of(n: &Node) -> usize {
    let raw = if n.planned_frames > 0 {
        n.planned_frames
    } else if n.segment_frames > 0 {
        n.segment_frames
    } else {
        0
    };
    raw.max(1)
}

fn backprop_best(tree: &mut Tree, start: NodeId) {
    let mut p = Some(start);
    while let Some(pid) = p {
        let children = tree.node_storage[pid.0].children.clone();
        let mut best = f64::NEG_INFINITY;
        for cid in children {
            let c = &tree.node_storage[cid.0];
            if c.exhausted || c.invalid {
                continue;
            }
            if c.subtree_best > best {
                best = c.subtree_best;
            }
        }
        let ext = if best > f64::NEG_INFINITY { best } else { 0.0 };
        let parent_id = tree.node_storage[pid.0].parent;
        {
            let pn = &mut tree.node_storage[pid.0];
            let next = pn.segment_score + ext.max(pn.base_ext);
            if pn.subtree_best == next {
                break;
            }
            pn.subtree_best = next;
        }
        p = parent_id;
    }
}

fn detach_child(tree: &mut Tree, child_id: NodeId) {
    let parent_id = match tree.node_storage[child_id.0].parent {
        Some(p) => p,
        None => return,
    };
    if let Some(pos) = tree.node_storage[parent_id.0]
        .children
        .iter()
        .position(|&c| c == child_id)
    {
        tree.node_storage[parent_id.0].children.remove(pos);
    }
    tree.node_storage[child_id.0].parent = None;
    backprop_best(tree, parent_id);
}

// ---------------------------------------------------------------------------
// 3. probeSegment
// ---------------------------------------------------------------------------

pub fn probe_segment(results: &[RolloutResult]) -> ProbeResult {
    probe_segment_with_cfg(results, &Config::default())
}

fn probe_segment_with_cfg(results: &[RolloutResult], cfg: &Config) -> ProbeResult {
    let mut evaluated_frames = 0usize;
    for r in results {
        evaluated_frames = evaluated_frames.max(r.per_frame_scores.len());
    }

    if evaluated_frames == 0 {
        return ProbeResult {
            segment_frames: cfg.t_max,
            t_div: -1,
            t_div_found: false,
            spread_curve: Vec::new(),
            spread_peak: 0.0,
            evaluated_frames: 0,
            cum: None,
            epsilon: cfg.epsilon,
            t_min: cfg.t_min,
            t_max: cfg.t_max,
        };
    }

    let mut cum: Vec<Vec<f64>> = Vec::with_capacity(results.len());
    for r in results {
        let mut row = vec![0.0; evaluated_frames + 1];
        for k in 1..=evaluated_frames {
            let prev = row[k - 1];
            row[k] = prev + r.per_frame_scores.get(k - 1).copied().unwrap_or(0.0);
        }
        cum.push(row);
    }

    let mut spread_curve = vec![0.0; evaluated_frames + 1];
    let mut t_div = -1i32;
    let mut t_div_found = false;
    let mut spread_peak = 0.0f64;

    for k in 1..=evaluated_frames {
        let mut mx = f64::NEG_INFINITY;
        let mut mn = f64::INFINITY;
        for row in &cum {
            mx = mx.max(row[k]);
            mn = mn.min(row[k]);
        }
        let sp = mx - mn;
        spread_curve[k] = sp;
        if sp > spread_peak {
            spread_peak = sp;
        }
        if !t_div_found && sp > cfg.epsilon {
            t_div = k as i32;
            t_div_found = true;
        }
    }

    let seg_src = if t_div_found {
        t_div as usize
    } else {
        evaluated_frames
    };
    let segment_frames = seg_src.clamp(cfg.t_min, cfg.t_max);

    ProbeResult {
        segment_frames,
        t_div,
        t_div_found,
        spread_curve,
        spread_peak,
        evaluated_frames,
        cum: Some(cum),
        epsilon: cfg.epsilon,
        t_min: cfg.t_min,
        t_max: cfg.t_max,
    }
}

// ---------------------------------------------------------------------------
// 4. buildCandidate / attachResults
// ---------------------------------------------------------------------------

pub fn build_candidate(
    tree: &mut Tree,
    parent_id: NodeId,
    op_idx: usize,
    result: &RolloutResult,
    probe: &ProbeResult,
) -> NodeId {
    let ops = standard_operations();
    let op = &ops[op_idx];

    let seg_f = probe.segment_frames;
    let mut actual_end = seg_f;
    if result.dead {
        if result.death_frame == 1 {
            actual_end = 1;
        } else if result.death_frame >= 2 {
            actual_end = (result.death_frame as usize - 1).min(seg_f);
        }
    }
    let child_dead = result.dead && result.death_frame >= 0 && result.death_frame <= seg_f as i32;

    let (parent_t_global, parent_tank) = {
        let p = &tree.node_storage[parent_id.0];
        (p.sim_state.t_global, p.sim_state.tank)
    };

    let sample = result
        .samples
        .get(actual_end)
        .copied()
        .or_else(|| result.samples.last().copied())
        .unwrap_or(Sample {
            t: parent_t_global,
            x: parent_tank.x,
            y: parent_tank.y,
            rot: parent_tank.rot,
        });

    let child_state = SimState {
        tank: Pose::new(sample.x, sample.y, sample.rot),
        t_global: parent_t_global + actual_end as f64 * FRAME_DT,
    };

    let segment_score = match &probe.cum {
        Some(cum) => {
            let row = &cum[op_idx];
            let idx = actual_end.min(row.len() - 1);
            row[idx]
        }
        None => result.total_score,
    };

    let base_ext = result.total_score - segment_score;
    let rollout_total = result.total_score;
    let subtree_best = segment_score + base_ext.max(0.0);
    let status = if child_dead {
        NodeStatus::Dead
    } else {
        NodeStatus::Alive
    };
    let full_death_frame = if result.dead { result.death_frame } else { -1 };

    let id = NodeId(tree.next_id);
    tree.next_id += 1;

    let child = Node {
        id,
        parent: Some(parent_id),
        inputs: op.inputs,
        children: Vec::new(),
        sim_state: child_state.clone(),
        segment_frames: actual_end,
        planned_frames: seg_f,
        segment_score,
        base_ext,
        rollout_total,
        subtree_best,
        t_end_sec: tree.root_abs_t + child_state.t_global,
        rollout_start_t: parent_t_global,
        status,
        full_dead: result.dead,
        full_death_frame,
        exhausted: false,
        invalid: false,
        next: None,
        rollout_samples: result.samples.clone(),
        op_name: op.name.clone(),
    };
    tree.node_storage.push(child);
    tree.node_storage[parent_id.0].children.push(id);
    backprop_best(tree, parent_id);
    id
}

pub fn attach_results(tree: &mut Tree, leaf_id: NodeId, results: &[RolloutResult]) -> usize {
    {
        let leaf = &tree.node_storage[leaf_id.0];
        if leaf.status.is_dead() || !leaf.children.is_empty() {
            return 0;
        }
    }
    if active_node_count(tree) + results.len() > tree.cfg.max_nodes {
        return 0;
    }

    let probe = probe_segment_with_cfg(results, &tree.cfg);
    let mut new_kids = Vec::with_capacity(results.len());
    for (i, result) in results.iter().enumerate() {
        let kid = build_candidate(tree, leaf_id, i, result, &probe);
        new_kids.push(kid);
    }

    let best = pick_best_child_by_rollout_total(tree, &new_kids);
    tree.node_storage[leaf_id.0].next = best;
    tree.stats.expands += 1;
    results.len()
}

pub fn pick_best_child_by_rollout_total(tree: &Tree, children: &[NodeId]) -> Option<NodeId> {
    let mut any_active = false;
    let mut all_true_dead = true;
    for &cid in children {
        let c = &tree.node_storage[cid.0];
        if c.exhausted || c.invalid {
            continue;
        }
        any_active = true;
        if c.full_death_frame != 1 {
            all_true_dead = false;
            break;
        }
    }
    if !any_active {
        all_true_dead = false;
    }

    let mut best: Option<NodeId> = None;
    let mut best_total = f64::NEG_INFINITY;

    for &cid in children {
        let c = &tree.node_storage[cid.0];
        if c.exhausted || c.invalid {
            continue;
        }
        if !all_true_dead && c.full_death_frame == 1 {
            continue;
        }
        let total = c.rollout_total;
        if best.is_none() || total > best_total {
            best = Some(cid);
            best_total = total;
            continue;
        }
        if total == best_total {
            let b = best.unwrap();
            let bnode = &tree.node_storage[b.0];
            let c_dead = c.status.is_dead();
            let b_dead = bnode.status.is_dead();
            if c_dead != b_dead {
                if !c_dead {
                    best = Some(cid);
                    best_total = total;
                }
                continue;
            }
            if c_dead && c.segment_frames > bnode.segment_frames {
                best = Some(cid);
                best_total = total;
                continue;
            }
            if cid.0 < b.0 {
                best = Some(cid);
                best_total = total;
            }
        }
    }
    best
}

// ---------------------------------------------------------------------------
// 5. Path / route helpers
// ---------------------------------------------------------------------------

fn pick_best_subtree(tree: &Tree, children: &[NodeId]) -> Option<NodeId> {
    let mut any_active = false;
    let mut only_immediate_dead = true;
    for &cid in children {
        let c = &tree.node_storage[cid.0];
        if c.exhausted || c.invalid {
            continue;
        }
        any_active = true;
        if c.full_death_frame != 1 {
            only_immediate_dead = false;
            break;
        }
    }
    if !any_active {
        only_immediate_dead = false;
    }

    let mut best: Option<NodeId> = None;
    for &cid in children {
        let c = &tree.node_storage[cid.0];
        if c.exhausted || c.invalid {
            continue;
        }
        if !only_immediate_dead && c.full_death_frame == 1 {
            continue;
        }
        if best.is_none() || c.subtree_best > tree.node_storage[best.unwrap().0].subtree_best {
            best = Some(cid);
            continue;
        }
        if c.subtree_best == tree.node_storage[best.unwrap().0].subtree_best {
            let b = best.unwrap();
            let bnode = &tree.node_storage[b.0];
            let c_dead = c.status.is_dead();
            let b_dead = bnode.status.is_dead();
            if c_dead != b_dead {
                if !c_dead {
                    best = Some(cid);
                }
                continue;
            }
            if c_dead && c.segment_frames > bnode.segment_frames {
                best = Some(cid);
            }
        }
    }
    best
}

fn pick_route_child(tree: &Tree, children: &[NodeId]) -> Option<NodeId> {
    let mut alive = Vec::new();
    for &cid in children {
        let c = &tree.node_storage[cid.0];
        if !c.exhausted && !c.invalid && c.status == NodeStatus::Alive {
            alive.push(cid);
        }
    }
    if alive.is_empty() {
        None
    } else {
        pick_best_subtree(tree, &alive)
    }
}

pub fn commit_path_of(tree: &Tree, root_id: NodeId, commit_node_id: Option<NodeId>) -> Vec<NodeId> {
    let mut path = vec![root_id];
    let mut n = root_id;

    {
        let node = &tree.node_storage[n.0];
        if !node.children.is_empty() {
            let children = node.children.clone();
            let mut first = None;

            if let Some(cn) = commit_node_id {
                if children.contains(&cn) {
                    let c = &tree.node_storage[cn.0];
                    if !c.exhausted && !c.invalid {
                        first = Some(cn);
                    }
                }
            }

            if first.is_none() {
                if let Some(nx) = node.next {
                    if children.contains(&nx) {
                        let c = &tree.node_storage[nx.0];
                        if !c.exhausted && !c.invalid {
                            first = Some(nx);
                        }
                    }
                }
            }

            if first.is_none() {
                first = pick_route_child(tree, &children);
            }

            if let Some(f) = first {
                path.push(f);
                n = f;
            }
        }
    }

    while let Some(nx) = tree.node_storage[n.0].next {
        let parent_ok = tree.node_storage[nx.0].parent == Some(n);
        let child_ok = tree.node_storage[n.0].children.contains(&nx);
        let state = &tree.node_storage[nx.0];
        if parent_ok && child_ok && !state.exhausted && !state.invalid {
            path.push(nx);
            n = nx;
        } else {
            break;
        }
    }

    path
}

pub fn route_avg_of_leaf(tree: &Tree, leaf_id: NodeId) -> f64 {
    let mut sum_score = 0.0;
    let mut sum_frames = 0usize;
    let mut n = leaf_id;
    while n != tree.root {
        let node = &tree.node_storage[n.0];
        sum_score += node.segment_score;
        sum_frames += planned_frames_of(node);
        match node.parent {
            Some(p) => n = p,
            None => break,
        }
    }
    if sum_frames > 0 {
        sum_score / sum_frames as f64
    } else {
        f64::NEG_INFINITY
    }
}

pub fn best_route_leaf_in_subtree(tree: &Tree, node_id: NodeId) -> Option<NodeId> {
    fn dfs(tree: &Tree, nid: NodeId, best_leaf: &mut Option<NodeId>, best_avg: &mut f64) {
        let n = &tree.node_storage[nid.0];
        if n.exhausted || n.invalid {
            return;
        }
        if n.children.is_empty() {
            let avg = route_avg_of_leaf(tree, nid);
            if avg > *best_avg {
                *best_avg = avg;
                *best_leaf = Some(nid);
            }
            return;
        }
        let children = n.children.clone();
        for cid in children {
            dfs(tree, cid, best_leaf, best_avg);
        }
    }

    let mut best_leaf = None;
    let mut best_avg = f64::NEG_INFINITY;
    dfs(tree, node_id, &mut best_leaf, &mut best_avg);
    best_leaf
}

// ---------------------------------------------------------------------------
// 6. True-dead retreat / growth
// ---------------------------------------------------------------------------

pub fn is_true_dead_node(tree: &Tree, node_id: NodeId) -> bool {
    let node = &tree.node_storage[node_id.0];
    if node.children.is_empty() {
        return false;
    }
    let mut any_active = false;
    for &cid in &node.children {
        let c = &tree.node_storage[cid.0];
        if c.exhausted || c.invalid {
            continue;
        }
        any_active = true;
        if !(c.full_death_frame >= 0 && c.full_death_frame <= 1) {
            return false;
        }
    }
    any_active
}

pub fn pick_retreat_leaf(tree: &Tree, dead_id: NodeId) -> Option<NodeId> {
    let mut a = dead_id;
    for _ in 0..3 {
        let parent = tree.node_storage[a.0].parent;
        if parent.is_none() || a == tree.root {
            a = tree.root;
            break;
        }
        a = parent.unwrap();
    }

    loop {
        let children = tree.node_storage[a.0].children.clone();
        let mut best_leaf: Option<NodeId> = None;
        let mut best_avg = f64::NEG_INFINITY;
        let mut best_time = f64::INFINITY;
        let mut best_id = usize::MAX;

        for &kid in &children {
            if let Some(leaf) = best_route_leaf_in_subtree(tree, kid) {
                let avg = route_avg_of_leaf(tree, leaf);
                let time =
                    tree.node_storage[leaf.0].t_end_sec - tree.node_storage[tree.root.0].t_end_sec;
                if best_leaf.is_none()
                    || avg > best_avg
                    || (avg == best_avg
                        && (time < best_time || (time == best_time && leaf.0 < best_id)))
                {
                    best_leaf = Some(leaf);
                    best_avg = avg;
                    best_time = time;
                    best_id = leaf.0;
                }
            }
        }

        if best_leaf.is_some() {
            return best_leaf;
        }
        if a == tree.root {
            return None;
        }
        match tree.node_storage[a.0].parent {
            Some(p) => {
                a = p;
            }
            None => return None,
        }
    }
}

pub fn apply_retreat_after_expand(tree: &mut Tree, leaf_id: NodeId) -> Option<NodeId> {
    let parent = match tree.node_storage[leaf_id.0].parent {
        Some(p) => p,
        None => return None,
    };
    if tree.node_storage[leaf_id.0].children.is_empty() {
        return None;
    }
    if !is_true_dead_node(tree, leaf_id) {
        return None;
    }

    tree.node_storage[leaf_id.0].exhausted = true;
    tree.stats.retreats += 1;
    tree.events
        .push(format!("true-dead-retreat leaf={}", leaf_id.0));
    backprop_best(tree, parent);

    let rt = pick_retreat_leaf(tree, leaf_id);
    if let Some(target) = rt {
        tree.events.push(format!(
            "retreat-depth leaf={} target={}",
            leaf_id.0, target.0
        ));
    }
    rt
}

fn is_optional_node(tree: &Tree, nid: NodeId) -> bool {
    let n = &tree.node_storage[nid.0];
    !n.invalid && !n.exhausted
}

fn is_growable_leaf(tree: &Tree, nid: NodeId) -> bool {
    let n = &tree.node_storage[nid.0];
    if n.status.is_dead() || n.exhausted || n.invalid || !n.children.is_empty() {
        return false;
    }
    let root_t_end = tree.node_storage[tree.root.0].t_end_sec;
    n.t_end_sec - root_t_end < tree.cfg.horizon_sec
}

fn collect_growable_leaves(tree: &Tree, nid: NodeId, out: &mut Vec<NodeId>) {
    let n = &tree.node_storage[nid.0];
    if n.exhausted || n.invalid || n.status.is_dead() {
        return;
    }
    if is_growable_leaf(tree, nid) {
        out.push(nid);
        return;
    }
    let children = n.children.clone();
    for cid in children {
        collect_growable_leaves(tree, cid, out);
    }
}

fn time_depth_of(tree: &Tree, nid: NodeId) -> f64 {
    tree.node_storage[nid.0].t_end_sec - tree.node_storage[tree.root.0].t_end_sec
}

fn pick_best_grow_leaf(tree: &Tree, candidates: &[NodeId]) -> Option<NodeId> {
    let mut best: Option<NodeId> = None;
    let mut best_avg = f64::NEG_INFINITY;

    for &leaf in candidates {
        if !is_growable_leaf(tree, leaf) {
            continue;
        }
        let avg = route_avg_of_leaf(tree, leaf);
        if best.is_none() || avg > best_avg {
            best = Some(leaf);
            best_avg = avg;
            continue;
        }
        if avg == best_avg {
            let b = best.unwrap();
            let d_leaf = time_depth_of(tree, leaf);
            let d_best = time_depth_of(tree, b);
            if d_leaf < d_best {
                best = Some(leaf);
                best_avg = avg;
                continue;
            }
            if d_leaf == d_best && leaf.0 < b.0 {
                best = Some(leaf);
                best_avg = avg;
            }
        }
    }
    best
}

pub fn pick_grow_leaf(tree: &Tree) -> Option<NodeId> {
    let path = commit_path_of(tree, tree.root, tree.commit_node);
    let tip = *path.last().expect("commit path is never empty");
    let root_t_end = tree.node_storage[tree.root.0].t_end_sec;

    let tip_stop = {
        let t = &tree.node_storage[tip.0];
        t.status != NodeStatus::Dead
            && !t.exhausted
            && !t.invalid
            && t.children.is_empty()
            && t.t_end_sec - root_t_end >= tree.cfg.horizon_sec
    };
    if tip_stop {
        return None;
    }

    for &p in &path {
        if is_growable_leaf(tree, p) {
            return Some(p);
        }
    }

    let tip_status = tree.node_storage[tip.0].status;
    if !is_optional_node(tree, tip) || tip_status.is_dead() {
        if let Some(rt) = pick_retreat_leaf(tree, tip) {
            return Some(rt);
        }
        return None;
    }

    let mut candidates = Vec::new();
    collect_growable_leaves(tree, tree.root, &mut candidates);
    pick_best_grow_leaf(tree, &candidates)
}

pub fn grow_step(
    tree: &mut Tree,
    provider: &mut dyn RolloutProvider,
    threats: &[scoring::Threat],
) -> usize {
    let active = active_node_count(tree);
    if active >= tree.cfg.max_nodes || active + standard_operations().len() > tree.cfg.max_nodes {
        tree.events.push("grow-maxnodes".to_string());
        return 0;
    }

    let leaf = match pick_grow_leaf(tree) {
        Some(l) => l,
        None => {
            tree.events.push("grow-no-leaf".to_string());
            return 0;
        }
    };

    let sim = tree.node_storage[leaf.0].sim_state.clone();
    let ops = standard_operations();
    let results = provider.rollouts(&sim, &ops, threats, EVAL_FRAMES);
    let added = attach_results(tree, leaf, &results);
    if added > 0 {
        apply_retreat_after_expand(tree, leaf);
    }
    added
}

// ---------------------------------------------------------------------------
// 7. Commit (normal segment-end branch only)
// ---------------------------------------------------------------------------

pub fn recompute_next_for_children(tree: &mut Tree, parent_id: NodeId) -> Option<NodeId> {
    let children = tree.node_storage[parent_id.0].children.clone();
    let best = pick_best_child_by_rollout_total(tree, &children);
    tree.node_storage[parent_id.0].next = best;
    best
}

fn norm_rot(a: f64) -> f64 {
    a.sin().atan2(a.cos())
}

fn shift_subtree_time(tree: &mut Tree, old_root_tg: f64) -> usize {
    if old_root_tg <= 0.0 {
        return 0;
    }
    let mut stack = vec![tree.root];
    let mut count = 0usize;
    while let Some(nid) = stack.pop() {
        let children = tree.node_storage[nid.0].children.clone();
        for cid in children {
            let c = &mut tree.node_storage[cid.0];
            c.sim_state.t_global = (c.sim_state.t_global - old_root_tg).max(0.0);
            c.rollout_start_t = (c.rollout_start_t - old_root_tg).max(0.0);
            c.t_end_sec = tree.root_abs_t + c.sim_state.t_global;
            count += 1;
            stack.push(cid);
        }
    }
    count
}

fn rebase_subtree_rigid(tree: &mut Tree, old_pose: Pose, new_pose: Pose) -> usize {
    let dx = new_pose.x - old_pose.x;
    let dy = new_pose.y - old_pose.y;
    let dr = norm_rot(new_pose.rot - old_pose.rot);
    if dx.abs() < 1e-6 && dy.abs() < 1e-6 && dr.abs() < 1e-6 {
        return 0;
    }
    let cos = dr.cos();
    let sin = dr.sin();
    let mut count = 0usize;

    fn tx_xy(x: f64, y: f64, old_pose: Pose, new_pose: Pose, cos: f64, sin: f64) -> (f64, f64) {
        let ox = x - old_pose.x;
        let oy = y - old_pose.y;
        (
            new_pose.x + ox * cos - oy * sin,
            new_pose.y + ox * sin + oy * cos,
        )
    }

    let root_children = tree.node_storage[tree.root.0].children.clone();
    let mut stack = root_children;
    while let Some(nid) = stack.pop() {
        let node = &mut tree.node_storage[nid.0];
        let t = node.sim_state.tank;
        let (nx, ny) = tx_xy(t.x, t.y, old_pose, new_pose, cos, sin);
        node.sim_state.tank.x = nx;
        node.sim_state.tank.y = ny;
        node.sim_state.tank.rot = norm_rot(t.rot + dr);
        for s in &mut node.rollout_samples {
            let (sx, sy) = tx_xy(s.x, s.y, old_pose, new_pose, cos, sin);
            s.x = sx;
            s.y = sy;
            s.rot = norm_rot(s.rot + dr);
        }
        count += 1;
        let children = node.children.clone();
        stack.extend(children);
    }

    for ds in &mut tree.doomed_snaps {
        let (nx, ny) = tx_xy(ds.x, ds.y, old_pose, new_pose, cos, sin);
        ds.x = nx;
        ds.y = ny;
    }
    count
}

pub fn commit(
    tree: &mut Tree,
    provider: &mut dyn RolloutProvider,
    threats: &[scoring::Threat],
    real_pose: Pose,
    results_opt: Option<&[RolloutResult]>,
) -> bool {
    let prev_id = match tree.commit_node {
        Some(id) => id,
        None => {
            tree.events.push(
                "commit-skip: no commit_node (fresh-root branch not implemented)".to_string(),
            );
            return false;
        }
    };

    if tree.node_storage[prev_id.0].parent != Some(tree.root) {
        tree.events.push(
            "commit-skip: prev.parent is not root (fresh-root branch not implemented)".to_string(),
        );
        return false;
    }

    let root_id = tree.root;
    let old_root_abs_t = tree.root_abs_t;
    tree.doomed_snaps.clear();
    tree.events.push(format!("commit prev={}", prev_id.0));

    // Old-root siblings (all except prev) enter the doomed snapshot.
    let siblings = tree.node_storage[root_id.0].children.clone();
    for sib in siblings {
        if sib == prev_id {
            continue;
        }
        let (op_name, t_end, x, y, dead) = {
            let n = &tree.node_storage[sib.0];
            (
                n.op_name.clone(),
                n.t_end_sec,
                n.sim_state.tank.x,
                n.sim_state.tank.y,
                n.status.is_dead(),
            )
        };
        tree.doomed_snaps.push(DoomedSnap {
            op_name,
            t_end_sec: t_end,
            x,
            y,
            dead,
        });
        detach_child(tree, sib);
    }

    let (prev_old_t_global, old_prev_tank, has_kids) = {
        let p = &tree.node_storage[prev_id.0];
        (
            p.sim_state.t_global,
            p.sim_state.tank,
            !p.children.is_empty(),
        )
    };
    let new_root_abs_t = old_root_abs_t + prev_old_t_global;

    // Promote prev to root and align root to the real pose.
    tree.root = prev_id;
    tree.root_abs_t = new_root_abs_t;
    {
        let r = &mut tree.node_storage[prev_id.0];
        r.parent = None;
        r.sim_state = SimState {
            tank: real_pose,
            t_global: 0.0,
        };
        r.t_end_sec = new_root_abs_t;
    }

    // Keep the old prev subtree; remount its relative time axis and rigidly
    // rebase its poses onto the real root pose (JS v42/v45 normal branch).
    if has_kids && prev_old_t_global > 0.0 {
        shift_subtree_time(tree, prev_old_t_global);
    }
    if has_kids {
        rebase_subtree_rigid(tree, old_prev_tank, real_pose);
    }

    // If prev was a leaf, build the new root layer from the real pose.
    if !has_kids {
        let attached = if let Some(res) = results_opt {
            if !res.is_empty() {
                attach_results(tree, prev_id, res)
            } else {
                let sim = tree.node_storage[prev_id.0].sim_state.clone();
                let ops = standard_operations();
                let generated = provider.rollouts(&sim, &ops, threats, EVAL_FRAMES);
                attach_results(tree, prev_id, &generated)
            }
        } else {
            let sim = tree.node_storage[prev_id.0].sim_state.clone();
            let ops = standard_operations();
            let generated = provider.rollouts(&sim, &ops, threats, EVAL_FRAMES);
            attach_results(tree, prev_id, &generated)
        };
        if attached == 0 {
            tree.events.push("commit attach-failed".to_string());
            return false;
        }
    }

    recompute_next_for_children(tree, prev_id);

    // Follow prev.next unless invalid / exhausted / fd==1.
    let root_children = tree.node_storage[prev_id.0].children.clone();
    let next_id = tree.node_storage[prev_id.0].next;
    let mut keep: Option<NodeId> = None;

    if let Some(nx) = next_id {
        if root_children.contains(&nx) {
            let n = &tree.node_storage[nx.0];
            if !n.exhausted && !n.invalid && n.full_death_frame != 1 {
                keep = Some(nx);
            }
        }
    }

    // Fallback: best route-avg leaf among the other children's subtrees.
    if keep.is_none() {
        let mut best_child: Option<NodeId> = None;
        let mut best_avg = f64::NEG_INFINITY;
        let mut best_time = f64::INFINITY;
        let mut best_leaf_id = usize::MAX;

        for &bc in &root_children {
            if Some(bc) == next_id {
                continue;
            }
            {
                let n = &tree.node_storage[bc.0];
                if n.exhausted || n.invalid {
                    continue;
                }
            }
            if let Some(leaf) = best_route_leaf_in_subtree(tree, bc) {
                let avg = route_avg_of_leaf(tree, leaf);
                let time = time_depth_of(tree, leaf);
                if best_child.is_none()
                    || avg > best_avg
                    || (avg == best_avg
                        && (time < best_time || (time == best_time && leaf.0 < best_leaf_id)))
                {
                    best_child = Some(bc);
                    best_avg = avg;
                    best_time = time;
                    best_leaf_id = leaf.0;
                }
            }
        }
        keep = best_child;
    }

    // Root-layer reselect: rebuild the current root layer from the real pose.
    if keep.is_none() {
        tree.events.push("root-layer-reselect".to_string());
        let root_children = tree.node_storage[prev_id.0].children.clone();
        for c in root_children {
            detach_child(tree, c);
        }

        let sim = tree.node_storage[prev_id.0].sim_state.clone();
        let ops = standard_operations();
        let generated;
        let res_slice: &[RolloutResult] = if let Some(res) = results_opt {
            if !res.is_empty() {
                res
            } else {
                generated = provider.rollouts(&sim, &ops, threats, EVAL_FRAMES);
                &generated
            }
        } else {
            generated = provider.rollouts(&sim, &ops, threats, EVAL_FRAMES);
            &generated
        };

        if attach_results(tree, prev_id, res_slice) == 0 {
            return false;
        }
        keep =
            pick_best_child_by_rollout_total(tree, &tree.node_storage[prev_id.0].children.clone());
        if keep.is_none() {
            return false;
        }
    }

    tree.commit_node = keep;
    tree.stats.commits += 1;
    tree.events.push(
        "reserve/reuse not implemented: unselected root children remain attached".to_string(),
    );
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pose(x: f64, y: f64, rot: f64) -> Pose {
        Pose::new(x, y, rot)
    }

    fn sample_at(k: usize) -> Sample {
        Sample {
            t: k as f64 * FRAME_DT,
            x: k as f64,
            y: 0.0,
            rot: 0.0,
        }
    }

    fn make_result(
        op_idx: usize,
        op_name: String,
        total_score: f64,
        per_frame_scores: Vec<f64>,
        dead: bool,
        death_frame: i32,
    ) -> RolloutResult {
        let frames = per_frame_scores.len();
        RolloutResult {
            total_score,
            dead,
            death_frame,
            per_frame_scores,
            samples: (0..=frames).map(sample_at).collect(),
            op_index: op_idx,
            op_name,
        }
    }

    fn alive_results() -> Vec<RolloutResult> {
        let ops = standard_operations();
        ops.iter()
            .enumerate()
            .map(|(i, op)| {
                make_result(
                    i,
                    op.name.clone(),
                    (i as f64 + 1.0) * 10.0,
                    vec![0.0; EVAL_FRAMES],
                    false,
                    -1,
                )
            })
            .collect()
    }

    struct FakeProvider {
        results: Vec<RolloutResult>,
        sim_state_seen: Option<SimState>,
        frames_seen: Option<usize>,
    }

    impl FakeProvider {
        fn new() -> Self {
            Self {
                results: Vec::new(),
                sim_state_seen: None,
                frames_seen: None,
            }
        }
    }

    impl RolloutProvider for FakeProvider {
        fn rollouts(
            &mut self,
            sim_state: &SimState,
            operations: &[Operation],
            _threats: &[scoring::Threat],
            frames: usize,
        ) -> Vec<RolloutResult> {
            self.sim_state_seen = Some(sim_state.clone());
            self.frames_seen = Some(frames);
            if self.results.is_empty() {
                operations
                    .iter()
                    .enumerate()
                    .map(|(i, op)| {
                        make_result(
                            i,
                            op.name.clone(),
                            (i as f64 + 1.0) * 10.0,
                            vec![0.0; frames],
                            false,
                            -1,
                        )
                    })
                    .collect()
            } else {
                self.results.clone()
            }
        }
    }

    fn probe_for_segment(seg: usize) -> ProbeResult {
        ProbeResult {
            segment_frames: seg,
            t_div: -1,
            t_div_found: false,
            spread_curve: Vec::new(),
            spread_peak: 0.0,
            evaluated_frames: seg,
            cum: Some(vec![vec![0.0; seg + 1]; 9]),
            epsilon: PI * PI,
            t_min: 3,
            t_max: 30,
        }
    }

    #[test]
    fn probe_segment_all_same_returns_t_max() {
        let results = vec![
            make_result(0, "a".into(), 75.0, vec![1.0; 75], false, -1),
            make_result(1, "b".into(), 75.0, vec![1.0; 75], false, -1),
        ];
        let p = probe_segment(&results);
        assert_eq!(p.evaluated_frames, 75);
        assert!(!p.t_div_found);
        assert_eq!(p.t_div, -1);
        assert_eq!(p.segment_frames, 30);
        assert_eq!(p.spread_curve.len(), 76);
        assert_eq!(p.spread_peak, 0.0);
    }

    #[test]
    fn probe_segment_divergence_clamps() {
        let scores_a = vec![0.0; 75];
        let mut scores_b = vec![0.0; 75];
        scores_b[4] = 100.0; // divergence at frame 5
        let results = vec![
            make_result(0, "a".into(), 0.0, scores_a, false, -1),
            make_result(1, "b".into(), 100.0, scores_b, false, -1),
        ];
        let p = probe_segment(&results);
        assert!(p.t_div_found);
        assert_eq!(p.t_div, 5);
        assert_eq!(p.segment_frames, 5);

        // Divergence at frame 1 is clamped up to t_min.
        let mut scores_c = vec![0.0; 75];
        scores_c[0] = 100.0;
        let results2 = vec![
            make_result(0, "a".into(), 0.0, vec![0.0; 75], false, -1),
            make_result(1, "b".into(), 100.0, scores_c, false, -1),
        ];
        let p2 = probe_segment(&results2);
        assert_eq!(p2.t_div, 1);
        assert_eq!(p2.segment_frames, 3);
    }

    #[test]
    fn attach_results_picks_highest_rollout_total() {
        let mut tree = Tree::new(pose(0.0, 0.0, 0.0));
        let mut results = alive_results();
        results[3].total_score = 999.0;
        let root = tree.root;
        let added = attach_results(&mut tree, root, &results);
        assert_eq!(added, 9);
        let next = tree.node_storage[0].next.unwrap();
        assert_eq!(tree.node_storage[next.0].rollout_total, 999.0);
        assert_eq!(next.0, 4); // op 3 is id 4
    }

    #[test]
    fn attach_results_skips_fd1_when_survivor_exists() {
        let mut tree = Tree::new(pose(0.0, 0.0, 0.0));
        let mut results = alive_results();
        // fd=1 candidate has the highest total but must be skipped.
        results[0].dead = true;
        results[0].death_frame = 1;
        results[0].total_score = 999.0;
        results[1].total_score = 500.0;
        let root = tree.root;
        let added = attach_results(&mut tree, root, &results);
        assert_eq!(added, 9);
        let next = tree.node_storage[0].next.unwrap();
        assert_eq!(tree.node_storage[next.0].rollout_total, 500.0);
        assert_eq!(tree.node_storage[next.0].full_death_frame, -1);
    }

    #[test]
    fn commit_path_of_follows_commit_then_next_and_truncates_on_invalid() {
        let mut tree = Tree::new(pose(0.0, 0.0, 0.0));
        let root = tree.root;
        attach_results(&mut tree, root, &alive_results());
        let root_children = tree.node_storage[0].children.clone();
        let commit = root_children[2];
        tree.commit_node = Some(commit);
        attach_results(&mut tree, commit, &alive_results());
        let expected_next = tree.node_storage[commit.0].next.unwrap();

        let path = commit_path_of(&tree, tree.root, tree.commit_node);
        assert_eq!(path, vec![tree.root, commit, expected_next]);

        tree.node_storage[expected_next.0].invalid = true;
        let path2 = commit_path_of(&tree, tree.root, tree.commit_node);
        assert_eq!(path2, vec![tree.root, commit]);
    }

    #[test]
    fn build_candidate_death_semantics() {
        let cases = [(1, 1, true), (5, 4, true), (15, 10, false)];
        for (fd, expected_actual, expected_dead_status) in cases {
            let mut tree = Tree::new(pose(0.0, 0.0, 0.0));
            let probe = probe_for_segment(10);
            let result = make_result(0, "前".into(), 100.0, vec![0.0; 10], true, fd);
            let root = tree.root;
            let id = build_candidate(&mut tree, root, 0, &result, &probe);
            let n = &tree.node_storage[id.0];
            assert_eq!(n.planned_frames, 10, "fd={}", fd);
            assert_eq!(n.segment_frames, expected_actual, "fd={}", fd);
            assert_eq!(n.full_death_frame, fd, "fd={}", fd);
            assert_eq!(n.status.is_dead(), expected_dead_status, "fd={}", fd);
            assert!(n.full_dead, "fd={}", fd);
        }
    }

    #[test]
    fn true_dead_marks_exhausted_and_retreats() {
        let mut tree = Tree::new(pose(0.0, 0.0, 0.0));
        let root = tree.root;
        attach_results(&mut tree, root, &alive_results());
        let leaf = tree.node_storage[0].children[0];

        let mut fd1_results = alive_results();
        for r in &mut fd1_results {
            r.dead = true;
            r.death_frame = 1;
        }
        attach_results(&mut tree, leaf, &fd1_results);

        let rt = apply_retreat_after_expand(&mut tree, leaf);
        assert!(tree.node_storage[leaf.0].exhausted);
        assert_eq!(tree.stats.retreats, 1);
        assert!(rt.is_some());
    }

    #[test]
    fn not_true_dead_when_any_fd2() {
        let mut tree = Tree::new(pose(0.0, 0.0, 0.0));
        let root = tree.root;
        attach_results(&mut tree, root, &alive_results());
        let leaf = tree.node_storage[0].children[0];

        let mut mixed_results = alive_results();
        for r in &mut mixed_results {
            r.dead = true;
            r.death_frame = 1;
        }
        mixed_results[4].death_frame = 2;
        attach_results(&mut tree, leaf, &mixed_results);

        let rt = apply_retreat_after_expand(&mut tree, leaf);
        assert!(!tree.node_storage[leaf.0].exhausted);
        assert_eq!(tree.stats.retreats, 0);
        assert!(rt.is_none());
    }

    #[test]
    fn grow_step_builds_nine_children_with_empty_threats() {
        let mut tree = Tree::new(pose(0.0, 0.0, 0.0));
        let mut provider = FakeProvider::new();
        let added = grow_step(&mut tree, &mut provider, &[]);
        assert_eq!(added, 9);
        assert_eq!(active_node_count(&tree), 10);
        assert_eq!(tree.node_storage[0].children.len(), 9);
        for &c in &tree.node_storage[0].children {
            assert_eq!(tree.node_storage[c.0].planned_frames, 30);
        }
        assert!(tree.node_storage[0].next.is_some());
        assert_eq!(provider.frames_seen, Some(EVAL_FRAMES));
    }

    #[test]
    fn commit_follows_next_and_promotes_root() {
        let mut tree = Tree::new(pose(0.0, 0.0, 0.0));
        let root = tree.root;
        attach_results(&mut tree, root, &alive_results());
        let prev = tree.node_storage[0].children[0];
        tree.commit_node = Some(prev);
        attach_results(&mut tree, prev, &alive_results());
        let expected_next = tree.node_storage[prev.0].next.unwrap();

        let real_pose = pose(5.0, 6.0, 1.0);
        let mut provider = FakeProvider::new();
        let ok = commit(&mut tree, &mut provider, &[], real_pose, None);
        assert!(ok);

        assert_eq!(tree.root, prev);
        assert_eq!(tree.node_storage[tree.root.0].sim_state.tank, real_pose);
        assert_eq!(tree.commit_node, Some(expected_next));
        assert_eq!(tree.stats.commits, 1);
        assert_eq!(tree.node_storage[tree.root.0].sim_state.t_global, 0.0);
    }

    #[test]
    fn commit_falls_back_when_next_is_fd1() {
        let mut tree = Tree::new(pose(0.0, 0.0, 0.0));
        let root = tree.root;
        attach_results(&mut tree, root, &alive_results());
        let prev = tree.node_storage[0].children[0];
        tree.commit_node = Some(prev);

        let mut fd1_results = alive_results();
        for (i, r) in fd1_results.iter_mut().enumerate() {
            r.dead = true;
            r.death_frame = 1;
            r.total_score = 100.0 + i as f64;
        }
        attach_results(&mut tree, prev, &fd1_results);
        let fd1_next = tree.node_storage[prev.0].next.unwrap();
        assert_eq!(tree.node_storage[fd1_next.0].full_death_frame, 1);

        let real_pose = pose(5.0, 6.0, 1.0);
        let mut provider = FakeProvider::new();
        let ok = commit(&mut tree, &mut provider, &[], real_pose, None);
        assert!(ok);

        let cn = tree.commit_node.unwrap();
        assert_ne!(cn, fd1_next);
        assert!(tree.node_storage[tree.root.0].children.contains(&cn));
    }
}
