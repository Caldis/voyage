# 关键参数表（DX-09）

给新任务 / 审查代理快速核对「这个数字现在到底是多少、定义在哪一行」用，不追求覆盖所有常量，只收录经常被问起、或改错了会引发坑点的那一批（视场、分辨率、clipmap、LUT、相机高度、云缓冲、奇观距离……）。
每行注明出处文件与行号；行号会随代码变动漂移，若对不上以 `git grep` 实测为准，发现漂移顺手改一下本表。「物理量 / 取舍」一列标出这个数字是有物理依据的量，还是纯粹的观感取舍（取舍类改了不需要论证物理正确性，改了要不好看即可）。

| 参数 | 当前值 | 出处（文件:行） | 物理量 / 取舍 |
| --- | --- | --- | --- |
| 视场（垂直半视场） | `tan(25°)`（垂直半视场 25°，全视场约 50°） | `src/render/scene.ts:379`（`uTanHalfFov`） | 取舍——窗洞开口 34×47 cm 在这个视场下窗框基本看不见，是「额头贴窗」的取景角度，见 `src/view-presets.ts:32` |
| 分辨率 / DPR 默认 | 画布像素 = 视口像素 × `min(devicePixelRatio, dprCap)`；默认档 `dprCap = 1.5` | `src/main.ts:38`（初始 `setPixelRatio`）、`src/quality.ts:31,41`（`LEVELS[0].dprCap` / `DEFAULT_DPR_CAP`） | 取舍——高刷新率高分屏上限流，防止画质自动档一路砸到最低还不够；`scripts/dev-browser.mjs` 的 `shots`/`cold`/`bench` 默认视口 1600×1200（见 README「调试与验证」） |
| 画质档位 | 高（云步进分辨率 ×1、`dprCap 1.5`）/ 中（×0.75）/ 低（×0.5）/ 最低（×0.5 + `dprCap 1.0`，仅自动档可达） | `src/quality.ts:30-35`（`LEVELS` 数组） | 取舍——手动三档只能选前三个，自动档按 GPU 计时（`EXT_disjoint_timer_query_webgl2`）或帧间隔升降，见同文件 `decideByGpuTime` / `decideByFrameInterval` |
| clipmap 级数与最细分辨率 | 7 级，边长 8 → 512 km（每级 ×2）；最细一级 8 km / 1024 px ≈ 7.8 m/像素；影像 / 水体纹理 1024²，地形高度纹理 256² | `src/ground/clipmap.ts:15-18`（`GROUND_LEVELS` / `GROUND_BASE_KM` / `RES` / `HRES`） | 取舍——按巡航高度地平线约 370 km 反推的覆盖范围，最细一级对齐 Sentinel-2 原生约 10 m 分辨率（同文件第 14 行注释） |
| LUT 尺寸与范围 | 透射率 256×64；多次散射 32×32；辐照度 64×16；天空视图 192×108；空气透视 32×64×32（最远 400 km） | `src/atmosphere/common.glsl.ts:7-16`（`LUT_SIZE` / `AERIAL_MAX_DISTANCE_KM`） | 取舍（尺寸）+ 物理量（覆盖范围按巡航高度地平线距离定）——天空视图 / 空气透视 LUT 要用 32 位浮点，见坑点「精度」（T36） |
| 相机高度范围（飞机） | 面板滑块 0.5–13 km，默认 10.7 km；海面最低 0.5 km，陆地按「周围格子最高点 + 2.5 km」动态抬高下限 | `apps/voyage/index.html:113`（`#altitude` 滑块）、`src/flight.ts:175-176`（`FLOOR_SEA_KM` 等，陆地下限逻辑见同文件 `updateAltitudeFloor`） | 取舍（滑块范围）+ 物理量（陆地下限按地景可用分辨率算，见文件头注释「地景从更低处看会露馅」） |
| 相机高度范围（火车） | 眼高固定约 2.5 m（离轨面）、横向偏移 0.95 m（靠窗座位）；巡航速度 90 km/h；台车轴距 13.8 m | `src/rail/train.ts:15,18,20,22`（`CRUISE_KMH` / `BOGIE_SPACING_M` / `EYE_HEIGHT_M` / `EYE_LATERAL_M`） | 物理量（估算）——`EYE_HEIGHT_M` 注释：地板面约 1.1–1.2 m + 坐姿眼高约 1.2–1.3 m；坡道上受 float32 精度限制会有约 0.5 m 台阶，见坑点「火车」 |
| 云缓冲分辨率 | `(视口宽 × DPR × 云画质系数) × 2`（history 缓冲两倍宽）× `视口高 × DPR × 云画质系数` | `src/clouds/clouds.ts:1304-1311`（`setSize`） | 取舍——两倍宽是 T38 加的深度打包（左半颜色、右半 `深度×不透明度, 不透明度`），见坑点「云缓冲格式」；云画质系数即上面「画质档位」的 `cloudScale` |
| 奇观距离范围 | 天梯 330–410 km；建木 340–410 km；雾海灯城 70–130 km；浮空古城 75–130 km；（调试用 `w00-probe` 60–120 km，不进随机挑选，仅 `__voyage.wonders.trigger` 召唤） | `src/wonders/catalog.ts:96,121,139,157,190`（各条目 `distanceKm`） | 取舍——按「肉眼能分辨的角尺寸 / 简化模型露馅的阈值」反推，方法同 T40 交通工具（见坑点「预算内的简化交通工具模型」） |
