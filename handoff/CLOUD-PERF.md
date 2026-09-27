# 云程序第 4 波：PERF-1 / PERF-2 / T27 · 交接

- 分支：`worktree-agent-a4e5c912260f5a52c`（基于 master `56547ea`）；开发服务器 5250（在 apps/voyage 下 `npx vite --port 5250 --strictPort --host 127.0.0.1`）
- 状态：**已交付**，等审查。只改了 `src/clouds/clouds.ts`、`src/clouds/clouds.glsl.ts`（`weather.ts` 没动）。`main.ts` / `outside-pass.ts` 没动，接入片段见文末。

## 做了什么

### PERF-1：云步进改成单输出
- 步进程序原来是 MRT（颜色 + 深度两个颜色输出）。现在只有 `gl_FragColor`，云的深度写 `gl_FragDepth`（`depth / AERIAL_MAX_DISTANCE`，400 km），落在 `raw` 的 `DepthTexture`（32F）上；步进材质 `depthTest: true, depthWrite: true, depthFunc: AlwaysDepth`（关掉深度测试时 GL 不写深度）。resolve 从深度纹理读回再乘 400。
- 深度精度从半精度变成 32 位（重投影略准），颜色 / T 仍是半精度，位级不变。每像素写带宽 16 B → 12 B，非雷暴场景的云步进也快了 0.1 ms 左右。
- 兼容现在的 `main.ts`：它读的 `raw.textures[1]` 变成 undefined，赋给 `uCurrentDepth` 后 three 用空纹理顶上，下一次 `clouds.render()` 就改回深度纹理（实测无报错）。

### PERF-2：雷暴 / 台风的占据网格 + 软边云省步数
1. **占据网格**（`OCC_*`）：世界坐标 512×512×84 的 R8 3D 纹理（水平格距 0.5 km、覆盖 ±128 km；竖直 84 层均分云壳），格点上求一次雷暴 / 台风密度（lod 0 和 3.5 各一次取并集、不做细节侵蚀），有云写 1。查询用 mip 2 的三线性：2×2×2 块的平均 > 0 就算「可能有云」，等于向外膨胀至少 2.5 个格距，兜住格点之间的小突起和不同 lod 的表面差异。
   - 只在云步进程序里查（`#define CLOUD_OCC`，主步进和受光步进都查）；窗外程序（sampler 已满）、探针不查。
   - 前后台双缓冲，每帧建 12 层（7 帧建完）再换上来：天气变了前台立刻作废（这几帧照旧逐点求值），飞离网格中心 24 km 时前台继续用。整张一次建完在 5090 上是 5–9 ms，分帧后每帧约 1 ms。
   - 程序在第一次 `probe()` 时后台编译（compileAsync），编好之前步进照旧逐点求值；实测冷启动后约 1 s 编好。
2. **软边云省步数**（`SOFT_SKIP`）：雷暴的砧和雨幡、台风的卷云盖和雨带塔顶的砧（`gStormSoft`，由 `stormDensity` / `hurricaneDensity` 顺手记下）不做表面细化；这类云里一步的光学厚度 < 0.5 时下一步走 2 倍步长。乳状云口袋仍算硬边。原因：网格建好后，台风外围 / 雨带剩下的开销大半在「往上看穿过卷云盖」的像素上（每像素约 25 个有云采样点，每个 8 步受光步进），表面细化在这种本来就渐变的冰晶云上是白走。
   - 对照开关：`clouds.ts` 的 `const bool SOFT_SKIP = true;` 改 false 就回到改动前的走法。

