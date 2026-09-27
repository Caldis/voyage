#!/usr/bin/env bash
# PERF-10：同一组场景按 pass 计时重复 N 次（每次重开页面，两端口交替），看「页面加载决定的档位」分布。
# 用法：bash apps/voyage/handoff/PERF-10-passes-rep.sh <端口> <对照端口> <次数> <场景,…> <输出目录>
set -e
A=$1; B=$2; N=$3; ONLY=$4; OUT=$5
HERE="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$OUT"
for i in $(seq 1 "$N"); do
  node "$HERE/scripts/passes.mjs" --port "$A" --baseline "$B" --rounds 1 --frames 30 --only "$ONLY" > "$OUT/rep-$i.log" 2>&1 || true
  node "$HERE/handoff/PERF-10-passes-sum.mjs" "$OUT/rep-$i.log" "云步进,云步进(卷云变体)" | tail -n +2 | sed "s/^/r$i | /"
done
