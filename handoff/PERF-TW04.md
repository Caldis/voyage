# PERF-TW04 · TW04 积雨云重做后的雷暴天性能回收（交付）

- 分支 `worktree-agent-ab549aa4e779753f5`（已合并 master f25f660）。开发端口 5298；对照：master f25f660 在 `D:\Code\opus-test\tmp\ptw-base`（5371），TW04 前 3edb28c 在 `tmp\ptw-pre`（5372，简报没给端口，自取），逐步对照 `tmp\ptw-step`（5373）。三个对照 worktree 与服务器交付前已删 / 已关。
- 硬件渲染已核：`ANGLE (NVIDIA GeForce RTX 5090 … Direct3D11)`；gpu-ab / ab / shader-budget 都持测量锁（排队等过别的代理的 ab 与 shader-budget），URL 带 `voyage=0`（工具自带）；变体一律显式写全（`materials: base` / `patch`），每组带 A/A。
- 改动：`src/clouds/storm-shield.ts`（新）、`src/clouds/clouds.ts`、`src/clouds/clouds.glsl.ts`（全在 `CLOUD_STORM` / `CLOUD_WEATHER` 宏里）、`scripts/storm-shield.test.mts`（新）、README 坑点一条。**没碰** far-towers.ts / weather.ts / TASKS / WORKLOG / ROADMAP / DEV_SOP。
- 默认程序逐字不变：`shader-parity --base <master>` 只有 5 个雷暴程序不同（cloud-march-storm / severe、cloud-occupancy、cloud-probe-weather、cloud-shadow-map-weather）；cloud-march、cirrus、lenticular、wonder、**typhoon**、窗外、机翼等全部逐字或预处理后相同。`check:glsl` 全过，typecheck / build 通过，`dist/assets` 0 字节文件 0 个，所有测量期间 console error 0。

## 结论

| 口径 | storm-day | storm-sc | storm-sc-low | tw-squall（飑线） | storm-graze |
| --- | --- | --- | --- | --- | --- |
| 云 pass 对 master（1600×1200） | **×0.821** | — | **×0.822** | ×0.900 | ×0.943 |
| 整帧对 master（3840×1950） | ×0.874 | ×0.870 | ×0.873 | ×0.918 | — |
| 整帧对 TW04 前（3840×1950） | **×1.138** | **×1.124** | **×1.120** | ×1.305 | — |
| 整帧 ms（3840×1950，占 6.25 ms 预算） | 8.53（136%） | 8.19（131%） | 8.54（137%） | 14.3（229%） | — |

- 三个单体雷暴场景整帧回到 TW04 前 ×1.15 以内（目标达成）；飑线仍 ×1.31（见「没做 / 剩下的」）。
- 冷编译（离线 FXC，`shader-budget --rounds 3`，按最小值）：cloud-march-storm 对 master −5.6%，**对 TW04 前仍 +24%**（4.43 → 5.51 s；目标 +10% 没达到）；severe +15%、occupancy +17%、shadow-weather +6%、probe-weather +21%（都对 TW04 前）。
- 画质：同页 ab（cloud-live，每变体两轮）与 master 平均差 0.02–0.46 级，噪声底 0.04–0.38；亮度 / 相邻差 / 饱和度逐项相同；飞行 240 帧闪烁像素与同代码两次录制同量级（下表）。

## 每步收益（gpu-ab `--time clouds`，1600×1200，8 轮 ABBA，A/A 都在 ±0.5% 内）

| 步 | 做法 | storm-day | storm-sc-low | tw-squall | storm-graze | 结果 |
| --- | --- | --- | --- | --- | --- | --- |
| ① | 砧盾视线判断用 CPU 拟合的**外接椭圆**（`uShieldEll`，面积约为旧外接圆的 0.29）× 砧的高度层求交；`cloudRayNearWeather` 也按「椭圆 × 高度层」判（旧版只看圆） | ×0.88 | ×0.88 | ×1.00 | ×1.00 | **保留** |
| ④ | 单体常量搬 uniform：砧盾半轴 / 弯曲 / 塔顶 O（`uShieldP/Q`）、主塔种子与伴生塔数（`uStormSd`）、伴生塔轴 / 塔顶 / 半径 / 种子（`uSatA/B`）；去掉 anvilShield、anvilShadowOD、stormTowersSdf 里逐样本的哈希与三角函数 | ×0.936 | ×0.935 | ×0.904 | ×0.942 | **保留** |
| ②a | 砧盾段空白步：只查占据网格的小循环（采样点、步长逐一与完整步进相同） | ×1.17 | ×1.17 | ×1.09 | ×1.16 | 撤回（更慢） |
| ②b | 层外样本延后算塔脚加云量（等价） | ×1.10 | ×1.11 | ×1.08 | ×1.11 | 撤回（更慢） |
| ③ | 精简密度（受光）里伴生塔改包络 | 上限 ×0.98–1.00 | ×0.97–0.98 | ×0.87–0.91 | ×1.00–1.01 | 不做（见下） |
| ⑤ | 砧影 anvilShadowOD 粗判 | 上限 ×1.000 | ×0.997 | ×1.004 | ×0.992 | 不做（整项删掉都不省） |

