# PERF-10 + PERF-11 · 冷编译回收（进行中，WIP）

端口 5210，对照 5270（`D:\Code\opus-test\tmp\perf10-base`，master 的 detached worktree）。

## 已完成
- `clouds.glsl.ts`：雷暴密度全部进 `#ifdef CLOUD_STORM`，台风进 `#ifdef CLOUD_TYPHOON`，两者共用的（占据网格查询、gStormW、stormHash22、sminStorm、gLightLen）进 `#ifdef CLOUD_WEATHER`（JS 端有 S / T 时自动加）。
- `clouds.ts` MARCH_FRAG：细化、天气受光步进、闪电、台风长影 / 体积阴影 / 眼里互照等全部按宏分开；默认程序预处理后 598 行（severe 1381 行），只剩 uniform 声明和 `anyWeather` 判断（`handoff/PERF-10-preproc.mjs` 验证）。
- 变体管理：`marchVariants`（键 W/C/S/T），`pickMarch` 挑已编好的权重最大子集；启动后第 60 次 probe 预编 S、T 与天气版小程序（占据网格、云影图 / 探针天气版）；`prepareWeather` 给导演预告用（尚未接进 weather-director）。
- PERF-11：resolve 窗板外提前写 (0,0,0,1)；右半（深度）只在 `uGroundOn && uTerrainMax > 0.05 km` 时写（scissor），`uCloudDepthOn` 让窗外读深度时返回 0。
- `lint-shaders` 登记新变体（check:glsl 全部通过）；`scenarios.mjs` / `regression.playwright.js` 等 `cloudVariantPending`；`passes.mjs` 按材质名归类。

## 正在做
- 零回归：固定 offset 后（`handoff/PERF-10-shots.sh`、`PERF-10-matrix.mjs`），除 cirrus-noon、wonder-floatcity-day（都带 CLOUD_CIRRUS）外都在噪声底内；这两个与 master 稳定差 5–7/255，查原因中。

## 下一步
导演预告钩子、帧时间（passes）、真冷启动对照、离线 FXC、README 坑点、报告账本。
