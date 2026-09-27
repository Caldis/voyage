# PERF-6 + PERF-8 交接

分支 `worktree-agent-a400c6f1f11c979dc`，开发端口 5246，对照（未改动的 master）端口 5286
（`tmp/baseline-master/` 里的 detached worktree，收尾前会删掉）。依据
`research/PERF_REPORT_wave3.md` §4.4–4.5、表里 PERF-6 / PERF-8 两行。硬件 RTX 5090，ANGLE d3d11。

## PERF-6：关掉 FullscreenPass 的 autoClear

### 改法

`src/render/pass.ts`：`FullscreenPass` 构造时 `renderer.autoClear = false`（类头注释写了完整依据）。
没有改任何调用点——`grep renderer.render( src/` 全仓库只有 `pass.ts` 这一处命中，本仓库没有
传统的透视相机 / 多物体场景绘制，所有渲染都经这一个全屏三角形入口，所以在这一处关掉就对全部
调用生效，不用逐个改 `pass.render(...)` 的调用方。

### 逐个核对的清单（「部分覆盖 / 深度 / 累积」三类风险）

| 调用点（文件） | 目标 | 风险类别 | 核对结论 |
| --- | --- | --- | --- |
| `luts.ts`：transmittance / multiScattering / irradiance / skyView / skyViewMoon | 2D LUT | — | `depthBuffer:false`，无 discard，整屏覆盖 |
| `luts.ts`：aerialMaterial（逐 layer 循环） | 3D LUT 每层 | 看似部分覆盖（只写一层） | 三维纹理的「层」是独立的 2D 画布，本层内仍是整屏覆盖；`depthBuffer:false` |
| `clouds.ts`：`shadowMat` → `back` | 云影图 | **部分覆盖**（`scissorTest` 分帧建，只画新建的那几行） | 安全：scissor 矩形本身就把绘制裁死在「这一批新行」，清不清只影响这块矩形，反正马上被同一次绘制整个覆盖，等价；`depthBuffer:false` |
| `clouds.ts`：`occMat` → `back, layer` | 占据网格 3D 纹理 | 看似部分覆盖（分帧建，每帧几层） | 每次画的那一层本身整屏覆盖，`depthBuffer:false`，安全 |
| `clouds.ts`：`probeMat` → `probeTarget` | 1×1 探针 | — | `depthBuffer:false` |
| `clouds.ts`：`marchMat` / `marchWonderMat` → `raw` | 云步进 | **深度**（唯一带真实深度附件的目标，`depthTexture`） | 安全：`depthFunc: THREE.AlwaysDepth`（`clouds.ts` 原有注释「深度测试恒通过、写深度」），深度测试恒通过，旧深度是什么都不影响这次写入；且 `MARCH_FRAG` 每条路径都写 `gl_FragDepth`（`clouds.ts` 原有注释「写了 gl_FragDepth 的程序每条路径都要写」），没有分支会漏写 |
| `clouds.ts`：`resolveMat` → `history[next]` | 云时间累积 | **累积**（TAA 风格重投影） | 安全：着色器里显式读上一帧纹理（`uPrevHistory` 之类）算出全新值再整屏写回 `next`，不是 GL blending；`next` 与「正在读的上一帧」是两张不同的 ping-pong 纹理，没有原地累积 |
| `clouds.ts`：`wonderSurfMat` → `wonderSurf` | 奇观表面 | — | `depthBuffer:false`，整屏覆盖 |
| `noise.ts`：readback / make3D（启动一次性） | 云噪声 | — | `depthBuffer:false`；只在启动跑一次，不在每帧路径上 |
| `ocean/waves.ts`：evolve / butterfly（ping-pong）/ finalize（逐 layer） | FFT 海浪 | 看似累积（ping-pong） | 安全：每级 FFT 蝶形是纯函数式的「读上一级、算这一级」，不是原地累加；`depthBuffer:false` |
| `render/bloom.ts`：downMat / upMat | 眩光 mip 链 | **累积**（up 级读 low 级再叠加） | 安全：`UP_FRAG` 显式 `texture(uLow,...) + texture(uCurrent,...)` 算出和再整屏写回 `up[i]`，不是 GL blending（材质没设 `blending`），`depthBuffer:false` |
| `render/exposure.ts`：meterMat / adaptMat / finalMat（→ 画布） | 测光 / 适应 / 最终输出 | — | 全部 `depthTest:false, depthWrite:false`，`depthBuffer:false`（`finalMat` 写画布，画布本身也没人对它做深度测试） |
| `main.ts`：outsideMat/groundDetail → `hdrOutside`，cabinMat → `hdr`，wingMat → `hdrWing` | 窗外 / 舱内合成 / 机翼 | 看似部分覆盖（README 说「窗外 pass 全屏但只算本窗窗板以内」） | 安全：那句话说的是**着色逻辑**只在窗板范围内算真实值、范围外画统一的暗色/透明，不代表**像素覆盖**是部分的——`outside-pass.ts` / `wing-shading.glsl.ts` 都没有 `discard`（`grep discard src/render` 全仓库零命中），每个像素都会写出一个值，只是窗板外的值是「暗」而不是「跳过」；`depthBuffer:false` |

