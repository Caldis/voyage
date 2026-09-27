#!/usr/bin/env bash
# 逐场景求差：<A 目录> 对 <B 目录>（噪声底）、<A 目录> 对 <C 目录>（改动），打印 mean / p99 / 超阈值像素比例。
# 用法：bash apps/voyage/handoff/PERF-10-diff.sh <A> <B> <C> [热图输出目录]
set -e
A=$1; B=$2; C=$3; HEAT=$4
HERE="$(cd "$(dirname "$0")/.." && pwd)"
for f in "$A"/*.png; do
  n=$(basename "$f" .png)
  [ -f "$B/$n.png" ] && [ -f "$C/$n.png" ] || continue
  noise=$(node "$HERE/scripts/compare.mjs" --diff "$B/$n.png" --json "$f" 2>/dev/null | tr -d '\n' | sed 's/  */ /g')
  if [ -n "$HEAT" ]; then
    mkdir -p "$HEAT"
    chg=$(node "$HERE/scripts/compare.mjs" --diff "$C/$n.png" --heatmap "$HEAT/$n.png" --json "$f" 2>/dev/null | tr -d '\n' | sed 's/  */ /g')
  else
    chg=$(node "$HERE/scripts/compare.mjs" --diff "$C/$n.png" --json "$f" 2>/dev/null | tr -d '\n' | sed 's/  */ /g')
  fi
  echo "$n"
  echo "  噪声底: $noise"
  echo "  改动  : $chg"
done
