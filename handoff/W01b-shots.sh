#!/usr/bin/env bash
# W01b：天梯外延结构 / 奇观白天可见的验收截图（私有 headless）。在仓库根执行：
#   bash apps/voyage/handoff/W01b-shots.sh <端口> <输出目录，相对仓库根> [d3d11|vulkan] [附加参数…]
# 拍：两个回归场景（wonder-tether-dusk、wonder-jianmu-day）+ 正午召唤天梯 + 夜里天梯 + 黄昏建木 + 夜里建木（日期都写死 2026-09-27）
PORT=${1:-5201}
OUT=${2:-tmp/screenshot/W01b/cur}
ANGLE=${3:-d3d11}
shift 3 2>/dev/null
S='v.wonders.enabled = true; for (let i = 0; i < 2; i++) await new Promise((r) => requestAnimationFrame(r)); v.wonders.trigger('
E=', reveal: 1 }); return v.wonders.describe();'
node apps/voyage/scripts/dev-browser.mjs shots --port "$PORT" --angle "$ANGLE" --out "$OUT" \
  --only wonder-tether-dusk,wonder-jianmu-day \
  --scene "{\"name\":\"wonder-tether-noon\",\"p\":{\"preset\":\"wpac\",\"date\":\"2026-09-27\",\"time\":720,\"coverage\":0.3,\"wing-pos\":\"-4\"},\"js\":\"${S}'tether', { forwardOffsetDeg: 0, distKm: 370${E}\"}" \
  --scene "{\"name\":\"wonder-tether-night\",\"p\":{\"preset\":\"wpac\",\"date\":\"2026-09-27\",\"time\":1290,\"coverage\":0.3,\"wing-pos\":\"-4\",\"cabin-light\":\"off\"},\"js\":\"${S}'tether', { forwardOffsetDeg: 0, distKm: 370${E}\"}" \
  --scene "{\"name\":\"wonder-jianmu-dusk\",\"p\":{\"preset\":\"wpac\",\"seat\":\"left\",\"date\":\"2026-09-27\",\"time\":1072,\"coverage\":0.3,\"wing-pos\":\"-4\",\"cabin-light\":false},\"js\":\"${S}'jianmu', { forwardOffsetDeg: 0, distKm: 380${E}\"}" \
  --scene "{\"name\":\"wonder-jianmu-night\",\"p\":{\"preset\":\"wpac\",\"date\":\"2026-09-27\",\"time\":1290,\"coverage\":0.3,\"wing-pos\":\"-4\",\"cabin-light\":\"off\"},\"js\":\"${S}'jianmu', { forwardOffsetDeg: 0, distKm: 380${E}\"}" \
  "$@"
