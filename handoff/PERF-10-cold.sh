#!/usr/bin/env bash
# PERF-10：真冷启动与对照端口交替 N 轮（d3d11），每轮各起一个浏览器、nonce 破缓存。
# 用法：bash apps/voyage/handoff/PERF-10-cold.sh <端口> <对照端口> <轮数> <输出目录>
# 输出：<目录>/cold-<端口>-r<i>.log；汇总用 grep totalMs
set -e
A=$1; B=$2; N=$3; OUT=$4
HERE="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$OUT"
for i in $(seq 1 "$N"); do
  for P in "$A" "$B"; do
    node "$HERE/scripts/dev-browser.mjs" cold --port "$P" --wait-quiet > "$OUT/cold-$P-r$i.log" 2>&1 || true
    echo "$P r$i $(grep -o 'totalMs=[0-9]*' "$OUT/cold-$P-r$i.log")"
  done
done
