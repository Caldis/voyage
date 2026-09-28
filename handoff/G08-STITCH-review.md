# G08-STITCH 独立审查

审查对象：分支 `worktree-agent-a0799f38165606dd7`（e7c77cc），合入 master f13572e 后在临时工作区 `tmp/g08rev` 复核（端口 5236；master 对照端口 5296，用主工作区起的开发服务器）。硬件与实现者相同（RTX 5090，ANGLE d3d11，1600×1200，画质档 high）。审查员自己的数据与截图在 `tmp/screenshot/G08rev/`（含全部审查脚本 `g08rev-*.mjs`，放到 `apps/voyage/handoff/` 下即可运行；`g08rev-rect.mjs` 纯离线，任意目录 `node` 直接跑）。

## 结论：通过（合并时顺手修 M1；M2 是 master 上早就有的问题，另开任务）

跨线程契约、回退链、瓦片矩形的数学、拼接滤波、性能都复核过，没有发现要返工的问题。

- 契约：transfer 之后主线程没有再碰被转移的缓冲；两个 Worker 都串行执行，位图缓存的换出不会关掉还没画的位图；回退链三级都实测走通，也不会重复提交。
- 性能：尖峰下降复现了（见第 4 节）。首载没有变慢。解码缓存长航程命中率稳定在 84–90%，没有整轮不命中。
- 画面：2× 放大时 CPU 和 GPU 画布逐像素几乎一致（最大差 1），没有引入锯齿或摩尔纹。夜景灯点换一版的幅度可以接受。

有一处需要在合并时顺手修（M1），另有几处文档要更正（L1、L2）。审查中还发现一个 master 上早就存在的地形 / 夜光接缝问题（M2），它不是 G08 引入的，但分量不轻，建议马上另开一个任务处理。

## 问题（按严重度）

### M1（中，合并时修）合成 Worker 回报 error 后，这次构建的 reject 没人接，控制台出一条 pageerror

- 现象：用 `handoff/g08rev-fallback.mjs 5236 inner` 模拟 Safari 16.4 以前的环境。做法是在两个 Worker 脚本开头插入 `self.OffscreenCanvas = undefined`，Worker 能起来，但一干活就报错。回退链能走完（拼接 Worker 停用 → 合成 Worker 停用 → 主线程算），7 级都 valid。但控制台多出一条 `pageerror Error: 这个 Worker 不支持 OffscreenCanvas 2D`。只停用拼接 Worker（`stitchonly`）时是 0 error。
- 根因：`buildGroundLevelAsync` 在 error 回报时 `req.reject(...)`，`build()` 没有 catch，调用处是 `void this.build(...)`（clipmap.ts:405），于是成了未处理的 Promise 拒绝。onerror 那条路径在 master 上也是这样，但 G08 新增的「async onmessage 回 `{error}`」让这条路径在 Safari 老版本上**首载必然触发一次**。
- 修法（一行）：`void this.build(...).catch((e) => console.warn("地面一级构建失败，下一帧重建", e))`，或者在 `build` 里 catch。按注释的设计，失败后下一帧会重建，所以吞掉就对了。
- 识别：`node handoff/g08rev-fallback.mjs <端口> inner`（审查脚本存档在 `tmp/screenshot/G08rev/g08rev-*.mjs`，放进 `apps/voyage/handoff/` 下运行；合并时可收进 handoff），看 console error 是不是 0。

### M2（中，master 早就有，不阻塞本任务，建议立即另开任务）地形高度图、夜光仍用旧矩形 → 原点以西每条瓦片竖缝都是 0 m 深沟 / 无灯带

交接里「理论上会出 0 m 细线、没有测」这一条，审查实测**确认存在，而且比预想的宽**：

