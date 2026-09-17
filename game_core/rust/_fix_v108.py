import io

p = 'vantage_tree.js'
s = io.open(p, encoding='utf-8').read()

# 1) 段内卡墙状态
old1 = """    var _stuckOps = {};                        // 操作名 → 剩余禁止帧数
    var _stuckOpBanFrames = 45;                // 禁选时长（0.75 秒）
    var _stuckMoveMinM = 1.0;                  // 一段操作的“有效位移”下限（米）"""
new1 = """    var _stuckOps = {};                        // 操作名 → 剩余禁止帧数
    var _stuckOpBanFrames = 45;                // 禁选时长（0.75 秒）
    var _stuckMoveMinM = 1.0;                  // 一段操作的“有效位移”下限（米）
    // v108：段内卡墙检测。段末才判卡墙太慢——段长可能 30 帧（0.5 秒），
    // 这半秒里 AI 顶着墙纹丝不动（主人实测“按住前进、有特效、但坦克不动”）。
    var _stuckInSegFrames = 0;                 // 连续多少帧“有油门却没位移”
    var _stuckInSegPos = null;                 // 上一帧位置
    var _stuckInSegThreshold = 6;              // 连续 6 帧（0.1 秒）就判定
    var _stuckInSegDistM = 0.03;               // 单帧位移 < 3cm（正常前进≈32cm）"""
assert old1 in s, 'a1'
s = s.replace(old1, new1, 1)

# 2) 段内卡墙检测函数
old2 = """    /** v106：两个操作是不是“方向相反”（前进↔后退、左转↔右转）。"""
new2 = """    /** v108：段内卡墙检测——有油门却连续多帧几乎不位移，立刻结束当前段重选。
     *  主人实测：坦克正面垂直贴墙时，树要等段末（最长 0.5 秒）才换操作，
     *  这半秒里“按住前进、有特效、坦克纹丝不动”，等于宕机送死。 */
    function checkStuckInSegment(tree, tankState) {
        if (!tree || !tree.commitNode || !tankState) {
            _stuckInSegFrames = 0; _stuckInSegPos = null;
            return;
        }
        var cmt = tree.commitNode;
        var inp = cmt.inputs || {};
        // 只有“真的在踩油门”才算（原地转向不算卡墙）
        if (!inp.forward && !inp.back) {
            _stuckInSegFrames = 0; _stuckInSegPos = null;
            return;
        }
        if (!_stuckInSegPos) {
            _stuckInSegPos = { x: tankState.x, y: tankState.y };
            _stuckInSegFrames = 0;
            return;
        }
        var dx = tankState.x - _stuckInSegPos.x, dy = tankState.y - _stuckInSegPos.y;
        var moved = Math.sqrt(dx * dx + dy * dy);
        if (moved < _stuckInSegDistM) {
            _stuckInSegFrames++;
        } else {
            _stuckInSegFrames = 0;
            _stuckInSegPos = { x: tankState.x, y: tankState.y };
        }
        if (_stuckInSegFrames >= _stuckInSegThreshold) {
            var opKey = cmt.opName || ('n' + cmt.id);
            _stuckOps[opKey] = _stuckOpBanFrames;
            tree.stats.stuckInSegment = (tree.stats.stuckInSegment || 0) + 1;
            recordStructure(tree, 'stuck-in-segment',
                opKey + ' frames=' + _stuckInSegFrames);
            pushEvent('stuck', '贴墙立即重选:' + opKey);
            // 立刻结束当前段 → tick 后面就会重选（并带着“该操作被拉黑”的惩罚）
            cmt.tEndSec = _timeAcc;
            tree._forcedReselect = true;
            _stuckInSegFrames = 0;
            _stuckInSegPos = null;
        }
    }

    /** v106：两个操作是不是“方向相反”（前进↔后退、左转↔右转）。"""
assert old2 in s, 'a2'
s = s.replace(old2, new2, 1)

# 3) tick 里调用
old3 = """        // v103：空场安全感知 → 自动去最安全的那块地皮（走到就停）。
        if (_killfieldEnabled) {
            try { syncKillfieldAutoTarget(ai); } catch (eAuto) {}
        }"""
new3 = """        // v103：空场安全感知 → 自动去最安全的那块地皮（走到就停）。
        if (_killfieldEnabled) {
            try { syncKillfieldAutoTarget(ai); } catch (eAuto) {}
        }
        // v108：段内贴墙检测（有油门却不位移 → 立即结束本段重选）
        try { checkStuckInSegment(_tree, tankState); } catch (eStuckSeg) {}"""
assert old3 in s, 'a3'
s = s.replace(old3, new3, 1)

# 4) reset 清干净（跨局残留会让“每几局行为都不一样”）
old4 = """        _moveTargetWrites = 0;
        _lastAdapter = null;
        _lastTankState = null;"""
new4 = """        _moveTargetWrites = 0;
        _lastAdapter = null;
        _lastTankState = null;
        // v108：这些跨局必须清干净，否则上一局的“卡墙黑名单/段内计数”会带进
        // 下一局 —— 主人实测“同样配置、每几局 AI 就变一个样”，根因就在这里。
        _stuckOps = {};
        _stuckInSegFrames = 0;
        _stuckInSegPos = null;"""
assert old4 in s, 'a4'
s = s.replace(old4, new4, 1)

# 5) 录制 meta 版本号跟上
s = s.replace("treeVersion: 'v106',", "treeVersion: 'v108',", 1)

io.open(p, 'w', encoding='utf-8').write(s)
print('ok')
