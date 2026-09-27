#!/usr/bin/env bash
# T38 自测场景：富士山清晨 4 km（日期写死，月相 / 太阳位置可复现）与台风雨带。
# 用法：bash handoff/T38-scenes.sh <端口> <输出目录（相对 worktree 根）> [额外参数，如 --angle vulkan --freeze --settle]
set -e
PORT=$1; OUT=$2; shift 2
cd "$(dirname "$0")/.."
FUJI='"preset":"fuji","date":"2026-09-27","time":395,"altitude":4,"wing-pos":"-4"'
node scripts/dev-browser.mjs shots --port "$PORT" --out "$OUT" "$@" \
  --scene "{\"name\":\"fuji-dawn\",\"p\":{$FUJI,\"coverage\":0.05},\"offset\":[-20,0.2],\"ground\":true,\"js\":\"v.haze.override={}\"}" \
  --scene "{\"name\":\"fuji-dawn-c0\",\"p\":{$FUJI,\"coverage\":0},\"offset\":[-20,0.2],\"ground\":true,\"js\":\"v.haze.override={}\"}" \
  --scene "{\"name\":\"fuji-dawn-c30\",\"p\":{$FUJI,\"coverage\":0.3},\"offset\":[-20,0.2],\"ground\":true,\"js\":\"v.haze.override={}\"}" \
  --only typhoon-bands