补充证据：`grep -rn discard src/` 在整个 `src/` 下零命中；`grep -rn "blending:\s*THREE\." src/` 零命中
（没有任何 `AdditiveBlending` / `CustomBlending`）——这两条是「清单能这么短」的根本原因：本仓库的
全屏 pass 全部是「纯函数式：读若干输入纹理，为每个像素算一个新值，整屏写出」，没有一处依赖
「这次绘制之前，目标里已经有什么」。

### 实测：gl.clear 调用次数（`tmp/perf-6-8/clear-count.mjs`，批渲 30 帧取平均，热身 60 帧）

| 场景 | 改前 | 改后 |
| --- | ---: | ---: |
| noon-cumulus | 118.83 | 0.00 |
| storm-day | 115.23 | 0.00 |
| typhoon-bands | 115.23 | 0.00 |
| fuji-day | 115.23 | 0.00 |
| night-city | 115.23 | 0.00 |
| route-hnd-cts | 115.23 | 0.00 |

（比 wave3 报告里「107 次」略高，是这几波新功能——T41 星表、T08 道路灯带等——新增的全屏 pass
自然带来的，不是本任务改动引入的；改后全部归零，符合预期。）

### 画质回归：4 个场景逐像素对比

用 `tmp/perf-6-8/pixel-diff.mjs`（headless Canvas2D 逐像素比较，输出每通道绝对差的均值 / 最大值 /
变化像素占比）。方法论：先测「同一份代码、两次独立截图」的噪声底（TAA 云、翼尖颤动、海面 /
城市灯点的 hash 抖动、真实网络瓦片加载进度都会带来天然差异，README 坑点也提过这一条），
再拿「改前 vs 改后」的差和噪声底比较——量级相当就是零回归，量级显著更大才是真的问题。

| 场景 | 同代码噪声底（mean） | 改前 vs 改后（mean） | 结论 |
| --- | ---: | ---: | --- |
| noon-cumulus | 0.49 | 0.71 | 同量级，零回归 |
| fuji-day | 0.24 | 0.30 | 同量级，零回归 |
| typhoon-bands | 0.53 | 0.53 | 几乎相等，零回归 |
| night-city | 3.97（严格对照，见下） | 3.97 | 零回归 |

night-city 踩了两个和代码无关的测试方法论坑，记在「坑点」一节；用严格对照（强制关翼尖频闪 +
等到 `ground.pending === 0` 才截图）复测后，改前 vs 改后与同代码两次独立截图的差完全同量级。

## PERF-8：地面 clipmap 纹理上传分帧

### 测量方法

`tmp/perf-6-8/stream-profile.mjs`：`addInitScript` 钩住 `WebGL2RenderingContext.prototype.texSubImage3D`
（按 format/type 估算字节数）和全局 `requestAnimationFrame`（记录真实挂钟帧间隔，`__voyageStartup`
出现之后才开始记，避免把加载遮罩的 rAF 也算进去），每帧记一行 `{dt, texBytes, texCalls, pending}`。
两个场景，均为 20–30 秒真实挂钟采样：

- **cold**：冷启动后 `window.__voyage.setPreset('fuji')`，不等待，直接开始记录（对应「fuji-day 冷启动后」）。
- **route**：`setPreset('hnd-cts')` 后 `director.setActive(true); director.rate = 60`（对应
  「route-hnd-cts 沿航线加速飞行」，README 坑点里提到的连续航程加速会让细级别持续重建）。

