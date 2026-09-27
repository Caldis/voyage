#!/usr/bin/env bash
# W03 浮空古城的自测截图（仓库根或 apps/voyage 下执行都行）。
# 用法：bash apps/voyage/handoff/W03-shots.sh <端口> <输出目录（相对仓库根）> [d3d11|vulkan] [场景名,逗号分隔] [距离 km] [种子]
#   day     右座朝西、16:15（太阳 16°、在城左上方约 11°）：侧逆光，剪影 + 亮边 + 雾里的光束（= 回归场景 wonder-floatcity-day）
#   dusk    左座朝东、17:20（太阳约 1°，在身后）：黄昏镀金，身后是暗下去的东天（= 回归场景 wonder-floatcity-dusk）
#   front   左座朝东、15:00（太阳 31°、在身后）：顺光，泛青灰的淡剪影
#   cloud   同 day，但云海贴着航路（8–9.8 km）：城的下半截被前方的云挡住、城挡住身后的云
#   alto    同 front，高积云（4.5–6 km）：根须垂进下面的云里
#   night   右座朝西、21:30：几乎只剩剪影 + 岩锥尖一点极淡的微光
#   rise    同 day，reveal = 0.1 / 0.35 / 0.6（浮现过程：一团不对劲的云 → 雾散开）
# 日期一律写死 2026-09-27（月相、太阳位置可复现）。
set -e
PORT=${1:-5203}
OUT=${2:-tmp/screenshot/W03/shots}
ANGLE=${3:-d3d11}
ONLY=${4:-day,dusk}
DIST=${5:-85}
SEED=${6:-0.23}
cd "$(dirname "$0")/.."

js() { # $1 reveal
  echo "v.wonders.enabled = true; for (let i = 0; i < 2; i++) await new Promise((r) => requestAnimationFrame(r)); v.wonders.trigger(\\\"floatcity\\\", { forwardOffsetDeg: 0, distKm: $DIST, reveal: ${1:-1}, riseS: 1e9, seed: $SEED }); for (let i = 0; i < 240 && v.clouds.wonderLayerState !== \\\"ready\\\"; i++) await new Promise((r) => setTimeout(r, 250)); return v.wonders.describe() + \\\" · \\\" + v.clouds.wonderLayerState;"
}
scene() { # $1 名字；$2 p 的 JSON 片段；$3 reveal
  echo "{\"name\":\"$1\",\"p\":{\"preset\":\"wpac\",\"date\":\"2026-09-27\",$2,\"wing-pos\":\"-4\"},\"wait\":4000,\"js\":\"$(js $3)\"}"
}
SC='"cloud-preset":"stratocumulus","coverage":0.6'
ARGS=()
IFS=',' read -ra L <<< "$ONLY"
for n in "${L[@]}"; do
  case $n in
    day) ARGS+=(--scene "$(scene floatcity-day "\"seat\":\"right\",\"time\":975,$SC")") ;;
    back) ARGS+=(--scene "$(scene floatcity-back "\"seat\":\"right\",\"time\":1020,$SC")") ;;
    dusk) ARGS+=(--scene "$(scene floatcity-dusk "\"seat\":\"left\",\"time\":1040,\"cabin-light\":false,$SC")") ;;
    front) ARGS+=(--scene "$(scene floatcity-front "\"seat\":\"left\",\"time\":900,$SC")") ;;
    cloud) ARGS+=(--scene "$(scene floatcity-cloud "\"seat\":\"right\",\"time\":975,\"cloud-preset\":\"deck-below\",\"coverage\":0.5")") ;;
    alto) ARGS+=(--scene "$(scene floatcity-alto "\"seat\":\"left\",\"time\":900,\"cloud-preset\":\"altocumulus\",\"coverage\":0.6")") ;;
    night) ARGS+=(--scene "$(scene floatcity-night "\"seat\":\"right\",\"time\":1290,\"cabin-light\":false,$SC")") ;;
    rise) for r in 0.1 0.35 0.6; do ARGS+=(--scene "$(scene floatcity-rise-$r "\"seat\":\"right\",\"time\":975,$SC" $r)"); done ;;
  esac
done
node scripts/dev-browser.mjs shots --port "$PORT" --out "$OUT" --angle "$ANGLE" "${ARGS[@]}"
