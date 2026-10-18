/**
 * Vantage Sandbox — 物理沙箱适配器（阶段①）
 *
 * 2026-10-12 v178（1-4-a 形状签名 + 候选体重建，**只做"武器形状"那一半**）：
 *   炮塔/炮管的判死轮廓不再写死 `BULLET_TURRET`，改成**按当前武器取各自的炮塔常量**
 *   （以游戏自己的 `B2DUtils.updateTankBodyTurret` 分派表 + `Constants.*_TURRET` 为准；
 *   全仓没有 `weapon.getTurretShape()`）。签名 = `w:<武器名>[:launched]`，进两个缓存键
 *   （融合候选体槽 / 克隆世界 / 死亡世界）⟹ **签名变了就整槽重建**（§12.4b）。
 *   取不到武器（旧探针假 GC）⟹ 保持原状炮弹炮塔，逐字节同 v177。
 *   ⛔ 本轮**不碰护盾夹具 / 毒雾 / 道具本体**（那些在等规格）；不碰树 / 评分 / Rust。
 * 2026-10-02 v55（Rust ABI v9：破片语义进 Rust + 弹种标记透传）：
 *   simulateRustBatch / simulateTankBatchScored 的 bullets[] 新增 isShrapnel
 *   （来自 v162/v164 摆位收尾的 slot.isShrapnel）；VantageRustBridge 转成
 *   bullet_is_shrapnel 数组并透传 ABI v9，Rust 逐字复刻 Shrapnel.hitMaze /
 *   Shrapnel.done / Shrapnel.update 不调 _super() 三条语义。
 *   激光射线扫掠、追踪导弹制导本轮未做，原因与卡点见《待查清单》§19。
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
            // ⚠️ v178（1-4-a）起：这 3 个是**遗留 / 炮弹炮塔**那一份（默认武器）；
            //    「按当前武器取各自炮塔」走 weaponTurretShape() 的形状表，
            //    见下面「炮塔形状签名」一节。保留这 3 个字段是为了
            //    ① 取不到武器时的原状回退（逐字节同旧版）② 旧探针读 constants.TURRET_*。
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
    // v178（1-4-a）：炮塔/炮管**形状签名** + 候选体重建（**本轮只做"武器形状"那一半**）
    //
    // 【事实来源 —— 游戏自己的代码，不是猜】
    //   · 炮塔 fixture **只有一个建法**：`B2DUtils.updateTankBodyTurret(b2body, tank, weapon)`
    //     （`game_core/js/b714588dc4621fe104113111ba90b1a7.js` = Constants + B2DUtils）。
    //     它先删掉所有 `userData.type === "turret"` 的夹具，再 `switch (weapon.getType())`：
    //       BULLET      → `_createBulletTurretFixtureDefs`      → 1 块矩形（BULLET_TURRET）
    //       LASER       → `_createLaserTurretFixtureDefs`       → **2 块**（碟 DISH_* + 天线 ANTENNA_*）
    //       DOUBLE_BARREL→`_createDoubleBarrelTurretFixtureDefs`→ 1 块矩形
    //       SHOTGUN     → `_createShotgunTurretFixtureDef`      → 1 块矩形
    //       HOMING_MISSILE→`_createMissileTurretFixtureDef`     → 1 块**五边形**，且**仅当
    //                      `!weapon.getField("launched")`** 才建（发射后炮管 fixture 消失）
    //       GATLING_GUN → `_createGatlingGunTurretFixtureDefs`  → 1 块矩形
    //       MINE        → `break`（**什么都不建 ⟹ 拿地雷时坦克只有 base，没有炮管**）
    //     几何**全部**读 `Constants.<X>_TURRET.*`（px/20 = m），本文件不自己描边。
    //   · **全仓没有 `weapon.getTurretShape()`**（grep 0 条）⟹ 形状表只能来自 Constants + 上面那张分派表。
    //   · 形状改变的 3 个触发点（`updateTankBodyTurret` 的全部调用点）：
    //       ① `RoundModel.setWeaponState`（拾取 / 装填）② `RoundModel.updateWeapon`（**导弹发射后**）
    //       ③ `RoundModel.destroyWeapon`（武器用尽 → 换下一个）。本文件只**读当前武器**，
    //       不复制触发点 —— 读到的形状天然跟着上面 3 条走。
    //
    // 【签名】`w:<武器名>[:launched]`（**护盾位留空**，本轮不做护盾夹具 —— 等规格）。
    //   签名进了两个缓存键（融合候选体槽 / 死亡世界）⟹ **签名变了就整槽重建**（§12.4b）。
    //
    // 【安全阀】任何一步取不到（GC 没有 `getActiveWeapon`、常量表缺失、旧探针的假 GC）
    //   ⟹ 返回 null ⟹ 调用方**保持原状（炮弹炮塔）**，对拍套件逐字节不变。
    // ============================================================

    function _shapeNum(v, dflt) {
        return (v && typeof v.m === 'number') ? v.m : dflt;
    }

    /**
     * 四角（局部坐标），**顶点顺序与游戏 `_create*TurretFixtureDefs` 逐字一致**。
     * ⚠️ 绕序错 → Box2D 法线朝内 → 碰撞失效（2026-08-09 实测踩坑，原注释保留在 ensureDeathWorld）。
     */
    function turretRectPoly(ox, oy, w, h) {
        var hw = w / 2, hh = h / 2;
        return [
            { x: ox + hw, y: oy + hh },
            { x: ox - hw, y: oy + hh },
            { x: ox - hw, y: oy - hh },
            { x: ox + hw, y: oy - hh }
        ];
    }

    /**
     * 按武器类型给炮塔轮廓（**局部坐标，米**；可多块：激光 = 碟 + 天线）。
     * @param {number} type - `Constants.WEAPON_TYPES.*`（BULLET=-1 … GATLING_GUN=5）
     * @param {boolean} launched - 只对 HOMING_MISSILE 有意义（= `weapon.getField("launched")`）
     * @returns {Object|null} `{name, launched, polys:[[{x,y}…]…]}`
     *   ⚠️ `polys = []` 是**真语义**（拿地雷 / 导弹已发射 ⟹ 真没有炮管），不是"取不到"；
     *   `null` = 常量表取不到（调用方走原状）。
     */
    function weaponTurretShape(type, launched) {
        var C = (typeof Constants !== 'undefined') ? Constants : null;
        if (!C || !C.WEAPON_TYPES) return null;
        var W = C.WEAPON_TYPES;
        var launchedFlag = !!launched;
        function mk(name, polys) { return { name: name, launched: launchedFlag, polys: polys }; }
        function rect(key) {
            var T = C[key];
            if (!T || typeof T.WIDTH === 'undefined' || typeof T.HEIGHT === 'undefined') return null;
            return [turretRectPoly(_shapeNum(T.OFFSET_X, 0), _shapeNum(T.OFFSET_Y, 0),
                                   _shapeNum(T.WIDTH, 0), _shapeNum(T.HEIGHT, 0))];
        }
        if (type === W.MINE) return mk('MINE', []);                     // case MINE: break ⟹ 无炮管
        if (type === W.BULLET) {
            var pb = rect('BULLET_TURRET');
            return pb ? mk('BULLET', pb) : null;
        }
        if (type === W.LASER) {
            var L = C.LASER_TURRET;
            if (!L) return null;
            var dish = turretRectPoly(_shapeNum(L.DISH_OFFSET_X, 0), _shapeNum(L.DISH_OFFSET_Y, -1.85),
                                      _shapeNum(L.DISH_WIDTH, 2.0), _shapeNum(L.DISH_HEIGHT, 0.5));
            var ant = turretRectPoly(_shapeNum(L.ANTENNA_OFFSET_X, 0), _shapeNum(L.ANTENNA_OFFSET_Y, -2.0),
                                     _shapeNum(L.ANTENNA_WIDTH, 0.1), _shapeNum(L.ANTENNA_HEIGHT, 1.4));
            return mk('LASER', [dish, ant]);                            // 顺序 = 游戏工厂返回顺序
        }
        if (type === W.DOUBLE_BARREL) {
            var pd = rect('DOUBLE_BARREL_TURRET');
            return pd ? mk('DOUBLE_BARREL', pd) : null;
        }
        if (type === W.SHOTGUN) {
            var ps = rect('SHOTGUN_TURRET');
            return ps ? mk('SHOTGUN', ps) : null;
        }
        if (type === W.GATLING_GUN) {
            var pg = rect('GATLING_GUN_TURRET');
            return pg ? mk('GATLING_GUN', pg) : null;
        }
        if (type === W.HOMING_MISSILE) {
            if (launchedFlag) return mk('HOMING_MISSILE', []);          // 发射后炮塔 fixture 被移除
            var M = C.MISSILE_TURRET;
            if (!M || typeof M.CENTER_HEIGHT === 'undefined' || typeof M.SIDE_HEIGHT === 'undefined') return null;
            var ox = _shapeNum(M.OFFSET_X, 0), oy = _shapeNum(M.OFFSET_Y, -1.95);
            var mw = _shapeNum(M.WIDTH, 0.3), ch = _shapeNum(M.CENTER_HEIGHT, 1.4), sh = _shapeNum(M.SIDE_HEIGHT, 0.4);
            return mk('HOMING_MISSILE', [[
                { x: ox + mw / 2, y: oy + ch / 2 },
                { x: ox - mw / 2, y: oy + ch / 2 },
                { x: ox - mw / 2, y: oy - sh / 2 },
                { x: ox,          y: oy - ch / 2 },
                { x: ox + mw / 2, y: oy - sh / 2 }
            ]]);
        }
        return null;
    }

    /**
     * 形状签名（进缓存键）。null = 形状不可解析（调用方走原状）。
     * v190（G5 · §12.8「护盾也是坦克形状的一部分」）：**把护盾位折进来** —— `|s:<0|1>`。
     *   签名变 ⟹ 融合世界候选体 / 克隆世界整槽重建（1-4-a 那套机制）。
     *   ⚠️ 不折进来就会出现："护盾出现/消失后仍复用旧候选体" ⟹ 判死轮廓与真夹具长期不一致。
     */
    function shapeSignature(shape, shieldOn) {
        if (!shape) return null;
        return 'w:' + shape.name + (shape.launched ? ':launched' : '') + '|s:' + (shieldOn ? 1 : 0);
    }

    // ============================================================
    // v190（G5 · §12.8 / §12.31）：**护盾 fixture 进融合世界**
    //
    // 【规格（权威版 §12.31C，照抄）】
    //   · 护盾 = 坦克周围一圈**真的反弹子弹**的 fixture（`SHIELD` 碰撞类别）——❌ 不是"无敌"
    //   · **已经在场的**子弹撞护盾 → **反弹**（Box2D restitution 做）
    //   · **破片**撞护盾 → **停**（速度乘 0，与碰墙同款）——❌ 不要也做成反弹
    //   · ❌ **不为"自己打出的弹反弹回来打死自己"建模拟**（薛定谔的子弹，§12.31B）
    //
    // 【口径 · 以游戏自己的源码为准】`_i4_game_roundmodel.js` `PreSolve` 的
    //   `case SHIELD|PROJECTILE`（L134-148 **原文**）只有三条规则：
    //     ① `!projectile.isDeadlyToOwner() && projectile.getPlayerId() == shield.getPlayerId()`
    //          → `SetEnabled(false)`             = **自己的、还没致命的弹【穿过】自己的盾**
    //     ② 否则：`if (!deadlyToOwner) makeDeadlyToOwner()`  ← **撞盾 = 从此对主人也致命**
    //        （这正是 §12.31A①「贴墙射击 → 弹反弹回来自杀」能成立的前提）
    //        再 `if (type == WEAPON_TYPES.MINE) SetEnabled(false)` = **破片禁用接触**（不反弹；
    //        "停"是事件里把速度乘 0 实现的 ⟹ **按"物理挡下"实现会错**）
    //     ③ 其余 → 接触留着，由 `restitution = 1.0`（工厂 `_createShieldFixtureDefs`）**反弹**
    //   夹具几何（工厂原文）：`circle r = SHIELD.RADIUS.m = 86px/20 = 4.3`、圆心 = 坦克体原点、
    //     `density 10 / friction 0 / restitution 1.0`、
    //     `categoryBits = SHIELD(32)`、`maskBits = TANK|PROJECTILE|SHIELD|ZONE = 101`（**不含 MAZE ⟹ 不撞墙**）
    // ============================================================
    var _shieldStats = { built: 0, torn: 0, bounceContacts: 0, shrapnelStops: 0,
                         ownPassThrough: 0, madeDeadlyByShield: 0 };

    function shieldRadiusM() {
        try {
            if (typeof Constants !== 'undefined' && Constants.SHIELD && Constants.SHIELD.RADIUS) {
                return Constants.SHIELD.RADIUS.m;
            }
        } catch (e) { }
        return 4.3;
    }

    /**
     * 读"这辆坦克现在有没有**真护盾**"。
     * ⚠️ 只认 `UPGRADE_TYPES.SHIELD === 2`；**`SPAWN_SHIELD === 1`（出生护盾）不算**
     *    —— 这正是权威版 §12.28b 订正过的那对坑（10.0 vs 6.0 也是这一对）。
     */
    function _vtShieldOfGame(gameController, playerId) {
        var T = 2;
        try { if (typeof Constants !== 'undefined' && Constants.UPGRADE_TYPES) T = Constants.UPGRADE_TYPES.SHIELD; } catch (e0) { }
        var u = null;
        try {
            if (gameController && typeof gameController.getUpgradeByPlayerIdAndType === 'function') {
                u = gameController.getUpgradeByPlayerIdAndType(playerId, T);
            }
        } catch (e1) { u = null; }
        if (!u) return null;
        var life = null;
        try { life = (typeof u.getField === 'function') ? u.getField('lifetime') : null; } catch (e2) { }
        return { upgradeId: (u.getId ? u.getId() : null), type: (u.getType ? u.getType() : null),
                 lifetime: life, radius: shieldRadiusM() };
    }

    /** 当前坦克的护盾规格；无盾 → null（**读真游戏，不猜**）。 */
    function currentTankShield(gameController, playerId) {
        if (!gameController || typeof gameController.getUpgradeByPlayerIdAndType !== 'function') return null;
        return _vtShieldOfGame(gameController, playerId);
    }

    /** 把 body 上的护盾 fixture 换成"当前该有的样子"（无盾 ⟹ 拆干净）。只认 `userData.type==='fusedShield'`。 */
    function applyShieldFixture(body, spec, ownerId) {
        if (!body || typeof Constants === 'undefined' || !Constants.COLLISION_CATEGORIES) return false;
        var CC = Constants.COLLISION_CATEGORIES;
        var fx = body.GetFixtureList(), changed = false;
        while (fx) {
            var ud = null;
            try { ud = fx.GetUserData(); } catch (eUd) { ud = null; }
            var next = fx.GetNext();
            if (ud && ud.type === 'fusedShield') { body.DestroyFixture(fx); _shieldStats.torn++; changed = true; }
            fx = next;
        }
        if (!spec) return changed;
        var fd = new Box2D.Dynamics.b2FixtureDef();
        fd.density = 10.0;                       // 工厂原文（_createShieldFixtureDefs）
        fd.friction = 0.0;
        fd.restitution = 1.0;                    // ★ 反弹就是靠它
        fd.shape = new Box2D.Collision.Shapes.b2CircleShape(spec.radius || shieldRadiusM());
        // ⚠️ **不能**叫 'tankXxx'：死亡接触扫描认的是 `type.indexOf('tank')===0 && 另一个是 bullet`
        //    —— 护盾**不是判死夹具**（撞盾是反弹，不是死）。这里用独立名字，扫描天然忽略它。
        fd.userData = { type: 'fusedShield', gameObject: ownerId === undefined ? null : ownerId };
        fd.filter = new Box2D.Dynamics.b2FilterData();
        fd.filter.categoryBits = CC.SHIELD;
        // 工厂原文：TANK|PROJECTILE|SHIELD|ZONE（**不含 MAZE** ⟹ 护盾不撞墙）
        fd.filter.maskBits = CC.TANK | CC.PROJECTILE | CC.SHIELD | CC.ZONE;
        body.CreateFixture(fd);
        _shieldStats.built++;
        return true;
    }

    /** 遗留 / 原状形状 = 炮弹炮塔；数值逐字来自 buildConstants 的兜底（同旧版）。 */
    function legacyTurretShape(consts) {
        return {
            name: 'BULLET', launched: false, legacy: true,
            polys: [turretRectPoly(0, consts.TURRET_OFFSET_Y, consts.TURRET_WIDTH, consts.TURRET_HEIGHT)]
        };
    }

    /**
     * 从**活武器对象**解形状：口径与游戏 `updateTankBodyTurret` 完全一致
     * （`weapon.getType()` + `weapon.getField("launched")`）。
     */
    function weaponObjectShape(w) {
        if (!w || typeof w.getType !== 'function') return null;
        var type;
        try { type = w.getType(); } catch (eType) { return null; }
        var launched = false;
        try { launched = !!w.getField('launched'); } catch (eL) { launched = false; }
        return weaponTurretShape(type, launched);
    }

    /** 当前武器形状；任何一步取不到 → null（**不做记忆化**：武器对象会原地换 type/launched） */
    function currentWeaponShape(gameController, playerId) {
        if (!gameController || typeof gameController.getActiveWeapon !== 'function') return null;
        var w = null;
        try { w = gameController.getActiveWeapon(playerId); } catch (eAw) { w = null; }
        return weaponObjectShape(w);
    }

    /** 判死轮廓解析：当前武器形状 → 取不到才回退原状（炮弹炮塔）。 */
    function resolveTankShape(gameController, playerId, consts) {
        return currentWeaponShape(gameController, playerId) || legacyTurretShape(consts);
    }

    /**
     * 把 body 上的**炮弹炮塔换成当前武器自己的炮塔**（候选体重建的一步）。
     * 拆法/建法与游戏 `updateTankBodyTurret` + `_create*TurretFixtureDefs` 同款：
     * 只认 `userData.type === "turret"`；夹具参数 density 0 / friction 0.25 / restitution 0；
     * filter categoryBits=TANK、maskBits=TANK|MAZE|PROJECTILE|COLLECTIBLE|SHIELD|ZONE。
     * `shape` 为空或 legacy ⟹ **什么都不做**（保持 `B2DUtils.createTankBody` 建出来的炮弹炮塔）。
     * @returns {boolean} 是否动过夹具
     */
    function applyWeaponTurret(body, tank, shape) {
        if (!body || !shape || shape.legacy) return false;
        var C = (typeof Constants !== 'undefined') ? Constants : null;
        if (!C || !C.COLLISION_CATEGORIES) return false;
        var CC = C.COLLISION_CATEGORIES;
        var fx = body.GetFixtureList();
        while (fx) {
            var ud = null;
            try { ud = fx.GetUserData(); } catch (eUd) { ud = null; }
            var next = fx.GetNext();
            if (ud && ud.type === 'turret') body.DestroyFixture(fx);
            fx = next;
        }
        for (var i = 0; i < shape.polys.length; i++) {
            var src = shape.polys[i], verts = [];
            for (var v = 0; v < src.length; v++) {
                verts.push(Box2D.Common.Math.b2Vec2.Make(src[v].x, src[v].y));
            }
            if (verts.length < 3) continue;
            var fd = new Box2D.Dynamics.b2FixtureDef();
            fd.density = 0.0;
            fd.friction = 0.25;
            fd.restitution = 0.0;
            fd.shape = new Box2D.Collision.Shapes.b2PolygonShape.AsArray(verts);
            fd.userData = { type: 'turret', gameObject: tank };
            fd.filter = new Box2D.Dynamics.b2FilterData();
            fd.filter.categoryBits = CC.TANK;
            fd.filter.maskBits = CC.TANK | CC.MAZE | CC.PROJECTILE | CC.COLLECTIBLE | CC.SHIELD | CC.ZONE;
            body.CreateFixture(fd);
        }
        return true;
    }

    /** 「塔尖」= 局部坐标里最靠前（-y 最大）的顶点距离；无炮管 → 车体半长（真语义）。 */
    function turretTipOf(shape, fallback) {
        var tip = fallback, i, j;
        var polys = (shape && shape.polys) ? shape.polys : [];
        for (i = 0; i < polys.length; i++) {
            for (j = 0; j < polys[i].length; j++) {
                if (-polys[i][j].y > tip) tip = -polys[i][j].y;
            }
        }
        return tip;
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
    var _cloneCache = null;   // { mazeRef, world, tankBodies:{pid:body}, bulletBodies:[{body,radius,active}], shapeSig }

    // v178（1-4-a）：克隆世界里**所有坦克**的当前武器形状合起来作为签名。
    // 任何一辆换武器（或导弹发射）⟹ 签名变 ⟹ 整个克隆世界重建（候选体重建）。
    // 取不到坦克表 → null（getCloneWorld 的调用方会退化成"不校验签名"，保持原状）。
    function cloneWorldShapeSig(gameController) {
        var tanks = null;
        try { tanks = gameController.getTanks(); } catch (eTanks) { tanks = null; }
        if (!tanks) return null;
        var parts = [], pid;
        for (pid in tanks) {
            if (!tanks.hasOwnProperty(pid)) continue;
            var sh = currentWeaponShape(gameController, pid);
            // v190（G5）：护盾位也进签名（护盾出现/消失 ⟹ 克隆世界重建）
            var shl = currentTankShield(gameController, pid);
            parts.push(pid + '=' + (sh ? shapeSignature(sh, !!shl) : ('?' + '|s:' + (shl ? 1 : 0))));
        }
        parts.sort();
        return parts.join(',');
    }

    function getCloneWorld(gameController, shapeSig) {
        if (shapeSig === undefined) shapeSig = cloneWorldShapeSig(gameController);
        var maze = gameController.getMaze();
        if (!maze) return null;
        if (_cloneCache && _cloneCache.mazeRef === maze &&
            (shapeSig === null || _cloneCache.shapeSig === shapeSig)) return _cloneCache;

        var world = new Box2D.Dynamics.b2World(
            Box2D.Common.Math.b2Vec2.Make(0, 0), true);
        B2DUtils.createMaze(world, maze);   // 原版：克隆全部墙

        var tankBodies = {};
        var tanks = gameController.getTanks();
        for (var pid in tanks) {
            if (!tanks.hasOwnProperty(pid)) continue;
            var tk = tanks[pid];
            if (!tk || !tk.getB2DBody || !tk.getB2DBody()) continue;
            tankBodies[pid] = B2DUtils.createTankBody(world, tk);   // 原版建体（默认带炮弹炮塔）
            // v178：换成这辆坦克**当前武器自己的**炮塔（原版 createTankBody 写死炮弹炮塔）
            applyWeaponTurret(tankBodies[pid], tk, currentWeaponShape(gameController, pid));
            // v190（G5）：护盾夹具（与融合世界同款；判死权威仍是融合世界）
            applyShieldFixture(tankBodies[pid], currentTankShield(gameController, pid), pid);
        }

        _cloneCache = {
            mazeRef: maze,
            shapeSig: shapeSig,
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
        // v171（1-2③）：LASER 按真游戏语义纳入 track —— 基类 Projectile（镜面反弹、
        // |v| 不变、0.8s 寿命、粘性反弹计数），半径 0；它的判死由扫掠负责（sweepable）。
        // 制导导弹(3)/地雷(4) 仍排除：track 世界没有制导/停墙语义，乱纳会造错轨迹。
        return t === Constants.WEAPON_TYPES.BULLET ||
            t === Constants.WEAPON_TYPES.DOUBLE_BARREL ||
            t === Constants.WEAPON_TYPES.SHOTGUN ||
            t === Constants.WEAPON_TYPES.GATLING_GUN ||
            t === Constants.WEAPON_TYPES.LASER;
    }

    /**
     * v12（1-2④）G：**显式断言钉死 D1** —— 追踪导弹**不得**进入 track 世界。
     *
     * 理由：track 世界是「锚点 + 固定折线」（Box2D 只跑弹体自身），而制导弹道**依赖
     * 目标（= 我方候选）的未来轨迹**；同一条折线不可能对 9 条候选路线同时成立。
     * 主人已明确否掉"用假轨迹近似"（轨迹大幅差异、还可能影响本来安全的地方）。
     * ⟹ 制导只落在**融合世界逐帧模拟**里（每帧都有候选位姿，正是"给定候选轨迹就能
     * 精确算"的场景），rescore 那条路由 B2 逐 node 喂**该 node 的**制导弹道。
     *
     * 这个断言会被 `_probe_missile_pairing.js` / diff 套件调用；以后谁"顺手"把
     * HOMING_MISSILE 加进白名单，它会立刻响亮失败。
     */
    function assertMissileNotBallistic() {
        var t;
        try {
            t = (typeof Constants !== 'undefined' && Constants.WEAPON_TYPES &&
                 typeof Constants.WEAPON_TYPES.HOMING_MISSILE === 'number')
                ? Constants.WEAPON_TYPES.HOMING_MISSILE : 3;
        } catch (eA) { t = 3; }
        var fake = { getType: function () { return t; } };
        if (isBallisticProjectile(fake) !== false) {
            throw new Error('v12 D1 断言失败：HOMING_MISSILE 被 isBallisticProjectile 纳入 track 世界');
        }
        if (isBallisticProjectile({ getType: function () { return 0; } }) !== true) {
            throw new Error('v12 D1 断言失败：LASER 必须仍在 track 白名单里（1-2③ 成果）');
        }
        return true;
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
    /**
     * v163：`lifetime === 0` 表示「这颗弹不靠寿命结束」。
     *
     * 原游戏 `Projectile.constructor(state, lifetime, ...)` 的第 2 参是 lifetime。
     * 各弹种传的是真实常量，**只有地雷破片 `Shrapnel.create(state, 0, ...)` 传 0**——
     * 它靠 `Shrapnel.done()`（速度≈0）判结束，不靠寿命。
     *
     * 旧实现把这个 0 直接当寿命用：`lifeTotal=0 → lifeLeft=0`，而融合世界逐帧循环里
     * `bs.lifeLeft -= FRAME; if (lifeLeft<=0) 停用` ⇒ **破片在第一帧就被杀掉**。
     * 实证：录制 vantage_record_1790927237502/1790925717252 地雷致死时
     *   placements 里有破片、contacts=[]、dfs=[-1]、`polyGap` 最小值出现在 k=0
     *   （之后就再没变近）——因为它第 1 帧就没了。
     * 这是地雷"绿死"的真正根因，一直存在，与 v161/v162 无关。
     */
    var NO_LIFETIME_SEC = 1e9;
    function lifetimeSecOf(pr) {
        var lt = (pr && typeof pr.lifetime === 'number') ? pr.lifetime : 10;
        return (lt > 0) ? lt : NO_LIFETIME_SEC;
    }

    // ------------------------------------------------------------------
    // v166：`Projectile.done()` 第三支 —— 反弹上限（JS track / JS 融合共用）。
    //
    // 【代码原文】真 bundle `418577fd210ad079ea3d1e5e04050fe0.js`：
    //   Projectile.update: var currentTimeout = new Date().getTime() - this.timeoutWindow;
    //                      for (i=0;i<this.bounces.length;++i) {
    //                          if (this.bounces[i] >= currentTimeout) { this.bounces.splice(0,i); break; }
    //                      }
    //   hitMaze/hitShield: this.bounces.push(new Date().getTime());
    //   done: return timeAlive>=lifetime || stopped || bounces.length>=timeoutBounceCount;
    //   HomingMissile.update 里复制了同一段剪枝循环（它不走基类 update）——本文件
    //   `simulateBulletTracks` / `simulateFusedBatch` 对**所有非破片弹**（含导弹）
    //   用下面同一套逻辑，三处（JS track / JS 融合 / Rust rollout.rs）必须同改。
    //
    // 【实测】35 是**毫秒**（`docs/.../弹种实测-反弹上限与激光-2026-10-10.md` §二.4）：
    //   长走廊 600 帧 21 次撞墙，`bounces.length` 最大只有 1，弹活满 10.0s ⇒
    //   正常飞行永不触发；把弹种在两面墙内角（每帧 2 次接触）→ 第 3 帧 6≥5 销毁。
    // ⛔ 绝不许写成“总共反弹 5 次消失”（那会让长走廊提前判死）。
    //
    // ⚠️ 剪枝是**粘性**的：只在找到第一条窗口内记录时 splice(0,i)；全过期时一条不删
    //   （实测单条记录能撑到 467ms 才被删）。照抄，不许“按窗口过滤整个数组”。
    // ------------------------------------------------------------------
    function bounceTimeoutWindowSec() {
        var ms = (typeof Constants !== 'undefined' && Constants.PROJECTILE_BOUNCE_TIMEOUT_WINDOW !== undefined)
            ? Constants.PROJECTILE_BOUNCE_TIMEOUT_WINDOW : 35;
        return ms / 1000;   // 原版用 new Date().getTime()（毫秒）
    }
    function bounceTimeoutCount() {
        return (typeof Constants !== 'undefined' && Constants.PROJECTILE_BOUNCE_TIMEOUT_COUNT !== undefined)
            ? Constants.PROJECTILE_BOUNCE_TIMEOUT_COUNT : 5;
    }
    function pruneBounceStamps(stamps, nowSec, windowSec) {
        var currentTimeout = nowSec - windowSec;
        for (var i = 0; i < stamps.length; i++) {
            if (stamps[i] >= currentTimeout) {
                stamps.splice(0, i);
                break;
            }
        }
    }
    /** 该弹是否霰弹（`Shotgun.hitMaze/hitShield` 把 timeAlive 钳到 >=MAX-AFTER）。 */
    function projectileIsShotgun(pr) {
        try {
            return !!(pr && typeof pr.getType === 'function' &&
                pr.getType() === Constants.WEAPON_TYPES.SHOTGUN);
        } catch (eSG) { return false; }
    }
    /**
     * v166：本帧“撞墙/撞盾”接触枚举（原版 PreSolve 每个 touching 接触都会
     * dispatch PROJECTILE_MAZE_COLLISION / PROJECTILE_SHIELD_COLLISION，
     * 从而调 hitMaze/hitShield ⇒ 每帧每个仍在接触的 fixture 都算 1 次）。
     * 与死亡判定共用同一套 Box2D 世界；只读接触链表，不改物理。
     */
    function forEachProjectileWallContact(world, onHit) {
        var CAT = (typeof Constants !== 'undefined') ? Constants.COLLISION_CATEGORIES : null;
        if (!CAT || !world || !world.GetContactList) return;
        var PROJ = CAT.PROJECTILE;
        var HARD = CAT.MAZE | CAT.SHIELD;
        var contact = world.GetContactList();
        while (contact) {
            if (contact.IsTouching()) {
                var fa = contact.GetFixtureA();
                var fb = contact.GetFixtureB();
                var ca = fa.GetFilterData().categoryBits;
                var cb = fb.GetFilterData().categoryBits;
                var bulletFix = null;
                if ((ca & PROJ) && (cb & HARD)) bulletFix = fa;
                else if ((cb & PROJ) && (ca & HARD)) bulletFix = fb;
                if (bulletFix) {
                    var ud = bulletFix.GetUserData();
                    var obj = ud && ud.gameObject;
                    // v12（1-2④）：把 `bulletFix` 一并给回调 —— 制导弹有 N 个副本，
                    // gameObject 是同一个真弹对象，只有 fixture/body 能把接触归到具体副本。
                    if (obj) onHit(obj, bulletFix);
                }
            }
            contact = contact.GetNext();
        }
    }
    /** 霰弹撞墙/撞盾：复刻 `timeAlive = max(timeAlive, MAX-AFTER)` ⇒ 剩余寿命 ≤ AFTER。 */
    function clampShotgunLifeLeftAfterHit(lifeTotal, lifeLeft) {
        var maxL = (typeof Constants !== 'undefined' && Constants.SHOTGUN_MAX_LIFETIME !== undefined)
            ? Constants.SHOTGUN_MAX_LIFETIME : 2.0;
        var after = (typeof Constants !== 'undefined' && Constants.SHOTGUN_LIFETIME_AFTER_MAZE_HIT !== undefined)
            ? Constants.SHOTGUN_LIFETIME_AFTER_MAZE_HIT : 0.7;
        var ageNow = lifeTotal - lifeLeft;
        var clampedAge = Math.max(ageNow, maxL - after);
        return Math.max(0, lifeTotal - clampedAge);
    }


    function computeBulletTrackFrames(gameController, horizonFrames) {
        var maxFrames = Math.max(1, Math.round(horizonFrames || 0));
        var FRAME = _frameDtSec;
        var projectiles = gameController.getProjectiles();
        for (var id in projectiles) {
            if (!projectiles.hasOwnProperty(id)) continue;
            var pr = projectiles[id];
            if (!pr || !isBallisticProjectile(pr)) continue;
            var lifeTotal = lifetimeSecOf(pr);   // v163
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
     * @param {number} durationFrames - 预测帧数（每帧 _frameDtSec 秒，默认0.02，实战经校准）
     * @param {Array} [onlyIds] - 可选：只模拟这些 id；省略/空数组 = 全部
     * @returns {Array|null} [{id, type, frames:[{t,x,y,alive}...]}...]；无迷宫返回 null
     */
    function simulateBulletTracks(gameController, durationFrames, onlyIds) {
        var cw = getBulletTrackWorld(gameController);
        if (!cw) return null;
        var projectiles = gameController.getProjectiles();
        var FRAME = _frameDtSec;
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
        // v129：轨迹自带自己的帧长。查询端必须按"生成时的步长"解读下标，
        // 否则校准（v124~v126）前后生成的轨迹会被当成另一个帧率 → 弹速虚高 20%。
        var trackFrameDt = FRAME;
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
            slot.lifeTotal = lifetimeSecOf(pr);   // v163
            slot.lifeAge = pr.getTimeAlive ? pr.getTimeAlive() : 0;
            slot.lifeLeft = Math.max(0, slot.lifeTotal - slot.lifeAge);
            slot.active = slot.lifeLeft > 0;
            if (!slot.active) {
                slot.body.SetActive(false);
                continue;
            }
            slot.frames = [];
            slot.trackId = id;
            // v166：本轮撞墙/撞盾记录（原版 bounces 时间戳数组；粘性剪枝 + ≥5 判死）
            slot.isShrapnel = false;                       // track 白名单里没有破片
            slot.isShotgun = projectileIsShotgun(pr);
            slot.pid = (pr.id !== undefined && pr.id !== null) ? pr.id : id;
            slot.projObj = pr;
            slot.bounces = [];
            slot.hitThisFrame = 0;

            active.push(slot);
            results.push({ id: id, type: pr.getType ? pr.getType() : null,
                           frameDt: trackFrameDt, frames: slot.frames });   // v129
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

            // v166：本帧撞墙/撞盾接触 = 原版 PreSolve 的每个 touching 接触。
            // 每帧每个仍在接触的墙/盾 fixture 都 push 一次时间戳（hitMaze/hitShield）；
            // 霰弹命中后 timeAlive 被钳到 >=MAX-AFTER ⇒ 剩余寿命 ≤ AFTER。
            var bounceNow = (k + 1) * FRAME;   // 本 Step 之后的模拟时刻
            for (i = 0; i < active.length; i++) active[i].hitThisFrame = 0;
            forEachProjectileWallContact(cw.world, function (obj) {
                var hitPid = (obj && obj.id !== undefined && obj.id !== null) ? String(obj.id) : null;
                for (var hi = 0; hi < active.length; hi++) {
                    var hs = active[hi];
                    if (hs.projObj === obj ||
                            (hitPid !== null && hs.pid !== undefined && String(hs.pid) === hitPid)) {
                        hs.hitThisFrame++;
                        break;
                    }
                }
            });
            for (i = 0; i < active.length; i++) {
                s = active[i];
                if (!s.active || s.hitThisFrame <= 0) continue;
                for (var hb = 0; hb < s.hitThisFrame; hb++) s.bounces.push(bounceNow);
                if (s.isShotgun) {
                    s.lifeLeft = clampShotgunLifeLeftAfterHit(s.lifeTotal, s.lifeLeft);
                }
            }


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
                // v166：`Projectile.update` 的粘性剪枝 + `done()` 第三支。
                // 顺序照原版：先剪枝、再由 done() 判 ≥5（不是“总共弹 5 次”）。
                pruneBounceStamps(s.bounces, bounceNow, bounceTimeoutWindowSec());
                if (s.bounces.length >= bounceTimeoutCount()) {
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
        var cw = getCloneWorld(gameController, cloneWorldShapeSig(gameController));
        var FRAME = _frameDtSec;
        var i;
        opt = opt || {};

        var me = gameController.getTank(aiId);
        var meBody = cw ? cw.tankBodies[aiId] : null;
        var samples = [];

        // 克隆世界建后才出现的坦克：动态补建克隆体（原版建体函数）
        if (cw && me && me.getB2DBody && me.getB2DBody() && !meBody) {
            meBody = B2DUtils.createTankBody(cw.world, me);
            // v178：补建的克隆体也要按当前武器换炮塔
            applyWeaponTurret(meBody, me, currentWeaponShape(gameController, aiId));
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
        // v178（1-4-a）：死亡世界也进了形状签名缓存 ⟹ 一起清掉（下次 ensureDeathWorld 重建）
        _deathWorld = null; _deathTankBody = null; _deathBulletBodies = []; _deathWorldSig = null;
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
    // v149：纯诊断几何工具。不能使用 GetAABB（不同 Box2D 构建 ABI 不一致），
    // 只从真实 fixture shape + body transform 计算融合传感器 AABB。
    // v149 修 v148 自身的 bug：旧 fusedSensorAabb 用 `out = ...` 覆盖，只留下
    // **最后一个** sensor 夹具，而候选坦克有"车体 + 炮塔"两个 sensor，于是测量
    // 打在了错误的那个上，出现"明明有 contacts 却显示 gap=1.8m"的假矛盾。
    function fusedR2(v) { return Math.round(v * 100) / 100; }
    function fusedWorldPoint(body, x, y) {
        var p = body.GetPosition(), a = body.GetAngle(), c = Math.cos(a), s = Math.sin(a);
        return { x: p.x + c * x - s * y, y: p.y + s * x + c * y };
    }
    function fusedFixtureAabb(body, fixture) {
        var sh = fixture && fixture.GetShape ? fixture.GetShape() : null;
        if (!sh) return null;
        var pts = [], type = sh.GetType ? sh.GetType() : null;
        if (type === Box2D.Collision.Shapes.b2Shape.e_circleShape) {
            var cp = sh.m_p || { x: 0, y: 0 }, cw = fusedWorldPoint(body, cp.x, cp.y), cr = sh.m_radius || 0;
            pts = [{ x: cw.x - cr, y: cw.y - cr }, { x: cw.x + cr, y: cw.y + cr }];
        } else {
            var vs = (typeof sh.GetVertices === 'function' ? sh.GetVertices() : sh.m_vertices) || [];
            for (var vi = 0; vi < vs.length; vi++) pts.push(fusedWorldPoint(body, vs[vi].x, vs[vi].y));
        }
        if (!pts.length) return null;
        var ax = pts[0].x, bx = pts[0].x, ay = pts[0].y, by = pts[0].y;
        for (var pi = 1; pi < pts.length; pi++) {
            ax = Math.min(ax, pts[pi].x); bx = Math.max(bx, pts[pi].x);
            ay = Math.min(ay, pts[pi].y); by = Math.max(by, pts[pi].y);
        }
        return { minX: ax, maxX: bx, minY: ay, maxY: by, type: type };
    }
    /** 返回该候选体的**全部** sensor 夹具 AABB（车体 + 炮塔）。 */
    function fusedSensorAabbs(body) {
        var out = [], f = body && body.GetFixtureList ? body.GetFixtureList() : null;
        while (f) {
            var ud = f.GetUserData && f.GetUserData();
            if (ud && ud.type === 'fusedSensor') {
                var a = fusedFixtureAabb(body, f);
                if (a) { a.op = ud.opIndex; out.push(a); }
            }
            f = f.GetNext();
        }
        return out;
    }
    /** 子弹圆到"若干传感器 AABB"的最近 gap；负值=已重叠。
     *  注意：AABB 只是粗口径。旋转矩形的 AABB 比实体大，边缘会假阳。 */
    function fusedCircleSensorGap(px, py, radius, boxes) {
        var best = null, bestBox = null;
        for (var i = 0; i < boxes.length; i++) {
            var b = boxes[i];
            var dx = px < b.minX ? b.minX - px : (px > b.maxX ? px - b.maxX : 0);
            var dy = py < b.minY ? b.minY - py : (py > b.maxY ? py - b.maxY : 0);
            var g = Math.sqrt(dx * dx + dy * dy) - radius;
            if (best === null || g < best) { best = g; bestBox = b; }
        }
        return { gap: best, box: bestBox };
    }
    /**
     * v150：**精确**的圆到凸多边形距离（减去半径）。AABB 在旋转矩形边缘会假阳，
     * 只有这个口径才能定案"几何上到底有没有重叠"。
     * 返回 gap：<=0 表示圆与多边形真正相交。
     */
    function fusedPointPolygonGap(px, py, radius, verts) {
        if (!verts || verts.length < 2) return null;
        var n = verts.length, inside = true, minD = Infinity;
        // v151：先判绕向。旧写法只认逆时针（cross>=0 为内），顺时针多边形会让
        // inside 永远 false，深处的点被当成"外部"返回正值 → 假阴。
        var area2 = 0;
        for (var wi = 0; wi < n; wi++) {
            var wa = verts[wi], wb = verts[(wi + 1) % n];
            area2 += wa.x * wb.y - wb.x * wa.y;
        }
        var ccw = area2 >= 0;
        for (var i = 0; i < n; i++) {
            var a = verts[i], b = verts[(i + 1) % n];
            var ex = b.x - a.x, ey = b.y - a.y;
            // 凸多边形内点判定：所有边的叉积同号，符号由绕向决定
            var cross = ex * (py - a.y) - ey * (px - a.x);
            if (ccw ? (cross < 0) : (cross > 0)) inside = false;
            var el = ex * ex + ey * ey;
            var t = el > 0 ? ((px - a.x) * ex + (py - a.y) * ey) / el : 0;
            t = t < 0 ? 0 : (t > 1 ? 1 : t);
            var qx = a.x + ex * t - px, qy = a.y + ey * t - py;
            var d = Math.sqrt(qx * qx + qy * qy);
            if (d < minD) minD = d;
        }
        return (inside ? -minD : minD) - radius;
    }
    /** 精确口径：子弹圆到该候选体**全部** sensor 多边形的最近 gap。 */
    function fusedCircleSensorPolyGap(px, py, radius, body) {
        var best = null, bestBox = null, f = body && body.GetFixtureList ? body.GetFixtureList() : null;
        while (f) {
            var ud = f.GetUserData && f.GetUserData();
            if (ud && ud.type === 'fusedSensor') {
                var sh = f.GetShape(), pts = [];
                var type = sh && sh.GetType ? sh.GetType() : null;
                if (type === Box2D.Collision.Shapes.b2Shape.e_circleShape) {
                    var cp = sh.m_p || { x: 0, y: 0 }, cw = fusedWorldPoint(body, cp.x, cp.y), cr = sh.m_radius || 0;
                    // 圆形 sensor：退化为点到圆心距离
                    var ddx = cw.x - px, ddy = cw.y - py;
                    var g = Math.sqrt(ddx * ddx + ddy * ddy) - cr - radius;
                    if (best === null || g < best) { best = g; bestBox = fusedFixtureAabb(body, f); }
                } else {
                    var vs = (typeof sh.GetVertices === 'function' ? sh.GetVertices() : sh.m_vertices) || [];
                    for (var vi = 0; vi < vs.length; vi++) pts.push(fusedWorldPoint(body, vs[vi].x, vs[vi].y));
                    if (pts.length >= 2) {
                        var gp = fusedPointPolygonGap(px, py, radius, pts);
                        if (gp !== null && (best === null || gp < best)) {
                            best = gp; bestBox = fusedFixtureAabb(body, f);
                        }
                    }
                }
            }
            f = f.GetNext();
        }
        return { gap: best, box: bestBox };
    }
    /** v171（1-2③ 激光扫掠）：线段 × 凸多边形（端点在内也算）。 */
    function fusedPointInPolyVerts(px, py, verts) {
        var inside = false;
        for (var i = 0, j = verts.length - 1; i < verts.length; j = i++) {
            var a = verts[i], b = verts[j];
            if (((a.y > py) !== (b.y > py)) &&
                    (px < (b.x - a.x) * (py - a.y) / (b.y - a.y) + a.x)) inside = !inside;
        }
        return inside;
    }
    function fusedSegSegInt(ax, ay, bx, by, cx, cy, dx, dy) {
        var d1 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
        var d2 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
        var d3 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
        var d4 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
        return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
    }
    /** v171：线段 × 凸多边形。端点在内或与任一边相交 → true。 */
    function fusedSegmentPolyHit(ax, ay, bx, by, verts) {
        if (!verts || verts.length < 2) return false;
        if (fusedPointInPolyVerts(ax, ay, verts) || fusedPointInPolyVerts(bx, by, verts)) return true;
        for (var i = 0; i < verts.length; i++) {
            var a = verts[i], b = verts[(i + 1) % verts.length];
            if (fusedSegSegInt(ax, ay, bx, by, a.x, a.y, b.x, b.y)) return true;
        }
        return false;
    }
    function fusedSegmentSensorPolyHit(ax, ay, bx, by, body) {
        var f = body && body.GetFixtureList ? body.GetFixtureList() : null;
        var minX = Math.min(ax, bx), maxX = Math.max(ax, bx);
        var minY = Math.min(ay, by), maxY = Math.max(ay, by);
        while (f) {
            var ud = f.GetUserData && f.GetUserData();
            if (ud && ud.type === 'fusedSensor') {
                var sh = f.GetShape();
                var type = sh && sh.GetType ? sh.GetType() : null;
                if (type === Box2D.Collision.Shapes.b2Shape.e_circleShape) {
                    var cp = sh.m_p || { x: 0, y: 0 }, cw = fusedWorldPoint(body, cp.x, cp.y), cr = sh.m_radius || 0;
                    var abx = bx - ax, aby = by - ay;
                    var el = abx * abx + aby * aby;
                    var t = el > 0 ? ((cw.x - ax) * abx + (cw.y - ay) * aby) / el : 0;
                    t = t < 0 ? 0 : (t > 1 ? 1 : t);
                    var qx = ax + abx * t - cw.x, qy = ay + aby * t - cw.y;
                    if (Math.sqrt(qx * qx + qy * qy) <= cr) return true;
                } else {
                    var vs = (typeof sh.GetVertices === 'function' ? sh.GetVertices() : sh.m_vertices) || [];
                    var pts = [];
                    for (var vi = 0; vi < vs.length; vi++) pts.push(fusedWorldPoint(body, vs[vi].x, vs[vi].y));
                    if (pts.length >= 2) {
                        var bminX = Infinity, bmaxX = -Infinity, bminY = Infinity, bmaxY = -Infinity;
                        for (var pi = 0; pi < pts.length; pi++) {
                            if (pts[pi].x < bminX) bminX = pts[pi].x;
                            if (pts[pi].x > bmaxX) bmaxX = pts[pi].x;
                            if (pts[pi].y < bminY) bminY = pts[pi].y;
                            if (pts[pi].y > bmaxY) bmaxY = pts[pi].y;
                        }
                        if (maxX >= bminX && minX <= bmaxX && maxY >= bminY && minY <= bmaxY) {
                            if (fusedSegmentPolyHit(ax, ay, bx, by, pts)) return true;
                        }
                    }
                }
            }
            f = f.GetNext();
        }
        return false;
    }
    /** v171：激光一帧内的实际路径折线（按墙裁剪 + 镜面反射，最多 maxSegs 段）。
     *  只用于几何判死；绝不改任何 body（保持 v153「不提前停车」纪律）。 */
    function fusedSweepSegments(world, x0, y0, x1, y1, maxSegs) {
        var MAZE = (typeof Constants !== 'undefined' && Constants.COLLISION_CATEGORIES)
            ? Constants.COLLISION_CATEGORIES.MAZE : 2;
        var segs = [];
        var ax = x0, ay = y0, bx = x1, by = y1;
        for (var it = 0; it < maxSegs; it++) {
            var best = null;
            try {
                world.RayCast(function (fixture, point, normal, fraction) {
                    var fd = fixture && fixture.GetFilterData ? fixture.GetFilterData() : null;
                    if (!fd || (fd.categoryBits & MAZE) === 0) return 1;
                    if (best === null || fraction < best.frac) {
                        best = { frac: fraction, px: point.x, py: point.y, nx: normal.x, ny: normal.y };
                    }
                    return 1;
                }, Box2D.Common.Math.b2Vec2.Make(ax, ay), Box2D.Common.Math.b2Vec2.Make(bx, by));
            } catch (eRay) { best = null; }
            if (!best || best.frac >= 1) { segs.push({ ax: ax, ay: ay, bx: bx, by: by }); break; }
            segs.push({ ax: ax, ay: ay, bx: best.px, by: best.py });
            var rx = bx - best.px, ry = by - best.py;
            var dot = rx * best.nx + ry * best.ny;
            var rrx = rx - 2 * dot * best.nx, rry = ry - 2 * dot * best.ny;
            ax = best.px; ay = best.py;
            bx = ax + rrx; by = ay + rry;
        }
        return segs;
    }

    function auditFusedGeometry(audit, fc, k) {
        if (!audit || !audit.geometryEnabled) return;
        var slots = fc.bulletSlots || [], cands = fc.candidates || [];
        for (var bi = 0; bi < slots.length; bi++) {
            var bs = slots[bi];
            if (!bs || !bs.body || !bs.body.IsActive() || bs.lastRound !== fc.round) continue;
            var bp = bs.body.GetPosition(), bf = bs.body.GetFixtureList(), rad = 0;
            try { rad = bf && bf.GetShape && (bf.GetShape().m_radius || 0); } catch (eRad) {}
            var pid = bs.pid == null ? ('slot' + bi) : bs.pid;
            for (var oi = 0; oi < cands.length; oi++) {
                var boxes = fusedSensorAabbs(cands[oi]);
                if (!boxes.length) continue;
                var gg = fusedCircleSensorGap(bp.x, bp.y, rad, boxes);
                // v152 性能：精确多边形距离是热路径大头。先用 AABB 粗筛，
                // 只有 AABB gap 已经很小（<0.35m）才做精确测试——绝大多数帧
                // 子弹离坦克几米，粗筛就挡掉了。v150 无条件算，是"现象更严重"的来源。
                var gp = (gg.gap !== null && gg.gap < 0.35)
                    ? fusedCircleSensorPolyGap(bp.x, bp.y, rad, cands[oi])
                    : null;
                var key = String(oi) + '|' + String(pid);
                var old = audit.geometry.proximity[key];
                var refGap = (gp && typeof gp.gap === 'number') ? gp.gap : gg.gap;
                if (!old || refGap < old.polyGap) {
                    audit.geometry.proximity[key] = {
                        op: oi, pid: pid,
                        polyGap: fusedR2(refGap), aabbGap: fusedR2(gg.gap),
                        k: k, sensorCount: boxes.length,
                        bullet: { x: fusedR2(bp.x), y: fusedR2(bp.y), r: fusedR2(rad) },
                        sensor: (gp && gp.box) ? { minX: fusedR2(gp.box.minX), maxX: fusedR2(gp.box.maxX),
                            minY: fusedR2(gp.box.minY), maxY: fusedR2(gp.box.maxY), op: gp.box.op }
                            : (gg.box ? { minX: fusedR2(gg.box.minX), maxX: fusedR2(gg.box.maxX),
                                minY: fusedR2(gg.box.minY), maxY: fusedR2(gg.box.maxY), op: gg.box.op } : null)
                    };
                }
            }
        }
    }
    /**
     * v151：接触链表逐帧快照（纯诊断）。
     * 已实证：polyGap<0（子弹圆真压进坦克多边形）却 IsTouching=false、deathFrame=-1。
     * 要分清是哪一层，必须看接触链表本身：
     *   · pair 根本不在链表里 → broadphase / filter / body active 问题
     *   · pair 在链表但 IsTouching=false → narrowphase / shape 问题
     *   · IsTouching=true 却没写 deathFrame → 我们的扫描/写回问题
     */
    function auditContactList(audit, fc, k) {
        if (!audit || !audit.geometryEnabled) return;
        var out = { k: k, total: 0, sensorProj: [], projCats: {}, sensorOps: {} };
        var contact = fc.world.GetContactList();
        while (contact) {
            out.total++;
            var fa = contact.GetFixtureA(), fb = contact.GetFixtureB();
            var ua = fa && fa.GetUserData && fa.GetUserData();
            var ub = fb && fb.GetUserData && fb.GetUserData();
            var sUd = (ua && ua.type === 'fusedSensor') ? ua : ((ub && ub.type === 'fusedSensor') ? ub : null);
            var oUd = (ua && ua.type === 'fusedSensor') ? ub : ((ub && ub.type === 'fusedSensor') ? ua : null);
            if (sUd) {
                out.sensorOps[sUd.opIndex] = (out.sensorOps[sUd.opIndex] || 0) + 1;
                var oBody = ((ua && ua.type === 'fusedSensor') ? fb : fa).GetBody();
                var oCat = ((ua && ua.type === 'fusedSensor') ? fb : fa).GetFilterData().categoryBits;
                out.projCats[oCat] = (out.projCats[oCat] || 0) + 1;
                if (oCat === Constants.COLLISION_CATEGORIES.PROJECTILE && out.sensorProj.length < 24) {
                    var oObj = oUd && oUd.gameObject;
                    out.sensorProj.push({
                        op: sUd.opIndex,
                        pid: oObj && oObj.id !== undefined ? oObj.id : null,
                        touching: !!contact.IsTouching(),
                        enabled: !!contact.IsEnabled(),
                        bodyActive: !!(oBody && oBody.IsActive())
                    });
                }
            }
            contact = contact.GetNext();
        }
        if (out.sensorProj.length || out.total) {
            audit.contactList = audit.contactList || [];
            audit.contactList.push(out);
            if (audit.contactList.length > 12) audit.contactList.shift();
        }
    }

    /** 接触瞬间的真值：直接对那个 sensor 夹具量一次。 */
    function auditContactTruth(fc, sensorFixture, otherFixture, k, op, pid, category, audit) {
        try {
            var sBody = sensorFixture.GetBody && sensorFixture.GetBody();
            var oBody = otherFixture.GetBody && otherFixture.GetBody();
            var sa = fusedFixtureAabb(sBody, sensorFixture);
            var op2 = oBody && oBody.GetPosition ? oBody.GetPosition() : null;
            var orad = 0;
            try { orad = otherFixture.GetShape && (otherFixture.GetShape().m_radius || 0); } catch (eOr) {}
            var gap = (sa && op2) ? fusedCircleSensorGap(op2.x, op2.y, orad, [sa]) : null;
            var polyGapTruth = (op2 && sBody) ? fusedCircleSensorPolyGap(op2.x, op2.y, orad, sBody) : null;
            audit.contacts.push({
                k: k, op: op, pid: pid, category: category,
                bullet: op2 ? { x: fusedR2(op2.x), y: fusedR2(op2.y), r: fusedR2(orad) } : null,
                sensor: sa ? { minX: fusedR2(sa.minX), maxX: fusedR2(sa.maxX),
                    minY: fusedR2(sa.minY), maxY: fusedR2(sa.maxY) } : null,
                gapAtContact: gap ? fusedR2(gap.gap) : null,
                polyGapAtContact: polyGapTruth ? fusedR2(polyGapTruth.gap) : null
            });
        } catch (eTruth) {
            audit.contacts.push({ k: k, op: op, pid: pid, category: category, truthError: String(eTruth) });
        }
    }

    /** 这颗弹**能不能和护盾建接触**（= 游戏 PreSolve 的 `SetEnabled` 判定）。返回 true = 允许反弹。 */
    function shieldContactAllowed(pr) {
        var CC = (typeof Constants !== 'undefined') ? Constants.COLLISION_CATEGORIES : null;
        if (!CC) return true;
        var type = null, owner = null, deadly = false;
        try { if (typeof pr.getType === 'function') type = pr.getType(); } catch (e0) { }
        try { if (typeof pr.getPlayerId === 'function') owner = pr.getPlayerId(); } catch (e1) { }
        try { if (typeof pr.isDeadlyToOwner === 'function') deadly = !!pr.isDeadlyToOwner(); } catch (e2) { }
        var MINE = -99;
        try { if (typeof Constants !== 'undefined' && Constants.WEAPON_TYPES) MINE = Constants.WEAPON_TYPES.MINE; } catch (e3) { }
        if (type === MINE) return false;                      // ② 破片：禁接触（不反弹）
        return { type: type, owner: owner, deadly: deadly, mine: false };
    }

    /**
     * v190（G5）：把"这颗弹 × 护盾"的三条规则落到**这颗弹自己的 filter** 上。
     * @returns {boolean} 是否允许与护盾接触（= 会不会反弹）
     */
    function applyShieldRuleToSlot(slot, pr, aiId) {
        var CC = (typeof Constants !== 'undefined') ? Constants.COLLISION_CATEGORIES : null;
        if (!slot || !slot.body || !CC) return null;
        var type = null, owner = null, deadly = false;
        try { if (typeof pr.getType === 'function') type = pr.getType(); } catch (e0) { }
        try { if (typeof pr.getPlayerId === 'function') owner = pr.getPlayerId(); } catch (e1) { }
        try { if (typeof pr.isDeadlyToOwner === 'function') deadly = !!pr.isDeadlyToOwner(); } catch (e2) { }
        var MINE = -99;
        try { if (Constants.WEAPON_TYPES) MINE = Constants.WEAPON_TYPES.MINE; } catch (e3) { }
        var ownPass = (String(owner) === String(aiId)) && !deadly;   // ① 自己的、还没致命的弹
        var shrapnel = (type === MINE);                              // ② 破片
        var allow = !ownPass && !shrapnel;                           // ③ 其余 ⟹ 允许接触（会反弹）
        var why = shrapnel ? 'shrapnel-stop' : (ownPass ? 'own-pass-through' : 'bounce-allowed');
        // 改这颗弹的 mask（只动 SHIELD 那一位，其它位一个都不碰）
        try {
            var fx = slot.body.GetFixtureList();
            while (fx) {
                var fd = fx.GetFilterData();
                var base = (fd.maskBits & ~CC.SHIELD);       // 先清 SHIELD
                fd.maskBits = allow ? (base | CC.SHIELD) : base;
                fx.SetFilterData(fd);
                fx = fx.GetNext();
            }
        } catch (eSet) { }
        slot.shieldRule = why;
        slot.shieldAllows = allow;
        if (ownPass) _shieldStats.ownPassThrough++;
        return allow;
    }

    /** Step 之后的护盾接触扫描：记账 + 破片的"停"（几何）+ 记"撞盾后对主人致命"。 */
    function scanShieldContacts(fc, opCount, k) {
        if (!fc || !fc.bulletSlots) return;
        var CC = (typeof Constants !== 'undefined') ? Constants.COLLISION_CATEGORIES : null;
        if (!CC) return;
        var touched = null;
        try { touched = fc.world.GetContactList(); } catch (eC) { touched = null; }
        var c = touched;
        while (c) {
            try {
                if (c.IsTouching()) {
                    var fa = c.GetFixtureA(), fb = c.GetFixtureB();
                    var ua = fa.GetUserData(), ub = fb.GetUserData();
                    var shieldFix = (ua && ua.type === 'fusedShield') ? fa : ((ub && ub.type === 'fusedShield') ? fb : null);
                    if (shieldFix) {
                        var otherFix = (shieldFix === fa) ? fb : fa;
                        var otherUd = (shieldFix === fa) ? ub : ua;
                        // 找到这颗弹对应的槽（按 body 反查；共享体与制导副本都算）
                        var pid = _vtFusedBodyPid(fc, otherFix.GetBody());
                        for (var i = 0; i < fc.bulletSlots.length; i++) {
                            var sl = fc.bulletSlots[i];
                            if (!sl || sl.lastRound !== fc.round || String(sl.pid) !== String(pid)) continue;
                            sl.shieldDeadlyNow = true;                       // = 游戏那句 makeDeadlyToOwner()
                            sl.shieldHitFrames = (sl.shieldHitFrames || 0) + 1;
                            if (sl.shieldRule === 'shrapnel-stop') {
                                // 破片：接触被禁 ⟹ 这里理论上不会走到；留着做保险
                                try { sl.body.SetLinearVelocity(Box2D.Common.Math.b2Vec2.Make(0, 0)); } catch (eV) { }
                                _shieldStats.shrapnelStops++;
                            } else {
                                _shieldStats.bounceContacts++;
                                _shieldStats.madeDeadlyByShield++;
                            }
                            break;
                        }
                    }
                }
            } catch (eContact) { }
            c = c.GetNext();
        }
        // 破片的"停"：几何检查（掩码把 SHIELD 去掉了 ⟹ 不会有接触，必须自己算圆-圆重叠）
        for (var si = 0; si < fc.bulletSlots.length; si++) {
            var sl2 = fc.bulletSlots[si];
            if (!sl2 || sl2.lastRound !== fc.round || !sl2.body || !sl2.body.IsActive()) continue;
            if (sl2.shieldRule !== 'shrapnel-stop') continue;
            var pp2 = sl2.body.GetPosition();
            for (var oi = 0; oi < opCount; oi++) {
                var cb = fc.candidates[oi];
                if (!cb || !cb.IsActive()) continue;
                var hasShield = false, sp = null;
                try {
                    var f2 = cb.GetFixtureList();
                    while (f2) { var u2 = f2.GetUserData();
                        if (u2 && u2.type === 'fusedShield') { hasShield = true; sp = f2.GetShape(); }
                        f2 = f2.GetNext(); }
                } catch (eF2) { hasShield = false; }
                if (!hasShield || !sp) continue;
                var cp = cb.GetPosition();
                var rr = (sp.m_radius || 4.3) + (sl2.radius || 0.05);
                var dx = pp2.x - cp.x, dy = pp2.y - cp.y;
                if (dx * dx + dy * dy <= rr * rr) {
                    // 与游戏事件里那句 `speed *= 0` 等价；`Shrapnel.done() = |v|²≤0.01` 会让它下一帧退场
                    try { sl2.body.SetLinearVelocity(Box2D.Common.Math.b2Vec2.Make(0, 0)); } catch (eV2) { }
                    sl2.shieldStopped = true;
                    _shieldStats.shrapnelStops++;
                    break;
                }
            }
        }
    }

    function createFusedCandidateBody(world, tank, opIndex, shape, shieldSpec, ownerId) {
        var body = B2DUtils.createTankBody(world, tank);
        // v178（1-4-a）：`createTankBody` 写死"炮弹炮塔"（`_createBulletTurretFixtureDefs`），
        //   这里换成**当前武器自己的**炮塔 —— 它同时进 sensor 夹具（判死轮廓）与
        //   MAZE 过滤的实心夹具（贴墙滑动）。shape 为 null/legacy ⟹ 保持原状（逐字节同旧版）。
        applyWeaponTurret(body, tank, shape);
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
        // v190（G5）：护盾夹具 —— **必须在上面两个循环之后**：
        //   ① 上面的 `fd.maskBits = MAZE` 会把护盾改成只撞墙（错）
        //   ② sensor 克隆循环会把护盾圆 4.3 m 也克隆成判死 sensor ⟹ 任何子弹进圈都判死（灾难）
        //   ⟹ 单独最后建；它的 `userData.type='fusedShield'` 不在判死扫描的匹配式里。
        applyShieldFixture(body, shieldSpec, ownerId);
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
        // v178（1-4-a）：**形状签名进缓存键** —— 当前武器（+导弹 launched）变了就整槽重建。
        //   §12.4b：武器形状与护盾都挂在同一套"候选体重建"上（护盾位本轮留空，等规格）。
        //   取不到武器 ⟹ 'w:BULLET'（与真实炮弹炮塔同几何，不会来回抖）。
        var shape = currentWeaponShape(gameController, aiId);
        // v190（G5）：**护盾位折进签名**（§12.8「护盾也是坦克形状的一部分」）
        var shieldSpec = currentTankShield(gameController, aiId);
        var shapeSig = shapeSignature(shape, !!shieldSpec) || ('w:BULLET|s:' + (shieldSpec ? 1 : 0));
        if (_fusedCacheSlots[cacheKey] && _fusedCacheSlots[cacheKey].shapeSig === shapeSig) {
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
            candidates.push(createFusedCandidateBody(world, me, i, shape, shieldSpec, aiId));
        }
        _fusedCache = {
            mazeRef: maze,
            aiId: aiId,
            // v178（1-4-a）：候选体的形状签名（进缓存键；变了就整槽重建）
            // v190（G5）：签名里已含护盾位 ⟹ 护盾出现/消失同样整槽重建
            shapeSig: shapeSig,
            shieldSig: !!shieldSpec,
            shieldRadius: shieldSpec ? shieldSpec.radius : null,
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
    // v12（1-2④）：最近一次 rescore 的「每 node 制导弹道」只读快照（诊断/对拍用；
    // 不参与任何决策）。B2 的关键证据：不同 node 的 track 必须不同。
    var _lastRescoreMissileTracks = null;

    var _fusedDropStats = {
        approxPlaced: 0,      // 无 track/折线可用 → 按"真实位姿 + 真实速度"前推后摆上
        noThreat: 0,          // 连威胁条目都找不到（威胁表漏了它）
        skipped: 0,           // 其它原因没摆（保留计数，不允许无声）
        // v12（1-2④）D2：追踪导弹追的是别人 → 本段摘掉（绝不降级成普通弹）。
        droppedTargetOther: 0,
        // v12：制导弹在场但迷宫导航表建不出来 → 本批制导弹停用（不直飞）。
        missileNoNav: 0,
        lastLogMs: 0,
        lastDetail: ''
    };
    // v144：融合死亡审计（只读，不参与决策）。记录最后批次的摆弹来源、坐标、
    // track 索引、威胁条目和实际 fusedSensor×PROJECTILE 接触。
    var _lastFusedBatchSummary = null;
    // v188（S1 §12.3）：**上一次融合批次**的逐 op 死因溯源（只读；给 releaseDeathsAfterRemoval 用）。
    //   形状 = [ {op:i, causes:[{frame, bulletId, src}]} , … ]（长度 = operations 数）
    var _lastDeathCauses = null;
    var _lastDeathCauseSeq = null;   // 与 _lastDeathCauses 同一次批次的 seq（`_fusedBatchSeq`）
    var _fusedBatchSeq = 0;
    var _fusedBatchAuditHistory = [];
    var MAX_FUSED_AUDIT_HISTORY = 40;
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

    // v124：每帧时长（秒）。默认 0.02 不变（测试/离线均按 0.02）；
    // 实战中由树按"游戏自己的时钟"实测校准后写入——实测世界每 tick 推进约 0.035 秒，
    // 而代码固定按 0.02 模拟，会让树时钟慢一半 → 预测"还有 5 帧"现实只剩 2~3 帧。
    var _frameDtSec = 0.02;
    var _frameDtRangeWarned = false;
    /** 实战步长（秒）由树的 calibrateFrameDt 校准后写进来。
     *  v163：合法范围放宽到 [0.001, 1.0]（游戏自己的 Constants.MAX_DELTA_TIME 才是真上限，
     *  本 build 是 0.1），并且**拒绝时响亮报警**——旧版对 [0.005, 0.2] 之外的值静默忽略，
     *  结果"树以为改了、沙箱还在用旧值"（两套帧长），正是阶段 1-1 要清掉的不一致。
     *  v163b：Rust 侧 rollout.rs `set_frame_dt` 的值域同步放宽到 [0.001, 1.0]（重新编译过 wasm），
     *  否则 >200fps（240Hz≈0.00417s）时 JS 收下、Rust 静默忽略 → 又是两套帧长。 */
    function setFrameDtSec(v) {
        var n2 = parseFloat(v);
        if (isFinite(n2) && n2 >= 0.001 && n2 <= 1.0) {
            _frameDtSec = n2;
        } else if (!_frameDtRangeWarned) {
            _frameDtRangeWarned = true;
            if (global.console && console.warn) {
                console.warn('[VantageSandbox] setFrameDtSec 拒绝病态帧步长 ' + v +
                    '（接受 0.001~1.0 秒）→ 继续用 ' + _frameDtSec + ' s。' +
                    '树/沙箱步长可能不一致，这条不许静默。');
            }
        }
        return _frameDtSec;
    }
    function getFrameDtSec() { return _frameDtSec; }

    /** v137：Rust 核心里的时间步长是**写死的 0.02**（rollout.rs `FRAME_DT`、
     *  rescore.rs `RESCORE_DT`），JS 侧却会在 v124 校准后把它改成实测值
     *  （0.015~0.03）。两边不一致时同一批弹会被算成两条不同的弹道：
     *    · 75 帧视界 JS 是 1.25s、Rust 是 1.5s；
     *    · 每颗弹的位置逐帧偏开，Rust 说"9 个操作都安全"，JS 融合世界里却在撞。
     *  Rust 只是候选、JS 融合才是死亡权威，但**选路**用的是 Rust 结论——
     *  这就是"树显示安全却死了"的物理引擎错位来源。
     *  这里做一道响亮的护栏：步长不是 0.02 就不用 Rust 快路，回退 JS 融合路径
     *  （正确性优先，速度退回 v114 之前）。等 Rust ABI 传入真实 frame_dt 再放行。 */
    var _rustDtWarned = false;
    function rustFrameDtCompatible() {
        // v160：帧步长已经通过 `vt_set_frame_dt` 传进 Rust，两边同口径，
        // **不再要求精确 == 0.02**。旧行为备份：`Math.abs(_frameDtSec - 0.02) < 1e-9`。
        // 保留这个入口只为兼容旧 wasm：没有 vt_set_frame_dt 时仍按旧规则禁用。
        if (global.VantageRustBridge && global.VantageRustBridge._ready &&
                global.VantageRustBridge.setFrameDt) {
            try { global.VantageRustBridge.setFrameDt(_frameDtSec); } catch (eSyncDt) {}
            return true;
        }
        var ok = Math.abs(_frameDtSec - 0.02) < 1e-9;
        if (!ok && !_rustDtWarned) {
            // 铁律：上限/护栏要"留余量 + 响亮失败"，不许静默降级。
            // 这里只提示一次，避免每帧刷屏（主人早就提过日志要节流）。
            _rustDtWarned = true;
            if (global.console && console.warn) {
                console.warn('[VantageSandbox] 帧步长 ' + _frameDtSec.toFixed(5) +
                    's 与 Rust 核心写死的 0.02s 不一致 → Rust 快路停用，回退 JS 融合路径' +
                    '（正确性优先，速度会退到 v114 之前）。要恢复 Rust 速度，需把真实' +
                    ' frame_dt 传进 vantage_core ABI（rollout.rs FRAME_DT / rescore.rs RESCORE_DT）。');
            }
        }
        return ok;
    }

    // ------------------------------------------------------------------
    // v164：**弹种档案**。融合世界原先对每一颗弹都用同一套「普通圆弹」参数
    //   （半径直接取 shape 半径、restitution=1 反弹、速度归一化保初速），
    //   但真实各弹种的半径/寿命/速度/撞墙行为**各不相同**：
    //     BULLET(-1)/DOUBLE_BARREL(1)/GATLING(5)：圆弹，撞墙反弹
    //     SHOTGUN(2)       ：圆弹，撞墙反弹；撞墙后 timeAlive 被钳到 >=1.3s
    //     LASER(0)         ：**半径 0**；真实是「射线扫掠」不是圆体，不反弹
    //                        ⇒ needsSweep：融合世界目前只做了退化半径护栏，扫掠判定待做
    //     HOMING_MISSILE(3)：2s 后制导转向 —— 直线/反弹折线只是粗略近似
    //     MINE(4) 破片      ：`Shrapnel.hitMaze` 把速度乘 0 ⇒ `done()`=速度²<=0.01
    //                        ⇒ **当帧消失**（不反弹、不留在地上）；且 `Shrapnel.update`
    //                          不调 `_super()` ⇒ **没有**基类那条「速度归一化保初速」
    //   铁律：动任何弹种，必须 JS 融合世界与 Rust（rollout.rs create_projectile_body）
    //        同一次落同一语义，两边都留历史注释。
    // ------------------------------------------------------------------
    var _projProfile = {};
    (function buildProjectileProfile() {
        if (typeof Constants === 'undefined' || !Constants.WEAPON_TYPES) return;
        var W = Constants.WEAPON_TYPES;
        function put(t, o) { if (t !== undefined && t !== null) _projProfile[t] = o; }
        put(W.BULLET,         { name: 'BULLET',        radiusFallback: 0.25, bounces: null, wall: 'bounce' });
        put(W.DOUBLE_BARREL,  { name: 'DOUBLE_BARREL', radiusFallback: 0.25, bounces: null, wall: 'bounce' });
        put(W.GATLING_GUN,    { name: 'GATLING_GUN',   radiusFallback: 0.1,  bounces: null, wall: 'bounce' });
        put(W.SHOTGUN,        { name: 'SHOTGUN',       radiusFallback: 0.1,  bounces: null, wall: 'bounce' });
        put(W.LASER,          { name: 'LASER',         radiusFallback: 0.05, bounces: null, wall: 'bounce', needsSweep: true });
        // v9 更正：旧值 `wall: 'vanish'` 与真代码不符（保留作对照）。真 bundle
        // `418577fd210ad079ea3d1e5e04050fe0.js` 里 `HomingMissile=Projectile.subclass()` 只重写
        // `update`；`hitMaze` 继承基类（只 push bounces 时间戳，**不动速度**）⇒ 撞墙照常
        // 按 restitution=1 反弹，直到超时窗口/反弹次数。`bounces: null` 仍表示用全局值。
        put(W.HOMING_MISSILE, { name: 'HOMING_MISSILE',radiusFallback: 0.25, bounces: null, wall: 'bounce', steers: true });
        put(W.MINE,           { name: 'MINE_SHRAPNEL', radiusFallback: 0.1,  bounces: 0,    wall: 'vanish', noSpeedNorm: true });
    })();

    /** v164：取弹种档案；无类型信息返回 null（调用方走旧口径，保守不变）。 */
    function projectileProfileOf(pr) {
        if (!pr || typeof pr.getType !== 'function') return null;
        try { return _projProfile[pr.getType()] || null; } catch (e) { return null; }
    }

    // ------------------------------------------------------------------
    // TODO(v9) 仍未做的两个弹种（**不允许用近似值静默改语义**，见《待查清单》§19）：
    //   ① LASER 射线扫掠：真判定是本帧位置→下帧位置（180 m/s ⇒ 每帧 3.6 m）的线段
    //      与坦克多边形的相交，不是半径 0.05 的圆。现在 `acquireFusedBullet` 只在
    //      `radius<=0` 时回退到档案 `radiusFallback: 0.05` 并响亮记日志——这是护栏，
    //      不是正确语义；JS 融合世界与 Rust 都收到这个 0.05，两边暂时一致但都错。
    //      卡点：需要在 JS 与 Rust **同一次**落「线段 × 坦克多边形（先用墙裁剪）」，
    //      还要处理同帧撞墙后的反射（基类 `Projectile.update` 会归一化速度并继续飞）。
    //   ② HOMING_MISSILE 制导：真 `HomingMissile.update` 用 maze 的
    //      `getDistancesFromPosition` / `getShortestPathWithGraph` 选最近坦克并只朝
    //      「迷宫图下一格」加速（ACCELERATION=40），2.0s 后才激活。融合世界里只有
    //      AI 自己的 9 个候选、没有其他坦克的未来轨迹，也没有 ABI 传 `timeAlive`/
    //      目标位置/迷宫图，无法忠实复刻；瞎猜会改变危险方向，故未做。
    // ------------------------------------------------------------------

    /** v12（1-2④）：把某槽的制导副本全部停放（SetActive(false)），不销毁。 */
    function parkHomingCopies(slot) {
        var hm = (slot && slot.homing) || [];
        for (var hi = 0; hi < hm.length; hi++) {
            if (hm[hi] && hm[hi].body) hm[hi].body.SetActive(false);
        }
    }

    /**
     * v12（1-2④）：确保该槽有 `opCount` 个制导副本（每候选一颗弹体，选项 A）。
     * 缺的按当前半径新造（多个副本**各自一份** fixture userData，写 `homingOp`）；
     * 多出来的（上一批 op 更多）停放不销毁。
     */
    function ensureHomingCopies(fc, slot, projectile, radius, opCount) {
        if (!slot.homing) slot.homing = [];
        while (slot.homing.length < opCount) {
            var mi = slot.homing.length;
            var hb = B2DUtils.createProjectileBody(fc.world, projectile, radius);
            // 配对标记：接触判定时只有 homingOp == sensor.opIndex 的副本才算命中。
            try {
                var fix = hb.GetFixtureList();
                var ud = fix && fix.GetUserData ? fix.GetUserData() : null;
                if (ud) { ud.homingOp = mi; ud.homingCopyOf = projectile; }
            } catch (eUd) {}
            slot.homing.push({ body: hb, opIndex: mi, bounces: [], hitThisFrame: 0 });
        }
        for (var hj = opCount; hj < slot.homing.length; hj++) {
            if (slot.homing[hj] && slot.homing[hj].body) slot.homing[hj].body.SetActive(false);
        }
        for (var hk = 0; hk < slot.homing.length && hk < opCount; hk++) {
            slot.homing[hk].bounces = [];
            slot.homing[hk].hitThisFrame = 0;
        }
    }

    /** v12：把 N 个副本摆到共享体的同一落点/速度（共享体本身不使用）。 */
    function placeHomingCopies(fc, slot, x, y, vx, vy, opCount) {
        for (var hi = 0; hi < slot.homing.length; hi++) {
            var hc = slot.homing[hi];
            if (!hc || !hc.body) continue;
            if (hi >= opCount) { hc.body.SetActive(false); continue; }
            hc.body.SetPositionAndAngle(Box2D.Common.Math.b2Vec2.Make(x, y), 0);
            hc.body.SetLinearVelocity(Box2D.Common.Math.b2Vec2.Make(vx, vy));
            hc.body.SetAngularVelocity(0);
            hc.body.SetActive(true);
            hc.body.SetAwake(true);
            hc.bounces = [];
            hc.hitThisFrame = 0;
        }
    }

    function acquireFusedBullet(fc, projectile, opCount) {
        var i, slot = null;
        for (i = 0; i < fc.bulletSlots.length; i++) {
            if (fc.bulletSlots[i].lastRound !== fc.round) { slot = fc.bulletSlots[i]; break; }
        }
        var rb = projectile.getB2DBody();
        var prof = projectileProfileOf(projectile);
        var radius = 0.25;
        try {
            radius = rb.GetFixtureList().GetShape().m_radius;
        } catch (eR) {}
        // v164：**不允许静默造退化体**。激光 `LASER.RADIUS.m=0` 让旧代码造出半径 0 的圆，
        //   在融合世界里几乎撞不上坦克 ⇒ 判死不可靠 ⇒ 绿死。退化半径必须响亮报出来。
        if (!(radius > 0) || !isFinite(radius)) {
            var _fb = (prof && prof.radiusFallback > 0) ? prof.radiusFallback : 0.05;
            try {
                fusedDropLog('id=' + (projectile.id !== undefined ? projectile.id : '?') +
                    ' 半径退化(' + radius + ') 弹种=' + ((prof && prof.name) || (projectile.getType ? projectile.getType() : '?')) +
                    ' → 回退半径 ' + _fb);
            } catch (eLog) {}
            radius = _fb;
        }
        var isMissile = isHomingMissileProjectile(projectile);
        if (!slot) {
            slot = { body: null, lastRound: -1, radius: radius, homing: [] };
            slot.body = B2DUtils.createProjectileBody(fc.world, projectile, radius);
            fc.bulletSlots.push(slot);
        } else if (slot.radius !== radius) {
            // v24：槽位半径必须跟随当前弹种；不同半径复用同一 slot 会造成
            // 霰弹/加特林(0.1)用成普通弹(0.25)的死亡判定错误。
            if (slot.body) {
                slot.body.SetActive(false);
                try { fc.world.DestroyBody(slot.body); } catch (eD) {}
            }
            // v12：半径变了 → 上一轮的制导副本也不能再用（直径不对），销毁重建。
            var hmOld = slot.homing || [];
            for (var ho = 0; ho < hmOld.length; ho++) {
                if (hmOld[ho] && hmOld[ho].body) {
                    hmOld[ho].body.SetActive(false);
                    try { fc.world.DestroyBody(hmOld[ho].body); } catch (eDh) {}
                }
            }
            slot.homing = [];
            slot.body = B2DUtils.createProjectileBody(fc.world, projectile, radius);
            slot.radius = radius;
        }
        slot.lastRound = fc.round;
        slot.needsSweep = !!(prof && prof.needsSweep);   // v171：激光扫掠标志（不许只看半径）
        // v166：本轮撞墙/撞盾记录（原版 `bounces`）与接触计数必须按轮次清空——
        //   槽位是按 lastRound 轮询复用的，残留时间戳会把新弹提前判死（§14 同类教训）。
        slot.projObj = projectile;
        slot.bounces = [];
        slot.hitThisFrame = 0;
        slot.isMissile = isMissile;

        if (!isMissile) {
            // v12：上一轮若是制导弹，共享体是 inactive、副本是活的 → 这里必须
            // 把副本全部停放（否则普通弹轮次里残留副本继续飞 = 幻影弹）。
            parkHomingCopies(slot);
            slot.missileTimeAlive = 0;
            slot.body.SetActive(true);
            return slot;
        }
        // v12（1-2④）：制导弹 —— 共享体**不使用**（置 inactive），运动全在 N 个副本上。
        slot.body.SetActive(false);
        ensureHomingCopies(fc, slot, projectile, radius, opCount);
        // timeAlive：真弹的字段（`Projectile.timeAlive`；制导门 = 严格 > 2.0s）。
        var taNow = (typeof projectile.timeAlive === 'number' && isFinite(projectile.timeAlive))
            ? projectile.timeAlive : 0;
        slot.missileTimeAlive = taNow;
        // ⚠️ 归一化上限 = **发射时**速度（`Projectile.constructor` 的 initialSpeed，
        //   HOMING_MISSILE.SPEED.m = 18），不是摆位时的当前速度。用当前速度当上限会让
        //   减速过的导弹永久钉死在低速（制导失效）；Rust 侧同样用 18（ABI 不带此参）。
        var launchSpeed = (typeof projectile.initialSpeed === 'number' &&
            isFinite(projectile.initialSpeed) && projectile.initialSpeed > 0)
            ? projectile.initialSpeed : MISSILE_LAUNCH_SPEED;
        slot.missileInitialSpeed = launchSpeed;
        return slot;
    }

    function parkUnusedFusedBullets(fc) {
        for (var i = 0; i < fc.bulletSlots.length; i++) {
            if (fc.bulletSlots[i].lastRound !== fc.round) {
                fc.bulletSlots[i].body.SetActive(false);
                // v12（1-2④）：制导弹的 N 个副本**必须一起停放** —— 否则上一颗弹的
                // 副本会继续飞（幻影弹）→ 假死/假绿。上一位代理提前报备的坑。
                var hm = fc.bulletSlots[i].homing || [];
                for (var hj = 0; hj < hm.length; hj++) {
                    if (hm[hj] && hm[hj].body) hm[hj].body.SetActive(false);
                }
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
        if (!rustFrameDtCompatible()) return null;   // v137：帧步长不一致不走 Rust 快路
        if (durationFrames > 75) return null;
        if (!global.VantageRustBridge || !global.VantageRustBridge._ready) return null;

        var fc = getFusedWorld(gameController, aiId);
        if (!fc) return null;
        // v176（A）：本局第一批就把导航表建好（幂等）——把"第一次见制导弹"那一刻的卡顿
        //   挪到开局的非关键帧；超预算时这里就会触发 E 的停用 + 响亮告警。
        prebuildMazeNav(gameController);
        var FRAME = _frameDtSec;   // v163：样本时间戳必须用同一个校准帧长（旧版写死 0.02）

        var fused = simulateFusedBatch(gameController, aiId, operations, 0, opt);
        if (!fused || fused.length !== operations.length) return null;

        var me = gameController.getTank(aiId);
        if (!me || !me.getB2DBody || !me.getB2DBody()) return null;

        var bullets = [];
        var needMissileNav = false;
        for (var bi = 0; bi < fc.bulletSlots.length; bi++) {
            var slot = fc.bulletSlots[bi];
            if (slot.lastRound !== fc.round || !slot.active) continue;
            var isMissile = !!slot.isMissile;
            var useBody = slot.body;
            if (isMissile) {
                // v12（1-2④）：制导弹的共享体是 inactive（不使用），位姿/速度取副本 0
                //（N 个副本落点/初速相同）。**绝不能因为共享体 inactive 就把它漏给 Rust**
                // —— 那就是"Rust 快路对制导弹失明"= 假绿。
                var hlist = slot.homing || [];
                if (!hlist.length || !hlist[0] || !hlist[0].body) continue;
                useBody = hlist[0].body;
                needMissileNav = true;
            } else if (!slot.body || !slot.body.IsActive()) {
                continue;
            }
            var bpos = useBody.GetPosition();
            var bvel = useBody.GetLinearVelocity();
            bullets.push({
                x: bpos.x,
                y: bpos.y,
                vx: bvel.x,
                vy: bvel.y,
                radius: slot.radius,
                lifeLeft: slot.lifeLeft,
                active: true,
                // v9：把弹种带进 Rust ABI（slot.isShrapnel 由 v162/v164 的摆位收尾设置）。
                // v166：霰弹标记（`bullet_is_shrapnel` 字节扩成弹种码：0=普通 1=破片 2=霰弹）
                isShotgun: !!slot.isShotgun,

                isShrapnel: !!slot.isShrapnel,
                isLaser: !!slot.needsSweep,
                // v12（1-2④）：弹种码 4 = HOMING_MISSILE；`missileTimeAlive` 判 2.0s 门。
                isMissile: isMissile,
                missileTimeAlive: isMissile ? (slot.missileTimeAlive || 0) : 0
            });
        }

        // v12（1-2④）：有制导弹 → 必须先把迷宫导航表装进 Rust（`vt_set_maze`）。
        // `maze_id` 不符时 Rust 会**响亮返回 0**（`lib.rs`）→ 这里回退 JS 融合世界。
        var mazeId = 0;
        if (needMissileNav) {
            var navMaze = gameController.getMaze();
            var navT = getMazeNavTables(navMaze);
            if (!navT) {
                console.warn('[VantageSandbox] 制导弹在场但迷宫导航表建不出来，回退融合世界');
                return null;
            }
            mazeId = mazeIdOf(navMaze);
            var mazeAck = null;
            try {
                mazeAck = global.VantageRustBridge.setMaze({
                    mazeId: mazeId, w: navT.w, h: navT.h,
                    flags: navT.flags, nextTile: navT.table
                });
            } catch (eMaze) {
                console.warn('[VantageSandbox] vt_set_maze 调用失败，回退融合世界:', eMaze);
                return null;
            }
            if (!mazeAck || mazeAck.ok !== true) {
                console.warn('[VantageSandbox] vt_set_maze 失败，回退融合世界:', mazeAck && mazeAck.error);
                return null;
            }
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
                frames: durationFrames,
                // v12（1-2④）：ABI 尾参 `maze_id`（无制导弹时 0，Rust 不校验）。
                mazeId: mazeId
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
                    return { t: frame * FRAME, x: s.x, y: s.y, rot: s.rot };
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
        // v176（A）：**两条路共用这一个入口** ⟹ 在这里预建导航表，才能保证"换图/开局就建"
        //   对 JS 融合路也生效（只挂在内核 Rust 路上时，JS 路仍会懒建到"第一次见制导弹"）。
        //   幂等：同 maze 第二次调用命中缓存，只花一次 getter 比较。
        prebuildMazeNav(gameController);
        if (!FUSED_ENABLED) return null;
        var fc = getFusedWorld(gameController, aiId);
        if (!fc) return null;
        var me = gameController.getTank(aiId);
        if (!me || !me.getB2DBody || !me.getB2DBody()) return null;

        var FRAME = _frameDtSec;
        opt = opt || {};
        var i, k, id;

        // v127：候选坦克必须**继承真实坦克的线速度与角速度**。
        // 原来一律清零 → 现实里带着动量（原地旋转、贴墙蹭行）的坦克，在模拟里是
        // 一辆从静止起步的车：原地旋转被子弹扫到、被墙卡住只能爬，这两种情况
        // 模拟里都不会出现 ⇒ 树判"无威胁/可以前进" ⇒ 静止被单杀 / 按住前进蹭墙。
        var realVX = 0, realVY = 0, realVW = 0;
        try {
            var meBody0 = me.getB2DBody();
            var lv0 = meBody0.GetLinearVelocity();
            realVX = lv0.x; realVY = lv0.y;
            realVW = meBody0.GetAngularVelocity();
            if (!isFinite(realVX) || !isFinite(realVY)) { realVX = 0; realVY = 0; }
            if (!isFinite(realVW)) realVW = 0;
        } catch (eV0) { realVX = 0; realVY = 0; realVW = 0; }

        for (i = 0; i < fc.candidates.length; i++) {
            var cb = fc.candidates[i];
            var active = i < operations.length;
            cb.SetActive(active);
            if (active) {
                cb.SetPositionAndAngle(
                    Box2D.Common.Math.b2Vec2.Make(opt.startPose.x, opt.startPose.y),
                    opt.startPose.rot);
                cb.SetLinearVelocity(Box2D.Common.Math.b2Vec2.Make(realVX, realVY));
                cb.SetAngularVelocity(realVW);
                cb.SetAwake(true);
            }
        }

        fc.round++;
        var projectiles = gameController.getProjectiles();
        // v188（S1 §12.3 ①）：**识别**"该消失但曾存在"的弹（只读：对比真实弹列表 + 游戏事件分类）。
        //   ⚠️ 只记账 + 后面清槽，**绝不参与判死结论**。
        var _removal = scanProjectileRemovals(gameController, projectiles);
        var tactics = global.TankTroubleAITactics;
        var audit = { seq: ++_fusedBatchSeq,
            durationFrames: durationFrames,
            purpose: opt.auditPurpose || 'unknown',
            tGlobal: (typeof opt.tGlobal === 'number') ? opt.tGlobal : 0,
            nowTGlobal: (typeof opt.nowTGlobal === 'number') ? opt.nowTGlobal : 0,
            threats: (opt.threats || []).map(function(th) { return th && th.id; }).slice(0,80),
            geometryEnabled: durationFrames > 0 && (opt.auditPurpose === 'jsConfirm' || opt.auditPurpose === 'scanNodeDeath'),
            geometry: { proximity: {} },
            placements: [], contacts: [] };
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
            // v12（1-2④）D2：追踪导弹**只模拟"追我方"的那颗**。追别人的本段摘掉，
            // 并响亮记账（`droppedTargetOther`）；**绝不降级成普通弹**（那是假绿）。
            //
            // 口径（已批准，见第 3/4 轮报告 §五）：建表/摆位这一刻按真游戏的
            //   `currentTargetPlayerId` 判；**"模拟中切目标"无法在融合世界判定**
            //（没有别人的未来轨迹，Rust 融合世界更是连别的坦克都没有）⟹ 只做
            //   "本段摘掉"：下一段 acquire 时会重新读真弹的当前目标，变了就丢。
            //   `currentTargetPlayerId == null`（未激活，还没选目标）**保守保留**。
            if (isHomingMissileProjectile(pr)) {
                var _mTgt = (pr.currentTargetPlayerId === undefined || pr.currentTargetPlayerId === null)
                    ? null : String(pr.currentTargetPlayerId);
                if (_mTgt !== null && _mTgt !== String(aiId)) {
                    _fusedDropStats.droppedTargetOther = (_fusedDropStats.droppedTargetOther || 0) + 1;
                    audit.droppedTargetOther = audit.droppedTargetOther || [];
                    if (audit.droppedTargetOther.length < 16) {
                        audit.droppedTargetOther.push({
                            t: (opt && typeof opt.nowTGlobal === 'number') ? opt.nowTGlobal : 0,
                            pid: (pr.id !== undefined ? pr.id : null),
                            target: _mTgt, aiId: String(aiId)
                        });
                    }
                    fusedDropLog('id=' + (pr.id !== undefined ? pr.id : '?') +
                        ' 追踪导弹目标=别人(' + _mTgt + ') → D2 本段摘掉（audit droppedTargetOther）');
                    continue;
                }
            }
            var rb = pr.getB2DBody();
            var slot = acquireFusedBullet(fc, pr, operations.length);
            slot.pid = (pr && pr.id !== undefined) ? pr.id : null;   // v39：轨迹导出用
            slot.srcInfo = null;                                     // v122：本帧用了哪个时间基准
            var rpos = rb.GetPosition();
            var rvel = rb.GetLinearVelocity();
            var th = threatById[id];

            var placed = false;
            var vx = 0, vy = 0;
            var qLife = 0;
            var tgNow = (typeof opt.tGlobal === 'number' && isFinite(opt.tGlobal)) ? opt.tGlobal : 0;
            var nowTg = (typeof opt.nowTGlobal === 'number' && isFinite(opt.nowTGlobal)) ? opt.nowTGlobal : 0;
            // v167（S7）：节点起点比"现在"早多少（= 段中扫描/复核 commitNode 时的差值）。
            //   >0 表示本批次的真实弹体位姿属于"现在"，不是节点起点那一刻的弹位。
            var tBack = nowTg - tgNow;
            // v165：**寿命扣减必须用「从现在到节点起点」这个基准**（qAge），
            //   不能用下面的 qLife —— qLife = tGlobal - anchorOffset 是**轨迹索引口径**
            //   （用来查 th.track[idx]），锚点通常比"现在"更早。
            //   用 qLife 扣寿命会**多扣 nowTGlobal-anchorOffset**（实测 0.07~0.42 秒）
            //   ⇒ 子弹在引擎里提前消失 ⇒ 该死没算死 ⇒ **显示绿/黄实际会死**。
            // v167（S7）：**不能钳到 0**。qAge = tGlobal - nowTGlobal 就是"从现在到节点
            //   起点"的有符号秒数：节点起点在过去时为负（那时子弹更年轻、剩余寿命更长），
            //   钳到 0 会让"段中复核 commitNode"这一批次的子弹提前 tBack 秒退场
            //   —— 和 S3 同一个错（假绿），只是换在 JS 侧。
            var qAge = tgNow - nowTg;
            // v131：浮点容差——tGlobal 可能是 2.2e-16（shiftSubtreeTime/rebase 累积误差），
            // 绝不能判成"未来节点"走轨迹分支，否则真实弹体摆位被跳过 → 致死弹从融合世界消失。
            // v167（S7）：**只在"节点起点就是现在"时才用真实弹体位姿**。tBack>0 时
            //   真实弹体在弹道上已经比节点起点多走了 tBack×弹速 米（实测 4.6m@0.26s），
            //   直接拿来当节点起点的弹位是错位（审计估 4~15m）→ 走下面的轨迹/折线分支
            //   （与 scoring/threatBulletPos、Rust rescore、树内 trackPosAt 同一口径）。
            if (!(opt.tGlobal > 1e-6) && !(tBack > 1e-6)) {
                slot.body.SetPositionAndAngle(
                    Box2D.Common.Math.b2Vec2.Make(rpos.x, rpos.y), rb.GetAngle());
                vx = rvel.x;
                vy = rvel.y;
                placed = true;
                slot.srcInfo = { src: 'real', off: 0, q: 0, idx: 0 };
            } else if (th) {
                var q = (opt.tGlobal > 1e-6 ? opt.tGlobal : 0) - (th.anchorOffset || 0);
                qLife = Math.max(0, q);
                var qClamped = Math.max(0, q);   // v135：钳到 0，弹锚点比节点晚时也查轨迹
                {
                    // v136：q<0 不再跳过 + idx 用 qClamped + 越界钳到最后一帧
                    var posNow = null, posNext = null, posPrev = null;
                    if (th.track && th.track.length) {
                        var idx = Math.round(qClamped / ((th.trackFrameDt && th.trackFrameDt > 0) ? th.trackFrameDt : FRAME));
                        if (idx >= th.track.length) idx = th.track.length - 1;
                        if (idx >= 0) {
                            var s0 = th.track[idx];
                            // v134：轨迹里的坐标**永远有效**（它记录了弹在哪），
                            // alive 标志只该管寿命（弹是否消失），不该管位置查询。
                            // 原来 alive===false 就放弃摆弹 → 真实还在飞的弹从融合世界消失 → 绿死。
                            if (s0) {
                                posNow = { x: s0.x, y: s0.y };
                                if (idx + 1 < th.track.length) {
                                    var s1 = th.track[idx + 1];
                                    if (s1) {
                                        posNext = { x: s1.x, y: s1.y };
                                    } else if (idx > 0) {
                                        s1 = th.track[idx - 1];
                                        if (s1) posPrev = { x: s1.x, y: s1.y };
                                    }
                                } else if (idx > 0) {
                                    s1 = th.track[idx - 1];
                                    if (s1) posPrev = { x: s1.x, y: s1.y };
                                }
                                // 没有 posNext/posPrev 时：用 s0 自身（静止摆位），
                                // 比完全不摆安全得多。
                                if (!posNext && !posPrev) {
                                    posNext = { x: s0.x + 0.01, y: s0.y };
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
                            idx: Math.round(qClamped / ((th.trackFrameDt && th.trackFrameDt > 0) ? th.trackFrameDt : FRAME))
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
                {
                    // v167（S7）：**允许负值**——节点起点在过去时，要沿真实速度把弹
                    //   "时间反推"回节点起点，而不是从"现在"往前推（原来 max(0,·) 把
                    //   过去节点钉在原地 = 弹位多走 tBack×弹速）。
                    advFrames = Math.round((tgNow - nowTg) / FRAME);
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
                    slot.lifeTotal = lifetimeSecOf(pr);   // v163
                    slot.lifeAge = pr.getTimeAlive ? pr.getTimeAlive() : 0;
                    slot.lifeLeft = Math.max(0, slot.lifeTotal - slot.lifeAge - qAge);   // v165：用 qAge 不是 qLife
                    // v136：不再因 lifeLeft<=0 关弹——弹在 getProjectiles 里就是活的，
                    // 哪怕 1 帧后到期也活满 rollout。原来 lifeLeft<=0 直接关 → 树看不见 → 被打。
                    slot.active = slot.initialSpeed > 0;
                    if (!slot.active) { slot.body.SetActive(false); continue; }
                    // v164：approx 分支也必须落弹种标记。原来这里 continue 掉了公共收尾，
                    //   导致 slot.isShrapnel / prevDirX/Y **既不设也不重置**，而槽位是按
                    //   lastRound 轮询复用的 ⇒ 残留必然发生：破片不消失，或第 1 帧被误杀。
                    var slotProfA = projectileProfileOf(pr);
                    slot.profile = slotProfA;
                    slot.isShrapnel = !!(slotProfA && slotProfA.name === 'MINE_SHRAPNEL');
                    slot.noSpeedNorm = !!(slotProfA && slotProfA.noSpeedNorm);
                    slot.isShotgun = projectileIsShotgun(pr);   // v166：approx 分支也要落弹种标记

                    // v12（1-2④）：approx 分支同样要摆 N 个制导副本（否则制导弹在
                    //   "节点起点在过去"的扫描批次里从融合世界消失 = 假绿）。
                    if (slot.isMissile) {
                        slot.missileInitialSpeed = (typeof slot.missileInitialSpeed === 'number' &&
                            isFinite(slot.missileInitialSpeed) && slot.missileInitialSpeed > 0)
                            ? slot.missileInitialSpeed : MISSILE_LAUNCH_SPEED;
                        placeHomingCopies(fc, slot, fpx, fpy, rvel.x, rvel.y, operations.length);
                        slot.body.SetActive(false);
                    }
                    slot.prevDirX = null; slot.prevDirY = null;
                    slot.srcInfo = { src: 'approx', off: 0, q: qLife, idx: advFrames };
                    audit.placements.push({ pid: slot.pid, active: true, src: 'approx', x: fusedR2(fpx), y: fusedR2(fpy),
                        vx: fusedR2(rvel.x), vy: fusedR2(rvel.y), threat: !!th, trackLen: th && th.track ? th.track.length : 0,
                        idx: advFrames });
                    if (th) _fusedDropStats.approxPlaced++;
                    else _fusedDropStats.noThreat++;
                    fusedDropLog('id=' + (pr.id !== undefined ? pr.id : '?') +
                        ' 原因=' + (th ? (th.track ? 'track取不到位' : '无track且折线越界/缺失') : '威胁表无此弹') +
                        ' 帧移=' + advFrames + '帧(正=前推/负=反推) tGlobal=' + tgNow + ' nowTGlobal=' + nowTg);
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
            // v162/v164：标记弹种（破片撞墙即消失，复刻 Shrapnel.hitMaze 的速度清零）。
            var slotProf = projectileProfileOf(pr);
            slot.profile = slotProf;
            slot.isShrapnel = !!(slotProf && slotProf.name === 'MINE_SHRAPNEL');
            slot.noSpeedNorm = !!(slotProf && slotProf.noSpeedNorm);
            slot.isShotgun = projectileIsShotgun(pr);   // v166：霰弹撞墙/盾后剩余寿命 ≤0.7s（JS 融合/JS track/Rust 三处同改）

            slot.prevDirX = null; slot.prevDirY = null;
            slot.initialSpeed = Math.sqrt(vx * vx + vy * vy);
            slot.lifeTotal = lifetimeSecOf(pr);   // v163
            slot.lifeAge = pr.getTimeAlive ? pr.getTimeAlive() : 0;
            slot.lifeLeft = Math.max(0, slot.lifeTotal - slot.lifeAge - qAge);   // v165：用 qAge 不是 qLife
            // v137：**不再因 lifeLeft<=0 把整颗弹关掉**。lifeLeft 只回答“这颗弹还剩
            // 几帧”，应当由下面逐帧循环到期时自然退场（`bs.lifeLeft -= FRAME` 那段）。
            // 原来 placement 阶段就 `active = speed>0 && lifeLeft>0`，于是一颗
            // “现在还活着、但在这个未来节点已经/即将到期”的弹，会在**它仍然存活的
            // 那几帧**里从融合世界整颗消失 → 死权失明 → 树判 fd=-1 绿节点 → 实际被
            // 打死。这就是“树显示完全安全但 AI 死了”的直接来源。
            // 与 v136 在 !placed 兜底分支改过的口径统一：placement 只看有没有速度。
            slot.active = slot.initialSpeed > 0;
            if (!slot.active) slot.body.SetActive(false);
            // v190（G5 · §12.31C）：**PreSolve 三条规则的等价物**（原文 `_i4_game_roundmodel.js:134-148`）。
            //   Box2D 里 `SetEnabled(false)` 的等价物 = 把这一侧的 mask 去掉 SHIELD ⟹ 根本不建接触。
            //   ① 破片（type=MINE）：禁接触（**不反弹**；"停"由下面的几何检查把速度乘 0 做）
            //   ② 自己的、还没致命的弹：禁接触 ⟹ **穿过自己的盾**（§12.31B：不为它建模拟）
            //   ③ 其余：留接触 ⟹ restitution=1.0 **反弹**；并在接触那一刻记成"已致命"（③的后半）
            applyShieldRuleToSlot(slot, pr, aiId);
            if (slot.isMissile) {
                // v12（1-2④）：制导弹 —— N 个副本摆到共享体的同一落点/速度；
                // 共享体不使用（置 inactive）。副本跑的是**各自候选**的制导弹道。
                slot.missileInitialSpeed = (typeof slot.missileInitialSpeed === 'number' &&
                    isFinite(slot.missileInitialSpeed) && slot.missileInitialSpeed > 0)
                    ? slot.missileInitialSpeed : MISSILE_LAUNCH_SPEED;
                if (slot.active) {
                    placeHomingCopies(fc, slot, slot.body.GetPosition().x, slot.body.GetPosition().y,
                        vx, vy, operations.length);
                } else {
                    parkHomingCopies(slot);
                }
                slot.body.SetActive(false);
            }
            if (slot.active) {
                var ap = slot.body.GetPosition(), av = slot.body.GetLinearVelocity(), asi = slot.srcInfo || {};
                audit.placements.push({ pid: slot.pid, active: true, src: asi.src || null,
                    x: fusedR2(ap.x), y: fusedR2(ap.y), vx: fusedR2(av.x), vy: fusedR2(av.y), threat: !!th,
                    trackLen: th && th.track ? th.track.length : 0,
                    idx: asi.idx == null ? null : asi.idx });
            }
        }
        if (audit.placements.length > 80) audit.placements.length = 80;
        parkUnusedFusedBullets(fc);
        // v188（S1 §12.3 ②）：**摘除** —— 被移除的弹对应的槽显式退休（记账 + 停 body + 断真弹引用）。
        //   注：这些槽因为 `lastRound !== fc.round` 本来就不会再参与判死；这里是**显式化 + 可观测**，
        //   并把残留（projObj/bounces/homing 副本）清干净，免得下一轮复用出幻影弹。
        var _retired = retireFusedBulletSlots(fc, _removal && _removal.abnormal);
        if (_retired) _fusedDropStats.retiredSlots = (_fusedDropStats.retiredSlots || 0) + _retired;
        if (_removal && _removal.abnormal.length) {
            _fusedDropStats.abnormalRemovals = (_fusedDropStats.abnormalRemovals || 0) + _removal.abnormal.length;
        }
        if (_removal && (_removal.vanished.length || _retired)) {
            audit.removal = {
                vanished: _removal.vanished.length,
                abnormal: _removal.abnormal.slice(0, 16),
                normalTimeout: _removal.normalTimeout.length,
                normalHit: _removal.normalHit.length,
                heuristicNormal: _removal.heuristicNormal.length,
                retiredSlots: _retired,
                ledgerInstalled: !!_removal.ledgerInstalled
            };
        }

        // v12（1-2④）：制导弹的导航表（按 maze 对象缓存，整局一次）。
        // 拿不到表 → **响亮停用**本批制导弹（绝不静默直飞：直飞制导弹会造假绿）。
        var missileSlotCount = 0;
        for (i = 0; i < fc.bulletSlots.length; i++) {
            if (fc.bulletSlots[i].lastRound === fc.round && fc.bulletSlots[i].isMissile) missileSlotCount++;
        }
        var navTables = missileSlotCount ? getMazeNavTables(gameController.getMaze()) : null;
        if (missileSlotCount && !navTables) {
            for (i = 0; i < fc.bulletSlots.length; i++) {
                var mns = fc.bulletSlots[i];
                if (mns.lastRound === fc.round && mns.isMissile) {
                    mns.active = false;
                    parkHomingCopies(mns);
                }
            }
            _fusedDropStats.missileNoNav = (_fusedDropStats.missileNoNav || 0) + missileSlotCount;
            fusedDropLog('制导弹在场但拿不到迷宫导航表（buildNextTileTable 失败）→ 本批制导弹全部停用（不直飞）');
        }

        var samples = [], dead = [], deathFrame = [], speeds = [], rotSpds = [], geoHit = [], sweepHit = [];
        // v188（S1 §12.3 ③）：逐 op 死因溯源（只记录）。空表 = 本批还没人死。
        _lastDeathCauses = [];
        _lastDeathCauseSeq = _fusedBatchSeq;
        for (i = 0; i < operations.length; i++) _lastDeathCauses.push({ op: i, causes: [] });
        for (i = 0; i < operations.length; i++) {
            samples.push([]);
            dead.push(false);
            deathFrame.push(-1);
            speeds.push(0);
            rotSpds.push(0);
            geoHit.push(-1);
            sweepHit.push(-1);   // v171：激光扫掠命中帧（只读补判）
        }

        var snapFwd = me.forward, snapBack = me.back,
            snapLeft = me.left, snapRight = me.right,
            snapSpeed = me.speed, snapRotSpd = me.rotationSpeed;
        var locked = !!me.locked;

        for (k = 0; k <= durationFrames; k++) {
            auditFusedGeometry(audit, fc, k);
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
            // v153：几何判死**扫描**（只记不改速）。Box2D 对 sensor 的精确形状测试
            // 被 fat-AABB 门挡住时 e_touchingFlag 保持 false，整场碰撞被漏掉（v151
            // 录像实证 polyGap=-0.34 却 touching=false）。这里逐帧记录“第一次几何
            // 重叠”发生在第几帧，但**不立刻置 dead**——立刻置 dead 会把候选停车，
            // 使 JS/Rust 轨迹分叉（实测 diff_rollout_bridge 会因此报 0.32m 轨迹偏差）。
            // 改成 rollout 跑完后回溯补判：接触路径没抓到时才用它，抓到时以接触为准。
            for (i = 0; i < operations.length; i++) {
                if (geoHit[i] >= 0) continue;
                for (var gbi = 0; gbi < fc.bulletSlots.length; gbi++) {
                    var gbs = fc.bulletSlots[gbi];
                    if (!gbs || gbs.lastRound !== fc.round) continue;
                    // v12（1-2④）：制导弹的几何补判也要**按副本配对** —— 只允许
                    // homingOp == i 的那颗副本把 op i 判死（否则一颗弹全红）。
                    var gbodies = [];
                    if (gbs.isMissile) {
                        var ghl = gbs.homing || [];
                        for (var ghi = 0; ghi < ghl.length; ghi++) {
                            if (ghl[ghi].opIndex === i && ghl[ghi].body && ghl[ghi].body.IsActive()) {
                                gbodies.push(ghl[ghi].body);
                            }
                        }
                    } else if (gbs.body && gbs.body.IsActive()) {
                        gbodies.push(gbs.body);
                    }
                    if (!gbodies.length) continue;
                    var gBoxes = fusedSensorAabbs(fc.candidates[i]);
                    if (!gBoxes.length) continue;
                    var gHitHere = false;
                    for (var gbj = 0; gbj < gbodies.length && !gHitHere; gbj++) {
                        var gbp = gbodies[gbj].GetPosition(), gbf = gbodies[gbj].GetFixtureList(), gbr = 0;
                        try { gbr = gbf && gbf.GetShape && (gbf.GetShape().m_radius || 0); } catch (eGbr) {}
                        var gGate = fusedCircleSensorGap(gbp.x, gbp.y, gbr, gBoxes);
                        if (gGate.gap === null || gGate.gap >= 0.35) continue;
                        var gExact = fusedCircleSensorPolyGap(gbp.x, gbp.y, gbr, fc.candidates[i]);
                        if (gExact && typeof gExact.gap === 'number' && gExact.gap < 0) {
                            geoHit[i] = k;
                            try {
                                if (_lastDeathCauses && _lastDeathCauses[i]) {
                                    _lastDeathCauses[i].causes.push({
                                        frame: k, src: 'geometry',
                                        bulletId: (gbs && gbs.pid !== undefined) ? gbs.pid : null
                                    });
                                }
                            } catch (eCause2) { }
                            if (audit && audit.geometryEnabled) {
                                audit.contacts.push({ k: k, op: i, pid: gbs.pid, category: 'geometry',
                                    polyGapAtContact: fusedR2(gExact.gap), source: 'polyGap-scan' });
                            }
                            gHitHere = true;
                        }
                    }
                    if (gHitHere) break;
                }
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
                    // v128：贴墙爬行校准。树发现真实车在贴墙爬行（实际速度<<名义速度）时
                    // 传入 opt.speedCap（实测 m/s），rollout 的前进速度一律钳到实测值——
                    // 否则模拟车沿墙滑得比真实车快 2~3 倍，段末偏 2+米（实测）。
                    if (typeof opt.speedCap === 'number' && opt.speedCap > 0 && speeds[i] > opt.speedCap) {
                        speeds[i] = opt.speedCap;
                    }
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

            // v171：激光扫掠前置快照 —— 记录 needsSweep 弹在 Step 前的位置。
            for (i = 0; i < fc.bulletSlots.length; i++) {
                var swPre = fc.bulletSlots[i];
                if (swPre.lastRound !== fc.round || !swPre.body || !swPre.body.IsActive() || !swPre.needsSweep) continue;
                var swPP = swPre.body.GetPosition();
                swPre.sweepPrevX = swPP.x; swPre.sweepPrevY = swPP.y;
            }

            fc.world.Step(FRAME, 10, 10);

            // v190（G5）：**护盾接触扫描**（只读接触 + 破片"停"）——
            //   · 非破片：Box2D 已经用 restitution=1.0 反弹完了；这里只记账 + 标"已致命"（§12.31A① 的前提）
            //   · 破片  ：接触被我们禁掉了（掩码去 SHIELD）⟹ 走几何检查把速度乘 0（= 事件里那句 `speed *= 0`）
            scanShieldContacts(fc, operations.length, k);

            // v171（1-2③）：激光扫掠（只读；命中只记 sweepHit[k]，绝不改 body/速度）。
            for (i = 0; i < fc.bulletSlots.length; i++) {
                var swB = fc.bulletSlots[i];
                if (swB.lastRound !== fc.round || !swB.body || !swB.needsSweep) continue;
                if (swB.sweepPrevX === undefined || swB.sweepPrevY === undefined) continue;
                var swP = swB.body.GetPosition();
                var swSegs = fusedSweepSegments(fc.world, swB.sweepPrevX, swB.sweepPrevY, swP.x, swP.y, 4);
                for (var swsi = 0; swsi < swSegs.length; swsi++) {
                    var swseg = swSegs[swsi];
                    for (var swoi = 0; swoi < operations.length; swoi++) {
                        if (sweepHit[swoi] >= 0) continue;
                        if (fusedSegmentSensorPolyHit(swseg.ax, swseg.ay, swseg.bx, swseg.by, fc.candidates[swoi])) {
                            sweepHit[swoi] = k;
                            try {
                                if (_lastDeathCauses && _lastDeathCauses[swoi]) {
                                    _lastDeathCauses[swoi].causes.push({
                                        frame: k, src: 'sweep',
                                        bulletId: (swB && swB.pid !== undefined) ? swB.pid : null
                                    });
                                }
                            } catch (eCause3) { }
                            if (audit && audit.geometryEnabled) {
                                audit.contacts.push({ k: k, op: swoi, pid: swB.pid, category: 'sweep',
                                    source: 'laser-sweep' });
                            }
                        }
                    }
                }
                swB.sweepPrevX = undefined; swB.sweepPrevY = undefined;
            }

            // v166：本 Step 的撞墙/撞盾接触（原版 PreSolve 每个 touching 接触
            // 都会 dispatch PROJECTILE_MAZE/SHIELD_COLLISION → push 时间戳）。
            // 破片（Shrapnel.hitMaze 直接覆盖、不调 super）不记；其余弹种（含
            // 普通弹/双管/霰弹/加特林/激光/导弹）都记，与 rollout.rs 同口径。
            var bounceNow = (k + 1) * FRAME;
            for (i = 0; i < fc.bulletSlots.length; i++) {
                fc.bulletSlots[i].hitThisFrame = 0;
                var hmr = fc.bulletSlots[i].homing || [];
                for (var hmj = 0; hmj < hmr.length; hmj++) hmr[hmj].hitThisFrame = 0;
            }
            forEachProjectileWallContact(fc.world, function (obj, bulletFix) {
                var hitPid = (obj && obj.id !== undefined && obj.id !== null) ? String(obj.id) : null;
                var hitBody = (bulletFix && bulletFix.GetBody) ? bulletFix.GetBody() : null;
                for (var hi = 0; hi < fc.bulletSlots.length; hi++) {
                    var hsl = fc.bulletSlots[hi];
                    if (hsl.lastRound !== fc.round) continue;
                    // v12（1-2④）：制导弹按**副本 body**归账（N 个副本同帧撞同一面墙
                    // 必须各记各的；共用一份 bounces 会当帧 ≥5 → 整颗弹被误杀）。
                    if (hsl.isMissile) {
                        var hml = hsl.homing || [];
                        for (var hmi = 0; hmi < hml.length; hmi++) {
                            if (hml[hmi].body === hitBody) {
                                hml[hmi].hitThisFrame++;
                                return;   // 回调里 return = 这颗 fixture 已归账
                            }
                        }
                        continue;
                    }
                    if (!hsl.body.IsActive()) continue;
                    if (hsl.projObj === obj ||
                            (hitPid !== null && hsl.pid !== undefined && hsl.pid !== null &&
                             String(hsl.pid) === hitPid)) {
                        hsl.hitThisFrame++;
                        break;
                    }
                }
            });
            for (i = 0; i < fc.bulletSlots.length; i++) {
                var hsB = fc.bulletSlots[i];
                if (hsB.lastRound !== fc.round) continue;
                if (hsB.isMissile) {
                    var hmb = hsB.homing || [];
                    for (var hmbj = 0; hmbj < hmb.length; hmbj++) {
                        for (var hmbk = 0; hmbk < hmb[hmbj].hitThisFrame; hmbk++) {
                            hmb[hmbj].bounces.push(bounceNow);
                        }
                    }
                    continue;   // 导弹不是霰弹：没有 clamp 分支
                }
                if (!hsB.body.IsActive() || hsB.hitThisFrame <= 0) continue;
                if (hsB.isShrapnel) continue;   // 破片 hitMaze 不调 super ⇒ 不 push
                for (var hb = 0; hb < hsB.hitThisFrame; hb++) hsB.bounces.push(bounceNow);
                if (hsB.isShotgun) {
                    // Shotgun.hitMaze/hitShield：timeAlive=max(timeAlive, MAX-AFTER)
                    hsB.lifeLeft = clampShotgunLifeLeftAfterHit(hsB.lifeTotal, hsB.lifeLeft);
                }
            }


            for (i = 0; i < fc.bulletSlots.length; i++) {
                var bs = fc.bulletSlots[i];
                if (bs.lastRound !== fc.round || !bs.body.IsActive()) continue;
                bs.lifeLeft -= FRAME;
                if (bs.lifeLeft <= 0) {
                    bs.active = false;
                    bs.body.SetActive(false);
                    continue;
                }
                // v166：`Projectile.update` 的粘性剪枝 + `done()` 第三支（≥5 当帧销毁）。
                // 与 JS track / Rust rollout.rs 逐字同口径；破片不走这三条（自己覆盖 done）。
                if (!bs.isShrapnel) {
                    pruneBounceStamps(bs.bounces, bounceNow, bounceTimeoutWindowSec());
                    if (bs.bounces.length >= bounceTimeoutCount()) {
                        bs.active = false;
                        bs.body.SetActive(false);
                        continue;
                    }
                }

                var bv = bs.body.GetLinearVelocity();
                var blen = bv.Length();
                if (blen === 0) {
                    bs.active = false;
                    bs.body.SetActive(false);
                    continue;
                }
                // v162：破片撞墙即停 —— 复刻 `Shrapnel.hitMaze`（速度清零）。
                // 判据：飞行方向发生了可观测变化（Box2D 的 restitution=1.0 会把它反射），
                // 真实破片不会反弹，所以一旦方向变了就说明撞墙，立刻清零停住。
                // 实证依据：录制 vantage_record_1790925717252.json 地雷致死时
                //   placements=30/36/72、contacts=[]、dfs=[-1]、killer polyGap=1.22
                //   —— 破片在该停的地方弹走了，擦过 1.22 米 → 树全绿 → 死。
                if (bs.isShrapnel && bs.prevDirX !== null) {
                    var dot = (bv.x / blen) * bs.prevDirX + (bv.y / blen) * bs.prevDirY;
                    if (dot < 0.999) {           // 方向变了（约 >2.5°）就是撞墙了
                        bs.body.SetLinearVelocity(Box2D.Common.Math.b2Vec2.Make(0, 0));
                        bs.active = false;
                        bs.body.SetActive(false);
                        continue;
                    }
                }
                if (bs.isShrapnel) { bs.prevDirX = bv.x / blen; bs.prevDirY = bv.y / blen; }
                var blenSq = blen * blen;
                // v164：vanish 类弹（破片）在真实世界靠 `done()`（速度²<=0.01）当帧消失，
                //   且 `Shrapnel.update` 不调 `_super()` ⇒ **没有**基类那条「速度归一化保初速」。
                //   旧代码对它们也归一化 → 本该消失的弹被维持满速继续飞 → 幻影弹。
                if (bs.noSpeedNorm) {
                    if (blenSq <= 0.01) {
                        bs.active = false;
                        bs.body.SetActive(false);
                        continue;   // 复刻 done()：速度≈0 即退场
                    }
                } else {
                    var binitSq = bs.initialSpeed * bs.initialSpeed;
                    if (Math.abs(blenSq - binitSq) > 0.01) {
                        bv.Multiply(bs.initialSpeed / blen);
                        bs.body.SetLinearVelocity(bv);
                    }
                }
            }

            // v12（1-2④）：制导弹逐副本推进 —— `HomingMissile.update` 的逐帧语义。
            // 顺序：`timeAlive += dt` →（撞墙剪枝/done）→ `if (timeAlive > 2.0)` 制导
            // → 「只拉大」归一化（**没有 Math.abs**）。与 Rust `rollout.rs` 的
            // 制导块同口径，`diff_rollout_bridge` 逐帧对拍。
            if (navTables) {
                for (i = 0; i < fc.bulletSlots.length; i++) {
                    var ms = fc.bulletSlots[i];
                    if (ms.lastRound !== fc.round || !ms.isMissile || !ms.active) continue;
                    ms.missileTimeAlive += FRAME;
                    ms.lifeLeft -= FRAME;
                    var mlifeOver = ms.lifeLeft <= 0;
                    var mAnyAlive = false;
                    var mhom = ms.homing || [];
                    for (var mmi = 0; mmi < mhom.length; mmi++) {
                        var mc = mhom[mmi];
                        if (!mc || !mc.body) continue;
                        if (mmi >= operations.length) { mc.body.SetActive(false); continue; }
                        if (!mc.body.IsActive()) continue;
                        if (mlifeOver) { mc.body.SetActive(false); continue; }
                        // `Projectile.update` 粘性剪枝 + `done()` 第三支（每副本独立）。
                        pruneBounceStamps(mc.bounces, bounceNow, bounceTimeoutWindowSec());
                        if (mc.bounces.length >= bounceTimeoutCount()) {
                            mc.body.SetActive(false);
                            continue;
                        }
                        var mv = mc.body.GetLinearVelocity();
                        var mlen = mv.Length();
                        if (mlen === 0) { mc.body.SetActive(false); continue; }
                        var mvx = mv.x, mvy = mv.y;
                        if (ms.missileTimeAlive > MISSILE_ACTIVATION_SEC) {
                            var mpos = mc.body.GetPosition();
                            var mtgt = fc.candidates[mmi].GetPosition();
                            var mst = missileSteerVelocity(navTables, mpos.x, mpos.y, mvx, mvy,
                                (ms.missileInitialSpeed > 0 ? ms.missileInitialSpeed : MISSILE_LAUNCH_SPEED),
                                mtgt.x, mtgt.y, FRAME);
                            mvx = mst.vx; mvy = mst.vy;
                        }
                        mc.body.SetLinearVelocity(Box2D.Common.Math.b2Vec2.Make(mvx, mvy));
                        mAnyAlive = true;
                    }
                    if (!mAnyAlive) ms.active = false;
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
                        // v12（1-2④）：制导弹副本**按 homingOp 配对** —— 只有
                        // homingOp === op 的副本命中本候选 sensor 才作数；其它副本
                        // 穿过本候选一律不算（否则一颗弹会把 9 个候选全判死 = 假死）。
                        var otherUdPair = (udA && udA.type === 'fusedSensor') ? udB : udA;
                        if (otherUdPair && otherUdPair.homingOp !== undefined &&
                                otherUdPair.homingOp !== op) {
                            contact = contact.GetNext();
                            continue;
                        }
                        if (op >= 0 && op < dead.length && !dead[op]) {
                            var sensorFixAudit = (udA && udA.type === 'fusedSensor') ? fixA : fixB;
                            var otherFixAudit = (udA && udA.type === 'fusedSensor') ? fixB : fixA;
                            var otherUdAudit = (udA && udA.type === 'fusedSensor') ? udB : udA;
                            var otherObjAudit = otherUdAudit && otherUdAudit.gameObject;
                            auditContactTruth(fc, sensorFixAudit, otherFixAudit, k, op,
                                otherObjAudit && otherObjAudit.id !== undefined ? otherObjAudit.id : null,
                                otherCat, audit);
                            // v188（S1）：记"这颗弹是凶手"（只记录，不改判定）
                            try {
                                if (_lastDeathCauses && _lastDeathCauses[op]) {
                                    _lastDeathCauses[op].causes.push({
                                        frame: k, src: 'contact',
                                        // ⚠️ 必须问"这个**刚体**本轮是谁"（槽复用 ⟹ userData.gameObject 是老的）
                                        bulletId: _vtFusedBodyPid(fc, (otherFixAudit && otherFixAudit.GetBody) ? otherFixAudit.GetBody() : null)
                                    });
                                }
                            } catch (eCause1) { }
                            dead[op] = true;
                            // v153：IsTouching() 反映的是 Step **之前**那一帧
                            // （b2World::Step 先 Collide() 再 Solve()），所以这里
                            // 记的是“第 k 帧撞上” = 能走 k 步。旧写法 k+1 是整体
                            // 偏大 1 的来源：它把“走 1 步就死”标成 fd=2（橙）而不是
                            // fd=1（红），于是“9 种全红=节点真死”永远凑不齐。
                            deathFrame[op] = k;
                        }
                    }
                }
                contact = contact.GetNext();
            }
            // v151：记录本帧接触链表真值（只在几何审计开启时）。
            auditContactList(audit, fc, k);
        }

        me.forward = snapFwd; me.back = snapBack;
        me.left = snapLeft; me.right = snapRight;
        me.speed = snapSpeed; me.rotationSpeed = snapRotSpd;

        // v153：回溯补判。接触路径没抓到、但几何上确实重叠的，补上死亡帧。
        // 只会让死权更敏感（少漏），不会更迟钝；且不影响 rollout 轨迹，
        // 因此 JS 与 Rust 的物理轨迹保持一致。
        for (i = 0; i < operations.length; i++) {
            if (!dead[i] && geoHit[i] >= 0) {
                dead[i] = true;
                deathFrame[i] = geoHit[i];
                if (audit) audit.geometryFallback = true;
            }
        }
        // v171（1-2③）：激光扫掠回溯补判。与 geoHit 同款：只在 rollout 结束后写 dead，
        // 不改轨迹；fd=k 与接触/geoHit 同语义（能走 k 步）。
        // v12（1-2④）顺手修：**合并规则必须与 Rust 对齐（取更早帧）**。
        //   原写法把 sweep 当 fallback（`!dead[i]`）⟹ 若 `dead[i]` 已被**另一颗弹**
        //   的接触置 true，更早的 sweep 帧会被丢掉 ⟹ JS 偏晚（另一代理实测
        //   1049 条 JS/Rust 分歧全是这一类；5 个真游戏 golden 支持"第一次穿车就死"
        //   = 更早的 sweep 帧，**Rust 对、JS 偏晚**）。Rust `rollout.rs` 的
        //   sweep 合并用的是 min ⟹ 这里也改成"更早帧优先"。
        //   ⚠️ `geoHit` 那处不动：Rust 没有 geometry fallback，改它会让 JS 在非激光
        //   场景比 Rust 更早（本 seed 非激光分歧为 0，另立项）。
        for (i = 0; i < operations.length; i++) {
            if (sweepHit[i] >= 0 && (!dead[i] || sweepHit[i] < deathFrame[i])) {
                dead[i] = true;
                deathFrame[i] = sweepHit[i];
                if (audit) audit.sweepFallback = true;
            }
        }
        audit.sweepHits = sweepHit.slice();
        audit.deathFrames = deathFrame.slice();
        audit.dead = dead.slice();
        // v151：把"几何已重叠但整段 rollout 没有任何接触"的 pair 摘出来，一眼可见。
        if (audit.geometry && audit.geometry.proximity) {
            var missed = [];
            for (var mk in audit.geometry.proximity) {
                if (!audit.geometry.proximity.hasOwnProperty(mk)) continue;
                var mv = audit.geometry.proximity[mk];
                if (mv && typeof mv.polyGap === 'number' && mv.polyGap < 0) missed.push(mv);
            }
            if (missed.length) audit.overlapNoContact = missed.slice(0, 12);
        }
        if (audit.geometry && audit.geometry.proximity) {
            // v149：只留"近失"(gap<2m) 的条目，远距离的整片 45 条是录像体积元凶。
            var gkeys = Object.keys(audit.geometry.proximity), gkeep = {};
            for (var gi = 0; gi < gkeys.length; gi++) {
                var gv = audit.geometry.proximity[gkeys[gi]];
                if (gv && typeof gv.polyGap === 'number' && gv.polyGap < 2.0) gkeep[gkeys[gi]] = gv;
            }
            var gk2 = Object.keys(gkeep);
            if (gk2.length > 16) { var g2 = {}; for (var gj = 0; gj < 16; gj++) g2[gk2[gj]] = gkeep[gk2[gj]]; gkeep = g2; }
            audit.geometry.proximity = gkeep;
        }
        _lastFusedBatchSummary = audit;
        _fusedBatchAuditHistory.push(audit);
        if (_fusedBatchAuditHistory.length > MAX_FUSED_AUDIT_HISTORY) _fusedBatchAuditHistory.shift();
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
    var _deathWorldSig = null;   // v178（1-4-a）：建这个世界时用的炮塔形状签名

    /**
     * @param {Object} consts - 常量表
     * @param {Object} [shape] - v178：炮塔形状 `{name, launched, polys}`；缺省/legacy ⟹ 炮弹炮塔（原状）
     */
    function ensureDeathWorld(consts, shape) {
        var sig = shape ? shapeSignature(shape) : null;
        if (_deathWorld && _deathWorldSig === sig) return;
        if (_deathWorld) {     // v178 候选体重建：签名变了 ⟹ 整个死亡世界（含炮塔夹具）拆掉重建
            _deathWorld = null;
            _deathTankBody = null;
            _deathBulletBodies = [];
        }
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

        // 炮塔（前伸，**每块一个 fixture**：激光 = 碟 + 天线两块；拿地雷/导弹已发射 = 0 块）
        // ——顶点顺序与游戏 _create*TurretFixtureDefs 完全一致
        // （绕序错误会导致 Box2D 法线朝内、碰撞失效，2026-08-09 实测踩坑）
        // v178（1-4-a）：轮廓来源从"写死 BULLET_TURRET"改成"当前武器"；缺省 = 原状（逐字节同旧版）。
        var turretPolys = (shape && shape.polys) ? shape.polys
            : [turretRectPoly(0, consts.TURRET_OFFSET_Y, consts.TURRET_WIDTH, consts.TURRET_HEIGHT)];
        for (var tp = 0; tp < turretPolys.length; tp++) {
            var poly = turretPolys[tp];
            if (!poly || poly.length < 3) continue;
            var verts = [];
            for (var vi = 0; vi < poly.length; vi++) {
                verts.push(Box2D.Common.Math.b2Vec2.Make(poly[vi].x, poly[vi].y));
            }
            var turretFixture = new Box2D.Dynamics.b2FixtureDef();
            turretFixture.shape = new Box2D.Collision.Shapes.b2PolygonShape.AsArray(verts);
            turretFixture.density = 0.0;
            turretFixture.userData = { type: 'tankTurret' };
            _deathTankBody.CreateFixture(turretFixture);
        }

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
     * @param {Object} [shape] - v178（1-4-a）：判死轮廓（当前武器的炮塔）；缺省 = 原状炮弹炮塔
     * @returns {boolean} 是否死亡
     */
    function checkDeath(tankState, bulletPositions, consts, shape) {
        ensureDeathWorld(consts, shape);

        // v22 性能预筛：若没有子弹中心落在“坦克最远夹具半径 + 子弹半径”内，
        // 静态重叠检测不可能有接触，直接返回 false，省掉死亡世界 Step。
        // 这是纯粗筛：只跳过“几何上不可能死亡”的情况，命中区仍走原 Box2D 判定。
        // ⚠️ v178：这个半径**故意保持**用炮弹炮塔算出来的保守值（所有武器里最大：
        //   炮弹 2.7 / 激光天线 2.7 / 加特林·霰弹 2.625 / 导弹 2.65 / 双管 2.3 / 地雷 无）
        //   ⟹ 对任何武器都只会"多算不会漏判"，不随武器变，免得粗筛变成漏筛。
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
    // v177（阶段 2-2）：死亡事件采集器（订阅式 · **不 wrap 任何游戏方法**）
    // ============================================================
    // 为什么「订阅就够、不需要 wrap RoundController.killTank」：
    //   RoundModel.killTank / destroyTank 只做 `destroyedPlayerIds.push(pid)`，
    //   **不删坦克**；真正 delete 坦克的是 `_removeDestroyed()`，而它在
    //   RoundModel.update() 里的语句顺序是：
    //       _removeDestroyed() → b2dworld.Step() → _filterAndDispatchCollisionEvents()
    //       → _removeDestroyed()   ← 坦克在这里才被 delete
    //       → 各实体 update()      ← tank.x/y/rotation 在这里才刷新
    //   ⟹ 事件回调里 `gc.getTank(pid)` **必定还在**；但读到的 x/y/rot 是
    //      **上一帧末**的值（滞后 1 帧），b2dbody 才是本帧 Step 后的值。
    //   ⟹ wrap 的信息增量 = 0（只是「同一行拿到 kill+tank」），却要在产品路径上
    //      改核心方法 —— 所以本采集器**一个游戏方法都不包**。
    var COLLECTOR_KEY = '__vtDeathCollector';   // ★ 自己的字段名：避开 _trainingKillPatched / _vtbKillWrapped
    var DEATHS_CAP = 64;                        // 每局保留上限（防御性；正常一局远小于）
    var ERRORS_CAP = 16;
    var _deathDebugThrow = null;                // 仅测试用：设成事件名（键或值）后，该事件进采集器时先抛错
    var _deathDebugThrowMode = 'inner';         // 'inner' = 抛在【我们自己的 try 内】(默认，验证自己的 catch)
                                                // 'outer' = 抛在【try 之外】(验证外层 try/catch 会吞掉它)
    var _deathTestThrowCount = 0;               // 抛错次数（应等于被我们 catch 到的次数）

    function _vtNowMs() {
        try {
            return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        } catch (e) { return null; }
    }

    function _vtZoneCause(zone) {
        var out = 'unknown';
        try {
            var T = (typeof Constants !== 'undefined' && Constants.ZONE_TYPES) ? Constants.ZONE_TYPES : null;
            if (zone && T && typeof zone.getType === 'function') {
                var zt = zone.getType();
                if (zt === T.STORM) out = 'storm';
                else if (zt === T.SPAWN) out = 'spawn';
            }
        } catch (eZC) {}
        return out;
    }

    /** 只读位姿：主口径 = tank 缓存（**上一帧末**）；同时附 b2dbody（**本帧 Step 后**）供对齐 */
    function _vtPoseOf(gc, pid) {
        var out = { x: null, y: null, rot: null, poseSrc: 'missing', bodyX: null, bodyY: null, bodyRot: null };
        try {
            var t = (gc && typeof gc.getTank === 'function') ? gc.getTank(pid) : null;
            if (!t) return out;
            out.x = (typeof t.getX === 'function') ? t.getX() : null;
            out.y = (typeof t.getY === 'function') ? t.getY() : null;
            out.rot = (typeof t.getRotation === 'function') ? t.getRotation() : null;
            out.poseSrc = 'tankCache';
            try {
                var b = (typeof t.getB2DBody === 'function') ? t.getB2DBody() : null;
                if (b && b.GetPosition) {
                    out.bodyX = b.GetPosition().x;
                    out.bodyY = b.GetPosition().y;
                    out.bodyRot = (b.GetAngle ? b.GetAngle() : null);
                }
            } catch (eB) {}
        } catch (eP) {}
        return out;
    }

    /**
     * 测试用的「故意抛错」是否命中当前事件。
     * ⚠️ 事件名有两套写法：`RoundModel._EVENTS.TANK_KILLED` 是 **键**，派发时传的是 **值**
     *    （`"tank killed"`）⟹ 两套都要认，否则 setDeathDebugThrow('TANK_KILLED') 永远不命中
     *    （这个 bug 是本探针第一次跑出来的：throws=0/errors=0）。
     */
    function _vtThrowMatches(evt) {
        if (_deathDebugThrow === null) return false;
        if (evt === _deathDebugThrow) return true;
        try {
            var E = (typeof RoundModel !== 'undefined' && RoundModel && RoundModel._EVENTS) ? RoundModel._EVENTS : null;
            if (E && E[_deathDebugThrow] === evt) return true;
        } catch (e) {}
        return false;
    }

    function _vtNewDeathCollector(gc) {
        var col = {
            gc: gc,
            deaths: [],            // 本局死亡记录（**全部是值拷贝，不含任何游戏对象引用**）
            lastRound: [],         // 上一局（ROUND_CREATED 时归档）
            byPid: {},             // pid -> 记录对象（**先到先写**）
            lastZoneCause: {},     // pid -> 'storm' | 'spawn' | 'unknown'
            pendingContact: {},    // pid -> 最近一次致命/毒雾碰撞的接触点（值拷贝）
            errors: [],            // ★ 我们自己吞掉的异常（不能指望外层）
            deathsOverflow: 0,
            seq: 0,
            installed: false,
            subCount: 0,
            handler: null
        };
        // ★ 回调签名是 (self/ctxt, gameId, evt, data) —— 第 3 个参数才是 evt！
        col.handler = function (self, gameId, evt, data) {
            var hit = _vtThrowMatches(evt);
            if (hit) _deathTestThrowCount++;
            if (hit && _deathDebugThrowMode === 'outer') {
                // 【测试模式 outer】故意在【我们自己的 try 之外】抛 —— 用来证明
                // RoundModel._notifyEventListeners 的 try/catch 会把异常吞掉（只 console.log）
                // ⟹ 谁都不能指望它，必须自己 catch。
                throw new Error('[VantageSandbox 采集器] 测试用故意抛错(outer) evt=' + evt);
            }
            try {
                if (hit) {
                    // 【测试模式 inner】抛在 try 内 ⟹ 下面 的 catch 必须记到
                    throw new Error('[VantageSandbox 采集器] 测试用故意抛错(inner) evt=' + evt);
                }
                _vtOnRoundEvent(col, evt, data);
            } catch (err) {
                // ★ 坑①：RoundModel._notifyEventListeners 的 try/catch 只 console.log，
                //    我们必须【自己 catch + 自己留证据】，否则就是「游戏没事、数据静默丢」。
                if (col.errors.length < ERRORS_CAP) {
                    col.errors.push({
                        where: 'handler',
                        evt: String(evt),
                        msg: String((err && err.message) || err),
                        stack: String((err && err.stack) || ''),
                        seq: col.seq,
                        tWallMs: _vtNowMs()
                    });
                }
                try {
                    console.warn('[VantageSandbox 死亡采集器] 回调内异常已自行捕获（游戏不受影响）:',
                        (err && err.message) || err, 'evt=' + evt);
                } catch (eW) {}
            }
        };
        return col;
    }

    function _vtApplyContact(rec, e) {
        if (!rec || !e) return;
        if (rec.contactX === null && typeof e.x === 'number') rec.contactX = e.x;
        if (rec.contactY === null && typeof e.y === 'number') rec.contactY = e.y;
        if (rec.contactNx === null && typeof e.nx === 'number') rec.contactNx = e.nx;
        if (rec.contactNy === null && typeof e.ny === 'number') rec.contactNy = e.ny;
        if (rec.contactSrc === null && e.srcKind) rec.contactSrc = e.srcKind;
        if (rec.deadlyX === null && typeof e.px === 'number') { rec.deadlyX = e.px; rec.deadlyY = e.py; }
        if (rec.deadlyVx === null && typeof e.vx === 'number') { rec.deadlyVx = e.vx; rec.deadlyVy = e.vy; }
        if (rec.deadlyType === null && typeof e.projectileType === 'number') rec.deadlyType = e.projectileType;
    }

    /** 记录一次碰撞的接触点（值拷贝）；若该 pid 已有死亡记录就顺带回填 ⟹ **顺序无关** */
    function _vtNoteContact(col, pid, point, normal, projectile, srcKind) {
        if (pid === null || pid === undefined) return;
        var e = col.pendingContact[pid] || (col.pendingContact[pid] = { srcKind: srcKind });
        e.srcKind = srcKind || e.srcKind;
        if (point) {
            if (typeof point.x === 'number') e.x = point.x;
            if (typeof point.y === 'number') e.y = point.y;
        }
        if (normal) {
            if (typeof normal.x === 'number') e.nx = normal.x;
            if (typeof normal.y === 'number') e.ny = normal.y;
        }
        if (projectile) {
            e.px = (typeof projectile.getX === 'function') ? projectile.getX() : null;
            e.py = (typeof projectile.getY === 'function') ? projectile.getY() : null;
            e.vx = (typeof projectile.getSpeedX === 'function') ? projectile.getSpeedX() : null;
            e.vy = (typeof projectile.getSpeedY === 'function') ? projectile.getSpeedY() : null;
            e.projectileType = (typeof projectile.getType === 'function') ? projectile.getType() : null;
        }
        e.tWallMs = _vtNowMs();
        // ⚠️ TANK_KILLED 会【先】到：killTank 是在 RC._modelEventHandler 里嵌套派发的，
        //    而 RC 的监听器注册在我们之前 ⟹ 我们的 TANK_KILLED 回调早于我们的碰撞回调。
        //    所以这里必须能「回填」，不能只靠 pendingContact 的存在。
        var rec = col.byPid[pid];
        if (rec) _vtApplyContact(rec, e);
    }

    /** 写一条死亡记录：**按 pid 先到先写**（后到的只补空洞，绝不覆盖已有位置/口径） */
    function _vtWriteDeath(col, pid, extra) {
        if (pid === null || pid === undefined) return null;
        col.seq++;
        var rec = col.byPid[pid];
        if (!rec) {
            rec = {
                seq: col.seq,
                victimPlayerId: pid,
                killerPlayerId: null, experience: null, deadlyId: null, deadlyType: null,
                x: null, y: null, rot: null, poseSrc: null,
                bodyX: null, bodyY: null, bodyRot: null,
                src: null, cause: null,
                contactX: null, contactY: null, contactNx: null, contactNy: null, contactSrc: null,
                deadlyX: null, deadlyY: null, deadlyVx: null, deadlyVy: null,
                pairedEvents: [],
                tWallMs: _vtNowMs()
            };
            var pose = _vtPoseOf(col.gc, pid);   // ★ 值拷贝；此刻坦克还没被 _removeDestroyed 删掉
            rec.x = pose.x; rec.y = pose.y; rec.rot = pose.rot; rec.poseSrc = pose.poseSrc;
            rec.bodyX = pose.bodyX; rec.bodyY = pose.bodyY; rec.bodyRot = pose.bodyRot;
            if (col.deaths.length < DEATHS_CAP) col.deaths.push(rec);
            else col.deathsOverflow++;
            col.byPid[pid] = rec;
        } else {
            var pose2 = _vtPoseOf(col.gc, pid);
            if (rec.x === null && pose2.x !== null) { rec.x = pose2.x; rec.y = pose2.y; rec.rot = pose2.rot; rec.poseSrc = pose2.poseSrc; }
            if (rec.bodyX === null && pose2.bodyX !== null) { rec.bodyX = pose2.bodyX; rec.bodyY = pose2.bodyY; rec.bodyRot = pose2.bodyRot; }
        }
        if (extra) {
            if (extra.src && rec.pairedEvents.indexOf(extra.src) < 0) rec.pairedEvents.push(extra.src);
            for (var k in extra) {
                if (Object.prototype.hasOwnProperty.call(extra, k)) {
                    if (rec[k] === null || rec[k] === undefined) rec[k] = extra[k];
                }
            }
        }
        _vtApplyContact(rec, col.pendingContact[pid]);
        return rec;
    }

    function _vtOnRoundEvent(col, evt, data) {
        var E = (typeof RoundModel !== 'undefined' && RoundModel && RoundModel._EVENTS) ? RoundModel._EVENTS : null;
        if (!E) return;   // 引擎没加载：静默返回（不抛）
        switch (evt) {
            case E.ROUND_CREATED: {
                // ★ 每局清表：endRound 会 this.tanks={}，缓存必须一起失效
                col.lastRound = col.deaths;
                col.deaths = [];
                col.byPid = {};
                col.lastZoneCause = {};
                col.pendingContact = {};
                col.deathsOverflow = 0;
                col.seq = 0;
                break;
            }
            case E.TANK_DEADLY_COLLISION: {
                var pid1 = (data && data.tankA && typeof data.tankA.getPlayerId === 'function')
                    ? data.tankA.getPlayerId() : null;
                _vtNoteContact(col, pid1, data && data.collisionPoint, data && data.collisionNormal,
                    data && data.projectile, 'deadlyCollision');
                break;
            }
            case E.TANK_ZONE_COLLISION: {
                var pid2 = (data && data.tankA && typeof data.tankA.getPlayerId === 'function')
                    ? data.tankA.getPlayerId() : null;
                if (pid2 !== null && pid2 !== undefined) {
                    col.lastZoneCause[pid2] = _vtZoneCause(data && data.zone);
                    // ⚠️ 嵌套派发顺序：`killTank/destroyTank` 是 RC._modelEventHandler【先】处理的，
                    //    所以我们的 TANK_DESTROYED 回调会【早于】这条 zone 回调 ⟹ 那时 cause 还是
                    //    'unknown'。这里必须回填，否则毒雾/出生区致死永远记不出真因。
                    var recZ = col.byPid[pid2];
                    if (recZ && (recZ.cause === null || recZ.cause === undefined || recZ.cause === 'unknown')) {
                        recZ.cause = col.lastZoneCause[pid2];
                    }
                }
                _vtNoteContact(col, pid2, data && data.collisionPoint, data && data.collisionNormal,
                    null, 'zoneCollision');
                break;
            }
            case E.TANK_KILLED: {
                // data = Kill 对象（有 getter）
                var pid3 = (data && typeof data.getVictimPlayerId === 'function') ? data.getVictimPlayerId() : null;
                if (pid3 === null || pid3 === undefined) break;
                _vtWriteDeath(col, pid3, {
                    src: 'TANK_KILLED',
                    cause: 'projectile',
                    killerPlayerId: (typeof data.getKillerPlayerId === 'function') ? data.getKillerPlayerId() : null,
                    experience: (typeof data.getExperience === 'function') ? data.getExperience() : null,
                    deadlyId: (typeof data.getDeadlyId === 'function') ? data.getDeadlyId() : null,
                    deadlyType: (typeof data.getDeadlyType === 'function') ? data.getDeadlyType() : null
                });
                break;
            }
            case E.TANK_DESTROYED: {
                // ★ data = 裸 playerId 字符串（**不是对象**！和 TANK_KILLED 不一样）
                var pid4 = (typeof data === 'string')
                    ? data
                    : ((data === null || data === undefined) ? null : String(data));
                if (pid4 === null) break;
                _vtWriteDeath(col, pid4, {
                    src: 'TANK_DESTROYED',
                    cause: col.lastZoneCause[pid4] || 'unknown'
                });
                break;
            }
        }
    }

    /** GC 里我们的 handler 挂了几份（**期望恰好 1**；挂两份 = 回调跑两次） */
    function _vtSubCount(gc, cb) {
        var n = 0;
        try {
            var a = (gc && gc.roundEventListeners) ? gc.roundEventListeners : [];
            for (var i = 0; i < a.length; i++) { if (a[i] && a[i].cb === cb) n++; }
        } catch (e) {}
        return n;
    }

    /** 幂等安装：同一个 gc 只订阅一次。换 GC（新一局）= 自动重装。 */
    function _vtEnsureDeathCollector(gc) {
        if (!gc) return null;
        if (gc[COLLECTOR_KEY]) return gc[COLLECTOR_KEY];   // ★ 幂等闸门
        var col = _vtNewDeathCollector(gc);
        gc[COLLECTOR_KEY] = col;
        if (typeof gc.addRoundEventListener === 'function') {
            try {
                // ★ 订阅在 GameController 上：RoundController/RoundModel 每回合新建，
                //   而 GC 会在 _createRoundController() 里把所有 roundEventListeners
                //   **自动重挂到新 RC** ⟹ 回合重启**不需要**重订阅。
                gc.addRoundEventListener(col.handler, col);
                col.installed = true;
            } catch (eSub) {
                col.errors.push({
                    where: 'subscribe', evt: '',
                    msg: String((eSub && eSub.message) || eSub),
                    stack: '', seq: 0, tWallMs: _vtNowMs()
                });
            }
        }
        col.subCount = _vtSubCount(gc, col.handler);
        return col;
    }

    function _vtCopyRecord(r) {
        var o = {}, k;
        for (k in r) {
            if (!Object.prototype.hasOwnProperty.call(r, k)) continue;
            o[k] = Array.isArray(r[k]) ? r[k].slice() : r[k];
        }
        return o;
    }
    function _vtCopyList(list) {
        var out = [], i;
        for (i = 0; i < list.length; i++) out.push(_vtCopyRecord(list[i]));
        return out;
    }

    // ============================================================
    // v188（S1 · 权威版 §12.3）：子弹「非正常消失」的**移除链**
    //
    // 【图纸】§12.3 三件事：① 识别（对比真实世界的弹列表）② 摘除（槽置空闲 / body 停用）
    //   ③ 更新树里受影响帧的生死（**单调放活，不重跑死亡检测**）。
    //
    // 【现状（施工前读码结论，见报告 §二）】
    //   · ② 已经有一半：`acquireFusedBullet` 按 **真实弹列表** 逐轮重新 acquire，
    //     没被 acquire 的槽由 `parkUnusedFusedBullets` 把 body 停用（lastRound 轮询复用）。
    //     ⟹ **消失的弹不会留在融合世界里参与判死**（这半边本来就是对的）。
    //   · ① **完全没有**：沙箱从没把"这颗弹不该再存在了"显式识别/记账；
    //     树那边自己做了一份（`vantage_tree.js` 的 `removedIdsBetween`）。
    //   · ③ **完全没有**：判死只输出 `{dead, deathFrame}`，**没有"这颗弹是凶手"的溯源**，
    //     所以"把某颗弹摘掉 ⟹ 把被它判死的帧放活"在沙箱里无从下手。
    //
    // 【本段做什么】只加**只读观测 + 两个纯函数**，绝不改判死结论：
    //   ① `scanProjectileRemovals()`：逐批对比真实弹列表，把"上批见过、这批没了"的弹
    //      按**游戏自己的事件**分类（正常/非正常），并给出假阳率口径（naive 对照）。
    //   ② `retireFusedBulletSlots()`：把被移除的弹对应的槽显式退休（记账 + 停 body）。
    //   ③ `_lastDeathCauses` 溯源 + `releaseDeathsAfterRemoval()`：**纯函数**，只从
    //      已经记下来的死亡原因里剔掉被移除的弹，重新取最早帧 —— 不重跑任何物理/接触。
    //
    // 【口径 · 以游戏自己的代码为准】`RoundModel`（= `_i4_game_roundmodel.js` 美化副本）
    //   里"弹为什么会没"只有 3 条路：
    //     · `timeoutProjectile()` → 事件 `PROJECTILE_TIMEOUT`（**寿命到了 = 正常**）
    //     · `destroyProjectile()` → 事件 `PROJECTILE_DESTROYED`（**撞掉/被吃掉 = 正常**）
    //     · `removeTank(playerId)` → 把该玩家**所有弹**塞进 `destroyedProjectileIds`
    //       （随后 `delete this.projectiles[...]`），**不派发任何 PROJECTILE_* 事件**，
    //       只派发一个 `TANK_CHICKENED_OUT`（载荷 `ChickenOut.getProjectileIds()`）
    //       ⟹ **这才是 §10.2 说的"有人非正常退出 → 他的子弹全消失"**。
    //   ⟹ 于是"非正常"有一条**零歧义**的判据：**弹没了，但既没有 TIMEOUT 也没有
    //      DESTROYED 事件**（或收到了 CHICKENED_OUT 的名单）。
    //      正常超时/正常撞掉一定各有一条事件 ⟹ **不会误报**（假阳率可实测，报告 §四）。
    //   ⚠️ `killTank/destroyTank`（**击杀**）在 `_removeDestroyed` 里**只删坦克不删弹**
    //      （源码原文：只对 `destroyedPlayerIds` 删 body/weapon/upgrade；弹另按
    //      `destroyedProjectileIds` 删）⟹ **本 round 代码里"击杀对手"不会让他的弹消失**。
    //      这与权威版 §10.2 括号里的"击杀对手"不一致 ⟹ **已登记待核**（报告 §六）。
    // ============================================================
    var PROJECTILE_LEDGER_KEY = '__vtProjectileLedger';   // ★ 独立字段：不挤占 2-2 采集器
    var MAX_LEDGER_SEEN = 512;                            // 上限（防长局无限增长）

    function _vtFrameDtSec() { return _frameDtSec; }

    function _vtEventName(key, fallback) {
        try {
            var E = (typeof RoundModel !== 'undefined' && RoundModel && RoundModel._EVENTS) ? RoundModel._EVENTS : null;
            if (E && E[key]) return E[key];
        } catch (e) { }
        return fallback;
    }

    function _vtNewProjectileLedger(gc) {
        var led = {
            gc: gc,
            seen: {},              // id → { firstT, lastT, owner, type, lifeLeft }
            events: {},            // id → 'timeout' | 'destroyed' | 'chickenout'
            removed: {},           // id → { class, t, owner, type, lifeLeftAtLastSight }
            order: [],             // 移除顺序（有上限）
            chickenOutPids: 0,
            stats: {
                seenTotal: 0,
                vanishedTotal: 0,          // ★ naive 口径：只看"id 从列表消失"
                normalTimeout: 0,          // 寿命到了（有事件）
                normalHit: 0,              // 撞掉/被吃（有事件）
                normalHeuristic: 0,        // 无事件但残寿≈0 → 判为正常（启发式兜底）
                abnormalExit: 0,           // CHICKENED_OUT 名单里的（有人退出）
                abnormalNoEvent: 0,        // 无事件且寿命未尽（★ 真正要抓的）
                roundResets: 0,
                errors: 0
            },
            installed: false,
            handler: null
        };
        // ★ 回调签名 (self/ctxt, gameId, evt, data) —— 与 2-2 采集器同一套（第 3 个才是 evt）
        led.handler = function (self, gameId, evt, data) {
            try {
                var EV_TO = _vtEventName('PROJECTILE_TIMEOUT', 'projectile timeout');
                var EV_DE = _vtEventName('PROJECTILE_DESTROYED', 'projectile destroyed');
                var EV_CO = _vtEventName('TANK_CHICKENED_OUT', 'tank chickened out');
                var EV_RC = _vtEventName('ROUND_CREATED', 'round created');
                if (evt === EV_TO) {
                    if (typeof data === 'string' || typeof data === 'number') led.events[String(data)] = 'timeout';
                } else if (evt === EV_DE) {
                    if (typeof data === 'string' || typeof data === 'number') led.events[String(data)] = 'destroyed';
                } else if (evt === EV_CO) {
                    // ☆ 游戏直接把"这个退出玩家的弹"名单交给我们（零歧义）
                    var ids = [];
                    try {
                        if (data && typeof data.getProjectileIds === 'function') ids = data.getProjectileIds() || [];
                    } catch (eIds) { ids = []; }
                    for (var i = 0; i < ids.length; i++) led.events[String(ids[i])] = 'chickenout';
                    led.chickenOutPids += ids.length;
                } else if (evt === EV_RC) {
                    // 换局：上一局的弹全没了，**这是正常的** ⟹ 清账，不许记成移除
                    led.seen = {};
                    led.events = {};
                    led.stats.roundResets++;
                }
            } catch (eH) {
                led.stats.errors++;
            }
        };
        return led;
    }

    /** 幂等安装（同一个 gc 只订阅一次；换 GC = 自动重装）。 */
    function _vtEnsureProjectileLedger(gc) {
        if (!gc) return null;
        if (gc[PROJECTILE_LEDGER_KEY]) return gc[PROJECTILE_LEDGER_KEY];
        var led = _vtNewProjectileLedger(gc);
        gc[PROJECTILE_LEDGER_KEY] = led;
        if (typeof gc.addRoundEventListener === 'function') {
            try {
                gc.addRoundEventListener(led.handler, led);
                led.installed = true;
            } catch (eSub) {
                led.stats.errors++;
            }
        }
        return led;
    }

    /** 剩余寿命（秒）；破片 lifetime=0 是"无寿命上限"哨兵 → 返回 null（不做启发式） */
    function _vtLifeLeftOf(pr) {
        try {
            var total = lifetimeSecOf(pr);
            if (!(total > 0)) return null;
            var age = (pr && typeof pr.getTimeAlive === 'function') ? pr.getTimeAlive() : 0;
            if (!isFinite(age)) return null;
            return Math.max(0, total - age);
        } catch (e) { return null; }
    }

    /**
     * ① 识别：对比真实世界的弹列表。**只读**（不碰任何 body / 不碰判死）。
     * @param {Object} gameController
     * @param {Object} [liveProjectiles] 可选的"本帧真实弹表"（调用方刚取过的，避免重复取）
     * @returns {Object} {abnormal:[id…], normalTimeout:[…], normalHit:[…], heuristicNormal:[…],
     *                    vanished:[…], stats, ledgerInstalled}
     */
    function scanProjectileRemovals(gameController, liveProjectiles) {
        var led = _vtEnsureProjectileLedger(gameController);
        var res = { abnormal: [], normalTimeout: [], normalHit: [], heuristicNormal: [],
                    vanished: [], stats: null, ledgerInstalled: !!(led && led.installed) };
        if (!led) return res;
        var pr = liveProjectiles;
        if (!pr) {
            try { pr = gameController.getProjectiles ? gameController.getProjectiles() : {}; } catch (e0) { pr = {}; }
        }
        var tNow = _vtNowMs();
        var live = {}, id, p;
        var nSeen = 0;
        for (id in led.seen) { if (Object.prototype.hasOwnProperty.call(led.seen, id)) nSeen++; }
        for (id in pr) {
            if (!Object.prototype.hasOwnProperty.call(pr, id)) continue;
            p = pr[id];
            live[String(id)] = 1;
            var rec = led.seen[String(id)];
            if (!rec) {
                if (nSeen >= MAX_LEDGER_SEEN) continue;      // 上限：超了就只统计不记账
                rec = led.seen[String(id)] = { firstT: tNow, lastT: tNow, owner: null, type: null, lifeLeft: null };
                nSeen++;
                led.stats.seenTotal++;
            }
            rec.lastT = tNow;
            rec.lifeLeft = _vtLifeLeftOf(p);
            if (p) {
                try { rec.owner = (typeof p.getPlayerId === 'function') ? p.getPlayerId() : rec.owner; } catch (eOw) { }
                try { rec.type = (typeof p.getType === 'function') ? p.getType() : rec.type; } catch (eTy) { }
            }
        }
        // "消失" = 上批见过 − 这批还在
        var goneIds = [];
        for (id in led.seen) {
            if (!Object.prototype.hasOwnProperty.call(led.seen, id)) continue;
            if (!live[id]) goneIds.push(id);
        }
        for (var g = 0; g < goneIds.length; g++) {
            var gid = goneIds[g], grec = led.seen[gid];
            var ev = led.events[gid] || null;
            var cls;
            if (ev === 'timeout') cls = 'normalTimeout';
            else if (ev === 'destroyed') cls = 'normalHit';
            else if (ev === 'chickenout') cls = 'abnormalExit';
            else {
                // 无事件：用"最后一次看到时还剩多少寿命"当启发式兜底
                //   ⚠️ 残寿 ≤ 1.5 帧 ⟹ 判成正常超时（否则会把正常超时记成移除 = 假阳）
                var lf = (grec && typeof grec.lifeLeft === 'number') ? grec.lifeLeft : null;
                cls = (lf !== null && lf <= 1.5 * _vtFrameDtSec()) ? 'heuristicNormal' : 'abnormalNoEvent';
            }
            res.vanished.push(gid);
            led.stats.vanishedTotal++;
            if (cls === 'normalTimeout') { res.normalTimeout.push(gid); led.stats.normalTimeout++; }
            else if (cls === 'normalHit') { res.normalHit.push(gid); led.stats.normalHit++; }
            else if (cls === 'heuristicNormal') { res.heuristicNormal.push(gid); led.stats.normalHeuristic++; }
            else {
                res.abnormal.push(gid);
                if (cls === 'abnormalNoEvent') led.stats.abnormalNoEvent++;
                else led.stats.abnormalExit++;
                led.removed[gid] = {
                    class: cls, t: tNow, owner: grec ? grec.owner : null, type: grec ? grec.type : null,
                    lifeLeftAtLastSight: grec ? grec.lifeLeft : null
                };
                led.order.push(gid);
                if (led.order.length > 64) led.order.shift();
            }
            delete led.seen[gid];
            delete led.events[gid];
        }
        res.stats = _vtCopyRecord(led.stats);
        res.t = tNow;
        return res;
    }

    /** ② 摘除：把"已被移除的弹"对应的融合世界槽显式退休（body 停用 + 清残留）。 */
    /** 融合体 → 它**本轮**代表的真弹 id（槽是轮询复用的，body 的 userData.gameObject 是建体那刻的老弹）。 */
    function _vtFusedBodyPid(fc, body) {
        if (!fc || !body || !fc.bulletSlots) return null;
        for (var i = 0; i < fc.bulletSlots.length; i++) {
            var sl = fc.bulletSlots[i];
            if (!sl) continue;
            if (sl.body === body) return (sl.pid === undefined ? null : sl.pid);
            var hm = sl.homing || [];
            for (var j = 0; j < hm.length; j++) {
                if (hm[j] && hm[j].body === body) return (sl.pid === undefined ? null : sl.pid);
            }
        }
        return null;
    }

    function retireFusedBulletSlots(fc, removedIds) {
        var retired = 0;
        if (!fc || !fc.bulletSlots || !removedIds || !removedIds.length) return retired;
        var rm = {}, i;
        for (i = 0; i < removedIds.length; i++) rm[String(removedIds[i])] = 1;
        for (i = 0; i < fc.bulletSlots.length; i++) {
            var slot = fc.bulletSlots[i];
            if (!slot) continue;
            if (slot.lastRound === fc.round) continue;             // 本轮还在飞 → 不动
            if (!rm[String(slot.pid)]) continue;                    // 不是被移除的那颗 → 不动
            slot.retired = true;
            slot.retiredAt = fc.round;
            slot.removedReason = 'abnormal-removal';
            slot.active = false;
            slot.projObj = null;                                    // ★ 断开真弹引用
            slot.bounces = [];
            slot.hitThisFrame = 0;
            slot.sweepPrevX = undefined; slot.sweepPrevY = undefined;
            slot.srcInfo = null;
            if (slot.body) { try { slot.body.SetActive(false); } catch (eB) { } }
            var hm = slot.homing || [];
            for (var hj = 0; hj < hm.length; hj++) {
                if (hm[hj] && hm[hj].body) { try { hm[hj].body.SetActive(false); } catch (eH) { } }
            }
            retired++;
        }
        return retired;
    }

    /**
     * ③ 单调放活（**纯函数**，不重跑死亡检测）：把"死亡原因里含被移除弹"的那些帧重新裁定。
     * 归因来自 `_lastDeathCauses`（**上一次融合批次**逐步记下来的每 op 死因）。
     * @param {Array} deaths - 与批次同序的 [{dead, deathFrame}, …]（树里节点的生死就长这样）
     * @param {Array} removedIds - 被移除的弹 id
     * @returns {Object} {results:[{dead,deathFrame,released}], released, moved, kept, unattributed, monotoneOk}
     */
    function releaseDeathsAfterRemoval(deaths, removedIds, causesTable) {
        // ⚠️ 归因表必须与 deaths **同一次批次**：缺省用"最近一次融合批次"的 `_lastDeathCauses`。
        //    如果调用方在两次之间还跑过别的批次（例如扫描/确认），**必须显式传 causesTable**，
        //    否则归因会张冠李戴（探针第一版就踩了：A 批的死因被 B 批的空表顶掉 ⟹ unattributed=1）。
        var CT = (causesTable && causesTable.length) ? causesTable : _lastDeathCauses;
        var out = { results: [], released: 0, moved: 0, kept: 0, unattributed: 0, monotoneOk: true,
                    usedOwnCauses: !!(causesTable && causesTable.length),
                    removedIds: (removedIds || []).slice() };
        if (!deaths || !deaths.length) return out;
        var rm = {}, i, j;
        for (i = 0; i < (removedIds || []).length; i++) rm[String(removedIds[i])] = 1;
        for (i = 0; i < deaths.length; i++) {
            var d = deaths[i] || {};
            var wasDead = !!d.dead;
            var oldFd = (typeof d.deathFrame === 'number') ? d.deathFrame : -1;
            var rec = { dead: wasDead, deathFrame: oldFd, released: false };
            if (!wasDead || oldFd < 0) { out.results.push(rec); out.kept++; continue; }
            var cs = (CT && CT[i]) ? CT[i].causes : null;
            if (!cs || !cs.length) {
                // 归因不明（例如被"非弹"的东西判死）→ **保守不动**
                out.unattributed++;
                out.results.push(rec); out.kept++; continue;
            }
            var survive = [];
            for (j = 0; j < cs.length; j++) {
                var c = cs[j];
                if (c && c.bulletId !== null && c.bulletId !== undefined && !rm[String(c.bulletId)]) survive.push(c);
            }
            if (survive.length === cs.length) { out.results.push(rec); out.kept++; continue; }  // 与移除的弹无关
            if (!survive.length) {
                rec.dead = false; rec.deathFrame = -1; rec.released = true;
                out.released++;
            } else {
                var f = survive[0].frame;
                for (j = 1; j < survive.length; j++) if (survive[j].frame < f) f = survive[j].frame;
                rec.deathFrame = f;                    // 只可能更晚（去掉了更早的原因）
                if (f > oldFd) out.moved++; else out.kept++;
            }
            if (rec.dead && rec.deathFrame < oldFd) out.monotoneOk = false;   // 单调性自检
            if (!wasDead && rec.dead) out.monotoneOk = false;                // 活→死 绝不允许
            out.results.push(rec);
        }
        return out;
    }


    // ============================================================
    // v189（S1-毒雾）：毒雾判死 —— **纯几何、无 Box2D**
    //
    // 【权威依据】权威版 §12.30（`docs/Vantage躲弹实现/01-设计理论/权威与定案/智能体架构-权威版-2026-10-07.md:2414`）
    //   A 状态量（6 个）· B 每帧 update 原文 · C getCorners 完整公式 · D 安全区 = 一个矩形
    //   逐步对照见 `docs/Vantage躲弹实现/02-实现/进展记录/毒雾判死进沙箱-2026-10-13.md` §二。
    //
    // 【为什么纯几何就够】§12.30.D：原版每帧把 4 条边带 fixture **全部销毁重建**，
    //   等价于"安全区 = 矩形 [stormEndLeft, stormStartRight] × [stormEndTop, stormStartBottom]"，
    //   坦克只要有任何一部分超出这个矩形就死 ⟹ 不需要建任何 Box2D 体。
    //
    // 【硬约束（施工纪律）】
    //   · **不建 body、不碰融合世界、不碰判死权威**：只在**批次出口**叠加"毒雾出界即死"，
    //     只可能【活 → 死】，**绝不复活**任何既有死亡。
    //   · **不推坦克**：没有夹具/接触 ⟹ 物理采样逐字节不变（探针有反向验证）。
    //   · 场上没有 STORM zone ⟹ **零开销**直接返回（无风暴场景逐字节不变）。
    //   · 读状态只读**活 zone 对象**（= 游戏 `update` 用的那一份）；序列取 `zone._expansionSequence`
    //     —— ⚠️ **绝不调 `maze.getStormExpansionSequence()`**（实测：每调一次重抽一条新序列）。
    //   · 任一步取不到（无 getZones / 常量缺失 / 字段不是数）⟹ 返回 null ⟹ 不做毒雾判死
    //     （与 v178 形状签名同款"取不到就保持原状"安全阀）。
    // ============================================================
    var _STORM_LAST = null;   // 最近一次毒雾判死审计（只给探针/报告读，不参与逻辑）

    /** 读 §12.30.A 的 6 个状态量；没有 STORM zone 或取不全 → null */
    function stormStateOf(gameController) {
        var C = (typeof Constants !== 'undefined') ? Constants : null;
        if (!C || !C.ZONE_TYPES || !gameController || typeof gameController.getZones !== 'function') return null;
        var zones = null;
        try { zones = gameController.getZones(); } catch (eZ) { return null; }
        if (!zones) return null;
        var z = null, id;
        for (id in zones) {
            if (!zones.hasOwnProperty(id)) continue;
            var cand = zones[id];
            if (cand && typeof cand.getType === 'function' && cand.getType() === C.ZONE_TYPES.STORM) { z = cand; break; }
        }
        if (!z) return null;
        var tb = z._tileBounds, seq = z._expansionSequence, t = z._expansionTime;
        if (!tb || typeof tb.minX !== 'number' || typeof tb.maxX !== 'number' ||
            typeof tb.minY !== 'number' || typeof tb.maxY !== 'number') return null;
        if (!seq || typeof seq.length !== 'number' || seq.length < 1) return null;
        if (typeof t !== 'number' || !isFinite(t)) return null;
        var TILE = (C.MAZE_TILE_SIZE && typeof C.MAZE_TILE_SIZE.m === 'number') ? C.MAZE_TILE_SIZE.m : null;
        var WALL = (C.MAZE_WALL_WIDTH && typeof C.MAZE_WALL_WIDTH.m === 'number') ? C.MAZE_WALL_WIDTH.m : null;
        var GROW = (typeof C.STORM_ZONE_START_GROW_TIME === 'number') ? C.STORM_ZONE_START_GROW_TIME : null;
        var CYCLE = (typeof C.STORM_ZONE_EXPANSION_TIME === 'number') ? C.STORM_ZONE_EXPANSION_TIME : null;
        if (TILE === null || WALL === null || GROW === null || CYCLE === null || !(GROW > 0)) return null;
        var r = z._expansionTilesRight, b = z._expansionTilesBottom, l = z._expansionTilesLeft, tp = z._expansionTilesTop;
        return {
            t: t, side: z._expansionSide,
            r: (typeof r === 'number') ? r : 0, b: (typeof b === 'number') ? b : 0,
            l: (typeof l === 'number') ? l : 0, tp: (typeof tp === 'number') ? tp : 0,
            seq: seq, tb: tb, TILE: TILE, WALL: WALL, GROW: GROW, CYCLE: CYCLE
        };
    }

    /**
     * §12.30.B 的每帧逻辑（**原文逐句**，含首帧与重置两个边界）：
     *   t -= dt; if (t <= GROW) { if (side < 0) { side = seq[已扩总格数]; 该边 +1 } }
     *   if (t <= 0) { side = -1; t = CYCLE }
     * ⚠️ 只改"安全区几何"要用到的量；`_rebuildTiles()`/`changeZone()` 是**逻辑格列表**与状态广播，
     *    与几何无关（而且 `getTiles()` 领先夹具一格，§12.30 明确不许当危险区）⟹ 这里不复刻。
     */
    function stormStepState(s, dt) {
        s.t -= dt;
        if (s.t <= s.GROW) {
            if (s.side < 0) {
                s.side = s.seq[s.r + s.b + s.l + s.tp];
                switch (s.side) {
                    case 0: s.r += 1; break;
                    case 1: s.b += 1; break;
                    case 2: s.l += 1; break;
                    case 3: s.tp += 1; break;
                }
            }
        }
        if (s.t <= 0.0) {
            s.side = -1;
            s.t = s.CYCLE;
        }
        return s;
    }

    /** §12.30.C 的 `getCorners()` 四个**内边界** = §12.30.D 的安全区矩形 */
    function stormSafeRect(s) {
        var ratio = Math.max(0.0, Math.min(1.0, (s.GROW - s.t) / s.GROW));
        var tb = s.tb;
        return {
            R: ((tb.maxX + 1) - (s.r - (s.side === 0 ? 1.0 - ratio : 0.0))) * s.TILE,
            B: ((tb.maxY + 1) - (s.b - (s.side === 1 ? 1.0 - ratio : 0.0))) * s.TILE,
            L: (tb.minX + s.l - (s.side === 2 ? 1.0 - ratio : 0.0)) * s.TILE,
            T: (tb.minY + s.tp - (s.side === 3 ? 1.0 - ratio : 0.0)) * s.TILE
        };
    }

    /**
     * 坦克（车体 + 当前武器炮塔）在给定位姿下，**超出安全区矩形的最大量**（米）。
     * 负 = 完全在内；>= 0 = 有部分在外（或正好压线）⟹ 死。
     * 口径：凸多边形完全在凸矩形内 ⟺ 所有顶点都在内（逐顶点判，**不是**取 AABB）。
     * ⚠️ 炮塔取"当前武器"的形状（`resolveTankShape`，含 MINE/导弹已发射 ⟹ 无炮管）。
     */
    function stormPolyOvershoot(consts, shape, x, y, rot, rect) {
        var c = Math.cos(rot), sn = Math.sin(rot);
        var worst = -Infinity;
        function testLocal(px, py) {
            var wx = x + c * px - sn * py;
            var wy = y + sn * px + c * py;
            var ov = rect.L - wx;                       // 越过左边界
            if (wx - rect.R > ov) ov = wx - rect.R;     // 右
            if (rect.T - wy > ov) ov = rect.T - wy;     // 上
            if (wy - rect.B > ov) ov = wy - rect.B;     // 下
            if (ov > worst) worst = ov;
        }
        testLocal(-consts.TANK_HALF_WIDTH, -consts.TANK_HALF_HEIGHT);
        testLocal(consts.TANK_HALF_WIDTH, -consts.TANK_HALF_HEIGHT);
        testLocal(consts.TANK_HALF_WIDTH, consts.TANK_HALF_HEIGHT);
        testLocal(-consts.TANK_HALF_WIDTH, consts.TANK_HALF_HEIGHT);
        var polys = (shape && shape.polys) ? shape.polys : [];
        for (var i = 0; i < polys.length; i++) {
            for (var j = 0; j < polys[i].length; j++) testLocal(polys[i][j].x, polys[i][j].y);
        }
        return worst;
    }

    /**
     * 把毒雾判死叠加到一批模拟结果上（**原地改 results**，返回同一个数组）。
     *
     * 时序口径（**照原版帧内顺序推导，不是拍的**）：
     *   `RoundModel.update` 里 `world.Step`（碰撞）**在** `zone.update`（重建夹具）**之前**
     *   ⟹ 第 N 帧碰撞用的是 `state(N−1)` 的几何。
     *   所以判据 = `overshoot(samples[N], rect(state(N−1))) >= 0`（N 从 1 起；N=0 是本帧位姿，
     *   本帧的碰撞已经发生过——坦克还活着才会被问 ⟹ 不检 N=0）。
     *   边界压线算死（对齐 Box2D `touching`：正好接触也触发）。
     */
    function applyStormDeaths(gameController, playerId, results, durationFrames) {
        if (!results || !results.length) return results;
        var s0 = stormStateOf(gameController);
        if (!s0) { _STORM_LAST = null; return results; }        // ⚡ 没有毒雾：零开销
        var consts = buildConstants();
        var shape = null;
        try { shape = resolveTankShape(gameController, playerId, consts); } catch (eSh) { shape = null; }
        var audit = {
            shape: shape ? (shape.name + (shape.launched ? ':launched' : '')) : null,
            t0: Math.round(s0.t * 1e4) / 1e4, side0: (s0.side === undefined ? null : s0.side),
            tiles0: [s0.r, s0.b, s0.l, s0.tp], rect0: null, ops: [],
            injected: 0, keptEarlier: 0, alreadyDead: 0
        };
        audit.rect0 = stormSafeRect(s0);
        for (var i = 0; i < results.length; i++) {
            var res = results[i];
            if (!res || res.stormChecked) continue;
            res.stormChecked = true;
            var samples = res.samples;
            if (!samples || !samples.length) continue;
            var oldFd = (typeof res.deathFrame === 'number') ? res.deathFrame : -1;
            var oldDead = !!res.dead;
            if (oldDead && oldFd >= 0) { audit.alreadyDead++; continue; }
            var s = { t: s0.t, side: s0.side, r: s0.r, b: s0.b, l: s0.l, tp: s0.tp,
                      seq: s0.seq, tb: s0.tb, TILE: s0.TILE, WALL: s0.WALL, GROW: s0.GROW, CYCLE: s0.CYCLE };
            var lim = Math.min(durationFrames, samples.length - 1);
            var fd = -1, ov = null;
            for (var k = 1; k <= lim; k++) {
                var smp = samples[k];
                if (!smp) break;
                ov = stormPolyOvershoot(consts, shape, smp.x, smp.y, smp.rot, stormSafeRect(s));
                if (ov >= 0) { fd = k; break; }
                stormStepState(s, _frameDtSec);
            }
            audit.ops.push({ op: i, fd: fd, ov: (typeof ov === 'number' && isFinite(ov)) ? Math.round(ov * 1e6) / 1e6 : null,
                             oldFd: oldFd, lim: lim });
            if (fd < 0) continue;
            res.dead = true;
            res.deathFrame = fd;
            res.stormDeath = true;
            res.stormDeathFrame = fd;
            res.stormOvershoot = audit.ops[audit.ops.length - 1].ov;
            // ⚠️ 与 S1（移除链）的交互：该 op 原来那条"弹杀"已被更早的毒雾死**取代** ⟹
            //    把它记下的弹因清空，让 `releaseDeathsAfterRemoval` 走
            //    "归因不明 → 保守不动"（否则它可能按"弹被移除"把毒雾死复活成活）。
            //    只在"同一次批次"（长度一致，且本函数紧跟批次同步执行）时清。
            if (_lastDeathCauses && _lastDeathCauses.length === results.length && _lastDeathCauses[i]) {
                _lastDeathCauses[i].causes = [];
            }
            audit.injected++;
        }
        _STORM_LAST = audit;
        return results;
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

        // v177（阶段 2-2）：在本 gc 上安装死亡事件采集器（幂等；**只订阅，不 wrap 任何游戏方法**）
        //   · 订阅挂在 GameController 上 ⟹ 回合重启时 GC 会自动重挂到新 RC，**不用重订阅**
        //   · 同一个 gc 只装一次（gc[COLLECTOR_KEY] 幂等闸门）；换 gc（新一局）自动重装
        var deathCollector = _vtEnsureDeathCollector(gameController);

        // ── v175（阶段2-1）：只读取数小工具（全部 try 包裹，取不到就给 null，绝不改游戏状态）──
        // 护盾升级类型码：Constants.UPGRADE_TYPES.SHIELD === 2（b714588d…:行1@4009）
        var SHIELD_UPGRADE_TYPE = (typeof Constants !== 'undefined' && Constants.UPGRADE_TYPES)
            ? Constants.UPGRADE_TYPES.SHIELD : 2;

        /** 读 Classy 私有字段：先走 getField（自动去 `_` 前缀），再兜底直读 `_name` */
        function _priv(obj, name) {
            if (!obj) return null;
            try {
                if (typeof obj.getField === 'function') {
                    var v = obj.getField(name);
                    if (v !== undefined && v !== null) return v;
                }
            } catch (eGF) {}
            var key = '_' + name;
            return (obj[key] !== undefined) ? obj[key] : null;
        }

        /** 当前武器弹药（活对象；⚠️ 绝不读序列化 fieldsJSON —— 那条路会全 null） */
        function _ammoOf(playerId) {
            var w = null;
            try { w = gameController.getActiveWeapon(playerId); } catch (eA) {}
            if (!w) return null;
            var numBullets = _priv(w, 'numBullets');
            var bulletsFired = _priv(w, 'bulletsFired');
            return {
                weaponId: (w.getId ? w.getId() : null),
                type: (w.getType ? w.getType() : null),
                numBullets: numBullets,
                bulletsFired: bulletsFired,
                numMines: _priv(w, 'numMines'),
                triggerPulled: _priv(w, 'triggerPulled'),
                // 两种口径**原样给、不换算**：
                //   默认枪（BulletWeapon）：_numBullets=初值(5)、_bulletsFired 递增 ⟹ 剩余=numBullets-bulletsFired
                //   双管/霰弹/地雷/加特林：_numBullets/_numMines 直接递减 ⟹ 本身就是剩余
                remainingByDifference: (numBullets !== null && bulletsFired !== null)
                    ? (numBullets - bulletsFired) : null
            };
        }

        /** 护盾（在 upgrades 里，**不在** MODIFIER_TYPES —— 后者只有 {SPEED:0}，b714588d…:行1@4295） */
        function _shieldOf(playerId) {
            var u = null;
            try {
                if (typeof gameController.getUpgradeByPlayerIdAndType === 'function') {
                    u = gameController.getUpgradeByPlayerIdAndType(playerId, SHIELD_UPGRADE_TYPE);
                }
            } catch (eS) {}
            if (!u) return null;
            return {
                upgradeId: (u.getId ? u.getId() : null),
                type: (u.getType ? u.getType() : null),
                lifetime: _priv(u, 'lifetime'),
                weakened: _priv(u, 'weakened')
            };
        }

        /** 武器活对象的摘要（id/type/全部自定义字段） */
        function _weaponSummary(w) {
            if (!w) return null;
            var fields = null;
            try { fields = (typeof w.getFields === 'function') ? w.getFields() : null; } catch (eWF) {}
            return {
                id: (w.getId ? w.getId() : null),
                playerId: (w.getPlayerId ? w.getPlayerId() : null),
                type: (w.getType ? w.getType() : null),
                fields: fields
            };
        }

        var adapter = {
            // —— 常量 ——
            constants: consts,

            // —— 操作定义 ——
            operations: OPERATIONS,

            // —— 数据获取 ——
            getTankState: function() {
                var tank = gameController.getTank(aiId);
                if (!tank) return null;
                // v175（阶段2-1）：【只加字段】—— x/y/rot 这三个既有字段含义原样不动。
                //   按键 5 个 + locked：⚠️ Tank.getForward/getBack/getLeft/getRight/getFireDown
                //   在 locked 时**全部返回 false**（7b2ed8ad…:行3 每个 getter 体内都有
                //   `if(this.locked){return false;}`）⟹ 不给 locked 就分不清「没按」与「被武器锁定」。
                //   speed/rotationSpeed 同样在 locked 时被归零（同文件 getSpeed/getRotationSpeed）。
                //   弹药/护盾走下面两个只读小工具（_ammoOf/_shieldOf），失败一律给 null，绝不抛。
                return {
                    x: tank.getX(),
                    y: tank.getY(),
                    rot: tank.getRotation(),
                    forward: tank.getForward ? tank.getForward() : null,
                    back: tank.getBack ? tank.getBack() : null,
                    left: tank.getLeft ? tank.getLeft() : null,
                    right: tank.getRight ? tank.getRight() : null,
                    fireDown: tank.getFireDown ? tank.getFireDown() : null,
                    locked: tank.getLocked ? tank.getLocked() : null,
                    speed: tank.getSpeed ? tank.getSpeed() : null,
                    rotationSpeed: tank.getRotationSpeed ? tank.getRotationSpeed() : null,
                    ammo: _ammoOf(aiId),
                    shield: _shieldOf(aiId)
                };
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
                        speedY: p.getSpeedY ? p.getSpeedY() : 0,
                        // v173（1-2④）：树侧要用它做「追踪导弹换目标 → 刷新」
                        //   （权威版 §10.2 第④条）。v172 及以前这里一个字段都没给，
                        //   所以那条刷新触发器全仓没有任何实现（实测 grep 0 次引用）。
                        //   只加字段、不改任何既有消费方的口径（projectileSignature 只用 id）。
                        type: p.getType ? p.getType() : null,
                        targetId: (p.currentTargetPlayerId === undefined || p.currentTargetPlayerId === null)
                            ? null : p.currentTargetPlayerId,
                        // v175（阶段2-1）：lifeLeft = lifetime − getTimeAlive()。
                        //   ⚠️ lifeTotal 直读【普通实例属性】p.lifetime：游戏里 **没有 getLifetime()**
                        //   （418577fd…:行4 Projectile.fields 有 lifetime/timeAlive，方法区只有 getTimeAlive）。
                        //   ⚠️ 地雷破片（Shrapnel）建体时 lifetime 传 0 ⟹ 它的 lifeLeft 恒 ≤0，
                        //   这不是 bug，是「碎片一出即老」的真实口径（见本文件 v161 注释）。
                        //   ✅ 只加这一个字段；bounces/deadlyToOwner/stopped【本轮故意不加】（要主人拍 6/9 维）。
                        lifeLeft: (typeof p.lifetime === 'number' && p.getTimeAlive)
                            ? (p.lifetime - p.getTimeAlive()) : null
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

            // ══════════════════════════════════════════════════════════════════
            // v175（阶段2-1）：纯转发取数（**只加**；全部是 GameController 上真实存在的方法，
            //   逐个已在 ce217c9b…:行1 核对过：@17186/@17287/@17903/@17691/@18914/@18712/
            //   @10202/@18561/@18004/@18121/@18240/@16639/@16785/@16838/@9905）。
            //   返回【活对象】（与既有 getMaze/getB2DWorld 同口径），不拷贝、不换算。
            // ══════════════════════════════════════════════════════════════════
            getTank: function(playerId) {
                return gameController.getTank(playerId);
            },

            getTanks: function() {
                return gameController.getTanks();
            },

            getCollectibles: function() {
                return gameController.getCollectibles();
            },

            getTraps: function() {
                return gameController.getTraps();
            },

            getZones: function() {
                return gameController.getZones();
            },

            getUpgradeByPlayerIdAndType: function(playerId, type) {
                return gameController.getUpgradeByPlayerIdAndType(playerId, type);
            },

            getScores: function() {
                return gameController.getScores();
            },

            getScoreByPlayerIdAndType: function(playerId, type) {
                return gameController.getScoreByPlayerIdAndType(playerId, type);
            },

            getCounters: function() {
                var out = [];
                var counters = null;
                try { counters = gameController.getCounters(); } catch (eC) {}
                for (var cid in counters) {
                    var c = counters[cid];
                    if (!c) continue;
                    out.push({
                        id: cid,
                        type: (c.getType ? c.getType() : null),
                        // 剩余秒：TimerCountdownCounter._currentTime 递减 / OvertimeCountUpCounter._currentTime 递增
                        // （7b2ed8ad…:行32@34499 / 行34@35206）
                        currentTime: _priv(c, 'currentTime'),
                        startTime: _priv(c, 'startTime')
                    });
                }
                return out;
            },

            /** 回合/游戏状态字符串（GameModel._STATES：between rounds/counting down/in round/ended） */
            getState: function() {
                return gameController.getState ? gameController.getState() : null;
            },

            /**
             * ⚠️ 与游戏里 RoundState.getWeaponStates() **不是同一个东西**（那个只在 expanded
             * 的 RoundState 上，且游戏侧 GameController/RoundController 都没透出 getWeapons）。
             * 本方法是【逐玩家】口径：getActiveWeapon + getDefaultWeapon + getQueuedWeapons
             * （ce217c9b…:行1@18004/@18121/@18240），不受 RoundState 的 expanded 位影响。
             */
            getWeaponStates: function(playerId) {
                var id = (playerId === undefined || playerId === null) ? aiId : String(playerId);
                var active = null, def = null, queued = [];
                try { active = gameController.getActiveWeapon(id); } catch (eWA) {}
                try { def = gameController.getDefaultWeapon(id); } catch (eWD) {}
                try {
                    var q = gameController.getQueuedWeapons(id) || [];
                    for (var i = 0; i < q.length; i++) queued.push(_weaponSummary(q[i]));
                } catch (eWQ) {}
                return {
                    playerId: id,
                    active: _weaponSummary(active),
                    default: _weaponSummary(def),
                    queued: queued
                };
            },

            /**
             * ⚠️【如实标注】返回值**恒为 Constants.TEAMS.NO_TEAM = 0**。
             * 证据：所有已实现的 GameMode.getTeam() 都 `return Constants.TEAMS.NO_TEAM`
             * （54518faa…:行45@41391；Classic 继承、Deathmatch 行49 同款），且 addPlayer 硬编码
             * NO_TEAM（ce217c9b…:行1@5081）；全仓 grep：TEAM_RED/TEAM_BLUE **只出现在常量定义处**，
             * 没有任何写入点。字段是真字段，数据是假数据 ⟹ 保留能力，但**观测编码阶段不要编队友段**。
             */
            getTeam: function(playerId) {
                var id = (playerId === undefined || playerId === null) ? aiId : String(playerId);
                var player = null;
                try { player = gameController.getActivePlayer(id); } catch (ePA) {}
                if (!player) {
                    try { player = gameController.getQueuedPlayer(id); } catch (ePQ) {}
                }
                if (player && typeof player.getTeam === 'function') return player.getTeam();
                return null;
            },

            /**
             * RoundState 快照。expanded=false 时等价于 GameController.getRoundState()（它内部传
             * this.playerAdded）；expanded=true 时**直达 RoundController.getRoundState(true)**
             * （82e43ebf…:行1@7800 `expandedState |= !this.initialRoundStateSent`）。
             * ⚠️ 结构性坑：地雷/武器/升级/计时器/毒雾五段**只在 expanded 时**才有
             * （46989e39…:行1@18340 `if(expandedState){this._getExpandedRoundState(rs);}`）
             * ⟹ 那五类请直接走 getTraps/getUpgradeByPlayerIdAndType/getZones/getCounters/getWeaponStates。
             */
            getRoundState: function(expanded) {
                var rc = gameController.roundController || null;
                if (expanded && rc && typeof rc.getRoundState === 'function') {
                    try { return rc.getRoundState(true); } catch (eRS) {}
                }
                return gameController.getRoundState ? gameController.getRoundState() : null;
            },

            /** 地图/对局配置四件套（对称 / 毒雾开关 / 可刷新道具类型 / 玩家上限）+ 模式 */
            getMatchConfig: function() {
                var gm = null;
                try { gm = gameController.getGameMode ? gameController.getGameMode() : null; } catch (eGM) {}
                // ⚠️ crateTypes 在游戏里【只有字段、没有 getter】（ce217c9b…:行1@731 字段块；
                //   getCrateTypes 只存在于网络消息 CreateGameMessage，54518faa…:行32@16571）
                var crates = null;
                try {
                    if (gameController.crateTypes && gameController.crateTypes.length !== undefined) {
                        crates = Array.prototype.slice.call(gameController.crateTypes);
                    } else if (gm && gm.crateTypes && gm.crateTypes.length !== undefined) {
                        crates = Array.prototype.slice.call(gm.crateTypes);
                    }
                } catch (eCT) {}
                return {
                    symmetric: gameController.getSymmetric ? gameController.getSymmetric() : null,
                    storm: gameController.getStorm ? gameController.getStorm() : null,
                    crateTypes: crates,
                    maxActivePlayerCount: gameController.getMaxActivePlayerCount ? gameController.getMaxActivePlayerCount() : null,
                    mode: gameController.getMode ? gameController.getMode() : null,
                    premium: gameController.getPremium ? gameController.getPremium() : null,
                    ranked: gameController.getRanked ? gameController.getRanked() : null
                };
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
                    // v161：**按弹种决定反弹次数**。原实现一律用全局 `bounces`，
                    // 对不会反弹的弹也是 6 次全图射线，纯浪费。
                    // 地雷破片（Shrapnel）实测：`hitMaze` 把速度清零 → 撞墙即停、不反弹，
                    // 且 `done()` 在速度≈0 时返回 true → 立刻消失。
                    // 所以对 MINE(4) 用 0 次反弹 = **1 次射线**（原来 6 次，省 6 倍），
                    // 而且路径末端正好落在墙上，与真实行为一致。
                    // 依据：`Shrapnel.hitMaze`/`done`（本地版与正式版代码一致）。
                    // v164：反弹次数改由**弹种档案**决定（原来只特判 MINE）。
                    //   破片/激光 wall='vanish' ⇒ 0 次（1 条射线，撞墙即止，与真实一致）。
                    var effBounces = bounces;
                    try {
                        var _profP = projectileProfileOf(p);
                        if (_profP && typeof _profP.bounces === 'number') effBounces = _profP.bounces;
                    } catch (eType) {}
                    var pathInfo = B2DUtils.calculateProjectilePath(world, p, effBounces, maxLen, false);
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
                        type: (p.getType ? p.getType() : null),
                        sweep: !!(_profP && _profP.needsSweep),
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
            /**
             * v193（§15.4#1）：**道具下一次刷新**（**纯读新增 getter**）。
             * 「何时」= 游戏自己的倒计时 `gm.crateSpawnDuration`（剩余秒；游戏 `gameMode.update`
             *   `_i4_game_messages.js:1584-1596` 每帧 `-= deltaTime`，且**只在 场上箱子数 < MAX_CRATES 时**才走）。
             * @returns {Object|null} {count,maxCrates,spawnDuration,counting,symmetric,nextTile,nextKnown,types}
             * ⚠️「在哪刷」= **永久不可得**（对称/非对称都一样，见报告 §十一）：getCrateSpawnPosition 内部也是 Math.random（_getRandomPosition→MathUtils.randomArrayEntry）+ 写 maze.used，调用会消费 2 个随机数 ⟹ ⛔ 本 getter 绝不调它。
            getCrateSpawnInfo: function() {
                var gm = null;
                try { gm = gameController.getGameMode ? gameController.getGameMode() : null; } catch (eG1) { }
                if (!gm) return null;
                var o = { count: null, maxCrates: null, spawnDuration: null, counting: false,
                          symmetric: null, types: null };
                try { o.count = gameController.roundController ? gameController.roundController.getCrateCount() : null; } catch (eG2) { }
                try { o.maxCrates = (typeof Constants !== 'undefined' && Constants.MAX_CRATES !== undefined) ? Constants.MAX_CRATES : null; } catch (eG3) { }
                try {
                    if (typeof gm.crateSpawnDuration === 'number') o.spawnDuration = gm.crateSpawnDuration;
                    if (gm.crateTypes && gm.crateTypes.length !== undefined) o.types = Array.prototype.slice.call(gm.crateTypes);
                } catch (eG4) { }
                // v196：还必须 crateTypes 非空（没开箱的局游戏里根本不走这段倒计时）
                var hasTypes = !!(o.types && o.types.length > 0);
                o.counting = (o.count !== null && o.maxCrates !== null && hasTypes) ? (o.count < o.maxCrates) : false;
                try { o.symmetric = gameController.getSymmetric ? gameController.getSymmetric() : null; } catch (eG5) { }
                return o;
            },

            simulateTank: function(state, inputs, durationFrames, opt) {
                opt = opt || {};
                if (!opt.startPose) opt.startPose = state;
                var _single = simulateTankClone(gameController, aiId, inputs, durationFrames, opt);
                // v189（S1-毒雾）：只在出口叠一层「毒雾出界即死」（无毒雾时零开销、逐字节不变）
                return applyStormDeaths(gameController, aiId, [_single], durationFrames)[0];
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
                            // v189（S1-毒雾）：毒雾与"Rust/JS 谁算的"无关（纯几何、只读游戏状态）
                            //   ⟹ 在**出口**统一叠加，保证两条路的毒雾判死口径一致。
                            return applyStormDeaths(gameController, aiId, rustBatch, durationFrames);
                        }
                    } catch (eRust) {
                        console.warn('[VantageSandbox] Rust 物理预测失败，回退融合世界:', eRust);
                    }
                }
                return applyStormDeaths(gameController, aiId,
                    simulateFusedBatch(gameController, aiId, operations, durationFrames, opt), durationFrames);
            },

            /**
             * v33：九操作 Rust 评分路径（ABI v6 vt_score_paths）。
             * 一次调用同时完成 Rust 融合世界坦克模拟（samples/候选死亡帧）
             * 与 f64 遮蔽角评分。仅支持默认安全配置：lane=0 且弹簧绳关闭；
             * 任何失败/不支持都返回 null，由 tree.rolloutNine 静默回退
             * VantageScoring.scorePaths（JS 融合路径）。
             */
            // v38：融合世界摆放弹药的统计（树侧每帧记录 + 响度检查用）
            setFrameDtSec: setFrameDtSec,
            getFrameDtSec: getFrameDtSec,
            getFusedDropStats: function() {
                return {
                    approxPlaced: _fusedDropStats.approxPlaced,
                    noThreat: _fusedDropStats.noThreat,
                    skipped: _fusedDropStats.skipped,
                    // v12（1-2④）：D2 记账与"无导航表"记账（树侧响度检查用）。
                    droppedTargetOther: _fusedDropStats.droppedTargetOther || 0,
                    missileNoNav: _fusedDropStats.missileNoNav || 0,
                    lastDetail: _fusedDropStats.lastDetail
                };
            },
            /** v12：当前 AI 的 id（computeThreats 的 D2 判据要拿它比 targetId）。 */
            getAiId: function() { return String(aiId); },
            /** v12：最近一次 rescore 的「每 node 制导弹道」只读快照（B2 对拍用）。 */
            getLastRescoreMissileTracks: function() { return _lastRescoreMissileTracks; },
            getLastFusedBatchSummary: function() { return _lastFusedBatchSummary; },
            getFusedBatchAuditHistory: function() { return _fusedBatchAuditHistory.slice(); },
            simulateTankBatchScored: function(state, operations, durationFrames, opt) {
                if (!RUST_PHYSICS_ENABLED || !FUSED_ENABLED) return null;
                if (!rustFrameDtCompatible()) return null;   // v137：帧步长不一致不走 Rust 快路
                if (durationFrames > 75) return null;
                if (!global.VantageRustBridge || !global.VantageRustBridge._ready) return null;
                opt = opt || {};
                var cfg = opt.cfg || {};
                if (cfg.springRopeEnabled) return null;
                if (typeof cfg.lanePenaltyRatio === 'number' && cfg.lanePenaltyRatio > 0) return null;
                if (!opt.startPose) opt.startPose = state;

                var fc = getFusedWorld(gameController, aiId);
                if (!fc || !fc.wallShapes) return null;
                var FRAME = _frameDtSec;   // v163：样本时间戳必须用同一个校准帧长（旧版写死 0.02）

                var fused0 = simulateFusedBatch(gameController, aiId, operations, 0, opt);
                if (!fused0 || fused0.length !== operations.length) return null;

                var me = gameController.getTank(aiId);
                if (!me || !me.getB2DBody || !me.getB2DBody()) return null;

                var bullets = [];
                for (var bi = 0; bi < fc.bulletSlots.length; bi++) {
                    var slot = fc.bulletSlots[bi];
                    if (slot.lastRound !== fc.round || !slot.active) continue;
                    // v12（1-2④）：`vt_score_paths` 的 ABI **没有** maze_id/missile_ta 尾参
                    //   ⟹ 它无法制导。有制导弹在场时**响亮回退** JS 评分路径（JS 融合世界
                    //   有制导），绝不把制导弹当普通弹塞进去（那是假绿）。
                    if (slot.isMissile) return null;
                    if (!slot.body || !slot.body.IsActive()) continue;
                    var bpos = slot.body.GetPosition();
                    var bvel = slot.body.GetLinearVelocity();
                    bullets.push({
                        x: bpos.x,
                        y: bpos.y,
                        vx: bvel.x,
                        vy: bvel.y,
                        radius: slot.radius,
                        lifeLeft: slot.lifeLeft,
                        active: true,
                        // v166：霰弹标记（`bullet_is_shrapnel` 字节扩成弹种码：0=普通 1=破片 2=霰弹）
                        isShotgun: !!slot.isShotgun,

                        // v9：把弹种带进 Rust ABI（slot.isShrapnel 由 v162/v164 的摆位收尾设置）。
                        isShrapnel: !!slot.isShrapnel,
                isLaser: !!slot.needsSweep
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
                            return { t: frame * FRAME, x: s.x, y: s.y, rot: s.rot };
                        }),
                        dead: r.deathFrame >= 0,   // v172：fd=0 也是死（首帧命中）
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
                // v189（S1-毒雾）：这是"最终执行路线的死亡权威确认"那条路 ⟹ 必须叠毒雾判死
                return applyStormDeaths(gameController, aiId,
                    simulateFusedBatch(gameController, aiId, operations, durationFrames, opt), durationFrames);
            },

            /**
             * v31：Rust vt_rescore_nodes 增量层刷新（ABI v4）。
             * 对树节点已存储的 rolloutSamples 做纯函数重评分 + 融合传感器/
             * CCD 死亡验证，不重新模拟坦克物理。仅在 Rust 物理开关开启、
             * 融合世界存在且 Rust 桥就绪时启用；任何失败都返回 null，
             * 由树回退 VantageScoring.scorePaths（JS 融合路径）。
             * @param {Array} [pendingThreats] 本 tick 新增的 threat 列表；
             *   缺省时所有 threat 视为旧弹（isNew=false，全量刷新）。
             * @param {number} [nowTGlobal] v167（S3）：融合世界"现在"相对 rootAbsT
             *   的秒数（树侧 nowTGlobalOf(tree) 原样传）。Rust 侧把
             *   `lifeLeftSeconds` 当**轨迹锚点时刻**的剩余寿命：逐帧
             *   `life_left = L - (t_k - anchorOffset)`。JS 手上只有"现在"的剩余
             *   寿命 `L_now`，两者差 Δ = nowTGlobal - anchorOffset（= 该威胁
             *   被锚定后已经过的时间）⇒ 不补 Δ 就会让弹在重评分世界里提前 Δ 秒
             *   退场（`set_active(false)` 删 contact ⇒ 该弹最后 Δ 秒里的致命帧全部丢失
             *   ⇒ 假绿）。缺省 0 = 旧口径（不补），diff/离线调用不受影响。
             */
            rescoreTankSamples: function(nodes, threats, cfg, pendingThreats, nowTGlobal) {
                if (!RUST_PHYSICS_ENABLED || !FUSED_ENABLED) return null;
                if (!rustFrameDtCompatible()) return null;   // v137：帧步长不一致不走 Rust 快路
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
                // v12（1-2④）：制导弹的初始状态（每威胁一份），下面按 node 生成导引 track。
                var missileThreatInfo = [];
                var ti, tfi, pi;
                for (ti = 0; ti < threats.length; ti++) {
                    var th = threats[ti];
                    if (!th) return null;
                    // v171（1-2③）：激光必须显式传 kind=3（禁止用半径 0/0.05 推断）；
                    // 半径同时按真值传 0（Rust 校验允许），粒子圆只作危险粗筛。
                    // v12（1-2④）：追踪导弹显式传 kind=4；它的轨道不是固定折线，
                    //   由下面**按 node 预算**成该 node 专属的导引 track（路线 B2）。
                    var thIsMissile = false;
                    try {
                        thIsMissile = (th.type !== undefined && th.type !== null &&
                            typeof Constants !== 'undefined' && Constants.WEAPON_TYPES &&
                            th.type === Constants.WEAPON_TYPES.HOMING_MISSILE);
                    } catch (eMis0) { thIsMissile = false; }
                    var thKind = thIsMissile ? 4
                        : ((th.sweep || (typeof Constants !== 'undefined' && Constants.WEAPON_TYPES &&
                            th.type === Constants.WEAPON_TYPES.LASER)) ? 3 : 0);
                    var _anchorOff = (typeof th.anchorOffset === 'number' && isFinite(th.anchorOffset))
                        ? th.anchorOffset : 0;
                    var bth = {
                        speed: th.speed || 0,
                        anchorOffset: _anchorOff,
                        bulletRadius: (thKind === 3) ? 0 : 0.25,
                        lifeLeftSeconds: 10,
                        isNew: !!(pendingIds[String(th.id)] === true),
                        kind: thKind
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
                            // v165：必须用 lifetimeSecOf（破片 lifetime=0 是"无寿命上限"哨兵，
                            //   裸 lifetime 会让破片在重评分世界第一帧就停用 ⇒ 地雷致死漏判 ⇒ 假绿）。
                            // v167（S3）：**换算到轨迹锚点口径**——Rust 逐帧扣的是
                            //   `t_k - anchorOffset`（锚点时刻起算），JS 手上是"现在"的剩余寿命。
                            //   差 Δ = nowTGlobal - anchorOffset（该威胁被锚定后已过的时间），
                            //   不补 Δ 会让弹提前 Δ 秒退场、丢掉最后 Δ 秒里的致命帧（假绿）。
                            //   per-threat、与节点 start_t 无关（节点起点由 Rust 的 t_k 承担）。
                            var lifeNow = Math.max(0, lifetimeSecOf(prj) - prj.getTimeAlive());
                            var nowRel = (typeof nowTGlobal === 'number' && isFinite(nowTGlobal))
                                ? nowTGlobal : 0;
                            bth.lifeLeftSeconds = Math.max(0, lifeNow + (nowRel - _anchorOff));
                        }
                    }
                    // v12（1-2④）：记下制导弹的初始状态，供"每 node 一条轨道"（B2）。
                    missileThreatInfo.push(null);
                    if (thKind === 4) {
                        var _pp = (th.path && th.path.length && th.path[0])
                            ? { x: th.path[0].x, y: th.path[0].y }
                            : { x: (typeof th.x === 'number' ? th.x : 0),
                                y: (typeof th.y === 'number' ? th.y : 0) };
                        var _vx = 0, _vy = 0;
                        if (th.path && th.path.length >= 2) {
                            var _dx = th.path[1].x - _pp.x, _dy = th.path[1].y - _pp.y;
                            var _L = Math.sqrt(_dx * _dx + _dy * _dy);
                            if (_L > 1e-9 && th.speed > 0) {
                                _vx = _dx / _L * th.speed;
                                _vy = _dy / _L * th.speed;
                            }
                        }
                        if (_vx === 0 && _vy === 0 && prj && prj.getB2DBody) {
                            try {
                                var _lv = prj.getB2DBody().GetLinearVelocity();
                                _vx = _lv.x; _vy = _lv.y;
                            } catch (eLv) {}
                        }
                        var _nowRel = (typeof nowTGlobal === 'number' && isFinite(nowTGlobal)) ? nowTGlobal : 0;
                        var _taAnchor = 0;
                        if (prj && typeof prj.timeAlive === 'number' && isFinite(prj.timeAlive)) {
                            _taAnchor = prj.timeAlive - _nowRel + _anchorOff;
                        } else if (typeof th.missileTimeAlive === 'number' && isFinite(th.missileTimeAlive)) {
                            _taAnchor = th.missileTimeAlive;
                        }
                        var _init = (prj && typeof prj.initialSpeed === 'number' && prj.initialSpeed > 0)
                            ? prj.initialSpeed : MISSILE_LAUNCH_SPEED;
                        missileThreatInfo[missileThreatInfo.length - 1] = {
                            path0: _pp, vx: _vx, vy: _vy, anchorOff: _anchorOff,
                            taAnchor: _taAnchor, initSpeed: _init
                        };
                    }
                    bridgeThreats.push(bth);
                }

                // v12（1-2④）路线 B2：有制导弹威胁 ⟹ 每个 node 一条**导引后**的
                // 制导弹道（track），由 bridge 按 node 逐次调用 `vt_rescore_nodes`。
                // 生产者复用融合世界同一套 `missileSteerVelocity`（一份实现两处用）。
                var anyMissileThreat = false;
                for (ti = 0; ti < bridgeThreats.length; ti++) {
                    if (bridgeThreats[ti] && bridgeThreats[ti].kind === 4) { anyMissileThreat = true; break; }
                }
                var missileNavT = null;
                if (anyMissileThreat) {
                    missileNavT = getMazeNavTables(gameController.getMaze());
                    if (!missileNavT) {
                        console.warn('[VantageSandbox] 制导弹威胁存在但导航表建不出来，回退 JS 融合路径');
                        return null;
                    }
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
                    if (anyMissileThreat) {
                        var mtrack = new Array(bridgeThreats.length);
                        for (ti = 0; ti < bridgeThreats.length; ti++) {
                            mtrack[ti] = (bridgeThreats[ti] && bridgeThreats[ti].kind === 4)
                                ? buildMissileThreatTrack(missileNavT, missileThreatInfo[ti], nodes[bni], nowTGlobal)
                                : null;
                        }
                        bn.missileTracks = mtrack;
                    }
                    bridgeNodes.push(bn);
                }
                // v12：只读快照（B2 证据：每个 node 的制导弹道是各自的）。
                try {
                    _lastRescoreMissileTracks = bridgeNodes.map(function (bn) {
                        return bn.missileTracks || null;
                    });
                } catch (eSnap) { _lastRescoreMissileTracks = null; }

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
                        dead: rn.deathFrame >= 0,   // v172：fd=0 也是死（首帧命中）
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
             * @param {number} durationFrames - 预测帧数（每帧 _frameDtSec 秒，默认0.02，实战经校准）
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
            checkDeath: function(tankState, bulletPositions, shapeOverride) {
                // v178（1-4-a）：判死轮廓 = **本 AI 当前武器**的炮塔（取不到则原状炮弹炮塔）
                var shape = shapeOverride || resolveTankShape(gameController, aiId, consts);
                return checkDeath(tankState, bulletPositions, consts, shape);
            },

            /**
             * v171（1-2③）：线段扫掠判死（与真游戏 CCD 同义的几何口径）。
             * 用死亡世界同款夹具多边形（车体 3.0×4.0 + **当前武器的炮塔**，局部坐标），
             * 按 tankState 旋转/平移；segments = [{ax,ay,bx,by}, ...]。
             * 只读，不碰任何 body。
             * v178（1-4-a）：炮塔那块从"写死 0.7×1.4"改成"当前武器各自的炮塔"
             *   （激光 = 碟+天线两块；拿地雷/导弹已发射 = 没有炮塔块）。
             */
            checkDeathSweep: function(tankState, segments, shapeOverride) {
                if (!tankState || !segments || !segments.length) return false;
                var c = Math.cos(tankState.rot), sn = Math.sin(tankState.rot);
                var shape = shapeOverride || resolveTankShape(gameController, aiId, consts);
                var local = [
                    [{ x: -consts.TANK_HALF_WIDTH, y: -consts.TANK_HALF_HEIGHT },
                     { x: consts.TANK_HALF_WIDTH, y: -consts.TANK_HALF_HEIGHT },
                     { x: consts.TANK_HALF_WIDTH, y: consts.TANK_HALF_HEIGHT },
                     { x: -consts.TANK_HALF_WIDTH, y: consts.TANK_HALF_HEIGHT }]
                ];
                for (var qi = 0; qi < shape.polys.length; qi++) local.push(shape.polys[qi]);
                var polys = [];
                for (var pi = 0; pi < local.length; pi++) {
                    var wp = [];
                    for (var vi = 0; vi < local[pi].length; vi++) {
                        var lv = local[pi][vi];
                        wp.push({ x: tankState.x + c * lv.x - sn * lv.y,
                                  y: tankState.y + sn * lv.x + c * lv.y });
                    }
                    polys.push(wp);
                }
                for (var si = 0; si < segments.length; si++) {
                    var sg = segments[si];
                    if (!sg) continue;
                    for (var pj = 0; pj < polys.length; pj++) {
                        if (fusedSegmentPolyHit(sg.ax, sg.ay, sg.bx, sg.by, polys[pj])) return true;
                    }
                }
                return false;
            },

            /**
             * 线段撞墙检测（复用 B2DUtils.checkLineForMazeCollision）
             */
            checkWall: function(p1, p2) {
                var world = gameController.getB2DWorld();
                return B2DUtils.checkLineForMazeCollision(world, p1, p2);
            },

            // —— v178（1-4-a）：炮塔形状签名（**只读诊断**，不参与决策）——
            /**
             * 本 AI 坦克**当前武器**的判死轮廓（局部坐标，米）+ 签名。
             * 探针/对拍用它证明"同一局面换武器 ⟹ 判死轮廓真的不同"。
             * @returns {Object} {sig, name, launched, legacy, tip, polys:[[{x,y}…]…]}
             */
            getTankShape: function() {
                var shape = resolveTankShape(gameController, aiId, consts);
                var polys = [];
                for (var i = 0; i < shape.polys.length; i++) {
                    var p = [];
                    for (var j = 0; j < shape.polys[i].length; j++) {
                        p.push({ x: shape.polys[i][j].x, y: shape.polys[i][j].y });
                    }
                    polys.push(p);
                }
                return {
                    sig: shapeSignature(shape),
                    name: shape.name,
                    launched: !!shape.launched,
                    legacy: !!shape.legacy,
                    tip: turretTipOf(shape, consts.TANK_HALF_HEIGHT),
                    polys: polys
                };
            },

            /**
             * 融合世界候选体（opIndex）的**局部坐标**夹具多边形快照（含 sensor 块）。
             * 判死轮廓的权威就在这里：sensor 块 = 死亡接触形状。只读诊断。
             * @returns {Array|null} [{type, verts:[{x,y}…]}…]
             */
            getFusedCandidateLocalPolys: function(opIndex) {
                var fc = getFusedWorld(gameController, aiId);
                if (!fc || !fc.candidates[opIndex]) return null;
                var body = fc.candidates[opIndex];
                var pos = body.GetPosition(), ang = body.GetAngle();
                var ca = Math.cos(-ang), sa = Math.sin(-ang);
                var out = [];
                for (var f = body.GetFixtureList(); f; f = f.GetNext()) {
                    var sh = f.GetShape();
                    if (!sh || !sh.m_vertexCount) continue;
                    var verts = [];
                    for (var v = 0; v < sh.m_vertexCount; v++) {
                        var wv = sh.m_vertices[v];
                        var dx = wv.x - pos.x, dy = wv.y - pos.y;
                        verts.push({ x: dx * ca - dy * sa, y: dx * sa + dy * ca });
                    }
                    var ud = null;
                    try { ud = f.GetUserData(); } catch (eUd) { ud = null; }
                    out.push({ type: (ud && ud.type) ? ud.type : null, verts: verts });
                }
                return out;
            },

            // —— v190（G5 · §12.8/§12.31）：护盾（**只读诊断**）——
            /** 本 AI 坦克**当前有没有真护盾**（读真游戏 upgrades；SPAWN_SHIELD 不算）。 */
            getTankShield: function() {
                var sh = currentTankShield(gameController, aiId);
                return sh ? { on: true, upgradeId: sh.upgradeId, type: sh.type, lifetime: sh.lifetime,
                              radius: sh.radius, sig: shapeSignature(currentWeaponShape(gameController, aiId) ||
                                legacyTurretShape(consts), true) }
                          : { on: false, radius: shieldRadiusM(),
                              sig: shapeSignature(currentWeaponShape(gameController, aiId) ||
                                legacyTurretShape(consts), false) };
            },
            /** 融合世界候选体(opIndex)的护盾夹具快照（**证明"夹具真的建了/拆了"**）。 */
            getFusedCandidateShield: function(opIndex) {
                var fc = getFusedWorld(gameController, aiId);
                if (!fc || !fc.candidates[opIndex]) return null;
                var cb = fc.candidates[opIndex], out = null;
                try {
                    var f = cb.GetFixtureList();
                    while (f) {
                        var u = f.GetUserData();
                        if (u && u.type === 'fusedShield') {
                            var sh = f.GetShape(), fd = f.GetFilterData(), cp = cb.GetPosition();
                            out = { has: true, r: sh.m_radius, x: cp.x, y: cp.y,
                                    categoryBits: fd.categoryBits, maskBits: fd.maskBits,
                                    maskHasMaze: !!(fd.maskBits & Constants.COLLISION_CATEGORIES.MAZE) };
                        }
                        f = f.GetNext();
                    }
                } catch (eS) { out = { err: String((eS && eS.message) || eS) }; }
                return out || { has: false };
            },
            /** 护盾累计账（只读）：建/拆夹具次数、反弹接触、破片停、自己的弹穿盾。 */
            getFusedShieldStats: function() {
                var fc = getFusedWorld(gameController, aiId);
                var slots = [];
                if (fc && fc.bulletSlots) {
                    for (var i = 0; i < fc.bulletSlots.length; i++) {
                        var sl = fc.bulletSlots[i];
                        if (!sl || sl.lastRound !== fc.round) continue;
                        slots.push({ pid: sl.pid, rule: sl.shieldRule || null,
                                     allows: (sl.shieldAllows === undefined ? null : sl.shieldAllows),
                                     hitFrames: sl.shieldHitFrames || 0, stopped: !!sl.shieldStopped });
                    }
                }
                var st = _vtCopyRecord(_shieldStats);
                st.roundSlots = slots;
                st.hasShieldFixture = (fc && fc.shieldSig) ? true : false;
                st.shieldSig = (fc && fc.shieldSig) ? true : false;
                return st;
            },

            // —— v188（S1 · §12.3）：子弹「非正常消失」移除链（**只读诊断 + 纯函数**）——
            /** ① 识别：立即扫一遍真实弹列表（探针/树都可以主动调；融合批次里已经自动调过）。 */
            scanProjectileRemovals: function() {
                return scanProjectileRemovals(gameController);
            },
            /** 移除链的累计账（只读）：vanishedTotal 是 **naive 口径**（只看 id 从列表消失）。 */
            getRemovalStats: function() {
                var led = _vtEnsureProjectileLedger(gameController);
                return led ? _vtCopyRecord(led.stats) : null;
            },
            /** 已经判为"非正常消失"的弹（最近 64 条）。 */
            getRemovedProjectiles: function() {
                var led = _vtEnsureProjectileLedger(gameController);
                if (!led) return [];
                var out = [];
                for (var i = 0; i < led.order.length; i++) {
                    var id = led.order[i];
                    var r = _vtCopyRecord(led.removed[id] || {});
                    r.id = id;
                    out.push(r);
                }
                return out;
            },
            /** 上一次融合批次的序号（把死因表与批次对上：两次之间又跑过别的批次时用得上）。 */
            getLastDeathCauseSeq: function() { return _lastDeathCauseSeq; },
            /** 上一次融合批次的逐 op 死因（只读快照）。 */
            getLastDeathCauses: function() {
                if (!_lastDeathCauses) return null;
                return _lastDeathCauses.map(function(c) {
                    return { op: c.op, causes: (c.causes || []).map(function(x) {
                        return { frame: x.frame, bulletId: x.bulletId, src: x.src }; }) };
                });
            },
            /**
             * ② 摘除（可手动调；批次里已自动调用）：把 removedIds 对应的槽退休。
             * @returns {number} 真退休了几个槽
             */
            retireFusedBulletSlots: function(removedIds) {
                var fc = getFusedWorld(gameController, aiId);
                return retireFusedBulletSlots(fc, removedIds);
            },
            /** 融合世界弹槽快照（**证明"槽真的空了"**用）。 */
            getFusedBulletSlots: function() {
                var fc = getFusedWorld(gameController, aiId);
                if (!fc) return null;
                var out = [];
                for (var i = 0; i < fc.bulletSlots.length; i++) {
                    var sl = fc.bulletSlots[i];
                    if (!sl) continue;
                    var bodyActive = false;
                    try { bodyActive = !!(sl.body && sl.body.IsActive()); } catch (eB) { }
                    out.push({
                        idx: i, pid: sl.pid === undefined ? null : sl.pid,
                        lastRound: sl.lastRound, round: fc.round,
                        inThisRound: sl.lastRound === fc.round,
                        active: !!sl.active, bodyActive: bodyActive,
                        retired: !!sl.retired, retiredAt: (sl.retiredAt === undefined ? null : sl.retiredAt),
                        removedReason: sl.removedReason || null,
                        hasProjObj: !!sl.projObj, radius: sl.radius,
                        isMissile: !!sl.isMissile
                    });
                }
                return { round: fc.round, slots: out };
            },
            /**
             * ③ 单调放活（**纯函数**：不重跑死亡检测）。
             * @param {Array} deaths 与"上一次融合批次"同序的 [{dead, deathFrame}, …]
             * @param {Array} removedIds 被移除的弹 id（缺省 = 用沙箱自己刚识别的 abnormal 列表）
             */
            releaseDeathsAfterRemoval: function(deaths, removedIds, causesTable) {
                var ids = removedIds;
                if (!ids) {
                    var led = _vtEnsureProjectileLedger(gameController);
                    ids = led ? led.order.slice() : [];
                }
                return releaseDeathsAfterRemoval(deaths, ids, causesTable);
            },

            // —— 死亡事件采集（v177 · 阶段 2-2）——
            // ⚠️ 纯读：不碰 VantageTree / 评分 / 沙箱世界。
            // 🔴 尤其**绝不调 `VantageTree.noteDeath(kill)`** —— 那会 `_frozen = true` **把树定死**。
            // 记录里 x/y/rot 是**值拷贝**（不是 tank 引用）⟹ endRound 清 tanks 也不会读到旧局数据。
            getDeaths: function() { return deathCollector ? _vtCopyList(deathCollector.deaths) : []; },
            getDeathsCount: function() { return deathCollector ? deathCollector.deaths.length : 0; },
            getLastRoundDeaths: function() { return deathCollector ? _vtCopyList(deathCollector.lastRound) : []; },
            clearDeaths: function() {
                if (!deathCollector) return 0;
                deathCollector.deaths = [];
                deathCollector.byPid = {};
                deathCollector.seq = 0;
                return 0;
            },
            /** 自证用：装了没、挂了几份（**期望 subCount === 1**）、有没有我们吞掉的异常、wrap 了没 */
            getDeathHookStatus: function() {
                if (!deathCollector) return { installed: false, reason: 'no-collector' };
                return {
                    installed: deathCollector.installed,
                    installedOn: 'GameController.addRoundEventListener',
                    subCount: _vtSubCount(deathCollector.gc, deathCollector.handler),
                    deaths: deathCollector.deaths.length,
                    lastRound: deathCollector.lastRound.length,
                    overflow: deathCollector.deathsOverflow,
                    errors: deathCollector.errors.length,
                    errorList: deathCollector.errors.slice(0, 4),
                    throws: _deathTestThrowCount,
                    wrapped: false   // ★ 本采集器一个游戏方法都没包（只有订阅）
                };
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
    // v174（1-2④）：追踪导弹「下一格表」预计算（ABI v12 用）
    //
    // 为什么需要它：`HomingMissile.update` 的瞄准点走
    //   `maze.getShortestPathWithGraph(start, end)[0]`，而那是 **jKstra 的
    //   【双向】Dijkstra**（`2e2acf87850d72356447904f0853591b.js:1`：
    //   out/in 两个迭代器轮流推进、`_hasBeenReachBothWays` 相遇即停；还带 4 个
    //   √2 对角边）⟹ **平局时走哪条最短路是该库实现的细节**，在 Rust 里复刻它
    //   既贵又脆。【结论】改由 JS 用**游戏自己的 API** 整表预计算：
    //   忠实性由【构造】保证、平局不可能分叉。
    //
    // 表布局：`Uint8Array(w*h*w*h)`，下标 = `fromIdx*(w*h) + toIdx`，
    //   值 = 「下一格」的下标（`y*w+x`）；`255` = 该格对【不需要或不可算】：
    //     · from/to 任一不是 reachable 格（`getDistancesFromPosition === false`）；
    //     · 4 连通距离 ≤ 1 ⟹ 真游戏走的是「直接瞄准坦克真实坐标」分支，**不查最短路**；
    //     · 最短路为空（理论上不该发生，留哨兵）。
    // ⚠️ 距离口径用的是 `getDistancesFromPosition/getDistanceToPosition`
    //   = **4 连通 BFS**（`_traverseCloseTiles`），与真游戏选目标的口径一致。
    // ============================================================
    /**
     * v12（1-2④）：为**单个 node** 预算一条制导弹道（B2 的 JS 生产者）。
     *
     * 起点 = 该威胁的锚点状态（`th.path[0]` + 锚点速度，`computeThreats` 造的
     * 直线威胁就是"当前位置 + 当前速度方向"）；时间轴 = 相对 rootAbsT，
     * 锚点在 `anchorOff` 秒处。每个 dt 步：
     *   · 先按当前速度位移（等价 Box2D Step）→ 再 `timeAlive += dt`；
     *   · `timeAlive > 2.0` 时用 `missileSteerVelocity`（与融合世界**同一函数**）
     *     朝该 node 的坦克位姿制导。
     *
     * ⚠️ 已知近似（写进报告）：若 `node.startT > anchorOff`（更深的未来节点），
     * 锚点到节点起点那一段没有该 node 以外的坦克轨迹 ⟹ 目标暂时冻结在
     * `samples[0]`（节点起点位姿）。根节点（startT≈anchorOff）无此近似。
     */
    function buildMissileThreatTrack(navT, info, node, nowTGlobal) {
        var dt = _frameDtSec;
        if (!info) return null;
        var anchorOff = isFinite(info.anchorOff) ? info.anchorOff : 0;
        var p0 = info.path0 || { x: 0, y: 0 };
        var vx = info.vx || 0, vy = info.vy || 0;
        var ta = isFinite(info.taAnchor) ? info.taAnchor : 0;
        var initSpeed = (info.initSpeed > 0) ? info.initSpeed : MISSILE_LAUNCH_SPEED;
        var nodeStart = (node && typeof node.startT === 'number' && isFinite(node.startT)) ? node.startT : 0;
        var frames = (node && typeof node.frames === 'number' && node.frames >= 1) ? node.frames : 0;
        var samples = (node && Array.isArray(node.samples)) ? node.samples : [];
        var endT = nodeStart + frames * dt;
        var steps = Math.round((endT - anchorOff) / dt);
        if (!(steps > 0)) steps = 0;
        var x = p0.x, y = p0.y;
        var track = [{ x: x, y: y, alive: true }];
        for (var i = 1; i <= steps; i++) {
            x += vx * dt;
            y += vy * dt;
            ta += dt;
            if (ta > MISSILE_ACTIVATION_SEC && samples.length) {
                var tAbs = anchorOff + i * dt;
                var idx = Math.round((tAbs - nodeStart) / dt);
                if (idx < 0) idx = 0;
                if (idx >= samples.length) idx = samples.length - 1;
                var tgt = samples[idx];
                if (tgt && isFinite(tgt.x) && isFinite(tgt.y)) {
                    var st = missileSteerVelocity(navT, x, y, vx, vy, initSpeed, tgt.x, tgt.y, dt);
                    vx = st.vx; vy = st.vy;
                }
            }
            track.push({ x: x, y: y, alive: true });
        }
        return track;
    }

    function buildNextTileTable(maze) {
        var out = { ok: false, w: 0, h: 0, table: null, pairs: 0, computed: 0, skipped: 0, ms: 0 };
        try {
            if (!maze || typeof maze.getWidth !== 'function' ||
                typeof maze.getShortestPathWithGraph !== 'function' ||
                typeof maze.getDistancesFromPosition !== 'function' ||
                typeof maze.getDistanceToPosition !== 'function' ||
                typeof maze.getTiles !== 'function') {
                return out;
            }
            var w = maze.getWidth(), h = maze.getHeight();
            var t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
            var n = w * h;
            var table = new Uint8Array(n * n);
            table.fill(255);
            var reach = new Uint8Array(n);
            // v12（1-2④）：同一趟里补 `flags`（`vt_set_maze` 的入参，与 Rust
            // `vtmaze.rs` 同约定）：
            //   bit0 = reachable（getDistancesFromPosition !== false）
            //   bit1 = left wall（tiles[x][y][2]）  bit2 = top wall（tiles[x][y][1]）
            //   bit3 = floor（tiles[x][y][0]）
            var flags = new Uint8Array(n);
            var tiles = maze.getTiles();
            var fx, fy, x, y;
            for (x = 0; x < w; x++) {
                for (y = 0; y < h; y++) {
                    var fi0 = y * w + x;
                    var fbits = 0;
                    if (maze.getDistancesFromPosition({ x: x, y: y }) !== false) { reach[fi0] = 1; fbits |= 1; }
                    var tl = (tiles && tiles[x]) ? tiles[x][y] : null;
                    if (tl) {
                        if (tl[2] == 1) fbits |= 2;
                        if (tl[1] == 1) fbits |= 4;
                        if (tl[0] == 1) fbits |= 8;
                    }
                    flags[fi0] = fbits;
                }
            }
            for (fy = 0; fy < h; fy++) {
                for (fx = 0; fx < w; fx++) {
                    var fi = fy * w + fx;
                    if (!reach[fi]) continue;
                    var dists = maze.getDistancesFromPosition({ x: fx, y: fy });
                    if (dists === false) continue;
                    for (var ty = 0; ty < h; ty++) {
                        for (var tx = 0; tx < w; tx++) {
                            var ti = ty * w + tx;
                            if (!reach[ti]) continue;
                            var d = maze.getDistanceToPosition(dists, { x: tx, y: ty });
                            if (d === false || d <= 1) continue;   // tank-exact 分支，不查最短路
                            out.pairs++;
                            var path = maze.getShortestPathWithGraph({ x: fx, y: fy }, { x: tx, y: ty });
                            if (!path || !path.length) { out.skipped++; continue; }
                            table[fi * n + ti] = (path[0].y * w + path[0].x) & 0xff;
                            out.computed++;
                        }
                    }
                }
            }
            out.ok = true; out.w = w; out.h = h; out.table = table;
            out.flags = flags;   // v12：vt_set_maze 需要（额外字段，不改既有消费方）
            out.reach = reach;   // v12：制导的 reachable 判定用
            var t1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
            out.ms = Math.round((t1 - t0) * 100) / 100;
        } catch (e) {
            out.err = String((e && e.message) || e);
        }
        return out;
    }

    // ============================================================
    // v12（1-2④）：追踪导弹逐帧制导 —— JS 侧与 Rust 侧（`rollout.rs`
    //   `missile_guide_step`）**同一套公式**，两侧必须同改。
    // ============================================================
    var MISSILE_ACCEL = 40.0;         // Constants.HOMING_MISSILE.ACCELERATION
    var MISSILE_ACTIVATION_SEC = 2.0; // Constants.HOMING_MISSILE_ACTIVATION_TIME
    var MISSILE_LAUNCH_SPEED = 18.0;  // Constants.HOMING_MISSILE.SPEED.m
    var MAZE_TILE_M = 10.0;           // Constants.MAZE_TILE_SIZE.m
    (function readMissileConstants() {
        try {
            if (typeof Constants === 'undefined') return;
            if (Constants.HOMING_MISSILE && typeof Constants.HOMING_MISSILE.ACCELERATION === 'number') {
                MISSILE_ACCEL = Constants.HOMING_MISSILE.ACCELERATION;
            }
            if (typeof Constants.HOMING_MISSILE_ACTIVATION_TIME === 'number') {
                MISSILE_ACTIVATION_SEC = Constants.HOMING_MISSILE_ACTIVATION_TIME;
            }
            if (Constants.HOMING_MISSILE && Constants.HOMING_MISSILE.SPEED && typeof Constants.HOMING_MISSILE.SPEED.m === 'number') {
                MISSILE_LAUNCH_SPEED = Constants.HOMING_MISSILE.SPEED.m;
            }
            if (Constants.MAZE_TILE_SIZE && typeof Constants.MAZE_TILE_SIZE.m === 'number') {
                MAZE_TILE_M = Constants.MAZE_TILE_SIZE.m;
            }
        } catch (eConst) {}
    })();

    function homingMissileTypeId() {
        try {
            if (typeof Constants !== 'undefined' && Constants.WEAPON_TYPES &&
                    typeof Constants.WEAPON_TYPES.HOMING_MISSILE === 'number') {
                return Constants.WEAPON_TYPES.HOMING_MISSILE;
            }
        } catch (eT2) {}
        return 3;
    }
    /** v12：真弹对象是不是追踪导弹（只认弹种，不看半径）。 */
    function isHomingMissileProjectile(pr) {
        try {
            return !!pr && typeof pr.getType === 'function' && pr.getType() === homingMissileTypeId();
        } catch (eT) { return false; }
    }

    // 按 maze 对象缓存（`buildNextTileTable` 是整局一次的重活；maze 变 → 重建）。
    var _mazeNavCacheRef = null;
    var _mazeNavCacheTables = null;
    var _mazeIdSeq = 1;
    var _mazeIds = (typeof WeakMap === 'function') ? new WeakMap() : null;

    // ─────────────────────────────────────────────────────────────────────
    // v176（1-2④ 收尾）E：**建表预算阀**
    //
    // 依据（《导航表建表开销-2026-10-14》真迷宫 · Node 侧墙钟实测）：
    //   6×4 (24 格 / 576 格位)  冷首发 **5.0 ms**   ← 当前游戏实际尺寸
    //   6×5 (30 格 / 900)       9.4 ms
    //   10×6 (60 格 / 3.6k)     53.6 ms
    //   16×10 (160 格 / 25.6k)  **292 ms**
    //   20×12 (240 格 / 57.6k)  **2812 ms**  ⟹【推断】24×14 ≈ 8~15 s、30×20 ≈ 40~70 s
    // 表大小 = `(w*h)²` 字节 ⟹ 用**格位数**当预算代理量。
    // ⚠️ 为什么**不用时钟**测：页内 `performance.now()`/`Date.now()` 在虚拟钟下**冻结**
    //   （20 000 000 次循环 delta=0，见同报告 §二）⟹ 只有"格位数"这个量在页内可测、可复现。
    // 阈值怎么定的（**本轮实测**，Node 侧冷首发；表格位数 = (w*h)²）：
    //   11×7 (77格/5 929格位) **67.3 ms** ← 当前游戏实际尺寸；8×6 40.6ms；10×6 53.6ms；12×8(9 216) 129.4ms
    //   14×9 (126格/15 876格位) **531.9 ms** ⟹ 必须挡住；16×10(25 600) 292ms；20×12(57 600) **2 812 ms**
    // ⟹ 取 12 000 格位：把**实际会出现的尺寸全放行**（≤129 ms），把 ≥530 ms 的那档**全部挡住**。
    // ⚠️ 格位数只是**代理量**（真正的驱动量是"需算格对 × 格子数"，两者不完全同序：
    //   16×10 格位更多却更快(292) 而 14×9 更慢(532)）⟹ 将来要精确，应改成"先数格对、再按
    //   `格对×格子/4000` 预估 ms"两段式；本轮按最小改动只做代理量（已记入报告"未解决"）。
    var NAV_TABLE_CELL_BUDGET = 12000;
    var _navStatus = { state: 'idle', w: 0, h: 0, tiles: 0, cells: 0, limit: NAV_TABLE_CELL_BUDGET,
                       builtAtVtMs: null, reason: '' };
    var _mazeNavDisabledRef = null;
    /** 诊断出口（**E 的"响亮"就靠它**：外部可检测的状态位，不必翻 console）。 */
    function getNavTableStatus() {
        return { state: _navStatus.state, w: _navStatus.w, h: _navStatus.h,
                 tiles: _navStatus.tiles, cells: _navStatus.cells, limit: _navStatus.limit,
                 builtAtVtMs: _navStatus.builtAtVtMs, reason: _navStatus.reason,
                 budgetCells: NAV_TABLE_CELL_BUDGET };
    }

    function getMazeNavTables(maze) {
        if (!maze) return null;
        if (_mazeNavCacheRef === maze && _mazeNavCacheTables && _mazeNavCacheTables.ok === true) {
            return _mazeNavCacheTables;
        }
        // E：本局已判定"超预算 ⟹ 停用制导" ⟹ **不重试、不建表**（否则每帧都想建 = 更糟）。
        if (_mazeNavDisabledRef === maze) return null;
        var mw = 0, mh = 0, tiles = 0, cells = 0;
        try {
            mw = maze.getWidth(); mh = maze.getHeight(); tiles = mw * mh;
            cells = tiles * tiles;          // ★ 预算量 = **表格位**（(w*h)²），不是格子数
        } catch (eWH) { tiles = 0; cells = 0; }   // ⚠️ 第一版写成 cells=mw*mh（格子数）→ 阀永远不会触发（探针实测抓到）
        if (cells > NAV_TABLE_CELL_BUDGET) {
            _mazeNavDisabledRef = maze;
            _navStatus.state = 'disabled-budget';
            _navStatus.w = mw; _navStatus.h = mh; _navStatus.cells = cells; _navStatus.tiles = tiles;
            _navStatus.builtAtVtMs = Date.now();
            _navStatus.reason = 'maze ' + mw + 'x' + mh + ' = ' + tiles + ' tiles ⇒ table ' + cells +
                ' cells > budget ' + NAV_TABLE_CELL_BUDGET + ' cells (' + (cells) + ' bytes)';
            // ★ "响亮"：error 级 + 固定前缀（便于 grep）+ 上面那个可读状态位。
            console.error('[VantageSandbox][导航表][预算超限·本局停用制导] ' + _navStatus.reason +
                ' —— 追踪导弹不会进入本批模拟（不直飞）；详见 VantageSandbox.getNavTableStatus()');
            return null;
        }
        var t = buildNextTileTable(maze);
        if (!t || t.ok !== true) {
            _navStatus.state = 'build-failed';
            _navStatus.reason = String((t && t.err) || 'buildNextTileTable 返回非 ok');
            return null;
        }
        _mazeNavCacheRef = maze;
        _mazeNavCacheTables = t;
        _navStatus.state = 'ready';
        _navStatus.w = t.w; _navStatus.h = t.h; _navStatus.tiles = t.w * t.h;
        _navStatus.cells = t.w * t.h * t.w * t.h;
        _navStatus.builtAtVtMs = Date.now();   // 虚拟钟（跨帧有效）
        _navStatus.reason = '';
        return t;
    }

    /**
     * v176（1-2④ 收尾）A：**换图/开局就把表建好**（不再等"第一次见到制导弹"）。
     * 为什么要挪：表只建一次，原来那一次正好落在**"AI 正被打、要立刻决策"**的那一刻
     *   （实测 16×10 冷首发 292 ms、20×12 2812 ms）；挪到本局**第一批批处理**时，
     *   坦克还没动、树也刚起步 ⟹ 同样的时间落在**非关键帧**。
     * 代价：开局第一 tick 会多出"建表"这一份开销（当前游戏尺寸 = 3~10 ms，见上）。
     * 幂等：按 maze 对象缓存；同一 maze 再调 = 直接返回缓存（不重复建）。
     */
    function prebuildMazeNav(gameController) {
        try {
            if (!gameController || typeof gameController.getMaze !== 'function') return null;
            var mz = gameController.getMaze();
            if (!mz) return null;
            return getMazeNavTables(mz);
        } catch (ePb) { return null; }
    }
    /** `vt_set_maze` 用的稳定 id：同一个 maze 对象永远同一个 id；0 号保留给"未装表"。 */
    function mazeIdOf(maze) {
        if (!_mazeIds) return 1;
        var id = _mazeIds.get(maze);
        if (!id) { id = _mazeIdSeq++; _mazeIds.set(maze, id); }
        return id >>> 0;
    }
    function navReachable(t, x, y) {
        return t && x >= 0 && y >= 0 && x < t.w && y < t.h && (t.flags[y * t.w + x] & 1) !== 0;
    }
    function navLeftOpen(t, x, y) {
        return t && x >= 0 && y >= 0 && x < t.w && y < t.h && (t.flags[y * t.w + x] & 2) === 0;
    }
    function navTopOpen(t, x, y) {
        return t && x >= 0 && y >= 0 && x < t.w && y < t.h && (t.flags[y * t.w + x] & 4) === 0;
    }
    /**
     * 4 连通距离档位（与真游戏 `getDistancesFromPosition/getDistanceToPosition` 同口径）：
     * 返回 -1 = 不可达/不可算（照真游戏跳过整步）；0 = 同格；1 = 相邻且墙开着；
     * 2 = 距离 ≥2（调用方查「下一格」表）。
     * `_traverseCloseTiles` 只看墙、不看 tiles[x][y][0]（格是否存在），这里照抄。
     */
    function missileTileDistBand(t, x, y, tx, ty) {
        if (!t) return -1;
        var fx = Math.floor(x / MAZE_TILE_M), fy = Math.floor(y / MAZE_TILE_M);
        var gx = Math.floor(tx / MAZE_TILE_M), gy = Math.floor(ty / MAZE_TILE_M);
        if (!navReachable(t, fx, fy) || !navReachable(t, gx, gy)) return -1;
        if (fx === gx && fy === gy) return 0;
        var dx = gx - fx, dy = gy - fy;
        if (dx === -1 && dy === 0) return navLeftOpen(t, fx, fy) ? 1 : -1;
        if (dx === 1 && dy === 0) return navLeftOpen(t, gx, gy) ? 1 : -1;
        if (dx === 0 && dy === -1) return navTopOpen(t, fx, fy) ? 1 : -1;
        if (dx === 0 && dy === 1) return navTopOpen(t, gx, gy) ? 1 : -1;
        return 2;
    }
    /** 「下一格」表查表（返回格中心世界坐标；表未覆盖 → null = 照真游戏不猜）。 */
    function missileNextTileCenter(t, x, y, tx, ty) {
        if (!t) return null;
        var fx = Math.floor(x / MAZE_TILE_M), fy = Math.floor(y / MAZE_TILE_M);
        var gx = Math.floor(tx / MAZE_TILE_M), gy = Math.floor(ty / MAZE_TILE_M);
        if (fx < 0 || fy < 0 || gx < 0 || gy < 0 || fx >= t.w || fy >= t.h || gx >= t.w || gy >= t.h) return null;
        var n = t.w * t.h;
        var v = t.table[(fy * t.w + fx) * n + (gy * t.w + gx)];
        if (v === 255 || v >= n) return null;
        return { x: (v % t.w + 0.5) * MAZE_TILE_M, y: (Math.floor(v / t.w) + 0.5) * MAZE_TILE_M };
    }
    /**
     * 制导一步（`HomingMissile.update` 逐字对齐）：
     *   · 距离不可达 ⇒ 跳过加速（但**归一化仍执行**）；
     *   · 距离 ≤1 ⇒ 瞄准坦克真坐标；否则瞄准「下一格」中心；
     *   · 每轴 `rel<0 ? v-A·dt : v+A·dt`（rel==0 走 + 分支）；
     *   · `|v|² − initialSpeed² > 0.01` ⇒ 乘回 initialSpeed（**没有 Math.abs**）。
     * 返回 {vx, vy, guided}；调用方**必须**把结果写回 body（即使 guided=false，
     * 因为归一化可能改了速度）。
     */
    function missileSteerVelocity(tables, x, y, vx, vy, initialSpeed, targetX, targetY, dt) {
        var guided = false;
        var band = missileTileDistBand(tables, x, y, targetX, targetY);
        if (band >= 0) {
            var aim = null;
            if (band <= 1) aim = { x: targetX, y: targetY };
            else aim = missileNextTileCenter(tables, x, y, targetX, targetY);
            if (aim) {
                var relX = aim.x - x, relY = aim.y - y;
                if (relX < 0) vx -= MISSILE_ACCEL * dt; else vx += MISSILE_ACCEL * dt;
                if (relY < 0) vy -= MISSILE_ACCEL * dt; else vy += MISSILE_ACCEL * dt;
                guided = true;
            }
        }
        var len2 = vx * vx + vy * vy;
        var init2 = initialSpeed * initialSpeed;
        if (len2 - init2 > 0.01) {
            var len = Math.sqrt(len2);
            if (len > 0) { vx *= initialSpeed / len; vy *= initialSpeed / len; }
        }
        return { vx: vx, vy: vy, guided: guided };
    }

    // ============================================================
    // 导出
    // ============================================================
    global.VantageSandbox = {
        createAdapter: createVantageAdapter,
        // v177（阶段 2-2）：死亡采集器（**订阅式**）—— 探针/录制器可以直接用 gc 取，不必先建 adapter
        /** v190（G5 · §12.8/§12.31）：护盾工具（纯函数 / 只读）—— 探针与对拍复用。 */
        shieldRadiusM: shieldRadiusM,
        currentTankShield: function(gc, pid) { return currentTankShield(gc, pid); },
        applyShieldFixture: applyShieldFixture,
        getShieldStats: function() { return _vtCopyRecord(_shieldStats); },
        /** v188（S1 · §12.3）：弹「非正常消失」移除链 —— 订阅式账本（幂等；只订阅不 wrap）。 */
        ensureProjectileLedger: function(gc) { return _vtEnsureProjectileLedger(gc); },
        getProjectileLedger: function(gc) { return (gc && gc[PROJECTILE_LEDGER_KEY]) ? gc[PROJECTILE_LEDGER_KEY] : null; },
        /** ① 识别（纯读）：对比真实弹列表，返回 abnormal/normal/vanished 分类 + 累计账。 */
        scanProjectileRemovals: scanProjectileRemovals,
        /** ③ 单调放活（纯函数，不重跑死亡检测）。 */
        releaseDeathsAfterRemoval: releaseDeathsAfterRemoval,
        // v189（S1-毒雾）：毒雾判死（纯几何、无 Box2D）—— 探针/离线对拍直接用
        /** 读 §12.30.A 的 6 状态量（没有 STORM zone → null） */
        stormStateOf: stormStateOf,
        /** §12.30.C/D 的安全区矩形（探针复算用） */
        stormSafeRect: stormSafeRect,
        /** 在一批 {samples,dead,deathFrame} 上叠加毒雾判死（原地改，只活→死） */
        applyStormDeaths: applyStormDeaths,
        /** 最近一次毒雾判死的审计（只读；不作逻辑输入） */
        getStormDeathAudit: function() { return _STORM_LAST; },
        ensureDeathCollector: function(gc) { return _vtEnsureDeathCollector(gc); },
        getDeathCollector: function(gc) { return (gc && gc[COLLECTOR_KEY]) ? gc[COLLECTOR_KEY] : null; },
        /** 仅测试用：设成事件名（键或值）后，该事件进采集器时先抛错。mode='outer' 抛在 try 外。传 null 关闭。 */
        setDeathDebugThrow: function(evtName, mode) {
            _deathDebugThrow = evtName || null;
            _deathDebugThrowMode = (mode === 'outer') ? 'outer' : 'inner';
            return { throwOn: _deathDebugThrow, mode: _deathDebugThrowMode };
        },
        getDeathDebugThrowCount: function() { return _deathTestThrowCount; },
        createNodeSimState: createNodeSimState,
        simulateNode: simulateNode,
        OPERATIONS: OPERATIONS,
        buildConstants: buildConstants,
        /** v178（1-4-a）：炮塔形状表（纯函数，只读 Constants）。
         *  @param {number} type `Constants.WEAPON_TYPES.*`；@param {boolean} launched
         *  @returns {Object|null} {name, launched, polys}；null = 常量表取不到 */
        weaponTurretShape: weaponTurretShape,
        /** v178：形状签名 `w:<武器名>[:launched]`（进缓存键；null 形状 → null） */
        shapeSignature: shapeSignature,
        /** v178：遗留/原状形状 = 炮弹炮塔（与旧版逐字节相同的兜底） */
        legacyTurretShape: legacyTurretShape,
        fusedEnabled: fusedEnabled,
        setFusedEnabled: setFusedEnabled,
        clearCaches: clearCaches,
        // v163：树侧 calibrateFrameDt 一直调 global.VantageSandbox.setFrameDtSec，
        // 但模块级导出里没有它（只有 adapter 实例有）→ 校准永远同步不进沙箱步长。
        // 补上导出；getFrameDtSec 给探针/诊断读同一个数。
        setFrameDtSec: setFrameDtSec,
        getFrameDtSec: getFrameDtSec,
        /** v37：把融合世界的墙多边形交出去（外接 AI 复用同一份墙几何，避免"各画一套地图"）。
         *  K（Killfield）就是靠这个看到和 V 完全一致的地图；拿不到就返回 null。 */
        getFusedWallShapes: function(gameController, aiId) {
            try {
                var fc = getFusedWorld(gameController, aiId);
                return (fc && fc.wallShapes) ? fc.wallShapes : null;
            } catch (eWallShapes) { return null; }
        },
        rustPhysicsEnabled: rustPhysicsEnabled,
        setRustPhysicsEnabled: setRustPhysicsEnabled,
        rustFrameDtCompatible: rustFrameDtCompatible,  // v137：Rust 快路是否安全可用
        /** v174（1-2④）：追踪导弹「下一格表」——用游戏自己的 API 预计算，供 ABI v12 传给 Rust。
         *  返回 {ok, w, h, table:Uint8Array(w*h*w*h), pairs, computed, skipped, ms,
         *        flags:Uint8Array(w*h), reach:Uint8Array(w*h)}。
         *  只读、不改变任何游戏状态；真游戏不调用它（探针/ABI 装配层用）。 */
        buildNextTileTable: buildNextTileTable,
        /** v176（E）：导航表状态位 —— `state` ∈ idle/ready/disabled-budget/build-failed。
         *  外部（探针/面板/测试）可据此**检测**"本局制导是否因超预算被停用"，不必翻 console。 */
        getNavTableStatus: getNavTableStatus,
        /** v12：按 maze 对象缓存的导航表（同一 maze 只建一次）；建不出 → null。 */
        getMazeNavTables: getMazeNavTables,
        /** v12：`vt_set_maze` 的稳定 maze id（同对象同 id；0 保留给未装表）。 */
        mazeIdOf: mazeIdOf,
        /** v12：制导一步（探针/对拍直接复用；与 Rust 同公式）。 */
        missileSteerVelocity: missileSteerVelocity,
        /** v12：最近一次 rescore 的「每 node 制导弹道」只读快照（B2 对拍用）。 */
        getLastRescoreMissileTracks: function() { return _lastRescoreMissileTracks; },
        /** v12（D1 断言）：HOMING_MISSILE 不得进 track 世界。 */
        assertMissileNotBallistic: assertMissileNotBallistic
    };

    // v161：地雷破片不反弹 —— getProjectilePaths 按弹种决定反弹次数（MINE 用 0）。
    //   依据（本地版与正式版代码一致）：Shrapnel.hitMaze 把速度清零（撞墙即停），
    //   done() 在速度≈0 时返回 true。原来一律用全局 pathBounces=5 → 6 次全图射线
    //   × 30 片 = 180 次，是"地雷爆炸直接卡死"的量；现在 30 片 = 30 次射线。
    //   参考待查清单 §9.2。
    console.log('[Vantage Sandbox] 模块已加载（**sandbox 模块自报 v61**；⚠️ 与 TREE_VERSION 无关，树版本请看 VantageTree.VERSION=' + ((typeof VantageTree !== 'undefined' && VantageTree.VERSION) ? VantageTree.VERSION : '树未加载') + '；v59：1-2③ 收尾 —— v172 fd=0 rescore 死判/评分消费层修正（rescore_nodes>=0 + bridge actualFrames + dead>=0；不改写 fd）+ 激光线段扫掠（Step 前后实际位移 × 候选全部 sensor 多边形，墙裁剪+镜面反射，回溯补判不中途停车）+ ABI v11 弹种码 3=LASER + v164 弹种档案 + v166 霰弹/反弹上限 + v57：S3/S7 时间基准修正；v176：导航表 换图即建 A + 预算阀 E；v178：1-4-a 炮塔形状签名 + 候选体重建（按当前武器取各自炮塔常量，护盾位留空））');

})(typeof window !== 'undefined' ? window : this);
