# NIGHT-AP-1 · 空气透视 LUT 纳入月光（交付）

分支 `worktree-agent-a0e48ac5dbcc6dee8`，依据 `research/NIGHT_AP.md` 推荐方案 A。环境：RTX 5090，ANGLE d3d11 硬件渲染（每个脚本都核对了 `GL_RENDERER`），1600×1200，画质 high，URL 带 `voyage=0`，测量全程持测量锁。

## 改了什么

- `src/atmosphere/luts.ts`
  - `AERIAL_FRAG`：新增 `integrateSegment2`（两路光源同一个积分循环，介质 / 透射率共用，各自相函数、到光源透射率、多次散射相加，次要光源乘 `uApSecondScale` 换到主导光源的单位）。`uApSecondLocal.w > 0.5` 才走它，否则仍是原来那一行 `integrateSegment`。
  - `updateAerialPerspective(camR, sunDir, sunKlux, moonDir, moonKlux)`（改签名）：两路估计 = 照度 × 地平线天光系数（`HORIZON_SKY_LOG10`，38 个高度角 × 4 个海拔的实测表，`handoff/NIGHT-AP-1-sky-scale.mjs` 量的：天空视图 LUT 地平线上第一行所有方位亮度均值），谁大谁主导，25% 回差；另一路 < 主导的 1e-3 不积分。主导方向 / 照度写进 `sharedUniforms.uApDir / uApIlluminance`；次要光源转到主导方位系，放在 LUT 存的 z ≥ 0 半边。
  - 调试：`apState`、`apMoon`（false = 改前）、`apForce`。
- `src/atmosphere/common.glsl.ts`：`ATMOSPHERE_COMMON` 声明 `uApDir` / `uApIlluminance`（未用的程序被驱动剔除）。
- `src/main.ts`：月光照度提前到空气透视更新之前算（原来 529 行那三行挪上去），调用改签名。
- 消费方只换 uniform 名（不重排）：`clouds/clouds.ts`（台风分段、合成两处，`hurricaneSunVis` / `HUR_BACKLIT_AP_CUT` 仍按太阳）、`clouds/far-towers.ts`、`render/terrain-shading.glsl.ts`、`rail/far-view.glsl.ts`、`render/outside-pass.ts`、`render/optics.glsl.ts`、`render/wonder-sky.glsl.ts`、`wonders/pillars.glsl.ts`、`render/traffic.glsl.ts`（研究没列，也在查这张表）、`wonders/ring.glsl.ts`（合并 master 后 WS08 新加的消费方）。另改了 clouds.ts / far-towers.ts 各一行过时注释。
- `scripts/lint-shaders.mjs`：新检查「空气透视 LUT 的查法」——任何程序代码行里用 `uSunDir` 调 `aerialPerspectiveUvw`、或 `uAerialInscatter*` × `uSunIlluminance`，`check:glsl` 直接 FAIL（研究漏列 traffic、WS08 并行新加 ring，说明这条要自动拦）。
- `README.md`：大气与曝光新增坑点一条；T48 那条的「满月远云棕红」移到「已推翻」并写清错在哪。
- 需要协调者接入的代码：无（uniform 走 `Atmosphere.sharedUniforms`，scene.ts 不用动）。

## 验收（研究 §4 表）

同页冻结 A/B（`handoff/NIGHT-AP-1-run.mjs`，场景与 ROI 同研究；`base` = `atmosphere.apMoon = false`，逐位等价改前；`noAP` 取掩膜）。截图：`tmp/screenshot/NIGHT-AP-1/{behind,front,nomoon}/`（worktree 下），地平线放大 `behind/zoom_base_new_noAP.png`、`front/zoom_base_new.png`。

| 项 | 门槛 | base（改前） | new | 判定 |
| --- | --- | --- | --- | --- |
| behind 远砧 L / 地平线天空 | 1.0–1.6 | 0.0105 / 0.0224 = 0.47 | 0.0299 / 0.0224 = **1.33** | 过 |
| behind 远砧 HDR 饱和 | ≤ 0.4 | 0.96 | **0.33** | 过 |
| behind 远砧屏幕 | 色相 180–250° 或 max−min ≤ 8 | 21/14/13（11°） | **56/56/59**（234°，max−min 3） | 过 |
| behind 远塔塔身 | — | 0.27 倍、10/7/8 | 1.14 倍、48/52/56 | — |
| behind 地平线远云带 | ≥ 0.9 倍天空 | 0.41 | **1.08** | 过 |
| behind 近处云屏幕 R ≤ B | | 37/38/38（143°） | **48/51/55** | 过 |
| front 远云带饱和 | ≤ 0.45 | 0.71 | **0.39** | 过 |
| front 远云带屏幕 R − B ≤ 3 | | 30/25/23（+7，橙褐） | **46/45/47**（−1） | 过 |
| nomoon | ≤ 1 级 | — | 主导仍是太阳、不积分次要光源，所有 uniform 与 base 相同 → 按构造逐位相同；截图 base↔new 差（平均 0.0035）与 base↔base2 噪声底（0.0043，cloudLive）同量级 | 过 |