- 离线计算（`tmp/screenshot/G08rev/g08rev-rect.mjs`：复刻 `tileCover` / `zoomForResolution` / 旧、新 `tileRect`；3 个预设 × 5 个位置 × 7 级）：
  - 地形画布是 256²、最近邻、CPU 画布（`makeCanvas` 的 willReadFrequently，没有边缘抗锯齿）。离原点以西 100 km 时，**每一级**都有约 3 列整列 0 m（第 0 级约 90 m 宽）；以西 300 km 时 8–11 列（第 0 级约 270 m 宽）。
  - 夜光画布是 1024²，同样位置的缝更宽：z8 瓦片跨 1°，以西 100 km 时第 0 级缝约 1.2 km（约 150 列），整条带子里没有灯。
- 实测（`handoff/g08rev-demcrack.mjs`：fuji 预设，冻结后钉在原点以西 111.74 km、高度 1.2 km，等 pending = 0 后扫 `heightCpu`）：L0–L5 每级都有一条连续 180–234 行的 0 m 竖缝，第 0 级在第 134–137 列（约 125 m 宽，周围山地 590–740 m）。飞机正下方是缝时 **`heightAt` 返回 0 m**，这个值会被离地高度、云底 floor 等 CPU 侧逻辑用到。截图 `tmp/screenshot/G08rev/demcrack-on.png`：这个姿态下肉眼不明显（地形网格比 31 m 的像素粗），深沟主要影响 CPU 侧的查询和法线。**夜光那条 1 km 级的无灯带没有做夜景实拍**，只有离线数字。
- 原点以东是重叠，不出缝。航线往西飞（hnd-itm，以及 fuji 预设本身就是向西飞）时一路都有缝，直到 `rebaseFrame` 把原点挪过来。
- 修法：`buildHeight` / `buildNight` 改用 `tileRect(cover.toPx, zoom, t, true)`，两处各改一行。代价：夜光换一版（和本任务同一类的一次性变化），要做夜景同页 A/B。建议协调者单独开一个小任务（G08c）。

### L1（低，文档）「主线程兜底首载 237 s」不能复现

- 审查用实现者自己的 `G08_NOWORKER=all node handoff/G08-diag.mjs 5236` 重跑：载入到 warmup 完成 **24.2 s**（coarse 7.3 s / fine 14.3 s）。用上面的 inner 注入重跑：26.4 s（fine 16.6 s）。237 s 多半是那次正好碰上 EOX 限流。
- 第三级回退的真实代价在**巡航**，不在首载：1× 巡航 60 s 有 26 个 > 16.7 ms 的帧（正常时 0），帧数 6272 对 7780。
- 结论：第三级**不需要**给用户提示（首载正常，只是巡航略卡）。README「坑二」里「首载很慢」和交接里的 237 s 要改成上面的数字。
- 另外，`G08_NOWORKER=all` 是在 `new Worker` 时直接抛错，测的是 `catch { worker = null }` 这条路径，**测不到** error 回报那条路径（M1 就是在那条路径上）。建议把 inner 注入这种测法收进 G08-diag。

### L2（低，注释）tile-compose.ts 里有两段注释前后矛盾，是 WIP 阶段留下的

- `drawTileCrisp` 的文档注释写「CPU 画布的 drawImage 对边上像素按覆盖率混合…GPU 画布画位图不做边缘抗锯齿」，和实测以及函数体里的注释正好相反（实测是 Chrome 的 CPU 画布**不**抗锯齿，GPU 画布抗锯齿）。它还写着「相邻瓦片的矩形不严格对接…缝隙处照旧透明」，这在 `tileRect` 修好之后已经不对了。
- 文件头写「在地面栅格化 Worker 里跑（road-raster.worker.ts）；Worker 不可用时主线程用同一份代码兜底（clipmap.ts 的 buildGroundLevelAsync）」，应改成「主要在拼接 Worker（tile-compose.worker.ts）里跑，停用后由合成 Worker、再退到主线程」。

### L3（低，可接受）过期的拼接任务不能取消；出一次错就永久停用拼接 Worker

