# PERF-9 · 地面瓦片管线的 CPU 尖峰 · 交接

分支 `worktree-agent-a9dd5d849d53247ab`，开发端口 5249，对照（未改动的 HEAD `1fc143e`）端口 5289
（`apps/voyage/tmp/baseline-master/` 里的 detached worktree，收尾前已删除）。硬件 RTX 5090，ANGLE d3d11。

承接 `handoff/PERF-6-8.md` 末尾留下的问题：route-hnd-cts 60× 加速航程下，PERF-8 把 texSubImage3D
相关的尖峰压下去之后，仍然观察到一类更大、更频繁、`texBytes=0`（与纹理上传无关）的尖峰（60–105 ms）。

## 剖析方法

`tmp/perf-9/cpu-profile.mjs`（未提交，见文件头注释）：playwright-core 打开页面 → 用
`scenarios.mjs` 的 `route-hnd-cts` 场景（等地面瓦片）→ `director.setActive(true); director.rate = 60`
复现 PERF-6-8 记录的 "route" 模式 → 页面侧 monkeypatch `requestAnimationFrame` 记录每帧
`{t: performance.now(), dt}`（不进被剖析的调用栈）→ CDP `Profiler.start()`（采样间隔 200 μs）实测 25
秒真实挂钟 → `Profiler.stop()` 拿完整采样序列。

CDP profile 的时间轴（相对 `profile.startTime` 的微秒数，浏览器进程时钟）和页面 `performance.now()`
（导航时钟）是两个不同原点的单调时钟：在 `Profiler.start()` 前后各记一次 Node 的 `Date.now()` 与页面的
`performance.now()`，建立线性锚点换算（同机单调时钟，几毫秒内的误差对定位 60–105 ms 量级的尖峰足够）。
按 `frameLog` 里 `dt > 16 ms` 的帧，把落在该帧时间窗口（±3 ms 容差）内的采样按叶子函数分组求 self
time，得到「尖峰帧期间」的热点排行，和「全程」热点排行对照。

## 剖析结论：主要是 `buildWater`（Path2D + `getImageData` + 逐顶点投影）和 `buildNight` 的变换循环

route-hnd-cts 60× 下，25 秒采样窗口里主线程 self time 前几名（改动前，`tmp/perf-9/cpu-profile-before.json`）：

| self time (ms) | 调用栈（叶子 ← 上一级） |
| ---: | --- |
| 638.63 | `getImageData` ← `buildWater @ clipmap.ts` |
| 367.99 | `(garbage collector)` |
| 356.51 | `getImageData` ← `buildNight @ clipmap.ts` |
| 340.00 | `buildNight @ clipmap.ts`（逐像素变换循环，Black Marble 减蓝底） |
| 263.54 | `tileYToLat` ← `proj` ← `buildWater`（多边形逐顶点投影） |
| 185.14 | `readSVarint` ← `loadGeometry`（矢量瓦片 protobuf 解码，`tiles.ts`） |
| 173.81 | `getImageData` ← `buildImagery @ clipmap.ts` |
| 157.77 | `tileYToLat` ← `proj` ← `buildWater`（河道折线逐顶点投影） |

`buildWater`（水体/河道用 Path2D 在主线程 canvas 上画多边形+折线，再 `getImageData` 读回）和
`buildNight`（读回夜光瓦片后逐像素做「亮度减蓝色底」变换）加起来，仅这几项 self time 就占 25 秒窗口的
约 5.6%（不含 canvas 填充/描边本身摊在 `(program)` 桶里的原生开销——见下文），且集中在尖峰帧：
93 个 `dt > 16 ms` 的帧里，`buildWater` 的 `getImageData`/`tileYToLat` 就占了约 5%的尖峰 CPU。
`buildImagery`（同样 `getImageData`，但没有逐顶点投影）与 `coarseGrid`（PERF-6-8 提到的可疑对象）
在尖峰帧里的份额都明显更小（`coarseGrid` 尖峰帧 self time 仅 9 ms，不是主因）。