- ①的数是「最终版 ÷ circ 变体」。②③⑤ 那几行是在种子修正（见「坑」）之前、另一套伴生塔几何上量的：变快 / 变慢的方向与量级可信，具体百分比仅作参考。
- ①④ 合计（最终版对 master）：day ×0.821、sc-low ×0.822、squall ×0.900、graze ×0.943（`handoff/PERF-TW04-final-variants.json`；其中 `circ` 变体把椭圆换回外接圆 = 只有 ④：×0.936 / 0.935 / 0.904 / 0.942，①的份额由两者之比得出）。
- ②③⑤ 的「上限」是整项撤掉（画面会错）量出来的：`PERF-TW04-diag-variants.json`、`PERF-TW04-s4-variants.json`、`PERF-TW04-sq-variants.json`。②的上限（整段砧盾段不走）只有飑线约 ×0.90，其余 ≤ 1%；做成等价写法反而 ×1.1–1.17（FXC 分档，与 PERF-STORM 在台风变体里见到的同一类）。占据网格的粗 mip 不能用来大跳：R8 按 2×2×2 平均，mip 3 起孤立有云格点被舍入成 0。
- ③：GPU 上限在三个单体场景里没有收益甚至变慢（FXC 分档），只有飑线 −9~13%；冷编译只有「精简密度里整个不要伴生塔」才省 12–18%，换成最便宜的包络 SDF（哪怕循环外只算一座最近的）也一点不省；而整个不要会让伴生塔失去自遮挡（背光面发亮），按「看得见的优先」不做。

### 冷编译（离线 FXC，按最小值；CPU 8–21%）

| 程序 | TW04 前 | master | 本分支 | 对 TW04 前 | 对 master |
| --- | ---: | ---: | ---: | --- | --- |
| cloud-march-storm | 4433 | 5846 | 5508–5518 | +24% | −5.6% |
| cloud-march-severe | 14430 | 17072 | 16572–16976 | +15% | −0.6% |
| cloud-occupancy | 2560 | 3098 | 2957–2993 | +17% | −4.6% |
| cloud-shadow-map-weather | 2431 | 2701 | 2575–2582 | +6% | −4.7% |
| cloud-probe-weather | 778 | 1022 | 937–939 | +21% | −8.3% |

归因（`shader-budget --variants handoff/PERF-TW04-fxc-variants.mjs`，相对本分支）：精简密度里整个不要伴生塔 −18%（见 ③，不做）、主步进不算砧盾 −11%、不算砧影 −4%、不算塔脚加云量 −2%、去掉已关掉的幞状云代码 −2~3%（噪声量级；留给 SPEC-PILEUS 处理）。

## 画质对照（`dev-browser ab --cloud-live --rounds 2`，对 master，整图，差异 0–255）

| 场景 | 本分支对 master mean / max | 噪声底（同代码两轮）mean / max | 亮度 old → cur |
| --- | --- | --- | --- |
| storm-day | 0.082 / 84 | 0.059 / 60–64 | 142.22 → 142.23 |
| storm-sc | 0.181 / 54 | 0.10–0.13 / 44–50 | 150.88 → 150.92 |
| storm-sc-low | 0.464 / 98 | 0.29–0.38 / 75–95 | 122.50 → 122.50 |
| storm-graze | 0.188 / 42 | 0.17–0.19 / 43–46 | 155.57 → 155.58 |
| typhoon-outer | 0.020 / 73 | 0.035–0.039 / 57–73 | 相同（台风程序逐字不变） |
| tw-squall | 0.093 / 77 | 0.064–0.066 / 52–61 | 135.46 → 135.44 |

- 与噪声底同量级、略高（×1.3–1.6）的那一点来自**采样相位**：砧盾段的起点从外接圆收到椭圆，4 倍空步的网格整体挪了，最明显的是 storm-day 远处砧顶轮廓那一行像素（放大 8 倍的差分图里一条细线，原图并排看不出，`tmp/screenshot/ptw/q2/q-storm-day/crop-400-300.png`）。把椭圆放大到接近外接圆（半轴 ÷0.6）这条线就回到噪声底，单独放大沿风或横风半轴、放宽高度层都不行，说明不是椭圆漏了密度（单测也证明足迹全在椭圆里），而是软边稀薄处 2 倍步长的非线性让收敛值随相位略变。没有结构性差异（塔、砧、砧影位置与形状逐像素重合）。
- 飞行闪烁（`ab` 的 `live`，240 帧，阈值 16 级、帧占比 5%，`PERF-TW04-live-jobs.json`）：