- 世代变了以后，拼接 Worker 里排着的旧任务照样做完（每个约 50 ms），主线程拿到结果后丢掉。实测最坏情况：连续 `rebuildAll()` 3 次再急转 90°，拼接在途峰值巡航时 2、低空带细节时 5，15 s 内回落到 0–1，不积压。不值得加取消协议。
- 任何一次 error 回报都会让拼接 Worker 永久停用。这是有意的设计，有 console.warn，可以接受。

### 信息

- 位图缓存 1200 张 × 256 KB ≈ 300 MB，在拼接 Worker 里，不算主线程堆。60× 航程 80 s 装满后命中率稳定在 84–85%。低空带 GSI 细节时 1× 命中 90%，没有整轮不命中。换出时有 close()，任务串行（Promise 链），同一任务里命中的位图先被 get 挪到最新，不会被本任务后面的 set 换出。主线程 Blob 缓存 1500 张，几十 MB。长航程没有泄漏迹象（主线程 JS 堆在 127–240 MB 之间来回，GC 正常）。
- 开发服务器首载时，最长的主线程任务 G08 是 1.61 / 1.63 / 1.69 s，master 是 1.09 / 1.31 / 1.11 s，3 次都是 G08 更长约 0.4 s。粗版就位和全部 fine 不受影响（见第 4 节）。估计是冷启动编译的归属不同，没有深究，建议性能工程师在 build 产物上顺带看一眼。

## 分项复核

### 1. 跨线程契约（读 diff）

- 所有权：拼接 Worker 把 `getImageData().data.buffer` 转移回主线程（ImageData 自有缓冲，byteOffset 0，可以转移）。主线程只把它原样转移给合成 Worker，之后 `albedoSrc` / `detailSrc` 不再被读。合成 Worker 出错时像素丢失，由重建重新拼（解码缓存命中，代价小）。拼接 Worker 停用时，交给合成 Worker 的是 ComposeSpec，Blob 只是克隆引用、不转移，主线程的 Blob 缓存继续有效。G07b 对照路径里的 ImageBitmap 照旧转移。
- 消息顺序与回退：`stitchPending` 按 id 先删再回调；`disableStitch` 把其余在途请求 resolve(null) 后，这些级改交合成 Worker。每个请求只 resolve 一次，没有重复提交。模块加载失败、async 里抛的异常，两种情况都有覆盖（onerror + `{id, error}`）。
- 世代检查：`stitchAsync` 之后和 `buildGroundLevelAsync` 之后都有 `gen` / `minLevel` 检查。
- 实测三级回退：只停拼接（inner 注入）warmup 26.4 s、0 error；两级都停见 M1、L1。

### 2. 瓦片矩形按行中间纬度对接

- 原来为什么左右不一致：Web Mercator 下同一行瓦片的纬度边界确实一致，但本地坐标 `x = Δlon · k · cos(lat)` 按**各点自己的纬度**换算经度，所以一条经线在本地坐标里是斜的。旧算法取左上角 (latT, lonL) 和右下角 (latB, lonR) 定矩形，同一条共用经线在左邻瓦片里按 latB 算、在右邻瓦片里按 latT 算，两边差 |x|·sinφ·Δφ：原点以西是缝，以东是重叠。实现者的解释正确。
- 新算法：两边都按这一行的 latM 算，东西相邻的瓦片输入的浮点数完全相同，缝严格为 0。上下两行的 y 只和纬度有关，本来就共用。离线复核 3 预设 × 5 位置 × 7 级，**新缝全部 0.000**，角点误差正好减半（例：以西 300 km 第 0 级 17.1 → 8.6 px，约 34 m）。行与行之间的水平错位仍是一整个差值，和旧算法相同，没有变坏。
- 夜景 route-hnd-cts-night 平均差 0.58、1% 像素差 > 8：看了实现者的 a/b 裁剪放大（`tmp/screenshot/G08rev/night-edges-ab.png`），灯点密度、层次、路网相当，只是整体挪了几个像素、换了一版，没有变差。它是朝真实位置的修正、一次性、同一版本内稳定，**可以接受**。
- 地形 / 夜光的风险见 M2（确认存在）。