白天逐位不变（`handoff/NIGHT-AP-1-parity.mjs`：同页冻结，把所有带 `uApDir` 的程序换回改前写法、LUT 程序去掉两路分支，逐 texel / 逐 float 比较空气透视 LUT 两张图、固定 uFrame 手动步进一次的云 raw（含远塔层）、hdrOutside；正对照（LUT 采样数 24→23、照度 ×1.001）能量出 19 万 / 73 万 / 92 万个差）：

| 场景 | 太阳 | LUT 内散射 / 透射率 | 云 raw | hdrOutside |
| --- | --- | --- | --- | --- |
| noon-cumulus、storm-day、typhoon-eye、fuji-day、rail-oito-default、ws-pillars-noon、wonder-jianmu-day、bow-rain、night-city | 70° … −49° | 0 / 0 | 0 | 0 |
| sunset-wing（+1.2°）、night-sea-milkyway | | 0 / 0 | 0 | 0（第二次跑四次快照：cur/old/cur2/old2 全 0） |
| dusk-earthshadow（−4.7°） | | 0 / 0 | 0 | 相邻的 cur2↔old2 为 0；cur↔old 的差与 old↔old2 同量级，是这个场景冻结后 hdrOutside 自己在漂（与改动无关） |

暮光切换（`handoff/NIGHT-AP-1-twilight.mjs`，满月 2026-07-29 南海右座航向 225°、窗朝西北正对余晖，时间 ×40 live 不冻结，逐 rAF 读回窗区）：太阳 −6° 时已在积分月亮那一路（比值 1.7e-3）；主导在太阳 **−12.28°** 换成月亮（月亮 +11°），**那一帧窗区亮度变化 0.032 级**，前后 ±40 帧的帧间变化中位 0.028、p95 0.036——看不出。切换时刻冻结强制两种主导各拍一张：整窗均值差 0.08–0.12 级（噪声底 sun↔sun2 0.005），就是镜像误差的量级。截图 `tmp/screenshot/NIGHT-AP-1/twilight-225/`。

冷编译（`shader-budget --baseline tmp/nap-base/apps/voyage --rounds 2`，min）：outside-default 5960 → 6061 ms（+1.7%）、cloud-march 498 → 499（+0.2%）、far-towers 588 → 593（+0.9%），都在噪声内；`atmosphere-aerial` 110 → 222 ms（+0.11 s，小程序、不在关键路径）。

GPU（`gpu-ab --time frame`，8 轮 ABBA 带 A/A）：twilight-10（太阳 −10°、两路都在积分）new 6.33 / old 6.38 ms，×1.007 [0.97, 1.06]，A/A ×0.987；night-sea-fullmoon new 2.43 / old 2.34，×0.971 [0.93, 1.00]，A/A ×0.934——都在离散度内。LUT pass 单测（`handoff/NIGHT-AP-1-lut-cost.mjs`，40 次均值 8 轮）：单路 0.115 / 0.103 ms，两路 0.102 ms，测不出差。

NIGHT-AP-2（`dev-browser ab`，`handoff/NIGHT-AP-1-ab-jobs.json`，同页冻结 old/new，噪声底 0）：
- 富士满月（2026-01-03 21:00，10.7 km）：远山从黑剪影变成淡蓝灰、融进地平线（`tmp/screenshot/NIGHT-AP-1/ab2/fuji-high-side.png`），整图亮度 26.3 → 31.1；4 km 夜城同样变亮（30.7 → 34.9）。不需要另补气辉。
- 火车满月（oito，2026-07-29 22:00）：变化很小（平均 0.11 级、最大 8），地面视角距离短、窗外被舱内灯的曝光压着，远景云略少了一点暖色（`ab2/rail-side.png`）。火车远景本来就看不出暗红剪影。

其他：typecheck、check:glsl（全部通过，含新检查）、`pnpm --filter voyage build`、`find dist/assets -type f -size 0` = 0、`dev-browser check` 控制台 0 error；每个测量脚本里页面错误都是 0。

## 遗留 / 给审查

- 镜像误差：暮光里次要光源的方位结构（太阳余晖、月亮的前向散射）在主导光源竖直面另一侧是镜像的。切换帧 0.1 级，看不出；如果以后要更准，方案 B（两张 LUT）是退路。
- 主导切换点用的是「地平线天光均值」，偏向前向散射峰；满月下切换在 −12° 附近（研究按中位数估 −9°），只影响镜像误差落在哪一侧。
- 前方远云带屏幕 46/45/47，研究提到的「略带紫」这次读成中性（色相 270° 但 max−min 只有 2）。
- NIGHT-AP-3（T48 保色门限下沿 −2.0）未动，理由已失效，见 README。
- 对照 worktree `tmp/nap-base` 交付前已删。复现脚本都在 `handoff/NIGHT-AP-1-*`（用法见各文件头；分析：`python handoff/NIGHT-AP-1-analyze.py <目录> handoff/NIGHT-AP-1-rois-behind.json base,new,noAP,new2`）。截图在本 worktree 的 `tmp/screenshot/NIGHT-AP-1/`（已忽略）。
