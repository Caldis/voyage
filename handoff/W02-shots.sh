#!/usr/bin/env bash
# W02 雾海灯城的自测截图（仓库根或 apps/voyage 下执行都行）。
# 用法：bash apps/voyage/handoff/W02-shots.sh <端口> <输出目录（相对仓库根）> [d3d11|vulkan] [场景名,逗号分隔]
#   night   wpac 无月夜 22:00、右座朝西、城心 95 km（= 回归场景 wonder-fogcity-night）
#   near    同上，城心 72 km（更大、塔更清楚）
#   cloud   同上，层积云 0.55 在前方：云挡住城的一部分、城挡住身后的云
#   day     同一位置 12:00（白天：黄褐色的霾团 + 巨塔淡灰剪影）
#   dusk    18:00（太阳约 −8°：灯刚亮、雾还带蓝灰）
set -e
PORT=${1:-5202}
OUT=${2:-tmp/screenshot/W02/shots}
ANGLE=${3:-d3d11}
ONLY=${4:-night,cloud,day}
cd "$(dirname "$0")/.."

js() { # $1 距离 km；$2 种子
  echo "v.wonders.enabled = true; for (let i = 0; i < 2; i++) await new Promise((r) => requestAnimationFrame(r)); v.wonders.trigger(\\\"fogcity\\\", { forwardOffsetDeg: 0, distKm: $1, reveal: 1, seed: ${2:-0.37} }); for (let i = 0; i < 240 && v.clouds.wonderLayerState !== \\\"ready\\\"; i++) await new Promise((r) => setTimeout(r, 250)); return v.wonders.describe() + \\\" · \\\" + v.clouds.wonderLayerState;"
}
scene() { # $1 名字；$2 p 的 JSON 片段；$3 距离
  echo "{\"name\":\"$1\",\"p\":{\"preset\":\"wpac\",\"date\":\"2026-01-16\",$2,\"cabin-light\":false,\"wing-pos\":\"-4\"},\"wait\":4000,\"js\":\"$(js $3)\"}"
}
ARGS=()
IFS=',' read -ra L <<< "$ONLY"
for n in "${L[@]}"; do
  case $n in
    night) ARGS+=(--scene "$(scene fogcity-night '"time":1320,"coverage":0.15' 95)") ;;
    near) ARGS+=(--scene "$(scene fogcity-near '"time":1320,"coverage":0.15' 72)") ;;
    cloud) ARGS+=(--scene "$(scene fogcity-cloud '"time":1320,"cloud-preset":"stratocumulus","coverage":0.55' 95)") ;;
    day) ARGS+=(--scene "$(scene fogcity-day '"time":720,"coverage":0.15' 95)") ;;
    dusk) ARGS+=(--scene "$(scene fogcity-dusk '"time":1080,"coverage":0.15' 95)") ;;
  esac
done
node scripts/dev-browser.mjs shots --port "$PORT" --out "$OUT" --angle "$ANGLE" "${ARGS[@]}"
