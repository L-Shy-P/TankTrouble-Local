# Vantage 训练数据归档 2026-10-21

## 内容
`episodes_part00` ~ `episodes_part03` — gzip 压缩的 `episodes.jsonl`，切成 40MB 分片。

## 还原
```bash
cat episodes_part* > episodes.jsonl.gz
python -c "import gzip,shutil; shutil.copyfileobj(gzip.open('episodes.jsonl.gz','rb'), open('episodes.jsonl','wb'))"
```

## 数据规模
- 原始：1,430 MB / 1,160 局
- 压缩：146 MB（7.4:1）
- 校验：解压后可解析局数 = 1160（与原文件行数一致）

## 采集条件
- CUDA 训练，`--w-fire-pg 1.0`、`--fire-ent-coef 0.005`、`--w-still -0.02`、`--w-empty-fire -0.05`
- `S30_DUMP_MAX=0`（不裁长局头）
- `survive` 已打补丁：`t < 60`（前 1 秒）的帧 `survive = 0`

## 已知问题
- 帧数中位数 47 帧（0.78 秒）
- 自杀率 99.4%
- 见 docs 里的根因诊断