### 改前（数字来自对照 worktree 5286，未改代码）

| 场景 | 帧间隔 dt（pending>0，ms） | 有 texSubImage3D 的帧 | 其中 dt>8ms 占比 | 有 tex 帧的均值 dt |
| --- | --- | ---: | ---: | ---: |
| cold（fuji-day） | mean 6.8–7.2 / p95 11.2 / max 93–111 | 17 | 6–12%（run-to-run 波动大，样本少） | 7.0–7.6 ms |
| route（hnd-cts ×60） | mean 6.7–6.8 / p95 7.6 / max 73–106 | 52–64 | **64–67%** | **21–24 ms** |

route（加速航程）场景信号清晰、可重复：两轮独立测量都是 64–67% 的「有上传」帧超过 8 ms，
均值 21–24 ms，个别到 50–60 ms；一个批次（同一级的 albedo + water + height，共 8.52 MB，
3 次 `texSubImage3D`）挤在同一个真实动画帧里几乎必然超预算。cold（静止在 fuji 上空，只有
1× 真实时间的自然巡航位移）场景样本少（一次采样窗口只有 17 次上传），run-to-run 波动大，
不如 route 稳定，但不矛盾（也观察到过 2/17 次超 30–47 ms 的尖峰）。

另外两次都观察到一次性的 69,074,944 字节 / 5 次调用的巨批（`texCalls` 一次性拉高，出现在
`setPreset` 触发 `ground.reset()` 之后紧接着的那一帧）——这不是逐级重建，是纹理**初次创建**时
three.js 把整个 7 层 `DataArrayTexture`（占位数据）一次性上传的固有开销，和「流式加载」无关，
每次翻到新地点必然发生一次，不受本任务改动影响，仅供参考。

### 改法

`src/ground/clipmap.ts`：`build()` 里原来 3 次 `this.upload(...)`（album / water / height，各自
触发一次 `texSubImage3D`）在同一个 JS continuation 里同步做完，紧接着就把这一级标记 `valid`。
改成排队：

- 新增 `UploadJob` 接口与 `GroundClipmap.uploadQueue`；`build()` 数据齐了之后 `queueUpload(jobs, after)`
  把 3 个上传任务和一个「全部传完之后要做的事」（`l.cx/cz/valid/maxHeight/grid` 与 `levelUniform`）
  一起排进队列，不再立刻做。
- `update(x, z)`（每帧调用一次）开头先 `drainUploads()`：**每帧最多真正执行一个任务**（一次
  `texSubImage3D`），批次内 3 个任务全部执行完才触发 `after()`，把这一级标记为 valid。
- `l.building` 撑到 `after()` 才清（不是任务入队时就清），避免同一级在纹理还没真正传完时
  被 `update()` 的重建循环判定「空闲」而重复触发重建。
- `reset()`（换预设 / 换起点）时清空 `uploadQueue`：排队里的都是旧生成的数据，马上要被新一轮
  重建覆盖，丢掉即可，避免浪费上传带宽。

这是「按块分帧上传」而不是严格的「按行」：三张纹理（1024²×4B 的 albedo/water、256²×2B 的
height）本身作为一个整体分到最多 3 帧里，没有再把单张纹理拆成行范围。理由见下面「为什么不做
真正的逐行上传」。

### 改后（同一台机器、同一对场景复测）

| 场景 | 有 texSubImage3D 的帧 | 其中 dt>8ms 占比 | 有 tex 帧的均值 dt |
| --- | ---: | ---: | ---: |
| cold（fuji-day） | 49 | **6%**（3 帧） | **6.99 ms**（基本贴回基线 6.3–6.8 ms） |
| route（hnd-cts ×60） | 322 | **12.7%**（41 帧） | **8.88 ms**（基线约 7.0–7.3 ms） |

route 场景的「上传帧超阈值比例」从 64–67% 降到 12.7%，均值从 21–24 ms 降到 8.88 ms——直接
证据是改后的按字节直方图里，绝大多数上传帧的 `texBytes` 是单张纹理（131,072 或 4,194,304），
`texCalls` 恒为 1（原来是 3，偶发 5），符合「每帧最多一个任务」的设计。

