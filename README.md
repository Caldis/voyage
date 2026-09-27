# voyage · 航行伴侣

模拟坐交通工具时看窗外风景的感觉。目前是飞机舷窗：物理大气、体积云与天气（雷暴、台风、闪电）、真实地理（卫星影像、地形、水体、城市夜光）、
海面、机翼、按真实尺寸建模的舷窗与舱内、真实的太阳 / 月亮 / 星空、真实航线。目标观感对标《微软模拟飞行》的窗外画面。

- 阶段规划与验收标准：[ROADMAP.md](ROADMAP.md)
- 任务看板（并行开发用）：[TASKS.md](TASKS.md)
- 开发流程（协调者 + 子代理）：[DEV_SOP.md](DEV_SOP.md)
- 进展与交接：[WORKLOG.md](WORKLOG.md)
- 关键参数（视场 / 分辨率 / clipmap / LUT / 相机高度 / 云缓冲 / 奇观距离……，附出处文件与行号）：[research/PARAMS.md](research/PARAMS.md)

## 硬约束速查表

开工前先扫一眼这张表，每条链接到「坑点」里对应主题节。数字类条目由工具自动生成 / 校验（见各条说明），改代码后重新生成，不要手改数字。

| 主题 | 硬约束 | 详见 |
| --- | --- | --- |
| 着色器编译 | FXC 会把**常量上界的循环整个展开**：循环上限只能写「常量 + `uLoopGuard`（恒为 0 的 uniform）」，不能是裸常量；**重函数**（`oceanRadiance`、`cloudShadow` 等）全程序只留**一个调用点**；片元程序尽量**单输出**，多输出（MRT）必须显式 `layout(location = n)`；可选功能做成**按需编译的 `#define` 变体**而不是 uniform 分支——云步进里加一段「平时不走」的分支也会让整体步进变慢一倍（W00 实测） | [着色器编译](#pit-shader) |
| sampler 上限 | ANGLE 上 `MAX_TEXTURE_IMAGE_UNITS = 16`，场景 / 窗外程序满了会链接失败（日志可能为空）。当前用量见下表，`node scripts/lint-shaders.mjs --emit-table` 生成，`check:glsl` 自动比对 README 与实测，不一致就 FAIL | [着色器编译](#pit-shader) |
| 冷编译门槛 | 单任务 ≤ 10%（关键路径程序的离线 FXC 最小值），一波累计 ≤ 15%；实现代理自测只作参考，**权威判定在波次收尾的安静窗口统一测**（并行开发时离线 FXC 噪声 ±30–40%） | [着色器编译](#pit-shader)、`DEV_SOP.md` 第 5 节 |
| 精度 | 大气 LUT（天空视图）、云缓冲（raw / history）都要用**32 位浮点**（有 `OES_texture_float_linear` 时）：半精度最小次正规数 5.96e-8，暗场景 / 无月夜会下溢成阶梯或纯黑 | [大气与曝光](#pit-atmos)、[云](#pit-cloud) |
| 云缓冲格式 | 云的 history 缓冲是**两倍宽**（`2×w`）：左半是颜色，右半存 `(深度 × 不透明度, 不透明度)`（T38），读它一律走 `cloudBufferColor` / `cloudBufferDepth`，不要直接 `texture(uClouds, uv)`；右半**只在附近有高出海面的真实地形、或相机低于 1 km（火车 / 起降）时才写**（PERF-11，`uCloudDepthOn`，不写时 `cloudBufferDepth` 返回 0），别的用途要深度先改这个条件 | [云](#pit-cloud) |
| 云的天气变体 | 雷暴 / 台风密度只在 `#ifdef CLOUD_STORM` / `CLOUD_TYPHOON`（共用部分 `CLOUD_WEATHER`）里，默认云步进 / 云影图 / 探针预处理后不含它们（PERF-10）；**新的天气代码一律写进这些宏里**，新的「平时不走」的功能照样做成变体，并在 `lint-shaders.mjs` 登记 | [着色器编译](#pit-shader)、[云](#pit-cloud) |
| 窗外程序的变体 | 罕见光学（宝光 / 本机影子 / 幻日 / 晕）只在 `#ifdef OUTSIDE_OPTICS`、天幕层奇观只在 `#ifdef OUTSIDE_WONDER` 里，窗外默认程序（冷启动关键路径）预处理后不含它们（PERF-13，`check:glsl` 断言）；只有 `""` / `OW` / `DOW` / `DROW` 四个组合，选哪个只由 `outside-pass.ts` 的 `wantedOutsideKey` 决定；新的「平时不出现」的窗外效果照样写进宏，并让 `opticsWanted` / `wantedOutsideKey` 认得它 | [着色器编译](#pit-shader) |
| 窗外输出 alpha 语义 | 窗外 pass 输出的 alpha 不是占位不透明度，是 `1 + 能看到多少点星`（T41）；改窗外输出时**别把它写回 1** | [舱内与倒影](#pit-cabin) |
| 影像 A 通道语义 | 影像纹理的 A 通道**兼存道路照亮宽度**（T08）：< 0.5 表示「缺影像比例 / 2」，≥ 0.5 表示有影像、其余 7 位是宽度；判断缺瓦片一律用 `min(A·2, 1)`（`sampleGroundAlbedo`），不能直接读 A。G06 起影像 / 水体纹理带 mipmap，读 A 的编码值（道路宽度 / 有向距离）必须 `textureLod(…, 0.0)` 读第 0 级。G07 起 mip 由 Worker 生成（`mips.ts`，在 `packRoads` 之后）：影像 mip 的 A 是「有影像比例」的合法编码（比例 1 写 128 = 有影像、宽度 0，否则 `比例 × 127.5`），`min(A·2, 1)` 在 mip 上恰好是覆盖比例；水体 mip 的 A 一律 255。G03 的高清细节合成只改 RGB、且必须在 `packRoads` 之前做 | [地面与数据](#pit-ground) |
| 影像源与请求 | 影像源都走 `tiles.ts` 的 `ImagerySource` + `loadImageryTile`（按站点令牌桶 / 并发，`HOST_LIMITS`）；404 / 410 / 占位图负缓存，429 / 5xx / 网络错误**不**缓存；换源或混源不能改变 EOX 的低频色调（`landClasses`、城市灯点、路灯聚落地毯的阈值都按它定）；`__voyage.ground.imageryStats` 看各站点请求 | [地面与数据](#pit-ground) |
| 地面精度 | `GROUND_RES`（2048 / 1024）只在模块加载时定一次（纹理不可变尺寸 + 着色器常量），运行时不许改；**与画质档无关**（G07b）：画质档每次载入从「自动」起步、不记忆，只有面板「地面精度」的手动选择跨载入记忆（localStorage `voyage.groundRes`），下次载入生效；`?groundres=` 压过面板 | [地面与数据](#pit-ground) |
| 数据真实性与许可 | 通告 / 路段 / 地理数据逐字摘录并注明来源；匹配不上的写进报告，不猜、不补全；示例数据要标「示例」 | [数据来源与许可](#数据来源与许可) |
| 外部请求不带个人信息 | 请求头（User-Agent 等）不放邮箱 / 姓名 | 根 [AGENTS.md](../../AGENTS.md)、[工具与环境](#pit-tools) |
| OSM 数据用离线包 | 全线 / 大范围的 OSM 数据不走公共 Overpass（504 / 429 常客），用 Geofabrik 离线包 + 提取脚本（`scripts/rail/extract_osm.py`） | 根 [AGENTS.md](../../AGENTS.md) |

sampler 用量（自动生成，不一致时 `check:glsl` 会报错并提示重新执行 `node scripts/lint-shaders.mjs --emit-table`）：

<!-- DX-09:sampler-table:begin -->
| 程序 | sampler 上限 | 当前用量（引用中 / 声明） |
| --- | --- | --- |
| `scene-default` | 16 | 6 / 9 |
| `scene-economy` | 16 | 6 / 9 |
| `outside-default` | 16 | 14 / 18 |
| `outside-extras` | 16 | 14 / 18 |
| `outside-ground-detail` | 16 | 14 / 18 |
| `outside-rail` | 16 | 14 / 18 |
<!-- DX-09:sampler-table:end -->

## 使用

- 启动：仓库根目录 `pnpm dev:voyage`，打开 http://127.0.0.1:5181
- 鼠标移动 = 挪动头部（窗框视差），滚轮 = 靠近 / 远离舷窗，`H` 隐藏面板
- 声音（T11）：默认关；面板勾选「声音」或按 `M` 开启（浏览器要求用户手势），背景板模式下照常播放、`M` 仍可开关
- 时间：日期 + 当地时刻滑块，或用 60× / 600× 快进看日落
- 航向（T49）：面板「航向」一栏——「自动航线」（默认：沿大圆航线飞，到达终点后自动接下一段）、「保持航向」、「盘旋」（以当前位置为等待点飞跑道形等待航线，一直看同一片地面）；「◀ 左转 / 右转 ▶」点一下 15°、按住连续转，或拖「选定航向」滑块；「直飞机场」选 15 个东亚机场之一，沿大圆航线飞过去、到达后在上空盘旋。键盘 `←` / `→` 每次 5°（`Shift` 15°；焦点在输入框 / 下拉框里时不响应）。转弯按真实客机：坡度 ≤ 25°，滚转约 3°/s（25° 要 8 秒多才压满）
- 调试小地图（DX-06）：面板勾选「调试小地图」或按 `N` 开启（默认关），左下角显示航向 / 轨迹 / 航线 / 云回波 / 交通 / 奇观；点击地图切换 50 / 200 / 800 km 量程

## 渲染管线（每帧）

```
CPU：太阳 / 月亮位置、航线与航向、颠簸、天气调度（闪电）、地面 clipmap 更新（异步拉瓦片）
  → 大气：天空视图 LUT（太阳、月亮各一张）+ 空气透视 3D LUT
  → 云：光线步进（层状云 + 雷暴 + 台风）→ 时间累积（带重投影）；每 4 帧一次云密度探针（异步读回）
  → 窗外 pass（outside-pass.ts，全屏但只算本窗窗板以内）：地形求交或海面、天空、太阳、月亮、星星 + 云合成
      + 远处飞机与航迹云 + 云地闪通道，× 窗板透射率 → hdrOutside（全分辨率 32F）
  → 座椅 pass（seat-pass.ts，PERF-14）：本排 / 前排座椅 → hdrSeat（颜色 + 覆盖率）
  → 场景 pass（scene.ts，舱内合成）：舷窗几何（舱壁 / 内衬 / 遮光板 / 座椅）+ 读 hdrOutside + 窗板细节（划痕、油污、水痕）
      → HDR（kcd/m²，alpha 打包窗外遮罩与机翼参考，见 scene.ts 的 packWingRef）
  → 机翼 pass（wing-pass.ts）：读场景 HDR，把机翼与翼尖灯合成进窗外部分（窗上有水时用 WING_WET 变体）
  → 眩光 mip 链 → 测光（窗外 / 舱内分开，亮度 + 色度）→ 适应 → 曝光 + 舱内色适应 + 浦肯野 + AgX + 抖动 → 屏幕
```
启动时一次性计算：透射率 / 多次散射 / 天空辐照度 LUT、云噪声（GPU 生成后读回）、星图（CPU 上排星表格子 + 解码银河）。
首次打开或改了着色器后要冷编译着色器（Windows d3d11 上 SC-5 以后真冷启动约 17 秒，见坑点），期间显示加载遮罩。

## 目录与模块

| 文件 | 内容 |
| --- | --- |
| `src/main.ts` | 创建渲染器与各系统、主循环编排（各 pass 调度）、`setPreset` / `snapAll` / `resize`、调试句柄 `window.__voyage` |
| `src/state.ts` | 共享类型 `VoyageState` / `Preset`、`CRUISE_PITCH_DEG`、`$` 小工具 |
| `src/flight.ts` | 预设（地点 / 航线）、大圆航向与距离、每帧飞行更新：`updateTurbulence`（颠簸、湿度、滚转）、`advanceFlight`（航向、倾斜转弯、高度爬升、俯仰、位置推进）；自动驾驶（T49，`autopilotOf(state)`：沿航线 / 手动航向 / 直飞 / 跑道形等待航线，坡度与滚转速率按真实时间限制） |
| `src/ui.ts` | 面板 DOM 绑定 `setupUi`、信息栏 `updateInfo`、时间 / 高度控件同步 |
| `src/astro.ts` | 太阳 / 月亮位置、月相、当地→赤道坐标矩阵（astronomy-engine） |
| `src/sky-assets.ts` | 星图（RGB：BSC5 星表格子，每格最多一颗星，T41；A 通道是银河）、月面贴图 |
| `src/light-pollution.ts` | 城市光污染的天空背景（T09）：从地面夜光估算，只压银河的可见度 |
| `src/traffic.ts` / `src/weather.ts` | 远处飞机的运动；天气预设、雷暴 / 台风摆放、闪电调度；天气场 `WeatherField`（T19b：按经纬度 + 时间取样云型 / 云量，雷暴系统与台风的出生、寿命、漂移，粗略东亚海陆分布） |
| `src/director.ts` / `src/weather-director.ts` / `src/routes.ts` | 导演（T19a）：航段接力（T49：优先向前、提前转弯、掉头借遮挡）、手动导航（`setHeading` / `turnBy` / `hold` / `directTo` / `resumeRoute`）、爬升—巡航—下降剖面、时间流逝、遮挡排队切换（`request` / `onCover`）、换原点；天气驱动（T19b）：按天气场插值云参数、借遮挡换云族、在视野外生成 / 移除雷暴台风、奇观之门云墙 `openGate`；东亚航线网 |
| `src/rail/*` | 火车模式（TR02）：`data.ts` 读线路烘焙产物；`corridor.ts` 走廊坐标（里程 s、横向 d、高程）、平滑中心线、按规范公式估算的超高；`train.ts` 速度曲线（巡航 90 km/h、曲线限速、终点停车折返）与车体姿态（台车连线、超高侧倾、悬挂外倾）；`vibration.ts` 车体低频振动；`geodesy.ts` 线路 ENU ↔ 经纬度；`mode.ts` 接到 voyage 的相机 / 状态（`window.__voyage.rail`，`rail.teleport(s, dir)` 调试用）；`far-view.ts` / `far-view.glsl.ts` 窗外程序的火车远景变体（TR03，`#define RAIL`，近处国土地理院平面带、掠射步进、相对高度、轮廓抗锯齿）；单测 `node src/rail/rail.test.mjs`；飞机模式着色器零回归比对 `node src/rail/shader-parity.mjs <对照 voyage 根目录>` |
| `src/debug/minimap.ts` | 调试小地图（DX-06）：可选的角落 2D canvas 叠层，画本机 / 轨迹 / 航线 / 交通 / 奇观，以及从天气场采样的云回波「多普勒」图；不碰任何 WebGL 程序 |
| `src/atmosphere/common.glsl.ts` | 大气参数、相函数、LUT 参数化、视线积分（所有着色器共用） |
| `src/atmosphere/luts.ts` | 透射率 / 多次散射 / 辐照度 / 天空视图 / 空气透视 LUT；`setHaze` 设边界层霾 |
| `src/atmosphere/haze.ts` / `src/render/haze.glsl.ts` | 低空障眼法（T18）：边界层霾参数（按时段、地区、日期）、清晨谷地辐射雾 |
| `src/clouds/noise.ts` | 云的形状 / 细节噪声、天气图（GPU 生成） |
| `src/clouds/clouds.glsl.ts` | 云密度：层状云（天气场驱动）、雷暴（`towerShape`）、台风；云影 |
| `src/clouds/clouds.ts` | 云的光线步进、时间累积、云预设、密度探针 |
| `src/ground/geo.ts` / `tiles.ts` / `clipmap.ts` | 经纬度换算；瓦片加载（影像源抽象 `ImagerySource`、按站点限速、负缓存；地形、水体、道路、夜光）；7 级 clipmap（`setDetailContext` 决定最细两级要不要高清细节） |
| `src/ground/imagery-blend.ts` | 高清细节合成（G03，在地面栅格化 Worker 里跑）：国土地理院航拍的高频 × 局部反差匹配 + EOX 的低频色调，挡水面 / 云 / 耀斑等异常 |
| `src/ground/road-raster.ts` / `road-raster.worker.ts` | 夜间道路灯带（T08）：OSM 道路栅格成有向距离场 + 照亮宽度，在 Web Worker 里算；着色见 `ground.glsl.ts` 的 `groundRoadCoverage`、`terrain-shading.glsl.ts` 的 `groundRoadLights` |
| `src/render/scene.ts` | 场景（舱内合成）着色器：舱内 uniform 声明、主函数（舱壁 / 内衬 / 遮光板 / 座椅 / 窗板效果、alpha 打包）、`createSceneMaterial`（持有所有 pass 共用的 uniforms） |
| `src/render/outside-pass.ts` | 窗外着色器（SC-5）：`outsideRadiance`（地面 / 海面 / 天空的唯一调用点）、交通、闪电；`createOutsideMaterial` / `createOutsideTarget`；窗外变体（PERF-13：`""` / `OW` 罕见光学 + 天幕层奇观 / `DOW` 低空细节 / `DROW` 火车）由 `GroundDetailVariant` 管，选择只在 `wantedOutsideKey` |
| `src/render/noise.glsl.ts` | 窗外与舱内共用的小噪声（hash12 / vnoise / hash22 / fbm2）和 `uLoopGuard`；改它两个程序都重编 |
| `src/render/ocean.glsl.ts` | 海面：菲涅尔、12 波斜率场、风痕、`oceanRadiance` |
| `src/render/terrain-shading.glsl.ts` | 真实地面着色 `groundRadiance` |
| `src/render/seat-pass.ts` | 座椅 pass（PERF-14）：座椅的追踪与着色从舱内合成里拆出来，画到 `hdrSeat`（rgb 颜色、a 覆盖率），舱内合成按像素读回；灯光与舱内合成共用 `scene.ts` 的 `cabinLightsSetup` |
| `src/render/wing-shading.glsl.ts` | 机翼着色 `shadeWing` 与航行灯 / 频闪 `wingLights` |
| `src/render/optics.ts` / `optics.glsl.ts` | 罕见光学现象（T17）：宝光与本机影子（乘在云的辐亮度上）、幻日与 22° 晕（卷云单次散射）、太阳圆盘与绿闪（地平线亚像素裁切 + 三色色散 + 蜃景放大）；CPU 端按条件 + 分段随机决定出不出现、多强 |
| `src/render/lightning.glsl.ts` | 闪电照度 `flashIlluminance` 与云地闪通道 `boltRadiance` |
| `src/render/view.glsl.ts` | 相机射线、舷窗尺寸 |
| `src/render/cabin.glsl.ts` | 窗洞内衬（漏斗）、窗板光源、划痕 / 油污 / 水痕 |
| `src/render/wing.glsl.ts` | 机翼 SDF、材质细节、机身投影 |
| `src/render/lights.glsl.ts` | 太阳 / 月亮 / 夜天光、直射主光源 `uKey*` |
| `src/render/stars.glsl.ts` | 银河（物理定标 + 眼睛的对比度阈值）、月亮圆盘（窗外程序）；点星的亚像素点扩散 `starPoints`（舱内程序，T41） |
| `src/render/ground.glsl.ts` | clipmap 采样、地形求交、地形阴影 |
| `src/render/islands.glsl.ts` | 程序生成的岛屿（仅在关闭真实地理数据时） |
| `src/render/traffic.glsl.ts` | 航迹云与远处飞机 |
| `src/render/exposure.ts` / `bloom.ts` / `pass.ts` | 曝光与色调映射；眩光；全屏 pass |
| `src/audio.ts` | 声音（T11）：Web Audio 程序化合成（频域合成的可循环噪声床 + 发动机谐波 + 事件），`Soundscape`（可建在 OfflineAudioContext 上）/ `CabinAudio`（面板与主循环用的控制器）；`scripts/audio-check.mjs` 离线出频谱表 |
| `src/rail/sound-model.ts`、`src/rail/audio-rail.ts` | 火车声音（TR07）：接缝节奏的几何（车轴过接缝时刻）、道口警报规格与多普勒、广播时机（纯计算，node 可跑）；`RailSoundscape` / `RailAudio`（火车模式下 `CabinAudio` 改驱动它，飞机噪声床静音、雷声照常）。`scripts/audio-check.mjs --rail` 离线出节奏周期、多普勒、频谱 |
| `scripts/build_stars.py` | 从 CDS 下载 BSC5，生成 `public/data/bsc5.json` |

**热点文件**：`src/main.ts` 和 `src/render/scene.ts` 几乎每个功能都会改到，并行开发时按 `DEV_SOP.md` 的规则分配（T01 已把它们拆小，但新增 uniform 仍要同时改 scene.ts 的声明块和 `createSceneMaterial`；新增面板状态要同时碰 state.ts / main.ts / ui.ts）。

## 调试与验证

- `window.__voyage`：`state`、`head`、`cloudUniforms`、`snapAll`、`clouds`、`resize`、`sceneMat`、`seatMat`、`hdrSeat`（PERF-14，座椅单独 pass 的材质与目标）、`hdrWing`（DX-22，机翼 pass 真正画进去的目标）、`wingVariant`（PERF-14，机翼湿窗变体：`shownWet` 这一帧画的是不是湿窗版、`wet` 湿窗材质本身）、`exposure`、`traffic`、`ground`、`weather`、`minimap`（DX-06 调试小地图，见下）、`optics`（T17，见下）、`freeze`（DX-08，DX-22 加了 `cloudLive` 选项，见下）、`sunAltDeg()` / `moonAltDeg()`（DX-12，太阳 / 月亮几何高度角，度；main.ts 每帧更新的 `lastSunAlt` / `lastMoonAlt`，不重复算一遍天文位置——`dev-browser.mjs shots` 往截图 JSON 里附这两个数就是靠它们，见下）。
- **冻结（DX-08，`__voyage.freeze(on, opts?)`）**：`freeze(true)` 钉住喂给主循环的挂钟时间（内部 `dt` 因此恒为 0），
  位置推进、航向、头部平滑跟随、天气（含闪电）、曝光适应、翼尖 / 航行灯频闪相位（都是按 `dt` 或冻结时刻的挂钟秒数算的）
  全部停在冻结那一刻；云的光线步进另有一个不受 `dt` 控制、每次调用都推进的抖动相位（时间累积重投影用），冻结时改成
  整次跳过、直接复用已经画好的那一份缓冲，不然「同一帧」还是会用不同抖动相位重新步进一次，画面有测得出的残留噪声。
  冻结后连续渲染逐像素一致（用 `dev-browser.mjs flicker --step 0` 验证过，两帧的 `compare.mjs --diff` 是 0/0/0），
  可以拿两张截图相减定位「这一版改动到底动了哪些像素」，不必依赖「同一份代码跑两次」的噪声估计。`freeze(false)` 解冻，
  恢复正常挂钟时间（不会跳变，只是从冻结那一刻继续走）。`shots --freeze` 是它的封装，见下。
  **`freeze(true, { cloudLive: true })`（DX-22）**：其余全部照常冻结，但云不跳过——继续按真实 rAF 节奏渲染 /
  做时间累积重投影（`clouds.render` 内部的 `uFrame` 只受调用次数控制、不读 `dt`），用来单独测云自己的时间波动
  （位置 / 航向 / 头部 / 时间 / 曝光 / 频闪 / 地面都不动，波动来源只可能是云）。`shots --cloud-live` / `flicker
  --cloud-live` 是它的封装，见下。
  **`benchFrame` 现在也遵守冻结（DX-22）**：以前 `benchFrame(n)` 直接把挂钟往前推 `n×16 ms`，绕开了 `frame()`
  里 `t = frozenNow ?? now` 那层换算——`shots --pair` 在两张截图之间调用 `benchFrame` 只是想测个帧时间，
  却会把飞机位置、模拟时间、曝光适应这些按 `dt` 累积的状态真的推进掉，「同一机位」的第二张截图其实已经不是
  同一机位了（PERF-14 发现的现象：master 自比也有 5–48% 像素超阈值；带地面的夜景 `night-city` 同 js 两张
  差 8.9%，城市灯光整体挪动——根因是这段推进也带着飞机的世界坐标 `uCloudOffset` 一起走）。现在冻结时
  `benchFrame` 改成每次都喂 `frozenNow` 本身，状态不再被它推进；三个场景（白天舱内 `noon-cumulus`、带地面
  夜景 `night-city`、`wonder-jianmu-day`）`shots --pair` 同一份 js 跑两次，`compare.mjs --diff --threshold 8`
  验证 mean/p99/max/超阈值像素全部为 0（此前的临时绕法 `v.benchFrame = () => 0` 已不需要）。
- **罕见光学现象**（T17，`src/render/optics.ts`）：平时按条件 + 随机出现（宝光：云顶在下方且是水滴云、太阳在海平线以上、每 20 模拟分钟掷一次；幻日 / 22° 晕：卷云、每 30 分钟掷一次，常只出一侧；绿闪：每个日落都有色散，约三成日落有把它放大到看得见的逆温蜃景）。强制出现：URL `?optics=glory,halo,flash`（或 `all`），全关对照 `?optics=off`；运行时 `__voyage.optics.force = { glory: true }`、`__voyage.optics.disabled = true`；`__voyage.optics.status` 看当前强度 / 云滴半径 / 放大倍数。`__voyage.optics.pinGreenFlash(0.5)` 把模拟时间钉在绿闪那一刻（0 = 红色日像上缘刚落到海平线、1 = 绿色上缘落下；飞机在动，每帧重新对准），`pinGreenFlash(null)` 解除；`__voyage.optics.pixelOf(__voyage.sceneMat.uniforms[, 方向])` 算反日点（或任意窗外方向）落在屏幕哪个像素，找「宝光 / 幻日在窗里」的时刻用。几何上：宝光要座位背对太阳（如 wpac 左座 16:30），幻日在太阳两侧约 22°（wpac 右座 16:30 卷云）。自测场景见 `handoff/T17-shots.ps1`。
- **调试小地图**（DX-06，`src/debug/minimap.ts`）：面板底部「调试小地图」开关，或按 `N`（不在输入框里时）；默认关，纯 2D canvas 叠层，画在左下角（约 280×300、半透明深色底，不挡舷窗中心），关着时 `update()` 第一行就返回、canvas `display:none`，零开销。内容：本机（图标固定圆心，地图始终「航向朝上」）、已飞过的轨迹、当前航线（`director.leg` 的航段或 `state.preset.dest`）、远处的其他飞机（`traffic.ts`）、奇观（`wonders.active`）、以及「云的多普勒」——仿气象雷达回波图，背景网格从 `director.weather.field.sample()`（天气场）按经纬度采样云量 / 云型换算出回波强度，叠加当前**实际渲染中**的 `weather.storms` / `weather.hurricane`（不论天气是导演按天气场摆的还是面板手选的，雷达图都和窗外一致）。点击地图本体在 50 / 200 / 800 km 三档量程间切换。雷达网格（48×48）每约 800 ms 重采样一次，且分帧算（每帧最多 4 行），避免拖帧；台风的螺旋雨带是按角度做正弦调制的近似图形（用于「看起来像螺旋回波」），不是 `clouds.glsl.ts` 里真正的密度场（CPU 侧读不到那份数据）。
- `sceneMat.uniforms.uDebug.value`（窗外与舱内共用同一份 uniforms，1–4 在舱内程序，其余在窗外程序）：1 内衬命中深度，2 亮度伪彩，3 内衬受到的窗光，4 内衬法线，5 海面本身，6 海面天空反射，7 海面内散射，8 海面粗糙度 / 像素覆盖，9 海面直射照度，10 闪烁格子。
- **航向 / 接力调试**（T49）：面板底部「立即触发到达 / 接下一段（调试）」按钮 = `__voyage.director.forceArrive()`：不等飞到终点，立即走一次「到达」（自动航线接下一段，要掉头 > 90° 时照常排进遮挡队列；直飞模式转入盘旋）。其他句柄：`__voyage.director.ap`（自动驾驶：`mode` / `selHeading` / `turnDir` / `timeScale` / `hold` / `nextCourse` / `holdCourse`）、`director.setHeading(deg, dir?)`、`director.turnBy(±deg)`、`director.hold()`、`director.directTo("ITM")`、`director.resumeRoute()`、`director.nextLeg`（离终点 400 km 内预挑的下一段）、`director.describeNav()`。离线复现 / 单测（不开浏览器，几秒跑完）：`node --import ./handoff/T49-resolve.mjs --experimental-transform-types --no-warnings handoff/T49-test.mts`；按真实时间打印航向 / 坡度曲线与 > 60° 转向事件：同样的前缀跑 `handoff/T49-sim.mts [流速] [真实分钟] [预设]`。
- `window.__voyageStartup`：启动各阶段耗时。
- URL 参数 `?lut16`：大气 LUT 强制用半精度（T36 改前的行为、没有 32 位浮点线性过滤的设备），用来对照深暮光的阶梯。
- 截图前：把 `head` 固定在 `{tx:0, ty:0.02, x:0, y:0.02, tz:-0.3, z:-0.3}`、`uCloudOffset` 归零或设成固定值、隐藏面板（加 `hidden` 类），前后对比才有意义；截图放 `tmp/screenshot/voyage-*.png`。
- 测帧率前先 `page.bringToFront()`（窗口被挡住时 Chrome 会节流到 1 fps）。
- 找程序生成的岛：在浏览器里用 JS 复刻 `hash22` 列出岛心（见 WORKLOG「岛屿」）。

- **私有 headless 联调**（不用共享浏览器锁）：`node scripts/dev-browser.mjs check --port <端口>`（只开页面、等启动完成、收集 console error / pageerror，有错误就打印并以非 0 退出码报告，没有就退出 0；提交前用它比跑 `shots` 快得多，不用等每个场景 2.5 s 的稳定等待）、`shots --port <端口> [--only a,b]`（跑回归场景表 + 截图 + 帧时间）、`cold --port <端口>`（真冷启动）、`bench --port <端口> --baseline <对照端口>`（批渲帧时间两端口对照，附 GPU timer query）、`flicker --port <端口> --only <场景>`（DX-08，见下）。脚本会自动找本机 `ms-playwright` 缓存的完整版 `chrome.exe`，启动后校验渲染器不是 SwiftShader（用了 `chrome-headless-shell.exe` 或 `--use-angle=swiftshader` 会静默退化，见下面「坑点」）。GPU 被其他代理占满时可能报 `Target crashed`（等一等或换个时间再跑，`pnpm run` 套一层时偶发挂起，直接 `node scripts/dev-browser.mjs ...` 更稳，见 `handoff/DX.md`）。
  **`cold --wait-quiet` / `check|shots --respect-lock`（DX-10）**：`cold` 对负载敏感（编译在 CPU 上做），`--wait-quiet` 先等本机 CPU 占用降到 50% 以下再开始测（超时也会继续，不无限等）；`check` / `shots` 本身不持锁，但发现「测量锁」（`tmp/measure.lock`，见下面「测量锁」）存在时会打印一句提示（不阻塞），传 `--respect-lock` 改成先等锁释放再跑，给别的代理的离线 FXC / 真冷启动腾地方。
  **`cold --repeat > 1` 汇总（DX-22）**：以前每一轮的 `startup`（`window.__voyageStartup`，各阶段耗时）只是各打印一份，`--repeat` 传大了以后自己拿眼睛比哪个阶段稳定、哪个阶段来回跳很费劲。现在跑完自动按每个字段聚合 min/median/max（`--baseline` 时当前 / 基线两侧分别聚合），数值型字段直接聚合，字符串化的对象字段（PERF-14 加的 `startup["批次各程序编好（ms）"]`，`JSON.stringify({窗外: ms, 舱内: ms, 座椅: ms, 机翼: ms, "云#0": ms, ...})`——`startup` 的类型是 `Record<string, number | string>`，塞真对象会在最外层 `JSON.stringify` 整个页面状态时出问题，所以那边写成了字符串）会先解析再按子键分别聚合，一眼看出这一批并行后台编译里哪个程序是关键路径、稳不稳定。`--out` 的 JSON 从原来的裸数组改成 `{ results, summary }`（`summary` 只在 `--repeat > 1` 时才有）。
  **`shots` 的 `--out` 相对仓库根解析**（不是当前工作目录，worktree 里跑就是 worktree 根），不传就是 `tmp/screenshot/dev-<端口>`（T08 开发体验反馈踩过一次：写了 `../../tmp/...` 结果传到了仓库外面）；也支持绝对路径，原样使用。`scripts/compare.mjs`、`scripts/probe.mjs`、`scripts/passes.mjs`、`scripts/shader-budget.mjs` 的路径参数（`--out`、`--heatmap`、`--baseline`）都是同一套解析规则（DX-08 统一进了 `lib/chrome.mjs` 的 `resolveRepoPath`）。
  **`shots` 默认关闪电频闪**（DX-07）：调用 `weather.ts` 本来就留的调试开关（`window.__voyage.weather.hold = true` + `heldIntensity = 0`），不然截图偶尔会撞上一大团闪电白光，糊里糊涂当成回归差异（T08 开发体验反馈）；`--allow-flash` 恢复正常按泊松过程闪（雷暴 / 台风场景想专门看闪电时用）。`shots` 现在也会打印截图期间的 console error / pageerror 数（和 `check` 共用一份收集逻辑），不用另外再跑一次 `check`。
  **`shots --freeze`（DX-08）**：截图前调用 `__voyage.freeze(true)`（见上）钉住位置 / 航向 / 头部 / 模拟时间 / 曝光适应 / 闪电 / 翼尖频闪相位，冻结后连续渲染逐像素一致，适合拿两次 `shots` 的截图相减（配合 `compare.mjs --diff`）定位改动到底动了哪些像素，不必依赖「同一份代码跑两次」的噪声估计。
  **`shots --settle`（DX-08）**：等 `__voyage.ground.pending === 0` 再截，而不是原来给 `sc.ground` 场景用的更宽松的 `pending < 5`（够看大致画面，但地面瓦片可能还在陆续贴上来）；逐像素对比前建议加上，否则瓦片加载差异会被误判成回归。
  **`shots --pair '<js1>' --pair '<js2>'`（或 `--ab`，两个值同样靠重复传参，DX-12）**：同一页面、同一机位，先后拍 a / b 两张。要解决的问题：批量截图时 `applyScene` 等地面瓦片 / 舱等 / 云变体编译的这几秒到几十秒里，飞机一直按真实挂钟往前飞（`__voyage.freeze` 之前是「摆好场景」不是「摆好场景并原地冻结」），分两次单独跑 `shots` 拍「开关前 / 开关后」根本拍不到同一机位。用法：应用场景后，先把头部 / 云偏移**钉回**场景 JSON 写的值（`scenarios.mjs` 的 `pinGeometry`，等待期间飘走的位置重新对齐），再 `freeze(true)` 并把翼尖频闪钉死为灭（同下面 `--freeze` 的 PERF-13 反馈），接着依次跑 `js1`、`js2`（各是一段 `v = window.__voyage` 的脚本），各拍一张 `<场景>.a.png` / `<场景>.b.png`，JSON（`<场景>.a.json`/`.b.json`）里除了「截图 JSON 附加信息」（见下）还附 `pairJs`（跑的是哪段 js）与 `jsOut`（js 的返回值）。
  第二种用法 **`--pair '<js1>' --base-shader <端口|目录|提交> [--material sceneMat] [--define KEY[=VALUE] ...]`**（`--pair` 这时至多给一段「拍 a 之前」的预设置 js，可以不给，但必须显式传，哪怕是空字符串——见下面「`--base-shader` 必须搭配 `--pair`」）：a 是当前代码（可选先跑预设置 js）的样子，b 是把 `--material`（默认 `sceneMat`，点号路径同 `probe.mjs`，DX-22 起还认几个「运行时状态」路径，见下）这个材质的 `fragmentShader` 换成 `--base-shader` 指向的那棵树上的原文、重新编译后拍的样子，换回来再拍一张 `<场景>.a2.png`（噪声底：理论上应与 a 逐像素一致，`compare.mjs --diff` 对照验证「钉住再冻结」这套手法本身有没有引入误差，PERF-12/TR07 反馈——想对比着色器改动前后的画面，此前只能自己写一次性脚本手动换 `fragmentShader`）。`--base-shader` 给端口号时直接读那个端口页面上材质此刻的源码（要求那个端口的开发服务器正在跑）；给目录（另一个 voyage 应用根，或含 `apps/voyage` 的仓库根）或 git 提交时离线用 `vite` 的 `ssrLoadModule` 枚举程序（和 `shader-budget.mjs --baseline`/`--chain` 同一套手法，不用真起开发服务器，但 `--material` 得在内置的材质 → 程序 id 映射表里有，见 `MATERIAL_TO_PROGRAM_ID`）。换上的着色器如果编译 / 链接失败，会在截图期间的 console error 里看到，b 那份 JSON 的 `shaderError` 标 `true` 并在控制台提示「很可能是垃圾画面，不要当真」（呼应 C01 反馈：编译失败不能悄悄出一张坏图）。
  **`--base-shader` 必须搭配 `--pair`（DX-22）**：以前不传 `--pair`（只给 `--base-shader`）会被静默忽略——`parsePairJs` 直接返回 `null`，整段 `--base-shader` 逻辑都不会执行，只拍到一张普通冻结截图，很容易被误当成拍到了对照（TASKS.md DX-22 描述）。现在改成直接报错，提示补上 `--pair ''`（空字符串占位，表示不需要预设置 js）。
  **`--material` 的运行时状态路径（DX-22）**：除了字面点号路径（`sceneMat`、`outsideMat`、`wingMat`、`seatMat`……），还认几个「不看字面属性、看这一帧实际在画什么」的值——离线枚举（`--base-shader` 传目录 / 提交）没有「这一帧」的概念，这几个值只能配 `--base-shader <端口>` 用：
  - `cabinClass.current`：这一帧实际画的舱内合成材质（`cabinClass.mats[cabinClass.shown].cabin`），不是构造时传入的默认商务舱材质字面量（那就是 `sceneMat` 本身）——想换经济舱正在用的着色器，字面路径拿到的永远是商务舱。
  - `cabinClass.seat`：这一帧实际画的座椅 pass 材质（PERF-14 把座椅从舱内合成拆成了单独 pass，`cabinClass.seat()`），和舱内合成同一舱等但是两个不同的程序。
  - `wingMat.current`：这一帧实际画的机翼材质——窗上有水且 `WING_WET` 变体已编好时是湿窗版，否则是默认干窗版（`wingMat` 字面量本身）。
  - `wingMat.wet`：不管这一帧实际画的是不是它，强制取 `WING_WET` 变体本身；变体还没后台编好时是 `null`，会直接报错，不会悄悄拿默认材质顶替。
  - `clouds.marchMat`：当前实际画的云步进变体（`clouds.marchVariants.get(clouds.marchShown).mat`），不是字面属性（只是默认无天气 / 无奇观的变体，C03 审查发现「冻结工具对云是瞎的」同一类问题——天气 / 奇观 / 卷云场景下字面属性根本不是实际在画的那个）。
  **`--define KEY[=VALUE]`（可重复，DX-22）**：给 `--base-shader` 换上的着色器原文补 `#define`（叠加在材质原本的 `defines` 上，不给 VALUE 就是 `#define KEY 1`）——只换 `fragmentShader` 文本有时编不出想看的分支，例如想看经济舱变体的差异，得在换文本的同时加 `CABIN_CLASS_ECONOMY`。换回原文（拍 `a2`）时 `defines` 也一并复原。
  **换目标（DX-22）**：`--material` 对应哪个渲染目标（决定编译时绑什么帧缓冲，ANGLE/D3D11 对不上会在下一次真实渲染时同步重编）不再靠「在 `cabinClass.mats` 里做对象身份查找」猜——PERF-14 把 `cabinClass.mats[班次]` 从单个材质改成了 `{cabin, seat}` 对子后，原来那种查找方式永远查不到、会一律退化成 `hdrOutside`（协调者验收前发现）；现在按 `--material` 的值直接查表：`sceneMat`/`cabinClass.current` → 舱内合成目标，`seatMat`/`cabinClass.seat` → 座椅目标（`__voyage.hdrSeat`），`wingMat*` → 机翼目标（`__voyage.hdrWing`，本任务新增的调试句柄），`clouds.*` → 云步进 / resolve 各自的目标，其余落 `hdrOutside`。
  **截图 JSON 附加信息（DX-12）**：`shots`（含 `--pair`）写出的每份 `.json` 现在都带 `panel`（面板控件当前值，键是控件 id）、`date`（`#date` 输入框的值）、`sunAltDeg` / `moonAltDeg`（太阳 / 月亮几何高度角，度，读 `__voyage.sunAltDeg()`/`moonAltDeg()`）、`quality`（画质档，`{ tier, level }`，`tier` 是面板选的「自动 / 高 / 中 / 低」，`level` 是自动档实际落在哪一档）。回看一批旧截图时不用再去猜「这张当时是什么天、什么档位」。
  **`flicker`（DX-08，泛化自 `handoff/T08-flicker.mjs` + `T08-flicker.py` + `T43-crawl.py`）**：`node scripts/dev-browser.mjs flicker --port <端口> --only <场景> [--step 0.06] [--frames 20] [--crop x,y,w,h] [--block 48] [--debug N]`。`__voyage.freeze(true)` 之后按 `--step` 毫米（默认 0.06，亚像素）步进微移相机（`head.x`，绕过头部平滑——冻结时 `dt=0`，改 `head.tx` 目标追不上，所以直接改 `head.x` 本身），连拍 `--frames` 帧，输出：
  - 块能量变异系数（T08 法）：把画面切成 `--block` 边长的小块，每块总亮度随帧的 `std/mean`，抗锯齿做对了应接近 0；
  - 爬行指标（T43 法）：亮像素上 `|I(t+1) − 2I(t) + I(t−1)|` 的均值 ÷ 亮度均值，抓块能量法量不出的「台阶沿线爬」（块能量本身在台阶移动时也守恒）。
  `--crop` 不给就是整个画面；一次只测一个场景（`--only` 单选一个，或传一个 `--scene`）。用 `--step 0`（不移动）可以反过来验证冻结本身是不是真的逐像素一致（本次交付就是这样验收的）。
  **`--cloud-live`（DX-22，把 `handoff/C03-rt.mjs` 审查用的实时路径收成正式选项）**：`__voyage.freeze(true, { cloudLive: true })`，其余全部冻结，只有云照常渲染。默认 `--step` 改成 0（这时候不该再叠加相机微移，混进来分不清波动来源）、默认 `--frames` 改成 32（见下面「已知限制」）。除了原有两个指标，额外输出：
  - `relStd`：裁剪区里够亮的每个像素，luma 在 `--frames` 帧上的时间标准差 ÷ 均值，逐像素算完再取均值；
  - `relLow16`：同一批像素先按 16 帧盒平均去掉逐帧噪声，再算这条「低频」序列的标准差 ÷ 均值——层状云横纹这类肉眼看得出的明暗起伏是低频的，纯看 `relStd` 会被 TAA / 抖动这类逐帧就自己抵消的高频噪声盖住，`relLow16` 才是「云本身在变化」的量级（同 C03 审查发现的横纹问题）。
  对角高频（十字 / 菱形纹）不在 `flicker` 里算：拿输出目录里任意一帧跑 `compare.mjs --measure ... --json` 看 `adjDiffDiag`（见下面 `compare.mjs`）。
  **已知限制**：`analyzeFlicker` 是把整批截图连同 base64 `dataUrl` 一次性塞进同一次 `page.evaluate` 解码，不是逐帧读 GPU 缓冲；DX-22 交付前实测 48 帧会稳定复现 `page.evaluate: Target page, context or browser has been closed`（40 帧过、48 帧必炸），**这不是 `--cloud-live` 带来的新问题**——不带 `--cloud-live` 的原版 `flicker` 一样在 48 帧崩，只是以前没人试过这么多帧。默认帧数 32 是留了余量的稳妥值；确实需要更细的低频分辨率（更多 16 帧盒子）时，在机器空闲的时候用 `--frames` 显式调大，一次不要涨太多。根治需要把 `analyzeFlicker` 改成分批读回，没有列进本任务范围（建议排一个 DX 任务）。
- **临时场景（DX-05）**：`shots` 支持 `--scene '<JSON>'`（可重复，和 `--only` 可并用），不用再为每个任务新写一个 `T0x-shots.mjs`。字段和 `scenarios.mjs` 里 `SCENES` 数组的条目一致：`name`（必填，同时是文件名）、`p`（面板控件 id → 值，如 `preset` / `time` / `wing-pos` / `cabin-class` / `altitude` / `weather` / `coverage`）、`head`（数字只设 z，或 `[x,y,z]` 三元组——`[-0.42,0.1,-0.5]` 看前方、`[0.42,0.1,-0.5]` 看后方、`[0,0.02,-0.42]` 默认坐姿）、`offset`（云的世界偏移）、`wait`、`ground`（等真实地面瓦片）。例（商务舱看后方）：
  ```bash
  node scripts/dev-browser.mjs shots --port 5247 --out tmp/screenshot/x \
    --scene "{\"name\":\"biz-behind\",\"p\":{\"preset\":\"wpac\",\"time\":720,\"wing-pos\":\"8\",\"cabin-class\":\"business\"},\"head\":[0.42,0.1,-0.5]}"
  ```
  没有 `--scene` 时行为和以前完全一样（`--only` 过滤固定场景表，或跑全量表）。
  场景还可以带 `js`（T17）：一段 async 脚本，参数 `v = window.__voyage`，在场景设好之后、截图等待之前执行，返回值附在输出 JSON 的 `info` 末尾（`js: …`）。同一次 `shots` 的场景共用一个页面，`js` 改的调试开关会带到后面的场景，**每个场景都把自己要的开关写全**（例如关的对照写 `v.optics.disabled=true; v.optics.force={}`）。
  **`--scenes-file <场景.json>`（DX-12）**：文件里放一个场景数组（字段和 `--scene` 的 JSON、`SCENES` 条目一致），免去命令行 JSON 转义——Windows 上 PowerShell / Git Bash 各自的引号规则不一样，一个带 `js` 字段的场景拼成命令行参数经常因为转义错误直接报「不是合法 JSON」。路径相对仓库根解析（和 `--out` 一致），可以和 `--only` / `--scene` 一起用，三边选中的场景拼在一起跑。
  **`--query '<url 参数>'`（DX-12）**：附加到导航 URL（`?dev=<时间戳>&<这里给的参数>`），例如 `--query eox=2024` 或 `--query "optics=all"`（带不带开头的 `?` 都可以）。给「只受 URL 参数控制、面板上没有对应控件」的行为用，比如地面影像切年份（`?eox=`）、强制罕见光学现象（`?optics=`）。
  **场景 `p` 支持 `"view-preset"`（DX-12）**：给了这个键（值是 `seated` / `close` / `wing` / `ahead` / `behind` 等 `view-presets.ts` 里的预设 id）且没有同时给 `head` 时，头部位置由面板「视角」下拉本来就有的 `setView()` 决定，不用再像 `economy-ahead` 那样手抄一遍预设的 `fwd`/`y`/`z` 到 `head` 数组（抄错座位方向的符号就会看反）；显式给了 `head` 仍然优先。
  **`applyScene` 默认关闭连续航程与时间流速（DX-12）**：每个场景开始时都会 `director.setActive(false)` 且 `state.playRate = 0`，避免「上一个场景开着连续航程 / 加速播放，下一个场景在等地面瓦片 / 舱等 / 云变体编译的这几秒到几十秒里飞机继续跑、天继续暗」这种串味（任务背景见下面 `--pair`）。场景确实想要连续航程 / 加速播放时给 `continuousJourney: true` / `playRate: <倍率>`（和 `head` / `offset` 一样是场景 JSON 的顶层字段），或者在 `p` 里给 `"voyage-on": true`（有真实面板控件，走 `set()` 那条路一样能打开，且在默认关闭之后执行，会覆盖它）。
- **回归场景的固定日期（DX-07）**：`scenarios.mjs` / `regression.playwright.js` 里依赖月相 / 星空的夜景、黄昏场景都写了固定 `date`（不写 `date` 就用「打开页面当天」，月相每天都在变，跨波对比会误判——第 6 波美术总监报告撞上过一次，见 `research/ART_REVIEW_wave6.md`）。`night-city` 系列、`route-hnd-cts-night`、`dusk-earthshadow` 用的是无月夜（月亮在地平线下，日期与高度写在场景条目的注释里）；`night-sea-milkyway`（T09）和新增的 `night-sea-fullmoon`（DX-07，满月、高度 58°、方位几乎正对左座窗外）各自固定在原来的月相上。月亮高度 / 方位都是用仓库自带的 `astronomy-engine`（`src/astro.ts` 的 `moonState`，T09 用过的同一套）算的。
- **`applyScene` 跨版本容错（DX-10）**：`scenarios.mjs` 的 `applyScene`（`shots` / `passes` / `flicker` / `bench` 都靠它设场景）现在能对着**老版本页面**跑而不崩——控件不存在（`document.getElementById(id)` 是 `null`）或下拉框没有这个选项，打印一句 `console.warn` 并跳过这一项，不再 `Cannot read properties of null` 整段中断；`sc.js` 执行失败也只把失败原因塞进返回的 `info`（`console.warn` 一并记一句），不抛出、不中断同一批的后面场景。用真实老提交验证过：`7436ba1`（早于经济舱 / 奇观功能）的页面完全没有 `cabin-class` 控件，`DEFAULTS` 里照常带着这个键，`shots` 照样能跑完并出截图。给 `--baseline` / `--chain` 这类跨版本对照腾出了「同一份场景表两边都能用」的前提，不用再像性能工程师第 6 波那样现场写一份容错副本（`tmp/perf-w6/w6_patch_scen.py`，没有进仓库）。
- **截图并排对照 / 量亮度 / 逐像素求差（DX-05 / DX-07 / DX-08）**：`node scripts/compare.mjs --out <输出.png> [--crop x,y,w,h] [--zoom N] <图1> [<图2> ...]`，把多张截图拼成一张，每张左上角标文件名（父目录/文件名，便于区分不同批次的同名场景）；不给 `--crop` 就是整图并排，给了就先裁剪再按 `--zoom` 用最近邻放大（不模糊，专门给锯齿 / 闪烁这类像素级问题用）。**`--out` 同样相对仓库根解析**（也支持绝对路径）。泛化自 `handoff/T35-crop.py`（Python + Pillow），改用 Node + Canvas2D（借一次性 headless 页面做合成，复用 `lib/chrome.mjs` 找 `chrome.exe` 的逻辑，但不需要真实 GPU）避免依赖本机 Python 环境。
  `--measure x,y,w,h`（可重复，DX-07；DX-11 补齐更多统计量）：按原图像素（不受 `--crop` / `--zoom` 影响）输出每张图该区域的一整套统计：`mean`/`p99`（Rec.709 luma，`0.2126R+0.7152G+0.0722B`，0–255，公式与 `handoff/T08-stats.py` 一致）、`meanR`/`meanG`/`meanB`（三通道均值，判断偏色比只看 luma 直接）、`meanSaturation`（HSL 饱和度 0–100，判断「灰蒙蒙」还是「过饱和」）、`adjacentDiff`（相邻像素 luma 绝对差均值，水平 + 垂直一起平均——棋盘纹 / 锯齿指标，平滑渐变应接近 0）、`adjDiffH`/`adjDiffV`/`adjDiffDiag`（DX-22，按方向拆开：横只算右邻、纵只算下邻、对角把 "\" 右下邻与 "/" 左下邻一起平均——十字纹 / 菱形纹在横 / 纵上经常被正常纹理的高频盖住量不出来，只有对角方向会明显偏高，此前只能靠 `handoff/C03-hf.py` 的 FFT 频谱才看得出，DEV_SOP「测量约定」记过这条区别）、`pctBright`/`pctDark`（luma ≥ 250 / ≤ 5 的像素占比，死白过曝 / 死黑欠曝的面积）、`maskedPixels`（见下面 `--mask`）。`--json` 改成打印 JSON；有 `--measure` 时 `--out` 不再是必填，可以只量数值不出拼图（省得再手写 Python + PIL 脚本，见 `research/ART_REVIEW_wave6.md` 末尾「开发体验反馈」）。
  **`--diff <图2> [--threshold 8] [--heatmap 差异.png] [--mask x,y,w,h ...] [--json] <图1>`（DX-08；DX-11 加 `--mask`）**：<图1>（位置参数）与 `--diff` 的值（<图2>）必须尺寸相同，按 `(|ΔR|+|ΔG|+|ΔB|)/3`（0–255）算每个像素的差异幅度，输出均值 / p99 / 超过 `--threshold`（默认 8，和 T08.md 验收表「差 > 8 的像素」同一口径）的像素占比、`maskedPixels`；`--heatmap` 额外写一张假彩色差异图（黑 = 无差异，过阈值变黄，2 倍阈值封顶到红，`--mask` 排除的区域画成灰色），比读一堆数字更快看出「差异到底在画面哪里」。
  **`--mask x,y,w,h`（可重复，DX-11）**：这个矩形（原图像素坐标，和 `--measure`/`--crop` 同一套坐标系）内的像素从 `--measure` 与 `--diff` 的统计里排除（例如遮住调试面板残留的一角、水印、小地图角标），不影响拼图 / 缩略图 / `--row`/`--col` 本身的像素内容，只影响算不算进统计。
  **`--mask-image <图.png> [--mask-channel alpha|luma] [--mask-threshold 128] [--mask-labels 高组,低组]`（DX-22）**：用另一张和被测图**同分辨率**的图（例如云缓冲不透明度的可视化图，或手绘 / 用 `probe.mjs` 读出的「窗外 vs 舱内」剪影图）的某个通道当逐像素分组依据，把每个 `--measure` 区域**额外**拆成两组分别统计（不是排除，是「两组都要看」——原有那一行不分组的统计照常输出，分组结果作为多出来的两行追加，`group` 字段标出是哪一组）：`channel` 默认 `luma`，`threshold` 默认 128（≥ 阈值算 `--mask-labels` 第一个名字那组，默认 `"high"`，< 阈值算第二个，默认 `"low"`；例如拿云缓冲当 mask-image 时 `--mask-labels cloud,sky` 能分别看云区 / 非云区各自的 `adjDiffDiag`，两边数字混在一起容易把问题冲淡）。分辨率对不上就跳过那张图的分组统计并打印警告，不中断其余图片；`--mask` 矩形和 `--mask-image` 分组是「与」的关系，先排除矩形，剩下的再分组。
  **`--row y` / `--col x`（都可重复，DX-11）**：对每张输入图取第 `y` 行（或第 `x` 列）的整条像素曲线，人读模式只打印 min/max/mean（完整数组太长），`--json` 打印完整的 `{ image, row, width, r, g, b, luma }` 数组——找地平线附近的色带台阶、天空渐变有没有断层，比在截图上凭眼睛找准哪一行快。
  **`--thumb N [--thumb-out 目录]`（DX-11）**：把每张输入图等比缩到最长边 = N 像素（默认双线性平滑，不是 `--zoom` 那种保留像素边界的最近邻——缩略图就是要靠模糊掉细节看整体剪影），写一张 `<原文件名>.thumbN.png`，默认写在原图同目录。剪影误读检查：远景的云团 / 岛屿 / 建筑轮廓缩到几十像素后还能不能一眼认出「这是什么」，是游戏美术常用的快速检验法，也呼应 3A 铁律「宁可小，不要糊」。
  **零回归判断的基准是「同一份代码跑两次」的噪声底，不是 0**：TAA、云的时间累积、海浪相位、翼尖颤动、随机闪电都会让同代码两次截图产生非零差异（前面「坑点」举过 low-sea-glint 平均差 7–9/255 的例子）。判断「这一版改动有没有引入真实差异」时，先量一次噪声底（改动前 vs 改动前，或用 `__voyage.freeze` 冻结后连拍两张——冻结后噪声底应该是 0，见上面 `flicker --step 0` 的验证），再和「改动前 vs 改动后」的数字比，明显超过噪声底才算数，不要直接看 mean/p99 是不是 0。
- **定位专用探针（DX-08，泛化自 `handoff/T45-probe.mjs`）**：`node scripts/probe.mjs --port <端口> --scene '<JSON>' [--patch 文件.mjs] [--read '<JSON>' ...] [--out 目录] [--angle vulkan|d3d11] [--settle]`。应用一个场景 → 可选按 `--patch` 文件（导出 `PATCHES = [{ mat, replace, target? }, ...]`，`mat` 是 `window.__voyage` 下材质的点号路径，如 `"clouds.marchMat"`、`"outsideMat"`；`replace` 是若干 `[查找文本, 替换文本]`，按这个材质从未改动过的原始 `fragmentShader` 做精确替换）替换着色器片段 → 借 `clouds.pass` 内部共享的全屏三角形（`renderer.compileAsync`）等新程序真正编译完成（不是盲等几秒，也不会像直接同步渲染那样有卡死丢上下文的风险）→ 截图 → 按 `--read`（可重复）读回指定渲染目标区域的数值，坐标是目标自身分辨率下的像素坐标（不是屏幕坐标）。`target` 别名：`cloud` = 云历史缓冲、`outside` = 窗外 HDR（`hdrOutside`）、`exposure` = 曝光适应结果（`exposure.adapted.0`，2×1：左像素是三个 log2 亮度 + 倒影增益，右像素是色度），也可以直接给任意点号路径。
  **`--patch` 编译 / 链接失败会直接报错退出（DX-11，C01 反馈）**：`renderer.compileAsync` 只保证「编译到 `KHR_parallel_shader_compile` 认为完成」，不检查链接是否成功——three.js 的链接错误检查（`WebGLProgram.js` 的 `onFirstUse`）要等这个材质真正被 `render()` 用过一次才会触发，`compileAsync` 不会主动调用它。以前的行为是：改坏的 `--patch` 编译 / 链接失败后，脚本毫无察觉地继续截图，拍出来的是一片点阵 / 乱码（GPU 用着不匹配的程序状态画的），得靠肉眼看截图才发现。现在 `compileWait` 在 `compileAsync` 之后补一次真正的 `render()`，再读 `renderer.properties.get(material).currentProgram.diagnostics`，`runnable === false` 就直接在 Node 侧抛出并带上 three.js 的 program/vertex/fragment 错误日志，不再悄悄出一张坏图。
- **按 pass 的 GPU 计时（DX-08，收编自散落在各任务 `tmp/perf(-cloud)/passes.mjs` 的手工副本）**：`node scripts/passes.mjs --port <端口> [--only a,b] [--frames 30] [--rounds 3] [--baseline 端口] [--param k[=v]] [--wait-quiet]`，猴子补丁 `__voyage.clouds.pass.render`（所有全屏 pass 共用的同一个方法），用 `EXT_disjoint_timer_query_webgl2` 给每次调用包一个查询，按材质对象认出「窗外 / 云步进 / 云 resolve / 舱内合成 / 机翼 / 测光 / 曝光适应 / 曝光合成」。
  **按材质名识别并归类（DX-10）**：识别顺序是①`material.name`（three.js 材质自带字段，非空就直接用——目前仓库里还没有材质设置它，但以后哪个任务照建议给材质命名时这里立刻能用上，不用再改 passes.mjs）②已知的 `__voyage` 字段做对象身份匹配（窗外 / 云步进 / 舱内合成……，覆盖当前核心 pass）③**fragmentShader 里的 `#define` 常量名**兜底——认出 `CLOUD_STORM` / `CLOUD_HURRICANE`（PERF-10 计划里的雷暴 / 台风变体命名）、`WONDER_LAYER`、`CLOUD_CIRRUS`、`GROUND_DETAIL`、`CABIN_CLASS_ECONOMY`，新变体只要照这个约定用 `#define`/`#ifdef`，不用改 passes.mjs 就能被正确归类④bloom 的上 / 下采样材质没有存在 `window.__voyage` 上（对象身份够不着）也没有 `#define`，改按各自独有的 uniform 名（`uSrcTexel` / `uFalloff`）识别成 `bloom-down` / `bloom-up`（收窄了「其他」桶，此前 bloom 全部内部调用都堆在这里）；仍然认不出的才归「其他」。批渲用已有的 `__voyage.benchFrame`，不需要改 main.ts。
  `--variants 文件.mjs`（导出 `VARIANTS = [[name, pairs], ...]`，和 `handoff/T37-variants-cost.mjs`、`handoff/W00-variants-cost.mjs` 的写法一致）：在 `--material`（默认 `clouds.marchMat`）上依次换上每个变体，等 `renderer.compileAsync` 真正编完、并检查这个材质**真的切到了新程序**（没切换就打印警告——量到的可能还是旧程序，W00 在坑点里踩过这个）。**切换检测按 `renderer.properties.get(mat).currentProgram` 的对象身份判断（DX-11/12，PERF-12/TR07 反馈）**：原来按「程序缓存 Map 的 size 有没有涨」判断，撞上 cacheKey 巧合复用旧条目时会误报「没切换」（其实已经切了），改成直接比 `currentProgram` 是不是同一个对象——这正是 three.js 内部（`WebGLRenderer.setProgram`）自己判断「要不要走新程序」用的同一个字段，语义上更准。**编译 / 链接失败同样直接报错退出（DX-11，和 `probe.mjs --patch` 同一套 `diagnostics.runnable` 检查）**：以前一个变体改坏了，量出来的是「静默画点阵」那份坏程序的计时数字，看着像正常的性能数据，容易被当真用来判断优化有没有效果；现在编译 / 链接失败会带着 three.js 的错误日志直接中断，不会把坏数据混进对照表。
  量 `typhoon-bands` 的「云步进」时会顺带打印它更接近已知的哪一档（3.2 / 5.2 ms，见下面坑点，与代码无关），避免误判成回归。
  **测量锁 + 负载感知（DX-10）**：整段测量期间持「测量锁」（见下面「测量锁」），开始与每轮（每个场景）前采样一次 CPU 占用，超过 50% 打印警告；`--wait-quiet` 先等 CPU 降到 50% 以下再开始。
- **node 直接跑 `src/*.ts` 离线单测的标准入口（DX-11，`scripts/lib/ts-resolve.mjs`，收编自 `handoff/T49-resolve.mjs`）**：`src/` 下的相对导入按仓库约定不带扩展名（`import { foo } from "./bar"`），但 node 原生的类型剥离（`--experimental-transform-types`）不会像 vite/tsc 那样自动补 `.ts` 后缀，直接跑会报 `ERR_MODULE_NOT_FOUND`。用法：`node --import ./scripts/lib/ts-resolve.mjs --experimental-transform-types --no-warnings <你的 .mts 脚本>`（在 `apps/voyage` 目录下跑）——它注册一个模块解析 hook，相对导入解析失败时补一个 `.ts` 后缀再试一次，其余情况原样交给下一个 resolver。已知在用：`handoff/T49-sim.mts` / `handoff/T49-test.mts`（T49 的航向 / 坡度曲线离线复现，导入 `src/*.ts` 不带扩展名，需要这个 hook）；`scripts/weather-stats.mts` 不需要这个 hook（它的导入本来就写了 `.ts` 扩展名），直接 `--experimental-transform-types` 即可，见下面「改天气场」一条。往后新的离线单测都用这一份入口，不用再各任务各自在 `handoff/` 下复制一份 resolve hook。
- **离线 GLSL 检查**：`pnpm --filter voyage check:glsl`，不开浏览器，几秒内跑完，能抓住 GLSL 保留字、同一程序内的同签名函数重名、场景 / 窗外程序 sampler 数超 16（已用真实 GPU 交叉验证过一次，见 `handoff/DX.md`「返工记录」；当前各程序的实测用量见文首「硬约束速查表」的 sampler 表格——那张表由本工具生成，这里不重复写死数字，见下面坑点「窗外着色器的 sampler 已满」的 DX-09 校正），以及 `src/` 下有没有 CRLF 行尾（DX-05；仓库靠 `.gitattributes` 统一 LF，Windows 上脚本误写 CRLF 时 git 提交才会提示，这里提前到 check:glsl 里扫一遍并列出文件，见下面坑点「Windows 上 Python 写回源文件会变成 CRLF」），以及「硬约束速查表」里的 sampler 表格是否与实测一致（DX-09；`node scripts/lint-shaders.mjs --emit-table` 重新生成表格内容）。提交前跑一次比等冷编译报错快得多。`node scripts/lint-shaders.mjs --self-test` 单独测检查逻辑本身，不用起 vite。

- **ANGLE 后端切换**：`dev-browser.mjs` 的 `shots` / `cold` / `bench` 都支持 `--angle d3d11|vulkan`，默认 `d3d11`（Windows 上与生产环境一致，**这是交付验收的口径，不要改**）。日常改代码想快速看效果，开一个专用的 vulkan 窗口：`node scripts/dev-browser.mjs cold --port <端口> --angle vulkan`或直接用桌面浏览器 `chrome.exe --use-angle=vulkan`（真冷启动能从约 100 秒降到几秒，见`research/DX_SHADER_COMPILE.md`）。vulkan 会藏住 D3D11 专属问题（sampler 上限 16 vs 32、FXC 编译暴涨、X3595 屏幕导数报错），**验收前一定要在默认 d3d11 上再跑一次**。
- **模拟高分屏 / 弱 GPU**（DX-04）：`dev-browser.mjs` 的 `shots` / `cold` / `bench` 都支持 `--viewport WxH`（浏览器视口，默认 `1600x1200`）和 `--dpr N`（`deviceScaleFactor`，默认 `1`）。二者组合改变实际绘制的画布像素数（画布 = 视口 × DPR），例如 `--viewport 1600x1200 --dpr 1.5` 实际绘制 2400×1800，用来在本机高性能 GPU 上人为制造过载，测「画质自动档」这类自适应逻辑的降档 / 回升；不传时行为与之前完全一致。PERF-5 验收时就是手工这样模拟出「高分屏 + 台风天气」的过载场景（见 `handoff/PERF-5.md`），现在收成了通用参数。
- **离线着色器编译预算**：`node scripts/shader-budget.mjs`（或 `pnpm --filter voyage shader-budget --<参数>`），不开完整浏览器场景、不占 GPU，用 ANGLE 的翻译器 + Windows SDK 的 `fxc.exe` 离线算出每个程序的真实编译时间和 sampler 数。`--only <程序>` 只测一个，`--quick` 用 `/Od` 几十秒内出「能不能编过」，`--bisect <模块>` 把场景程序里的某段换成桩，看它占了多少编译时间（`--bisect list` 看可换的模块）。和浏览器真冷编译对照过一次，误差 5.4%，在 ≤15% 的可信范围内（见 `handoff/SC-12.md`）。
  **`--keep-hlsl`（DX-08，T41 反馈）**：默认编完就删临时目录；传了就保留并打印路径，方便直接改 HLSL 本身再用 fxc 计时（比在 GLSL 层一轮轮 `--bisect` 更快定位「具体是哪几行贵」）。
  **`--rounds N`（DX-10，默认流程也支持，不止 `--baseline`）**：重复测 N 轮，程序表输出 **min / med / MAD** 与 `--out` JSON 里每轮原始值，**判定按最小值**——负载（别的代理占 CPU）只会让计时变慢，噪声是单向的（`research/PERF_REPORT_wave6.md` 的验证：两侧交替测 5 轮，MAD 只有个位数百分比）。程序表已知有几个 id 离线计时不可信（目前是 `exposure-meter`，离线 25 s、浏览器里 0.25 s，偏差百倍，原因未查证——猜测是 32×32 常量循环在 `fxc /O1` 下被整段展开，ANGLE 实际用的编译配置不同），会在程序表里标注「【离线不可信，浏览器实测远快，见 README 坑点】」，数字仍然打印，只是不建议拿它判贴线 / 超预算。
  **`--baseline <目录> --rounds N`（DX-08，DX-10 加了 min/MAD 与跨版本容错）**：和另一个 worktree 对照，GLSL→HLSL 翻译两侧各做一次（确定性，不是噪声来源，不用重复），fxc 编译按「当前一轮、基线一轮」交替测 `--rounds` 轮，**判定按最小值**，同时打印中位数 / MAD。只接受目录（另一个 voyage 应用根，或含 `apps/voyage` 的仓库根）——这个工具本来就不连接开发服务器，Windows 也没有 Linux `/proc/<pid>/cwd` 那样的机制能从端口反查进程的工作目录，传端口号会直接报错并提示改传目录（例如 `.claude/worktrees/agent-xxxx/apps/voyage`，不确定就先 `git worktree list` 查一下）。**基线树缺材质 / 程序时不再崩溃**：对照更老的提交（奇观 / 卷云 / 经济舱这类后来才加的功能还不存在）会跳过缺失的部分并在结果里列出（`—（新增，基线树没有）`），不会像以前那样因为一处链式属性访问（如 `clouds.marchWonderMat.fragmentShader`）就让整棵树的枚举崩掉（性能工程师第 6 波复测反馈踩过这个坑：「`shader-budget --baseline` 对不同时期的树直接失败」，只能各侧各跑各的再手工比）。
  **`--chain <提交1,提交2,…> --program <id>[,<id>...] [--rounds N] [--jobs N] [--workdir 目录]`（DX-10）**：沿一串提交（通常是某功能的合并链）轮转只测指定的一个或几个程序，每个状态相对上一状态的增量就是那次合并「贡献」了多少编译时间——收编性能工程师第 6 波手工做的归因（`research/PERF_REPORT_wave6.md` §2.3 的表就是这样跑出来的）。在 `tmp/shader-budget-chain`（或 `--workdir` 指定的路径）建一次性对照 worktree（`git worktree add --detach`，首次用会跑一次 `pnpm install --filter voyage`），跑完保留给下次 `--chain` 复用，不需要了手工 `git worktree remove` + 删目录清理（Windows 上常报「目录非空」，先 `remove --force` 解除登记再 `Remove-Item -Recurse -Force` 删目录，同 DEV_SOP 第 6 节的清理套路）。`--program` 指定的程序在某个提交里还不存在时跳过该提交（打印提示），不报错。例：
  ```bash
  node scripts/shader-budget.mjs --chain "1de0481,69b1aca,f8a06ba" --program cloud-march --rounds 3
  ```
  **`--variants <文件.mjs> --only <id>[,<id>...] [--rounds N]`（DX-10）**：补丁文件（查找 / 替换对），按单项撤回做变体对照——收编 T47（`handoff/T47-fxc-bisect.py`）、W01b（`handoff/W01b-fxc.sh`）、T41（手工改 HLSL）三份各写一次的需求。文件导出 `VARIANTS = [[name, [{file, find, replace}, ...]], ...]`（`file` 相对 `apps/voyage`；空数组 = 不改、当基线），直接在磁盘上的源文件做替换 → 翻译 → 计时，然后立刻改回原样（无论成功失败都会恢复，验证过：中途出错或正常跑完，`git status` 都干净）。和已有的 `--bisect` 不同：`--bisect` 只能撤 `MODULE_STUBS` 里预先登记的几个大模块调用点，`--variants` 可以撤任意一行改动，更贴近实际排查时「撤掉这一行看掉多少」的用法。例：
  ```js
  // 补丁文件
  export const VARIANTS = [
    ["base", []],
    ["noBend", [{ file: "src/render/seats.glsl.ts", find: "if (ndv < 0.3) nn = normalize(nn + v * (0.3 - ndv));", replace: "" }]],
  ];
  ```
  **`--variants` 会真的改动磁盘上的源文件（DX-11/12，PERF-13 反馈）**：`apply()` 是直接 `fs.writeFileSync` 改 `file` 指向的源码，跑完（或中途出错）才改回原样——**不要在正在改这个文件、或起着这个 worktree 的 dev server 的时候跑**：一是 vite 的文件监听会在改动瞬间触发一次没意义的 HMR / 重新构建（浪费一轮编译，某些情况下还可能和 `--variants` 自己的替换 / 还原时序打架，读到「改了一半」的文件）；二是如果这时候你自己也在编辑这个文件，`--variants` 还原时会用它读到的「跑之前的原文」整段覆盖回去，把你手上没保存 / 没提交的改动冲掉。安全的做法：单独开一个不跑 dev server 的 worktree（或临时 `git stash` 掉未提交的改动）专门跑 `--variants`，跑完再切回来。
  **`--wait-quiet`（DX-10）**：测量前先等 CPU 占用降到 50% 以下再开始（超时也会继续，不无限等）；每轮开始前也会采样一次 CPU 占用，超过 50% 打印警告（不阻塞，只是提醒这一轮的数字可能不可信）。
  **`--ledger`（DX-10，仅默认流程）**：测完把这次的程序 min/median/MAD 追加一行到编译预算账本（见下面「编译预算账本」），带上当前 git 提交和日期。
  **测量锁**：整段测量（含 `--baseline` / `--chain` / `--variants`）持锁，见下面「测量锁」。
  **`instructionSlots` / `dclTemps`（DX-11/12，PERF-12/TR07 反馈）**：程序表的备注列现在带 `slots=N temps=M`——从 fxc 的反汇编清单（`/Fc`）里抠出来的两个**确定性**指标（同一份 HLSL 编出来的数字不随机器负载变，不需要像 `fxcMs` 那样跑多轮取 min），先判断「冷编译变慢是不是常量循环被展开了」：被展开的循环通常伴随 `instructionSlots` 暴涨（循环体乘上循环次数）、`dclTemps` 也可能跟着涨；两个数字都没怎么变但 `fxcMs` 涨了很多，大概率是别的原因（优化器路径、寄存器分配……），不用一上来就 `--bisect`/`--variants` 排查是不是哪个循环被展开了。`--out` 的 JSON 里每个程序也带这两个字段。

- **着色器零回归对照（DX-11/12，收编自 `handoff/PERF-13-parity.mjs` 与 `src/rail/shader-parity.mjs`）**：`node scripts/shader-parity.mjs --base <目录|提交> [--only id1,id2]`。离线枚举两棵树的全部程序（`collectPrograms`，不开浏览器），逐个 id 比较：原始文本逐字相同就过；不同就用 `glslangValidator -E` 做**真预处理**（宏展开 + 条件编译 + 去掉注释/空白差异）再比一次，预处理后相同也算过（常见于只是 `#ifdef` 钩子本身文本不同，两边编译到的代码其实一样，比如火车模式在共用模块里留的 `#ifdef RAIL`）；预处理后仍不同才报差异，打印第一处不同的行（含上下文）。`--base` 传目录（另一个 voyage 应用根，或含 `apps/voyage` 的仓库根）时直接用；传 git 提交时在 `tmp/shader-parity-base`（`--workdir` 可改）建一次性对照 worktree，和 `shader-budget.mjs --chain` 同一套复用约定。只在本分支存在的程序（新增变体）不算差异，只在对照存在的（程序被删了）算差异。**`src/rail/shader-parity.mjs`（TR02/TR03 写的「文本展开版」，用 `resolveConditionals` 的简化 `#ifdef` 匹配代替真预处理）不在本任务的 `scripts/` 归属范围内，原样保留没有删除或改成转发，但往后新任务请改用这里这份**（真预处理更准，且比全部程序而不是写死几对）。
- **编译预算账本（DX-10）**：`research/compile-ledger.json` 是权威数据源（起点两行抄自 `research/PERF_REPORT_wave6.md` §3.1 的性能工程师第 6 波复测），`shader-budget.mjs --ledger` 直接追加一行；`node scripts/compile-ledger.mjs`（等价于 `--emit-md`）把账本渲染成 Markdown 表格，方便贴回 PERF 报告或这份 README（`--programs cloud-march,outside-default` 只看这几列，不然程序多了表格会很宽）；`--list` 逐行打印条目摘要（日期、提交、备注、程序数）。账本不区分「哪一波」，靠 `date` / `commit` 两列自己认；离线不可信的程序（`exposure-meter`）账本里也会跟着标注，`compile-ledger.mjs` 渲染时打 `†` 角标并在表尾加说明。

- **测量锁（DX-10）**：多个代理并行开发时，离线 FXC / 真冷启动 / 按 pass 的 GPU 计时会互相污染彼此的结果（第 6 波性能工程师开发体验反馈：「希望有…一个『测量锁』：性能工程师测量时，其他代理暂停编译 / 截图。这次靠协调者口头通知，还是撞上了一次不明来源的 `cc1`」）。约定（见 `scripts/lib/measure-lock.mjs`）：
  - **持锁**（`tmp/measure.lock` 目录，`mkdirSync` 原子互斥，和 `tmp/browser.lock` 同一手法；`owner.txt` 写持有者 + 开始时间）：`shader-budget.mjs` 的离线 FXC 计时、`dev-browser.mjs cold`（真冷启动）、`passes.mjs` 的按 pass GPU 计时。
  - **查锁但不强制等待**：`dev-browser.mjs` 的 `check` / `shots`，发现锁存在只打印一句提示（不阻塞），传 `--respect-lock` 改成先等锁释放。
  - **不是本仓库脚本的 vite 构建 / 开发命令**（`pnpm --filter voyage build` / `vite build` / `vite dev` 等，管不到）：约定上手工跑一次 `node scripts/measure-lock.mjs check` 看一眼有没有人在测量；`node scripts/measure-lock.mjs wait [--timeout 分钟数]` 轮询等到锁释放再退出（默认最多等 20 分钟）。
  - 这不是严格的分布式互斥（两次读—写之间仍有极小的竞态窗口），目标是「大概率避免互相干扰」，不是绝对正确性；锁只是提醒，任何一边异常退出忘了释放，直接删掉 `tmp/measure.lock` 目录即可（和 `tmp/browser.lock` 的「残留超时删掉再取」同一处理方式）。

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
| 银河 | NASA SVS Deep Star Maps 2020 的银河背景（Gaia DR2 中比约 11.5 等更暗的星，不含亮星）；绝对亮度按人马座大星云 ≈ 20.7 V 等/角秒² 定标（估算，见 `stars.glsl.ts`）；可见度按 Blackwell 大目标对比度阈值的近似拟合（估算） |
| 舱内声音 | 巡航客舱噪声的典型形状（非计权 63–500 Hz 最高、500 Hz 以上每倍频程 −6～−8 dB、A 计权峰值 500 Hz–1 kHz，按表约 78 dBA）是按公开测量的量级近似，不是某机型实测；气流噪声随动压 q = ½ρv²（ISA 密度）变化；左右声道按扩散声场相干函数 sinc(kd) 去相关；雷声延迟按 340 m/s |

## 数据来源与许可

| 文件 | 来源 | 许可 |
| --- | --- | --- |
| `public/data/bsc5.json` | 耶鲁亮星表第 5 版，CDS VizieR V/50，`scripts/build_stars.py` 生成 | 公有领域 |
| `public/data/moon_2k.jpg` | Solar System Scope「2k_moon」（基于 NASA LRO 数据） | CC BY 4.0，需署名：Solar System Scope |
| `public/data/milkyway_4k.jpg` | NASA SVS「Deep Star Maps 2020」（ID 4851）的 `milkyway_2020_4k.exr`（4096×2048，J2000 等距柱状），`scripts/build_milkyway.py` 转成 8 位对数编码灰度 JPEG（3.3 MB） | NASA 作品可自由使用，需署名：NASA/Goddard Space Flight Center Scientific Visualization Studio；其中 Gaia DR2 数据署名 ESA/Gaia/DPAC（CC BY-SA 3.0 IGO） |
| 卫星影像（运行时拉取） | EOX Sentinel-2 cloudless 2025（`tiles.maps.eox.at` 图层 `s2cloudless-2025_3857`；G01 从 2020 换来，选 2025 不选 2024 的理由见 `handoff/G01-03.md`）。WMTS GetCapabilities 里该图层 Abstract 原文：「EOxCloudless https://cloudless.eox.at by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2025) released under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International License. For commercial usage please see https://cloudless.eox.at」；服务的 AccessConstraints 要求按 maps.eox.at 的写法署名并带链接 | CC BY-NC-SA 4.0，需署名（面板署名区）；仅限非商业 |
| 日本低空近景的高清细节（运行时拉取，G03） | 国土地理院「全国最新写真（シームレス）」`seamlessphoto`（`cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg`，z14 / z15）；只在日本、离地 < 约 6 km 或看机翼视角、航程流速 ≤ 2×、白天时进 clipmap 最细两级，并且只取它的高频细节、色调仍用 EOX（`src/ground/imagery-blend.ts`）。利用条件原文（[地理院タイル一覧](https://maps.gsi.go.jp/development/ichiran.html)）：「地理院タイルをウェブサイトやソフトウェア、アプリケーション上でリアルタイムに読み込んで利用する場合、地理院タイルは出典の明示のみで申請不要でご利用いただけます」「出典は、『国土地理院』または『地理院タイル』等と記載していただき、地理院タイル一覧ページへのリンクを付けてください」 | [国土地理院コンテンツ利用規約](https://www.gsi.go.jp/kikakuchousei/kikakuchousei40182.html)（Public Data License 1.0，与 CC BY 4.0 兼容，可商用）；加工过要写明，署名写作「国土地理院（地理院タイル・全国最新写真（シームレス））を加工して作成」+ 一览页链接（面板署名区） |
| 地形（运行时拉取） | AWS Terrain Tiles，Terrarium 编码（`elevation-tiles-prod`） | 开放数据，各来源署名见其说明 |
| 水体、道路（运行时拉取） | OpenFreeMap 矢量瓦片的 water / waterway / transportation 图层（同一张瓦片、同一次请求） | © OpenStreetMap contributors，ODbL |
| `public/data/rail/oito-matsumoto-shinanoomachi.{json,bin}`（火车线路走廊：中心线、车站、道口、桥、建筑、土地利用、道路、水系、电力线） | OpenStreetMap，Geofabrik 中部包离线提取（`scripts/rail/extract_osm.py`，不走公共 Overpass），`scripts/rail/bake.py` 烘焙 | © OpenStreetMap contributors，ODbL 1.0；本文件属于衍生数据库，对外发布同样按 ODbL 提供 |
| 同上文件中的高程（`center.zGround` / `zRail` / `grade`、`grid.z`） | 国土地理院 标高タイル DEM5A（缺值用 DEM10B 补），`scripts/rail/dem.py` 取样 | 国土地理院コンテンツ利用規約（与 CC BY 4.0 兼容），署名「地理院タイル（標高タイル）を加工して作成」 |
| 同上文件中的 `masts.*`（接触网支柱） | **程序生成的示例**（OSM 里这一段没有支柱数据） | — |

火车线路数据的格式、各类要素的覆盖率与缺口、事实核对，见 `research/RAIL_BAKE_REPORT.md`；重跑方法见该报告 §6。

**经验近似（不是物理量，后续要替换）**：舱内受窗外光的系数、夜间自动曝光的目标中灰曲线、水体反射率取值。代码里都标了注释。

## 坑点

以下按主题分节，节内按时间先后排列；新任务的坑点追加到对应主题节末尾，减少合并冲突（见 `DEV_SOP.md` 第 7 节）。条目内容只做归类移动，不改写原意；明显过时的数字原地保留并加注记，不删除。开工前的速查见文首「硬约束速查表」。

<a id="pit-shader"></a>
### 着色器编译

- **three r186 的 `ShaderMaterial` 设了 `glslVersion: GLSL3` 就不再定义 `gl_FragColor`**，着色器报 `'gl_FragColor' : undeclared identifier`。
  修法：不设 `glslVersion`。WebGL2 下 three 仍然按 `#version 300 es` 编译，并自动声明 `pc_fragColor` 和 `gl_FragColor` 别名。
- **最终输出着色器 include `<dithering_fragment>` 前，要先 include `<common>` 和 `<dithering_pars_fragment>`**，否则报 `dithering` / `rand` 找不到。three 只给内置材质自动加这些声明。
- **分支和循环里不要用屏幕导数**（`fwidth`、`dFdx`，以及隐式求导的 `texture()`）：D3D 会报 X3595，结果没有定义，边缘可能闪烁。
  要么把导数挪到函数开头、任何分支之前；要么用解析的像素覆盖范围（距离 × 像素张角）；要么用 `textureLod` 显式指定 mip。
- **首次打开或改了着色器后要等很久（实测冷编译约 45 秒）**：Windows 上 Chrome 经 ANGLE 把 GLSL 转成 HLSL，交给 FXC 编译，FXC 会展开所有固定次数的循环，大着色器编译极慢。编译结果有磁盘缓存，之后打开不到 1 秒。
  用户决定：不为此做优化，只加加载遮罩（`#loading`）。如果以后要优化：把大循环的次数改成依赖 uniform，FXC 就无法展开。
  排查时的坑：看起来是新页面卡住，其实是 Vite 热更新让**旧页面**先重新加载、在冷编译里卡了 44 秒，新页面的 HTML 请求被推迟到那之后。
  用 `performance.getEntriesByType("navigation")[0].requestStart` 就能看出来。
  （2026-09-27 DX-09 校正：「约 45 秒」是 SC-3 / SC-5 压缩编译时间之前的数字，当前真冷启动量级见本文「渲染管线」一节与硬约束速查表「冷编译门槛」，此处数字仅作历史记录）
- GLSL 里 `half` 是保留字（还有 `input`、`output`、`filter`、`sample` 等），拿来当变量名或结构体字段会编译失败。
- 纯重构的验证：拼出最终着色器字符串前后逐行 diff（去空白）最可靠；截图比较要先用「同一份代码跑两次」估计噪声底（TAA 云、海浪相位、翼尖颤动、随机闪电都会带来差异，low-sea-glint 的平均差可到 7–9/255）。
- **窗外着色器的 sampler 已满（16/16）**：ANGLE 上 `MAX_TEXTURE_IMAGE_UNITS = 16`，T14 加入 `uOceanWaves` 后场景程序活跃 sampler 正好 16；SC-5 拆开后满的是窗外程序（outside-pass.ts），舱内合成程序只用 3 个，舱内要加纹理放那边。再加纹理会链接失败（日志可能为空）。修法：合并进纹理数组 / 图集。识别：`gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS)` 逐个数 sampler 类型。合并任何碰场景着色器的分支前都要数一遍。
  （2026-09-27 DX-09 校正：文中「16/16」「3 个」是 T14 刚加入时的数字，早已过时；当前实测数字见文首「硬约束速查表」的 sampler 表格，由 `node scripts/lint-shaders.mjs --emit-table` 生成、`check:glsl` 自动比对，不会再悄悄脱节）
- **FXC 会把常量上界的循环整个展开**：循环多、函数内联多时冷编译从 45 s 涨到 80–90 s，甚至超时 → `VALIDATE_STATUS false`（日志为空）→ `CONTEXT_LOST_WEBGL`，还会让共享浏览器 `GL_RENDERER = Disabled`。修法：循环上界写成「常数 + 恒为 0 的 uniform」（T02 的 `uTerrainSteps`、T06 的 `uLoopGuard`），重函数只调用一处。识别：冷编译时间暴涨、日志为空的链接失败。
- **GLSL 没有命名空间**：所有 `*.glsl.ts` 拼进同一个程序，同签名函数重名会编译失败；而且只在某个变体把相关模块凑齐时才暴露（T02 的细节变体与 T06 的 `lineCov` 撞名）。**新增 GLSL 函数一律带模块前缀**（如 `detailLineCov`、`seatSdf`）。`renderer.compileAsync` 失败也会 resolve，切换变体前要检查程序是否有效。
- **重函数只调用一次、结果复用**：FXC 会把被多处调用的函数在每个调用点整份内联，冷编译随调用点线性变长。已知重函数：`oceanRadiance`、`cloudShadow`、`flashIlluminance`、`sampleGround`、`keyLight`、`marchFunnel`、`windowIrradiance`、`cloudDensity`（及雷暴 / 台风部分）。SC-3 把场景程序里的 `oceanRadiance`、`cloudShadow`、`flashIlluminance` 都收成一个调用点后，场景冷编译 71 → 19 s（浮点逐像素不变）。新代码需要它们时先找现成结果，不要再调一次（T02 多调一次 cloudShadow 就多约 15 s）。定位法：真冷启动脚本 + `#if 0` 逐段二分。
- **开发时用 Vulkan 后端，验收用 D3D11**（2026-09-26 编译专项实测）：`--use-angle=vulkan` 让真冷启动从约 98 s 降到约 5 s（绕开 FXC 优化器——离线实测 FXC `/O1` 占约 90% 编译时间）。画面与 D3D11 一致，但 Vulkan 的 sampler 上限 32、uniform 上限 4096，且不会暴露 FXC 专有问题（编译暴涨、X3595），所以**交付验收仍在 D3D11 上做**。GL 后端链接失败，不可用。开发用浏览器：`& "C:\Program Files\Google\Chrome\Application\chrome.exe" --user-data-dir="$env:LOCALAPPDATA\voyage-dev-chrome" --use-angle=vulkan http://127.0.0.1:5181`（独立用户目录，不影响日常浏览）。
- **离线计编译时间**：浏览器只做 GLSL→HLSL 翻译，再用 `fxc.exe` 离线计时（与浏览器内 88.9 s 对 88.2 s），不占 GPU。坑：three 链接后会删 shader 源码，要编译完立刻取翻译结果；Git Bash 会把 fxc 的 `/O1` 改写成路径，加 `MSYS_NO_PATHCONV=1`；ANGLE 翻译出的 HLSL 带占位符，离线编译前要补全。（工具见 SC-2 `scripts/shader-budget.mjs`。）
- **海面着色被内联了两次**：`terrain-shading.glsl.ts` 的地面水体又调用一次整个 `oceanRadiance`，场景编译 82.8 s 中约 51 s 来自这份重复（SC-3 在修）。`clouds.glsl.ts` 同时拼进场景、机翼、云三个程序，改它三个都会重编。
- **`FRAG_PREFIX`（`lint-shaders.mjs`）的片元输出必须写 `layout(location = 0)`**：不写的话`glslangValidator` 不会报错（`check:glsl` 测不出来），但真实 ANGLE 编译 `cloud-march` 这类自己声明了 `layout(location = 1) out ...`（MRT）的程序会报 `EXT_blend_func_extended` 相关错误——GLSLES 3.00 规定一旦有多个片元输出，全部输出都要显式给 location。这也说明「静态语法校验通过」不能100% 代表「真实浏览器编译一定过」，MRT 相关的坑目前只能靠真实浏览器验证一次来兜底。
- **离线 fxc 计时对系统负载很敏感**：同一份程序在不同时刻测，`/O1` 编译时间可能差 20% 以上（本机被其他代理占用 GPU/CPU 时更明显）。用 `shader-budget.mjs` 的数字和浏览器冷编译对照时，两次测量要紧挨着做，中间不要插其它重活；同一个 `--bisect` 批次内部的相对比较不受影响（都在同一时刻测）。
- **场景拆成窗外 + 舱内两个程序以后（SC-5），改哪个文件重编哪个程序**：浏览器按程序的源码文本命中缓存。舱内程序（scene.ts）拼的是 cabin*.glsl.ts、seats.glsl.ts、wing.glsl.ts（ggxD / smithG）、lights、atmosphere；窗外程序（outside-pass.ts）拼的是 clouds.glsl.ts、ocean / ground / terrain / traffic / lightning / stars / islands、lights、atmosphere、noise.glsl.ts。
  d3d11 实测（RTX 5090）：只改 `cabin-shading.glsl.ts` 一个常数，重载后这一批编译 3.2 s；只改窗外一个常数 7.9 s；真冷全部 9 s 左右（原来单个场景程序约 20 s）。
  以后别把窗外模块拼进舱内程序（例如为了一个 uniform 拼整份 CLOUD_COMMON；舱内只需要 `uCoverage` 就单独声明），反之亦然，否则改一处两个都重编。两边都要的小工具放 noise.glsl.ts。
- **MRT 程序在 ANGLE / D3D11 上并行编译后，第一次 draw 会同步重编整个像素着色器**（与绑哪个目标无关，PERF-1）：云步进曾因此冷启动卡 4.7–8 s。新程序尽量单输出，需要第二个量时用深度附件（gl_FragDepth）或打包。识别：冷启动里某个程序第一次 draw 卡住的时间 ≈ 它一次完整 FXC 编译的时间。
- **循环里对纹理读出的数据做「三角函数 → 矩阵旋转 → normalize → 投影」会让 FXC 冷编译暴涨**（T41）：点星第一版在 3×3 格的循环里逐颗星算屏幕位置，窗外程序离线 FXC 5.5 → 45 s（d3d11 真冷 17 → 52 s），挪进舱内程序也一样（6.4 → 62 s）。不是循环展开（上限改成 90 时间不变）；换扁平循环、去 `continue`、单独去掉三角函数 / 矩阵 / normalize / 误差函数 / 取纹理都不管用，只有整行去掉才回到原值（二分方法：`shader-budget.mjs` 的临时目录里拿 ANGLE 翻译出的 HLSL，直接改 HLSL 用 fxc 计时，一轮一分钟，见 handoff/T41.md）。修法：在循环外按像素算一次「赤经 / 赤纬 → 屏幕像素」的雅可比，循环里只做线性组合。识别：新加的循环让 `shader-budget --only <程序>` 翻好几倍。
- **窗外程序里新加的小函数也会让离线 FXC 明显变慢**（T17）：本机影子最初用 5 个四边形的多边形距离场（每个 4 条边）+ 两层展开的循环，窗外程序离线 FXC 多约 1 s；改成一个 `6 + uLoopGuard` 的循环里算 6 段带厚度的线段后回落。整组光学现象最后让窗外程序离线 FXC 约 +20%（5.6–6.2 s → 7.2 s），但浏览器真冷启动总时长不变（约 16.2–16.5 s），因为并行编译的关键路径是云程序。以后往窗外程序加东西，两个口径都要看：`shader-budget.mjs --only outside-default` 与主分支交替测两轮（单次噪声可到 +50%），再用 `dev-browser.mjs cold` 看总时长。
- **窗外程序要用机翼程序的 uniform（如 `uSeatSign`）得自己再声明一次**（T17）：两个程序共用同一个 uniforms 对象，值会自动同步，但 GLSL 声明只在 `wing.glsl.ts` 里，窗外程序不拼它；`check:glsl` 会报 undeclared identifier。
- **离线 FXC 计时在机器被别的代理占用时噪声可到 ±40%**（T47）：同一份程序连测 7.4–14 s 都有，5% 的预算判不出来。做法：和 master 交替 ≥ 4 轮，同时看中位数和最小值；把单个改动换掉做变体对照（`handoff/T47-fxc-bisect.py`）比整体对照更能定位。
- **「平时不走」的天气代码占了云步进冷编译的 96%，拆成 `#define` 变体后启动关键路径换成了窗外程序**（PERF-10）：雷暴 / 台风密度按 uniform 分支跳过、却一直编在默认云步进里，离线 FXC 13.7 s；拆成 `CLOUD_STORM` / `CLOUD_TYPHOON` 变体后默认程序 0.49 s（雷暴版 3.9 s、台风版 7.3 s、两者都带 13.5 s），云影图 2.3 → 0.19 s、探针 0.76 → 0.15 s，卷云 / 奇观变体各 −96%。真冷启动（d3d11，交替 5 轮）master 21.2–22.2 s → 15.9–16.9 s；后台批次 13.4 s，现在由窗外程序（离线 9–10.6 s）决定，PERF-13 接着压。
  坑一：`check:glsl` 的「同名函数」检查不展开条件编译，`#ifdef A` / `#else` 里各写一份同名函数会被报重名——在**函数体里**分 `#ifdef`（见 `cloudStormsOn`）。
  坑二：`lint-shaders` 的条件展开器（sampler 统计用）只认单个 `defined(X)`，不认 `#if defined(A) || defined(B)`；需要「任一」时由 JS 端多加一个宏（本任务的 `CLOUD_WEATHER`）。
  识别：`node handoff/PERF-10-preproc.mjs` 用 glslangValidator `-E` 真预处理，逐程序列出雷暴 / 台风标识符出现次数，默认程序应只剩 uniform 声明。
- **舱内程序的离线 FXC 时间不跟指令数、也不跟调用点数成正比**（PERF-12）：`shader-budget --variants` 消融 scene-default，
  整个 `shadeSeat` 换成常数 −42%（7.8 → 4.5 s），可它里面任何一块（皮纹、缝线、胡桃木、高光、法线、AO、光照）单独去掉都在 ±10% 噪声里；
  去掉 `shadeWall` / `shadeReveal` 反而**更慢**（+10–17%）。把座椅部件、四点法线、四道缝线、三路高光都改成「常数 + uLoopGuard」循环
  （每个调用点只内联一份），fxc 指令槽 7899 → 约 6900，编译时间只 −5%（经济舱 −16%）；把 `shadeSeat` 挪到窗板分支之后调用也没用。
  结论：这个程序的 FXC 时间主要由 `shadeSeat` 这一整块和主函数其余部分「叠在一起」决定，零碎的循环化只能拿回几个百分点，
  要大幅下降得把座椅着色搬出这个程序（单独一个 pass），或者把各层表面的光照收成一个调用点（按层循环）。
  识别 / 工具：`fxc /O1 /Fc` 输出的 `Approximately N instruction slots used` 与 `dcl_temps` 是确定性的（不受负载影响），
  可以先拿它判断「常量循环有没有被展开」，编译时间仍要在安静时交替测。本次顺手找到三处还在被展开的常量循环：
  倒影光点（`RF_NPT`，20 份 `rfPoint`）、窗上水线（`dk = −2..2`，5 份含 4 次 vnoise 的循环体）、内衬二分（7 份 `sdFunnel`），都改成了 `+ uLoopGuard`。
- **窗外程序的罕见光学 / 天幕层奇观拆成按需变体后，真冷启动 13.4 → 11.1 s**（PERF-13）：两者平时不出现，却一直编在窗外默认程序里（离线 FXC 消融：去掉宝光 / 影子 / 晕 −15%、去掉天梯 / 建木 −20%、两者一起 −34~38%；太阳圆盘 + 绿闪只有 −2%，留在默认程序）。拆成 `OUTSIDE_OPTICS` / `OUTSIDE_WONDER` 后默认程序离线 FXC 约 5.8 s（同轮 master 8.8–11 s），组合只留 `""`、`OW`（巡航，首帧后后台预编，冷缓存约 10–12 s 编好）、`DOW`（低空，和原低空细节变体同一程序）、`DROW`（火车，同原火车变体），三个变体预处理后与改动前的对应程序逐字相同（`node handoff/PERF-13-parity.mjs <master 的 apps/voyage>`）。
  坑一：**本机影子是纯物理的，只要下面有云、太阳在上面就开着**——白天在云上几乎总要 `OW`，所以 `OW` 必须预编而不是等「稀有」时才编；判断「看不看得出」按着色器覆盖公式取上界（`optics.ts` 的 `opticsWanted`：压暗 ≤ 0.4 × 360 m² / 半影半径² × 0.7，< 0.2% 当看不出），日落时半影大，默认程序就够。
  坑二：**关掉真实地理数据时 main.ts 原来直接画 `outsideMat`**，拆变体后这条路会丢掉光学与奇观——现在一律走 `groundDetail.pick`（高度传 Infinity）。
  坑三：挪 uniform 声明的顺序会让「预处理后逐字相同」失败（常量缓冲布局也跟着变）：包 `#ifdef` 时保持原来的声明顺序。
  坑四：零回归截图里，夜景偶尔整窗发白是**翼尖频闪**被冻结在亮相（与窗外 pass 无关）；逐像素对比夜景前设 `__voyage.wingDebug.strobe = 0`（`handoff/PERF-13-shots.mjs` 已带）。
  识别：`check:glsl` 的「窗外默认程序不含罕见光学 / 天幕层奇观代码」一节；`__voyage.groundDetail.variantStatus` 看想要 / 实际画的变体与各变体编译状态。
- **座椅拆成单独 pass、机翼水珠暗边进湿窗变体后，真冷启动 12.0 → 9.1 s（最小值，中位 12.7 → 10.1 s）**（PERF-14）：PERF-13 之后启动批次的关键路径是舱内程序。
  按 PERF-12 留下的两个结构方案先做最小原型量离线 FXC：(a) 座椅追踪 + 着色搬出舱内程序（舱内只读一张纹理）−31%；(b) 座椅这一层的光照全换常数、只留材质（「光照收成一个调用点」的上界）+12%（噪声内，没有收益）——选 (a)。
  实装后 scene-default 7.3 → 3.9 s（−46%），新的座椅程序只要 1.5 s（两者之和 5.4 s 远小于原来的 7.3 s：FXC 时间随单个程序规模超线性增长，拆开就省）。
  机翼程序消融（`shader-budget --variants`）：材质整体 −43%（小翼 −22%、蒙皮 −23%、短舱 −15%）、窗板水珠 `waterOnPane` −18%、航行灯 + 灯照 −16%、两处 `wingEnv` 只留一处 −4%。
  材质和灯平时就看得见，只拆了「窗干时结果恒为 0」的水珠暗边（`WING_WET` 变体，干窗逐位相同）和 `wingEnv` 单调用点，机翼 7.3 → 6.5 s。
  现在批次里各程序编好的时刻（`__voyageStartup["批次各程序编好（ms）"]`，`dev-browser cold` 会打印）：座椅 1.6 s、舱内 4.4 s、机翼 6.5–7.8 s、窗外 6.8–8.5 s——**关键路径是窗外程序，机翼紧跟其后（差 0.2–0.7 s）**；窗外再压的话机翼会重新变成关键路径，下一刀见 `handoff/PERF-14.md`「还能怎么压」。
  坑一：座椅 pass 的目标必须是 32 位浮点（和 hdrOutside 同一判断）：半精度装不下屏幕玻璃上的太阳高光（可到 5e4 kcd/m² 以上，超过 65504 写成 inf），夜里全关灯时座椅亮度又落进半精度的非规格数。
  坑二：舱内合成和座椅 pass 的灯光必须是同一份代码（`scene.ts` 的 `CABIN_LIGHTS_SETUP` / `cabinLightsSetup`），不然座椅与侧壁的明暗会悄悄分家。舱等切换由 `CabinClassVariant` 同时编两个程序、都编好才切。
  坑三：`WingWetVariant` 按 `uWetness > 0.001` 选变体，和 `waterOnPane` 开头的 `wet <= 0.001` 返回 0 同一个门限；改其中一个要一起改。变体首帧后 120 帧后台预编（约 8 s 编好），启动就在雨里时前几秒机翼像素上少一圈水珠暗边。
  识别：`check:glsl` 的 1d 一节（舱内合成不调用 `shadeSeat` / `traceSeats`，机翼默认程序不调用 `waterOnPane`）；帧时间里多一行「座椅」（中位约 0.016 ms 的固定开销，满屏座椅的经济舱看前方舱内 + 座椅合计比原来 +0.02 ms）。
- **同一个数学表达式，写成 `max`+`abs` 比写成等价的 `clamp` 平方慢，FXC 对具体写法敏感、不是只看运算量**（TM01）：曝光合成里的一处软拐角，写成 `max(g, 0) + 0.5·max(0.5 − |g|, 0)²`（每个铰链各自 `max`，中间夹一次 `abs`）时 `exposure-final` 离线 FXC **+13%**；换成数学上逐点相等的写法 `0.5·clamp(g + 0.5, 0, 1)² + max(g − 0.5, 0)`（`clamp` 一次到位，不出现 `abs`）后回到噪声内。两种写法的浮点结果逐位相同（都是同一条 C¹ 连续的软拐角曲线），纯粹是 FXC 优化器对 `abs`/`max` 组合展开出的中间表示更啰嗦。识别 / 以后怎么避免：新写分段 / 钳位类的表达式时优先用 `clamp(x, lo, hi)` 一次夹到位，而不是拆成多个 `max`/`min` 再叠 `abs`；改完用 `shader-budget.mjs --variants` 对照写法本身（不只对照有没有这段代码），`fxc /O1 /Fc` 的 `Approximately N instruction slots used` 涨了但看不出为什么时，先怀疑是不是写成了 `max`+`abs` 的组合（`handoff/TM01-fxc.mjs`）。

<a id="pit-cloud"></a>
### 云

- **天气渐变不能走 `clouds.applyPreset` / `snap()`**（T19b）：会清掉时间累积，并让云影图整张在一帧里重建（3–8 ms）；连续航程每 0.25 s 推进一次云量，就会变成持续卡顿。修法：`clouds.setParams(p, true)`（gradual），云影图按后台分片节奏跟上；借遮挡的硬切才用 `setParams(p, false)`。
- **占据网格只保护 ±128 km 内的雷暴 / 台风**（T19b）：网格外照样逐点求值，4 个单体在 300 km 外仍 +1–1.5 ms/帧，台风在 750 km 外 +2–3 ms/帧（`handoff/T19b-storm-cost.mjs`）。天气驱动因此只在 280 km（雷暴）/ 600 km（台风）内摆放；以后要放得更远，先在云程序里给网格外的雷暴 / 台风做 LOD。
- **改天气场（`WeatherField`）的气候倾向之前和之后都要跑 `scripts/weather-stats.mts`**（WX10；DX-11 挂进了 `package.json`）：门禁是 `pnpm --filter voyage weather-stats -- --multi`（等价于 `node --experimental-transform-types --no-warnings scripts/weather-stats.mts --multi`，6 个种子全部通过，约 1.5 分钟，不开浏览器；不加 `--multi` 只跑一个种子并打印完整统计表，约 15 s）。它按月份和地区统计云型、雷暴、锋面、台风（100 年样本），对照气候目标区间断言，退出码非 0 就是失败；每条断言都写了依据。T19b 的天气场就是在没有这类统计的情况下，把 1 月日本海做成了 63% 晴空、把台风做成了每年 59 个。
  写新断言时有两个坑（WX10 审查）：①只按一个种子调通的门限会随种子翻转，比如 4 年样本里「台风 8 月最多」20 个种子有 7 个失败，所以必须用 `--multi` 验；②门限要让改前的代码失败，否则分不出改前改后（「华北七下八上晴空 ≤ 45」改前就能过，已换掉）。
- **粗略海陆轮廓 `coarseLand` 分不出日本海一侧和太平洋一侧**（WX10）：本州是一条沿太平洋岸画的胶囊，东京落在中轴线上，新潟、金泽、秋田都算作海。拿它按「离海岸多远」判断寒潮阴雪时，北海道西部变成晴空，关东反而阴雪。修法：陆地按手画的脊梁折线 `JAPAN_SPINE` 分两侧。识别：打印 `surgeGeo(lat, lon, true)`，逐个核对札幌、新潟、东京、广岛这类城市在哪一侧。
- **值噪声集中在 0.5 附近，不能拿阈值直接当「时间比例」**（WX10）：三维 `vnoise` 的 p10 ≈ 0.25、p90 ≈ 0.75；z 取半整数的切片更窄，p10 ≈ 0.30、p90 ≈ 0.70。要表达「某件事有 60% 的时间发生」，先用 `rank()` 拉伸，再比较「活跃度 − rank」。
- **连续航程中途，白天的台风几乎摆不出来**（WX10 发现，T19b 的机制）：台风的卷云盖半径约 300 km，「整组在视野外」基本满足不了；巡航高度又在积云之上，遇不到穿云遮挡，只能等深夜。现在只有用户跳变（`onJump`）时会直接摆放，日志记 `[jump]`。截台风图的办法：场景 js 里打开连续航程，然后调用 `director.weather.onJump()`。跳变时也要先过 PERF-10 的预告门 `weatherReady`：冷启动后十几秒内换预设，如果变体还没编好，这一次不摆台风 / 雷暴。**合并时别丢掉预告门**：丢了 typecheck 照样能过，但会摆出画不出来的台风。
- **云影起点不能正好落在球面上**：海面点 r = BOTTOM，对地球求交的根在 0 附近正负抖动，云影随机丢失。把起点抬高 10 m。
- 渲染到 3D 目标用 `renderer.setRenderTarget(target, layer)`：第二个参数在 3D 目标上就是层号。
- `Data3DTexture` 设 `generateMipmaps = true` 后，three 上传时会自动生成 mipmap。远处的云必须用 mip 采样，否则会严重闪烁。
- **（已推翻，2026-09-27 T27）台风云影用的是解析大形，不是真实密度**（T04）——现在窗外程序查一张世界坐标预计算的云影图，用真实密度（带细节侵蚀）。以下为当时记录：：完整台风密度进场景程序会让场景冷编译 65 → 103 s，所以云影 / 探针只用不采样纹理的大形。已知偏差：雨带阴影缺相位扰动与断续遮罩（偏约 ±1/4 带间距、断处仍有影），眼壁阴影缺 shape / bump（几公里），眼底层积云无阴影。巡航高度基本看不出；改云影时别把完整密度塞回场景程序。
- **表面细化必须退回到最近一个空白采样点**（T04 修 T03）：固定退回 2dt 会反复「撞上 → 退回」到步数上限，远处出现等高线条纹；完全不退回又会漏检成平行明暗条纹。另：高度场只能用水平切片噪声（3D 噪声会让塔身上下断开成漂浮团块）；按固定高度间距量化的台阶从高处看是等高线地图。
- **three 的 3D 渲染目标每画一层都会按 generateMipmaps 重新生成整张 mipmap**：只在最后一层打开。用 mip 做「膨胀」最多到 mip 2（R8 下 mip 3 会把单个有云格点舍成 0）。
- **云影要插值透射率，不能插值光学厚度再取 exp**（边缘会变回一刀切）；太阳低时影子对光源方向极敏感，云影图重建阈值要到 0.01° 量级。
- **three.js 的输出抖动（dithering）会在自相关里冒充周期峰**（T32）：在 (6,−1)/(6,−3) 处留 0.5–0.9 的假峰（舱壁上也有）。查纹理周期要先滤掉 5 px 以下成分；带通自相关的底噪约 0.13–0.19，「≤0.05」只适用于已知周期位移。
- **细节噪声周期太短时，中远处 mip 滤掉细级只剩最低一级，就是规则格子**（T32）：云细节噪声 0.9 km 周期曾导致云海一排排等距小云团；已改世界坐标随机平铺。雷暴 / 台风细节侵蚀、云街（纯 4 km 正弦）仍是周期的，留意。
- **有雷暴 / 台风时开销与距离无关**（T33）：场上一有天气系统，每个像素都切到天气模式（云壳撑到 0–15/20 km、近水平视线空走几百公里）。判断先做「放到 2000 km 外」的对照。现按视线是否够得着天气系统分路径。
- **步数用完会表现成纱窗点阵 + 直边透明方盒**（T33）：用完位置随像素抖动变 → 半透明点阵，连起来是直边。识别：临时调大上限看是否变实心。天气模式上限 448、普通云 192。
- **眼墙顶沿后面露出一根水平「栏杆」**（T37）：从台风眼往外看，顶沿后方任何一层处处等高的云顶（卷云盖顶约 16 km）在顶沿低处都会露成光滑横管。识别：只关卷云盖看管子是否消失。修法：卷云盖顶在眼壁附近压到顶沿以下、随顶沿起伏，探针 / 云影用同一个高度函数。
- **往上加细节会飘出碎云**（T37）：眼壁内壁随高度起伏时，在顶沿高度往上叠细尖峰会切出悬空小片。细节只往下刻。
- **找塔窗口截出直边**（T37）：雨带找塔的 3×3 窗口只完整覆盖离塔心约 13 km，砧 / 侧泡伸得更远就被截成直线。高处窗口顺高空风偏移 5 km；新加部件先核对窗口够不够。
- **相机紧贴稀薄云层底面时步进变贵**（T37）：给卷云盖底面加丝缕软化使 typhoon-outer 涨 35%（+0.7 ms），因为相机正下方多出大片稀薄云、步进要走细。已撤回；这类改动先用按 pass 的 GPU 计时（handoff/T37-variants-cost.mjs）逐项归因。
- **云步进里加「平时不走」的分支也会让整个步进变慢一倍**（W00）：把奇观的表面追踪、介质、投影直接写进 `MARCH_FRAG`，奇观关着（uniform 分支一次都不走）时 noon-cumulus 云步进 0.35 → 0.44–0.73 ms，typhoon-bands 约 ×2；逐段删掉任何一段都不够，只有全删才回到 0.35（寄存器 / FXC 的分支与展开取舍，同一份程序小改一处就可能在 0.35 和 0.72 两档之间跳）。
  修法：可选功能做成 `#define` 变体程序（`marchWonderMat`，只在有云间层奇观时用），重活放进单独的 pass（奇观 pass 把表面 + 介质合成一层，步进只读一个 texel）；默认程序预处理后与改动前逐字相同。识别：按 pass 的 GPU 计时（`tmp/perf-cloud/passes.mjs`）加页面内逐段替换（`handoff/W00-variants-cost.mjs` + `W00-mkvar.mjs`）；普通场景（noon-cumulus）就能看出来，不要以为「分支不走就没开销」。
- **云步进提前停步留下的透射率残差会让日盘透过厚云**（T45）：步进在 T < 0.005 时 break，停下时的 T（实测日盘处 4.2e-5）只是截断残差；日盘比背光的云亮约 10⁵ 倍，残差照样把一个白圆盘透出来（雷暴黄昏最显眼，任何厚云挡太阳都可能）。修法：步进末尾 `T = max(T − 0.005, 0) / 0.995`。识别：读回云缓冲（`handoff/T45-probe.mjs` 的 `readCloud`）看日盘处 T 是不是很小但不为 0。
- **受光步进的精简密度漏掉的部件不会自遮挡**（T45）：`stormDensityLite` 旧版没有雨幡，太阳贴地平线时从云底下平射进来，整片雨幡被照透、逆光又落在前向散射峰上，云底下挂一块发光椭圆（美术总监以为是海面耀斑，关掉海面云影它还在，已推翻）。修法：精简密度加上雨幡。以后给完整密度加部件时，想一下受光步进 / 探针用的精简版要不要跟着加。识别：页面内把该部件消光置 0，看亮斑是否消失。
- **光滑解析曲面在远处读成直线；按 lod 取的噪声在远处被 mip 平均成常数**（T44）：台风雨区外缘云底抬升段是光滑圆锥面，外围朝中心看（150–300 km 外）它的轮廓是一条斜直线（美术总监以为是卷云盖底，关掉卷云盖照样在）。给它加噪声时按步进的 lod 取，远处 lod 高，噪声已平均成常数，完全没效果；改固定取 mip 3 的低频噪声才断开。按 `lod − 4` 取细 mip 又让 typhoon-bands 云步进 +3 ms（远处样本读细纹理，缓存不友好）。识别：页面内逐个关部件（`handoff/T44-v5.mjs`），看直线跟着谁走。
- **给台风眼调的数值别漏到整个台风**（T44）：体积阴影空气透视的「影子里只剩 12% 内散射」、下方反射光用眼底反照率 0.35、投影用的解析卷云盖到 9Re 都是实心——这些在眼里对，按 18Re 的范围作用到外围，雨带的云就只剩透射率的偏黄、多一层暖色反射光，读成沙土色。按离中心的距离（2.5–4Re）过渡到眼外的取值。
- **稀薄大片云的受光别走完整受光步进**（T44）：卷云盖外围变薄后视线在里面走很长，每个样本 8 步受光步进，typhoon-bands 云步进 +2.2 ms。它上面只有天，用「本点消光 × 到云顶斜程」的解析光学厚度（`gStormSoft = 2`），回到 +3–5%。
- **云缓冲是半精度时，无月夜的云会下溢成纯黑**（T46）：云的 raw / history 目标原是半精度（最小次正规数 6e-8），无月夜云只有 1e-7 kcd/m² 量级，存进去只剩 0–2 个最低位：整片纯黑、边缘是量化马赛克。T41 补上物理量级的夜天光「几乎不变」、放大 100 倍才亮，就是这个原因。修法：有浮点线性过滤时云目标用 32 位浮点（resolve +0.04 ms）。识别：读回云缓冲（`handoff/T45-probe.mjs` 的 `readCloud`），值恰好是 0 或 5.96e-8 的整数倍。和 T36 大气 LUT 同类：以后夜里任何「补了量级却不变」的现象，先查中间目标的精度。
- **逆光的积云整团是灰褐色剪影、没有金边，不是相函数的问题，是受光步进用的「不带细节」的密度太胖**（T12）：层状云 `detail = false` 时旧版完全不侵蚀，再 ×3.5 饱和，比画出来的云胖一大圈的实心。受光步进后 3 步（0.4–3 km）和 150 km 外的远云走这条；太阳低时光线平着穿过整层云，几乎每个样本都被邻居的胖影子挡住。去掉粉末效应、加尖的前向峰都几乎不变（已推翻的假设）；受光光学厚度置 0、或只留前 3 步，金边立刻回来。修法：不取细节时按细节噪声均值侵蚀（不取纹理）。识别：页面内把受光循环分段置 0（`handoff/T12-v3.mjs`），看是哪几步把云压暗。以后给密度加「省掉的细节」时，省掉的那一路也要和完整路径一样瘦。
- **卷云代码按 uniform 分支、平时不走，积云场景的云步进也慢一档**（T12，W00 同类）：卷云的坐标变换写进 `layerDensity`（受光步进展开 6 份），不分支或 `if (uCloudType < 0.2)` 都让 noon-cumulus 云步进 0.40 → 0.50 ms、typhoon-bands 页面内 +20%；逐项去掉任何一处改动都回落（`handoff/T12-mkvar4.mjs`），说明是寄存器 / 分档而不是算术本身。修法：卷云代码放 `#ifdef CLOUD_CIRRUS`，云步进另有卷云变体 `marchCirrusMat`（云型 < 0.2 时用，第一次需要时或启动后约 300 次 probe 后台编译，`clouds.cirrusLayerState`），云影 / 探针程序直接带。识别：`passes.mjs --variants` 页面内逐项撤回，看是不是「撤哪一项都回落」。另：typhoon-bands 页面内对照时整页都落在慢一档（master 等价代码也是 6 ms），跨页面比较要看同一档。

- **云步进不知道地形，山后面的云会画到山前面**（T38）：云步进只按球壳走，视线打到山上以后还一路走到几百公里外；窗外 pass 按「背景 × T + 云」合成，山后的云被盖在山体上。清晨 4 km 看富士山（层云 1.2–3.4 km）：远处地平线上的云带横切山腰，山顶像浮在带子上，云量 0 时消失（美术总监 wave5 次要 2，当时怀疑的「按地形深度截断用错深度」不成立——根本没有截断）。读回：山坡上云的平均深度 65–290 km，地面只在 38 km。
  修法：云缓冲（history）加宽一倍，右半存 (深度 × 不透明度, 不透明度)，窗外程序用同一个 sampler 取（`cloudBufferColor` / `cloudBufferDepth`，窗外 sampler 不增加），在真实地面像素上按「云深度 / 地面距离」1.0–1.3 渐变去掉山后的云（`cloudBeforeGround`）。机翼程序也改成取左半。以后谁读 `clouds.texture`，都要用这两个函数取，不能直接 `texture(uClouds, uv)`。
  坑一：直接累积深度不行——没有云的帧深度是 400 km（gl_FragDepth = 1），稀疏小云、云边逐帧有云 / 没云，累积出的深度 150–360 km，海面上的云被当成在海面后面整片去掉（sunset-wing 一大片云没了）。必须按不透明度加权累积、用时相除。
  坑二：「视线在云壳里均匀、前段透射率 T^f」这种不看深度的估计不能用：山后的浓云 T ≈ 0 时 T^f 也 ≈ 0，整条云带原样留在山前。
  已知误差：山前一层薄云、山后还有浓云时平均深度被拉远，山前的薄云一起去掉。识别：`handoff/T38-probe-depth.mjs` / `T38-probe-k.mjs`（窗外输出地面距离、云深度、处理前后透射率）。
- **受光步进后几步一步几公里，按中点取 0 / 1 的密度会在塔身背光面切出水平分界**（T38，T44 遗留）：受光步长逐步翻倍，雨带塔的精简密度只在中点判断在不在塔里，某个高度以上中点出了塔、以下还在塔里，光学厚度在 227 / 457 两个值之间一跳，背光面亮度跳 4 倍：近塔半腰一条分界、下半截整片发暗（「圆桶」「拱洞」）。随机取样点（每帧换）能抹平但受光面满是颗粒，已撤回。修法：把这一步的长度（`gLightLen`）交给精简密度，过渡带按步长放宽（≈ 这一步落在塔里的比例），确定性、无噪声。另外眼外的塔不再按整个台风外壳高度压暗环境光（那是给眼壁井底的，底部只剩 12%），改按 0–10 km、下限 0.4。识别：`handoff/T38-probe-tower.mjs` 读回视线透射率降到 0.6 处的直射 / 环境光 / 受光光学厚度 / 高度，光学厚度只有几个固定值就是这个问题。
- **天气变体编好之前画的是「已编好的子集」，截图 / 计时要等 `clouds.cloudVariantPending` 变成 false**（PERF-10）：雷暴（S）、台风（T）变体启动后约 1.5 s 开始后台预编（`WEATHER_PREWARM_PROBES`，冷缓存下雷暴约 5 s、台风约 9 s 编好）；导演摆放雷暴 / 台风前先问 `weatherReady`（没编好就推迟，摆放本来就在视野外）。面板手选、组合（雷暴 + 台风、卷云 / 奇观 × 天气）第一次出现时按需编，编好之前按权重（台风 > 雷暴 > 奇观 > 卷云）画已编好的子集：天气系统暂时不画，普通云照常，不会画空、不同步卡住（`handoff/PERF-10-hitch.mjs`：编译期间和第一次进雷暴 / 台风都没有 > 50 ms 的帧）。`applyScene` 已经在等；自己写的脚本要等它，否则拍到的是没有雷暴的天。`clouds.variantStatus` 看各变体状态。
  坑（审查返工）：「选哪个变体」只能有**一个**函数（`wantedKey`）。第一版导演预告只检查 S / T，卷云 / 奇观在场时一摆雷暴，步进要的 CS / WCS 还没编好，回退画 S，整层卷云当场变普通云、奇观消失几秒；云影图 / 探针的天气版又按「场上有天气且天气小程序编好」自己决定，比台风步进早编好 5 s，海面先有台风的影子、天上还是普通云。现在预告按 `wantedKey` 拼完整键、并等天气小程序；云影 / 探针只在步进**实际画的**变体带 S / T 时用天气版（`weatherAuxOn`）；卷云 / 奇观在场时顺带预编 CS / CT（WCS / WCT）。识别：`handoff/PERF-10-combo.mjs`（按导演流程预告 → 摆放，逐帧断言 shown === wanted）。
- **跨页面截图对比，云的位置取决于「等编译等了多久」**（PERF-10）：场景表里没写 `offset` 的场景，飞机从打开页面起一直在飞；等卷云 / 奇观 / 天气变体编译的时间两边不同（后台预编占着编译线程），云就挪了几公里，cirrus-noon 均差 7/255、看起来像整片卷云变了。零回归对比要写死 `offset`，在等编译的 `js` 末尾再把 `uCloudOffset` 归零（`handoff/PERF-10-shots.sh`）。按 pass 计时同理：cirrus-noon 卷云带成片、视野里的云量随位置变，master 在 0.29–0.57 ms 之间跳；同一位置页面内换程序（`handoff/PERF-10-variants-cirrus.mjs`）才可比：卷云变体 0.46 ms，加回雷暴 + 台风代码（= master 的卷云变体）0.65 ms。
- **云 resolve 的邻域夹取用 `texture()` 读 32 位浮点纹理很慢**（PERF-11）：取样点正好在纹素中心，线性过滤的结果就是纹素本身，但 RGBA32F 的过滤在 NVIDIA 上降速；改 `texelFetch`（边缘夹到 `[0, 尺寸 − 1]`，与 ClampToEdge 逐位相同）+ 窗板外（`paneDistance > 0.025`）直接写 (0, 0, 0, 1) + 右半深度只在附近有地形时写，resolve 0.114 → 0.025–0.040 ms。只做后两项时还有 0.08 ms——过滤才是大头。
- **多次散射的八度近似必须 a ≤ b，少阶以后要按有效反照率标定能量，深处还要一段扩散尾巴**（C01）：原来 a = 0.62 > b = 0.35、6 阶，第 3–5 阶的 b^k → 0，几乎是一份不随 od 变的常数光，高阶合计从 od 0 到 5 只降一半，受光 / 背光抹平，云芯明暗只有 ±6%（「不锐」的最大来源，`research/CLOUD_SHARPNESS.md`）。改成 a = b = c = 0.5、3 阶后曲线变陡（od 0 → 5 降到约 1/6.7），对比来自斜率（已推翻：研究报告与第一次交付说的「od = 5 处高阶是单次的 100 倍、背光面被灌满」——改后那里仍是约 100 倍）。
  能量：3 阶的受光厚云有效反照率 πL/E 只剩 0.21（改前其实也只有 0.35，T12「补回了能量」不成立）；高阶乘常数 `CLOUD_MS_ALBEDO = 6` 标定到受光云顶 p90 ≈ 0.75–0.78。**这是不守恒的经验增益**（乘后高阶绝对权重 3.0 / 1.5，不再满足 a ≤ b）：很薄处（od → 0）多次散射源项是单次的 3–4.5 倍（已知问题，cirrus-noon 只亮 +4/255）。粉末效应只乘高阶（Schneider 2015 是经验性的，这是按其物理含义的解读）。
  深处（审查返工）：3 阶全是指数，od ≳ 10 全归零 → 雷暴 / 台风背光塔身成深蓝剪影、飞机在云里窗外出现 2×2 棋盘纹（受光 od 的随机细节噪声被放大）且雾发蓝。修法：加二流近似的扩散尾巴 tailK/(4π)·(1/(1 + 0.1125 od) − e^−od)。**不能全局 tailK = 1**：从外面看的积云背光面（od 3–10）被抬平，云芯对比掉 26–32%；所以 `CLOUD_MS_TAIL` 分三档：晴天积云 0.2、飞机在云里 2（`uCloudImmersion`，与曝光的 `uWhiteout` 同一对象）、雷暴 / 台风塔身 1（天气宏里）。
  识别：云里的回归只看亮度均值量不出来（188 → 186「恢复了」其实满是棋盘纹、发蓝），回归表要加区域的相邻像素差和 RGB 均值（`handoff/C01-texture.py`），棋盘纹用实时截图（`shots --freeze`）量，64 帧真平均会把它当成雾的结构。
  识别：「整体亮度」要看 HDR（读云缓冲，或 `handoff/C01-albedo.py` 的同照度朗伯白面对照），不要看截图——满窗云时自动曝光会把变暗补回去，截图反而更亮。
  坑：页面内补丁拼出 `1 * (…)`（int × float）时 GLSL ES 编译失败，画面是一片斜纹点阵、看着像累积失效；补丁里的数一律 `toFixed`，编完检查 `diagnostics.runnable`（`handoff/C01-measure.mjs`）。
- **远处云带 / 逆光近处云底的水平横纹（「梳齿」）来自受光步进挑细节格点的随机数和采样深度相关，不是步长或 mip**（C03）：`gDetailRnd` 原来是 `fract(jitter + i·φ)`，和采样点在区间里的位置 `t + stepLen·jitter` 共用一个 jitter，时间累积收敛到的受光随「在第几步进云」（整数 i）跳变，掠射时 i 逐行变 → 一条条横纹。研究报告「步长减半横纹变少」是真的，但原因不是步长本身。修法：`fract(ign(gl_FragCoord.yx + vec2(19, 47)) + uFrame·(√2−1) + i·φ)`，零开销。空间项和时间增量**两样都要换**：
  - **整数倍的 ign 仍是 jitter 的函数**：fract(13·ign) = fract(13·jitter − …)，只起换图样的作用，还把 IGN 的蓝噪声邻域性质放大没了，实时单帧里是一层菱形交叉细纹（第一次交付 `ign·13 + uFrame·0.7549` 踩了，审查返工）；
  - 增量不要用 R2 的 0.7549：它和 jitter 的 0.618 有 4a + 6b ≈ 7 的近有理关系，64 帧只漂 0.09 圈；单独当一维序列时在 TAA 约 8 帧的窗口里只落在约 4 个值上，闪烁偏低频（「呼吸」）。√2−1 两方面都与 φ 相当。
  - **交叉纹要用对角高频能量量**（FFT 中 |fx|、|fy| 都 > 0.2 的能量 ÷ 半径 > 0.02 的总能量，`handoff/C03-hf.py`），**相邻像素差量不出**：横纹换成交叉纹时两者此消彼长，adj 几乎不变。而且要在**实时路径的单帧**上量（`handoff/C03-rt.mjs`：blend 0.12 + 邻域夹取，冻结后手动推进云），64 帧真平均会把它当成「未收敛」。`dev-browser flicker` 在 freeze 下跳过 `clouds.render`，对云的时间噪声是瞎的，不能拿来自证云「不闪」。
  识别：页面内把 S 换成常数（横纹消失 = 在光照里）、受光 od 置 0（消失）、mip 降 2 级（不消失）、步数上限加倍（逐位不变）；最后把 `gDetailRnd` 固定成 0.5（消失，但露 T32 的六边形格子边）。**以后任何「每帧换的随机数」都不要由 jitter 派生**：只要和采样深度是同一个随机数的函数，时间平均就会把整数步号变成画面上的等值线。量化：`handoff/C03-streak.py`（沿行平均后竖直二阶差分 ÷ 转 90° 的同一量）。
  另：增量为 φ 的序列乘 13 以后每帧只走 0.034（13φ ≈ 8.034），时间上几乎不动——换乘数时先算 frac(k·增量)；两条序列的增量对还要查低阶联合谐波 |k₁a + k₂b − 整数| 别太小。
- **按「离表面多近」改变步长会在 64 帧平均里长出一排排横纹 / 光照条纹，层状云的进云细化（C03）因此没做**：`layerDensity` 的「形状包络 / 侵蚀阈值」能当表面距离用，靠近表面时空白步长 2dt → 0.5dt，不透明度边宽 −15–20%，但①步长由上一个样本（位置 = jitter）决定，采样位置在帧间不再均匀，不透明度收敛成与高度相关的条纹；②进云那一步越短，落进被照亮的几十米表皮的概率越大，受光亮度随步长变 → 另一种条纹（受光深度按原来的 2dt 统计可以消掉这一种，第①种消不掉）；开销 +16–45%（按 pass）。雷暴式「退回 + 8 小步」提不高掠射薄边的命中概率（边宽不变），云步进 +140–175%，还把 noon 云芯对比 int_rng 0.22 → 0.14（表面采样变细，受光面整体变亮）。全程半步（边宽 −20–27%）+71–79%。细节与数字见 `handoff/C03.md`。
- **逆光银边「不亮」其实是「太宽」：前向峰按 hg(0.9)·e^(−0.25·od) 整份算，云芯在太阳附近发一大团光，薄边不突出**（C09）：太阳真在云后 3–8° 时 HDR 的边 ÷ 芯早就有 6–14（C01 量到的 1.16 是 backlit-cu 的几何：云离太阳 20–40°，衍射峰 10° 外就没了）；问题是往里 0.5–1.5° 的芯还有边的一半亮，显示上被 AgX 肩部压成一整块白。根因两个：①e^(−0.25·od) 这个 delta 缩放假设光被峰散射多少次都还挤在 hg(0.9) 里，od ≈ 16 处照样亮——其实每散射一次角分布宽一圈（HG⊛HG = HG(g1·g2)）；②云的表皮消光低：视线加权 σ 边上 5.5 /km、往里 1° 仍 11 /km（真实积云 50–150 /km），弦的光学厚度随深入涨得慢，受光 od ×4 芯也只暗一半。修法（①）：峰按路上被再散射的次数 k 展宽，k 服从 Poisson(0.75·od)，角分布 HG(0.9^(k+1))，k ≥ 3 的余量给 HG(0.656)，总能量与原来相同（backlit-close 的 HDR 边 ÷ 往里 0.5–1.5° 从 6.2 到 8.9，顺光 / 侧光 ≤ 2%）；②还没做（要动密度 / 边宽，见 C10）。
  坑：**「受光步进第一步缩短、薄边自遮挡更准」单独用会让银边更弱**——薄处 od 变小，芯也跟着亮（sharp 6.2 → 5.3–5.6）；「只加一个 g = 0.6 的宽瓣」只把边整体抬亮几个百分点，光晕宽度不变。但首步缩短（30 m ×2.2）能把受光的随机误差压下去（两者一起时各场景实时时间波动 0 到 −9%、单帧对角高频 −2 到 −11%），正好抵掉展宽放大的薄处噪声（f = 0.5 时单帧亮点 +36%，没用），所以两者一起上。
  识别 / 测法：**银边要从云缓冲读，不要看截图**：云缓冲不含背景（L 预乘、A = 透射），c = Y(L)/α 是云自身亮度，截图里半透明的边混着身后的天。按「离 α ≥ 0.9 边界多少像素」分带看 c 从边到芯怎么掉（`handoff/C09-prof.py`，sharp = 边 ÷ 往里 12–32 px）。机位要用 `backlit-close`（1 km 在积云底下往上看，太阳在一团 2.5–5 km 外的积云顶后面）：在 4 km 的层里找，挡住太阳的云几乎都在 1–2 km 以内（贴脸、整窗是云）。`handoff/C09-rim.mjs --find` 扫云偏移找「太阳处 α ≈ 1、3–8° 有边、周围是天」的机位，顺带临时抬高 `uTerrainMax` 让云缓冲右半写出云的距离。
  另见（C12 已修方向性）：静止相机的实时单帧里，薄云 / 半透明的边上有一层规则的点阵 / 斜纹（α 里也有，不是窗板纹理），逆光时最显眼（`D:\Code\opus-test\tmp\screenshot\c09\l3-bin.png`）。
- **云面的平行斜纹 / 纱窗点阵是主步进抖动 IGN 的空间图样，不是云的结构**（C12，BIS-7 二分定位）：IGN 每一帧都是同一族平行对角线，只按 φ 平移相位；blend 0.12（约 8 帧）+ 邻域夹取后没收敛的残差照样是对角的，飞行中（有重投影运动）更明显。修法：云外改用自生成的 128² 两通道蓝噪声（`scripts/gen-blue-noise.mjs` → `src/clouds/blue-noise.ts`，R 给步进抖动、G 给 gDetailRnd），空间项固定、每帧加 φ / √2−1。
  坑一：**不要每帧整体平移蓝噪声（R2 偏移）**——单帧更「蓝」，但逐像素的时间序列变成白噪声：HDR 时间波动 ×1.4–1.6、16 帧低频 ×2、单帧颗粒 ×1.3，比 IGN 还差。白噪声、R2 格点抖动（`fract(dot(xy, R2))`，斜纹 ×1.5）、每步再错开抖动（`fract(jitter + i·0.7549)`，噪声 +10%、HDR 均值 −1.6% 有偏）都试过，不如「蓝噪声 + φ」。
  坑二：**云里（C11 的 3×3 平均）反而要留 IGN**：IGN 的任意 3×3 块里 9 个值几乎均匀分层，被 3×3 平均后接近 9 样本分层估计、图样也被平均掉；蓝噪声的 3×3 分层差一些，云里 8 姿态相邻差 ×1.24、时间波动 ×1.23。所以 `blueNoise()` 在 `uCloudImmersion > 0.5` 时返回 IGN（整帧 uniform 分支）。以后改云里 resolve 的空间滤波，要连这个选择一起复核。
  坑三：**「蓝噪声 + φ」只去掉方向性，不减噪声幅度**：按亮度归一的相邻差 ×1.02、静止单帧的 FFT 对角高频 ×1.08（各向同性的细颗粒同样落在对角高频区，这个指标分不出「斜纹」和「颗粒」；飞行中 ×0.86）。方向性要看 `handoff/C12.md` 的「斜纹指数」（高通残差在 10 个位移上的自相关最大值，×0.73）或放大图。幅度要靠 resolve 的时间窗：静止时 blend 0.04 对角高频 −46%、时间波动 −52%，但会拖影 / 糊亚像素运动，要按重投影速度自适应，属于 resolve 的改动（handoff/C12.md 末尾的建议）。
  补充（C12 审查）：①云里切回 IGN 的阈值 0.5 偏早——部分入云（权重约 0.45–0.55）时蓝噪声相邻差比 IGN 低约 15%，完全在云里才 IGN 更好（约 ×0.84），进出云只零点几秒、看不出，不改；②「斜纹指数」只适用于静止同机位 A/B，运动下会被重投影的方向性模糊污染（运动下 ×0.98，静止 ×0.73）。
- **飞机在云里时窗外满是 2×2 棋盘纹 / 对角细纹，换抖动序列只换图样**（C11，诊断见 `handoff/INCLOUD-CHECKER.md`）：步进位置、受光挑格点两个 1 spp 随机源打在对受光 od 极敏感的深处介质上，blend 0.12 + 3×3 夹取的时间累积压不住，收敛后剩下的是抖动序列的空间图样。修法：resolve 把已经读进来的 3×3 邻域顺手求和，按 `uCloudImmersion` 把本帧值换成 3×3 平均（零额外取样，云缓冲上等于固定一次 3×3 盒式模糊；云里满窗是几十米内的雾，没有要保的细节）。in-cloud 8 个固定姿态：显示相邻像素差几何均值 2.88 → 0.43（最差 6.08 → 0.68），对角高频 ×0.07，HDR 时间 relStd ×0.18、relLow16 ×0.38。**不会跨深度边**：云缓冲左半只有云——步进不认识机翼 / 机身 / 地面（地面在窗外 pass 按右半深度合成，机翼在机翼 pass 盖上去），3×3 里没有别的物体的边；右半（深度）不做平均。机翼边上那些 2 px 阶梯 / 点阵（襟翼滑轨整流罩的阴影、亮三角的斜边）在改动前的 16 帧平均图里一模一样，是机翼 pass 自己的，原来被云的噪声盖住（`D:\Code\opus-test\tmp\screenshot\c11\wing\stair_z1.png`）。
  两个陷阱：①`uCloudImmersion`（= 曝光的 whiteout）出云后按 0.5 s 指数衰减，要约一分钟才真正到 0，直接当权重的话出云后几秒还在做 1% 量级的平均、云外不再逐位等于改动前——权重从 0.02 起算（`clamp(imm·1.0204 − 0.0204, 0, 1)`）。②**同页 A/B 时 `freeze()` 每调用一次都把冻结时刻重设成 `performance.now()`**：`uTime`、云偏移、whiteout 在两次调用之间各跳一帧，变体之间比的就不是同一个云场（C11 第一版 new / new2 平均差 0.6，以为是着色器不确定）。绕法：调 `freeze` 时临时把 `performance.now` 换成固定值（`handoff/C11-ab.mjs` 的 `__c11freeze`）。即使这样，偶尔还有**某一个变体**整体差一截（与着色器无关：同源的 old / old2 之间也出现过），判零回归要交替排 `old,new,old2,new2`，看有没有一对是 0，不要只看一对。识别：同一着色器的两个变体差得和新旧之间一样多。
- **云外时间累积降 blend 的真正障碍是重投影深度，不是双线性**（C12b，`handoff/C12b.md`）：静止时 blend 0.12 → 0.04 能让噪声减半，但直接降在巡航 / 转弯时云边出现错位的拖影（误差最多 ×1.8）。根因：resolve 用**本像素 1 spp 的深度**（`gl_FragDepth`）重投影，它随步进抖动、云边有 / 无云逐帧跳，取历史的位置每帧随机偏一下，blend 越低累积得越多。修法三件一起上：①重投影深度改 3×3 按不透明度加权的平均深度（单独这一条，巡航误差 ×0.90、转弯 ×0.85）；②历史改 Catmull-Rom（12 次 texelFetch），双线性每帧按小数位移叠一次 f(1−f) 的模糊，稳态约 1.1 px，Catmull-Rom 降到约 0.7 px；③blend = mix(0.04, 0.12, 4·(fx(1−fx)+fy(1−fy)))，按重投影位置的**小数部分**而不是位移大小（远云每帧 0.1–0.3 px 正是双线性最糊的区间）。结果：静止 HDR relStd ×0.49、对角高频 ×0.55、relLow16 ×0.58；巡航等效模糊 σ 1.08 → 0.73 px、对真值误差 ×0.90；转弯误差峰值最差 ×1.15；出云 ×0.91；云里（wImm > 0）与右半逐位不变。
  **reset 后收敛（C12b 审查返工）**：`snap()`（换预设 / 天气 / 云滑条 / `setSize` 即画质档自动升降）后 reset 帧只有 1 spp，blend 0.04 下它的权重按 0.96ⁿ 衰减，第 16 帧误差是 master 的 2.2–2.6 倍、约 48 帧才追上。修法：`uSinceReset`（reset 帧 0，之后每帧 +1，`render()` 里和 reset 标志一起维护），云外左半 `blend = max(blend, 1/(uSinceReset+1))`——前约 25 帧是等权平均，之后交还自适应 blend；修后第 16 帧误差比 master 还低（backlit-cu 0.051 对 0.072）。**时间累积类改动的验收必须加「reset 后收敛」一项**（`C12b-ab.mjs --modes reset`：snap 后第 1–64 帧对静止真值的误差曲线）——静止 / 巡航 / 转弯三个模式都在稳态上量，抓不到这个问题。
  三个坑：①**Catmull-Rom 单独上会让运动时噪声 ×1.16**——双线性的模糊顺带在降噪，换掉它要同时降 blend 才不亏；②**常数 0.04（即使有①②）转弯误差 ×1.74、出云 ×1.22**，必须按小数部分自适应；③方差裁剪（均值 ± 1.25σ，与 min/max 取交集）在这里没有收益（静止噪声反而 ×1.03，运动持平），没采用。识别：降 blend 后巡航截图云边出现亮 / 暗的错位细边（不是均匀的糊），先查重投影用的是哪个深度。测量：`handoff/C12b-ab.mjs` 的确定性航迹（手动推进 `uCloudOffset` 与 `clouds.render`，各变体逐位同一航迹）+ 每个检查点静止等权平均 256 帧的「真值」，比 `C12b-metrics.py` 的拟合模糊 σ 与对真值误差——冻结工具与真实 rAF 飞行都做不到逐位同一航迹。

<a id="pit-atmos"></a>
### 大气与曝光

- 半精度浮点最大 65504：太阳圆盘的辐亮度约 1.8e6 kcd/m²，写进 HDR 目标前要夹到 6e4，否则变成 Inf，把测光也带坏。
- **太阳的辐亮度会冲爆半精度**：要有眩光，HDR 目标必须是 32 位浮点，否则太阳被截断成 6e4，光晕能量少了 30 倍，只剩一个小白点。
- 曝光的测光 / 适应目标（T28 起是 2×1：左像素亮度、右像素色度）只有一两个像素，耗时就是单个线程的串行采样链，GPU 再宽也不能并行。T28 的色度测光一开始跑两遍 16×16（先求均值再排除高光），曝光 pass 从 0.057 ms 涨到 0.084 ms；改成用上一帧的适应亮度判高光、只跑一遍后回到噪声内。识别：整帧 bench 看不出（GPU 被占满时噪声 ±15%），用 `handoff/T28-bench-exposure.mjs` 单测曝光 pass。以后往测光里加东西，采样数控制在亮度像素的 1024 次以内。
- 1×1 的曝光适应目标要用 `FloatType`。半精度在对数亮度约 8 附近的步长是 0.004，每帧的微小变化会被吞掉，适应会卡住。
- **深暮光天空的块状阶梯来自半精度 LUT 的下溢**（T36）：
  - 现象：太阳在 −10° 到 −18° 之间时，天空是一格一格的阶梯色块，云量为 0 也有。
  - 根因：大气 LUT 以「光源照度 = 1」为单位存辐亮度。实测天空视图 LUT 的中位数，−10° 时约 4e-8，−15° 时约 6e-10，−18° 时约 6e-11，都低于半精度的最小次正规数 5.96e-8。每个 texel 只剩 0 / 1 / 2 个最低位，双线性插值后被自动曝光放大成阶梯。
  - 修法：支持 `OES_texture_float_linear` 时，所有大气 LUT 都存成 32 位浮点（`Atmosphere.float32`）。性能在噪声以内，着色器没有变化。
  - 排查：URL 加 `?lut16` 可以强制回到半精度复现。逐张切 32 位的实验表明，只有天空视图 LUT 有影响；空气透视和多次散射 LUT 切不切都一样。
  - 识别：暗场景里出现和 LUT texel 网格对齐的块状台阶时，先看这张 LUT 的数值有没有掉到 6e-5 以下（半精度的正规数下限）。以后再加以「照度 = 1」为单位的 LUT，也要用 32 位。
  - 没有 32 位线性过滤的设备仍会退回半精度，阶梯还在。要修的话，可以按太阳高度乘一个缩放系数再存。
- **霾（T18）的相函数要比背景米氏更「钝」**：沿用 g = 0.8 时侧光下霾层比地平线的瑞利天空还暗，霾线看不出来；霾单独用 g = 0.7（`HAZE_G`）。霾的 uniform 虽然在 `ATMOSPHERE_COMMON` 里，但只有 LUT 程序调用 `sampleMedium`，场景 / 云程序里不可达。
- **舱内只乘直射透射率会发蓝发暗**（T31）：被云挡掉的直射要按二流近似补成白色漫射；探针用的台风大形卷云盖高度要和完整版一致。
- **只抬高可见度阈值、不改画出来的底色，银河几乎不会变淡**（T09）：城市人工天光和舱内光幕没有画进天空，按真实背景算出的阈值只砍掉超出部分的一点点（城市里 C ≈ 0.7、阈值 0.08 → 还剩 88%），画面上的对比度照旧。修法：再乘「画出来的底色 ÷ 真实底色」，让银河相对画面底色的对比度等于真实对比度（`milkyWayVisibility`）；月光照亮的天空本来就画在底色里，这一项对它是 1。识别：强行把 `uSkyGlow` 设成几倍夜天光，截图里银河几乎不变。
- **从巡航高度看海平线，绿闪在物理上几乎看不见，不是着色器没生效**（T17）：色散只让绿色日像比红色高约 20 角秒（一个像素约 2.7 角分），而最后那一丝阳光贴着海面擦过整个低层大气两次（进、出各一次，Rayleigh 光学厚度约 7.6，加气溶胶），绿光透射率只有红光的约 1%。10.7 km 上即使放大 8 倍，那一个像素也只是很暗的一点绿；1 km 高度时就是看得出的一点绿。
  真实的「看得见的绿闪」靠近地逆温层的蜃景把地平线附近竖直放大（Young 的 mock mirage）——放大的是角尺寸，不是时间，所以 `opticsSunDisk` 做的是「视高度 → 真高度」的映射，而不是把色散量乘大（乘大会让绿闪持续十几秒）。
  识别：`__voyage.optics.pinGreenFlash(-3)` 时能看到白亮的日边，`0.5` 时只剩一点绿，`disabled` 时什么都没有；想确认机制在工作，临时把 `uOpticsFlash.y` 调到 10 看绿边是否变高。
- **晕和幻日的份额要按「单次散射 × 归一化相函数」定标，别凭感觉给 0.05**（T17）：幻日的角分布很集中（约 1°×1.3°，峰值约 1000 /sr），份额给 0.05 时幻日比太阳周围的天空亮上千倍、22° 晕成了一道彩虹。按「卷云约一半是前向衍射、水平片状冰晶约 1%、每个幻日分到约 10%」估到 5e-4（晕 5e-3），幻日才是「比周围卷云亮几倍」。三原色通道的晕颜色会比真实的连续光谱纯得多，各通道内缘往中间收一半才像「红色内缘、往外发白」。
- **夜里发光体发白 / 发灰，不是「浦肯野按全局适应亮度」的锅，是「按亮度线性褪色」+ AgX 高光压色度**（T48）：现象：钠灯照亮的雾（R:G:B ≈ 1 : 0.23 : 0.01、约 0.16 cd/m²）屏幕上是奶白，night-city 的钠灯路网是白的。
  根因两段：① 浦肯野的混合是「全局适应因子 × 像素亮度因子」，夜里全局因子恒为 1，实际由像素亮度决定——0.16 cd/m² 时仍混约 28% 的视杆灰蓝，不管像素多饱和；② 窗外对数平均测光被大片黑底拉低（0.001 cd/m²），雾被曝光推到中灰之上 4–7 档，AgX 在对数域逐通道压缩，通道比被压扁成奶白，城市灯（约 3 cd/m²）直接截白。
  修法（exposure.ts，只作用于窗外像素 src.a）：按「色觉阈值」保色——饱和度（浦肯野前的 1 − min/max）0.5→0.85、像素亮度 log10 cd/m² −2.0→−0.8 同时满足时不混视杆的色度，但亮度仍按视杆光谱走（只保色度不保亮度，否则灯的光晕变亮变糊）；夜里（窗外适应 log10 < −1.5→0）对同一批高饱和像素，把 AgX 结果往「同色相、同显示亮度（放不下时降亮度保色度）」拉 60%。
  坑：满月的地平线远云被长路径消光染成棕红，饱和度 0.88，但只有约 0.009 cd/m²，亮度门限下沿放在 −2.0 才不把它们变棕；亮度门限太窄（0.6 个量级）雾会出现「橙芯 + 灰边」的硬边；色度保持若再乘一次亮度门限，边缘更陡。
  识别：`handoff/T48-ab.mjs`（同帧冻结 A/B，关掉 T48 参数等价改前）+ `compare.mjs --diff`：白天 / 黄昏必须 0 差异；色度用 `handoff/T48-chroma.py` 量（compare --measure 只有 luma）。跨两次 `shots --freeze` 的截图不能逐像素比（飞机在飞，冻结时刻不同，位置差一两公里）。
- **无月夜 4 km 的城市连成奶白平台：「保色」不能降亮度；根子是城区低频整体过曝，要按低通做局部适应**（T48b，`handoff/T48b.md`）：
  现象：night-city（睡眠 / 全关）城区一块平的奶油色，路网只剩几条淡橙线（城区相邻差 4.1、≥250 为 0）。
  根因两层：① T48 的色度保持目标按 `1/max(x)` 降亮度，所有过曝的灯都被归一到「最大通道 = 1」，亮度层次压平（BIS-7 已开关证实）；
  ② 就算去掉 ①，AgX 原样也只有相邻差 6.4、≥250 占 21%——窗外对数均值被黑地拉到约 0.001 cd/m²，整片城区的**低频**亮度在中灰之上 4–7 档，灯、灯下路面、地毯光一起顶到肩部。
  修法：① 目标改为「同色相、亮度 = AgX」，放不下时向同亮度的白去饱和；② AgX 之前按眩光低通（`uBloom`）亮度超过中灰 +3 档的部分压暗 0.6 × 超出量（`uNightLocal`，门控同 T48 的夜 × 窗外遮罩），
  灯点 / 路网是低通之上的细节，照原样保留。城区相邻差 4.1 → 18.0，≥250 5.5%（单个灯芯），白天 / 黄昏 / 满月海 / 舱壁逐位不变。
  坑：BIS-7 建议的「浦肯野亮度按视杆 / 明视混合」实测光晕更亮、相邻差略降，没用——亮于 1 cd/m² 的像素 scotopic 本来就归零；HSL 饱和度对「接近白的奶油色」虚高（master 53%、改后 26% 才是更有颜色的画面），判颜色看 RGB。
  副作用：翼尖航行灯的光晕跟着变小（它的低通也远超拐点）。识别：`handoff/T48b-ab.mjs` 同页冻结多变体，`u.uNightLocal.value.y = 0` 关掉局部适应。
- **满窗受光的云被自动曝光压成中灰，是曝光的问题，不是云的问题**（C02）：窗外对数均值 → 中灰 0.18，满窗云时最亮 1% 云只有 157–163/255。修法：白天窗外曝光不低于 EV100 15 的相机曝光（`uDayEvAnchor`，⑨，`y = 0` 关掉即改前），比锚点暗 0.5 档以上的视野（海、陆地、天空、黄昏、夜里）逐像素不变（TM01 起锚点两侧 ±0.5 档是软拐角，in-cloud、typhoon-bands 落在这里，窗与舱壁有 < 1/255 的抬升）。
  坑一：锚点要放在舱内约束 ③ ④ **之前**，否则云越亮、④「舱内最多比窗外多提亮 4.5 档」把舱壁一起压暗（clouds-variety 139 → 123）。
  坑二：⑤ 雪景补偿的统计判据（h − o < 0.05–0.12）对画面内容很敏感：C01 让云里的雾不再均匀，in-cloud 的 h − o 0.016 → 0.097，窗外 188 → 141；阈值又加宽不得（fuji-day 是 0.129）。改为再加一条直接判据「飞机在云里」（`EXPOSURE_WHITEOUT`，clouds.ts 的 keyVisibility 按密度探针写）。识别：`meta.json` 里 adapted 的 z − x（`handoff/C01-measure.mjs` 输出）。
  坑三：抬曝光会把云芯明暗推进 AgX 肩部，显示上的对比被压掉约三成（HDR ×1.7 → 显示 ×1.4）；EV 取 14.5 更亮但更平，取 15 是折中。（TM01 已补，见下条）
- **白天窗外的受光云在 AgX 肩部丢对比：换整条曲线会连天空 / 海一起变，只能在 AgX 之前局部抬高光段斜率**（TM01）：
  现象：C02 以后满窗云海更亮了，但 HDR 里 ×1.8 的云芯对比到屏幕上只剩 ×1.45（clouds-variety int_c）。
  根因：three 的 AgX 在中灰以上显示斜率一路变缓——d ln(sRGB)/d ln(输入) 在屏幕 160 处约 0.28，203 处 0.18。
  试过三种（同页冻结 A/B，`handoff/TM01.md`）：① AgX + Blender Punchy（power 1.35、sat 1.4）——云对比够了，但天空 / 海的 R 通道 81 → 37，整窗变深变艳；
  ② Khronos PBR Neutral——对比最高，但云变奶黄（183/170/155）、天空暗 20+；③（采用）AgX 之前按亮度在中灰 +0.5 → +2.5 档把对数斜率 ×1.4，
  +2.5 以上**按最大通道**（再按饱和度前移 0.3 ×（最大通道 − 亮度））收回、+5.0 归零（`dayHighlightGain`，只乘标量），
  门控 = day ×（1 − 均匀视野）× 窗外遮罩 × **云覆盖**（曝光合成读云缓冲的不透明度，`main.ts` 每帧 `finalMat.uniforms.uClouds.value = clouds.texture`）。
  坑一：只在「顶点以上斜率回到 1」时，顶点以上整体抬 1 档，太阳 / 夕照附近跟着亮；收回到 AgX 白点（+6.5）也不够——sunset-wing 夕照的橙色云边最大通道先到顶，
  ≥250 像素 1.1% → 4.3%。按最大通道定位收回段后，+4.0 归零时不升、+5.0 时 +0.21%（都是 R 通道 249 → 250，AgX 里暖色云边的 R 本来就停在 249）；
  再按饱和度把收回段前移 0.3 ×（最大通道 − 亮度）后 +0.046%。前移倍数 ≥ 0.5 或「按饱和度淡出」会把夕照 / 逆光场景的效果整个关掉（暖色受光云的 m − l 本来就有 0.5 档以上）。
  坑四（审查返工）：收回段越窄，最亮一段被压得越扁——收回到 +4.0 时 +2.5 → +4 档的局部显示对比只剩 AgX 的 0.39，逆光银边、砧顶细节 ×0.86–0.94、rim90 下降。
  这是**有界显示范围的必然代价**：白点不动、膝点以下（天空 / 海）不动，中间一段拉开多少，上面一段就得压回多少；离线复刻 AgX 扫了 480 组参数，
  没有一组能同时做到「云体 144–203 跨度 ≥ ×1.2」和「215–235 段 ≥ ×0.95」。定稿取收回到 +5.0（0.39 → 0.54），斜率 1.4 与 1.2 / 1.3 的取舍见 `handoff/TM01.md`。
  坑五：整窗都给增益时，太阳光晕（天空）也被抬：backlit-cu 太阳周围 ≥200 的面积 +34%，成了一团更大的奶白光斑。按云不透明度门控后逐位不变。
  坑二：C02 的硬 max 改成软拐角时，写成 `max(g,0) + 0.5·max(0.5 − |g|, 0)²` 离线 FXC 让 exposure-final 慢 10–15%，换成逐点相等的铰链
  `0.5·clamp(g + 0.5, 0, 1)² + max(g − 0.5, 0)` 就持平；四个铰链向量化成一次 vec4 运算后，高光段的增量也在噪声内（+1–2%）。
  坑三：「锚点以上保留一部分自适应」（审查建议的有限自适应）会经 ③ ④ 把舱壁一起压暗（留 30% 时 clouds-variety 舱壁 148 → 140），没采用。
  识别：`handoff/TM01-measure.mjs --vfile handoff/TM01-ab.mjs`（base / soft / hi / final）+ `C01-metrics.py`（int_c）+ `TM01-stats.py`（窗 / 舱壁 / 云 / 非云的 RGB、相邻像素差、≥250 比例）；
  棋盘纹用 `--live` 的实时单帧 + `TM01-hf.py`（相邻像素差与低频差同比变化 = 没有新增高频噪点）；最亮一段的细节与太阳光晕用 `TM01-band.py`（按参考变体显示亮度分段的高频 std 比、`--sun x,y` 光晕面积）。
- **「云体对比拉开」与「最亮段细节不压」要同时成立，得用局部色调映射：曲线按低通取、细节按另一条斜率加回**（TM02，`handoff/TM02.md`）：
  做法：TM01 的增益改成 `G(b) + (S(b) − 1)·(l − b)`，b = 眩光（`uBloom`，本来就读，不多占 sampler）的亮度；中间段 S − 1 = G' × sd/s（sd = s 时一阶泰勒等于全局曲线），
  收回段 G' 截到 0（细节不跟着收回）再加 κ·G(b) 补 AgX 肩部。参数 `uDayHiLocal = (sd 1.4, κ 0.4, σr 0.5, 开关)`，w = 0 逐位回到 TM01。
  坑一（光晕）：低通直接用（不做值域回落，σr = 100）时 sunset-wing 云边 8 px 内暗 1 级、storm-day 砧边亮 1.8 级。低通按值域回落 `d' = d / (1 + (d/σr)²)`（双边滤波的廉价近似：跨云边 / 太阳光晕的大落差退回全局曲线）
  + 结果截到 ≥ 0 后，全部白天场景光晕 ≤ 1.3 级、≤ 8 px（storm-day 砧边最大），天空一侧逐位为 0（云不透明度门控）。
  坑二（≥250）：「白点前淡出局部项」按**低通位置**的最大通道判断时对 ≥250 没用——夕照橙色云边比周围亮，按低通取曲线拿到的增益比全局大（全局在收回段已是 0），
  推进 249 → 250（sunset-wing +0.06%）。要按**像素自己**的最大通道（含饱和度前移）在收回终点前 1 档内把 d 淡到 0（`uDayHiLocalTop`），之后 ≥250 与 master 逐位相同。
  坑三：眩光低通最细一级（半分辨率、约 2 px）占权重 45%，σ ≤ 2 px 的细节才完整算「细节」，2–8 px 的结构一半按曲线走——所以最亮段只从 ×0.95 回到 ×0.97，不是 ×1.0；要更多得另加更宽的低通（多采几次 uBloom 或新 mip），没做。
  识别：`TM01-measure.mjs --vfile handoff/TM02-ab.mjs`（off / master / g14 / final / master2 噪声底 / mask 窗外遮罩），`TM02-band.py`（TM01-band 加窗内遮罩：TM01 里 cu-side 215–230 的 ×0.87 是窗框被 σ=2 低通跨窗边带动，不是云），
  `TM02-halo.py`（光晕：改变量减去「按参考亮度的中位改变量」后，按离云边距离分格看残差；逐点曲线的残差恒 ≈ 0，可当对照）。
- **按屏幕位置读云缓冲做门控，会把挡在云前的东西一起算成云**（TM01 回归，美术总监 wave7 第 1 条，TM02 修）：
  现象：正午机翼白漆上一块块亮 4–12 级、1 px 硬边、跟着背后积云滑动的「迷彩」斑（biz-seated 1× 可见）。根因：高光段门控 `smoothstep(云不透明度)` 读的是云缓冲，机翼在窗外遮罩里，白漆又刚好在高光段。
  修法：曝光合成另读机翼 pass 之前的场景 HDR（`uPreWing` = main.ts 的 `hdr`），机翼 pass 在没有机翼的像素上逐位照抄，**逐通道相对差 > 1e-4 就是被挡住**，门控乘 1 − 它。
  坑：门限按相对亮度差 0.002 → 0.02 时，白漆与背后白云亮度相近的像素漏过去，翼面留一片散点——只能用「逐位相同」这个严格判据。不要把覆盖率打包进 `hdrWing` 的 alpha：测光 pass 在半纹素位置双线性采它，打包值会在机翼边界插值成乱码。
  没管到：地形 / 奇观剪影挡在云前（不经机翼 pass），要窗外 pass 输出有效云不透明度才能根治。识别：`TM02-wing.py`（机翼区相对高光段全关的逐像素差）+ `TM02-ab.mjs` 的 tm01bug / noOcc 变体。
  另两处已知的边界（TM02 审查，低）：机翼剪影边缘 1 px 细线不提亮（背后受光云时暗 4–13 级、与剪影重合，肉眼不可见；根治要机翼 pass 输出覆盖率）；薄雾 + 频闪时翼尖灯的雾中散射会让天空 / 海被判成「机翼覆盖」，这些区域本不提亮，无影响。

<a id="pit-ground"></a>
### 地面与数据

- **加速播放（连续航程 60×）会把影像瓦片服务器打到限流**（T19a）：飞机每秒走 15 km，8–32 km 的细级别 clipmap 每一两帧就重建，EOX 每分钟约 7000 个请求，被拒时返回的错误页不带 CORS 头，控制台刷出上万条 `blocked by CORS policy`（看起来像 CORS 配置错误，其实是限流）。只给 `ground.update` 加时间节流没用：请求量约正比于「飞过的距离 × 细级别数」。
  修法：`ground.setMinLevel()` 按流速停用最细几级（10× 停 1 级，≥30× 停 3 级），60× 降到每分钟约 550 个，1× 基线约 95。以后怎么识别：`handoff/T19a-voyage.mjs` 的 summary 里有 `requestsPerRealMin` 和 `consoleErrorCount`。
- **连续航程不调 `setPreset`**（T19a）：接下一段只换 `state.preset`（导航目标、时区、霾），不换本地坐标原点，否则地面、云场都会重建。离原点太远时由导演借穿云或深夜「换原点」（`director.ts` 的 rebase 请求），经纬度、高度、航向都连续，只有云场和海浪的噪声原点会跳一下。
- **时间加速时「原地掉头、坡度一帧打满」**（T49，用户反馈「有时飞机会大幅转向倾斜，不知道怎么触发」）：现象是连续航程 10× / 60× 到达终点接下一段时，飞机在 2–3 真实秒内掉头 100–170°、坡度一帧到 25°。根因两条：①转弯与坡度平滑都按**模拟**时间算（ω = g·tanφ / v、坡度时间常数 1.4 模拟秒），60× 下航向变化率 63°/真实秒、滚转速率 500–760°/真实秒；②`pickNextLeg` 不看方向，接力时 71% 的下一段要转 > 90°（航线网是放射状的，到了新千岁 / 那霸 / 广州这种端点只能掉头）。修法（flight.ts 自动驾驶 + director.ts）：坡度按**真实时间**以 ≤ 3°/s 趋近目标坡度，时间加速时按「窗外转动 ≤ 6°/真实秒」降低坡度上限（10× 约 15°、60× 约 2.5°，转弯半径相应变大）；航向由实际坡度按协调转弯算，不再直接设角速度；接力优先挑与到达航向夹角 ≤ 90° 的下一段（离终点 400 km 预挑），按转弯半径提前开始转；只能掉头且时间加速（10× / 60×）时机翼改平直飞，等穿云（在云里直接换向）或入夜，最多等 8 模拟分钟或 45 真实秒再照常转；1× 直接照常转（25° 坡度约 3 分钟掉头）。**等待时限只能用导演自己累加的时钟**（审查 P1）：不开连续航程时 `state.simTime` 只随「时间流速」走（默认暂停），拖时间滑块还会倒退，拿它当时钟会让排队永远不放行、飞机一直直飞（`T49-test.mts` 第 9 项）。以后怎么识别：`handoff/T49-sim.mts 60 20` 列出的 > 60° 转向事件时长应在十几到几十真实秒、最大滚转速率 3°/s；`handoff/T49-test.mts` 全部通过。
- **时间加速下转弯半径很大，目的地又近时会绕着它转圈**（T49）：60× 巡航时转弯半径约 170 km，直飞一个 100 km 外、在身后的机场时，一直压坡度会让机场始终落在转弯圆里。`navDiff()` 在「终点落在转弯圆内」（距离 < 2r·sin|Δ|）时先改平直飞出去，再转回来。改转弯参数时跑 `T49-test.mts` 第 6 项（直飞伊丹后盘旋）。
- **海面天空反射不能再乘相机→海面的透射率**。天空视图 LUT 是从相机算的，本身已经包含这段衰减。
  现象：黄昏时地平线下方有一条细暗线。起初以为是 LUT 在地平线处跨行插值，改了夹取以后暗线还在，才找到真正原因。
  修法：反射贡献 = F·(L相机(反射方向) − 内散射(相机→海面))。LUT 的地平线夹取也保留了，它本身没错。
- **低空时耀斑侧面有一道「竖直断层」，不是 bug**：那是耀斑波瓣的边缘。耀斑中心过曝，又是平滑的高斯分布，所以边界显得锐利；换风速后边界会跟着移动。
  排查时先后怀疑过风痕（确实太陡，已经放软）、闪烁、云影，用 `uDebug` 5–10 逐项排除后才确认。以后判断方法：改风速，看边界是否移动。
- **海平面近处求交**：从 r≈6360 km 出发的通用球面求交在近处有约半米误差，会让海浪纹理出现与视角相关的颗粒噪点；`oceanRadiance` 里用 t = c / (−b + √(b²−c)) 重算。
- **影像瓦片取不到时不能露底色**：`clipmap.buildImagery` 预先给画布涂深海色 `rgb(8,22,40)`，某张瓦片偶发失败（网络 / 限流）就露出一块直边的「深海色陆地」，而 `loadBitmap` 还把失败永久缓存。修法：除最粗一级外缺瓦片处留透明，`sampleGround` 按透明度回退到粗一级；失败不缓存、重建时重试。识别：陆地上出现直边、颜色恰为深海底色的色块。测回退：`page.route` 拦掉一部分瓦片（`page.unroute` 必须传同一个正则对象，否则拦截不解除）。
- **换预设后紧接着设高度，会被上一个地点的高度下限夹住**（T18）：回归脚本在同一帧里先切预设再设高度，这时 `state.floor` 和滑块 `min` 还是旧地点的，浏览器把 0.6 夹成了 2.6。修法：换预设 / 开关真实地理时立刻 `resetAltitudeFloor` 并同步滑块 `min`。识别：海上场景的高度恰好等于上一个陆地场景的下限。
- **clipmap 里的细线（道路）不能存覆盖率，要存有向距离**（T08）：clipmap 纹素在巡航高度的中远处是 60–250 m，比屏幕像素在地面上的宽度大 2–3 倍，
  覆盖率图双线性放大后每条路是 2 个纹素宽的软带子（4–6 个屏幕像素，糊）。改存「到最近中心线的有向距离」（`road-raster.ts`），双线性能在纹素内还原线位，
  着色器按像素足迹解析抗锯齿，线细到 1 像素。坑一：**无符号**距离（或帐篷形剖面）双线性后线会被吸到纹素中心、线上最小值在 0–0.5 纹素之间跳，
  亮度沿线一节一节地变（锯齿），必须有符号。坑二：有符号距离在两条路之间、在路的负侧与「无路」之间会跳变，插值出假零点 = 假线；
  用「照亮宽度」只写在中心线 2 纹素内当遮罩 + 中心处梯度 |∇sd| ≫ 1 判假线挡掉。识别：`uDebug = 24` 里路中间或路旁平行多出一条线。
- **斜看时细线 / 点状图案要按足迹的长轴过滤**（T08）：像素在地面上的足迹沿视线方向是横向的 1/cosθ 倍（贴近地平线几十倍）。只按横向足迹选级、取一个点，
  和视线垂直的路（屏幕上横着的路）会断成虚线、飞机一动就闪。`groundRoadCoverage` 沿长轴取 1–6 个点，每点只负责长轴的 1/n。
  实测（`handoff/T08-flicker.mjs` + `T08-flicker.py`，亚像素步进 20 帧，块能量变异系数）：各向异性 中位 0.021 / p98 0.074，只取一点 0.059 / 0.18。
  近处路灯光斑、城市灯点这类「每格一个点」的图案同理：光斑要按足迹的椭圆展宽（长轴方向用长轴），否则成串的单像素横向短划。
  **已知未修**：城市灯点（`groundLand` 里 30 m 一格的光点）仍只按短轴展宽，斜看时是横向短划（base 截图里就有）；展宽超过半格后只算本格一盏灯，
  远处城市按 1/r² 变暗。T08 试过按椭圆展宽 + 远处换成期望值，城区在中距离变成过曝的平涂白斑（城区遮罩的形状露出来），观感更差，已撤回，留给单独的任务。
- **细线过曝会丢掉抗锯齿**（T08）：解析抗锯齿靠边上像素的灰阶，线的亮度一旦超过夜间曝光的白点，边上像素也被截成同一个平色，看起来就是台阶。
  道路灯带的亮度（`ROAD_LUMINANCE`）按「低空 4 km 看城市时满覆盖的路也不过曝」定。识别：放大看线全是一个颜色、边缘是像素台阶。
- **矢量瓦片的线有贴着缓冲区边走的段**（T08）：瓦片外有 64 单位缓冲，裁剪后有些线沿缓冲区的边走一段（每张 z9–z12 瓦片 2–19 段），画出来是沿经线 / 纬线
  笔直几十公里的假线。道路（`RoadTileBuilder`）和河道（`tiles.ts` 的 `insideTile`）都删掉整段在瓦片以外的线段。识别：从舷窗斜看有横贯画面的笔直水平亮线。
- **影像纹理的 A 通道兼存道路照亮宽度**（T08）：水体纹理 RGBA 已满（R 水面、G 海洋、B 夜光、A 道路有向距离），照亮宽度放进影像的 A：
  < 0.5 表示「缺影像的比例 / 2」（原来的缺瓦片回退语义），≥ 0.5 表示有影像、其余 7 位是宽度。读影像 alpha 判断缺瓦片一律用 `min(A·2, 1)`
  （`sampleGroundAlbedo`）；水体纹理不能走带缺瓦片回退的采样（`sampleGround` 已拆成两个入口）。
- **clipmap 重建时的 CPU 活要放 Worker**（T08）：一级道路几万到十几万个顶点，主线程上投影 + 逐段求距离实测每级 25–180 ms，1M 像素的浮点合成循环 15–40 ms，
  飞行中每重建一级就卡一下。现在投影、抽稀、求距离、和夜光 / 影像合成都在 `road-raster.worker.ts`，像素缓冲区转移过去再转移回来（主线程上那一遍夜光拷贝循环也省了）。
  识别：`handoff/T08-shots.mjs --longtask 30` 统计长任务。
- **照亮宽度的解码要和编码逐位对上**（T43）：影像 A 存 `128 + 宽度 × 127 / ROAD_W_MAX`，T08 的着色器按 `A·2 − 1` 解码，「不亮」的 128 被解成 0.16 m，
  所有没亮的路（田里的每一条乡道）都剩一根等亮的灰线，路网看上去就是一张地图。现按 `(A·255 − 128) / 127` 还原。识别：调试 24 里偏远地区的路全是一样亮的细灰线。
- **NASA Black Marble 不能当「有没有人」的判据**（T43）：GIBS 上的是拉伸过的可视化产品，关东平原一张 z8 瓦片一半以上像素 ≥ 0.45、九成 ≥ 0.05
  （`handoff/T43-night-hist.py`）。只按夜光决定路亮不亮，平原上所有乡道都亮。现在用「夜光² × 影像建成区」（和城市灯点同一判据）在 0.4 km 内的平均（`road-raster.ts` 的聚落地毯），
  农田、山林里的路自然暗掉。以后给任何夜间效果定「城 / 乡」，先看这个分布。
- **细线的解析抗锯齿要用帐篷核，不能用盒子**（T43）：盒子足迹下，比像素窄的线的剖面是「像素中心离线 < F/2 就满亮、否则全暗」，线是 1 像素的台阶，飞机一动台阶沿线爬；
  块能量守恒，所以 `T08-flicker.py` 的块能量变异系数量不出来。换帐篷核（半宽 F）后线按距离线性分到相邻两像素。量法：`handoff/T43-crawl.py`（逐像素时间二阶差分 ÷ 亮度）。
- **预算内的简化交通工具模型，近距离会露出「其实是个球」的破绽**（T40，用户反馈插单）：`traffic.glsl.ts` 的远处飞机没有机翼 / 机身细节，只是按角尺寸画的一个均匀亮斑，角直径一旦超过几个像素就会被识别成「一个变大的圆点」而不是飞机；旧版航线还带 ±0.6 rad（约 ±34°）的随机交叉角、横向距离下限只有 8 km，经常斜穿我们的航迹，两架飞机的航迹也可能互相交叉。
  修法两层：①航线设计——先按目标屏幕像素数反推最小距离（1600×1200、默认视场下，`pixelAngle = 2·tan(25°)/1200`，机体角直径(px) ≈ 51.5/dist(km)，要求 ≤ 约 3 px ⟹ dist ≥ 18 km，见 `traffic.ts` 文件头），对飞只给 ≤3° 交叉角、同向慢慢超越干脆不给交叉角（相对速度小、经过时间长，一点交叉角也会累积出大幅侧向漂移），出生时的横向距离下限按「最坏交叉角 × 最大出生距离」的漂移量再加出来；两条「车道」留够间隙防止互相交叉。②着色器兜底（与航线设计无关，防任何路径下露馅）：机体显示半径按像素数夹住（超过阈值只留一个不再变大的小亮点，`BODY_MAX_PX`）、航迹云按「离我们最近的一点」整体安全淡出（`TRAFFIC_MIN_DIST_KM`，需要和 `traffic.ts` 的 `MIN_DIST_KM` 保持一致）。
  识别 / 验证：`handoff/T40.md` 里的推算和离线抽样脚本（10000 次 spawn 模拟，统计最近距离最小值和两机相互最近距离，同类改动可以复用这个思路）；以后再给别的远处简化模型（船、车）设计运动路径，先按这个套路算「肉眼能看出简化痕迹」对应的像素阈值。
- **地面瓦片重建的 CPU 尖峰不在纹理上传里，在 `getImageData` + 逐顶点投影 + 逐像素变换**（PERF-9，接续 PERF-8）：route-hnd-cts 60× 加速航程下，PERF-8 把 `texSubImage3D` 的尖峰压下去后，仍有 60–105 ms 的主线程长任务、`texBytes=0`。CDP CPU 剖析（`Profiler.start/stop`，方法见 `handoff/PERF-9.md`）定位到主因是 `clipmap.ts` 的 `buildWater`（Path2D 画水体/河道 + `getImageData` 读回 + 逐顶点 `tileYToLat`/`tileXToLon` 投影）和 `buildNight`（读回夜光瓦片后逐像素做「亮度减蓝色底」变换），这些都在主线程同步跑，`coarseGrid`（PERF-6-8 当时怀疑的对象）实测占比很小。
  修法：把水体/河道的栅格化和夜光变换都搬进已有的 `road-raster.worker.ts`（用 `OffscreenCanvas`——主线程和 Worker 都能创建，同一份代码两边通用；水体几何改存扁平数组 `WaterTileData`，格式对齐已有的 `RoadTileData`，见 `road-raster.ts` 的 `WaterTileBuilder`），和道路 SDF 叠加一起做，只留 `getImageData` 返回后传两个 Transferable 数组回主线程。`buildImagery`/`buildNight` 的取瓦片 + `getImageData` 仍在主线程（它们的画布内容来自 `ImageBitmap`，缓存在主线程 `tiles.ts` 的 LRU 里给下次重建复用，转移会 detach 破坏复用，要挪得把整条 fetch/decode/缓存链路搬进 Worker，改动更大，留给后续）。
  实测（route-hnd-cts 60×，25 秒窗口）：`dt > 16 ms` 的帧从 95/3622（2.62%）降到 38/3893（0.98%），落在「50–105 ms」这个尖峰区间的帧从 17 个降到 1 个（压线在 100 ms）。识别：`buildWater`/`buildNight` 的 `getImageData` 或 `tileYToLat` 在 CPU 剖析的 self time 排行里名列前茅，且集中在 `dt > 16 ms` 的帧里；复现方法见 `handoff/PERF-9.md`「剖析方法」。
- **每个 404 都会在控制台记一条 error，JS 拦不住**（G02 / G03）：国土地理院在日本以外、海上返回 404（带 CORS 头，状态码读得到），`fetch` 被 `catch` 住也没用，Chrome 仍在控制台打「Failed to load resource: the server responded with a status of 404」，验收的「控制台无 error」就过不了。负缓存只能让每张瓦片只出一次。
  修法：请求前先筛——覆盖框按日本各地分成几块（`GSI_PHOTO.bounds`，避开朝鲜半岛），再用同一级的 DEM 筛掉整张都是海的瓦片（`clipmap.detailTileWanted`）。坑中坑：**不能按「海底 < −5 m」判海**，近岸 DEM 来自 SRTM，海面是 0 m 而不是负值（骏河湾北岸一整排 z14 瓦片被当成陆地、全部 404）；改成「有像素 > 0.5 m 才算有陆地」后 fuji / kanto 低空实测 0 个 404。识别：`__voyage.ground.imageryStats.hosts[…].recentMissing` 列最近「确定没有」的地址。以后接 Esri：它缺数据是 200 + 占位图（research/IMAGERY.md §2.1），走 `isPlaceholder`，不会刷 404。
- **高清源不能直接换 EOX，要做频率分离 + 反差匹配**（G03）：GSI 在 z14 比 EOX 亮约 1.6–2 倍、发灰，批次之间有拼接缝；直接贴上去，`landClasses` / 城市灯点 / 路灯聚落地毯的判据全变。只取 GSI 的「H / H_low」细节比乘到 EOX 的低频上可以保住色调，但**EOX 2025 本身在 10–30 m 已经有不少纹理，GSI 航拍发雾，细节比的幅度比 EOX 的还小**：第一版（不做反差匹配、GSI 用 z14）实测低空看机翼视角整片地面反而变「平」，高尔夫球场、田块的纹理消失。修法：按局部细节能量把 GSI 的细节放大到 EOX 的水平（增益 0.8–2.5），第 0 级改取 z15 再 2:1 缩小。识别：`__voyage.ground.detailEnabled = false` 做同机位 A/B（`handoff/G01-03.md`）。
- **高清细节只在白天用，而且要在灯光看得见之前关掉**（G03，审查 R1 修正）：第一版按太阳 −2° 开 / −4° 关，可路灯在约 +3.4° 就开始亮（`groundRoadLights`），城市灯点不看太阳；日落前后二三十分钟里灯光按混了航拍的颜色判建成区，到 −4° 最细两级整层重建，灯光当场换一版。修法两条：①门限改成 +6° 开 / +4.5° 关，换回纯 EOX 的重建发生在白天；②路灯的聚落地毯改用混合**之前**的 EOX 颜色算（`LevelPixels.urbanAlbedo`），A 通道的照亮宽度与细节层完全无关。城市灯点（着色器逐像素读 RGB）仍靠①。识别：黄昏同机位拨 `__voyage.ground.detailEnabled`，灯光不应有任何变化。
- **GSI 取不齐时先出纯 EOX**（G03，审查 S2）：刚进日本 / 刚降到低空时最细两级要 100–160 张 GSI，令牌桶排队可达 20 s，而 `build()` 等所有数据，这段时间最细一级连 EOX 都不跟着重新居中。现在细节限时 3 s（`DETAIL_WAIT_MS`），没齐就按纯 EOX 出这一版、记成没有细节，下一帧再建一次补上。
- **Worker 里的高清合成一级约 0.35–0.4 s**（G03，1024² 四通道两遍盒滤波 + 局部能量）：只在低空 / 看机翼、日本、≤ 2× 时的最细两级发生，但 Worker 是串行的，同一时刻别的级别的水体 / 道路合成会排在它后面。按列走的纵向滤波曾让它到 0.6 s（缓存不友好），已改成按整行累加。以后要再加东西先看 `blendDetail` 的分段耗时。
- **巡航地面糊的根因是 clipmap 纹素，不是影像源；级别的覆盖范围是硬约束**（G06）：按距离选级（`groundLod` 的 `0.85·GROUND_BASE` 项）实质是「这个距离上只能用盖得住它的那一级」，想在同一距离上细一倍只能每级像素翻倍（1024² → 2048²），单纯把选级系数调细会落到 `usableLevel` 的回退、画面上多出一圈硬接缝。纹素变细后必须同时做 mipmap + 各向异性（`groundSampleAniso`：光线微分算足迹、带地形法线，`textureGrad`），否则沿视线方向欠采样更重：只调到 2048 不做各向异性，近地平线一带相邻像素差 0.66 → 0.82（亮斑点闪）。识别：`node handoff/G06-ratio.mjs` 看纹素 / 横足迹；`handoff/G06-flicker.mjs`（`G06_MOVE=米/帧` 让飞机真的前进，不是转头）量闪烁。
- **影像 / 水体纹理有 mipmap 以后，读 A 通道一律 `textureLod(…, 0.0)`**（G06）：两张纹理的 A 都是编码值（影像 A = 缺影像比例 / 道路照亮宽度，水体 A = 道路有向距离），mip 是平均出来的，解码没有意义。`groundRoadTap` 等道路代码按第 0 级读；各向异性取样只用 RGB 和「缺影像比例」（平均后恰好是比例，有路的纹素 A > 0.5 只会让瓦片缺失的过渡略偏）。以后给这两张纹理加任何读 A 的代码，先确认读的是第 0 级。
- **DataArrayTexture 的每层尺寸必须一致，而且 three 会把 `image.data` 整块常驻在 CPU 上**（G06）：2048² × 4 × 7 层一张 117 MB，两张就让 JS 堆 212 → 440 MB。现在用 `LayerStage`（clipmap.ts）只在上传那一刻把这一层交给 three（three r186 按层上传只调 `image.data.subarray()`），构造时 `source.dataReady = false` 只分配不传；CPU 上要读夜光的 light-pollution 改读 `ground.nightSample`（每级 64² 的采样网格）。坑：谁再去读 `ground.albedo/water.image.data` 会拿到空数组；上下文丢失后 three 整块重传拿到的也是空数组（纹理内容丢，不崩）。
- **一次 texSubImage3D 传 16 MB 在主线程上要 8–15 ms，4 MB 只要 0.5 ms**（G06，非线性，推测是 Chrome 命令缓冲的传输区放不下、改走同步大块共享内存）：2048² 一层按 three 的按层上传就是 16 MB 一次。现在 `ground.attachGl(renderer)`（main.ts）后 `uploadDirect` 按 512 行一块直接调 GL（恢复当前纹理单元绑定与 pixelStorei，three 的状态缓存不乱），没接上时退回 three。剩下的偶发 20–40 ms 帧（1× 约 5 帧 / 90 s）CPU 剖析显示主线程在 idle，是 GPU 侧（生成整个数组的 mip、Worker 读回位图）。**「是整组 generateMipmap」这一推测在 5090 上已推翻**（G07）：整组 7 层 × 12 级生成 GPU 实测只要约 1.3 ms，同页交替 A/B（`handoff/G07-spikes.mjs`）里 > 16.7 ms 的帧几乎都不落在有上传的帧上（两种做法各 10–17 个 / 3 分钟，和上传相关的 0–2 个）；集显上整组生成的带宽（约 150 MB）才是问题，G07 已改成 Worker 按层生成、按级上传。识别：`handoff/G06-stream.mjs <端口> <流速> <秒>`（帧间隔分桶、上传耗时、Worker 耗时、各站点请求 / 分）。（2026-09-28 G07b：剩下的尖峰已归因到 Worker 里的 GPU 读回，见本节「Worker 里对 GPU 画布 / GPU 位图的读回会让主线程掉帧」一条。）
- **2048² 的 getImageData 不能放主线程；画布也不能用 CPU 画布画完交给 Worker**（G06）：影像 / 高清细节在主线程的 OffscreenCanvas（GPU 画布）上画瓦片，`transferToImageBitmap()` 交给 Worker 读回像素。试过 `willReadFrequently`（CPU 画布）：主线程上 100 多张瓦片的 drawImage 变成长任务，1× 巡航 2 分钟 35 个 > 50 ms。夜光数据本身约 500 m，照旧按 1024 取、Worker 里双线性放大。
- **加速航程时瓦片按 1024 选缩放级，矢量一律按 1024 选**（G06）：影像按 2048 选时 1× 巡航 EOX 请求 85 → 158 / 分；流速 > 2× 改按 1024（`FINE_MAX_RATE`，60× 实测 EOX 718 / 分，master 726），流速降回来后非 fine 的级别重建一次。矢量瓦片换缩放级会让 OpenMapTiles 按级取舍的道路等级 / 简化变，夜间路网就换一版，所以只在 2048² 上栅格化、不换级。代价：Worker 每级 0.25–0.75 s（像素多 4 倍），60× 下 Worker 忙到约 95%。
- **一次重建的三张纹理分帧上传、最后才换中心 → 中间 1–2 帧整级影像错位 1/8 边长**（G07 发现，PERF-8 起就有）：`drainUploads` 每帧只传一张（影像 → 水体 → 高度），`levelUniform` 在最后一张传完才换成新中心；中间几帧着色器按**旧中心**读**新影像**，第 4 级就是整级平移 16 km，每次重建闪一下。冻结后逐帧 readPixels 实测 master 上恰好 2 帧尖峰（平均差 0.158，其余帧 < 0.02）。修法：暂存上传（`drainStaged`）——像素按帧分块（每帧 ≤ 4 MB）写进一个 PIXEL_UNPACK_BUFFER，写完后**同一帧**里从缓冲拷进影像 / 水体（第 0 级 + mip）、传高度、换中心；主线程每帧 ≤ 0.2 ms（中位），换上那一帧 ≤ 5 ms。以后任何「分帧上传 + 最后换元数据」的设计都要问一句：中间帧读到的是不是半新半旧。识别：`node handoff/G07-recenter.mjs <端口> 4`（让一级偏开 1/8 重建，打印逐帧差异尖峰；`__voyage.ground.stagedUpload = false` 退回旧做法对照）。
- **夜里城市灯点 / 路灯对影像的锐度非线性敏感：同一片地面换一个影像缩放级，灯光整片换一版**（G07）：灯点按影像颜色判建成区（`smoothstep` 之后再平方、再 `smoothstep`），路灯按影像算聚落地毯，影像糊一点，过门限的像素就少一大截。同页把全部级别从「1024 缩放级」升级到「2048 缩放级」：白天平均差 0.03–0.12（p99 ≤ 2.7），夜里 1.25–1.9（p99 23–45）。所以首载「先粗后细」只在白天做，太阳低于 +6° 时直接按细级建（`updateWarm`）。同一个问题在加速航程（> 2× 按 1024 取）降回 1× 后的重建里也有（G06 起就有，未处理）。识别：夜景同页 `v.ground.warm = false; v.ground.rebuildAll()` 再改回 true 对照。
- **GROUND_RES 在模块加载时定死（`quality.ts` 的 `GROUND_RES_DECISION`），运行时不许改**（G07）：它同时是纹理不可变尺寸、着色器常量、瓦片缩放级依据。自动判定开一个临时 WebGL2 上下文读渲染器字符串：页面里**第一个**上下文要初始化 GPU 进程 / ANGLE 设备（实测 380 ms），之后的上下文只要约 6 ms，所以探测只是把主渲染器本来要付的初始化提前，净增约 6 ms（`handoff/G07-probecost.mjs`）。离线工具（node）里恒为 2048，着色器文本与 G06 逐字相同。调试：`?groundres=1024|2048`（压过面板）。规则自检：`handoff/G07-gpu-rules.mts`（「Radeon RX Vega 8 Graphics」是 APU，名字里也带 RX）。（2026-09-28 G07b 改：G07 原来让手动画质档跨载入记忆（`voyage.quality`）并决定地面精度，为了看云选过一次「中」之后每次载入地面都是 1024²，Safari 想要 2048 只能选「高」、失去自动降档。现在两者解耦：画质档每次载入从「自动」起步、不记忆；地面精度是面板单独一项「自动 / 2048² / 1024²」，只有它的手动选择记在 localStorage `voyage.groundRes`，下次载入生效，状态行 `#ground-res-status` 提示；旧键 `voyage.quality` 载入时清掉。端到端检查：`node handoff/G07b-panel.mjs <端口>`。）
- **Worker 里对 GPU 画布 / GPU 位图的读回会让主线程掉帧：1× 巡航偶发 23–47 ms 帧的真正来源**（G07b 查清，G06 起就有）：G06 / G07 审查怀疑过整组 generateMipmap、暂存上传、mip 临时缓冲的 GC，都不对。给 Worker 每次任务记精确起止与分阶段时刻（`imageryStats.worker.recent[].marks`：read / water / waterRead / detail / night / roads / mips）后，同页交替 16 分钟里 26 个尖峰有 23 个落在两段**GPU 读回**里：`readBitmap`（主线程 GPU 画布拼好的影像位图 `drawImage` 到 CPU 画布再 `getImageData`，尖峰只出现在这一步比平时慢一倍的那几次，读 51–63 ms 对中位 24 ms）和水体画布的 `getImageData`（默认 2D 画布是 GPU 加速的）。GPU 进程同步读回 16 MB 期间，页面的合成 / WebGL 命令排在后面，主线程帧跟着卡 3–5 个 vsync。mip 阶段、上传帧、背靠背任务都没有尖峰。修法：水体画布 `getContext("2d", { willReadFrequently: true })` 走 CPU 栅格（多约 5 ms，在 Worker 里），waterRead 阶段的尖峰归零；影像画布同样改 CPU 会把代价搬到主线程（每次建级约 59 ms 长任务），已否决（`ground.imageryCanvasCpu` 留作对照）。剩下的 read 阶段尖峰要根治得把瓦片拼接整个挪进 Worker（把瓦片 ImageBitmap 克隆过去在 CPU 画布上画），见 `handoff/G07b.md`。以后凡是 Worker / 主线程里对 2048² 画布 `getImageData`，先问一句这张画布是不是 GPU 的。识别：`node handoff/G07b-spikes.mjs <端口> 60 4 G07b,cpuWater`（每个尖峰标出落在哪个阶段；`ground.waterCanvasCpu = false` 退回旧做法）。
- **GPU 探测的临时上下文会被 dev-browser 的 GPU 计时钩子抓走 → `bench` 的 gpu 列静默消失**（G07 引入，G07b 发现并修）：`dev-browser.mjs` 的 `installGlProbe` 在 `HTMLCanvasElement.getContext` 上挂钩子，把页面里**第一个** webgl2 上下文存成 `window.__glProbe` 做 timer query；G07 的地面精度探测在模块加载时用 `<canvas>` 开了第一个 webgl2 上下文、读完就 `loseContext()`，钩子抓到的是这个已丢失的上下文，`gpuTimedFrame` 拿不到扩展、按设计静默返回 null，`bench` 输出里的 `gpu=` 那一段就没了（不报错）。修法：探测优先用 `OffscreenCanvas`（钩子不管它），不支持 OffscreenCanvas WebGL2 的浏览器才退回 `<canvas>`。以后任何在主渲染器之前开的临时 WebGL 上下文都照此办理。识别：`node scripts/dev-browser.mjs bench --port <端口> --only noon-cumulus --rounds 2` 的输出行应带 `gpu=`。
- **GPU 探测要和主渲染器同一个 `powerPreference`**（G07 审查 L2，G07b 修）：双显卡 Mac 上默认值会拿到 Intel 核显、判成 1024，而主渲染器是 `high-performance` 的独显。临时上下文在 `finally` 里 `loseContext()`，读参数中途抛异常也释放。
- **直传 GL 要在第一次渲染之前就拿到纹理对象**（G07）：three 要到这张纹理第一次被渲染用到才 `texStorage3D`，而首载的几层常在窗外程序编完之前就建好，那时只能退回 three 整组上传 + 整组 generateMipmap。`attachGl(renderer)` 里直接 `renderer.initTexture()` 让它立即分配（对全 0 内容做唯一一次整组 generateMipmap）。
- **跨版本比地面截图时，先确认两边的 `ground.pending` 都归零了**（G07）：EOX 限流严重的时段，master 在 fuji 低空 / night-city 首载后 120 s 里 `pending` 一直是 26–160（失败的瓦片随每次重建重试），近处退到粗级、夜里灯点成团——和「新版本变了」看起来一模一样。强制全部重建后 master 的画面与 G07 一致（`handoff/G07-rebuild-check.mjs`）。判零回归用同页 A/B（`handoff/G07-pair.mjs`，同一页面切换做法后原地重建全部级别），噪声底 0。

<a id="pit-cabin"></a>
### 舱内与倒影

- **窗上的水要做成「折射」，不能画成线和圈**（T29）：旧版把水线画成深色细线加头上一个圆、水珠只剩一圈暗环，在亮背景前读成铅笔线、钉头和空心圆圈。
  现在 `waterOnPane` 只给水面坡度 / 覆盖率 / 暗边，`scene.ts` 按坡度偏折视线、`texelFetch` 偏移后的 `uOutside`，暗边只在下缘（月牙）。
  坑一：按真实折射率算，偏折是几十度 = 上百像素，点采样会在水珠里画出放射状条纹（像图钉），还读到窗板开口以外（那里 alpha = 0，黑）；`WATER_DEFLECT` 因此缩到物理值的约 1/10，开口外的样本退回不偏折。
  坑二：整圈暗环 = 空心圆圈；均匀的雾里折射前后一样，暗环是唯一可见的东西，必须弱且只留下缘。
  另：湿度按 ISA 气温门限（`flight.ts` 的 `outsideAirTempC`），高于约 4.6 km（ISA −15°C）不再挂水，已有的水按升华 / 吹干消退。
- **`fwidth` 做抗锯齿要设上限**：视线几乎贴着舱壁时，平面交点在无穷远处，导数巨大，会把遮光板、内衬、舱壁的颜色混在一起。
- 舱内色适应不能拿舱内平均色直接当白点（灰世界）：舱壁本身是暖白，平均色偏暖就会被当成暖光抵消，白天舱壁依然冷灰。要先除以饰面的平均反照率（`uCabinRefAlbedo`）得到光源色。改了舱内主材的反照率要同步这个值。
- **机翼自阴影用的距离场必须处处是真实距离的下界，包围要覆盖各个方向**（T22）：襟翼滑轨整流罩旧版只按展向 `|z − zf|` 包围，翼面上方几米高的点也只报几十厘米；软阴影估计 `14·d / 走过的距离` 把它当成「擦边」，整片上翼面被压暗，而且按步进采样离散成一圈圈年轮纹（夜景最明显），穿云时成迷彩块，小翼上成竖向分面、像镀铬。识别：`uWingDebug` 的 8（去自阴影）一开纹就没了；1（去鼓包）、4（去环境反射）无效。修法：包围加上竖直方向，最终距离再对包围取大兜底。改任何部件的距离场后都用 8 位对照一次。
- **球体追踪贴着表面掠射时步数会爆**（T22）：外轮廓附近的射线几乎和翼面相切，每步只挪近一点；边缘超采样的子射线从半路出发、64 步走不到前缘，四条都算「没打中」，像素整个露出背景，前缘外轮廓成了 1 像素的硬台阶。全局加步数能修，但机翼 pass 慢 40%。修法：外轮廓（非内轮廓）的子射线从命中点前 16 像素处出发；中心射线「还在逼近」时步数可以延长。对照开关：`uWingDebug` 的 64 / 128。
- **窗板对舱内的反射要有结构**（T24）：均匀的侧壁亮度会在夜里窗外暗时变成一层无结构的灰纱。现用 `cabin-reflect.glsl.ts` 沿镜面方向与简化舱内盒子求交（灯槽、行李架、对面洗墙光与暗舷窗、座椅暗区、自己头肩暗剪影），按「瞳孔 + 1.7° 角弥散 × 虚像距离」虚化；白天倒影低于窗外 0.3% 时整段跳过。坑：洗墙光在灯高处硬截断，不先按虚化宽度摊平会成一条刺眼白线；近处座椅按平面算的虚化太小，要给 0.25 m 下限；头按「被灯照亮」着色会成发亮的蛋，要画成暗剪影。
  **T34 修正**：暗剪影在开灯时读成倒影正中的「黑洞」，一刀切的 1.7° 虚化又把灯带抹成「天边的糊带」。现在按层虚化（大面 0.7°、边和亮线 0.35°、阅读灯光点 0.1° + 像素下限），开灯时头肩只是把背后的倒影压暗 13%、边缘按 3 倍虚化的一片（画成被照亮的脸 + 头发 + 肩膀试过，仍读成发亮的浅色蛋，协调者否掉），睡眠 / 全关不画头。
- **倒影「不比来源亮」不等于「不比屏幕上的舱壁亮」**（T34）：T30 的 ⑦ 只限曝光差，睡眠档倒影的来源（紧挨氛围灯的侧壁）比可见舱壁亮 30 倍，倒影在屏幕上仍是舱壁的 2.8 倍。修法：`exposure.ts` ⑧ 按显示亮度加硬上限（面状倒影 ≤ k · 舱内均值，暗处 k = 0.2），阅读灯光点不进上限。识别：`handoff/T34-stats.py` 看「面/墙」。
  坑一：上限公式里 `log2(窗外亮度)` 夜里是 −inf，乘权重 0 得 NaN，NaN 进测光后整屏曝光崩（舱壁一起跳）——log 的参数先 max 一个小正数。
  坑二：切 `uDebug` 拍调试图时适应还在走，窗外置黑几百毫秒后曝光就变了；拍之前把 `exposure.adaptMat.uniforms.uDt` 钉成 0。
- **色适应的白点不能用灰世界**（T28）：舱内平均色含饰面本身的暖白，直接当白点会把暖白抵消成冷灰；要除以饰面平均反照率得到光源色。测光像素上的串行采样很贵（测光 pass 只有两个像素、无法并行），高光排除用上一帧适应亮度判断、只跑一遍。
- **GPU 耗时看的是 warp 里最慢的那条射线**（PERF-3）：边缘超采样贵在求交步数的长尾，不在着色（把子射线着色换成常数只省 0.01–0.02 ms）；要压步数上限而不是平均值。`shadowSteps=0` 曾经并不跳过阴影段，只是少算了循环总数。
- **Web Audio 的 DynamicsCompressorNode 自带补偿增益**（T11）：规范里压缩器按阈值 / 比率自动抬高输出（阈值 −6、比率 12 约 +3 dB），拿它当兜底限幅器时，所有安静的声音也被抬了。噪声床的高斯峰值因数 4–5 σ，床本身若放在 −17 dBFS 就会一直碰阈值。
  修法：噪声床放到 −26 dBFS（音量 100%），压缩器改阈值 −3 / 比率 20（补偿约 +1.7 dB），只有近雷碰得到。识别：`scripts/audio-check.mjs` 的峰值列应比阈值低 4 dB 以上。
- **OfflineAudioContext 一次性预排所有事件会把 CPU 量大**（T11）：离线渲染前就把 60 秒的几十个闷响全建好，它们的滤波 / 增益节点从 0 秒起就在图里，量出 4.6% 核；实时只预排 0.3 秒，真实开销约 2%。
  修法：量 CPU 时用 `ctx.suspend(t)` 每 0.25 s 停一下再 `update`，和实时一样滚动排程（`scripts/audio-check.mjs` 的 `cpu()`）。
- **面板雷暴摆在 55–75 km 外**（T11）：雷声按 340 m/s 延迟近三分钟，隔着机舱本来也听不见。声音把打雷的距离上限放到 90 km，远雷只剩 90 Hz 以下、低于底噪约 11 dB 的闷响（一片断续的低沉滚动）；想听清楚的雷要导演把雷暴摆近（10 km 内雷声在 150 Hz 以下与底噪相当或更响）。
- **窗板高度只看得到仰角约 20° 以下的天**（T09）：默认头位下窗上沿约 +20°，银河要低低地在窗里才看得见；判断「银河出没出来」先算它的高度角和方位，别先怀疑着色器。
- **星点不能画进等距柱状贴图再放大**（T41）：5.3′ 一格的星图在 1600×1200 下一格约 2 个像素，双线性放大后星是方块 / 菱形，高赤纬处格子在赤经方向变窄，读成短划线。现在星表存进「每行格数随赤纬减少」的格子（sky-assets.ts），按屏幕像素做高斯方格积分（σ = 0.6 像素）。窗外 alpha 现在是 1 + 能看到多少点星（水珠折射仍按 > 0.99 判断），改窗外输出时别把它写回 1。
- **全关档窗中央的「双亮星」是阅读灯倒影**（T41）：T34 的阅读灯光点 + 双层窗板重影在全关档还留着两三盏，所有夜景同一屏幕位置都有。识别：`uDebug = 32`（关倒影）后消失。现在全关档不画光点，睡眠档按面状倒影的同一上限软限幅。
- **按编号取哈希的程序化内容，东西碰到格子边就会切出竖直硬边**（T42）：倒影座椅区按「排」分格、每格用哈希决定椅背高低 / 有没有人 / 娱乐屏，第一版椅背占格子的 0–0.42、娱乐屏的光晕中心贴着格子边，格子边上哈希一跳，座椅区出现一排刀切的竖直矩形（比原来的「垛口」还假）。修法：格子内的东西都放在中段，离格子边留出大于虚化宽度的余量（虚化宽度再截到 0.07 m），格子之间的「底」（坐垫高度）用不随格变的常数。识别：随机化以后画面里冒出笔直的竖线 / 横线，且位置对得上 `floor(x / 格距)`。
- **倒影里的随机开合要保证相邻不同，纯随机会连成一串**（T42）：对面舷窗遮光板第一版按窗号纯随机取 4 档，黄昏截图里正好连着五扇全开，又读成一排垛口。现在偶数号窗随机取，奇数号窗在「和两边都不同」的状态里挑。离线 FXC（`shader-budget --only scene-default`）单次噪声可到 ±30%，与主分支交替测 3 轮以上再比；新加的常量上限循环用 `N + uLoopGuard` 防展开。
- **掠射的侧壁不能用一个各向同性的像素足迹淡出纹理**（T35）：「看前方 / 看后方」时视线贴着侧壁，像素只在「视线在墙面上的投影方向」被拉长 1/cos，垂直方向不拉长。原来的 `t·pixAng / max(cos, 0.2)` 让所有细纹一起被抹平（画面上是一整片平灰墙），而在 cos < 0.2 的地方又欠估足迹、会闪。修法：`shadeWall` 算出 `pixX` / `pixY` 两个方向的足迹，沿 x、沿 y 变化的纹理和缝各按自己的淡出。识别：斜看的墙面上横纹、竖纹同时消失，或者只在极掠射处出现摩尔纹。
- **座椅几何往正面长，就会挤进默认坐姿的画面**（T35）：本排头枕的正面离眼睛的横向视角只比视场边缘多 2°，商务舱头枕往前加厚 1 cm、护翼再鼓 2.8 cm，画面右下角就多出一大块模糊的浅色皮。修法：加厚改成往背后，护翼只往前 2 cm。识别：改了 `seatSection` / `sdSeatBack` 以后，默认坐姿（head = [0, 0.02, −0.42]）拍一张，和 master 对照（`handoff/T35-shots.mjs --only biz-seated,econ-seated`）。
- **窗外 / 舱内交界的像素在曝光后会过冲成一圈 1 px 白线**（T47）：场景 HDR 在交界处 = m·窗外 + (1 − m)·舱内，曝光 pass 原来按遮罩在 log 域混合两边的曝光（几何平均），窗外绝对亮度高、曝光低，那一份被多乘了 √(E舱内/E窗外)，显示值比窗外本身还亮：头枕 / 座椅压在窗前的轮廓外一圈逐像素跳的白色虚线，夜里开灯时窗板边一圈白线（把座椅置黑、只留背景，白线仍在，就是这个）。修法两步：`exposure.ts` 改成按曝光的**倒数**混合（显示值变成两边显示值的凸组合，不会过冲）；`scene.ts` 末尾把交界像素按 a' = m·E窗外 / (m·E窗外 + (1 − m)·E舱内) 重新混合窗外 / 舱内两份并写进遮罩，曝光后两边正好按几何覆盖率 m 混合（能拆开是因为窗外画面在 col 里的系数恰好是 outsideMask）。以后在窗内加新的合成层，要保证窗外画面的系数仍等于 outsideMask。识别：交界像素比两侧都亮。
- **窗板开口边抗锯齿的那一圈不能退回侧壁色**（T47）：`inPane` 在 0..1 之间的像素，视线其实穿进了开口、`marchFunnel` 没打到内衬，`reveal` 的默认值是侧壁色；夜里开灯时侧壁亮、窗外黑，窗板边一圈带台阶的白线（和上一条叠在一起）。现在这一圈取开口边上的密封条（仍只调用一次 `shadeReveal`）。识别：白线贴着窗板开口内侧，开灯的夜景最明显。
- **直射光穿过窗板要按入射角打折**（T47）：原来 `eSunNormal` 只乘常数 0.85，太阳高、几乎贴着窗面照进来（入射角 80° 以上）时，窗洞下缘的内衬被照成死白（看后方约 30% 的像素到 255）。三层亚克力 6 个界面的菲涅尔透射在 83° 只剩正射的约 4%。现在乘 `paneSunT(sunC.z)`（cabin.glsl.ts）。
- **shadeWall 的细颗粒曾把亚麻压纹的斜率整个覆盖**（T47）：`slope = …` 写在 `slope += 亚麻` 之后，fA > 0（几乎总是）时压纹的法线扰动一点不剩，默认坐姿正对侧壁读成光面白板。累加量一律用 `+=`；加新的一层扰动时 grep 一下同一变量有没有别处用 `=` 赋值。
- **舱内合成的 GPU 大头是「算完再乘 0」**（PERF-12）：窗板开口里的像素约占画面三分之一，原来侧壁（`shadeWall`）、内衬
  （`marchFunnel` 穿过开口时一路走满 24 步）、遮光板（`shadeShade`）都照算一遍再按 0 权重混掉；座椅完全挡住的像素也照算窗板效果。
  现在 `scene.ts` 先算合成权重（inBezel / inPane / shaded / seat.cov），权重为 0 的层不着色，调试 1–4 仍全算。GPU 消融里「去掉某一层省 0.03–0.05 ms」
  其实大半是这种白算。以后往舱内加层：**先想清楚它的权重什么时候为 0，在分支里跳过**；新加的判断要保证跳过时结果逐像素不变
  （`node handoff/PERF-12-ab.mjs --base <对照端口>` 同页冻结换着色器，`handoff/PERF-12-abdiff.sh` 求差，噪声底应为 0）。
- **倒影白天也在付钱**（PERF-12）：倒影的跳过条件「上界 < 窗外 0.3%」里含对面舷窗的亮度（≈ 本窗窗外的一半），白天永远不成立，
  正午也要算完整个倒影（约 0.11 ms）。实测正午关掉倒影，差异是对面舷窗的两团淡影（≤ 2–4/255），看得出一点「玻璃感」，所以没改跳过条件，
  改成倒影内部省：座位列由近到远做前后合成（被近列挡满就不算远列和整个背景），视线高过这一列能画的最高处就跳过，光点只在朝上的射线上算。
- **点星在白天也会查 3×3 星表格**（PERF-12）：窗外 pass 只要是天空就在 alpha 里标「看得见星」，正午整扇窗每个像素都在算 `starPoints`。
  现在舱内按「窗外亮度 × 像素张角² < 6e-7」门限（天狼星峰值的 200 倍）才算，白天和黄昏亮的那半边跳过，夜景逐像素不变。

<a id="pit-wonder"></a>
### 奇观

- **远处的暗色细线白天物理上就看不见，要靠「比天空亮」的东西被注意到**（W01b）：几百 km 外的天梯 / 建木，视线上的天空亮度几乎全来自它前面的空气（高处那段身后是太空），反照率 3.5% 的线挡掉的那一点背景光在 8 位里被舍掉（W00 实测对比 < 1/255）；正午太阳在头顶，竖直的柱面侧面也几乎不受光。提高线的反照率会让黄昏晕成光柱（W01 的取舍）。
  修法：白天的可见性交给反照率高、朝向好的东西——扁平台（中继站，反照率 0.3，底面被下方地球的反光照亮、边缘被阳光照亮）、舱体、云气（反照率 0.8），以及真实存在的「白天可见」机制：金属面板的镜面闪光（像铱星闪光，半角向量对上某块面板的方位与倾角才亮）、高强度白色频闪（真实的高塔白天白闪、夜里红闪）。识别：白天看不见时先算「它比天空亮还是暗」，暗的东西别指望调亮线本身。
- **暮色里被照亮的远处细线按物理算会截成激光 / 霓虹**（W01b 返工）：暮色天空比阳光暗 4–5 个数量级，被照到的缆 / 枝亮上千倍、截白，又没有被空气冲淡的感觉；同时「背景 × 线前面空气比例」这个月光近似在黄昏也生效，地影里那段和天空一样亮，上段像悬在半空。修法：太阳落下后按同方向天空亮度封顶（1.3–2 倍，`wonderCap`，保留色相），月光近似只在太阳 < −12° 用，地影里的一段画成挡掉约 22% 天光的淡剪影一路接到地平线。识别：黄昏截图里奇观是一根纯白、边缘锐利的线，或者被照亮的一段下面什么都没有。
- **像面上解「撑杆」的高度时，别用 u^p（p < 1）做弯曲**（W01b）：根部导数无穷，牛顿法 + clamp 之后枝根离开树干几 km，出现一截台阶或小钩。修法：`g(u) = u + bend·u·(1 − u)`（bend = 1 时根部斜出、梢部竖直，导数处处有限）。识别：黄昏的亮枝在分叉处有小横钩。
- **早退半径（reach）必须盖住最宽的部件，而且部件要在半径以内先渐隐到 0**（W01b）：建木云气的高斯尾巴伸到 reach（原 22 km）以外，被截成一道竖直的硬边。修法：reach 放宽到 40 km，云气在离轴线 28–38 km 渐隐。识别：云絮 / 光晕的一侧是竖直的直边。
- **夜里大面积的自发光，绝对亮度决定的是「颜色」而不是「多亮」**（W02）：窗外曝光按窗内对数平均测光，灯城的雾占窗的约两成，雾的亮度 ×k 屏幕上只变约 k^0.8（实测 ×2.7 → 屏幕 122 → 147/255）。但浦肯野效应按**像素的绝对亮度**混灰蓝（< 0.1 cd/m² 约四成，≥ 1 cd/m² 不混）：雾太暗（0.02 cd/m²）读成灰米色，太亮又被 AgX 收成奶白 / 截白。修法：灯海基准 `FC_LG` 取 2.5e-3 kcd/m²（雾约 0.2 cd/m²），雾内亮度起伏收窄到约 2 倍，源色比想要的更纯（钠灯 (1, 0.4, 0.08)）。识别：夜景发光体发灰 → 先算像素绝对亮度，别先调颜色；发白 → 看起伏范围。黄昏曝光低，同一套参数就是橙的。
- **`fract(sin(dot(p, …)) · 43758)` 这类 hash 在较大参数上会整行相关**（W02）：金字塔灯带按（层号, 格号）取 hash 决定亮不亮，结果整层一起亮，成了横贯塔面的亮条。换 Hoskins 的 hash12（`fract(p.xyx · 0.1031)` 那种）后正常。另：水平的平台顶面整面落在同一层灯带里，也会成一条亮线——灯带只放斜面（按法线 y 分量淡出）。识别：该是随机稀疏的格子，却成了连续横线。
- **60–100 km 外斜看的规则街网读成一张发光地图 + 摩尔纹**（W02）：0.45 / 0.6 km 间距的街道在足迹约 0.25–0.5 个间距时一半画线一半平均，和像素网格拍出波纹；1–1.4 km 的棋盘格在透视下是放射状网格。修法：只画几族稀疏、缓弯、分段断续的干道，街区纹理用一次纹理按足迹选 mip；线族向均值的过渡提前到 0.12–0.35 个间距。识别：雾下地面出现平行波纹，或一眼看出规则网格。
- **云间层奇观里插在视线前部的解析霾会把后面的实体蒙白**（W02）：光穹（城市上空被灯海照亮的霾）消光取 0.03 /km 时金字塔被蒙成和雾一样的浅色、剪影没了，0.008 /km 才是「朦胧但仍比雾暗」。排查：关介质（调试时 `v.wonders.active.def.volume.medium = false`，会改到 catalog 对象，只在临时页面里用）只看表面，塔仍发浅 → 查事件。
- **SDF 分区求值时，区域外的「下界」要给到部件内容的真实范围，不能给到区域边界**（W03）：浮空古城按高度分段求值（`if (c.y < 0.3) 算底座 else d = c.y − 0.3`），区域外的值在边界上趋于 0，球面追踪在那里「命中」（`dist < 0.2·足迹`），画出一道左右贯穿奇观包围盒的细水平线（掠射看水平面就是一条线）。修法：区域外给到部件内容最高 / 最低处的距离（如底座内容在 y < 0.08，就给 `c.y − 0.09`），区域边界和内容之间留出余量。识别：奇观上出现一条横贯、比奇观还宽、和某个高度常数对齐的细线。
- **按方位分段的随机（`floor(atan(...)·N)`）只认 (−π, π]**（W03）：瀑布的方位 `a = 2π·hash` 超过 π 时，拿它去查「岩石上沿按方位分段的半径」查到的是另一段，瀑布出水口落在岩石里面，整道瀑布被表面挡住、看不见。修法：先 `a = atan(sin a, cos a)` 折回同一个区间。识别：随机放的部件有的种子看得见、有的看不见。
- **云间层奇观外面罩一个均匀的薄雾椭球，远看是一圈圆盘光晕**（W03）：逆光时前向散射把整个椭球照亮，椭球边缘就是一个清楚的圆。修法：薄雾按 `pr²`（从中心到边缘平滑到 0）并乘噪声；浓雾只放在有理由的地方（底座下挂着的一团云、瀑布化的雾），做成团而不是竖直的雾墙。识别：奇观周围有一个比它大、边缘清楚的圆 / 椭圆亮斑。
- **远处物体自己的「光束」（体积阴影）在屏幕上只有十来个像素**（W03）：6 km 大的城在 80 km 外，树冠缝隙切出的光束朝相机方向延伸，投影长度约「光束长 × sin(光束与视线夹角) / 距离」，几 km 的光束只有 10 像素上下；把雾加浓到看得见光束时整座城先被蒙白。逆光的观感主要靠剪影 + 树冠透光的亮边 + 底座下被照亮的云团；画面级的「云隙光」要由云系统在相机与奇观之间的云里做（归属 clouds/*）。识别：调浓雾找光束之前，先看城是不是已经发白。
- **「深色、圆整、对称的球 + 盘 + 下面一团云和几根细柱」远看就是核爆蘑菇云**（W03 返工，协调者发现）：浮空古城第一版树冠是居中的对称大圆球，压在盘状底座上，正下方托着一团云、垂着根须——80 km 外、白天逆光的深色剪影正好是蘑菇云的语汇。修法：冠层偏向一侧、横向宽扁、顶面起伏，另一侧留低矮次冠，残塔 / 台地从冠层旁边露出来；底座下的云偏一侧、变淡；再补空气透视让它远而淡。识别：把截图缩到 64 px 高看剪影（`handoff/W03-compare.py` 的 thumb64）。以后做任何「上面一团、下面一根」的远景奇观都先做这个缩略测试。
- **往下看的视线别直接查天空 LUT（`skyRadiance(rd, false)`）当「背景色」**（W03 返工）：地平线以下的 LUT 值是偏橙的错色，拿它给奇观底座做空气透视混色，底座下面整片发橙。修法：把视线抬到地平线（巡航高度约 −3.3°）上方一点再查。
- **奇观介质想自己算受光（例如光束要被树冠缝隙切开），反照率返回 0、散射光写进 emit**（W03）：`wonderLayer` 在反照率全 0 时跳过标准受光 `wonderMediumLight`（W03 加的判断），否则每步白算一次主光源 + 天光 + 4 瓣相函数。标准受光只有一个平滑的投影椭球挡光，切不出光束。

<a id="pit-train"></a>
### 火车

- **火车：OSM 折线直接当相机轨迹，车体「转一下、直一段、再转一下」**（TR02）：烘焙的 `center.x / y` 是 OSM 折线按 2 m 重采样的原样，弯道上节点约 20 m 一个、每个节点折几度（`heading` / `curvature` 是 σ = 15 m 平滑过的，位置没有）。
  车体方向取前后台车（相距 13.8 m）的连线，经过折角时偏航速度跳变。修法：`rail/corridor.ts` 把平面位置也按 σ = 15 m 高斯平滑，`position()` 用 Catmull-Rom 插值（线性插值时每过一个 2 m 采样点转向速度还会跳一下，约 12 Hz 的细小顿挫）。
  以后怎么识别：`node src/rail/rail.test.mjs` 的「偏航角速度连续」一项（每帧偏航变化的二阶差分）；近景 / 中景（TR04 / TR05）要和相机对齐，也必须用 `Corridor.position()`，不要直接读 `center.x / y`。
- **火车：超高（侧倾）一帧一帧地跳、在站场咽喉区一秒翻好几度**（TR02）：①滑动平均曲率按「最近的采样点」取窗口，结果每 2 m 跳一级；②道岔、反向曲线在 OSM 里是一串短促的弯，按公式算出的超高十几米内从一侧翻到另一侧。
  修法：窗口在相邻采样点之间线性插值；超高再限制沿线变化率（≤ 1.67 mm/m，估，模拟逓減），左右两侧分别前后各推一遍，削成梯形、不产生滞后。识别：单测的「滚转每帧变化」「超高沿线变化率」。
- **火车：相机贴地后，着色器里的相机高度只有约 0.5 m 的分辨率**（TR02，推算，没有在画面上验证）：`uCamR = 6360 + 高度(km)` 按 float32 上传，6360 附近的最小间隔是 2⁻¹¹ km ≈ 0.49 m。飞机在几公里高度上看不出来；火车眼高 2.5 m 时，坡道上相机会以约 0.5 m 的台阶上下跳。
  TR03 做远景的 RAIL 变体时要处理（例如把相机高度拆成 uniform 里的「大数 + 小数」，或者近地部分改用相对高度）。
- **火车：voyage 本地坐标与真实距离南北方向差约 0.35%**（TR02）：`ground/geo.ts` 的 LocalFrame 纬度方向固定 110.574 km/度（赤道附近的值），北纬 36° 真实是约 110.96 km/度。影像、地形都按它摆，所以相机必须走「线路 ENU → 真实经纬度（`rail/geodesy.ts`）→ LocalFrame」，不能把 ENU 米直接除以 1000 当本地公里（35 km 外会错开约 100 m）。
  近景 / 中景（米级、线路坐标）与远景（LocalFrame）拼接时，500 m 处的比例差约 1.7 m，TR03 / TR04 要知道。
- **火车：停站中切回飞机再切回火车，列车冲出终点、永远卡在线路末端**（TR02 审查 B1）：终点停车位之外没有「下一个停车点」，目标速度一直是 0；旧版 `teleport` 给巡航初速、`enter()` 每次都 teleport 且把方向重置成 +1。
  修法：位置夹在两个终点停车位之间，初速不超过到下一停车点的制动曲线，停在终点上直接进入停站；`enter()` 不给参数时列车原样继续。识别：单测第 7、8 节（终点跳转、停站中切换）。
- **回归场景切火车要注意面板控件的应用顺序**（TR02）：`applyScene` 先按 DEFAULTS 设 `preset`、`seat`……，再设场景自己的键。火车模式下改 `preset` 会先退出火车（`setPreset` 里 `rail.exit()`），所以火车场景要写 `"vehicle": "train"`（排在 DEFAULTS 之后生效），想要右座的话在 `js` 里再设；进入火车时座位默认换到北阿尔卑斯一侧（往信濃大町是左座）。飞机场景跟在火车场景后面时，要写 `"vehicle": "plane"`（DEFAULTS 里还没有这个键，TR08 可以加上）。

- **火车声音：跳位置被当成加速播放，把广播吞掉**（TR07）：`rail/audio-rail.ts` 按「音频时钟里走了多远 / 车速」估模拟流速，加速播放（导演流速）时静掉接缝、道口、广播这类节奏事件。`rail.teleport` 一下跳 30 km，被估成约 40 倍速，fastForward 持续约 0.7 s，正好把刚触发的「まもなく」吞掉。
  修法：位移超过「100 倍速一个更新周期能走的距离」就当跳位置，重新排程、不参与估计；字幕无论如何都显示，只是加速时不放喃喃声。识别：teleport 之后 `__voyage.audio.debug().rail.rateEst` 应仍约 1。
- **火车声音：警报声第一版低了 25 dB，完全听不见**（TR07）：车体隔声（−27 dB）之后又乘了一遍噪声床的 RMS 参考，经过道口时警报 −65 dBFS。识别：`node scripts/audio-check.mjs --rail` 的「道口通过」行，±1 s 的总声级应与底噪相当（现在 −41.7，峰 −24）。
- **火车声音：广播喃喃声现算是一次 63 ms 的主线程长任务**（TR07）：共振峰合成在 JS 里逐样本算，5 s 的一段约 60–90 ms。修法：建图时预合成 3 段 7 s（逐段让出主线程），广播时截取需要的长度、末尾淡出。识别：`handoff/TR07-prof.mjs` 的 `maxMs`（现在约 0.6 ms）。
- **离线节奏检查：包络自相关会报成两倍周期**（TR07）：接缝节奏的包络在 T、2T 处的自相关几乎一样高，随机数流一变（加了一段预合成就变了），最大值就从 1 s 跳到 2 s。修法：取「≥ 最大值 90%」的局部峰里最短的滞后。以后写周期检测都要加这个防倍周期。
- **火车声音的数值多是估值 / 示例**（TR07，详见 `handoff/TR07.md`）：本线是否已长轨化、接缝是相对式还是相互式、警报两音交替还是同时，都**未核实**；面板接缝下拉默认「定尺 25 m（示例）」。道口多普勒用**运动听者**公式 (c + v·cosθ)/c（实现为 1 − ṙ/c），`research/TRAIN.md` §6.2 写的 c/(c ∓ v) 是声源运动的公式，90 km/h 时差 0.6%。
- **火车：贴地相机下飞机的窗外程序把近处画成海、山脚一条白带**（TR03）：三个根因叠在一起。①眼高 2.5 m 时地平线附近的视线在平原上方几米处走十几公里，飞机版「按离地高度缩步」在 96 步内用完，`terrainHit` 退回海平面球（`tSea`），画成海；②AWS 地形在近处比国土地理院轨面高（弯道处 7–30 m），视线从地形里面出发，第一步就「打中」t = 0，`groundHit` 返回 false，也退回海；③地面瓦片的河道折线按类别估宽（river 60 m），十几米的小河在铁路边画成 70 m 宽的「湖」（12.65 km 处实测，线路烘焙的 OSM 里那里根本没有水面多边形）。
  修法：窗外程序的 `#define RAIL` 变体（`rail/far-view.glsl.ts`，只拼进火车变体，共用模块里只有 `#ifdef RAIL` 钩子）：近处 250 m 内是国土地理院标高的解析平面、600 m 渐变到 clipmap 地形（近处按基准差平移到国土地理院）；步长下限按距离放大（4–10%），地形逼近时按逼近速度预估；没打到地形的视线是天空、不退回海平面球；火车模式下河道折线限宽 12 m（`GroundClipmap.waterwayMaxM`）。眼睛不再按 clipmap 抬高。
  识别：火车模式窗外出现大片反射天空的水面 → `uDebug = 23` 看水体遮罩（红 = 水）；是遮罩里真的有水就去查瓦片的 waterway 宽度，遮罩没水却是水面就是退回了海平面球。
- **火车：着色器里相机高度的 float32 精度**（TR03 已处理）：`uCamR = 6360 + 海拔` 在 6360 附近只有约 0.49 m 一级。火车变体的求交、阴影全部用相对量：`uRailCamAltKm`（海拔本身，亚毫米精度）+ 沿视线的增量 `t(2·rc·μ + t) / (√(rc² + q) + rc)`（`railAltAlong`，不在 6360 附近相减）。以后往火车变体加任何「比高度」的代码都走 `railAltAlong` / `gh.alt`，不要写 `length(P) − BOTTOM`。
- **火车：高度 clipmap 半精度把平原量化成台地**（TR03）：半精度在 0.5–1 km 海拔只有约 0.5 m 一级，飞机上看不出；贴地掠射时远处地平线是一级级台阶。高度纹理改成 R32F（`clipmap.ts`，线性过滤要 `OES_texture_float_linear`，three 已启用）。飞机模式的地形高度因此变准了一点（fuji-day 与 master 平均差 0.23/255，属噪声）。
- **火车：斜看的影像要沿足迹长轴取样**（TR03）：1 km 外像素在地面上沿视线方向的足迹是横向的几百倍，取一个点就是严重欠采样，列车一动整片平原闪。火车变体沿长轴取最多 4 点（`railGroundSample`），级别选到每点约一个纹素；地形法线在求交时就算好（`gh.nT`），掠射角按法线算（按天顶算会把正对我们的山坡也模糊掉）。
- **火车：远处山脊几乎和地平线平行，轮廓是 1 像素的水平台阶，列车一动就沿轮廓爬**（TR03）：两类边都要抗锯齿。①地形对天空（没打到）：步进途中记下离地形最近处（以像素竖直足迹计），在它附近两轮细找，覆盖率 = 1 − 距离，和天空按覆盖率混；②近处山脊挡远处山脊（都打到）：只记「局部最近、之后又离远」的一处，把远山的颜色按那道山脊的距离重新加一遍空气透视当作它的颜色混进来。**云的切割（`cloudBeforeGround`）也要按同一覆盖率混**，不然山脊边的云还是一刀切（第一版只改地面颜色，截图看不出变化，查了半天才发现台阶是云被切出来的）。识别：`uDebug = 26`（火车变体专用：红 = 覆盖率，绿 = 距离 / 50 km，蓝 = 近处山脊覆盖率）。仍未解决：平原上相隔几公里的低矮起伏之间的遮挡边（对比很低，放大 5 倍才看得出）。
- **火车远景变体第一次进入火车模式时后台编译约 18–19 s（d3d11 真冷），期间沿用飞机的窗外程序，窗外会先画成海**（TR03，已知）：飞机模式不受影响（变体只在火车模式下编译）。以后若要消掉，可在面板选「火车」的同时开始编译、编好之前在状态文字里提示。

<a id="pit-tools"></a>
### 工具与环境

- **node 直接跑 .ts（类型剥离）不支持参数属性、也不补 `.ts` 扩展名**（TR02）：`ground/geo.ts` 这类用了 `constructor(readonly x…)` 的模块会报 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`；项目里 import 不写扩展名，node 找不到。
  `src/rail/rail.test.mjs` 用 `module.registerHooks` 补扩展名；想被 node 单测直接加载的模块（`src/rail/` 下除 mode.ts 以外）不要用参数属性、enum 这类非「可擦除」语法。
- 调试模式 3、4 的覆盖条件曾经写成 `uDebug >= 3`，把后来加的 5–10 全盖住了，窗口一片黑。加新的调试模式时，要检查已有的判断条件。
- 用 Python 做「删除第一处匹配」时要小心：新插入的代码可能就是第一处匹配，结果删掉的是新代码，旧的反而留下了（报 `undeclared identifier`）。
- **测帧率前先把浏览器窗口切到前台**：Playwright 的窗口被别的窗口挡住时，Chrome 会把 `requestAnimationFrame` 节流到每秒 1 次，
  而页面仍报告 `visible`、有焦点。现象：每帧正好 1000 ms，关掉什么都一样慢。用 `page.bringToFront()` 后恢复正常（约 6 ms/帧）。
- 样式表要在 `index.html` 里用 `<link>` 引用，不要在 main.ts 里 `import`：经由 JS 注入的话，脚本执行完之前页面是一片没有样式的控件。
- **Windows 上用 `sed -i` 改文件，Vite 可能收不到变更**：`sed -i` 是先删再建，文件监听有时会漏掉。浏览器会一直加载带旧 `?t=` 时间戳的模块，报「XX is not defined」，但文件里明明已经改好了。
  修法：`touch` 一下被改的文件。以后识别：报错栈里模块 URL 的 `?t=` 时间戳比最近一次修改早。
- 回归脚本在 Playwright MCP 的 `browser_run_code_unsafe` 里运行时**没有全局 `URL`**（`ReferenceError: URL is not defined`）。只在 Node 侧可用的全局不要假设存在；取 origin 用正则。以后识别：脚本一开始就抛 ReferenceError。
- **测帧时间**：本机 GPU 远快于刷新率，rAF 间隔被锁在约 6.2 ms，看不出着色器代价；`gl.finish()` 在 Chrome 里也不等 GPU。用 `EXT_disjoint_timer_query_webgl2`，或「一个 rAF 里连渲染 N 帧后 readPixels 1 像素」。多个代理同时占 GPU 时任何计时都不可信。
- **真冷启动**：同一端口的着色器缓存会让「冷启动」其实是热的；测编译时间要用 addInitScript 往着色器注入随机数强制缓存不命中（审查脚本 `tmp/review-t02/cold.js`）。
- **`dev-browser.mjs flicker` 帧数太多会把整个页面炸掉**（DX-22 交付前实测发现，与 `--cloud-live` 无关——不带这个开关的原版 `flicker` 一样会炸）：`analyzeFlicker` 是把整批截图连同 base64 `dataUrl` 一次性塞进同一次 `page.evaluate` 解码，不是逐帧读 GPU 缓冲。本机（1600×1200）实测 40 帧过、48 帧稳定复现 `page.evaluate: Target page, context or browser has been closed`（渲染进程被这一大坨 base64 数据 + 同时存在的 N 份 `Float64Array(w*h)` 亮度缓冲拖崩）。`--cloud-live` 的默认帧数因此定得比较保守（32，见上），确实需要更细的时间分辨率时用 `--frames` 显式调大、一次不要涨太多，机器空闲时测。根治要把 `analyzeFlicker` 改成分批读回（例如学 `handoff/C03-rt.mjs` 的 `realtime()` 直接 `readRenderTargetPixels` 读云缓冲，不经过截图 + PNG 解码），没有列进 DX-22 范围，建议排一个 DX 任务。
- **调试模式编号**：`uDebug` 1–10 原有；11 / 12 海浪（T14：白浪覆盖率、可分辨斜率）；21 地表分类、22 像素足迹、23 水体遮罩（T02）；24 只画道路灯带（T08，地面处辐亮度，不含空气透视）；25 去掉道路灯带（T43）；26 火车远景的轮廓覆盖率 / 距离 / 近处山脊覆盖率（TR03，只在火车变体里）。新增前先查占用。
- **glslang-validator-prebuilt-predownloaded 没有 `bin` 字段**：不能 `npx` 直接跑，要 `require("glslang-validator-prebuilt-predownloaded").getPath()` 拿到可执行文件路径自己 `spawn`（`apps/voyage/scripts/lint-shaders.mjs` 已经封装好）。
- **离线校验 THREE 的 `#include <chunk>`**：不能直接展开 `THREE.ShaderChunk` 的原文喂给 `glslangValidator`——它的 `common` chunk 里的 `average()` 函数会被 glslangValidator 误报「redeclaration of existing name」（ANGLE / 真实浏览器编译完全正常，是 glslangValidator 自己符号表的问题）。`lint-shaders.mjs` 用手写的桩替换（`INCLUDE_STUBS`）绕开。
- **按文本数 sampler 引用，光展开 `#ifdef` 还不够，要连着做「从 main() 可达性剪枝」**：一个函数即使在源码里正常定义、正常读了某个 sampler，只要这个函数本身从场景程序的 `main()` 顺着调用链走不到（比如只被另一个程序调用），真实驱动的死代码消除会把它和它读的 sampler 一起砍掉——纯文本「这个名字出现过好几次」看不出「是否真的可达」。`lint-shaders.mjs` 的 `reachableFromMain`/`pruneUnreachable` 就是为了修这个坑（撞上的真实案例：`uMultiScatteringLut` 只被 LUT 预计算程序用，场景程序的 `main()` 到不了它）。加新的静态分析工具时留意这一条。
- **验证「静态数的 sampler 数」对不对，起一个真实 WebGL2 上下文比猜靠谱**：挂 `HTMLCanvasElement.prototype.getContext` 和 `gl.linkProgram` 的钩子把 `WebGLProgram` 对象截下来，再读 `gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS)` + 逐个 `gl.getActiveUniform` 数 sampler 类型（手法抄自 `tmp/review-t06/perf.js`），比任何文本分析都准。
- **`chrome-headless-shell.exe` 会静默退化成 SwiftShader**，且没有 `EXT_disjoint_timer_query_webgl2`：私有 headless 一定要用 `ms-playwright` 缓存里 `chromium-<版本>/chrome-win64/chrome.exe` 这个完整版二进制，不能用同一份缓存里的 `chromium_headless_shell-*`。
- **`regression.playwright.js` 的端口正则如果写太窄，会静默退回默认端口、覆盖别人的截图**：曾经只认 `51\d\d`（5100–5199），worktree 常用的 52xx 端口匹配不上时悄悄退回 `5181`，把截图写进主分支目录（本波发生 3 次）。现在认任意 `5\d{3}` 且不在范围内直接报错退出；以后类似的「按端口猜路径/猜配置」的脚本都要照这个模式改：宁可报错，不要猜一个默认值。
- **拆程序、换写法后做逐像素对比，海面闪光和城市夜光会有成片的单像素翻转，这是正常的**：它们按世界坐标取 hash 决定亮不亮，视线方向差 1 ulp（换一种编译顺序就会差这么多）就会让格子边界上的像素换一个 hash。
  SC-5 的校准：master 与「只给 rdW 多做一次 normalize 的 master」对比，night-city 平均相对差 3.95e-4、sunset 单像素最大相对差 0.96，和 master 与 SC-5 的差（3.93e-4、0.92）是同一量级；而天空、云、舱内这些没有 hash 的部分逐位一致或只差 1e-5。
  判断方法：差异是否两个方向都有（A 比 B 亮和 B 比 A 亮的像素都有）、是否集中在闪光 / 夜光这类稀疏亮点上、与「1 ulp 扰动」的校准是否同量级。系统性的错误会是单向的、成片的。
- **对比截图前冻结翼尖姿态**：`uWingFlex` 每帧按时间摆动（turbulence 0 也在动），同一端口前后两张图边缘会错开 1 像素；1:1 对比要把它冻结。同一版本前后两次截图也可能差一两颗云 / 海面高光，看到亮点先同版本再拍一次确认。
- **测「省了多少」要带关掉该功能的对照组**：只看总时间会被别处的开销（例如多开的数组让所有像素都慢 0.02 ms）误导。
- **同页 `material.clone()` 做 A/B 计时，排第一个的场景数字不可信**（能差 2 倍，根因未明）；最终数字用两个端口整轮交替测。
- **headless 里听不见声音，但可以离线分析**（T11）：`node scripts/audio-check.mjs [--port 5211]`（没有开发服务器会自己起 vite）直接打开 `/src/audio.ts` 这个地址（同源、不启动渲染器）再动态 import，用 OfflineAudioContext 渲染各状态并输出倍频程表 / A 计权 / 峰值 / 左右相干度到 `tmp/audio-check/spectra.json`。页面上那条 404 是 favicon，无关。火车（TR07）加 `--rail`（只查火车）或 `--rail --all`，结果写 `tmp/audio-check/rail.json`。
- **同一时刻拍「正常 / 调试」两张图做减法不可靠**（T43）：即使停掉主循环、把 uCloudOffset 拨回原点，头部 / 航向仍会漂几个像素，城市灯点整体错位，相减全是灯点。
  道路的贡献直接拍调试 24（同一冻结曝光），调试 25 = 去掉道路灯带（`handoff/T43-shots.mjs`）。
- **回归场景的日期默认是「今天」，夜景的月相每天不同**（T09）：场景只设 `time` 时日期沿用页面打开那天，月亮在不在天上、多亮随运行日期变，夜间场景的基线不可比。要稳定的夜景写 `date`（`applyScene` 对日期框发 `change`，没写 `date` 的场景恢复成页面打开时的日期）。选银河场景的办法：用 astronomy-engine 扫全年「太阳 < −18°、月亮 < −5°、人马座大星云高 4–16°、方位对着窗」，本仓库的 `night-sea-milkyway` 就是这样挑出来的（南海、左座朝东南、2026-05-15 22:30）。
- **`svs.gsfc.nasa.gov` 的 TLS 握手在本机经常失败**（T09）：Git Bash 的 curl（schannel）直接 `SSL/TLS connection failed`，Python 的 urllib 也会间歇 `UNEXPECTED_EOF_WHILE_READING`；重试几次就好（`build_milkyway.py` 自带重试）。
- **页面内换着色器做 A/B 时，要等后台编译真的完成再计时**（W00）：`compileAsync` 还没好时画的仍是旧程序，量到的是旧程序的数（W00 因此一度以为某段代码「不花钱」）。奇观变体第一次编译 d3d11 约 13–17 s，`--variants` 的 wait 给 25 s，并看 `__voyage.clouds.wonderLayerState === "ready"`。另：typhoon-bands 的云步进在两个端口上都会随页面加载出现约 3.2 / 5.2 ms 两档（与代码无关），对照要在同一页面里交替、或多轮取同一档比较。
- **`scripts/probe.mjs` 的 `--read` 坐标是 GL 左下原点、目标自身分辨率**（T38）：脚本注释写的「左上角原点」不对（直接交给 `readRenderTargetPixels`），屏幕行 y 要换成 `H − 1 − y`；云缓冲在台风等场景会按画质档降到 0.75，坐标还要乘比例，T38 起云缓冲还是两倍宽（右半是深度）。读到一整片 0 或和截图对不上，先查这两点。另：`clouds.raw` 读出来全是 0（原因没查），读云缓冲用 `cloud`（history）。
- **跨端口的 `shots --freeze` 不逐像素可比**（T38）：同一端口连拍两次噪声底很低（noon-cumulus 平均差 0.16），但两个端口（新代码要冷编译、页面加载时长不同）冻结时机不同，机翼颤动 / 头部相位差几个像素，整张图沿边缘全是差异（平均差 1.4–2）。判断零回归要看区域亮度（`compare.mjs --measure`）或页面内对照（`passes.mjs --variants` / `probe.mjs --patch`）。
- **Windows 上 Python 写回源文件会变成 CRLF**（T35）：`open(p, 'w')` 在文本模式下会把 `\n` 写成 `\r\n`，提交时 git 会提示 "CRLF will be replaced"。修法：读写都加 `newline=''`。识别：`grep -c $'\r' 文件` 不是 0。
- **`regression.playwright.js` 的 applyScene 与 `scenarios.mjs` 要逐项同步，check:glsl 只比场景数组**（W01b）：T17 只在 `scenarios.mjs` 里加了 `js` 字段，MCP 版回归脚本的 applyScene 没有，写了 `js` 的场景（召唤奇观、调试开关）在 MCP 回归里静默不生效、截图里什么都没有，同步检查照样通过。W01b 已补上；以后给 applyScene 加字段两边一起改。识别：MCP 回归截图里缺了 `js` 应该打开的东西，而 `dev-browser.mjs shots` 里有。
- **相机微动测闪烁时，飞行本身会让远处物体每帧挪 1–2 像素**（W03）：`W03-flicker.mjs` 每步隔 250 ms，45 km 外的城相对飞机约 0.3°/s，逐帧差分图上所有轮廓都是一排等距的平行条纹（匀速运动，不是闪烁）。判断用裁剪区平均亮度（W03：0.08–0.18 / 255）和逐帧形状，别用逐像素差分的百分比。
- **只把 `dt` 钉成 0，云还是会有测得出的残留噪声**（DX-08）：实现 `__voyage.freeze` 时最初只是把喂给 `renderFrame` 的挂钟时间钉住（`dt` 因此恒为 0），位置 / 头部 / 曝光适应等按 `dt` 累积的状态确实都不再变化，但用 `dev-browser.mjs flicker --step 0` 连拍还是量到块能量 CV 有个小的非零 p90/p98、`compare.mjs --diff` 两帧平均差约 0.1/255、个别像素到 18/255。根因：`clouds.render()` 内部有一个**不受 `dt` 控制、每次调用都会推进**的抖动相位（`this.frame++ % 64`，时间累积重投影用的采样偏移），冻结时这个相位照样在转，云步进用不同的抖动偏移重新采样一次，时间累积的结果就跟着抖一点点——肉眼看不出，但截图能测出来。
  修法：`main.ts` 里冻结时整次跳过 `clouds.render(...)`（以及会推进 `frameCount` 的 `clouds.probe(...)`），直接复用 `clouds.texture` 已经指向的那份缓冲（同一块 GPU 内存，不重新计算），下游的窗外 / 舱内合成 / 曝光都是这份固定输入的纯函数，重新渲染多少次结果都一样。
  识别：以后再给什么东西加「不受 dt 控制、只受调用次数控制」的相位 / 计数器（时间累积、抖动、噪声种子……），先问一句「冻结时这个东西还会不会走」；验证冻结是否真的逐像素一致，用 `flicker --step 0` 连拍再 `compare.mjs --diff` 两帧，数字应该是 0/0/0，不是「看起来差不多」。
- **scratchpad 里的脚本文件名撞上 Python 标准库模块名，会静默换成错的模块**（T02 第 2 波已踩过、第 6 波 09-27 12:17 又撞一次，DX-09 补进 README）：
  scratchpad 是所有代理共用的临时目录，写一个 `bisect.py`（或 `random.py`、`copy.py`、`types.py` 这类和标准库同名的文件）时，
  Python 的 `import bisect` 会优先在当前工作目录 / `sys.path` 里找到这个同名文件，而不是标准库的 `bisect` 模块，出错时往往没有清楚的异常信息，只是行为悄悄不对。
  这条坑此前只记在 `handoff/T02.md` 里，README 查不到，所以第 6 波又被撞了一次（见 `research/DX_REPORT_wave6.md` 第 1 节表格第 7 行）。
  修法：scratchpad 脚本文件名一律带任务前缀（如 `T49-bisect-helper.py`），不要用和 Python 标准库同名的名字。识别：`import` 之后行为不对、但没有 ModuleNotFoundError 之类的明确报错时，先检查 scratchpad 里是否有同名 `.py` 文件。
- **对照基线放进 scratchpad，会让 `check:glsl` 静默全 FAIL**（T38 审查踩过）：scratchpad 目录本身路径约 250 字符，
  再拼上仓库相对路径后容易顶到 Windows 路径长度上限，`lint-shaders.mjs` 内部 `spawnSync` 调 `glslangValidator` 时因为
  找不到临时文件而 ENOENT，但没有把这类底层异常单独识别出来，表现就是所有程序一起 `[FAIL]` 且日志里没有具体的语法错误内容，
  很容易被误判成「这一批改动全炸了」。
  修法：对照 / 临时工作区一律建在仓库的 `tmp/` 下（例如 `tmp/<任务>-rev-merge`），不要放 scratchpad。
  识别：`check:glsl` 里全部程序一起失败、且看不到具体的语法错误内容时，先怀疑路径长度，不要先怀疑代码本身。
- **测量锁按「脚本所在 worktree 的根」取路径，跨 worktree 不互斥**（PERF-12，**DX-11/12 已根治**）：`scripts/lib/measure-lock.mjs` 的锁目录原来是
  `path.join(脚本所在仓库根, "tmp/measure.lock")`，在 worktree 里跑就落在该 worktree 自己的 `tmp/` 下，别的代理（另一个 worktree 或主仓库）看不到，
  等于没锁。识别：`ls D:/Code/opus-test/.claude/worktrees/*/tmp/measure.lock` 能看到好几把（老版本才会这样，现在只会有一把）。
  修法：`mainRepoRoot()` 用 `git rev-parse --path-format=absolute --git-common-dir` 找主仓库的 `.git`（worktree 与主仓库共享同一个 `.git`），
  取上一级就是主仓库根，锁统一落在那里，所有 worktree 共用同一把；找不到（不是 git 仓库 / 没装 git）时退回原来的行为，不阻塞脚本。
- **GPU 计时也会被别的代理污染**（PERF-12）：`passes.mjs` 同一份代码两次测舱内合成 0.317 / 0.350 ms（`nvidia-smi` 显示别的进程占 GPU 75%）。
  判 0.01–0.03 ms 量级的差异要 `--frames 60 --rounds 4` 以上、变体表首尾各放一次 base 看漂移，或 `--baseline` 同场景交替。
- **`applyScene` 的 `--settle` 返回后、`pinGeometry` + 冻结之后，地面瓦片仍可能在加载**（T48b）：同页多变体对照第一轮，8 张图拍摄时 `ground.pending` 从 155 一路降到 12，冻结的画面仍在被新瓦片改写，变体之间不可比。修法：冻结后再 `waitForFunction(ground.pending === 0)` 并多等 2 s（`handoff/T48b-ab.mjs` 的做法），每张图的 JSON 里记截图那一刻的 pending 与 CORS 错误数。识别：同一变体拍两次（噪声底）不为 0。
- **`shots --pair` / `--base-shader` 的噪声底不是 0：每拍一张后 `shootOne` 都跑一次 `benchFrame(30)`，而 benchFrame 不经过冻结**（PERF-14 发现，工具未改）：
  它按 16 ms 一帧推进 30 帧的模拟时间与曝光适应，a、b、a2 三张其实是三个不同时刻——自己换自己（master 着色器换 master 着色器）也有 5–48% 的像素差 > 8，夕阳场景连太阳眩光都不一样。
  绕法：`--pair` 的预设置 js 里写 `v.benchFrame = () => 0;`（截图 JSON 里的 frameMs 变成 0），噪声底立刻变成逐像素 0。另一个坑：`--base-shader` 不带 `--pair` 时整段被静默忽略，只拍普通截图。
  识别：a−a2 不是 0 就先别看 a−b。