### T27：云影改查云影图
- **先验证**：让 `cloudShadow` 恒返回 1，sunset-wing 的金色色块变成一整片连续耀斑 → 坐实「是云影裁出来的，不是云」（`tmp/screenshot/t27/sunset-wing-base-vs-noshadow.png`）。
- **根因**：旧版在窗外程序里逐像素沿太阳方向取 5 个固定点（点距约 4 km、不抖动），每个点按 4 km 弦长算光学厚度——哪怕只蹭到一点云，光学厚度也上百，影子是一刀切的二值边；相邻像素的采样点落在云的有 / 无两侧，边缘成了 1–2 像素的台阶，雷暴那边 12 个点对着 5 km 厚的砧，采样点进出砧就是一道道水平条纹。
- **试过的**：只把 lod 2 → 3.5（形状变圆，边照样硬）；光学厚度乘 0.25（边软一点，雷暴的条纹还在）。
- **现在的做法**：窗外程序只查一张按世界坐标铺开的「云影图」（`CLOUD_SHADOW_*`）：三级并排（±16 / ±80 / ±400 km，每级 512²，格距约 62 m / 312 m / 1.6 km），每个格点沿主光源方向取 48 个点，用**完整的**云密度（含雷暴、台风真实形状，带细节侵蚀），RGBA 存从 0 / 1 / 2 / 3 km 高度出发的透射率（高处地面按高度插值）。查询用三次 B 样条（4 次双线性取样），级与级之间交叉过渡。
  - 存透射率不存光学厚度：插值光学厚度再取 exp，边又会变回一刀切。
  - 必须带细节侵蚀：不侵蚀的大形偏胖，太阳低时几乎每条光线都撞上云，整片海都在影子里，sunset 的耀斑直接没了（`tmp/screenshot/t27/sunset-wing-3.png` 中间那张）。
  - 主光源方向变 > 0.01° 或飞离中心 > 4 km 时在后台缓冲里分 16 帧重建（整张 3–8 ms，分帧后每帧 0.2–0.5 ms）；云 / 天气参数变了一帧建完。中心对齐到最粗一级的格距，重建前后格点位置不变。
  - 窗外程序不再调任何云密度函数：sampler 16/16 → 14/16，离线 fxc 7.9 s → 5.0 s。`cloudShadow` 的调用点仍是 outside-pass.ts 那一个，签名没变。
  - README 坑点「台风云影用的是解析大形」不再成立（云影图用真实台风密度）；`hurricaneShadowDensity` 只剩探针在用。

## 数字（d3d11，RTX 5090，1600×1200，GPU 与其他代理共享；`passes.mjs` 按 pass 计时，master 5181 与本分支 5250 交替）

| 场景 | 云步进 master | 云步进本分支 | 变化 | 整帧 GPU master → 本分支 |
| --- | ---: | ---: | ---: | --- |
| storm-day | 6.87 / 7.09 / 7.08 | 2.20 / 2.20 / 2.21 | **−69%** | 8.20 → 3.14 |
| typhoon-eye | 9.77 / 10.31 / 10.09 | 4.21 / 4.20 / 4.20 | **−58%** | 11.09 → 5.13 |
| typhoon-bands | 9.30 / 9.41 / 9.39 | 4.67 / 4.65 / 4.64 | **−50%** | 10.40 → 5.59 |
| typhoon-outer | 10.19 / 10.33 / 10.28 | 3.96 / 3.96 / 3.93 | **−62%** | 11.28 → 4.87 |
| noon-cumulus | 0.42 / 0.42 / 0.43 | 0.32 / 0.32 / 0.32 | −25% | 2.17 → 1.95 |
| sunset-wing | 0.46 | 0.34–0.39 | −20% | 2.15 → 1.97 |
| clouds-variety | 1.17 | 0.87 | −26% | 2.21 → 1.82 |
| fuji-day | 0.49 | 0.36 | −27% | 1.51 → 1.33 |

窗外 pass：storm-day 0.56 → 0.42 ms，其余持平或略降（云影图查询比逐像素步进便宜）。

**冷启动（d3d11，`dev-browser cold`）**：本分支 13.3 s / 14.4 s，master 23.0 s（同一时段，master 里「云光线步进程序编译」即 MRT 重编 8.1 s；本分支 13–16 ms）。启动后切到 storm-day / typhoon-eye 没有 ≥ 1 s 的冻结（最长一帧 206 ms，是 applyScene 自己）。占据网格和云影图两个程序启动后约 1 s 编好。

