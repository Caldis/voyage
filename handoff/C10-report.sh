#!/bin/sh
# C10：对一次 C10-ab.mjs 的输出目录跑全部指标，写 <目录>/metrics.txt。用法：sh handoff/C10-report.sh <目录> <基准> <变体...>
D="$1"; shift
BASE="$1"
cat "$D/errors.json"
{
  echo "#### C10-metrics（显示单帧 / HDR 时间，相对 $BASE）"
  python handoff/C10-metrics.py "$D" "$BASE"
  echo "#### 噪声分量的斜纹指数与幅度"
  python handoff/C10-nstreak.py "$D" "$@"
  echo "#### 巡航（确定性航迹，检查点对真值）"
  python handoff/C10-motion.py "$D" "$@"
  echo "#### 边宽 / 表皮剖面"
  for j in clouds-variety cu-side noon-cumulus backlit-cu backlit-close sunset-wing storm-day typhoon-bands cirrus-noon wonder-floatcity-day; do
    if [ -d "$D/$j" ]; then echo "== $j"; python handoff/C10-edge.py "$D" "$j" "$@" diag; fi
  done
} > "$D/metrics.txt" 2>&1
echo written