### 为什么不是真正的逐行上传，以及还剩下什么

排查过程中发现：即便是**单独一次** 3 次调用 / 8.52 MB 的批次（改前），也不是每次都慢——同样的
字节数，有时 3–6 ms（正常），有时 20–60 ms（尖峰），这提示尖峰很可能不是纯粹的「字节数 / 带宽」
问题，而是与该批次上传发生的那个 JS 任务里**还在做什么别的事**（`coarseGrid()` 的 CPU 循环、
`packRoadsAsync` 的 Worker 消息处理、或者恰好落在一次 GC）叠加在一起有关，也可能与 ANGLE/D3D11
驱动对「正在被着色器采样的纹理」做写后读同步（write-after-read）有关系——两种猜测都没有在本任务
预算内坐实根因，只是"把 3 次调用摊到 3 帧"这个粗粒度的缓解已经把大部分批次从「3 次挤一帧」
变成「1 次一帧」，效果符合预期，就没有再往下做真正按行拆分单张纹理的 `gl.texSubImage3D`
手工调用（three.js 的 `DataArrayTexture.addLayerUpdate` 只支持整层上传，要做真正的逐行拆分得绕开
three 的纹理管理、自己拿 `renderer.getContext()` 手写 `texSubImage3D`，风险和复杂度明显更高，
在「测试节制」的口径下没有再做）。

**改后仍然观察到的、更大也更频繁的尖峰（60–105 ms 量级，`texBytes=0`，即与 `texSubImage3D` 无关）**：
route 场景改后 top-15 最慢帧里有 12 个 `texBytes=0`。这些不在 PERF-8 的范围（题目明确说
「改成按行 / 按块分帧上传」，即 GPU 上传这一件事），初步归因（未验证，供开分析用）：
- `clipmap.ts` 的 `buildImagery` / `buildHeight` / `buildWater` / `buildNight` 里各有一次
  `ctx.getImageData(0, 0, RES, RES)`（1024×1024，或 256×256 的 `buildHeight`），这是同步的
  Canvas 像素读回，浏览器实现里可能有拷贝 / 格式转换开销；
- `packRoadsAsync` 往 `road-raster.worker.ts` 转移大块 `ArrayBuffer`（`postMessage(..., [transferList])`）
  再等回调，往返本身有调度延迟；
- 每级重建会新分配好几个 4 MB 量级的 `Uint8Array`/`Uint8ClampedArray`（`buildImagery`/`buildWater`
  的 `ImageData.data`、`buildNight` 的 `out` 数组等），密集分配容易触发一次 GC 停顿；
- `coarseGrid()` 有一个 `GRID×GRID×(64+128)` ≈ 19.7 万次迭代的 CPU 循环（现在还是同步跑在
  `after()` 回调里，紧跟着最后一次上传，没有分帧）。
- 复现方法：`node tmp/perf-6-8/stream-profile.mjs --port <端口> --mode route --preset hnd-cts --rate 60 --duration 30`
  （脚本未提交，在 `apps/voyage/tmp/perf-6-8/`，需要的话可以誊一份到 `scripts/`），看
  `spikesOver8ms` 里 `texBytes:0` 的条目，`pending` 字段能看出当时还有多少瓦片在飞。
- 协调者已认领：另开 **PERF-9** 跟踪。

## 测试记录

- `pnpm typecheck`：通过。
- `pnpm check:glsl`：全部通过（28 个程序，sampler 数、CRLF、重名检查都过）。
- `pnpm build`：通过，`dist/assets` 无 0 字节文件。
- `node scripts/dev-browser.mjs check --port 5246`：改动前后各测一次，均无 console error / pageerror。
- 未跑全量回归（13 场景）——按 DEV_SOP「测试节制」，只测了任务指定的 4 个场景 + PERF-8 涉及的
  ground 两个场景，协调者收尾时可以再跑一次全量回归留档。

## 归属确认

只改了 `src/render/pass.ts`、`src/ground/clipmap.ts`，没有碰 `clouds/*`（除只读查看确认深度/累积
安全性）、`wonders/*`、cabin / seats、stars、道路相关文件（T43 在改）。

## 临时脚本（未提交，在 `apps/voyage/tmp/perf-6-8/`）

