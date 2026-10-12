# 已归档到 D:（2026-10-12，C 盘救急）

**不是删除 —— 是搬家。** 原内容在：

```
D:\_vt_archive_20261012\
```

| 原路径（C:） | 归档位置（D:） | 大小 |
|---|---|---|
| `_tools/headless/_ev_pg/` | `D:\_vt_archive_20261012\_ev_pg\` | 33 M |
| `_tools/headless/_ev_logs/` | `D:\_vt_archive_20261012\_ev_logs\` | 18 M |
| `_tools/headless/_i4x_prof/` | `D:\_vt_archive_20261012\_i4x_prof\` | 7.2 M |
| `_tools/headless/_i4_prof/` | `D:\_vt_archive_20261012\_i4_prof\` | 1.3 M |

## 删之前核过（为什么安全）
- **代码引用**：12 + 9 + 1 处，**全部是探针的【输出目录】**（`const OUT = path.join(__dirname, '_i4x_prof')`），
  **且都用 `fs.mkdirSync(OUT, { recursive: true })`** ⟹ **脚本会自己重建目录，不会 ENOENT** ✓
- **读取方**：`grep readFileSync/readdirSync` 命中这几个目录的 **0 处** ⟹ **没有任何代码【读】它们** ✓
- **文档引用**：`_i4x_prof` 3 处 + `_i4_prof` 4 处 + `_ev_pg` 2 处 + `_ev_logs` 2 处
  ⟹ **路径已指向 D:，需要时按上表取回** ✓

## 要取回的话
```bash
cp -r /d/_vt_archive_20261012/_i4x_prof _tools/headless/
```