| job | 区域 | old（master） | cur | cur2（噪声底） |
| --- | --- | ---: | ---: | ---: |
| storm-day | 砧 / 塔身 / 云海与塔脚 | 1 / 8 / 2 | 0 / 4 / 1 | 2 / 4 / 2 |
| storm-sc-low | 砧 / 塔身 / 云海 | 10 / 1829 / 3340 | 21 / 1458 / 3617 | 56 / 1309 / 3615 |
| tw-squall | 砧盾 / 塔 | 5 / 8 | 4 / 9 | 1 / 23 |

## 踩到的坑（已写进 README 云坑点「雷暴天性能回收」）

- **stormHash22 是混沌哈希，CPU 上模拟不出来**。第一版在 JS 里按 `Math.fround` 逐步模拟种子，伴生塔数量 / 位置整个换了一套、砧盾半轴也不对（椭圆可能包不住足迹），ab 对 master 差 1.2 级（噪声底 0.05），一看截图伴生塔挪了。**这之前量的 ①④ gpu-ab 数全部作废**（是另一套几何），上表是改正后重测的。修法：`clouds.ts` 的 `STORM_SEED_FRAG` 用同一段 `STORM_HASH22_GLSL` 文本在 GPU 上算 5×4 个种子、单体半径 / 砧顶变化时同步读回（`Clouds.updateStormSeeds`，一次几十微秒）。识别：把着色器里的计算挪到 CPU 后，同页 ab 对 master 出现结构性差异而不只是边缘噪声。
- **等价改写也可能更慢**：②a / ②b 都是逐位等价的改写，却让雷暴云步进 ×1.1–1.17；③的包络 SDF 只多一次无纹理的 SDF，冷编译就一点不省。改雷暴程序一律 gpu-ab 整体对照、shader-budget 交替测，不凭直觉。
- 测量锁被别人的 shader-budget 连续抢到（「前面没有别的等待者」但每 15 s 才重查一次，对方每轮重新取锁），排了约 10 分钟。

## 没做 / 剩下的

1. 飑线整帧仍是 TW04 前的 ×1.31（14.3 ms，229% 帧预算）：拆分（`PERF-TW04-sq-variants.json`，对本分支）砧盾段空步约 10%、精简密度里的伴生塔约 9.5%、乳状云约 8%、砧盾密度本身 ≈ 0。剩下的都要改画面或另建结构才能省：例如占据网格建一张「砧盾每列上下界」的 2D 图让砧盾段按列跳（新程序、新纹理，要算冷编译账），或飑线的伴生塔减为每单体 2 座。
2. 冷编译 cloud-march-storm 仍比 TW04 前 +24%：大头是砧盾在主步进里（−11%）与精简密度里的伴生塔（−18%，去掉会失去自遮挡）。都不在启动关键路径（天气变体后台编）。
3. 单体半径 / 砧顶变化时有一次同步 readPixels（5×4 像素 RGBA32F）；需要 `EXT_color_buffer_float`（WebGL2 桌面端都有）。

## 复现

```bash
# apps/voyage 下；5298 = 本分支，5371 = master，5372 = TW04 前（3edb28c）
node scripts/dev-browser.mjs gpu-ab --port 5298 --base 5371 --jobs apps/voyage/handoff/PERF-TW04-scenes-jobs.json --variants apps/voyage/handoff/PERF-TW04-final-variants.json --rounds 8 --n 20 --time clouds
node scripts/dev-browser.mjs gpu-ab --port 5298 --base 5372 --jobs apps/voyage/handoff/PERF-TW04-frame-jobs.json --variants apps/voyage/handoff/PERF-TW04-pre-variants.json --rounds 8 --n 20 --time frame --viewport 2560x1300 --dpr 1.5
node scripts/dev-browser.mjs ab --port 5298 --base 5371 --jobs apps/voyage/handoff/PERF-TW04-q-jobs.json --rounds 2 --cloud-live --out tmp/screenshot/ptw/qf
node scripts/dev-browser.mjs ab --port 5298 --base 5371 --jobs apps/voyage/handoff/PERF-TW04-live-jobs.json --rounds 1 --cloud-live --out tmp/screenshot/ptw/live
node scripts/shader-budget.mjs --baseline <TW04 前的 apps/voyage> --only cloud-march-storm,cloud-march-severe,cloud-occupancy,cloud-probe-weather,cloud-shadow-map-weather --rounds 3
node scripts/shader-budget.mjs --variants handoff/PERF-TW04-fxc-variants.mjs --only cloud-march-storm --rounds 2   # 会改源文件，先停本 worktree 的开发服务器
node --experimental-transform-types --no-warnings scripts/storm-shield.test.mts   # 椭圆包住足迹的单测
```
截图 / 数据：`D:\Code\opus-test\.claude\worktrees\agent-ab549aa4e779753f5\tmp\screenshot\ptw\`（q / q2 / q3 / qf / live），日志 `D:\Code\opus-test\tmp\ptw-*.log`。