**离线 fxc（`shader-budget.mjs`）**：cloud-march 8.0 → 8.6 s（+7%，多了网格查询）；outside-default 7.9 → 5.0 s（−37%，云影不再逐像素步进）。两个新程序（网格 / 云影图）不在 shader-budget 的清单里。

**画面**：
- 网格本身（同一页面、同一组 uniform，`CLOUD-PERF-occ.mjs`）：查 / 不查网格逐像素对比，storm-day 0–17 个像素 |ΔT| > 0.02，雨带 104 个像素 |ΔL| > 5%（受光步进简化版的裙边按「带子全连着」算，网格按完整版建，带子断开处不再挡光——更接近完整密度），平均相对差 ≤ 1e-4。
- 软边云省步数（16 帧抖动平均后对比，近似时域累积后的画面）：雨带 2334 像素 |ΔT| > 0.02、平均相对差 1.3e-3，噪声底（只换抖动帧）14047 像素、4.9e-3；台风外围 6532 vs 29898、3.0e-3 vs 1.1e-2；雷暴 4615 vs 44233、1.1e-2 vs 4.1e-2。都在噪声内，差异集中在砧 / 卷云盖的边缘。
- T27：`tmp/screenshot/t27/map2-zoom.png`（sunset 放大 3 倍、storm 放大 2 倍）边缘是几像素的渐变，没有台阶和水平细条。**观感变化**：sunset-wing 的耀斑区变大、成片；typhoon-outer 下半部的海面整片落在卷云盖的影子里（卷云盖从下看是不透光的灰顶，现在影子和它一致；旧版用解析大形，太阳能从盖子下面照到海面），见 `tmp/screenshot/t27/typhoon-outer-3.png`。

截图都在本 worktree 的 `tmp/screenshot/`（`t27/`、`final-5250/`、`final-5181/`、`cmp-*`）。

## 需要协调者接入的代码（main.ts，T18 合并后）

启动段（`requestAnimationFrame(() => setTimeout(async () => { ... }))` 里）：

1. **删掉** `interface CloudsInternals {...}`、`const cloudsInternal = ...` 和三行 `cloudsInternal.resolveMat.uniforms.uCurrent/uCurrentDepth/uHistory.value = ...`（Clouds 构造时已经绑好 uCurrent / uCurrentDepth，uHistory 空着编译没关系）。
2. 批次里把
   ```ts
   [cloudsInternal.marchMat, cloudsInternal.raw],
   [cloudsInternal.resolveMat, cloudsInternal.history[0]],
   ```
   换成 `...clouds.compileTargets(),`（步进、resolve、占据网格、云影图四个程序连同它们真正画进去的目标）。同时把批次上方注释里「云步进画进两张（MRT，颜色 + 深度），绑错的话首帧画的时候要按新布局同步重编一遍」改成：「步进是单输出（深度走 gl_FragDepth，PERF-1）。ANGLE/D3D11 上 MRT 程序并行编译后第一次 draw 会同步重编整个像素着色器，绑哪个目标都没用；新程序尽量单输出」。
3. **删掉**批次后的手动触发块
   ```ts
   {
     pass.render(cloudsInternal.marchMat, cloudsInternal.raw);
     pass.render(cloudsInternal.resolveMat, cloudsInternal.history[0]);
   }
   tick("云光线步进程序编译");
   ```
   以及它上面那段「compileAsync 批次刚 resolve 之后……卡住主线程约 3 秒」的注释和 SC-5 那条「上面这一下冷启动时实测约 4.8 s」的注释（根因就是 MRT 重编，已消除）。`boot.finish("shaders")` 保留在原处。
4. 程序数统计两行改成：
   ```ts
   const [[marchMat], [resolveMat]] = clouds.compileTargets();
   startup["云光线步进材质的程序数"] = programs(marchMat);
   startup["云 resolve 材质的程序数"] = programs(resolveMat);
   ```

