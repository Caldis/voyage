# PERF-10 + PERF-11 · 冷编译回收（交付）

- 分支 `worktree-agent-a48b777328a0e36f1`，端口 5210，对照 5270（`D:\Code\opus-test\tmp\perf10-base`，master `3168382` 的 detached worktree，src 与当前 master 相同）。
- 状态：**已完成**，已合并最新 master（DX-10）。必审（跨模块契约：云缓冲右半语义变了；新增程序 / 变体；碰了 main.ts）。

## 改了哪些文件

| 文件 | 改动 |
| --- | --- |
| `src/clouds/clouds.glsl.ts` | 雷暴密度（塔、砧、乳状云、雨幡、精简版）进 `#ifdef CLOUD_STORM`；台风（眼壁、雨带、卷云盖、大形、层状云遮罩）进 `#ifdef CLOUD_TYPHOON`；两者共用（占据网格查询、gWeatherOn、gStormW/AO/Soft、stormHash22、sminStorm、gLightLen）进 `#ifdef CLOUD_WEATHER`。`cloudDensity` / `cloudDensityLite` 按宏分段。新 uniform `uCloudDepthOn`，`cloudBufferDepth` 在它为 0 时返回 0 |
| `src/clouds/clouds.ts` | MARCH_FRAG：细化、天气受光步进、闪电、台风长影 / 体积阴影 / 眼里互照 / 下方反射等按宏分开，默认程序只剩普通云路径；变体管理（`marchVariants`、`pickMarch`、`requestMarch`、`prewarmWeather`、`prepareWeather`、`cloudVariantPending`、`variantStatus`）；占据网格只有天气版、移出启动批次；云影图 / 探针各加天气版；RESOLVE_FRAG：`texelFetch`、窗板外提前退出、右半按需（scissor + `uResetDepth`） |
| `src/director.ts`（1 个可选方法） / `src/weather-director.ts`（2 行） | `DirectorHost.weatherReady?(kind)`：摆雷暴 / 台风前预告，没编好就推迟摆放 |
| `src/main.ts`（1 行） | 导演 host 接 `weatherReady: (kind) => clouds.prepareWeather(...)`。启动批次仍是 `...clouds.compileTargets()`，没改 |
| `scripts/lint-shaders.mjs` | 登记 cloud-march-storm / -typhoon / -severe、cloud-shadow-map-weather、cloud-probe-weather、cloud-occupancy（天气版）；`check:glsl` 另外校验 CS / CT / CST / WCS / WCT / WCST 组合（shader-budget 不带这些）；老树（lenient）没有 `marchVariant` 时跳过 |
| `scripts/scenarios.mjs` + `regression.playwright.js` | `applyScene` 在 js 之后等 `clouds.cloudVariantPending` 变 false（最多 120 s） |
| `scripts/passes.mjs` | `cloud-march*` 材质名归「云步进」/「云步进(卷云变体)」/「云步进(奇观变体)」（和 master 可比）；`#define` 归类改看 `material.defines` 而不是源码文本（PERF-10 后每个云程序源码里都有 `CLOUD_STORM` 字样） |
| `README.md` | 速查表两行（云缓冲右半按需、天气变体规则），坑点：着色器编译 1 条、云 3 条 |
| `research/PERF_REPORT_wave6.md` | 末尾「九、账本追加：PERF-10 后」 |
| `handoff/PERF-10-*.{mjs,sh}` | 预处理检查、截图、求差矩阵、真冷启动交替、帧时间（编译期间）、按 pass 汇总 / 重复、卷云变体归因 |

## 变体表（云步进，键 = 特性字母：W 奇观层、C 卷云、S 雷暴、T 台风；W 总带 C）

| 键 | 何时编 | 何时画 | 离线 FXC（最小） |
| --- | --- | --- | --- |
| `""` 默认 | 启动批次 | 晴天 / 普通云；其他变体没编好时的兜底 | 0.49 s（原 13.7 s） |
| `S` 雷暴 | 启动后第 60 次 probe（约 1.5 s）后台预编；导演预告 / 场上出现雷暴时立即 | 有雷暴 | 3.9 s |
| `T` 台风 | 同上 | 有台风 | 7.3 s |
| `ST` | 雷暴、台风同时在场时按需 | 同时在场 | 13.5 s |
| `C` 卷云 | T12 原节奏（要画卷云时，或启动后 300 次 probe） | 云型 < 0.2 | 0.59 s（原 17.3 s） |
| `WC` 奇观 | W00 原节奏（奇观在场 / `wonderPrewarm`） | 云间层奇观在场 | 0.68 s（原 15.1 s） |
| `CS` `CT` `CST` `WCS` `WCT` `WCST` | 真出现这种组合时按需 | 对应组合 | 未测（≈ 天气版 + 0.1–1 s） |