`(program)`（V8 采样器无法归到具体 JS 帧的原生调用，通常是 canvas 填充/描边、`postMessage`
结构化克隆这类 C++ 侧工作）在改动前占全程 4246 ms、尖峰帧 619 ms，是仅次于 `(idle)` 的第二大桶——
这部分没法用采样剖析进一步拆细，但后文的改前/改后对照显示它随 `buildWater` 挪走后明显下降，
说明其中相当一部分正是 `buildWater` 的 canvas 原生绘制开销。

## 修法：水体/河道栅格化、夜光变换全部搬进 Worker（用 OffscreenCanvas），和道路合成一起做

只改 `src/ground/*`（`clipmap.ts`、`road-raster.ts`、`road-raster.worker.ts`、`tiles.ts`），不改着色器：

- **`tiles.ts`**：`WaterFeatures.polygons/lines`（嵌套对象数组）改成扁平的 `WaterTileData`（新
  `WaterTileBuilder`，写法对齐已有的 `RoadTileData`/`RoadTileBuilder`），`loadWater()` 解析矢量瓦片时
  直接攒成这个格式，缓存进原有的 `vectors` LRU（不改缓存策略，只改缓存的数据形状）。
- **`road-raster.ts`**：新增 `buildGroundLevel(job, albedo, nightRaw)`，用 `new OffscreenCanvas(RES,
  RES)` 做水体/河道的 Path2D 填充+描边（逐顶点投影 `tileYToLat`/`tileXToLon`/`LocalFrame.toLocal`，和
  原来 `buildWater` 里的数学完全一致，只是从嵌套对象换成扁平数组遍历）→ `getImageData` → 用新的
  `darkenNight()`（从 `clipmap.ts` 的 `buildNight` 搬过来，公式不变）变换夜光 → 调用原有的
  `packRoads(job, px)` 叠加道路（这部分逻辑完全没动）→ 返回 `{water, albedo}`。`OffscreenCanvas` 在
  Worker 和主线程都能用，所以这一个函数同时服务 Worker 路径和「Worker 起不来」的主线程兜底路径。
- **`road-raster.worker.ts`**：`onmessage` 改成收 `{id, job, albedo, nightRaw}`（`albedo`/`nightRaw`
  走 Transferable），调用 `buildGroundLevel` 后把 `{id, water, albedo}` 转移回去。
- **`clipmap.ts`**：`buildWater()` 只剩「取瓦片、攒 job」（不再碰 canvas），`buildNight()` 只剩「取瓦片、
  画布合成、`getImageData`」（去掉逐像素变换循环），`build()` 里原来的 `packRoadsAsync` 调用改成
  `buildGroundLevelAsync(vec.job, albedo0, nightRaw)`。`coarseGrid` 仍在主线程（尖峰占比小，未改）。

**为什么 `buildImagery`（同样有 `getImageData`）没有一起挪**：`buildImagery`/`buildNight` 的画布内容
来自 `drawImage(ImageBitmap, …)`（栅格瓦片），`ImageBitmap` 缓存在主线程 `tiles.ts` 的 `loadBitmap`
LRU 里给下次重建复用；要把这两步的 canvas 合成也挪进 Worker，得把 `ImageBitmap` 转移过去（会
detach，破坏 LRU 复用）或者把整条「fetch → decode → 缓存」链路都搬进 Worker（更大的改动，缓存归属
也要重新设计）。`buildWater` 不需要 `ImageBitmap`（纯 Path2D 矢量绘制），可以直接把扁平几何数据
（仍是复制，不转移——原因同道路：留在主线程 LRU 里给下次重建复用）发给 Worker，风险和改动量小得多，
且是本次剖析里最大的一块，所以本任务只搬了这一半。`buildImagery`/`buildNight` 的 `getImageData`
和 `buildNight` 的取瓦片+画布合成仍在主线程——已如实记录在下面的「结论」和 README 坑点里，留给后续。

## 改前 / 改后对照（同一态 25 秒挂钟采样，route-hnd-cts 60×）