不接入也能跑：占据网格 / 云影图会在第一次 `probe()` 时自己后台编译（约 1 s），这 1 s 里没有云影、雷暴步进不查网格；接入后首帧就有。

`scripts/lint-shaders.mjs`（不在归属内）建议在 cloud 那一段加两行，把两个新程序纳入离线检查：
```js
add("cloud-occupancy", clouds.occMat);
add("cloud-shadow-map", clouds.shadowMat);
```

## 坑（建议写进 README 坑点）
- **MRT 程序在 ANGLE/D3D11 上并行编译后，第一次 draw 会同步重编整个像素着色器**（与绑哪个目标无关）。新程序尽量单输出；需要第二个量时用深度附件（gl_FragDepth）或打包。识别：冷启动里某个程序第一次 draw 卡住的时间 ≈ 它一次完整 FXC 编译的时间。
- **three 的 3D 渲染目标每画一层都会按 `generateMipmaps` 重新生成整张 mipmap**：84 层就是 84 遍。只在最后一层打开（`updateOccupancy`）。
- **mip 做「膨胀」只能用到 mip 2**：R8 下 mip 3 是 512 个格点的平均，单个有云格点 1/512 < 0.5/255 会被舍成 0。
- **在同一页面里用 `material.clone()` 做 A/B 计时，第一个场景的数字不可信**：同一场景当作第一个场景测和排在别的场景后面测，查 / 不查网格两列都能差 2 倍（2.6 vs 4.7 ms）。没查清根因（怀疑 GPU 时钟状态），做法是只信「排在后面」的场景，最终数字用 master / 分支两个端口交替、每端口整轮跑。
- **云影不能插值光学厚度再取 exp**：边缘会变回一刀切，要插值透射率。云影图要用带细节侵蚀的密度，否则低太阳时整片海都在影子里。
- 太阳低时影子对光源方向极敏感：太阳高度 5°、云高 2 km 时太阳每动 0.25° 影子挪约 1 km，云影图的重建阈值要到 0.01° 这个量级，否则影子一跳一跳。

## 已知问题 / 没做的
- 台风外围、雨带里剩下的云步进开销大半是「往上看穿过卷云盖」的有云采样点和它们的受光步进；再往下降得动卷云盖的受光（例如按卷云盖的高度解析估计），会改画面，要美术总监看。
- 占据网格对雨带「受光步进简化版」的裙边更严格了（见上面画面一节），约 100 个像素亮了 5% 以上。
- 云影图只覆盖 ±400 km（再远在地平线的霾里），地面点高于 3 km 时按 3 km 那一层算（富士山顶附近云层里的影子略偏）。
- 夜里主光源是月亮，云影图照样按月亮方向建；月亮在地平线下时整张为 1。

## 怎么复现
- 云步进逐 pass 计时：`tmp/perf/passes.mjs`（本 worktree，从主仓库 `tmp/perf/` 复制，标签改成按 uniform 认 SC-5 以后的程序：`tmp/perf/label.mjs`）；`tmp/perf/ab.sh 1 <场景,...>` master / 分支交替。
- 同页 A/B（网格查 / 不查、变体材质对比、16 帧平均、噪声底、建网格 / 云影图计时）：`node apps/voyage/handoff/CLOUD-PERF-occ.mjs --port 5250 [--cmp x.json --avg 16]`。
- 逐像素计数（主步数、有云采样点、重密度求值数）：`node apps/voyage/handoff/CLOUD-PERF-stats.mjs --port 5250`。
- T27 截图 / 放大裁切 / 连续帧：`node apps/voyage/handoff/CLOUD-PERF-t27.mjs --port 5250 [--pre 窗外源码替换.json] [--spre 云影图源码替换.json] [--frames 8]`。
- 冷启动卡顿：`tmp/perf/stall.mjs --port 5250`（加了启动后切雷暴 / 台风、记长帧）。