- `clear-count.mjs`：数 `gl.clear` 调用次数（每帧，批渲对照）。
- `pixel-diff.mjs`：两张同尺寸 PNG 逐像素绝对差（均值 / 最大值 / 变化占比）。
- `stream-profile.mjs`：`ground.pending>0` 期间的真实帧间隔 + `texSubImage3D` 字节数采样（cold /
  route 两种模式）。
- `shot-settled.mjs`：应用场景后一直等到 `ground.pending===0`（而不是 `shots` 默认的 `<5`）且强制
  关掉翼尖频闪再截图，专门用来排除下面两条坑点里的假信号。

这几个脚本如果后续任务还要用，建议誊一份进 `scripts/`（比如收成 `dev-browser.mjs` 的子命令，
参考 PERF-2/PERF-5 交接里对 `passes.mjs` 之类脚本的处理方式）；本任务按范围没有主动改
`scripts/dev-browser.mjs`。

## 坑点（建议转写进 README，按仓库纪律「踩到新坑当场写」，这里先记录，转写由协调者统一做）

- **night-city 这类夜景 + 真实地面瓦片场景，两次独立截图天然噪声很大，不能直接拿 pixel-diff
  的绝对数字判断回归**：
  1. 翼尖频闪（`main.ts` 的 `uStrobe`）按 `performance.now()` 真实挂钟相位闪（每 1.1 秒里约
     9% 占空比的高亮窗口），两次独立启动的页面在窗口外随机时刻截图，撞上「一次频闪、一次没闪」
     的概率不低，频闪亮起时整个窗外一大片过曝白雾，会把 mean diff 从个位数拉到 30+。
     识别：diff 图里如果亮部集中在翼尖周围一大片过曝区域，先怀疑频闪相位，不是画面回归。
     排除：`window.__voyage.wingDebug.strobe = 0` 强制关掉再截图对比。
  2. `dev-browser.mjs shots` 的 `ground:true` 字段只等到 `ground.pending < 5`（见 `scenarios.mjs`
     的 `applyScene`），不是等到真正的 0；两次独立截图受真实网络瓦片加载速度影响，「差 4 个瓦片
     还没到」的完整度不一样，城市灯光图案的细节量就会有肉眼可见差异，diff 会显著偏高。
     识别：diff 集中在地面纹理细节（道路灯带的疏密），不在窗框 / 舱内。
     排除：自己写等待循环轮询 `window.__voyage.ground.pending === 0`（见本任务的
     `shot-settled.mjs`），确认两边都完全加载完再比较。
  两条一起排除后，night-city 的 mean diff 落回 3.97，和其他没有这两个干扰源的场景的噪声底
  同量级。
- **本机重复大量测试 `route-hnd-cts` 60× 加速航程，没有实测触发 EOX 限流**（README 提过
  「60× 每分钟约 7000 个 EOX 请求会被限流」），但测试期间做过几十次这类高强度请求，值得以后
  留意：如果哪次复测发现 `ground.pending` 长期降不到 0，先怀疑限流，而不是代码出了问题。

## 结论

- PERF-6：确认关 `autoClear` 对本仓库这种「全屏三角形 + 无 discard + 无 GL blending」的渲染架构
  是安全的，`gl.clear` 从约 115–119 次/帧降到 0，画质零回归。收益本身很小（wave3 报告估计
  < 0.1 ms/帧，本任务没有单独为它测 GPU 时间，量级不值得——测量噪声本身就有几十微秒到几百
  微秒），但改动风险低、一次性做完，且清单本身对以后新增全屏 pass 有参考价值（新 pass 默认不用
  担心 clear，除非引入了 GL blending 或 discard，这两种情况的判断标准也写进了类头注释）。
- PERF-8：确认存在 > 8 ms 的尖峰，且与 `texSubImage3D` 有稳定、可复现的相关性（route-hnd-cts
  场景下 64–67% 的上传帧超阈值）；已实现按块分帧上传，把这个比例压到 12.7%，均值贴回基线。
  同时发现了一类更大、与上传无关的尖峰（60–105 ms），已如实记录复现方法和初步归因，交给
  PERF-9 跟进，本任务没有动手修（不在归属范围、也没有把握确认根因）。