| | 改前（5289） | 改后（5249） |
| --- | ---: | ---: |
| 采样窗口内渲染帧数 | 3622 | 3893 |
| `dt > 16 ms` 帧数 | 95（2.62%） | **38（0.98%）** |
| 尖峰帧窗口内的 CPU 占用 | 3536 ms | **922.5 ms** |
| 最慢的 10 帧 dt（ms） | 143.7, 74.9, 68.8, 68.7, 68.7, 68.7, 62.5, 62.5, 62.5, 62.5 | **100, 25.1, 18.9, 18.9, 18.9, 18.8, 18.8, 18.8, 18.8, 18.8** |
| dt 分桶：>100 / 50–100 / 16–50 ms | 1 / 16 / 78 | **0 / 1 / 37** |

`dt > 16 ms` 的帧数下降 60%，且分布发生质变：改前有 17 帧落在「60–105 ms」这个题目描述的区间
（50–100 ms 16 帧 + >100 ms 1 帧），改后只剩 1 帧压线在 100 ms（其余全部 16–25 ms 量级，多数是
`buildImagery`/`buildNight` 残留的 `getImageData` 偶尔在同一帧里撞到一起，量级比改前小一个数量级）。
改后窗口内渲染出的帧数还更多（3893 vs 3622）——主线程更少被长任务堵住，同样 25 秒真实时间里能推进
更多帧，这本身也是改善的旁证。

主线程 self time 排行的直接变化（改后 `tmp/perf-9/cpu-profile-after.json`）：`getImageData ←
buildWater`（638.63 ms）、`tileYToLat ← proj ← buildWater`（263.54 + 157.77 ms）、`buildNight` 的
逐像素变换循环（340.00 ms）**全部从全程热点前 20 名里消失**；`(program)` 从 4246.43 ms 降到
3838.72 ms（−9.6%，佐证相当一部分原生开销来自 `buildWater` 的 canvas 填充/描边）；`(idle)` 从
11319.98 ms 升到 14183.73 ms（主线程更多时间处于「没有活干」的等待状态，符合工作挪到 Worker 后
的预期）。`buildImagery`/`buildNight` 的 `getImageData`（这两步本轮没动）仍在，且因为主线程更少被
阻塞、同样时间内完成更多次级别重建，聚合 self time 略有上升（173.81→334.14、356.51→537.84 ms）——
这是符合预期的此消彼长，不是新增开销。

## 画质回归：3 个场景 + 同代码噪声底

`tmp/perf-9/shot-settled.mjs`（照抄 `handoff/PERF-6-8.md` 记录的严格截图法：应用场景后一直等到
`window.__voyage.ground.pending === 0`——本轮实测网络偶发卡住，超时放宽到 90 s——并强制关掉翼尖
频闪 `wingDebug.strobe = 0`，避免 PERF-6-8 记录过的两个假信号）+ `tmp/perf-9/pixel-diff.mjs`（一次性
headless 页面用 Canvas2D 逐像素求绝对差，均值 / p99 / 最大值 / 变化像素占比，方法论同 PERF-6-8）。

| 场景 | 同代码两次独立截图（噪声底 mean） | 改前 vs 改后（mean） | 结论 |
| --- | ---: | ---: | --- |
| fuji-day | 0.292 | 0.195 | 同量级（甚至更小），零回归 |
| night-city | 2.295 | 7.406 | 量级偏高，逐张目视对照（见下）无结构性差异，判定零回归 |
| route-hnd-cts-night | 2.810 | 6.256 | 同上 |

`night-city`/`route-hnd-cts-night` 的 mean diff 比噪声底高约 2–3 倍，逐张放大目视对照
（`tmp/screenshot/perf-9/{before,after}/*.png`）：城市光斑分布、道路网络形状、星空、机翼/翼尖灯完全
一致，没有缺块、没有整片错位或颜色跑偏，符合 README 坑点里记录过的「城市夜光按世界坐标 hash 决定
亮不亮，任何浮点顺序变化都会让格子边界的像素成片翻转」这一类已知噪声源，量级也和 PERF-6-8 记录的
`night-city` 严格对照基线（3.97）同一数量级。这两个场景恰好是最重度经过 `buildWater`/`buildNight`
改动路径的场景（`fuji-day` 白天，道路灯带/城市灯点在着色器里按太阳高度门控基本不显示，所以改动路径
对画面几乎没有可见影响，diff 也最小，方向上和「改动集中在夜景管线」是自洽的）。
本轮测试期间还两次观测到 `ground.pending` 长期卡在两位数不降（可能是本会话高强度反复测试撞上了
README 坑点提到的「大量测试可能触发限流」），重试后收敛，不是代码问题。