### 3. CPU 与 GPU 缩放滤波

`handoff/g08rev-filter.mjs`：东京 z13 的 4×4 张真实 EOX 瓦片，在 GPU / CPU 画布上以 high 质量缩放：

| 比例 | 平均差 | 最大差 | > 8 像素 | 相邻差 GPU / CPU |
| --- | --- | --- | --- | --- |
| 2×（fine = false 粗版） | 0.031 | 1 | 0% | 15.02 / 15.02 |
| 1.37× | 0.076 | 90 | 0.14% | 21.28 / 21.30 |
| 0.73× | 0.176 | 89 | 0.32% | 31.85 / 31.91 |

2× 放大两边几乎逐像素相同，所以交接里「fine = false 没单独做 A/B」这一项可以关掉。小数比例下的大差集中在小数边界上的少量像素：GPU 画布在边上做了覆盖率混合，CPU 画布没有。相邻差相同，说明瓦片内部没有更锐或振铃，**没有引入锯齿或摩尔纹**。放大对比图在 `filter-x2-{gpu,cpu}.png`。

### 4. 性能

- 尖峰（`node handoff/G08-spikes.mjs 5236 60 4 G07b,G08`，持测量锁，同页交替各 4 分钟，`spikes-rev.{txt,json}`）：G07b 12 个（2.99 / 分，其中 7 个落在 read 段）。G08 有 3 个窗口是 0；另一个窗口有 10 个，其中 5 个是 500–650 ms 的整机停顿，都在两个 Worker 的任务之外、没有主线程长任务，帧数少了约 390 帧。这是外部干扰，和实现者长测第 18 轮 G07b 那次 544 ms 同一类。排除这个窗口后，G08 是 0 / 3 分钟。结论方向和实现者一致：read 段尖峰被消除。
- 首载（`G08-load.mjs 5296 5236 3 fuji-day`，冷缓存交替）：粗版就位 master 中位 8.33 s → G08 7.88 s，全部 fine 14.39 → 14.37 s，**没有变差**。
- 60× 在途：拼接 ≤ 1，合成 ≤ 3，不积压（g08rev-hits）。
- 控制台：各次运行（除 M1 的注入场景外）0 error。typecheck、build 通过，`find dist/assets -type f -size 0` = 0，`tile-compose.worker-*.js` 已打包。

### 5. 与在途分支的冲突

`git merge-tree` 对 C10b（a58368f）、T48c（a2abd84，main.ts / exposure.ts / README）、W-LAMP（a04959b，wing）三个分支都**无冲突**。和 T48c 同改 README，但改的是不同段落，能自动合并。

## 开发体验反馈

- 实现者的脚本很好用（spikes / load / diag 直接拿来就能复核），`imageryStats.stitch` 的 decoded / hits / queued 让缓存和积压一眼可见。审查里补的两个探针建议收进 handoff 或 dev-browser：①Worker 里去掉 OffscreenCanvas 的注入测法（测 error 回报路径，`G08_NOWORKER` 测不到）；②`heightCpu` 竖缝扫描（地形 0 m 缝的回归检查）。
- 测量锁这次等了约 3 分钟（C10b 的 GPU 计时），机制可用。8 分钟的尖峰测量里仍然碰上一次 0.5–0.65 s 的整机停顿（锁管不到非本仓库的负载），靠「按窗口看、剔除任务外的整机停顿」识别。建议 G08-spikes 的汇总里自动标出「> 200 ms 且不在任何任务内」的窗口。
- 离线复刻 `tileCover` 算缝宽的脚本（`tmp/screenshot/G08rev/g08rev-rect.mjs`）几秒就能给出全部级别、全部位置的数字，比开浏览器快得多。M2 的修复任务可以直接拿它做验收。