小程序：占据网格（只有天气版，2.4 s）、云影图（默认 0.19 s / 天气版 2.4 s）、探针（默认 0.15 s / 天气版 0.76 s），天气版和 S、T 一起预编（`weatherAuxState`）。

**组合矩阵的取舍**：不预编组合，只预编 S、T（导演最常摆的两种）。组合按需编，编好之前按权重（T 8 > S 4 > W 2 > C 1）画「已编好的、权重最大的子集」：卷云 × 雷暴时卷云暂时画成普通层状云；奇观 × 雷暴（例如奇观之门的云墙）时奇观暂时不画；雷暴 + 台风时雷暴暂时不画。实际航程里组合很少（天气场的雷暴 / 台风与卷云层同时出现、奇观之门），代价是那一次多编 5–15 s 后台编译。

## 触发与过渡策略

1. 启动：只编默认版（+ resolve、默认云影图）。首帧后约 1.5 s 开始后台预编 S、T 与天气小程序（冷缓存下雷暴约 5 s、台风约 9 s 编好；`handoff/PERF-10-hitch.mjs` 实测编译期间最长帧 50 ms、无 > 50 ms 的帧，与 master 同期 37–50 ms 相当）。
2. 导演（连续航程）：`planStorms` / `planTyphoon` 摆放前问 `host.weatherReady(kind)`，没编好就这次不摆（顺带触发编译），下次规划再问；摆放本来就在视野外 / 遮挡下，推迟几秒看不出来。
3. 面板手选 / 调试脚本直接放天气：`Clouds.render` 每帧 `pickMarch`，想要的变体没编好就后台编，期间画默认版（普通云照常，雷暴 / 台风暂不出现），编好下一帧换上。实测「启动后立刻切雷暴」：5.2 s 后雷暴出现，期间最长帧 50 ms（`--early`）。
4. 云影图：有天气且天气版编好才用天气版，换程序时按分片节奏（16 帧）重建，不做整张一帧重建。
5. 一打开就有雷暴 / 台风的入口（目前没有）：`compileTargets()` 会把对应变体和天气小程序放进启动批次。

## 数字（d3d11，RTX 5090，1600×1200；测量时机器上有别的代理，两侧交替同轮比）

- **真冷启动**（交替 5 轮）：15.9 / 16.2 s（最小 / 中位），master 21.2 / 22.1 s，**−26%**。批次 18.4 → 13.4 s，首帧 1.2 → 0.55 s。**没到 12–13 s**：关键路径换成了窗外程序（离线 9.0–10.6 s），见 PERF_REPORT §九，下一步 PERF-13。
- **离线 FXC**：见上表与 PERF_REPORT §九。
- **帧时间**（passes 中位，本分支 / master）：resolve **0.025–0.040** / 0.068–0.115（≤ 0.05 达标）；云步进 noon 0.312 / 0.324、sunset 0.333 / 0.348、storm-day 1.36–1.43 / 1.38–1.48、typhoon-eye 2.16 / 3.20、typhoon-bands 2.49–2.53 / 2.20–3.93（两档）、typhoon-outer 1.74–1.76 / 1.91–2.37、fuji-day 0.325 / 0.420、night-city 0.664 / 0.710、奇观变体 0.260 / 0.406。cirrus-noon 跨页面位置不同不可比，同位置页面内：0.46（本分支）/ 0.65（加回雷暴 + 台风代码 = master 的卷云变体）。
- **零回归**（`PERF-10-shots.sh` 冻结 + settle + 写死 offset；`PERF-10-matrix.mjs` 两两求差，均值/255）：所有 11 个场景「本分支 vs master」都落在「同代码两次」范围内，例如 storm-day 0.32 对 master-master 0.42，typhoon-eye 0.29 / 0.65，fuji-dawn-c30 0.57 / 0.58，cirrus-noon 0.75 对本分支两次 0.67，wonder 1.99 对本分支两次 1.00（差异是随机航迹云与云纹理的逐帧抖动，热图无结构性差异，`tmp/screenshot/PERF-10/cmp-wonder.png`）。第一轮没写死 offset 时 cirrus / wonder 差 5–7，是飞机位置不同（README 新坑点）。
- `check:glsl` 全部通过（40 个程序），typecheck / build 通过、`dist/assets` 无 0 字节文件，截图期间无 console error。

## PERF-11 细节

- 右半（深度）启用条件：`uGroundOn > 0.5 && uTerrainMax > 0.05 km`（附近有高出海面的真实地形）。停用时 resolve 用 scissor 只画左半，`uCloudDepthOn = 0`，窗外 `cloudBufferDepth` 返回 0（= 云都在地面之前，`cloudBeforeGround` 原样保留）；重新启用那一帧右半不取历史（`uResetDepth`）。
- **深度没有改半精度**：右半和左半同在一张纹理里（T38 为了不给窗外程序多占 sampler），一张纹理只能一种格式；改半精度就要单独一张纹理 + 窗外多一个 sampler（14/16 → 15/16），不划算。真正的大头是邻域夹取对 RGBA32F 的 `texture()` 过滤读：改 `texelFetch` 后 resolve 已在 0.025–0.040 ms。T38 审查提到的精度保护（`max(d.y, 1e-4)`、按不透明度加权）都保留。
- 窗板外 `paneDistance > 0.025` 直接写 (0, 0, 0, 1)：步进在 > 0.02 处只写这个值，邻域全是它时夹取结果恒为它，逐位不变。

