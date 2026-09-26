# voyage · 航行伴侣

模拟坐交通工具时看窗外风景的感觉。目前是飞机舷窗：物理大气、体积云与天气（雷暴、台风、闪电）、真实地理（卫星影像、地形、水体、城市夜光）、
海面、机翼、按真实尺寸建模的舷窗与舱内、真实的太阳 / 月亮 / 星空、真实航线。目标观感对标《微软模拟飞行》的窗外画面。

- 阶段规划与验收标准：[ROADMAP.md](ROADMAP.md)
- 任务看板（并行开发用）：[TASKS.md](TASKS.md)
- 开发流程（协调者 + 子代理）：[DEV_SOP.md](DEV_SOP.md)
- 进展与交接：[WORKLOG.md](WORKLOG.md)

## 使用

- 启动：仓库根目录 `pnpm dev:voyage`，打开 http://127.0.0.1:5181
- 鼠标移动 = 挪动头部（窗框视差），滚轮 = 靠近 / 远离舷窗，`H` 隐藏面板
- 时间：日期 + 当地时刻滑块，或用 60× / 600× 快进看日落

## 渲染管线（每帧）

```
CPU：太阳 / 月亮位置、航线与航向、颠簸、天气调度（闪电）、地面 clipmap 更新（异步拉瓦片）
  → 大气：天空视图 LUT（太阳、月亮各一张）+ 空气透视 3D LUT
  → 云：光线步进（层状云 + 雷暴 + 台风）→ 时间累积（带重投影）；每 4 帧一次云密度探针（异步读回）
  → 场景着色器（全屏）：舷窗几何（舱壁 / 内衬 / 遮光板 / 窗板）→ 机翼 → 窗外（地形求交或海面、天空、太阳、月亮、星星）
      + 云合成 + 远处飞机与航迹云 + 云地闪通道 + 窗板细节（划痕、油污、水痕）→ HDR（kcd/m²，alpha = 窗外遮罩）
  → 眩光 mip 链 → 测光（窗外 / 舱内分开）→ 适应 → 曝光 + 浦肯野 + AgX + 抖动 → 屏幕
```
启动时一次性计算：透射率 / 多次散射 / 天空辐照度 LUT、云噪声（GPU 生成后读回）、星图（CPU 溅射）。
首次打开或改了着色器后，着色器冷编译约 45 秒（见坑点），期间显示加载遮罩。

## 目录与模块

| 文件 | 内容 |
| --- | --- |
| `src/main.ts` | 创建渲染器与各系统、主循环编排（各 pass 调度）、`setPreset` / `snapAll` / `resize`、调试句柄 `window.__voyage` |
| `src/state.ts` | 共享类型 `VoyageState` / `Preset`、`CRUISE_PITCH_DEG`、`$` 小工具 |
| `src/flight.ts` | 预设（地点 / 航线）、大圆航向与距离、每帧飞行更新：`updateTurbulence`（颠簸、湿度、滚转）、`advanceFlight`（航向、倾斜转弯、高度爬升、俯仰、位置推进） |
| `src/ui.ts` | 面板 DOM 绑定 `setupUi`、信息栏 `updateInfo`、时间 / 高度控件同步 |
| `src/astro.ts` | 太阳 / 月亮位置、月相、当地→赤道坐标矩阵（astronomy-engine） |
| `src/sky-assets.ts` | 星图（BSC5 溅射成 HDR）、月面贴图 |
| `src/traffic.ts` / `src/weather.ts` | 远处飞机的运动；天气预设、雷暴 / 台风摆放、闪电调度 |
| `src/atmosphere/common.glsl.ts` | 大气参数、相函数、LUT 参数化、视线积分（所有着色器共用） |
| `src/atmosphere/luts.ts` | 透射率 / 多次散射 / 辐照度 / 天空视图 / 空气透视 LUT |
| `src/clouds/noise.ts` | 云的形状 / 细节噪声、天气图（GPU 生成） |
| `src/clouds/clouds.glsl.ts` | 云密度：层状云（天气场驱动）、雷暴（`towerShape`）、台风；云影 |
| `src/clouds/clouds.ts` | 云的光线步进、时间累积、云预设、密度探针 |
| `src/ground/geo.ts` / `tiles.ts` / `clipmap.ts` | 经纬度换算；瓦片加载（影像、地形、水体、夜光）；6 级 clipmap |
| `src/render/scene.ts` | 场景着色器主体：uniform 声明、`outsideRadiance`、主函数、`createSceneMaterial`（按顺序拼接下面几个片段） |
| `src/render/ocean.glsl.ts` | 海面：菲涅尔、12 波斜率场、风痕、`oceanRadiance` |
| `src/render/terrain-shading.glsl.ts` | 真实地面着色 `groundRadiance` |
| `src/render/wing-shading.glsl.ts` | 机翼着色 `shadeWing` 与航行灯 / 频闪 `wingLights` |
| `src/render/lightning.glsl.ts` | 闪电照度 `flashIlluminance` 与云地闪通道 `boltRadiance` |
| `src/render/view.glsl.ts` | 相机射线、舷窗尺寸 |
| `src/render/cabin.glsl.ts` | 窗洞内衬（漏斗）、窗板光源、划痕 / 油污 / 水痕 |
| `src/render/wing.glsl.ts` | 机翼 SDF、材质细节、机身投影 |
| `src/render/lights.glsl.ts` | 太阳 / 月亮 / 夜天光、直射主光源 `uKey*` |
| `src/render/stars.glsl.ts` | 星星、月亮圆盘 |
| `src/render/ground.glsl.ts` | clipmap 采样、地形求交、地形阴影 |
| `src/render/islands.glsl.ts` | 程序生成的岛屿（仅在关闭真实地理数据时） |
| `src/render/traffic.glsl.ts` | 航迹云与远处飞机 |
| `src/render/exposure.ts` / `bloom.ts` / `pass.ts` | 曝光与色调映射；眩光；全屏 pass |
| `scripts/build_stars.py` | 从 CDS 下载 BSC5，生成 `public/data/bsc5.json` |

