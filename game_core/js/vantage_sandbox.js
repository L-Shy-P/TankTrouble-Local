/**
 * Vantage Sandbox — 物理沙箱适配器（阶段①）
 *
 * 2026-09-07 v34（Rust 物理默认开）：
 *   RUST_PHYSICS_ENABLED 默认 true；VantageRustBridge 未就绪或任何 Rust
 *   路径失败时仍自动回退 JS 融合世界，死亡权威不变。
 * 2026-08-16 v17（path[0] 活引用修复 + 诊断锚点快照）：
 *   getProjectilePaths/bulletPath 返回前把 B2DUtils.calculatePath 的
 *   每个 path 点深拷贝为 {x,y}。原 path[0] 是 b2body.GetPosition() 的
 *   活引用，锚定跨帧后 path[0] 跟着真实子弹跑，bulletPosAt 会得到
 *   “真实位移 + 预测增量”= 2 倍弹速漂移（JSON 实测 24.2/26.8 m/s vs
 *   真实 12.1/13.4 m/s）。本版返回不可变快照。
 * 2026-08-16 v18（bullet-only Box2D 子弹轨迹预测）：
 *   simulateBulletTracks(durationFrames)：私有克隆世界只放迷宫墙+当前
 *   弹道型子弹（子弹/双管/霰弹/加特林；排除制导导弹），按 0.02s 步进
 *   录逐帧 {t,x,y} 轨迹。反弹/半径/角弹法线全部由 Box2D 碰撞响应产生，
 *   与真实弹同源；供树锚定后的滚动评分替代 raycast 折线。
 * 2026-08-16 v19（融合世界改纯坦克候选世界，默认重新开启）：
 *   旧融合版幽灵弹根因 = 9 候选世界共享子弹 + 折线只摆未来位置不摆
 *   未来速度 + 槽位半径混用。v19 融合世界不再创建子弹体：子弹轨迹由
 *   v18 bullet-only 世界预测、旧 checkDeath 权威判死。树恢复每帧同步
 *   扩一层的融合生长节奏，短段也能长多层。
 * 2026-08-16 v20（track 帧数接口化，不硬编码弹种寿命）：
 *   adapter.getBulletTrackFrames(horizonFrames) 按“树滚动基准帧数 +
 *   当前场上各弹种真实 lifetime/timeAlive 的 max(基准,最长剩余寿命)”
 *   返回建议总帧数；simulateBulletTracks 仍由调用方传 durationFrames，
 *   每颗弹在各自寿命处截断。
 * 沿用 v17：bulletPosAt 末端 null；getProjectilePaths/bulletPath 深拷贝。
 * 2026-08-23 v26（done/停用弹排除）：
 *   simulateFusedBatch / simulateBulletTracks / adapter.getProjectiles /
 *   getProjectilePaths 统一跳过 pr.done()===true 或 b2 body 不存在/
 *   未激活的 projectile；旧 checkDeath 回退路径不变。
 * 2026-08-23 v27（弹道模拟提前停）：
 *   simulateBulletTracks 在所有被模拟子弹都已 active=false 后直接 break，
 *   不再空转 Box2D Step；混弹时由寿命最长的弹决定继续。
 * 2026-09-07 v33（ABI v6 + vt_score_paths 九操作评分 + 执行路线 JS 融合确认）：
 *   simulateTankBatchScored 一次调用完成 Rust 融合模拟 + f64 遮蔽角评分；
 *   仅支持 lane=0 且弹簧绳关闭的安全配置，任何失败/不支持返回 null。
 * 2026-09-07 v32（ABI v5 + 增量死亡验证只看新子弹 + JS 执行路线融合确认）：
 *   rescoreTankSamples 透传 previousDeathFrame 并标记 rustCandidate/rustIncremental；
 *   simulateTankBatch 为 Rust 物理预测打 rustPhysics 候选标记；新增
 *   simulateTankBatchJsFused 供树对最终执行路线做 JS 融合死亡确认。
 * 2026-09-05 v31（Rust vt_rescore_nodes ABI v4：帧级增量评分）：
 *   adapter.rescoreTankSamples(nodes, threats, cfg, pendingThreats) 透传
 *   nodes[].previousScores 与 threats[].isNew；Rust 只重算新弹能影响的
 *   帧，未受影响帧直接复制上一轮 perFrameScores。pendingThreats 缺省
 *   时按全量刷新（isNew=false）保持 v68 语义。
 * 2026-09-05 v30（Rust vt_rescore_nodes 增量层刷新接入）：
 *   adapter.rescoreTankSamples(nodes, threats, cfg) 通过 VantageRustBridge
 *   .rescoreNodes（ABI v3）对已有 rolloutSamples 重评分 + 融合验证；
 *   仅在 Rust 物理开关开启、融合世界存在且桥就绪时启用，否则返回 null。
 * 2026-09-05 v29（修复 cloneFusedShape 多边形接口：GetVertices，不是 GetVertex；
 *   该异常此前被 scorePaths 静默吞掉，导致融合世界实际从未生效）：
 * 2026-09-05 v28（Rust 融合 rollouts opt-in）：
 *   VantageSandbox.setRustPhysicsEnabled(true) 后，adapter.simulateTankBatch
 *   优先走 vt_rollout_batch（ABI v2）预测；JS 融合世界仍是死亡权威与回退。
 * 2026-08-23 v24（恢复单世界融合死亡权威：共享子弹 + 传感器 + CCD）：
 *   融合世界重新放入子弹体，子弹半径从真实 projectile fixture 读取；
 *   tGlobal=0 用真实位姿/速度，tGlobal>0 从 track/path 取位姿并差分取速度；
 *   每帧 Step 后遍历接触链表，只处理 fusedSensor × PROJECTILE 命中；
 *   旧 checkDeath / simulateTankClone / simulateBulletTracks 原样保留。
 * 2026-08-21 v23（性能预筛 + 新弹轨迹只算新弹 + 切片时停用闲置候选体）：
 *   checkDeath 先做“最远夹具半径+弹半径”粗筛：没有子弹中心落进该半径
 *   时静态重叠不可能发生，直接返回 false。9×75 rollout 原来每帧每候选
 *   都要 Step 一次死亡世界（20 弹约 60ms/轮），预筛后绝大多数帧直接
 *   跳过，双源基准的帧率不再被死亡检测压到 10~20fps。
 *   simulateBulletTracks(durationFrames, onlyIds) 支持只模拟指定弹：
 *   新弹局部追加时不再为全场弹重跑 480 帧轨迹。
 *   simulateFusedBatch 只激活本批 operations 对应的候选体，切片生长时
 *   Box2D Step 不再拖着 9 个候选一起碰撞。
 * 2026-08-19 v21（checkDeath 子弹池 20→64）：
 *   旧版检测世界只有 20 个子弹槽，bulletPositions 按下标截断——第 21 颗
 *   起在模拟里完全不存在（主人定调："子弹根本没在沙箱里"）。现全部
 *   入检，判定逻辑（重置位姿→Step→查接触）零改动。
 *
 * 设计原则（见 docs/Vantage躲弹实现/01-物理沙箱.md）：
 *   1. AI 主体不直接调用游戏全局对象，只认 SandboxAdapter 接口
 *   2. 常量从适配器读，不硬编码
 *   3. 死亡判定用游戏同源 Box2D 逻辑（克隆世界 + 接触检测）
 *   4. 对外以"帧"为单位，内部 FRAME_DT 换算成秒
 *   5. 坦克预测走私有克隆世界（拷贝区5）：墙/坦克/子弹全部用原版
 *      B2DUtils 建体函数克隆，Tank.update 同款驱动 + 原版 Step 参数——
 *      绝不 step 真实世界（借真实世界方案 2026-08-15 实锤污染，已退役）
 *   6. 子弹走确定性折线，状态 = 全局时间 t，不需每节点存
 *
 * 依赖（加载顺序）：
 *   Box2D → Constants → B2DUtils → ai_tactics.js（暴露 simulateTankInputs 等）→ 本文件
 *
 * 可移植性：换游戏版本只需重写 createVantageAdapter() 的实现，
 * 只要新版本的函数功能语义一致（函数名可以不同），AI 主体零改动。
 */
