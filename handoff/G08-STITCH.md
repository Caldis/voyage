# G08-STITCH · 影像瓦片拼接挪进 Worker · 交接

分支 `worktree-agent-a0799f38165606dd7`（基于 master e5c950f），开发端口 5233，对照 5293（`tmp/g08-base`，已删）。硬件 RTX 5090，ANGLE d3d11，1600×1200，DPR 1，画质档 high。
截图与数据：`D:\Code\opus-test\tmp\screenshot\G08\`（`spikes-1.{txt,json}` 是 40 分钟长测原始数据）。

## 做了什么

| 项 | 做法 | 文件 |
| --- | --- | --- |
| 主线程只取 Blob | `loadImageryBlob`：影像瓦片只取回 JPEG（限速 / 负缓存 / 占位图识别不变），缓存 Blob（1500 张）；夜光 / 地形照旧 `loadBitmap`（画布小，主线程拼）。Worker 报告解码失败的瓦片 `forgetImageryBlob`（删缓存、记 failed，下次重建重取） | `tiles.ts` |
| 拼接任务 | `buildImagery` / `buildDetail` 返回 `ComposeSpec`（各瓦片 Blob + 画布矩形，按覆盖范围顺序，和到达时序无关）；GSI 的限时（`DETAIL_WAIT_MS`）不变：到点前到的才算，没齐的一版不拼 | `clipmap.ts` |
| 拼接 Worker | 新 `tile-compose.worker.ts`：`createImageBitmap(blob)` 解码（软件位图）、按地址 LRU 缓存 1200 张（换出时 close）、`willReadFrequently` CPU 画布拼、`getImageData`，像素转移回主线程，主线程再转移给合成 Worker。任务用 Promise 链串行（防缓存换出关掉还没画的位图） | `tile-compose.ts`、`tile-compose.worker.ts`、`clipmap.ts`（`stitchAsync`） |
| 合成 Worker | `buildGroundLevel` 改收像素数组；新 `buildGroundLevelFrom` 接三种来源（像素 / 拼接任务 / G07b 的位图），合成 Worker 与主线程兜底共用 | `road-raster.ts`、`road-raster.worker.ts` |
| 回退 | 两个 Worker 的 onmessage 都是 async，异常 try/catch 后回 `{ id, error }`（async 里抛的不触发 error 事件）。拼接 Worker 停用 → 合成 Worker 自己拼；合成 Worker 停用 → 主线程算（没有 OffscreenCanvas 时 `make2d` 用 `<canvas>`） | `clipmap.ts`、`tile-compose.ts` |
| 瓦片矩形对接 | `tileRect`：左右边按这一行的中间纬度算（原来左边按上沿、右边按下沿，东西相邻的瓦片之间有缝 / 重叠）。CPU 画布不做边缘抗锯齿，旧矩形的缝变成整像素透明 → 暗细线（见坑点）。开关 `tileEdgeShared`（默认 true，两种拼接做法都用） | `clipmap.ts` |
| 边缘抗锯齿探测 | 启动时探测一次 CPU 画布画位图带不带边缘抗锯齿（Chrome 不带）；带时 `drawTileCrisp` 走「整像素裁剪 + 外扩 1 像素垫底 + 正片」，接缝 A 仍 = 1 | `tile-compose.ts` |
| 调试句柄 | `ground.imageryInWorker`（false = G07b 做法）、`ground.tileEdgeShared`；`imageryStats.stitch`（count / maxMs / decodedCached / aa / queued / recent[{start,end,ms,marks,decoded,hits}]）、`imageryStats.worker.queued`、`worker.recent[].decoded/hits` | `clipmap.ts` |

## 数字

**1× 巡航帧尖峰（`node handoff/G08-spikes.mjs 5233 60 20 G07b,G08 …`，hnd-cts 连续航程，同页 ABBA 交替，每窗口 60 s，各 20 窗口 = 20 分钟，持测量锁全程）**

| 做法 | 帧数 | > 16.7 ms | 每分钟 | > 25 ms | 落在合成 Worker 的 read 段 | 落在拼接 Worker 任务内 | 主线程长任务 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| G07b（主线程 GPU 画布拼、Worker 读回位图） | 158 225 | 63 | 3.14 | 39 | 47 | — | 0 |
| G08（拼接 Worker CPU 拼） | 159 391 | **1** | **0.05** | 0 | 0（G08 的 read 段是 0 ms） | **0** | 0 |

G08 唯一那 1 个尖峰落在两个 Worker 的任务之外。G07b 这次比 G07b 交接里的 1.5 / 分高（同一类 read 段尖峰，GPU 进程忙闲随时段变），但同页交替下的比较是公平的。拼接任务中位约 40–55 ms（在拼接 Worker 里），解码缓存命中后 `eoxDecode` 0–9 ms。

**60× 无积压（`node handoff/G08-stream60.mjs 5233 60 60 2`，同页交替每窗口 60 s）**：两边在途合成任务最大 3（= 最多 4 级同时在建），G08 拼接在途最大 1，窗口末尾都回落；合成 Worker 忙 0.71–0.81（G07b 0.82–0.85，read 段挪走了），拼接 Worker 忙 0.12–0.14；主线程长任务 0。G08 两窗口 > 16.7 ms 帧 2 / 2，G07b 1 / 67。

**首载（`node handoff/G08-load.mjs 5293 5233 N`，每次新浏览器冷缓存，交替）**

| 场景 | master 粗版就位 | G08 粗版就位 | master 全部 fine | G08 全部 fine |
| --- | --- | --- | --- | --- |
| fuji-day（两批 3 + 4 次） | 中位 7.8 / 8.0 s | 中位 7.3 / 7.9 s | 中位 14.4 / 15.1 s | 中位 18.3 / 14.4 s |
| route-hnd-cts（3 次） | 8.25 s | 8.25 s | 15.1 s | 15.2 s |

（fine 列受 EOX 限流左右：master 出现过 20.8 / 22.0 s，G08 第一批出现过 19.1 / 18.3 s；第二批 4 次 G08 全在 14.4–15.0 s。粗版就位不受网络尾巴影响，是本任务改动的主要影响面。）**第一版把拼接放在合成 Worker 里串着做，粗版就位慢约 0.5 s（fuji 7.8 → 8.4 s），所以才拆出单独的拼接 Worker。**

**零回归（同页 A/B，`G07B_FLAG=imageryInWorker node handoff/G07b-pair.mjs …`，两边都用对接矩形，只比拼接做法）**

| 档 | 场景 | 平均 / p99 / 最大 |
| --- | --- | --- |
| 2048 | fuji-day / fuji-low-detail / route-hnd-cts | 0.000 / 0 / 12.3、5.3、4（> 8 的像素 0%） |
| 2048 | night-city / route-hnd-cts-night | 0.02 / 0.33 / 190、0.03 / 0.67 / 180（> 8：0.024%、0.053%） |
| 1024 | fuji-day / fuji-low-detail / night-city | 0.000 / 0 / 7.3、0.000 / 0 / 2、0.03 / 0.67 / 174 |

差异来源：GPU 与 CPU 画布「high」缩放滤波不同（瓦片内 ±1–3 的零星点），以及 GPU 画布在瓦片接缝上的半透明（A 158–183，部分回退到粗一级）换成 CPU 画布的不透明；夜里个别灯点随之有无翻转（和 G07b 水体 CPU 栅格同一类，最大差大、平均差 0、p99 ≤ 0.67）。**这是有意改动**，不闪（一次性的建级结果，同一版本内稳定）。每次对照两边 `pending = 0`、失败瓦片数相同。

**瓦片矩形对接（`G07B_FLAG=tileEdgeShared`，有意改动）**：fuji-day 0.03 / 1 / 32，fuji-low-detail 0.01 / 0.33 / 15，route-hnd-cts 0.01 / 0 / 15，night-city 0.05 / 0.67 / 186，route-hnd-cts-night **0.58 / 8.3 / 236（> 8：1.0%）**。夜景离原点远，影像挪了几个像素，灯点（按影像判建成区）整片换一版，一次性的。不做这一项的话 CPU 拼接会在原点以西每条瓦片竖缝上出一条整像素透明的暗线（`fuji-seam.png`）。

**其他**：typecheck、build 通过，`find dist/assets -type f -size 0` = 0（`tile-compose.worker-*.js` 已打包），`check:glsl` 全部通过；控制台零 error（2048、`?groundres=1024`、`dev-browser check`，瓦片 CORS 限流错误除外）。回退路径实测：`G08_NOWORKER=stitch`（合成 Worker 自己拼）首载 27.8 s 正常；`G08_NOWORKER=all`（主线程算）功能正常，首载到 warmup 完成 24.2 s（coarse 7.3 s / fine 14.3 s，审查复现；实现时记的 237 s 不能复现，多半碰上了 EOX 限流）；代价在巡航：1× 巡航 60 s 有 26 帧超过 16.7 ms（正常 0），帧数 6272 对 7780。只保证能用，不需要给用户提示。（2026-09-28 按 G08 审查 L1 更正）

## 平台（Safari / Mac）

- Worker 里的 OffscreenCanvas 2D：Chrome 69+、Firefox 105+、**Safari 16.4+**。Worker 里 `createImageBitmap(Blob)`：Safari 15+。
- Safari 16.4 以前：拼接 Worker 报错 → 停用 → 合成 Worker 同样报错 → 停用 → 主线程用 `<canvas>` 算（慢但对）。首次失败的那一级下一帧重建。
- **没在 Safari / ANGLE Metal 上实测**：Safari 的 `createImageBitmap` 解出的位图可能是 GPU 位图（那样画到 CPU 画布上会有一次读回）；Safari 的 CPU 画布是否给 drawImage 做边缘抗锯齿不确定（有的话自动走 `drawTileCrisp` 慢路径，`imageryStats.stitch.aa = true`，拼接耗时约翻倍，仍在 Worker 里）。

## 还没做 / 已知问题

- 夜光（1024²）与地形（256²）仍在主线程的 CPU 画布上拼（本来就是 `willReadFrequently`，不是 GPU 读回，G07b 归因里没有尖峰）；它们的瓦片矩形也还是旧算法（左边上沿、右边下沿），离原点远时有亚像素到几个像素的缝。地形用最近邻、缝处是 0 m 底色，理论上会在高度图里出一条 0 m 的细线——没有测，建议下一个地面任务顺手看（`tileRect` 可以直接复用）。
- `fine = false`（加速航程 / 首载粗版，2× 放大）时 CPU 与 GPU 的放大滤波差异没单独做 A/B（A/B 都在 fine 之后拍）。
- 主线程兜底只是保底：首载正常（24.2 s），1× 巡航每分钟约 26 帧超过 16.7 ms（见上）。
- （G08c 已修）夜光 / 地形的瓦片矩形已改用 `tileRect` 对接，见 `handoff/G08c.md`。
- G07b 的 `imageryCanvasCpu` 开关只在 `imageryInWorker = false` 时有效，留作对照。

## 复现

```bash
# apps/voyage 下
node handoff/G08-spikes.mjs <端口> 60 20 G07b,G08 [输出.json]        # 1× 帧尖峰同页交替 + 按阶段归因（自己等锁、持锁；期间别改 src）
node handoff/G08-stream60.mjs <端口> 60 60 2                         # 60× 积压
node handoff/G08-load.mjs <对照端口> <端口> 3 [fuji-day,route-hnd-cts] # 首载（冷缓存交替）
G07B_FLAG=imageryInWorker node handoff/G07b-pair.mjs <端口> <输出目录> all [--query groundres=1024]   # 拼接做法同页 A/B
G07B_FLAG=tileEdgeShared node handoff/G07b-pair.mjs <端口> <输出目录> all                           # 矩形对接同页 A/B
node handoff/G07-diffs.mjs <目录> .a <目录> .b
node handoff/G08-diag.mjs <端口> [预设] [时间] [URL 参数]             # 两个 Worker 的阶段、解码命中、各站点请求；G08_BLOCK=0.5 拦一半 EOX，G08_NOWORKER=stitch|all 测回退，G08_SHOT=路径 截图
node handoff/G08-seam.mjs <端口>                                     # GPU / CPU 画布接缝 A 通道对照
node handoff/G08-stitchbench.mjs <端口>                              # CPU 拼 2048² 的耗时与 imageSmoothingQuality
```
