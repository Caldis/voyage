#!/usr/bin/env bash
# W01b：窗外程序冷编译对照（d3d11，交替测）。把 wonder-sky.glsl.ts 在「本分支版本」与「master 版本」之间来回换，
# 每换一次开一个全新浏览器测一次真冷启动。仓库根执行：bash apps/voyage/handoff/W01b-cold.sh <端口> <新版副本> <master 副本> [轮数]
PORT=${1:-5201}
NEW=$2
OLD=$3
ROUNDS=${4:-2}
F=apps/voyage/src/render/wonder-sky.glsl.ts
for round in $(seq 1 "$ROUNDS"); do
  for v in new master; do
    if [ "$v" = new ]; then cp "$NEW" "$F"; else cp "$OLD" "$F"; fi
    sleep 3
    echo "== $v 第 $round 轮"
    timeout 400 node apps/voyage/scripts/dev-browser.mjs cold --port "$PORT" --repeat 1 2>&1 | grep -E "totalMs|着色器编译" | sed 's/renderer=.*//'
  done
done
cp "$NEW" "$F"