**热点文件**：`src/main.ts` 和 `src/render/scene.ts` 几乎每个功能都会改到，并行开发时按 `DEV_SOP.md` 的规则分配（T01 已把它们拆小，但新增 uniform 仍要同时改 scene.ts 的声明块和 `createSceneMaterial`；新增面板状态要同时碰 state.ts / main.ts / ui.ts）。

## 调试与验证

- `window.__voyage`：`state`、`head`、`cloudUniforms`、`snapAll`、`clouds`、`resize`、`sceneMat`、`exposure`、`traffic`、`ground`、`weather`。
- `sceneMat.uniforms.uDebug.value`：1 内衬命中深度，2 亮度伪彩，3 内衬受到的窗光，4 内衬法线，5 海面本身，6 海面天空反射，7 海面内散射，8 海面粗糙度 / 像素覆盖，9 海面直射照度，10 闪烁格子。
- `window.__voyageStartup`：启动各阶段耗时。
- 截图前：把 `head` 固定在 `{tx:0, ty:0.02, x:0, y:0.02, tz:-0.3, z:-0.3}`、`uCloudOffset` 归零或设成固定值、隐藏面板（加 `hidden` 类），前后对比才有意义；截图放 `tmp/screenshot/voyage-*.png`。
- 测帧率前先 `page.bringToFront()`（窗口被挡住时 Chrome 会节流到 1 fps）。
- 找程序生成的岛：在浏览器里用 JS 复刻 `hash22` 列出岛心（见 WORKLOG「岛屿」）。

## 物理依据

| 部分 | 依据 |
| --- | --- |
| 大气 | Hillaire 2020, *A Scalable and Production Ready Sky and Atmosphere Rendering Technique*；透射率 LUT 参数化用 Bruneton 2017 |
| 海面耀斑 | Cox & Munk 1954 波面斜率分布，σ² = 0.003 + 0.00512·风速 |
| 太阳位置 | astronomy-engine（VSOP87），不含大气折射，与渲染一致 |
| 舷窗尺寸 | 窄体客机量级的估计值，不是某个机型的实测数据 |
| 机翼 | A320 量级的尺寸估计（后掠、上反、弦长、鲨鳍小翼），不是官方图纸 |
| 月亮 | astronomy-engine 算位置、视星等、相位；Lommel-Seeliger 反射 |
| 星星 | 耶鲁亮星表 BSC5（Hoffleit & Warren 1991），CDS V/50 |

## 数据来源与许可