## 返工（审查 `handoff/PERF-10-review.md`，2026-09-27 夜）

1. **选变体收敛成一个函数** `wantedKey(extra)`：步进（`pickMarch`）和导演预告（`prepareWeather`）都用它。预告按完整键（含卷云 C / 奇观 W）`requestMarch`，并等天气小程序 ready / failed 才返回 true。
2. **云影图 / 探针的天气版跟步进实际画的变体走**（`weatherAuxOn()` = 天气小程序 ready 且 `marchShown` 含 S / T）。云影图换程序时丢掉正在分片建的那张，从第 0 片重建。
3. 卷云 / 奇观在场时，预编阶段顺带编 `CS` / `CT`（或 `WCS` / `WCT`）。
4. 变体、天气小程序编译失败时 `console.warn` 一次。
5. PERF-11 深度：相机低于 1 km（火车 TR03、起降）时也开（`DEPTH_LOW_CAMERA_KM`）。
6. `check:glsl` 新增断言：cloud-march / -cirrus / -wonder / cloud-shadow-map / cloud-probe / outside-default / wing 用 glslangValidator `-E` 预处理后不含雷暴 / 台风函数名。
7. 已合并最新 master（TR03 等），check:glsl 41 个片元程序全部通过，typecheck 通过。

验证（`handoff/PERF-10-combo.mjs --port 5210`，冷缓存、按导演流程「预告到 true 再摆放」，摆放后逐帧比 shown / wanted 180 帧）：
- 卷云在场 + 摆雷暴：预告等 5.6 s，摆放后 shown = wanted = `CS`，0 帧不一致；撤掉后回到 `C`。
- 奇观（浮空古城）在场 + 摆台风：预告等 8.5–9.5 s，摆放后 shown = wanted = `WCT`，0 帧不一致；撤掉后回到 `WC`。
- 零回归复拍（n5）：11 个场景对 master（b3）、对返工前（n4）都在噪声底内。

## 已知问题 / 没做的

1. 冷启动 16 s 不到 12–13 s：窗外程序是新的关键路径（PERF-13）。
2. 默认云步进里还剩 `uStormCount` / `uHurricane` 的 uniform 声明、`anyWeather` 判断和循环上界的 `min(uStormCount, 0)` 防展开，没有任何雷暴 / 台风的密度 / 光照代码（`PERF-10-preproc.mjs`）。
3. 组合变体（CS、WCS…）没做离线 FXC 计时，只做了语法检查。
4. 面板手选雷暴 / 台风、变体没编好时没有「（准备中…）」提示（main / ui 不在归属，舱等那样的提示可以照抄：`clouds.variantStatus.shown !== wanted`）。
5. passes.mjs 的 `--variants` 在同一材质上连续换程序时「程序缓存数没有增加」的警告会误报（本次三个变体都真的换了、数值也变了），DX 可以查。

## 怎么复现

```bash
# 开发服务器（worktree 里）
pnpm --dir apps/voyage exec vite --port 5210 --strictPort --host 127.0.0.1
node apps/voyage/handoff/PERF-10-preproc.mjs                       # 各程序预处理后含不含雷暴 / 台风代码
bash apps/voyage/handoff/PERF-10-shots.sh 5210 tmp/screenshot/PERF-10/n  # 零回归截图（对照端口同样跑两次）
node apps/voyage/handoff/PERF-10-matrix.mjs tmp/screenshot/PERF-10 b1 b2 n1 n2
bash apps/voyage/handoff/PERF-10-cold.sh 5210 5270 5 tmp/perf10/cold
node apps/voyage/handoff/PERF-10-hitch.mjs --port 5210 [--early]   # 预编 / 第一次进雷暴台风的帧时间
node apps/voyage/scripts/shader-budget.mjs --only cloud-march,cloud-march-storm,cloud-march-typhoon --baseline <master 的 apps/voyage> --rounds 3 --wait-quiet --jobs 1
bash apps/voyage/handoff/PERF-10-passes-rep.sh 5210 5270 4 typhoon-outer,typhoon-bands,cirrus-noon,storm-day tmp/perf10/rep
node apps/voyage/scripts/passes.mjs --port 5210 --only cirrus-noon --variants apps/voyage/handoff/PERF-10-variants-cirrus.mjs --material clouds.marchCirrusMat --target clouds.raw
```
浏览器控制台：`__voyage.clouds.variantStatus`（各变体状态、想画 / 实际画、天气小程序、右半深度是否启用）。
