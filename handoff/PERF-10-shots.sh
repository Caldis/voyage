#!/usr/bin/env bash
# PERF-10 / PERF-11 零回归截图：简报点名的场景（冻结 + 等瓦片），另加 storm-dusk、fuji-dawn-c30（T38）。
# 每个场景都写死云的世界偏移（offset）：场景表里没写 offset 的场景，飞机位置 = 打开页面后飞了多久，
# 变体后台编译的等待时间不同，两次截图的云就挪了几公里（第一轮 cirrus-noon 均差 7/255 全是这个，不是渲染差异）。
# 用法：bash apps/voyage/handoff/PERF-10-shots.sh <端口> <输出目录（相对仓库根，或绝对路径）> [额外参数]
set -e
PORT=$1; OUT=$2; shift 2
HERE="$(cd "$(dirname "$0")/.." && pwd)"
FUJI='"preset":"fuji","date":"2026-09-27","time":395,"altitude":4,"wing-pos":"-4"'
FLOAT='v.wonders.enabled = true; for (let i = 0; i < 2; i++) await new Promise((r) => requestAnimationFrame(r)); v.wonders.trigger(\"floatcity\", { forwardOffsetDeg: 0, distKm: 80, reveal: 1, seed: 0.23 }); for (let i = 0; i < 240 && v.clouds.wonderLayerState !== \"ready\"; i++) await new Promise((r) => setTimeout(r, 250)); v.cloudUniforms.uCloudOffset.value.set(0, 0); return v.clouds.wonderLayerState;'
CIRRUS='for (let i = 0; i < 240 && ![\"ready\", \"failed\"].includes(v.clouds.cirrusLayerState); i++) await new Promise((r) => setTimeout(r, 250)); v.cloudUniforms.uCloudOffset.value.set(0, 0); return v.clouds.cirrusLayerState;'
node "$HERE/scripts/dev-browser.mjs" shots --port "$PORT" --out "$OUT" --freeze --settle "$@" \
  --scene '{"name":"noon-cumulus","p":{"preset":"wpac","time":720,"wing-pos":"8"},"offset":[0,0]}' \
  --scene '{"name":"sunset-wing","p":{"preset":"wpac","time":1040,"wing-pos":"8"},"offset":[0,0]}' \
  --scene "{\"name\":\"cirrus-noon\",\"p\":{\"preset\":\"wpac\",\"time\":720,\"cloud-preset\":\"cirrus\",\"coverage\":0.5,\"altitude\":9,\"wing-pos\":\"8\"},\"offset\":[0,0],\"js\":\"$CIRRUS\"}" \
  --scene '{"name":"storm-day","p":{"preset":"wpac","time":900,"coverage":0.3,"weather":"storm","wing-pos":"-4"},"offset":[0,0]}' \
  --scene '{"name":"storm-dusk","p":{"preset":"wpac","time":1040,"coverage":0.3,"weather":"storm","wing-pos":"-4"},"offset":[0,0]}' \
  --scene '{"name":"typhoon-eye","p":{"preset":"wpac","time":540,"coverage":0.2,"weather":"typhoon-eye","wing-pos":"-4"},"offset":[0,0]}' \
  --scene '{"name":"typhoon-bands","p":{"preset":"wpac","time":900,"coverage":0.2,"weather":"typhoon-bands","wing-pos":"-4"},"offset":[0,0]}' \
  --scene '{"name":"typhoon-outer","p":{"preset":"wpac","time":900,"coverage":0.2,"altitude":13,"weather":"typhoon-outer","wing-pos":"-4"},"offset":[0,0]}' \
  --scene '{"name":"fuji-day","p":{"preset":"fuji","time":930,"altitude":6,"coverage":0.1,"wing-pos":"-4"},"offset":[-20,0.2],"ground":true}' \
  --scene "{\"name\":\"fuji-dawn-c30\",\"p\":{$FUJI,\"coverage\":0.3},\"offset\":[-20,0.2],\"ground\":true,\"js\":\"v.haze.override={}\"}" \
  --scene "{\"name\":\"wonder-floatcity-day\",\"p\":{\"preset\":\"wpac\",\"seat\":\"right\",\"date\":\"2026-09-27\",\"time\":975,\"cloud-preset\":\"stratocumulus\",\"coverage\":0.6,\"wing-pos\":\"-4\"},\"offset\":[0,0],\"wait\":4000,\"js\":\"$FLOAT\"}"