| 文件 | 来源 | 许可 |
| --- | --- | --- |
| `public/data/bsc5.json` | 耶鲁亮星表第 5 版，CDS VizieR V/50，`scripts/build_stars.py` 生成 | 公有领域 |
| `public/data/moon_2k.jpg` | Solar System Scope「2k_moon」（基于 NASA LRO 数据） | CC BY 4.0，需署名：Solar System Scope |
| 卫星影像（运行时拉取） | EOX Sentinel-2 cloudless 2020（`tiles.maps.eox.at`） | CC BY-NC-SA 4.0，需署名；仅限非商业 |
| 地形（运行时拉取） | AWS Terrain Tiles，Terrarium 编码（`elevation-tiles-prod`） | 开放数据，各来源署名见其说明 |
| 水体（运行时拉取） | OpenFreeMap 矢量瓦片的 water / waterway 图层 | © OpenStreetMap contributors，ODbL |

**经验近似（不是物理量，后续要替换）**：舱内受窗外光的系数、夜间自动曝光的目标中灰曲线、水体反射率取值。代码里都标了注释。

## 坑点

- **three r186 的 `ShaderMaterial` 设了 `glslVersion: GLSL3` 就不再定义 `gl_FragColor`**，着色器报 `'gl_FragColor' : undeclared identifier`。
  修法：不设 `glslVersion`。WebGL2 下 three 仍然按 `#version 300 es` 编译，并自动声明 `pc_fragColor` 和 `gl_FragColor` 别名。
- **最终输出着色器 include `<dithering_fragment>` 前，要先 include `<common>` 和 `<dithering_pars_fragment>`**，否则报 `dithering` / `rand` 找不到。three 只给内置材质自动加这些声明。
- **海面天空反射不能再乘相机→海面的透射率**。天空视图 LUT 是从相机算的，本身已经包含这段衰减。
  现象：黄昏时地平线下方有一条细暗线。起初以为是 LUT 在地平线处跨行插值，改了夹取以后暗线还在，才找到真正原因。
  修法：反射贡献 = F·(L相机(反射方向) − 内散射(相机→海面))。LUT 的地平线夹取也保留了，它本身没错。
- **`fwidth` 做抗锯齿要设上限**：视线几乎贴着舱壁时，平面交点在无穷远处，导数巨大，会把遮光板、内衬、舱壁的颜色混在一起。
- 半精度浮点最大 65504：太阳圆盘的辐亮度约 1.8e6 kcd/m²，写进 HDR 目标前要夹到 6e4，否则变成 Inf，把测光也带坏。
- **云影起点不能正好落在球面上**：海面点 r = BOTTOM，对地球求交的根在 0 附近正负抖动，云影随机丢失。把起点抬高 10 m。
- **太阳的辐亮度会冲爆半精度**：要有眩光，HDR 目标必须是 32 位浮点，否则太阳被截断成 6e4，光晕能量少了 30 倍，只剩一个小白点。
- 渲染到 3D 目标用 `renderer.setRenderTarget(target, layer)`：第二个参数在 3D 目标上就是层号。
- `Data3DTexture` 设 `generateMipmaps = true` 后，three 上传时会自动生成 mipmap。远处的云必须用 mip 采样，否则会严重闪烁。
- **低空时耀斑侧面有一道「竖直断层」，不是 bug**：那是耀斑波瓣的边缘。耀斑中心过曝，又是平滑的高斯分布，所以边界显得锐利；换风速后边界会跟着移动。
  排查时先后怀疑过风痕（确实太陡，已经放软）、闪烁、云影，用 `uDebug` 5–10 逐项排除后才确认。以后判断方法：改风速，看边界是否移动。
- 调试模式 3、4 的覆盖条件曾经写成 `uDebug >= 3`，把后来加的 5–10 全盖住了，窗口一片黑。加新的调试模式时，要检查已有的判断条件。
- 1×1 的曝光适应目标要用 `FloatType`。半精度在对数亮度约 8 附近的步长是 0.004，每帧的微小变化会被吞掉，适应会卡住。
- **分支和循环里不要用屏幕导数**（`fwidth`、`dFdx`，以及隐式求导的 `texture()`）：D3D 会报 X3595，结果没有定义，边缘可能闪烁。
  要么把导数挪到函数开头、任何分支之前；要么用解析的像素覆盖范围（距离 × 像素张角）；要么用 `textureLod` 显式指定 mip。
