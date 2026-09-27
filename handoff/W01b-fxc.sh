#!/usr/bin/env bash
# W01b：窗外程序离线 FXC 编译时间对照（shader-budget，交替测）。仓库根执行：
#   bash apps/voyage/handoff/W01b-fxc.sh <新版副本> <master 副本> [轮数]
NEW=$1
OLD=$2
ROUNDS=${3:-2}
F=apps/voyage/src/render/wonder-sky.glsl.ts
for round in $(seq 1 "$ROUNDS"); do
  for v in new master; do
    if [ "$v" = new ]; then cp "$NEW" "$F"; else cp "$OLD" "$F"; fi
    echo "== $v 第 $round 轮"
    (cd apps/voyage && timeout 600 node scripts/shader-budget.mjs --only outside-default 2>&1 | grep -E "outside-default" | tail -2)
  done
done
cp "$NEW" "$F"
