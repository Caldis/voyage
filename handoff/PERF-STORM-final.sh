#!/usr/bin/env bash
# PERF-STORM 交付测量链（apps/voyage 下运行）：本分支开发服务器 5268，对照（master）5328。
# 输出：D:/Code/opus-test/tmp/perfstorm-final-*.log / *.json，截图 / 读回在 D:/Code/opus-test/tmp/screenshot/perfstorm/
set -u
T=D:/Code/opus-test/tmp
S=noon-cumulus,sea-sc,clouds-variety,night-city,storm-day,storm-sc-low,storm-sc,typhoon-bands
# 1. 按 pass 的帧预算（与 PERF-PREVIEW-8 同一口径：passes-vp 副本，中位 × 调用数 ÷ 帧数），1600×1200 与用户 3840×1950，master 与本分支各一遍
for P in 5328 5268; do
  node $T/pp8/passes-vp.mjs --port $P --only $S --frames 30 --rounds 3 --wait-quiet --out $T/perfstorm-final-pp1600-$P.json > $T/perfstorm-final-pp1600-$P.log 2>&1
  VPW=2560 VPH=1300 DPR=1.5 node $T/pp8/passes-vp.mjs --port $P --only $S --frames 30 --rounds 3 --wait-quiet --out $T/perfstorm-final-ppuser-$P.json > $T/perfstorm-final-ppuser-$P.log 2>&1
done
# 2. 用户分辨率整帧配对（gpu-ab --time frame）
node scripts/dev-browser.mjs gpu-ab --port 5268 --base 5328 --viewport 2560x1300 --dpr 1.5 --jobs apps/voyage/handoff/PERF-STORM-gpu-jobs.json --rounds 8 --n 10 --time frame > $T/perfstorm-final-frameuser.log 2>&1
# 3. 画质：切程序一致性 + 真值
node scripts/dev-browser.mjs ab --port 5268 --base 5328 --jobs apps/voyage/handoff/PERF-STORM-sw-jobs.json --rounds 1 --out $T/screenshot/perfstorm/sw > $T/perfstorm-final-sw.log 2>&1
# 4. flight：静止 / reset 后收敛 / 巡航 / 转弯 / live
node scripts/dev-browser.mjs flight --port 5268 --base 5328 --jobs apps/voyage/handoff/PERF-STORM-flight-jobs.json --variants apps/voyage/handoff/PERF-STORM-flight-variants.json --modes static,reset,cruise,turn,live --out $T/screenshot/perfstorm/flight > $T/perfstorm-final-flight.log 2>&1
echo ALLDONE > $T/perfstorm-final-done.txt