- 用 Python 做「删除第一处匹配」时要小心：新插入的代码可能就是第一处匹配，结果删掉的是新代码，旧的反而留下了（报 `undeclared identifier`）。
- **测帧率前先把浏览器窗口切到前台**：Playwright 的窗口被别的窗口挡住时，Chrome 会把 `requestAnimationFrame` 节流到每秒 1 次，
  而页面仍报告 `visible`、有焦点。现象：每帧正好 1000 ms，关掉什么都一样慢。用 `page.bringToFront()` 后恢复正常（约 6 ms/帧）。
- **首次打开或改了着色器后要等很久（实测冷编译约 45 秒）**：Windows 上 Chrome 经 ANGLE 把 GLSL 转成 HLSL，交给 FXC 编译，FXC 会展开所有固定次数的循环，大着色器编译极慢。编译结果有磁盘缓存，之后打开不到 1 秒。
  用户决定：不为此做优化，只加加载遮罩（`#loading`）。如果以后要优化：把大循环的次数改成依赖 uniform，FXC 就无法展开。
  排查时的坑：看起来是新页面卡住，其实是 Vite 热更新让**旧页面**先重新加载、在冷编译里卡了 44 秒，新页面的 HTML 请求被推迟到那之后。
  用 `performance.getEntriesByType("navigation")[0].requestStart` 就能看出来。
- 样式表要在 `index.html` 里用 `<link>` 引用，不要在 main.ts 里 `import`：经由 JS 注入的话，脚本执行完之前页面是一片没有样式的控件。
- GLSL 里 `half` 是保留字（还有 `input`、`output`、`filter`、`sample` 等），拿来当变量名或结构体字段会编译失败。
- **Windows 上用 `sed -i` 改文件，Vite 可能收不到变更**：`sed -i` 是先删再建，文件监听有时会漏掉。浏览器会一直加载带旧 `?t=` 时间戳的模块，报「XX is not defined」，但文件里明明已经改好了。
  修法：`touch` 一下被改的文件。以后识别：报错栈里模块 URL 的 `?t=` 时间戳比最近一次修改早。
- 回归脚本在 Playwright MCP 的 `browser_run_code_unsafe` 里运行时**没有全局 `URL`**（`ReferenceError: URL is not defined`）。只在 Node 侧可用的全局不要假设存在；取 origin 用正则。以后识别：脚本一开始就抛 ReferenceError。
- 纯重构的验证：拼出最终着色器字符串前后逐行 diff（去空白）最可靠；截图比较要先用「同一份代码跑两次」估计噪声底（TAA 云、海浪相位、翼尖颤动、随机闪电都会带来差异，low-sea-glint 的平均差可到 7–9/255）。
- **场景着色器的 sampler 已满（16/16）**：ANGLE 上 `MAX_TEXTURE_IMAGE_UNITS = 16`，T14 加入 `uOceanWaves` 后场景程序活跃 sampler 正好 16。再加纹理会链接失败（日志可能为空）。修法：合并进纹理数组 / 图集。识别：`gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS)` 逐个数 sampler 类型。合并任何碰场景着色器的分支前都要数一遍。
- **FXC 会把常量上界的循环整个展开**：循环多、函数内联多时冷编译从 45 s 涨到 80–90 s，甚至超时 → `VALIDATE_STATUS false`（日志为空）→ `CONTEXT_LOST_WEBGL`，还会让共享浏览器 `GL_RENDERER = Disabled`。修法：循环上界写成「常数 + 恒为 0 的 uniform」（T02 的 `uTerrainSteps`、T06 的 `uLoopGuard`），重函数只调用一处。识别：冷编译时间暴涨、日志为空的链接失败。
- **测帧时间**：本机 GPU 远快于刷新率，rAF 间隔被锁在约 6.2 ms，看不出着色器代价；`gl.finish()` 在 Chrome 里也不等 GPU。用 `EXT_disjoint_timer_query_webgl2`，或「一个 rAF 里连渲染 N 帧后 readPixels 1 像素」。多个代理同时占 GPU 时任何计时都不可信。
- **真冷启动**：同一端口的着色器缓存会让「冷启动」其实是热的；测编译时间要用 addInitScript 往着色器注入随机数强制缓存不命中（审查脚本 `tmp/review-t02/cold.js`）。
- **海平面近处求交**：从 r≈6360 km 出发的通用球面求交在近处有约半米误差，会让海浪纹理出现与视角相关的颗粒噪点；`oceanRadiance` 里用 t = c / (−b + √(b²−c)) 重算。
