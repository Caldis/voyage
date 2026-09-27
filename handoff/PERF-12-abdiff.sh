#!/usr/bin/env bash
# PERF-12：对 PERF-12-ab.mjs 的输出逐场景求差（A 本分支 vs B 基线；A vs A2 冻结噪声底），一行一个场景
# 用法（在 apps/voyage 下）：bash handoff/PERF-12-abdiff.sh tmp/screenshot/PERF-12/ab1
dir="$1"
for a in "../../$dir"/*-A.png; do
  n=$(basename "$a" -A.png)
  ab=$(node scripts/compare.mjs --diff "$dir/$n-B.png" --heatmap "$dir/$n-heat.png" "$dir/$n-A.png" 2>&1 | grep -E "平均|超过" | tr '\n' ' ')
  aa=$(node scripts/compare.mjs --diff "$dir/$n-A2.png" "$dir/$n-A.png" 2>&1 | grep -E "平均" | tr '\n' ' ')
  echo "$n | A-B: $ab | 噪声底 A-A2: $aa"
done