(function(global) {
    'use strict';

    // ============================================================
    // 常量表（从游戏 Constants 读取，不硬编码）
    // ============================================================
    function buildConstants() {
        var C = Constants;
        return {
            FRAME_DT: 0.02,  // 模拟帧时长（秒），与 simulateTankInputs 的 dt 一致
            TANK_FORWARD_SPEED: C.TANK.FORWARD_SPEED.m,
            TANK_BACK_SPEED: C.TANK.BACK_SPEED.m,
            TANK_ROTATION_SPEED: C.TANK.ROTATION_SPEED,
            TANK_WIDTH: C.TANK.WIDTH.m,
            TANK_HEIGHT: C.TANK.HEIGHT.m,
            TANK_HALF_WIDTH: C.TANK.WIDTH.m / 2,
            TANK_HALF_HEIGHT: C.TANK.HEIGHT.m / 2,
            BULLET_SPEED: C.BULLET.SPEED.m,
            BULLET_RADIUS: C.BULLET.RADIUS.m,
            PIXELS_PER_METER: C.PIXELS_PER_METER || 20,
            // 迷宫与折线采样（评分/基准时间模块用）
            MAZE_TILE_SIZE: C.MAZE_TILE_SIZE.m,
            PATH_STEP_SIZE: C.AI.PATH_STEP_SIZE,
            // 炮塔包络（碰撞体含炮塔，见 createTankBody 源码）
            TURRET_WIDTH: C.BULLET_TURRET ? C.BULLET_TURRET.WIDTH.m : 0.7,
            TURRET_HEIGHT: C.BULLET_TURRET ? C.BULLET_TURRET.HEIGHT.m : 1.4,
            TURRET_OFFSET_Y: C.BULLET_TURRET ? C.BULLET_TURRET.OFFSET_Y.m : -2.0,
            // 死亡预筛半径：坦克中心到最远碰撞夹具顶点的距离 + 子弹半径 + 安全余量。
            // checkDeath 的子弹体都是静态摆放后只 Step 0.001s 查重叠；若没有子弹
            // 中心落进这个半径，Box2D 不可能产生接触，可完全跳过死亡世界 Step。
            DEATH_PREFILTER_RADIUS:
                Math.sqrt(
                    Math.pow(C.TANK.WIDTH.m / 2, 2) +
                    Math.pow(Math.max(
                        C.TANK.HEIGHT.m / 2,
                        Math.abs((C.BULLET_TURRET ? C.BULLET_TURRET.OFFSET_Y.m : -2.0) -
                            (C.BULLET_TURRET ? C.BULLET_TURRET.HEIGHT.m : 1.4) / 2),
                        Math.abs((C.BULLET_TURRET ? C.BULLET_TURRET.OFFSET_Y.m : -2.0) +
                            (C.BULLET_TURRET ? C.BULLET_TURRET.HEIGHT.m : 1.4) / 2)
                    ), 2)
                ) + C.BULLET.RADIUS.m + 0.15
        };
    }

    // ============================================================
    // 拷贝区5（v6，2026-08-15 主人定调：私有克隆世界，全原版流程，零自研物理）
    //
    // 退役史：拷贝区4（借真实世界快照-推进-恢复）污染游戏本体已删；
    //   拷贝区3（运动学积分 + 自研墙检测/滑动）v5.2 虚影仍穿墙，主人令废弃
    //   ——自研物理永远追不平 Box2D，唯一正解 = 全部复用原版函数：
    //
    //   ① 私有克隆世界（迷宫变更时重建，草稿纸模式）：
    //      墙    = B2DUtils.createMaze(cloneWorld, maze)      （原版函数原样）
    //      坦克体 = B2DUtils.createTankBody(cloneWorld, tank)  （原版函数原样，
    //               传真实 tank 只读 getX/getY/getRotation，绝不碰其真实 body）
    //      子弹体 = B2DUtils.createProjectileBody(cloneWorld, projectile, r)
    //               （同上，读位姿/速度；池化管理，在场数量变化时启停）
    //   ② 我方驱动 = Tank.update 同款流程：借用真实 Tank 实例的
    //      _computeSpeed/_computeRotationSpeed（含 SPEED modifier 与 locked，
    //      实例字段前后快照恢复）→ SetLinearVelocity/SetAngularVelocity 写入
    //      克隆体（公式逐字节同 Tank.update）
    //   ③ 推进 = world.Step(0.02, 10, 10)（RoundModel.update 同参）
    //      → 贴墙滑动 / 坦克互推 / 子弹反弹全是真 Box2D 碰撞响应，天然同源
    //   ④ 对手坦克：保持真实速度向量（一阶近似，输入未知）
    //   死亡判定仍走 checkDeath（克隆迷你世界 Box2D 同源，折线取弹位）。
    //   未克隆项：护盾 SHIELD 夹具（拾取护盾坦克的弹开行为暂缺）、陷阱。
    // ============================================================
    var _cloneCache = null;   // { mazeRef, world, tankBodies:{pid:body}, bulletBodies:[{body,radius,active}] }

    function getCloneWorld(gameController) {
        var maze = gameController.getMaze();
        if (!maze) return null;
        if (_cloneCache && _cloneCache.mazeRef === maze) return _cloneCache;

        var world = new Box2D.Dynamics.b2World(
            Box2D.Common.Math.b2Vec2.Make(0, 0), true);
        B2DUtils.createMaze(world, maze);   // 原版：克隆全部墙

        var tankBodies = {};
        var tanks = gameController.getTanks();
        for (var pid in tanks) {
            if (!tanks.hasOwnProperty(pid)) continue;
            var tk = tanks[pid];
            if (!tk || !tk.getB2DBody || !tk.getB2DBody()) continue;
            tankBodies[pid] = B2DUtils.createTankBody(world, tk);   // 原版建体
        }

        _cloneCache = {
            mazeRef: maze,
            world: world,
            tankBodies: tankBodies,
            bulletBodies: []
        };
        return _cloneCache;
    }

    /** 子弹克隆体池：按需补建；每轮模拟前全停，acquire 时按轮次号复用 */
    var _cloneRound = 0;

    function acquireBulletBody(cw, projectile) {
        var i, slot = null;
        for (i = 0; i < cw.bulletBodies.length; i++) {
            if (cw.bulletBodies[i].lastRound !== _cloneRound) { slot = cw.bulletBodies[i]; break; }
        }
        if (!slot) {
            var rb = projectile.getB2DBody();
            var radius = 0.25;
            try {
                radius = rb.GetFixtureList().GetShape().m_radius;
            } catch (eR) {}
            slot = {
                body: null,
                lastRound: -1
            };
            slot.body = B2DUtils.createProjectileBody(cw.world, projectile, radius);
            cw.bulletBodies.push(slot);
        }
        slot.lastRound = _cloneRound;
        slot.body.SetActive(true);
        return slot.body;
    }

    /** 本轮未被 acquire 的池槽全部停用（每轮模拟结束时调用） */
    function parkUnusedBullets(cw) {
        for (var i = 0; i < cw.bulletBodies.length; i++) {
            if (cw.bulletBodies[i].lastRound !== _cloneRound) {
                cw.bulletBodies[i].body.SetActive(false);
            }
        }
    }

    // ============================================================
    // 拷贝区6（v18，2026-08-16）：bullet-only 子弹轨迹预测世界
    //
    // 目的：替换 B2DUtils.calculatePath 的 raycast 折线进入滚动评分。
    // 只克隆迷宫墙 + 当前弹道型子弹；没有坦克候选体，因此不会出现
    // 融合世界那种“9 个候选坦克把共享子弹撞乱”的污染。
    // 每帧 Step 后按 Projectile.update 同款口径把速度长度归一到
    // 初始速度，再录 {t,x,y} 快照（绝无活引用）。
    // ============================================================

    var _bulletTrackWorld = null;   // { mazeRef, world, slots:{id:{body,radius}} }
    var _bulletTrackRound = 0;

    function getBulletTrackWorld(gameController) {
        var maze = gameController.getMaze();
        if (!maze) return null;
        if (_bulletTrackWorld && _bulletTrackWorld.mazeRef === maze) {
            return _bulletTrackWorld;
        }
        var world = new Box2D.Dynamics.b2World(
            Box2D.Common.Math.b2Vec2.Make(0, 0), true);
        B2DUtils.createMaze(world, maze);   // 原版建墙，碰撞响应同源
        _bulletTrackWorld = {
            mazeRef: maze,
            world: world,
            slots: {}
        };
        _bulletTrackRound = 0;
        return _bulletTrackWorld;
    }

    /** 弹道型子弹白名单：制导导弹(3)/地雷(4) 不是匀速直线+反弹，暂不纳入。 */
    function isBallisticProjectile(pr) {
        if (!pr || typeof pr.getType !== 'function') return true;   // 无类型信息的老对象保守纳入
        var t = pr.getType();
        // LASER(0) 半径 0、不反弹，不进 Box2D 轨迹；制导导弹/地雷另行排除。
        return t === Constants.WEAPON_TYPES.BULLET ||
            t === Constants.WEAPON_TYPES.DOUBLE_BARREL ||
            t === Constants.WEAPON_TYPES.SHOTGUN ||
            t === Constants.WEAPON_TYPES.GATLING_GUN;
    }

    /** v26：已完成或已停用的 projectile 不参与任何模拟/轨迹/路径。 */
    function projectileDoneOrInactive(pr) {
        if (!pr) return true;
        if (pr.done && pr.done()) return true;
        var rb = pr.getB2DBody ? pr.getB2DBody() : null;
        if (!rb) return true;
        if (rb.IsActive && !rb.IsActive()) return true;
        return false;
    }

    /**
     * v20：树层询问“bullet track 该给多少帧”。
     * 基准是树滚动需要的 horizonFrames；再按当前场上每颗弹道型子弹的
     * 真实 lifetime/timeAlive 取最长剩余寿命，逐弹在自己的寿命处截断。
     * 不同弹种（普通弹/双管/霰弹/加特林…）寿命不同，全部由本函数统一折算。
     * @param {number} horizonFrames - 树滚动需要的基准帧数
     * @returns {number} 建议传给 simulateBulletTracks 的总帧数
     */
    function computeBulletTrackFrames(gameController, horizonFrames) {
        var maxFrames = Math.max(1, Math.round(horizonFrames || 0));
        var FRAME = 0.02;
        var projectiles = gameController.getProjectiles();
        for (var id in projectiles) {
            if (!projectiles.hasOwnProperty(id)) continue;
            var pr = projectiles[id];
            if (!pr || !isBallisticProjectile(pr)) continue;
            var lifeTotal = (typeof pr.lifetime === 'number') ? pr.lifetime : 10;
            var lifeAge = (pr.getTimeAlive && typeof pr.getTimeAlive === 'function')
                ? pr.getTimeAlive() : 0;
            var lifeLeftSec = Math.max(0, lifeTotal - lifeAge);
            var lifeLeftFrames = Math.ceil(lifeLeftSec / FRAME);
            if (lifeLeftFrames > maxFrames) maxFrames = lifeLeftFrames;
        }
        return maxFrames + 2;   // +2 帧容差
    }

    /**
     * 逐帧预测弹道型子弹的 Box2D 轨迹（默认全场；可 onlyIds 只算指定弹）。
     * @param {number} durationFrames - 预测帧数（FRAME_DT=0.02s/帧）
     * @param {Array} [onlyIds] - 可选：只模拟这些 id；省略/空数组 = 全部
     * @returns {Array|null} [{id, type, frames:[{t,x,y,alive}...]}...]；无迷宫返回 null
     */
    function simulateBulletTracks(gameController, durationFrames, onlyIds) {
        var cw = getBulletTrackWorld(gameController);
        if (!cw) return null;
        var projectiles = gameController.getProjectiles();
        var FRAME = 0.02;
        var i, k, id;
        // v22：允许只模拟指定 id 的子弹（新弹局部追加时，旧弹轨迹可复用，
        // 不必为 1 颗新弹把全场 20~40 颗弹各 roll 480 帧）。
        var idFilter = null;
        if (onlyIds && onlyIds.length) {
            idFilter = {};
            for (i = 0; i < onlyIds.length; i++) {
                if (onlyIds[i] !== undefined && onlyIds[i] !== null) idFilter[onlyIds[i]] = true;
            }
        }

        // 本轮全部停用；下面按“当前真实存在”逐个复活。
        _bulletTrackRound++;
        for (id in cw.slots) {
            if (cw.slots.hasOwnProperty(id)) cw.slots[id].body.SetActive(false);
        }

        var active = [];
        var results = [];
        for (id in projectiles) {
            if (!projectiles.hasOwnProperty(id)) continue;
            if (idFilter && !idFilter[id]) continue;
            var pr = projectiles[id];
            if (projectileDoneOrInactive(pr)) continue;
            if (!isBallisticProjectile(pr)) continue;
            var rb = pr.getB2DBody();
            var radius = 0.25;
            try { radius = rb.GetFixtureList().GetShape().m_radius; } catch (eR) {}
            var slot = cw.slots[id];
            if (!slot) {
                slot = {
                    body: B2DUtils.createProjectileBody(cw.world, pr, radius),
                    radius: radius
                };
                cw.slots[id] = slot;
            }
            var rpos = rb.GetPosition();
            var rvel = rb.GetLinearVelocity();
            slot.body.SetActive(true);
            slot.body.SetPositionAndAngle(
                Box2D.Common.Math.b2Vec2.Make(rpos.x, rpos.y), rb.GetAngle());
            slot.body.SetLinearVelocity(
                Box2D.Common.Math.b2Vec2.Make(rvel.x, rvel.y));
            slot.body.SetAngularVelocity(rb.GetAngularVelocity());
            slot.body.SetAwake(true);   // SetActive(true) 后 velocity 写入不会自动唤醒
            slot.initialSpeed = rvel.Length();
            slot.lifeTotal = (typeof pr.lifetime === 'number') ? pr.lifetime : 10;
            slot.lifeAge = pr.getTimeAlive ? pr.getTimeAlive() : 0;
            slot.lifeLeft = Math.max(0, slot.lifeTotal - slot.lifeAge);
            slot.active = slot.lifeLeft > 0;
            if (!slot.active) {
                slot.body.SetActive(false);
                continue;
            }
            slot.frames = [];
            slot.trackId = id;
            active.push(slot);
            results.push({ id: id, type: pr.getType ? pr.getType() : null, frames: slot.frames });
        }

        // 没有可预测弹 → 空数组（调用方回退折线）。
        if (!active.length) return results;

        for (k = 0; k <= durationFrames; k++) {
            // 录当前帧（真实模型读取时机 = RoundModel 更新后的位置）
            for (i = 0; i < active.length; i++) {
                var s = active[i];
                if (!s.active) continue;
                var bp = s.body.GetPosition();
                s.frames.push({ t: k * FRAME, x: bp.x, y: bp.y, alive: true });
            }
            if (k >= durationFrames) break;

            // v27：所有被模拟子弹都已死亡/停用后提前停，不再空转 Step。
            var anyActive = false;
            for (var ai2 = 0; ai2 < active.length; ai2++) {
                if (active[ai2].active) { anyActive = true; break; }
            }
            if (!anyActive) break;

            cw.world.Step(FRAME, 10, 10);   // RoundModel.update 同参

            // Projectile.update 同款速度归一（真实代码：长度偏离初始值>0.01 才归一）
            for (i = 0; i < active.length; i++) {
                s = active[i];
                if (!s.active) continue;
                s.lifeLeft -= FRAME;
                if (s.lifeLeft <= 0) {
                    s.active = false;
                    s.body.SetActive(false);
                    continue;
                }
                var v = s.body.GetLinearVelocity();
                var len = v.Length();
                if (len === 0) {
                    // 真实 Projectile.update 会 stopped；轨迹在下一帧自然断供。
                    s.active = false;
                    s.body.SetActive(false);
                    continue;
                }
                var lenSq = len * len;
                var initSq = s.initialSpeed * s.initialSpeed;
                if (Math.abs(lenSq - initSq) > 0.01) {
                    v.Multiply(s.initialSpeed / len);
                    s.body.SetLinearVelocity(v);
                }
            }
        }
        return results;
    }

    function simulateTankClone(gameController, aiId, inputs, durationFrames, opt) {
        var cw = getCloneWorld(gameController);
        var FRAME = 0.02;
        var i;
        opt = opt || {};

        var me = gameController.getTank(aiId);
        var meBody = cw ? cw.tankBodies[aiId] : null;
        var samples = [];

        // 克隆世界建后才出现的坦克：动态补建克隆体（原版建体函数）
        if (cw && me && me.getB2DBody && me.getB2DBody() && !meBody) {
            meBody = B2DUtils.createTankBody(cw.world, me);
            cw.tankBodies[aiId] = meBody;
        }

        // 克隆世界不可用（无迷宫等极端态）：退化为静止采样（保接口不炸）
        if (!cw || !meBody || !me || !me.getB2DBody()) {
            for (i = 0; i <= durationFrames; i++) {
                samples.push({ t: i * FRAME, x: me ? me.getX() : 0, y: me ? me.getY() : 0, rot: me ? me.getRotation() : 0 });
            }
            return { samples: samples, hitWall: false, dead: false, deathFrame: -1 };
        }

        // ① 重摆：全部坦克克隆体 → 各自真实位姿/速度（对手快照驱动）
        // ⚠ 本 Box2D 版本 SetTransform(t) 只收单个 b2Transform；两参摆位
        //   必须用 SetPositionAndAngle(pos, angle)（2026-08-15 离线实锤：
        //   传错参数 → t.GetAngle is not a function → v6 运行态全灭的真凶）
        var pid, tb, rpos, rvel, rbody;
        for (pid in cw.tankBodies) {
            if (!cw.tankBodies.hasOwnProperty(pid)) continue;
            var rt = gameController.getTank(pid);
            rbody = rt && rt.getB2DBody ? rt.getB2DBody() : null;
            if (!rbody) { cw.tankBodies[pid].SetActive(false); continue; }
            cw.tankBodies[pid].SetActive(true);
            rpos = rbody.GetPosition(); rvel = rbody.GetLinearVelocity();
            cw.tankBodies[pid].SetPositionAndAngle(
                Box2D.Common.Math.b2Vec2.Make(rpos.x, rpos.y), rbody.GetAngle());
            cw.tankBodies[pid].SetLinearVelocity(
                Box2D.Common.Math.b2Vec2.Make(rvel.x, rvel.y));
            cw.tankBodies[pid].SetAngularVelocity(rbody.GetAngularVelocity());
        }

        // 我方摆到起点位姿（树节点语义：从父节点位姿出发）
        meBody.SetPositionAndAngle(
            Box2D.Common.Math.b2Vec2.Make(opt.startPose.x, opt.startPose.y), opt.startPose.rot);
        meBody.SetLinearVelocity(Box2D.Common.Math.b2Vec2.Make(0, 0));
        meBody.SetAngularVelocity(0);

        // ② 子弹克隆体：在场全部 acquire 并摆位（tGlobal 时刻折线插值，速度取真实向量）
        _cloneRound++;
        var tactics = global.TankTroubleAITactics;
        var projectiles = gameController.getProjectiles();
        for (var projId in projectiles) {
            if (!projectiles.hasOwnProperty(projId)) continue;
            var pr = projectiles[projId];
            if (!pr || !pr.getB2DBody || !pr.getB2DBody()) continue;
            var clone = acquireBulletBody(cw, pr);
            var pb = pr.getB2DBody();
            var placed = false;
            if (opt.threats && opt.tGlobal > 0 && tactics && tactics.positionOnProjectilePath) {
                for (i = 0; i < opt.threats.length; i++) {
                    if (opt.threats[i].id !== projId) continue;
                    var posAt = tactics.positionOnProjectilePath(
                        opt.threats[i].path, opt.threats[i].speed, opt.tGlobal);
                    if (posAt) {
                        clone.SetPositionAndAngle(
                            Box2D.Common.Math.b2Vec2.Make(posAt.x, posAt.y), pb.GetAngle());
                        placed = true;
                    }
                    break;
                }
            }
            if (!placed) {
                var ppos = pb.GetPosition();
                clone.SetPositionAndAngle(
                    Box2D.Common.Math.b2Vec2.Make(ppos.x, ppos.y), pb.GetAngle());
            }
            var pvel = pb.GetLinearVelocity();
            clone.SetLinearVelocity(Box2D.Common.Math.b2Vec2.Make(pvel.x, pvel.y));
        }
        parkUnusedBullets(cw);   // 本轮未用到的池槽停用

        // ③ 借用真实 Tank 的原版速度计算（字段快照/恢复，防污染）
        var snapFwd = me.forward, snapBack = me.back,
            snapLeft = me.left, snapRight = me.right,
            snapSpeed = me.speed, snapRotSpd = me.rotationSpeed;
        var locked = !!me.locked;

        var hitWall = false;
        for (var k = 0; k <= durationFrames; k++) {
            samples.push({
                t: k * FRAME,
                x: meBody.GetPosition().x, y: meBody.GetPosition().y,
                rot: meBody.GetAngle()
            });
            if (k >= durationFrames) break;

            // Tank.update 同款驱动（locked 清速度 / compute + 设速度）
            if (locked) {
                meBody.SetLinearVelocity(Box2D.Common.Math.b2Vec2.Make(0, 0));
                meBody.SetAngularVelocity(0);
            } else {
                me.forward = !!inputs.forward;
                me.back = !!inputs.back;
                me.left = !!inputs.left;
                me.right = !!inputs.right;
                me._computeSpeed();
                me._computeRotationSpeed();
                var a = meBody.GetAngle();
                meBody.SetLinearVelocity(Box2D.Common.Math.b2Vec2.Make(
                    Math.sin(a) * me.speed, -Math.cos(a) * me.speed));
                meBody.SetAngularVelocity(me.rotationSpeed);
            }

            cw.world.Step(FRAME, 10, 10);   // RoundModel.update 同参
        }

        // ④ 恢复真实 Tank 实例字段（下帧游戏 update 本会重算，双保险）
        me.forward = snapFwd; me.back = snapBack;
        me.left = snapLeft; me.right = snapRight;
        me.speed = snapSpeed; me.rotationSpeed = snapRotSpd;

        return { samples: samples, hitWall: hitWall, dead: false, deathFrame: -1 };
    }

    // ============================================================
    // 9 种操作定义
    // ============================================================
    var OPERATIONS = [
        { name: '静止',   inputs: { forward: false, back: false, left: false, right: false } },
        { name: '前',     inputs: { forward: true,  back: false, left: false, right: false } },
        { name: '后',     inputs: { forward: false, back: true,  left: false, right: false } },
        { name: '左',     inputs: { forward: false, back: false, left: true,  right: false } },
        { name: '右',     inputs: { forward: false, back: false, left: false, right: true  } },
        { name: '前左',   inputs: { forward: true,  back: false, left: true,  right: false } },
        { name: '前右',   inputs: { forward: true,  back: false, left: false, right: true  } },
        { name: '后左',   inputs: { forward: false, back: true,  left: true,  right: false } },
        { name: '后右',   inputs: { forward: false, back: true,  left: false, right: true  } }
    ];

    // ============================================================
    // Fake Tank（供 simulateTankInputs 复用，只需 getX/getY/getRotation）
    // ============================================================
    function makeFakeTank(state) {
        return {
            getX: function() { return state.x; },
            getY: function() { return state.y; },
            getRotation: function() { return state.rot; }
        };
    }

    // ============================================================
    // 单世界融合沙箱（v13：9 候选同世界 + 共享子弹 + 传感器判死）
    // 旧 simulateTankClone / checkDeath 完整保留，开关关闭时回退。
    // ============================================================
    // v36：融合世界缓存改成**多槽**（键 = aiId），换图时整体作废。
    //   原因（主人实测"K 和 V 同时在场帧率减半、V 变蠢"）：原来是单槽缓存，
    //   两个 AI 用不同的 aiId 轮流查 → 每帧互相挤掉 → 每帧重建两次整个 Box2D
    //   融合世界；V 自己的缓存也一直被丢，等于每步都在付重建费、还丢了时间预算。
    var _fusedCacheSlots = {};
    var _fusedCacheMazeRef = null;
    var _fusedCache = null;
    // v24：融合世界重新承担死亡判定：共享子弹 + 传感器 + CCD。
    // 幽灵弹根因（只摆未来位置不摆未来速度、槽位半径混用）已修正：
    // tGlobal=0 用真实位姿/速度；tGlobal>0 从 track/path 取位姿并差分取
    // 速度，子弹半径从真实 projectile fixture 读取。bullet-only 轨迹世界
    // 仍保留，只用于轨迹/威胁/车道查询。
    var FUSED_ENABLED = true;
    // v34：Rust 融合 rollouts 默认开启；JS 融合世界仍是死亡权威与回退路径。
    // Rust 只做预测，不在任何地方改判真实死亡；桥未就绪时自动回退 JS。
    var RUST_PHYSICS_ENABLED = true;

    function setFusedEnabled(v) {
        FUSED_ENABLED = !!v;
        if (!FUSED_ENABLED) { _fusedCache = null; _fusedCacheSlots = {}; _fusedCacheMazeRef = null; }
    }

    /** v35：清掉跨局/重生的融合世界与克隆世界缓存，避免旧缓存拖慢/拖笨后续对局。 */
    function clearCaches() {
        _fusedCache = null; _fusedCacheSlots = {}; _fusedCacheMazeRef = null;
        _cloneCache = null;
    }

    function fusedEnabled() {
        return FUSED_ENABLED;
    }

    function setRustPhysicsEnabled(v) {
        RUST_PHYSICS_ENABLED = !!v;
    }

    function rustPhysicsEnabled() {
        return RUST_PHYSICS_ENABLED;
    }

    /** 复制一个同形状的夹具形状（传感器夹具与原始夹具完全同形）。 */
    function cloneFusedShape(shape) {
        if (!shape) return null;
        var st = shape.GetType();
        if (st === Box2D.Collision.Shapes.b2Shape.e_circleShape) {
            var cs = new Box2D.Collision.Shapes.b2CircleShape(shape.m_radius);
            if (shape.m_p) cs.m_p.SetV(shape.m_p);
            return cs;
        }
        if (st === Box2D.Collision.Shapes.b2Shape.e_polygonShape) {
            // 本 Box2D 修订的 b2PolygonShape 只有 GetVertices()/GetVertexCount()，
            // 没有 GetVertex()。必须用游戏真实接口，不能依赖 local_patch 之类的
            // 替身补丁（v29：此前融合世界一直在此抛错并被 scorePaths 吞掉回退）。
            var verts = [];
            var rawVerts = (typeof shape.GetVertices === 'function')
                ? shape.GetVertices()
                : shape.m_vertices;
            var n = rawVerts ? rawVerts.length : shape.GetVertexCount();
            for (var vi = 0; vi < n; vi++) {
                var v = rawVerts[vi];
                verts.push(Box2D.Common.Math.b2Vec2.Make(v.x, v.y));
            }
            return new Box2D.Collision.Shapes.b2PolygonShape.AsArray(verts);
        }
        return null;
    }

    /**
     * v24：候选坦克体恢复使用游戏原版 B2DUtils.createTankBody 创建，
     * 然后逐个夹具修改 filter，再为每个原有夹具复制同形状传感器夹具。
     */
    function createFusedCandidateBody(world, tank, opIndex) {
        var body = B2DUtils.createTankBody(world, tank);
        var MAZE = Constants.COLLISION_CATEGORIES.MAZE;
        var PROJ = Constants.COLLISION_CATEGORIES.PROJECTILE;
        var TANK = Constants.COLLISION_CATEGORIES.TANK;

        // 正常夹具：候选坦克只和墙碰撞（候选之间、候选与子弹都不碰撞）
        var shapes = [];
        var fixture = body.GetFixtureList();
        while (fixture) {
            var fd = fixture.GetFilterData();
            fd.maskBits = MAZE;
            fixture.SetFilterData(fd);
            shapes.push(fixture.GetShape());
            fixture = fixture.GetNext();
        }

        // 传感器夹具：与子弹产生 isSensor 接触，不反弹不阻挡
        for (var si = 0; si < shapes.length; si++) {
            var sensorShape = cloneFusedShape(shapes[si]);
            if (!sensorShape) continue;
            var sfd = new Box2D.Dynamics.b2FixtureDef();
            sfd.shape = sensorShape;
            sfd.density = 0.0;
            sfd.friction = 0.0;
            sfd.restitution = 0.0;
            sfd.isSensor = true;
            sfd.userData = { type: 'fusedSensor', opIndex: opIndex };
            sfd.filter = new Box2D.Dynamics.b2FilterData();
            sfd.filter.categoryBits = TANK;
            sfd.filter.maskBits = PROJ;
            body.CreateFixture(sfd);
        }
        return body;
    }

    function getFusedWorld(gameController, aiId) {
        if (!FUSED_ENABLED) return null;
        var maze = gameController.getMaze();
        if (!maze) return null;
        if (_fusedCacheMazeRef !== maze) {          // 换图 → 所有槽作废
            _fusedCacheSlots = {};
            _fusedCacheMazeRef = maze;
        }
        var cacheKey = String(aiId);
        if (_fusedCacheSlots[cacheKey]) {
            _fusedCache = _fusedCacheSlots[cacheKey];
            return _fusedCache;
        }
        var me = gameController.getTank(aiId);
        if (!me || !me.getB2DBody || !me.getB2DBody()) return null;

        var world = new Box2D.Dynamics.b2World(
            Box2D.Common.Math.b2Vec2.Make(0, 0), true);
        B2DUtils.createMaze(world, maze);

        // v28：为 Rust 融合 rollouts 提取墙多边形。本 Box2D 修订的 body/
        // fixture 链表是前插的，所以收集后 reverse 回创建顺序（与
        // diff_rollout.js 的 extractWallPolygons 完全一致）。
        var wallShapes = [];
        var wallBody = world.GetBodyList();
        while (wallBody) {
            var wallFixture = wallBody.GetFixtureList();
            while (wallFixture) {
                var wfd = wallFixture.GetFilterData();
                if ((wfd.categoryBits & Constants.COLLISION_CATEGORIES.MAZE) !== 0) {
                    var wshape = wallFixture.GetShape();
                    if (wshape && wshape.m_vertexCount &&
                            (typeof wshape.GetType !== 'function' ||
                             wshape.GetType() === Box2D.Collision.Shapes.b2Shape.e_polygonShape)) {
                        var verts = [];
                        for (var wvi = 0; wvi < wshape.m_vertexCount; wvi++) {
                            var wv = wshape.m_vertices[wvi];
                            verts.push({ x: wv.x, y: wv.y });
                        }
                        wallShapes.push({ verts: verts });
                    }
                }
                wallFixture = wallFixture.GetNext();
            }
            wallBody = wallBody.GetNext();
        }
        wallShapes.reverse();

        var candidates = [];
        for (var i = 0; i < OPERATIONS.length; i++) {
            candidates.push(createFusedCandidateBody(world, me, i));
        }
        _fusedCache = {
            mazeRef: maze,
            aiId: aiId,
            world: world,
            candidates: candidates,
            bulletSlots: [],
            round: 0,
            wallShapes: wallShapes
        };
        _fusedCacheSlots[String(aiId)] = _fusedCache;   // v36：存进多槽缓存，别挤掉别的 AI
        return _fusedCache;
    }

    // v38：融合世界"摆不了位的弹"统计。**绝不静默**：任何一颗真实存在的弹
    // 若进不了融合世界，死亡权威就会对它失明（预测"还活着/死得更晚"），
    // 主人实测的"橙色/绿色节点上死"就在这一族里。要么按真实位姿近似摆进去，
    // 要么留下响亮的记录。
    var _fusedDropStats = {
        approxPlaced: 0,      // 无 track/折线可用 → 按"真实位姿 + 真实速度"前推后摆上
        noThreat: 0,          // 连威胁条目都找不到（威胁表漏了它）
        skipped: 0,           // 其它原因没摆（保留计数，不允许无声）
        lastLogMs: 0,
        lastDetail: ''
    };
    function fusedDropLog(detail) {
        var now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        if (now - _fusedDropStats.lastLogMs < 1000) return;   // 每秒最多一条
        _fusedDropStats.lastLogMs = now;
        _fusedDropStats.lastDetail = detail;
        if (global.console && console.warn) {
            console.warn('[VantageSandbox] 融合世界摆放弹药不完整（预测可能偏乐观）：' + detail +
                ' 累计: 近似摆=' + _fusedDropStats.approxPlaced +
                ' 无威胁条目=' + _fusedDropStats.noThreat +
                ' 跳过=' + _fusedDropStats.skipped);
        }
    }

    function acquireFusedBullet(fc, projectile) {
        var i, slot = null;
        for (i = 0; i < fc.bulletSlots.length; i++) {
            if (fc.bulletSlots[i].lastRound !== fc.round) { slot = fc.bulletSlots[i]; break; }
        }
        var rb = projectile.getB2DBody();
        var radius = 0.25;
        try {
            radius = rb.GetFixtureList().GetShape().m_radius;
        } catch (eR) {}
        if (!slot) {
            slot = { body: null, lastRound: -1, radius: radius };
            slot.body = B2DUtils.createProjectileBody(fc.world, projectile, radius);
            fc.bulletSlots.push(slot);
        } else if (slot.radius !== radius) {
            // v24：槽位半径必须跟随当前弹种；不同半径复用同一 slot 会造成
            // 霰弹/加特林(0.1)用成普通弹(0.25)的死亡判定错误。
            if (slot.body) {
                slot.body.SetActive(false);
                try { fc.world.DestroyBody(slot.body); } catch (eD) {}
            }
            slot.body = B2DUtils.createProjectileBody(fc.world, projectile, radius);
            slot.radius = radius;
        }
        slot.lastRound = fc.round;
        slot.body.SetActive(true);
        return slot;
    }

    function parkUnusedFusedBullets(fc) {
        for (var i = 0; i < fc.bulletSlots.length; i++) {
            if (fc.bulletSlots[i].lastRound !== fc.round) {
                fc.bulletSlots[i].body.SetActive(false);
            }
        }
    }

    /**
     * v28：把 aiId 哈希成 32 位无符号整数，作为 Rust 持久融合世界缓存键。
     * FNV-1a。
     */
    function hashAiIdForRustCache(aiId) {
        var h = 0x811c9dc5;
        var s = String(aiId);
        for (var i = 0; i < s.length; i++) {
            h ^= s.charCodeAt(i);
            h = (h * 0x01000193) >>> 0;
        }
        return h >>> 0;
    }

    /**
     * v28：与 simulateFusedBatch 完全一致的速度/角速度计算，但只借用 me
     * 实例计算一轮，不写候选体。锁定坦克 => 速度与角速度都为 0。
     */
    function computeRustOperationSpeeds(me, operations, locked) {
        var speeds = [];
        var rotationSpeeds = [];
        var snapFwd = me.forward, snapBack = me.back,
            snapLeft = me.left, snapRight = me.right,
            snapSpeed = me.speed, snapRotSpd = me.rotationSpeed;

        for (var i = 0; i < operations.length; i++) {
            me.forward = !!operations[i].inputs.forward;
            me.back = !!operations[i].inputs.back;
            me.left = !!operations[i].inputs.left;
            me.right = !!operations[i].inputs.right;
            if (locked) {
                speeds.push(0);
                rotationSpeeds.push(0);
            } else {
                if (typeof me._computeSpeed === 'function') {
                    me._computeSpeed();
                } else {
                    me.speed = (me.forward ? 15.95 : 0) + (me.back ? -12.8 : 0);
                }
                if (typeof me._computeRotationSpeed === 'function') {
                    me._computeRotationSpeed();
                } else {
                    me.rotationSpeed = (me.left ? -5.0 : 0) + (me.right ? 5.0 : 0);
                }
                speeds.push(me.speed);
                rotationSpeeds.push(me.rotationSpeed);
            }
        }

        me.forward = snapFwd; me.back = snapBack;
        me.left = snapLeft; me.right = snapRight;
        me.speed = snapSpeed; me.rotationSpeed = snapRotSpd;

        return { speeds: speeds, rotationSpeeds: rotationSpeeds };
    }

    /**
     * v28：Rust 融合 rollouts 批量预测。仅当试验开关、融合世界、Rust 桥
     * 都就绪且 durationFrames <= 75 时启用。先调用 simulateFusedBatch(0帧)
     * 复用游戏真实的子弹放置/槽位逻辑（只记录起点，不 Step 世界），再把
     * 墙多边形/起点/操作速度/子弹输入交给 vt_rollout_batch。
     */
    function simulateRustBatch(gameController, aiId, operations, durationFrames, opt) {
        if (!RUST_PHYSICS_ENABLED || !FUSED_ENABLED) return null;
        if (durationFrames > 75) return null;
        if (!global.VantageRustBridge || !global.VantageRustBridge._ready) return null;

        var fc = getFusedWorld(gameController, aiId);
        if (!fc) return null;

        var fused = simulateFusedBatch(gameController, aiId, operations, 0, opt);
        if (!fused || fused.length !== operations.length) return null;

        var me = gameController.getTank(aiId);
        if (!me || !me.getB2DBody || !me.getB2DBody()) return null;

        var bullets = [];
        for (var bi = 0; bi < fc.bulletSlots.length; bi++) {
            var slot = fc.bulletSlots[bi];
            if (slot.lastRound !== fc.round || !slot.body || !slot.body.IsActive() || !slot.active) continue;
            var bpos = slot.body.GetPosition();
            var bvel = slot.body.GetLinearVelocity();
            bullets.push({
                x: bpos.x,
                y: bpos.y,
                vx: bvel.x,
                vy: bvel.y,
                radius: slot.radius,
                lifeLeft: slot.lifeLeft,
                active: true
            });
        }

        var opCalc = computeRustOperationSpeeds(me, operations, !!me.locked);
        var rustOps = [];
        for (var oi = 0; oi < operations.length; oi++) {
            rustOps.push({
                speed: opCalc.speeds[oi],
                rotationSpeed: opCalc.rotationSpeeds[oi]
            });
        }

        var bridgeResult;
        try {
            bridgeResult = global.VantageRustBridge.rolloutBatch({
                cacheId: hashAiIdForRustCache(aiId),
                startPose: opt.startPose,
                ops: rustOps,
                walls: fc.wallShapes,
                bullets: bullets,
                frames: durationFrames
            });
        } catch (eBridge) {
            console.warn('[VantageSandbox] Rust 物理预测调用失败，回退融合世界:', eBridge);
            return null;
        }

        if (bridgeResult.ok !== true || !bridgeResult.samples ||
                bridgeResult.samples.length !== operations.length ||
                !bridgeResult.dead || !bridgeResult.deathFrame ||
                bridgeResult.dead.length !== operations.length ||
                bridgeResult.deathFrame.length !== operations.length) {
            console.warn('[VantageSandbox] Rust 物理预测结果无效，回退融合世界');
            return null;
        }
        for (var si = 0; si < bridgeResult.samples.length; si++) {
            if (!bridgeResult.samples[si] ||
                    bridgeResult.samples[si].length !== durationFrames + 1) {
                console.warn('[VantageSandbox] Rust 物理预测样本数不匹配，回退融合世界');
                return null;
            }
        }

        return bridgeResult.samples.map(function (samples, idx) {
            return {
                samples: samples.map(function (s, frame) {
                    return { t: frame * 0.02, x: s.x, y: s.y, rot: s.rot };
                }),
                hitWall: false,
                dead: !!bridgeResult.dead[idx],
                deathFrame: bridgeResult.deathFrame[idx]
            };
        });
    }

    /**
     * 九操作批量模拟（融合世界）。
     * @returns {Array|null} 9 组 {samples, hitWall, dead, deathFrame}；不可用时 null
     */
    function simulateFusedBatch(gameController, aiId, operations, durationFrames, opt) {
        if (!FUSED_ENABLED) return null;
        var fc = getFusedWorld(gameController, aiId);
        if (!fc) return null;
        var me = gameController.getTank(aiId);
        if (!me || !me.getB2DBody || !me.getB2DBody()) return null;

        var FRAME = 0.02;
        opt = opt || {};
        var i, k, id;

        for (i = 0; i < fc.candidates.length; i++) {
            var cb = fc.candidates[i];
            var active = i < operations.length;
            cb.SetActive(active);
            if (active) {
                cb.SetPositionAndAngle(
                    Box2D.Common.Math.b2Vec2.Make(opt.startPose.x, opt.startPose.y),
                    opt.startPose.rot);
                cb.SetLinearVelocity(Box2D.Common.Math.b2Vec2.Make(0, 0));
                cb.SetAngularVelocity(0);
                cb.SetAwake(true);
            }
        }

        fc.round++;
        var projectiles = gameController.getProjectiles();
        var tactics = global.TankTroubleAITactics;
        var threatById = {};
        if (opt.threats) {
            for (i = 0; i < opt.threats.length; i++) {
                var th0 = opt.threats[i];
                if (th0 && th0.id !== undefined) threatById[th0.id] = th0;
            }
        }

        for (id in projectiles) {
            if (!projectiles.hasOwnProperty(id)) continue;
            var pr = projectiles[id];
            if (projectileDoneOrInactive(pr)) continue;
            var rb = pr.getB2DBody();
            var slot = acquireFusedBullet(fc, pr);
            slot.pid = (pr && pr.id !== undefined) ? pr.id : null;   // v39：轨迹导出用
            slot.srcInfo = null;                                     // v122：本帧用了哪个时间基准
            var rpos = rb.GetPosition();
            var rvel = rb.GetLinearVelocity();
            var th = threatById[id];

            var placed = false;
            var vx = 0, vy = 0;
            var qLife = 0;
            if (!(opt.tGlobal > 0)) {
                slot.body.SetPositionAndAngle(
                    Box2D.Common.Math.b2Vec2.Make(rpos.x, rpos.y), rb.GetAngle());
                vx = rvel.x;
                vy = rvel.y;
                placed = true;
                slot.srcInfo = { src: 'real', off: 0, q: 0, idx: 0 };
            } else if (th) {
                var q = opt.tGlobal - (th.anchorOffset || 0);
                qLife = Math.max(0, q);
                if (q >= 0) {
                    var posNow = null, posNext = null, posPrev = null;
                    if (th.track && th.track.length) {
                        var idx = Math.round(q / FRAME);
                        if (idx >= 0 && idx < th.track.length) {
                            var s0 = th.track[idx];
                            if (s0 && s0.alive !== false) {
                                posNow = { x: s0.x, y: s0.y };
                                if (idx + 1 < th.track.length) {
                                    var s1 = th.track[idx + 1];
                                    if (s1 && s1.alive !== false) {
                                        posNext = { x: s1.x, y: s1.y };
                                    } else {
                                        // 未来帧已死亡/不可用：飞出可用轨迹，不摆弹。
                                        posNow = null;
                                    }
                                } else if (idx > 0) {
                                    // 当前就是轨迹最后一帧且 alive：用最后两帧差分
                                    // 保留当前速度方向（前向），不得反向。
                                    s1 = th.track[idx - 1];
                                    if (s1 && s1.alive !== false) {
                                        posPrev = { x: s1.x, y: s1.y };
                                    } else {
                                        posNow = null;
                                    }
                                } else {
                                    // 只有一帧轨迹，无法取未来方向，不摆弹。
                                    posNow = null;
                                }
                            }
                        }
                    } else if (th.path && th.speed > 0 && tactics && tactics.positionOnProjectilePath) {
                        // 与 bulletPosAt 同口径：超过折线总长后子弹应视为消失。
                        var pathLen = 0;
                        for (var pi = 0; pi < th.path.length - 1; pi++) {
                            var pdx = th.path[pi + 1].x - th.path[pi].x;
                            var pdy = th.path[pi + 1].y - th.path[pi].y;
                            pathLen += Math.sqrt(pdx * pdx + pdy * pdy);
                        }
                        // 必须能取到 q + FRAME 的未来位置才摆弹；末端不得回退用过去帧。
                        if ((q + FRAME) * th.speed <= pathLen + 0.05) {
                            posNow = tactics.positionOnProjectilePath(th.path, th.speed, q);
                            if (posNow) {
                                posNext = tactics.positionOnProjectilePath(th.path, th.speed, q + FRAME);
                                if (!posNext) posNow = null;
                            }
                        }
                    }
                    if (posNow) {
                        slot.srcInfo = {
                            src: (th.track && th.track.length) ? 'track' : 'path',
                            off: (th.anchorOffset || 0),
                            q: q,
                            idx: Math.round(q / FRAME)
                        };
                        slot.body.SetPositionAndAngle(
                            Box2D.Common.Math.b2Vec2.Make(posNow.x, posNow.y), rb.GetAngle());
                        var dirX = 0, dirY = 0;
                        if (posNext) {
                            dirX = posNext.x - posNow.x;
                            dirY = posNext.y - posNow.y;
                        } else if (posPrev) {
                            // 轨迹最后一帧：方向 = 最后两帧前向差分。
                            dirX = posNow.x - posPrev.x;
                            dirY = posNow.y - posPrev.y;
                        }
                        var dirLen = Math.sqrt(dirX * dirX + dirY * dirY);
                        if (dirLen > 1e-8) {
                            var spd = th.speed > 0 ? th.speed : rvel.Length();
                            vx = dirX / dirLen * spd;
                            vy = dirY / dirLen * spd;
                        } else {
                            vx = rvel.x;
                            vy = rvel.y;
                        }
                        placed = true;
                    }
                }
            }
            if (!placed) {
                // v38：**不允许静默丢弹**。方向只有两个：
                //   ① 有威胁条目但轨迹/折线取不到位 → 用"真实弹体位姿 + 真实速度"
                //      从"现在"前推到本节点起点（tGlobal），近似摆进融合世界；
                //      弹是直线飞行，短程前推与真实基本一致，远比"当它不存在"安全。
                //   ② 连威胁条目都没有 → 也按真实位姿摆，但单独计数（威胁表漏弹）。
                var advFrames = 0;
                if (opt.tGlobal > 0) {
                    var nowTg = (typeof opt.nowTGlobal === 'number' && isFinite(opt.nowTGlobal))
                        ? opt.nowTGlobal : 0;
                    advFrames = Math.max(0, Math.round((opt.tGlobal - nowTg) / FRAME));
                }
                try {
                    var fpx = rpos.x + rvel.x * advFrames * FRAME;
                    var fpy = rpos.y + rvel.y * advFrames * FRAME;
                    slot.body.SetPositionAndAngle(
                        Box2D.Common.Math.b2Vec2.Make(fpx, fpy), rb.GetAngle());
                    slot.body.SetLinearVelocity(Box2D.Common.Math.b2Vec2.Make(rvel.x, rvel.y));
                    slot.body.SetAngularVelocity(rb.GetAngularVelocity());
                    slot.body.SetActive(true);
                    slot.body.SetAwake(true);
                    slot.lastRound = fc.round;
                    slot.initialSpeed = rvel.Length();
                    slot.lifeTotal = (typeof pr.lifetime === 'number') ? pr.lifetime : 10;
                    slot.lifeAge = pr.getTimeAlive ? pr.getTimeAlive() : 0;
                    slot.lifeLeft = Math.max(0, slot.lifeTotal - slot.lifeAge - qLife);
                    slot.active = slot.initialSpeed > 0 && slot.lifeLeft > 0;
                    if (!slot.active) { slot.body.SetActive(false); continue; }
                    slot.srcInfo = { src: 'approx', off: 0, q: qLife, idx: advFrames };
                    if (th) _fusedDropStats.approxPlaced++;
                    else _fusedDropStats.noThreat++;
                    fusedDropLog('id=' + (pr.id !== undefined ? pr.id : '?') +
                        ' 原因=' + (th ? (th.track ? 'track取不到位' : '无track且折线越界/缺失') : '威胁表无此弹') +
                        ' 前推=' + advFrames + '帧 tGlobal=' + opt.tGlobal);
                    continue;
                } catch (ePlace) {
                    _fusedDropStats.skipped++;
                    fusedDropLog('id=' + (pr.id !== undefined ? pr.id : '?') + ' 近似摆放也失败: ' + ePlace);
                    slot.body.SetActive(false);
                    slot.lastRound = -1;
                    continue;
                }
            }
            slot.body.SetActive(true);
            slot.body.SetLinearVelocity(Box2D.Common.Math.b2Vec2.Make(vx, vy));
            slot.body.SetAngularVelocity(rb.GetAngularVelocity());
            slot.body.SetAwake(true);
            slot.initialSpeed = Math.sqrt(vx * vx + vy * vy);
            slot.lifeTotal = (typeof pr.lifetime === 'number') ? pr.lifetime : 10;
            slot.lifeAge = pr.getTimeAlive ? pr.getTimeAlive() : 0;
            slot.lifeLeft = Math.max(0, slot.lifeTotal - slot.lifeAge - qLife);
            slot.active = slot.initialSpeed > 0 && slot.lifeLeft > 0;
            if (!slot.active) slot.body.SetActive(false);
        }
        parkUnusedFusedBullets(fc);

        var samples = [], dead = [], deathFrame = [], speeds = [], rotSpds = [];
        for (i = 0; i < operations.length; i++) {
            samples.push([]);
            dead.push(false);
            deathFrame.push(-1);
            speeds.push(0);
            rotSpds.push(0);
        }

        var snapFwd = me.forward, snapBack = me.back,
            snapLeft = me.left, snapRight = me.right,
            snapSpeed = me.speed, snapRotSpd = me.rotationSpeed;
        var locked = !!me.locked;

        for (k = 0; k <= durationFrames; k++) {
            for (i = 0; i < operations.length; i++) {
                var cb2 = fc.candidates[i];
                samples[i].push({
                    t: k * FRAME,
                    x: cb2.GetPosition().x,
                    y: cb2.GetPosition().y,
                    rot: cb2.GetAngle()
                });
            }
            // v39：逐帧轨迹导出（只在调用方显式给 opt.trace 时；用于和真实弹位逐帧对拍，
            // 定位"预测用的弹药状态比真实物理慢几帧"这类时间错位）。
            if (opt.trace && samples[0] && samples[0].length) {
                var tSm = samples[0][samples[0].length - 1];
                var tb = [];
                for (i = 0; i < fc.bulletSlots.length; i++) {
                    var ts = fc.bulletSlots[i];
                    if (!ts || !ts.body || !ts.body.IsActive() || ts.lastRound !== fc.round) continue;
                    var tp = ts.body.GetPosition();
                    var si = ts.srcInfo || {};
                    tb.push({
                        id: ts.pid,
                        x: Math.round(tp.x * 100) / 100,
                        y: Math.round(tp.y * 100) / 100,
                        src: si.src || null,
                        off: si.off,
                        q: si.q,
                        idx: si.idx
                    });
                }
                if (k === 0) {
                    var h0 = { tGlobal: (typeof opt.tGlobal === 'number') ? opt.tGlobal : 0,
                               nowTGlobal: (typeof opt.nowTGlobal === 'number') ? opt.nowTGlobal : 0,
                               segStartAbs: null };
                    opt.trace.header = h0;   // v122：本次 rollout 的时间基准
                }
                opt.trace.push({
                    k: k,
                    x: Math.round(tSm.x * 100) / 100,
                    y: Math.round(tSm.y * 100) / 100,
                    bs: tb
                });
            }
            if (k >= durationFrames) break;

            for (i = 0; i < operations.length; i++) {
                if (dead[i]) {
                    speeds[i] = 0;
                    rotSpds[i] = 0;
                    continue;
                }
                me.forward = !!operations[i].inputs.forward;
                me.back = !!operations[i].inputs.back;
                me.left = !!operations[i].inputs.left;
                me.right = !!operations[i].inputs.right;
                if (locked) {
                    speeds[i] = 0;
                    rotSpds[i] = 0;
                } else {
                    me._computeSpeed();
                    me._computeRotationSpeed();
                    speeds[i] = me.speed;
                    rotSpds[i] = me.rotationSpeed;
                }
            }
            me.forward = snapFwd; me.back = snapBack;
            me.left = snapLeft; me.right = snapRight;
            me.speed = snapSpeed; me.rotationSpeed = snapRotSpd;

            for (i = 0; i < operations.length; i++) {
                var cb3 = fc.candidates[i];
                var a = cb3.GetAngle();
                cb3.SetLinearVelocity(Box2D.Common.Math.b2Vec2.Make(
                    Math.sin(a) * speeds[i], -Math.cos(a) * speeds[i]));
                cb3.SetAngularVelocity(rotSpds[i]);
            }

            fc.world.Step(FRAME, 10, 10);

            for (i = 0; i < fc.bulletSlots.length; i++) {
                var bs = fc.bulletSlots[i];
                if (bs.lastRound !== fc.round || !bs.body.IsActive()) continue;
                bs.lifeLeft -= FRAME;
                if (bs.lifeLeft <= 0) {
                    bs.active = false;
                    bs.body.SetActive(false);
                    continue;
                }
                var bv = bs.body.GetLinearVelocity();
                var blen = bv.Length();
                if (blen === 0) {
                    bs.active = false;
                    bs.body.SetActive(false);
                    continue;
                }
                var blenSq = blen * blen;
                var binitSq = bs.initialSpeed * bs.initialSpeed;
                if (Math.abs(blenSq - binitSq) > 0.01) {
                    bv.Multiply(bs.initialSpeed / blen);
                    bs.body.SetLinearVelocity(bv);
                }
            }

            var contact = fc.world.GetContactList();
            while (contact) {
                if (contact.IsTouching()) {
                    var fixA = contact.GetFixtureA();
                    var fixB = contact.GetFixtureB();
                    var udA = fixA.GetUserData();
                    var udB = fixB.GetUserData();
                    var sensorUd = null;
                    var otherCat = 0;
                    if (udA && udA.type === 'fusedSensor') {
                        sensorUd = udA;
                        otherCat = fixB.GetFilterData().categoryBits;
                    } else if (udB && udB.type === 'fusedSensor') {
                        sensorUd = udB;
                        otherCat = fixA.GetFilterData().categoryBits;
                    }
                    if (sensorUd && otherCat === Constants.COLLISION_CATEGORIES.PROJECTILE) {
                        var op = sensorUd.opIndex;
                        if (op >= 0 && op < dead.length && !dead[op]) {
                            dead[op] = true;
                            deathFrame[op] = k + 1;
                        }
                    }
                }
                contact = contact.GetNext();
            }
        }

        me.forward = snapFwd; me.back = snapBack;
        me.left = snapLeft; me.right = snapRight;
        me.speed = snapSpeed; me.rotationSpeed = snapRotSpd;

        var results = [];
        for (i = 0; i < operations.length; i++) {
            results.push({
                samples: samples[i],
                hitWall: false,
                dead: dead[i],
                deathFrame: deathFrame[i]
            });
        }
        return results;
    }

    // ============================================================
    // Box2D 克隆世界（死亡判定用，草稿纸模式）
    // ============================================================
    var _deathWorld = null;
    var _deathTankBody = null;
    var _deathBulletBodies = [];

    function ensureDeathWorld(consts) {
        if (_deathWorld) return;
        _deathWorld = new Box2D.Dynamics.b2World(
            new Box2D.Common.Math.b2Vec2(0, 0), true
        );
        // 坦克体：矩形车体 + 炮塔（与游戏 createTankBody 同款）
        var tankBodyDef = new Box2D.Dynamics.b2BodyDef();
        tankBodyDef.type = Box2D.Dynamics.b2Body.b2_dynamicBody;
        tankBodyDef.active = true;
        tankBodyDef.allowSleep = false;
        _deathTankBody = _deathWorld.CreateBody(tankBodyDef);

        // 车体矩形
        var baseFixture = new Box2D.Dynamics.b2FixtureDef();
        baseFixture.shape = new Box2D.Collision.Shapes.b2PolygonShape.AsBox(
            consts.TANK_HALF_WIDTH, consts.TANK_HALF_HEIGHT
        );
        baseFixture.density = 1.0;
        baseFixture.userData = { type: 'tankBase' };
        _deathTankBody.CreateFixture(baseFixture);

        // 炮塔矩形（前伸）——顶点顺序与游戏 _createBulletTurretFixtureDefs 完全一致
        // （绕序错误会导致 Box2D 法线朝内、碰撞失效，2026-08-09 实测踩坑）
        var turretFixture = new Box2D.Dynamics.b2FixtureDef();
        var tw = consts.TURRET_WIDTH / 2;
        var th = consts.TURRET_HEIGHT / 2;
        var oy = consts.TURRET_OFFSET_Y;
        var verts = [
            Box2D.Common.Math.b2Vec2.Make(tw, oy + th),
            Box2D.Common.Math.b2Vec2.Make(-tw, oy + th),
            Box2D.Common.Math.b2Vec2.Make(-tw, oy - th),
            Box2D.Common.Math.b2Vec2.Make(tw, oy - th)
        ];
        turretFixture.shape = new Box2D.Collision.Shapes.b2PolygonShape.AsArray(verts);
        turretFixture.density = 0.0;
        turretFixture.userData = { type: 'tankTurret' };
        _deathTankBody.CreateFixture(turretFixture);

        // 子弹体池（v21：20→64，全部入检不再按下标截断）
        for (var i = 0; i < 64; i++) {
            var bulletBodyDef = new Box2D.Dynamics.b2BodyDef();
            bulletBodyDef.type = Box2D.Dynamics.b2Body.b2_dynamicBody;
            bulletBodyDef.active = true;
            bulletBodyDef.allowSleep = false;
            var bb = _deathWorld.CreateBody(bulletBodyDef);
            var bf = new Box2D.Dynamics.b2FixtureDef();
            bf.shape = new Box2D.Collision.Shapes.b2CircleShape(consts.BULLET_RADIUS);
            bf.density = 0.01;
            bf.restitution = 1.0;
            bf.userData = { type: 'bullet' };
            bb.CreateFixture(bf);
            _deathBulletBodies.push(bb);
        }
    }

    /**
     * 死亡判定（游戏同源 Box2D 接触检测）
     * 纯函数式：输入坦克位姿 + 子弹位置集合，输出是否死亡
     * 草稿纸模式：每次调用前重置位姿，Step 后检查接触
     *
     * @param {Object} tankState - {x, y, rot}
     * @param {Array} bulletPositions - [{x, y}, ...]
     * @param {Object} consts - 常量表
     * @returns {boolean} 是否死亡
     */
    function checkDeath(tankState, bulletPositions, consts) {
        ensureDeathWorld(consts);

        // v22 性能预筛：若没有子弹中心落在“坦克最远夹具半径 + 子弹半径”内，
        // 静态重叠检测不可能有接触，直接返回 false，省掉死亡世界 Step。
        // 这是纯粗筛：只跳过“几何上不可能死亡”的情况，命中区仍走原 Box2D 判定。
        var preR = (consts && typeof consts.DEATH_PREFILTER_RADIUS === 'number')
            ? consts.DEATH_PREFILTER_RADIUS : 4.0;
        var preR2 = preR * preR;
        var anyNear = false;
        for (var bi = 0; bi < bulletPositions.length; bi++) {
            var bdx = bulletPositions[bi].x - tankState.x;
            var bdy = bulletPositions[bi].y - tankState.y;
            if (bdx * bdx + bdy * bdy <= preR2) { anyNear = true; break; }
        }
        if (!anyNear) return false;

        // 重置坦克位姿
        _deathTankBody.SetPositionAndAngle(
            new Box2D.Common.Math.b2Vec2(tankState.x, tankState.y),
            tankState.rot
        );

        // 重置子弹位置（v21：池 20→64——旧池按下标截断，第 21 颗起在
        // 检测世界里完全不存在，弹多的场景 AI 以为自己安全，真实世界
        // 却被这些没进沙箱的弹杀死。现全部入检，判定逻辑不变。）
        var n = Math.min(bulletPositions.length, _deathBulletBodies.length);
        for (var i = 0; i < n; i++) {
            _deathBulletBodies[i].SetActive(true);
            _deathBulletBodies[i].SetPosition(
                new Box2D.Common.Math.b2Vec2(bulletPositions[i].x, bulletPositions[i].y)
            );
        }
        // 多余的子弹体设为不活跃
        for (var j = n; j < _deathBulletBodies.length; j++) {
            _deathBulletBodies[j].SetActive(false);
        }

        // Step 一帧（极小步长，只为生成接触）
        _deathWorld.Step(0.001, 1, 1);

        // 检查接触
        var contact = _deathWorld.GetContactList();
        while (contact) {
            if (contact.IsTouching()) {
                var fixtureA = contact.GetFixtureA();
                var fixtureB = contact.GetFixtureB();
                var udA = fixtureA.GetUserData();
                var udB = fixtureB.GetUserData();
                // 坦克-子弹接触 = 死亡
                if ((udA && udA.type && udA.type.indexOf('tank') === 0 && udB && udB.type === 'bullet') ||
                    (udB && udB.type && udB.type.indexOf('tank') === 0 && udA && udA.type === 'bullet')) {
                    return true;
                }
            }
            contact = contact.GetNext();
        }
        return false;
    }

    // ============================================================
    // 记录钩子（黄金测试 + NN 训练数据收集）
    // ============================================================
    var _recording = false;
    var _recordBuffer = [];

    function startRecording() {
        _recording = true;
        _recordBuffer = [];
    }

    function stopRecording() {
        _recording = false;
        return _recordBuffer;
    }

    function recordFrame(data) {
        if (_recording) {
            _recordBuffer.push(data);
        }
    }

    // ============================================================
    // SandboxAdapter 工厂函数
    // ============================================================
    /**
     * 创建 SandboxAdapter 实例
     * @param {Object} gameController - 游戏的 GameController 实例
     * @param {string} aiId - AI 的玩家 ID
     * @returns {Object} SandboxAdapter 接口
     */
    function createVantageAdapter(gameController, aiId) {
        var consts = buildConstants();

        var adapter = {
            // —— 常量 ——
            constants: consts,

            // —— 操作定义 ——
            operations: OPERATIONS,

            // —— 数据获取 ——
            getTankState: function() {
                var tank = gameController.getTank(aiId);
                if (!tank) return null;
                return { x: tank.getX(), y: tank.getY(), rot: tank.getRotation() };
            },

            getProjectiles: function() {
                var result = [];
                var projectiles = gameController.getProjectiles();
                for (var id in projectiles) {
                    var p = projectiles[id];
                    if (!p) continue;
                    if (p.done && p.done()) continue;
                    var body = p.getB2DBody ? p.getB2DBody() : null;
                    if (!body || (body.IsActive && !body.IsActive())) continue;
                    var speed = body ? body.GetLinearVelocity().Length() : consts.BULLET_SPEED;
                    result.push({
                        id: id,
                        x: p.getX(),
                        y: p.getY(),
                        speed: speed,
                        speedX: p.getSpeedX ? p.getSpeedX() : 0,
                        speedY: p.getSpeedY ? p.getSpeedY() : 0
                    });
                }
                return result;
            },

            getMaze: function() {
                return gameController.getMaze();
            },

            getB2DWorld: function() {
                return gameController.getB2DWorld();
            },

            /**
             * 批量取当前所有子弹的反射折线（评分/基准时间的数据源）
             * @param {number} bounces - 最大反弹次数
             * @param {number} maxLen - 单条折线最大长度（米）
             * @returns {Array} [{id, path:[{x,y}...], speed, x, y}...]
             */
            getProjectilePaths: function(bounces, maxLen) {
                var result = [];
                var projectiles = gameController.getProjectiles();
                var world = gameController.getB2DWorld();
                for (var id in projectiles) {
                    var p = projectiles[id];
                    if (!p) continue;
                    if (p.done && p.done()) continue;
                    var body = p.getB2DBody ? p.getB2DBody() : null;
                    if (!body || (body.IsActive && !body.IsActive())) continue;
                    var vel = body ? body.GetLinearVelocity() : null;
                    var speed = vel ? vel.Length() : consts.BULLET_SPEED;
                    var pathInfo = B2DUtils.calculateProjectilePath(world, p, bounces, maxLen, false);
                    var rawPath = pathInfo ? pathInfo.path : [];
                    // v17：立即深拷贝成 {x,y} 快照。
                    // B2DUtils.calculatePath 的 path[0] 是 b2body.GetPosition()
                    // 的活引用（未 Copy），锚定跨帧使用会跟着真实子弹一起跑，
                    // bulletPosAt 变成 2 倍弹速漂移（2026-08-16 JSON 实测）。
                    var path = [];
                    for (var pi = 0; pi < rawPath.length; pi++) {
                        path.push({ x: rawPath[pi].x, y: rawPath[pi].y });
                    }
                    // v7.3 折线健康校验（主人实测"旧反弹点指向子弹位置"）：
                    // 折线首段必须沿子弹物理速度方向（点积>0）。瞬态帧（模型
                    // 位置/物理位置在反弹瞬间不同步）产生的畸形折线整条丢弃，
                    // 不进渲染也不进评分（下帧自然恢复）。
                    if (path.length >= 2 && vel && speed > 0) {
                        var d0x = path[1].x - path[0].x, d0y = path[1].y - path[0].y;
                        var segLen = Math.sqrt(d0x * d0x + d0y * d0y);
                        if (segLen > 1e-6 && (d0x * vel.x + d0y * vel.y) / (segLen * speed) < 0.1) {
                            path = [];
                        }
                    }
                    result.push({
                        id: id,
                        path: path,
                        speed: speed,
                        // 位置统一与折线起点同源（物理体位置）——黄圈/威胁表/
                        // 评分的"子弹当前位置"不再用模型 getX（反弹瞬间两源
                        // 错位 = 视觉"旧反弹点连到子弹"的来源之一）
                        x: path.length ? path[0].x : p.getX(),
                        y: path.length ? path[0].y : p.getY()
                    });
                }
                return result;
            },

            // —— 物理模拟 ——
            /**
             * 坦克运动模拟（v6：拷贝区5 私有克隆世界，全原版流程）
             * 墙/坦克/子弹克隆体 + Tank.update 同款驱动 + 原版 Step 参数。
             * 不碰真实世界的任何 body。
             * @param {Object} state - {x, y, rot} 初始位姿
             * @param {Object} inputs - {forward, back, left, right}
             * @param {number} durationFrames - 模拟帧数
             * @param {Object} opt - {startPose, threats, tGlobal}（树节点语义）
             * @returns {Object} {samples, hitWall, dead, deathFrame}
             */
            simulateTank: function(state, inputs, durationFrames, opt) {
                opt = opt || {};
                if (!opt.startPose) opt.startPose = state;
                return simulateTankClone(gameController, aiId, inputs, durationFrames, opt);
            },

            /**
             * 批量坦克运动模拟（单世界融合路径）。
             * 开关关闭/世界不可用时返回 null，调用方回退旧路径。
             */
            simulateTankBatch: function(state, operations, durationFrames, opt) {
                opt = opt || {};
                if (!opt.startPose) opt.startPose = state;
                if (RUST_PHYSICS_ENABLED) {
                    try {
                        var rustBatch = simulateRustBatch(gameController, aiId, operations, durationFrames, opt);
                        if (rustBatch) {
                            // v32：Rust 物理预测的死亡帧只是候选；打标后由
                            // scorePaths 透传，树在最终执行路线上做 JS 融合确认。
                            for (var ri = 0; ri < rustBatch.length; ri++) {
                                rustBatch[ri].rustPhysics = true;
                            }
                            return rustBatch;
                        }
                    } catch (eRust) {
                        console.warn('[VantageSandbox] Rust 物理预测失败，回退融合世界:', eRust);
                    }
                }
                return simulateFusedBatch(gameController, aiId, operations, durationFrames, opt);
            },

            /**
             * v33：九操作 Rust 评分路径（ABI v6 vt_score_paths）。
             * 一次调用同时完成 Rust 融合世界坦克模拟（samples/候选死亡帧）
             * 与 f64 遮蔽角评分。仅支持默认安全配置：lane=0 且弹簧绳关闭；
             * 任何失败/不支持都返回 null，由 tree.rolloutNine 静默回退
             * VantageScoring.scorePaths（JS 融合路径）。
             */
            // v38：融合世界摆放弹药的统计（树侧每帧记录 + 响度检查用）
            getFusedDropStats: function() {
                return {
                    approxPlaced: _fusedDropStats.approxPlaced,
                    noThreat: _fusedDropStats.noThreat,
                    skipped: _fusedDropStats.skipped,
                    lastDetail: _fusedDropStats.lastDetail
                };
            },
            simulateTankBatchScored: function(state, operations, durationFrames, opt) {
                if (!RUST_PHYSICS_ENABLED || !FUSED_ENABLED) return null;
                if (durationFrames > 75) return null;
                if (!global.VantageRustBridge || !global.VantageRustBridge._ready) return null;
                opt = opt || {};
                var cfg = opt.cfg || {};
                if (cfg.springRopeEnabled) return null;
                if (typeof cfg.lanePenaltyRatio === 'number' && cfg.lanePenaltyRatio > 0) return null;
                if (!opt.startPose) opt.startPose = state;

                var fc = getFusedWorld(gameController, aiId);
                if (!fc || !fc.wallShapes) return null;

                var fused0 = simulateFusedBatch(gameController, aiId, operations, 0, opt);
                if (!fused0 || fused0.length !== operations.length) return null;

                var me = gameController.getTank(aiId);
                if (!me || !me.getB2DBody || !me.getB2DBody()) return null;

                var bullets = [];
                for (var bi = 0; bi < fc.bulletSlots.length; bi++) {
                    var slot = fc.bulletSlots[bi];
                    if (slot.lastRound !== fc.round || !slot.body || !slot.body.IsActive() || !slot.active) continue;
                    var bpos = slot.body.GetPosition();
                    var bvel = slot.body.GetLinearVelocity();
                    bullets.push({
                        x: bpos.x,
                        y: bpos.y,
                        vx: bvel.x,
                        vy: bvel.y,
                        radius: slot.radius,
                        lifeLeft: slot.lifeLeft,
                        active: true
                    });
                }

                var opCalc = computeRustOperationSpeeds(me, operations, !!me.locked);
                var rustOps = [];
                for (var oi = 0; oi < operations.length; oi++) {
                    var inputs = operations[oi].inputs || operations[oi];
                    rustOps.push({
                        speed: opCalc.speeds[oi],
                        rotationSpeed: opCalc.rotationSpeeds[oi],
                        moving: !!(inputs.forward || inputs.back || inputs.left || inputs.right)
                    });
                }

                var threats = opt.threats || [];
                var bridgeThreats = [];
                for (var ti = 0; ti < threats.length; ti++) {
                    var th = threats[ti];
                    if (!th) return null;
                    var bth = {
                        speed: th.speed || 0,
                        anchorOffset: th.anchorOffset || 0
                    };
                    if (th.track) {
                        if (!Array.isArray(th.track)) return null;
                        bth.track = [];
                        for (var tfi = 0; tfi < th.track.length; tfi++) {
                            var tf = th.track[tfi];
                            if (!tf) return null;
                            bth.track.push({ x: tf.x, y: tf.y, alive: tf.alive !== false });
                        }
                    }
                    if (th.path) {
                        if (!Array.isArray(th.path)) return null;
                        bth.path = [];
                        for (var pi = 0; pi < th.path.length; pi++) {
                            var pp = th.path[pi];
                            if (!pp) return null;
                            bth.path.push({ x: pp.x, y: pp.y });
                        }
                    }
                    bridgeThreats.push(bth);
                }

                var defaults = (global.VantageScoring && global.VantageScoring.DEFAULTS) || {};
                var deathPenalty = (cfg.deathPenalty !== undefined) ? cfg.deathPenalty
                    : ((defaults.deathPenalty !== undefined) ? defaults.deathPenalty : 0);
                var stuckPenalty = (cfg.stuckPenalty !== undefined) ? cfg.stuckPenalty
                    : ((defaults.stuckPenalty !== undefined) ? defaults.stuckPenalty : 4.0);
                var stuckDistEps = (cfg.stuckDistEps !== undefined) ? cfg.stuckDistEps
                    : ((defaults.stuckDistEps !== undefined) ? defaults.stuckDistEps : 0.05);
                var stuckRotEps = (cfg.stuckRotEps !== undefined) ? cfg.stuckRotEps
                    : ((defaults.stuckRotEps !== undefined) ? defaults.stuckRotEps : 0.05);
                var lanePenaltyRatio = (cfg.lanePenaltyRatio !== undefined) ? cfg.lanePenaltyRatio
                    : ((defaults.lanePenaltyRatio !== undefined) ? defaults.lanePenaltyRatio : 0);

                var bridgeResult;
                try {
                    bridgeResult = global.VantageRustBridge.scorePaths({
                        cacheId: hashAiIdForRustCache(aiId),
                        startPose: opt.startPose,
                        startT: (typeof opt.tGlobal === 'number') ? opt.tGlobal : 0,
                        ops: rustOps,
                        walls: fc.wallShapes,
                        bullets: bullets,
                        frames: durationFrames,
                        threats: bridgeThreats,
                        cfg: {
                            deathPenalty: deathPenalty,
                            stuckPenalty: stuckPenalty,
                            stuckDistEps: stuckDistEps,
                            stuckRotEps: stuckRotEps,
                            lanePenaltyRatio: lanePenaltyRatio,
                            springRopeEnabled: !!cfg.springRopeEnabled,
                            occlusionEnabled: cfg.occlusionEnabled !== false
                        }
                    });
                } catch (eScored) {
                    console.warn('[VantageSandbox] Rust 评分路径调用失败，回退 JS scorePaths:', eScored);
                    return null;
                }
                if (!bridgeResult || bridgeResult.ok !== true ||
                        !Array.isArray(bridgeResult.results) ||
                        bridgeResult.results.length !== operations.length) {
                    console.warn('[VantageSandbox] Rust 评分路径结果无效，回退 JS scorePaths:', bridgeResult && bridgeResult.error);
                    return null;
                }
                for (var ri2 = 0; ri2 < bridgeResult.results.length; ri2++) {
                    var rr = bridgeResult.results[ri2];
                    if (!rr || rr.ok !== true || !Array.isArray(rr.samples) ||
                            rr.samples.length !== durationFrames + 1 ||
                            !Array.isArray(rr.perFrameScores)) {
                        console.warn('[VantageSandbox] Rust 评分路径结果不匹配，回退 JS scorePaths');
                        return null;
                    }
                }

                return bridgeResult.results.map(function (r, idx) {
                    return {
                        samples: r.samples.map(function (s, frame) {
                            return { t: frame * 0.02, x: s.x, y: s.y, rot: s.rot };
                        }),
                        dead: r.deathFrame > 0,
                        deathFrame: r.deathFrame,
                        perFrameScores: r.perFrameScores.slice(),
                        totalScore: r.totalScore,
                        frameCount: r.frameCount,
                        rustPhysics: true,
                        deathAuthority: 'rust-candidate'
                    };
                });
            },


            /**
             * v32：强制 JS 融合世界的批量坦克模拟（不经过 Rust 物理开关）。
             * 供树对最终执行路线做死亡权威确认；不可用时返回 null。
             */
            simulateTankBatchJsFused: function(state, operations, durationFrames, opt) {
                opt = opt || {};
                if (!opt.startPose) opt.startPose = state;
                return simulateFusedBatch(gameController, aiId, operations, durationFrames, opt);
            },

            /**
             * v31：Rust vt_rescore_nodes 增量层刷新（ABI v4）。
             * 对树节点已存储的 rolloutSamples 做纯函数重评分 + 融合传感器/
             * CCD 死亡验证，不重新模拟坦克物理。仅在 Rust 物理开关开启、
             * 融合世界存在且 Rust 桥就绪时启用；任何失败都返回 null，
             * 由树回退 VantageScoring.scorePaths（JS 融合路径）。
             * @param {Array} [pendingThreats] 本 tick 新增的 threat 列表；
             *   缺省时所有 threat 视为旧弹（isNew=false，全量刷新）。
             */
            rescoreTankSamples: function(nodes, threats, cfg, pendingThreats) {
                if (!RUST_PHYSICS_ENABLED || !FUSED_ENABLED) return null;
                if (!global.VantageRustBridge || !global.VantageRustBridge._ready) return null;
                if (!Array.isArray(nodes) || nodes.length < 1 || nodes.length > 512) return null;
                if (!Array.isArray(threats)) return null;

                var fc = getFusedWorld(gameController, aiId);
                if (!fc || !fc.wallShapes) return null;

                var pendingIds = {};
                if (Array.isArray(pendingThreats)) {
                    for (var pti = 0; pti < pendingThreats.length; pti++) {
                        var pth = pendingThreats[pti];
                        if (pth && pth.id !== undefined && pth.id !== null) {
                            pendingIds[String(pth.id)] = true;
                        }
                    }
                }

                var bridgeThreats = [];
                var ti, tfi, pi;
                for (ti = 0; ti < threats.length; ti++) {
                    var th = threats[ti];
                    if (!th) return null;
                    var bth = {
                        speed: th.speed || 0,
                        anchorOffset: th.anchorOffset || 0,
                        bulletRadius: 0.25,
                        lifeLeftSeconds: 10,
                        isNew: !!(pendingIds[String(th.id)] === true)
                    };
                    if (th.track) {
                        if (!Array.isArray(th.track)) return null;
                        bth.track = [];
                        for (tfi = 0; tfi < th.track.length; tfi++) {
                            var f = th.track[tfi];
                            if (!f) return null;
                            bth.track.push({ x: f.x, y: f.y, alive: f.alive !== false });
                        }
                    }
                    if (th.path) {
                        if (!Array.isArray(th.path)) return null;
                        bth.path = [];
                        for (pi = 0; pi < th.path.length; pi++) {
                            var p = th.path[pi];
                            if (!p) return null;
                            bth.path.push({ x: p.x, y: p.y });
                        }
                    }
                    var projectiles = gameController.getProjectiles();
                    var prj = projectiles ? projectiles[th.id] : null;
                    if (prj) {
                        try {
                            var prb = prj.getB2DBody ? prj.getB2DBody() : null;
                            var shape = prb ? prb.GetFixtureList().GetShape() : null;
                            if (shape && typeof shape.m_radius === 'number') {
                                bth.bulletRadius = shape.m_radius;
                            }
                        } catch (eRadius) {}
                        if (typeof prj.lifetime === 'number' && typeof prj.getTimeAlive === 'function') {
                            bth.lifeLeftSeconds = Math.max(0, prj.lifetime - prj.getTimeAlive());
                        }
                    }
                    bridgeThreats.push(bth);
                }

                var bridgeNodes = [];
                for (var bni = 0; bni < nodes.length; bni++) {
                    var bn = {
                        samples: nodes[bni].samples,
                        moving: nodes[bni].moving,
                        startT: nodes[bni].startT,
                        frames: nodes[bni].frames
                    };
                    if (nodes[bni].previousScores !== undefined && nodes[bni].previousScores !== null) {
                        bn.previousScores = nodes[bni].previousScores;
                        if (nodes[bni].previousDeathFrame !== undefined && nodes[bni].previousDeathFrame !== null) {
                            bn.previousDeathFrame = nodes[bni].previousDeathFrame;
                        }
                    }
                    bridgeNodes.push(bn);
                }

                var bridgeResult;
                try {
                    bridgeResult = global.VantageRustBridge.rescoreNodes({
                        cacheId: hashAiIdForRustCache(aiId),
                        walls: fc.wallShapes,
                        nodes: bridgeNodes,
                        threats: bridgeThreats,
                        cfg: cfg || {}
                    });
                } catch (eRescore) {
                    console.warn('[VantageSandbox] Rust 增量重评分调用失败，回退 JS 融合路径:', eRescore);
                    return null;
                }
                if (!bridgeResult || bridgeResult.ok !== true ||
                        !bridgeResult.nodes ||
                        bridgeResult.nodes.length !== nodes.length) {
                    console.warn('[VantageSandbox] Rust 增量重评分结果无效，回退 JS 融合路径');
                    return null;
                }

                var mapped = [];
                for (var ni = 0; ni < nodes.length; ni++) {
                    var rn = bridgeResult.nodes[ni];
                    if (!rn || rn.ok !== true) {
                        console.warn('[VantageSandbox] Rust 增量重评分节点 ' + ni + ' 需要回退，改用 JS 融合路径');
                        return null;
                    }
                    var pfs = rn.perFrameScores || [];
                    var frameCount = pfs.length;
                    var incremental = !!(nodes[ni].previousScores !== undefined &&
                        nodes[ni].previousScores !== null);
                    mapped.push({
                        samples: nodes[ni].samples,
                        dead: rn.deathFrame > 0,
                        deathFrame: rn.deathFrame,
                        perFrameScores: pfs.slice(0, frameCount),
                        totalScore: rn.totalScore,
                        frameCount: frameCount,
                        rustCandidate: true,
                        rustIncremental: incremental
                    });
                }
                return mapped;
            },

            /**
             * @param {Object} projectile - 游戏子弹对象
             * @param {number} bounces - 最大反弹次数
             * @param {number} maxLen - 最大路径长度（米）
             * @returns {Array} path 点数组 [{x,y}...]
             */
            bulletPath: function(projectile, bounces, maxLen) {
                var world = gameController.getB2DWorld();
                var pathInfo = B2DUtils.calculateProjectilePath(
                    world, projectile, bounces, maxLen, false
                );
                var rawPath = pathInfo ? pathInfo.path : [];
                // v17：同 getProjectilePaths，必须返回不可变快照。
                var path = [];
                for (var pi = 0; pi < rawPath.length; pi++) {
                    path.push({ x: rawPath[pi].x, y: rawPath[pi].y });
                }
                return path;
            },

            /**
             * bullet-only Box2D 逐帧轨迹（v18）。每颗弹 [{id,type,frames:[{t,x,y,alive}]}]
             * @param {number} durationFrames - 预测帧数（0.02s/帧）
             * @param {Array} [onlyIds] - 可选：只模拟这些 id
             */
            simulateBulletTracks: function(durationFrames, onlyIds) {
                return simulateBulletTracks(gameController, durationFrames, onlyIds);
            },

            /**
             * 按“树滚动帧数 + 当前各弹种真实剩余寿命”给出建议 track 帧数。
             */
            getBulletTrackFrames: function(horizonFrames) {
                return computeBulletTrackFrames(gameController, horizonFrames);
            },

            /**
             * 沿折线按时间取子弹位置（复用 positionOnProjectilePath）
             * @param {Array} path - 反射折线
             * @param {number} speed - 子弹速度
             * @param {number} timeSec - 时间（秒）
             * @returns {Object|null} {x, y} 或 null
             */
            bulletPosAt: function(path, speed, timeSec) {
                var tactics = global.TankTroubleAITactics;
                if (!tactics || !tactics.positionOnProjectilePath) return null;
                if (!path || path.length < 2 || speed <= 0 || timeSec < 0) return null;
                // 超过折线总长度后子弹应视为消失，不能返回折线终点制造“静止幻影弹”。
                var totalLen = 0, pi;
                for (pi = 0; pi < path.length - 1; pi++) {
                    var dx = path[pi + 1].x - path[pi].x;
                    var dy = path[pi + 1].y - path[pi].y;
                    totalLen += Math.sqrt(dx * dx + dy * dy);
                }
                if (timeSec * speed > totalLen + 0.05) return null;
                return tactics.positionOnProjectilePath(path, speed, timeSec);
            },

            // —— 碰撞 / 死亡 ——
            /**
             * 死亡判定（游戏同源 Box2D 接触检测，草稿纸模式）
             * @param {Object} tankState - {x, y, rot}
             * @param {Array} bulletPositions - [{x, y}...]
             * @returns {boolean}
             */
            checkDeath: function(tankState, bulletPositions) {
                return checkDeath(tankState, bulletPositions, consts);
            },

            /**
             * 线段撞墙检测（复用 B2DUtils.checkLineForMazeCollision）
             */
            checkWall: function(p1, p2) {
                var world = gameController.getB2DWorld();
                return B2DUtils.checkLineForMazeCollision(world, p1, p2);
            },

            // —— 记录钩子（黄金测试 + NN 数据收集）——
            startRecording: startRecording,
            stopRecording: stopRecording,
            recordFrame: recordFrame
        };

        return adapter;
    }

    // ============================================================
    // 节点状态辅助（预测树用）
    // ============================================================
    /**
     * 创建节点模拟状态
     * 子弹状态不需每节点存（确定性折线，由全局时间决定）
     * 只存坦克位姿 + 全局时刻
     */
    function createNodeSimState(tankState, tGlobal) {
        return {
            tank: { x: tankState.x, y: tankState.y, rot: tankState.rot },
            tGlobal: tGlobal  // 秒
        };
    }

    /**
     * 从父节点状态 + 操作 → 模拟 → 子节点状态
     * @param {Object} adapter - SandboxAdapter
     * @param {Object} parentSimState - 父节点的 simState
     * @param {Object} inputs - 操作 {forward, back, left, right}
     * @param {number} durationFrames - 模拟帧数
     * @param {Array} bulletPaths - [{path, speed}...] 子弹折线
     * @returns {Object} {simState, dead, deathFrame, samples}
     */
    function simulateNode(adapter, parentSimState, inputs, durationFrames, bulletPaths) {
        var consts = adapter.constants;
        // 坦克运动（v6：拷贝区5 私有克隆世界，全原版流程）
        var sim = adapter.simulateTank(parentSimState.tank, inputs, durationFrames, {
            startPose: parentSimState.tank,
            threats: bulletPaths,
            tGlobal: parentSimState.tGlobal
        });
        var samples = sim.samples;

        // 逐帧死亡检测（折线取子弹位置 + 克隆世界 checkDeath，唯一权威）
        var dead = false;
        var deathFrame = -1;
        for (var i = 0; i < samples.length; i++) {
            var s = samples[i];
            var tGlobal = parentSimState.tGlobal + s.t;
            var bulletPositions = [];
            for (var b = 0; b < bulletPaths.length; b++) {
                var bp = adapter.bulletPosAt(bulletPaths[b].path, bulletPaths[b].speed, tGlobal);
                if (bp) bulletPositions.push(bp);
            }
            if (bulletPositions.length > 0 && adapter.checkDeath(s, bulletPositions)) {
                dead = true;
                deathFrame = i;
                break;
            }
        }

        // 末态
        var lastSample = samples[samples.length - 1] || parentSimState.tank;
        var childSimState = createNodeSimState(
            { x: lastSample.x, y: lastSample.y, rot: lastSample.rot },
            parentSimState.tGlobal + (lastSample.t || 0)
        );

        return {
            simState: childSimState,
            dead: dead,
            deathFrame: deathFrame,
            hitWall: sim.hitWall,
            samples: samples
        };
    }

    // ============================================================
    // 导出
    // ============================================================
    global.VantageSandbox = {
        createAdapter: createVantageAdapter,
        createNodeSimState: createNodeSimState,
        simulateNode: simulateNode,
        OPERATIONS: OPERATIONS,
        buildConstants: buildConstants,
        fusedEnabled: fusedEnabled,
        setFusedEnabled: setFusedEnabled,
        clearCaches: clearCaches,
        /** v37：把融合世界的墙多边形交出去（外接 AI 复用同一份墙几何，避免"各画一套地图"）。
         *  K（Killfield）就是靠这个看到和 V 完全一致的地图；拿不到就返回 null。 */
        getFusedWallShapes: function(gameController, aiId) {
            try {
                var fc = getFusedWorld(gameController, aiId);
                return (fc && fc.wallShapes) ? fc.wallShapes : null;
            } catch (eWallShapes) { return null; }
        },
        rustPhysicsEnabled: rustPhysicsEnabled,
        setRustPhysicsEnabled: setRustPhysicsEnabled
    };

    console.log('[Vantage Sandbox] 模块已加载（v40：轨迹带摆位基准(real/track/path/approx+offset+下标) + 不静默丢弹（近似摆放+响亮计数）+遮蔽开关接进 Rust（ABI v7）+ 融合世界缓存按 aiId 分槽 + 墙几何外供 + Rust 物理默认开 + vt_score_paths 九操作 Rust 评分 + simulateTankBatchScored + 执行路线 JS 融合确认）');

})(typeof window !== 'undefined' ? window : this);