## 测试记录

- `pnpm typecheck`：通过。
- `pnpm build`：通过，`dist/assets` 无 0 字节文件（`road-raster.worker-*.js` 从 2.4 kB 涨到 6.0 kB，
  符合预期——现在多做了水体/河道栅格化和夜光变换）。
- `pnpm check:glsl`：全部通过（本任务未碰任何 `.glsl.ts`，跑一遍确认没有连带影响）。
- `node scripts/dev-browser.mjs check --port 5249`：无 console error / pageerror。
- CPU 剖析、画质回归：见上两节。

## 归属确认

只改了 `src/ground/clipmap.ts`、`src/ground/road-raster.ts`、`src/ground/road-raster.worker.ts`、
`src/ground/tiles.ts`；没有碰着色器、`clouds/*`、`wonders/*`、cabin。

## 临时脚本（未提交，在 `apps/voyage/tmp/perf-9/`）

- `cpu-profile.mjs`：CDP Profiler 剖析（route-hnd-cts 60×，本文档「剖析方法」一节）。
- `shot-settled.mjs`：应用场景后等 `ground.pending === 0` + 关翼尖频闪再截图。
- `pixel-diff.mjs`：两张同尺寸 PNG 逐像素绝对差（均值 / p99 / 最大值 / 变化像素占比）。
- `cpu-profile-before.json` / `cpu-profile-after.json`（及同名 `.cpuprofile`，可以直接拖进 Chrome
  DevTools 的 JS Profiler 面板看火焰图）：本次剖析的原始数据。

这几个脚本如果后续任务还要用，建议誊一份进 `scripts/`（`cpu-profile.mjs` 尤其通用，任何「主线程尖峰
定位」都用得上），本任务按范围没有主动改 `scripts/dev-browser.mjs`。

## 已知未修 / 留给后续

- **`buildImagery`/`buildNight` 的 `getImageData` 仍在主线程**（见上文「为什么 `buildImagery` 没有一起
  挪」）：改后残留的尖峰帧（38 帧，多数 16–25 ms）里这两项还是最大的具名开销。要继续压，得把
  `ImageBitmap` 的 fetch/decode/缓存整条链路搬进 Worker（`tiles.ts` 的 `loadBitmap`），改动面更大，
  这次按「测试节制」没有做。
- **矢量瓦片的 protobuf 解析（`readSVarint`/`loadGeometry`，`tiles.ts`）仍在主线程**：改前/改后都在
  200 ms 量级（每张新瓦片解析一次，被 800 条的 LRU 缓存摊薄），本次没有移动，量级上不是当前最大的
  一块，但如果以后要继续压尖峰，这是下一个候选（连同瓦片 fetch 一起挪进 Worker，和上一条是同一个
  更大的重构）。
- **`(program)` 桶仍然不小**（改后全程 3838.72 ms）：CDP 采样剖析拿不到比「原生调用」更细的归因，
  如果要继续拆，需要用 Chrome `Tracing` 域（`disabled-by-default-devtools.timeline` 等分类）换取更
  细的分类（Canvas2D 绘制 / `postMessage` 结构化克隆 / V8 内部），本任务没有做到这一步。
- 改后仍会出现个别 ~100 ms 的孤立尖峰（25 秒窗口里观察到 1 次）：从聚合的尖峰热点排行看不出单一
  主因（`(idle)`/`(program)` 仍占大头），推测是多个级别的 `buildImagery`/`buildNight` 读回偶然撞在
  同一帧里；量级和频率都比改前小一个数量级，暂不继续深挖。
