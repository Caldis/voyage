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
| 窗外程序的变体 | 罕见光学（宝光 / 本机影子 / 幻日 / 晕）只在 `#ifdef OUTSIDE_OPTICS`、天幕层奇观只在 `#ifdef OUTSIDE_WONDER` 里，窗外默认程序（冷启动关键路径）预处理后不含它们（PERF-13，`check:glsl` 断言）；只有 `""` / `OW` / `DOW` / `DROW` / `OWP`（巨柱群，WS07）五个组合，选哪个只由 `outside-pass.ts` 的 `wantedOutsideKey` 决定；新的「平时不出现」的窗外效果照样写进宏，并让 `opticsWanted` / `wantedOutsideKey` 认得它 | [着色器编译](#pit-shader) |
| 窗外输出 alpha 语义 | 窗外 pass 输出的 alpha 不是占位不透明度，是 `1 + 能看到多少点星`（T41）；改窗外输出时**别把它写回 1** | [舱内与倒影](#pit-cabin) |
| 影像 A 通道语义 | 影像纹理的 A 通道**兼存道路照亮宽度**（T08）：< 0.5 表示「缺影像比例 / 2」，≥ 0.5 表示有影像、其余 7 位是宽度；判断缺瓦片一律用 `min(A·2, 1)`（`sampleGroundAlbedo`），不能直接读 A。G06 起影像 / 水体纹理带 mipmap，读 A 的编码值（道路宽度 / 有向距离）必须 `textureLod(…, 0.0)` 读第 0 级。G07 起 mip 由 Worker 生成（`mips.ts`，在 `packRoads` 之后）：影像 mip 的 A 是「有影像比例」的合法编码（比例 1 写 128 = 有影像、宽度 0，否则 `比例 × 127.5`），`min(A·2, 1)` 在 mip 上恰好是覆盖比例；水体 mip 的 A 一律 255。G03 的高清细节合成只改 RGB、且必须在 `packRoads` 之前做 | [地面与数据](#pit-ground) |
| 影像源与请求 | 影像源都走 `tiles.ts` 的 `ImagerySource` + `loadImageryBlob`（G08：主线程只取 JPEG Blob，解码与拼接在拼接 Worker 里；按站点令牌桶 / 并发，`HOST_LIMITS`）；404 / 410 / 占位图负缓存，429 / 5xx / 网络错误**不**缓存；换源或混源不能改变 EOX 的低频色调（`landClasses`、城市灯点、路灯聚落地毯的阈值都按它定）；`__voyage.ground.imageryStats` 看各站点请求 | [地面与数据](#pit-ground) |
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
- **面板分区**（UX-3，`research/PANEL_UX_GUIDE.md` §2）：标题栏 →「此刻」摘要（常驻，航段 / 时刻 / 朝向 / 天气一句）→
  观景 / 航程（默认展开）→ 天气 / 声音 / 画质（默认折叠，标题行右侧一行摘要；声音区标题行本身带开关）→ 开发者区
  （默认隐藏，`?dev` 或 `Shift + D`）→ 页脚（数据来源与许可，折叠为一行）。折叠状态记在 localStorage
  `voyage.pref.panel`（`sections` 字段各区、`dev` 字段开发者区，只记用户亲手点的）。完整信息栏（太阳 / 月亮高度角、
  经纬度小数点后三位）在开发者区的 `<pre id="info">`；控件 id 与规范 §1「控件 id 契约」保持不变，场景表按 id 设值不受分区影响。
- **手机 / 窄屏底部抽屉**（UX-4，`research/PANEL_UX_GUIDE.md` §9，断点宽 ≤ 720px 或高 ≤ 500px）：面板变成底部抽屉，
  默认收起成一条把手（抓手 + 「此刻」一行摘要 + 展开箭头，≤ 屏高 12%，不挡舷窗中心），点击整条把手或上下拖动
  （触屏 pointer events）展开到 ≤ 40% 屏高、内部滚动；展开状态记在 `voyage.pref.panel`（`drawer` 字段，只记
  `isTrusted` 操作）。桌面宽屏（断点之外）完全不受影响，`#panel` 逐位不变。
- 在画面上按住拖动 = 转头（窗框视差），滚轮 = 前后挪（靠近 / 远离舷窗），双击复位；`H` 隐藏面板
- 聚焦观察（FOCUS-ZOOM）：在画面上**按住不动**约 0.2 秒（位移不超过 5 px），视场平滑收窄到「默认 / 倍率」（默认 2.5×，缓入缓出约 0.2 秒），松开平滑还原；按下就拖走的仍是转头。聚焦中照样可以拖动转头，灵敏度按倍率降低。触屏长按同理；键盘按住 `Z` 等价（焦点在输入框 / 下拉里时不触发）。聚焦时四角轻微压暗（CSS 叠层，不进渲染管线）
- 头部左右限位（FOCUS-ZOOM 追加）：头往舷窗前伸得越多、视场越宽，左右能挪的就越少——保证视锥永远看不到没建模的前后机舱（纯黑 / 空白侧壁）和本窗很斜时的窗洞黑带；聚焦（视场变窄）时可以转得更偏。拖到限位附近有弹性阻尼，前伸或松开聚焦使限位收紧时头部被平滑拉回。限位表与判据见 `handoff/FOCUS-ZOOM.md`，离线重算 `node --experimental-transform-types --no-warnings apps/voyage/handoff/FOCUS-ZOOM-limits.mts`
- 开发者区（`?dev`、`?dev=1` 或 `Shift + D` 显示，记在 localStorage `voyage.pref.panel`）：聚焦倍率（1.5–8×）、聚焦过渡（0–600 ms）、聚焦暗角（0–100%），双击复位。URL `?zoom=4` / `?zoomms=300` 本次优先（`zoom` 允许 1 = 关掉聚焦，对照用）且不写记忆；亲手调过的值记在 `voyage.focus`（`{v:1, mag, ms, vignette}`，只记 `isTrusted` 的操作）
- 快捷键（UX-1a 统一守卫）：`H` / `B` / `M` / `N` 在焦点位于文字输入框、日期框、下拉时不触发（焦点在复选框、滑条、按钮上照常），带 `Ctrl` / `Alt` / `Meta` 时也不触发；方向键在焦点位于任何输入框 / 下拉时归控件自己。面板下拉用鼠标选完会把焦点还给画面（键盘在下拉里挑选项时不抢焦点）
- 声音（T11）：默认关；面板勾选「声音」或按 `M` 开启（浏览器要求用户手势），背景板模式下照常播放、`M` 仍可开关
- 时间：日期 + 当地时刻滑块，或用 60× / 600× 快进看日落
- 连续航程（VOY-DEFAULT 起**默认开启**）：打开页面就按当天的默认时刻、从默认地点接入东亚航线网，1× 流速、时间与飞行一起流逝，云由天气场驱动（首帧直接对齐天气场，机头直接对准第一段航线，不在首屏做大坡度转弯）。面板取消勾选后记住（localStorage `voyage.continuousJourney` = `0`，只记真实点击，脚本 `dispatchEvent` 的切换不写），下次载入保持关；URL `?voyage=1` / `?voyage=0`（也认 `on/off`、`true/false`；同名参数多个时以最后一个为准）强制本次开 / 关，且不改写记住的选择
- 航向（T49）：面板「航向」一栏——「自动航线」（默认：沿大圆航线飞，到达终点后自动接下一段）、「保持航向」、「盘旋」（以当前位置为等待点飞跑道形等待航线，一直看同一片地面）；「◀ 左转 / 右转 ▶」点一下 15°、按住连续转，或拖「选定航向」滑块；「直飞机场」选 15 个东亚机场之一，沿大圆航线飞过去、到达后在上空盘旋。键盘 `←` / `→` 每次 5°（`Shift` 15°；焦点在输入框 / 下拉框里时不响应）。转弯按真实客机：坡度 ≤ 25°，滚转约 3°/s（25° 要 8 秒多才压满）
- 调试小地图（DX-06）：面板勾选「调试小地图」或按 `N` 开启（默认关），左下角显示航向 / 轨迹 / 航线 / 云回波 / 交通 / 奇观；点击地图切换 50 / 200 / 800 km 量程

## 渲染管线（每帧）

```
CPU：太阳 / 月亮位置、航线与航向、颠簸、天气调度（闪电）、地面 clipmap 更新（异步拉瓦片）
  → 大气：天空视图 LUT（太阳、月亮各一张）+ 空气透视 3D LUT
  → 云：光线步进（层状云 + 雷暴 + 台风）→ 时间累积（带重投影）；每 4 帧一次云密度探针（异步读回）
  → 窗外 pass（outside-pass.ts，全屏但只算本窗窗板以内）：地形求交或海面、天空、太阳、月亮、星星 + 云合成
      + 远处飞机与航迹云 + 云地闪通道，× 窗板透射率 → hdrOutside（全分辨率 32F）
  → 云隙光（atmosphere/rays.ts，SPEC-RAYS，只在白天有云时画）：1/4 分辨率沿视线查云影图 → 4×4 模糊 → 从 hdrOutside 减掉云影里的空气散射，写 rays.target，舱内合成改读它
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
| `src/ui.ts` | 面板 DOM 绑定 `setupUi`、信息栏 `updateInfo`（拆「此刻」摘要 `#now-line1/2` 与开发者区完整版 `#info`，UX-3）、时间 / 高度控件同步；六个分区的折叠记忆 `setupPanelFoldUi`（`voyage.pref.panel.sections`，UX-3）；窄屏底部抽屉 `setupDrawerUi`（`voyage.pref.panel.drawer`，UX-4，把手点击 / 拖动展开收起，断点见 `style.css`）；开发者区（`?dev` / `Shift + D`）与聚焦设置、`Z` 键 |
| `src/view-presets.ts` / `src/focus-zoom.ts` / `src/head-limits.ts` | 视角预设与画布输入（按住拖动转头、滚轮前后、双击复位、按住不动聚焦）；聚焦观察（视场过渡、设置与记忆、暗角叠层）；头部左右限位（按前伸 / 视场 / 座位 / 舱等求不露出未建模区域的上限，拖动弹性阻尼）（FOCUS-ZOOM） |
| `src/astro.ts` | 太阳 / 月亮位置、月相、当地→赤道坐标矩阵（astronomy-engine） |
| `src/sky-assets.ts` | 星图（RGB：BSC5 星表格子，每格最多一颗星，T41；A 通道是银河）、月面贴图 |
| `src/light-pollution.ts` | 城市光污染的天空背景（T09）：从地面夜光估算，只压银河的可见度 |
| `src/traffic.ts` / `src/weather.ts` | 远处飞机的运动；天气预设、雷暴 / 台风摆放、闪电调度；天气场 `WeatherField`（T19b：按经纬度 + 时间取样云型 / 云量，雷暴系统与台风的出生、寿命、漂移，粗略东亚海陆分布） |
| `src/director.ts` / `src/weather-director.ts` / `src/routes.ts` | 导演（T19a）：航段接力（T49：优先向前、提前转弯、掉头借遮挡）、手动导航（`setHeading` / `turnBy` / `hold` / `directTo` / `resumeRoute`）、爬升—巡航—下降剖面、时间流逝、遮挡排队切换（`request` / `onCover`）、换原点；天气驱动（T19b）：按天气场插值云参数、借遮挡换云族、在视野外生成 / 移除雷暴台风、奇观之门云墙 `openGate`；东亚航线网 |
| `src/rail/*` | 火车模式（TR02）：`data.ts` 读线路烘焙产物；`corridor.ts` 走廊坐标（里程 s、横向 d、高程）、平滑中心线、按规范公式估算的超高；`train.ts` 速度曲线（巡航 90 km/h、曲线限速、终点停车折返）与车体姿态（台车连线、超高侧倾、悬挂外倾）；`vibration.ts` 车体低频振动；`geodesy.ts` 线路 ENU ↔ 经纬度；`mode.ts` 接到 voyage 的相机 / 状态（`window.__voyage.rail`，`rail.teleport(s, dir)` 调试用）；`far-view.ts` / `far-view.glsl.ts` 窗外程序的火车远景变体（TR03，`#define RAIL`，近处国土地理院平面带、掠射步进、相对高度、轮廓抗锯齿）；单测 `node src/rail/rail.test.mjs`；飞机模式着色器零回归比对 `node src/rail/shader-parity.mjs <对照 voyage 根目录>` |
| `src/debug/minimap.ts` | 调试小地图（DX-06）：可选的角落 2D canvas 叠层，画本机 / 轨迹 / 航线 / 交通 / 奇观，以及从天气场采样的云回波「多普勒」图；不碰任何 WebGL 程序 |
| `src/boot/software-gl.ts` | 软件渲染检测（PERF-CPU）：渲染器字符串是 WARP / SwiftShader / llvmpipe 时页面顶部提示原因与办法，见坑点「性能」 |
| `src/atmosphere/common.glsl.ts` | 大气参数、相函数、LUT 参数化、视线积分（所有着色器共用） |
| `src/atmosphere/luts.ts` | 透射率 / 多次散射 / 辐照度 / 天空视图 / 空气透视 LUT；`setHaze` 设边界层霾 |
| `src/atmosphere/haze.ts` / `src/render/haze.glsl.ts` | 低空障眼法（T18）：边界层霾参数（按时段、地区、日期）、清晨谷地辐射雾 |
| `src/atmosphere/rays.ts` | 云隙光 / 曙暮光条（SPEC-RAYS）：窗外 pass 之后按云影图步进空气里的影子、从窗外 HDR 减掉被云挡住的单次散射，舱内合成改读它的输出（不画时就是 hdrOutside）；按需后台编译，不在冷启动关键路径上 |
| `src/clouds/noise.ts` | 云的形状 / 细节噪声、天气图（GPU 生成） |
| `src/clouds/clouds.glsl.ts` | 云密度：层状云（天气场驱动）、雷暴（`towerShape`）、台风；云影 |
| `src/clouds/clouds.ts` | 云的光线步进、时间累积、云预设、密度探针 |
| `src/clouds/far-towers.ts` | 远景对流塔层（TW02）：天气场 170–760 km、没被体积雷暴占用的积雨云，独立小程序按解析几何画（塔身花椰菜 + 砧 + 雨幡，塔所在处的日照 / 地影，400 km 外空气透视外推），步进之后叠进云的 raw；按需后台编译 |
| `src/ground/geo.ts` / `tiles.ts` / `clipmap.ts` | 经纬度换算；瓦片加载（影像源抽象 `ImagerySource`、按站点限速、负缓存；地形、水体、道路、夜光）；7 级 clipmap（`setDetailContext` 决定最细两级要不要高清细节） |
| `src/ground/tile-compose.ts` / `tile-compose.worker.ts` | 影像 / 高清细节瓦片的解码与拼接（G08）：主线程发 Blob + 画布矩形，拼接 Worker 解码（按地址缓存位图）、在 CPU 画布上拼、读回像素，转给合成 Worker；拼接 Worker 停用时合成 Worker / 主线程用同一份代码 |
| `src/ground/imagery-blend.ts` | 高清细节合成（G03，在地面栅格化 Worker 里跑）：国土地理院航拍的高频 × 局部反差匹配 + EOX 的低频色调，挡水面 / 云 / 耀斑等异常 |
| `src/ground/road-raster.ts` / `road-raster.worker.ts` | 夜间道路灯带（T08）：OSM 道路栅格成有向距离场 + 照亮宽度，在 Web Worker 里算；着色见 `ground.glsl.ts` 的 `groundRoadCoverage`、`terrain-shading.glsl.ts` 的 `groundRoadLights` |
| `src/render/scene.ts` | 场景（舱内合成）着色器：舱内 uniform 声明、主函数（舱壁 / 内衬 / 遮光板 / 座椅 / 窗板效果、alpha 打包）、`createSceneMaterial`（持有所有 pass 共用的 uniforms） |
| `src/render/outside-pass.ts` | 窗外着色器（SC-5）：`outsideRadiance`（地面 / 海面 / 天空的唯一调用点）、交通、闪电；`createOutsideMaterial` / `createOutsideTarget`；窗外变体（PERF-13：`""` / `OW` 罕见光学 + 天幕层奇观 / `DOW` 低空细节 / `DROW` 火车）由 `GroundDetailVariant` 管，选择只在 `wantedOutsideKey` |
| `src/render/noise.glsl.ts` | 窗外与舱内共用的小噪声（hash12 / vnoise / hash22 / fbm2）和 `uLoopGuard`；改它两个程序都重编 |
| `src/render/ocean.glsl.ts` | 海面：菲涅尔、12 波斜率场、风痕、`oceanRadiance` |
| `src/render/terrain-shading.glsl.ts` | 真实地面着色 `groundRadiance` |
| `src/render/seat-pass.ts` | 座椅 pass（PERF-14）：座椅的追踪与着色从舱内合成里拆出来，画到 `hdrSeat`（rgb 颜色、a 覆盖率），舱内合成按像素读回；灯光与舱内合成共用 `scene.ts` 的 `cabinLightsSetup` |
| `src/render/wing-shading.glsl.ts` | 机翼着色 `shadeWing` 与航行灯 / 频闪 `wingLights` |
| `src/render/optics.ts` / `optics.glsl.ts` | 罕见光学现象（T17）：宝光与本机影子（乘在云的辐亮度上）、幻日与 22° 晕（卷云单次散射）、太阳圆盘与绿闪（地平线亚像素裁切 + 三色色散 + 蜃景放大）；CPU 端按条件 + 分段随机决定出不出现、多强。SPEC-BOW：雨区（雷暴雨幡 / 浓积云下的阵雨，≤ 4 个解析高斯雨柱）上的雨虹（10 波长几何光学主 / 副虹 + 亚历山大暗带）与阵雨雨幕、云海上的云虹（Mie 拟合）、卷云里的环地平弧 / 日柱；演示 `?bow=1` |
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
  **已冻结时再调 `freeze(true)` 保留原冻结时刻（DX-23）**：以前每次都重取 `performance.now()`，同页多变体对照在两次冻结之间让 `uTime` / 频闪相位 / 海浪相位跳一截（`low-sea-glint` 隔 0.7 s 再冻结一次：master 平均差 3.14、9.7% 像素超阈值，现在 0）；C11 / C12b 靠劫持 `performance.now` 绕过的做法不再需要。要换冻结时刻就先 `freeze(false)`。
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
  **SPEC-BOW**：`?bow=1`（= `?optics=bow`）或 `__voyage.optics.force = { bow: true }` 演示虹——强制云虹 + 宝光、在对日点外 46° 那一圈上摆一片演示阵雨（窗外往下约 20° 的方向）、卷云里强制出片状冰晶（环地平弧要太阳 ≥ 58°，日柱要太阳 ≤ 6°）；拨了时间 / 航向后 `__voyage.optics.resetBowDemo()` 重摆；`status.rain` 列出槽里的雨柱（来源 / 距离 / 消光 / 离对日点角距）、`status.cloudBow` / `cha` / `pillar` 是强度。回归场景 `bow-rain` / `bow-cloud` / `bow-cha`（表尾）；对照、计时、闪烁的 jobs 在 `handoff/SPEC-BOW-*.json`。
- **调试小地图**（DX-06，`src/debug/minimap.ts`）：面板底部「调试小地图」开关，或按 `N`（不在输入框里时）；默认关，纯 2D canvas 叠层，画在左下角（约 280×300、半透明深色底，不挡舷窗中心），关着时 `update()` 第一行就返回、canvas `display:none`，零开销。内容：本机（图标固定圆心，地图始终「航向朝上」）、已飞过的轨迹、当前航线（`director.leg` 的航段或 `state.preset.dest`）、远处的其他飞机（`traffic.ts`）、奇观（`wonders.active`）、以及「云的多普勒」——仿气象雷达回波图，背景网格从 `director.weather.field.sample()`（天气场）按经纬度采样云量 / 云型换算出回波强度，叠加当前**实际渲染中**的 `weather.storms` / `weather.hurricane`（不论天气是导演按天气场摆的还是面板手选的，雷达图都和窗外一致）。点击地图本体在 50 / 200 / 800 km 三档量程间切换。雷达网格（48×48）每约 800 ms 重采样一次，且分帧算（每帧最多 4 行），避免拖帧；台风的螺旋雨带是按角度做正弦调制的近似图形（用于「看起来像螺旋回波」），不是 `clouds.glsl.ts` 里真正的密度场（CPU 侧读不到那份数据）。
- `sceneMat.uniforms.uDebug.value`（窗外与舱内共用同一份 uniforms，1–4 在舱内程序，其余在窗外程序）：1 内衬命中深度，2 亮度伪彩，3 内衬受到的窗光，4 内衬法线，5 海面本身，6 海面天空反射，7 海面内散射，8 海面粗糙度 / 像素覆盖，9 海面直射照度，10 闪烁格子。
- **航向 / 接力调试**（T49）：面板底部「立即触发到达 / 接下一段（调试）」按钮 = `__voyage.director.forceArrive()`：不等飞到终点，立即走一次「到达」（自动航线接下一段，要掉头 > 90° 时照常排进遮挡队列；直飞模式转入盘旋）。其他句柄：`__voyage.director.ap`（自动驾驶：`mode` / `selHeading` / `turnDir` / `timeScale` / `hold` / `nextCourse` / `holdCourse`）、`director.setHeading(deg, dir?)`、`director.turnBy(±deg)`、`director.hold()`、`director.directTo("ITM")`、`director.resumeRoute()`、`director.nextLeg`（离终点 400 km 内预挑的下一段）、`director.describeNav()`。离线复现 / 单测（不开浏览器，几秒跑完）：`node --import ./handoff/T49-resolve.mjs --experimental-transform-types --no-warnings handoff/T49-test.mts`；按真实时间打印航向 / 坡度曲线与 > 60° 转向事件：同样的前缀跑 `handoff/T49-sim.mts [流速] [真实分钟] [预设]`。
- `window.__voyageStartup`：启动各阶段耗时。
- **聚焦 / 头部限位**（FOCUS-ZOOM）：`__voyage.focus`（`mag` / `durationMs` / `vignette`、`factor` 当前放大倍数、`progress` 过渡进度、`hold('script', true|false)` 脚本按住 / 松开；冻结时要直接到位就再设 `progress = 1`）；`__voyage.headLimits`（`pos` / `neg` 这一帧头部 x 两侧的上限，`clamp(x)`）；`__voyage.clouds.zoomSinceResetCap`（视场变化帧的「reset 后帧数」上限，默认 8，`Infinity` = 改前行为）。截图时聚焦要走 `focus`，直接改 `sceneMat.uniforms.uTanHalfFov` 会在下一帧被主循环写回。测量脚本：`handoff/FOCUS-ZOOM-input.mjs`（真实鼠标 / 键盘 / 触摸验收）、`FOCUS-ZOOM-cloud.mjs`（视场变化时云时间累积对真值误差）、`FOCUS-ZOOM-gpu-*.json`（`gpu-ab` 1× / 4× / 8×）。
- **CPU / GPU 进程剖析（PERF-CPU，`scripts/cpu-prof.mjs`，默认有头 Chrome）**：`node scripts/cpu-prof.mjs --port <端口> [--scenes default,noon-cumulus,night-city,storm-day,in-cloud,route-1x,route-60x] [--seconds 6] [--viewport 2560x1300 --dpr 1.5] [--angle d3d11|d3d11-warp] [--trace] [--no-gl] [--out tmp/perfcpu/x.json]`。每个场景输出：rAF 间隔中位 / p95 / 最大、每个 rAF 回调里主循环 JS 的耗时；主线程忙碌比例（`Performance.getMetrics`）；各进程 CPU（`SystemInfo.getProcessInfo`，100% = 一核）与最忙的线程（带 Chrome 线程名：`CrRendererMain` / `CrGpuMain` / `DedicatedWorker thread` / `VizCompositorThread` / `ThreadPoolForegroundWorker`…，`scripts/lib/thread-cpu.ps1`，仅 Windows）；Worker 消息频率；主线程 JS 自耗时 Top N（CDP Profiler，ms/帧）；WebGL 调用统计（每帧次数 / 耗时，另列 getError / readPixels / getParameter / clientWaitSync 这类同步调用）；`--trace` 再录一段 Performance trace，按线程列事件自耗时（样式 / 布局 / 绘制 / GPU 命令解码）。场景除 `scenarios.mjs` 的名字外还有 `default`（打开页面什么都不设）、`route-1x` / `route-60x`（hnd-cts 连续航程）、`same`（不重设再量一次）、`wait<N>`（等 N 秒）、`A` / `B`（执行 `--jsA` / `--jsB` 后再量，同页交替对照；代码可写 `file:<路径>`）。持测量锁。
- URL 参数 `?lut16`：大气 LUT 强制用半精度（T36 改前的行为、没有 32 位浮点线性过滤的设备），用来对照深暮光的阶梯。
- 截图前：把 `head` 固定在 `{tx:0, ty:0.02, x:0, y:0.02, tz:-0.3, z:-0.3}`、`uCloudOffset` 归零或设成固定值、隐藏面板（加 `hidden` 类），前后对比才有意义；截图放 `tmp/screenshot/voyage-*.png`。
- 测帧率前先 `page.bringToFront()`（窗口被挡住时 Chrome 会节流到 1 fps）。
- 找程序生成的岛：在浏览器里用 JS 复刻 `hash22` 列出岛心（见 WORKLOG「岛屿」）。

- **私有 headless 联调**（不用共享浏览器锁）：`node scripts/dev-browser.mjs check --port <端口>`（只开页面、等启动完成、收集 console error / pageerror，有错误就打印并以非 0 退出码报告，没有就退出 0；提交前用它比跑 `shots` 快得多，不用等每个场景 2.5 s 的稳定等待）、`shots --port <端口> [--only a,b]`（跑回归场景表 + 截图 + 帧时间）、`cold --port <端口>`（真冷启动）、`bench --port <端口> --baseline <对照端口>`（批渲帧时间两端口对照，附 GPU timer query）、`flicker --port <端口> --only <场景>`（DX-08，见下）。脚本会自动找本机 `ms-playwright` 缓存的完整版 `chrome.exe`，启动后校验渲染器不是 SwiftShader（用了 `chrome-headless-shell.exe` 或 `--use-angle=swiftshader` 会静默退化，见下面「坑点」）。GPU 被其他代理占满时可能报 `Target crashed`（等一等或换个时间再跑，`pnpm run` 套一层时偶发挂起，直接 `node scripts/dev-browser.mjs ...` 更稳，见 `handoff/DX.md`）。
  **`cold --wait-quiet` / `check|shots --respect-lock`（DX-10）**：`cold` 对负载敏感（编译在 CPU 上做），`--wait-quiet` 先等本机 CPU 占用降到 50% 以下再开始测（超时也会继续，不无限等）；`check` / `shots` 本身不持锁，但发现「测量锁」（`tmp/measure.lock`，见下面「测量锁」）存在时会打印一句提示（不阻塞），传 `--respect-lock` 改成先等锁释放再跑，给别的代理的离线 FXC / 真冷启动腾地方。
  **`cold --repeat > 1` 汇总（DX-22）**：以前每一轮的 `startup`（`window.__voyageStartup`，各阶段耗时）只是各打印一份，`--repeat` 传大了以后自己拿眼睛比哪个阶段稳定、哪个阶段来回跳很费劲。现在跑完自动按每个字段聚合 min/median/max（`--baseline` 时当前 / 基线两侧分别聚合），数值型字段直接聚合，字符串化的对象字段（PERF-14 加的 `startup["批次各程序编好（ms）"]`，`JSON.stringify({窗外: ms, 舱内: ms, 座椅: ms, 机翼: ms, "云#0": ms, ...})`——`startup` 的类型是 `Record<string, number | string>`，塞真对象会在最外层 `JSON.stringify` 整个页面状态时出问题，所以那边写成了字符串）会先解析再按子键分别聚合，一眼看出这一批并行后台编译里哪个程序是关键路径、稳不稳定。`--out` 的 JSON 从原来的裸数组改成 `{ results, summary }`（`summary` 只在 `--repeat > 1` 时才有）。
  **`shots` 的 `--out` 相对仓库根解析**（不是当前工作目录，worktree 里跑就是 worktree 根，**不是主仓库**——审查时去对应 worktree 的 `tmp/screenshot/` 找；`shots` 结束时打印绝对路径。DX-24 起 `passes.mjs --variants`、`ab` / `flight` 的 `--jobs` / `--variants` / `file:` 也按仓库根解析，`scripts/` 下再没有按当前目录解析的路径参数），不传就是 `tmp/screenshot/dev-<端口>`（T08 开发体验反馈踩过一次：写了 `../../tmp/...` 结果传到了仓库外面）；也支持绝对路径，原样使用。`scripts/compare.mjs`、`scripts/probe.mjs`、`scripts/passes.mjs`、`scripts/shader-budget.mjs` 的路径参数（`--out`、`--heatmap`、`--baseline`）都是同一套解析规则（DX-08 统一进了 `lib/chrome.mjs` 的 `resolveRepoPath`）。
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
  **`ab`（DX-23，同页多变体 A/B，收编 `handoff/C11-ab.mjs`、`C12-ab.mjs`、`T48b-ab.mjs`、`W-STAIR-diag.mjs`、`TM01-measure.mjs`）**：`node scripts/dev-browser.mjs ab --port <端口> --jobs <jobs.json> [--variants <variants.json>] [--base <对照端口>] [--rounds 2] [--cloud-live] [--quality high] [--out 目录]`。每个 job 摆好场景（`settle`）→ 钉回机位 → 跑 90 帧让后台变体（湿窗等）编好 → 冻结、翼尖频闪钉灭 → **冻结状态下等 `ground.pending === 0`**（最多 120 s）再多等 2 s → 按 `old,new,old#2,new#2` 交替套用变体。每个变体先把所有变体碰过的材质原文 / defines / uniform 复原，再按变体换：`materials`（整段换原文，来源 `current` / `base`（从 `--base` 端口活页面读同一材质）/ `base:<另一材质>`（湿窗变体在对照页面还没编时用 `base:wingMat`）/ `file:<路径>`，**一次可换多个材质**）、`patch`（`{"wingMat,wingMat.wet": [["查找","替换"]]}`，键可逗号列多个材质共用一组补丁）、`defines`、`uniforms`（`{"exposure.finalMat.uniforms.uNightChroma.value.x": 0}`，数组值走 `fromArray`）、`js`；换完 `compileAsync` + 真 render 一次并查 `diagnostics.runnable`，编坏直接报错。**预热判据**：冻结时连续两张截图逐字节相同才算稳定（最多 `--warm-max 8` 轮，不稳会警告）；`--cloud-live` 时云一直在变，改成等 30 帧。每张图旁写 `.json`：`groundPending`、`errors`、`corsErrors`（期间 EOX 瓦片跨域失败数，**大于 0 或 pending > 0 自动标 `void` 作废**）、画质档、预热轮数。job 字段：`name`、`scene`（场景名或对象）、`offset` / `head`（多姿态）、`crop`（测量区，显示像素）、`zoom`（放大区截图）、`pre`（冻结前的 js）、`hdr`（如 `"hdrWing"`：读回渲染目标 float 逐位对照参照变体）+ `hdrMask`（一个不画目标物体的变体名：与参照逐位相同的像素算「非目标区」，单独报这些像素上的差——W-STAIR 的「非机翼逐位不变」）、`bench`（如 `"benchWing"`，7×30 帧中位）、`variants`（不给就用 `--variants` 文件）。跑完每个 job 打印指标表：亮度 / 相邻差 / 对角差 / HSV 饱和 / RGB max−min（裁剪区）、对第一个变体第 1 轮的差（mean / max / 差 > 8 像素数）、**噪声底**（同一变体两轮之差，应为 0）、作废标记；全部写进 `<out>/summary.json`。持测量锁（等锁再测）。模板见 `handoff/DX-23-ab-jobs.json`。
  **`flight`（DX-23，确定性航迹重放，收编 `handoff/C12b-ab.mjs` + `C12b-metrics.py` + `T48c-motion.mjs --inpage`）**：`node scripts/dev-browser.mjs flight --port <端口> --jobs <jobs.json> [--variants <variants.json>] [--modes static,reset,cruise,turn,exit,live] [--truth 128] [--speed 0.004] [--checks 100,120,140,160] [--no-sigma]`。页面**全冻结**（云也不由 rAF 画），脚本手动 `clouds.render(motion, …)` 推进云，航迹对每个变体逐位相同；变体格式同 `ab`（通常改 `clouds.resolveMat` / `clouds.marchMat`）。**真值** = 同姿态静止、逐帧 `clouds.raw`（resolve 之前、未夹取的本帧步进结果）等权平均 `--truth` 帧（`uFrame` 周期 64，取 64 的倍数），不依赖 resolve 着色器文本（C12b 靠文本替换造 truth 变体，resolve 一改就失配）；只对云外有意义（云里 resolve 另做 3×3 平均）。各模式：`static`（零运动预热 96 帧后读 64 帧云缓冲：relStd / relLow16 / 空间噪声 spatRms / 对真值误差 / 等效模糊 σ / 云边能量比）、`reset`（snap 后第 1–64 帧对真值误差，3 个 `uFrame` 起点平均——DEV_SOP 时间累积三条之①）、`cruise` / `turn`（滚转 `--roll 25`°、每帧偏航 `--yaw 0.05`°）/ `exit`（云里爬升出云，whiteout 按 τ 0.5 s 衰减）：在检查点对**该姿态**的真值算 `err`（rms/均值）、`σx/σy`（拟合 V ≈ 高斯⊗真值，**云边宽度**，像素）、`edge`（真值梯度前 10% 带上 box3 后梯度能量比，< 1 变糊）；`live`：解冻、飞机照常飞，**每个 rAF 紧跟主循环读显示画布裁剪区**（不截图——截图拉长帧间隔会给带时间常数的一方造假抖动，DEV_SOP 三条之②），输出 16×16 块去漂移后的 relStd / relLow16、整片「呼吸」（相邻帧均值差 / 均值）与帧间隔中位 / 最大。HDR 裁剪与真值存成 `.f32`，表格与各变体对第一个变体的比值打印在最后。实测 1 个 job × 2 变体 × 5 模式约 90 s。模板见 `handoff/DX-23-flight-*.json`。
  **`gpu-ab`（DX-26，同页 GPU 计时的变体对照，收编 `handoff/C10b-time.mjs`；变体 / 端口快慢的结论以它为准）**：`node scripts/dev-browser.mjs gpu-ab --port <端口> --jobs <jobs.json> [--variants <variants.json>] [--base <对照端口>] [--rounds 8] [--n 20] [--time clouds|frame|wing|scene]`。job / 变体格式同 `ab`。每轮按 ABBA 交替（A,B,C,C,B,A…，抵消单向漂移）套用变体，`EXT_disjoint_timer_query_webgl2` 包住 N 次被计时的动作：`clouds` = N 次 `clouds.render`（步进 + resolve，全冻结、rAF 不画云，查询里只有这 N 次；变体碰了 `clouds.*` 时默认）、`frame` = `benchFrame(N)`（cloudLive 冻结，含云；否则默认）、`wing` / `scene` = `benchWing` / `benchScene`。**程序切换核对，失败直接报错不出数**：① 两个变体在同一材质上文本（含 defines）不同却绑定同一个 WebGLProgram 编号 → 报「程序没切换」；② 计时区间里被改的材质一次都没画到 → 报错并列出区间里实际画了哪些材质、云步进当前变体键（C10 当年改的不是这一帧实际画的步进变体，量出「GPU 持平」的假结论）；③ 所有变体文本相同只提示。输出每个变体的中位 / 最小 / 离散（IQR / 中位）、对第一个变体**逐轮配对比**的中位与四分位，判定「显著」要求四分位不跨 1 **且**中位偏离超过 max(3%, 基准自身离散 / 2)；**加一个与基准相同的变体（如 `{"name":"cur2"}`）就是 A/A 噪声底**。实测（RTX 5090、d3d11，8 轮）：noon-cumulus 云 0.483 ms，A/A ×0.997 [0.985, 1.005]、步数上限 192→384 ×0.996（无变化）、`cloud-ref` ×1.95；负载下只跑 4 轮时 cap384 出过 ×1.20 的假「显著」，**结论至少 8 轮并带 A/A**。持测量锁。模板 `handoff/DX-26-gpu-ab-jobs.json`，故意改错材质的反例 `handoff/DX-26-gpu-ab-wrong.json`。
  **`ab` 的 DX-26 扩展**：
  - **`ground` 简写**：job 或变体里写 `"ground": {"demNightEdgeShared": false}`，自动设 `__voyage.ground` 上的开关、`rebuildAll()` 并按 G08c-seam 的判据等瓦片完全到位（pending 0、各级 valid 且不在建 / 不过期、上传队列空）；变体级的开关，没写的变体按 job 设好后的原值（变了才重建），job 结束复原。冻结后等瓦片的判据也从 `pending === 0` 加严成同一个 settled。
  - **正则补丁**：`patch` 里除 `["查找","替换"]`（第三项 `true` = 找不到就跳过）外，还可以写 `{"re": "…", "to": "…$1…", "flags": "g", "optional": true}`。
  - **内置诊断变体 `builtin`**（收编 `handoff/C10b-var*.mjs`，作用在当前实际画的 `clouds.marchMat`，可与自己的 `patch` 叠加，先套自己的再套内置的）：`cloud-ref` 细步真值（步长 ×1/4、lod 仍按原步长 = 同一密度场、上限 3000、关进云二分）、`cloud-dist` 深度出口（L = depth·α，读回后 Y/α = 深度 km）、`cloud-steps` 步数用量（R = 这条视线用掉的步数）。补丁是正则 + optional，同时适配 C10（二分、上限 192）与 C10b 交付版。
  - **`cloudDump`**（job 字段，`true` 或 `{warm: 96, frames: 16, heatTop}`）：每个变体换上后手动零运动推进云，读回 `history` 左半 16 帧平均的 (α = 1 − T, Y) 存 `<变体>.cloud.f32` + `.cloud.json`；`cloud-steps` 变体读 raw 单帧步数，另出 `<变体>.steps.png` 热图（色标上端默认步数上限的 1/3，用满上限标品红）与均值 / 分位 / 用满上限占比。job 里有 `cloud-ref` 变体时自动打印**按距离分带（0–10 / 10–20 / 20–40 / 40–80 / 80+ km，需 `cloud-dist` 变体）的云边宽度**、**对真值 α 分档（0.01–0.1 / 0.1–0.3 / 0.3–0.6 / 0.6–0.9）的比值**、云区 |Δα|、Y 比、云区 |ΔY|/Y（口径同 C10b-an.py；noon-cumulus 实测 cur 边宽 5.0（真值 3.75）、α 分档 0.055 / 0.082 / 0.182，与 C10b 交付文档的 5.25 / 0.05 / 0.09 / 0.19 一致）。同一目录事后可用 `compare.mjs --cloud-dir` 重算。全冻结时截图里的云也是换上变体后收敛的样子。模板 `handoff/DX-26-cloud-jobs.json`。
  - **`live`**（job 字段，收编 `handoff/W-LAMP-ab.mjs` 的 live.all + `W-LAMP-live.py --all`）：`{"crop":[x,y,w,h], "frames":480, "record":{"uStrobe":"sceneMat.uniforms.uStrobe.value"}, "skip":"uStrobe >= 0.5", "regions":{"后缘弯折线":[60,40,120,35]}, "thr":16, "frac":0.05, "strobe":null, "variants":[…]}`。在冻结的 A/B 之后解冻、飞机照常飞，对每个变体页内**每个 rAF 读显示画布裁剪区（全部帧）**并逐帧记 `record` 里的 uniform 与时间戳；只用「前一帧、本帧、后一帧都不被 `skip` 排除」的帧算时间二阶差分 |L_t − (L_{t−1}+L_{t+1})/2|，按区域（相对裁剪区，显示像素）报**闪烁像素**（二阶差 > `thr` 的帧占比 > `frac`）与每帧超阈值像素、平均二阶差、帧间隔。原始帧存 `live_<变体>_<w>x<h>.u8`（RGBA 自上而下，W-LAMP-live.py 可直接读）+ `live_<变体>_flags.json`。night-city-low 实测同代码两次录制：后缘弯折线闪烁像素 11 / 16、每帧超阈值 7.1 / 7.9——**两次录制之间就差这么多，判回归要带同代码的第二个变体当噪声底**。模板 `handoff/DX-26-live-ground-jobs.json`。
  **瓦片 / 网络错误归类（DX-26）**：`net::ERR_CONNECTION_CLOSED` 这类报错文本里没有 URL，以前被当成真 console error；现在按消息来源 URL 判：外站（不是本页开发服务器）的任何 `net::ERR_*`、EOX / 地图瓦片域名、CORS 一律聚合成一行计数，并按错误种类分类打印。
  **`shots` / `ab` / `flight` 默认固定高画质档（DX-23）**：自动档会在截图期间按帧时间悄悄降档（云半分辨率），前后截图不可比；`--quality auto` 保留自动档（降档时逐张打印警告），`--quality medium|low` 显式指定。**EOX 瓦片跨域报错聚合（DX-23）**：`check` / `shots` / `ab` / `flight` 不再把每批 600+ 条瓦片 CORS / `net::ERR_FAILED` 逐条打成 console error，改成结尾一行计数（附首条原文），不计入错误数。
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
  **测量工具打开页面一律带 `voyage=0`（VOY-DEFAULT）**：页面默认开启连续航程后，载入到 `applyScene` 之间的几秒里导演会先按天气场改云（含 `type` / `density`、云影图分片状态）、摆雷暴、改海面风、改舱灯与航向，`setActive(false)` 不会把这些都撤回。所以 `dev-browser.mjs`（`openPage`：check / shots / ab / flight / gpu-ab / bench 等全部子命令，以及 `cold`）、`passes.mjs`、`probe.mjs`、`cpu-prof.mjs`、`regression.playwright.js`、`cabin-luminance.playwright.js` 的导航 URL 都带 `voyage=0`，页面从载入起就不进连续航程，与改动前的页面同一状态。要测「默认开启」的真实首载 / 控制台：`--query "&voyage=1"`（同名参数以最后一个为准）。自己手写脚本打开页面时也要带 `?voyage=0`。
- **回归场景的固定日期（DX-07）**：`scenarios.mjs` / `regression.playwright.js` 里依赖月相 / 星空的夜景、黄昏场景都写了固定 `date`（不写 `date` 就用「打开页面当天」，月相每天都在变，跨波对比会误判——第 6 波美术总监报告撞上过一次，见 `research/ART_REVIEW_wave6.md`）。`night-city` 系列、`route-hnd-cts-night`、`dusk-earthshadow` 用的是无月夜（月亮在地平线下，日期与高度写在场景条目的注释里）；`night-sea-milkyway`（T09）和新增的 `night-sea-fullmoon`（DX-07，满月、高度 58°、方位几乎正对左座窗外）各自固定在原来的月相上。月亮高度 / 方位都是用仓库自带的 `astronomy-engine`（`src/astro.ts` 的 `moonState`，T09 用过的同一套）算的。
- **`applyScene` 跨版本容错（DX-10）**：`scenarios.mjs` 的 `applyScene`（`shots` / `passes` / `flicker` / `bench` 都靠它设场景）现在能对着**老版本页面**跑而不崩——控件不存在（`document.getElementById(id)` 是 `null`）或下拉框没有这个选项，打印一句 `console.warn` 并跳过这一项，不再 `Cannot read properties of null` 整段中断；`sc.js` 执行失败也只把失败原因塞进返回的 `info`（`console.warn` 一并记一句），不抛出、不中断同一批的后面场景。用真实老提交验证过：`7436ba1`（早于经济舱 / 奇观功能）的页面完全没有 `cabin-class` 控件，`DEFAULTS` 里照常带着这个键，`shots` 照样能跑完并出截图。给 `--baseline` / `--chain` 这类跨版本对照腾出了「同一份场景表两边都能用」的前提，不用再像性能工程师第 6 波那样现场写一份容错副本（`tmp/perf-w6/w6_patch_scen.py`，没有进仓库）。
- **截图并排对照 / 量亮度 / 逐像素求差（DX-05 / DX-07 / DX-08）**：`node scripts/compare.mjs --out <输出.png> [--crop x,y,w,h] [--zoom N] <图1> [<图2> ...]`，把多张截图拼成一张，每张左上角标文件名（父目录/文件名，便于区分不同批次的同名场景）；不给 `--crop` 就是整图并排，给了就先裁剪再按 `--zoom` 用最近邻放大（不模糊，专门给锯齿 / 闪烁这类像素级问题用）。**`--out` 同样相对仓库根解析**（也支持绝对路径）。泛化自 `handoff/T35-crop.py`（Python + Pillow），改用 Node + Canvas2D（借一次性 headless 页面做合成，复用 `lib/chrome.mjs` 找 `chrome.exe` 的逻辑，但不需要真实 GPU）避免依赖本机 Python 环境。
  `--measure x,y,w,h`（可重复，DX-07；DX-11 补齐更多统计量）：按原图像素（不受 `--crop` / `--zoom` 影响）输出每张图该区域的一整套统计：`mean`/`p99`（Rec.709 luma，`0.2126R+0.7152G+0.0722B`，0–255，公式与 `handoff/T08-stats.py` 一致）、`meanR`/`meanG`/`meanB`（三通道均值，判断偏色比只看 luma 直接）、`meanSaturation`（HSL 饱和度 0–100，判断「灰蒙蒙」还是「过饱和」）、`adjacentDiff`（相邻像素 luma 绝对差均值，水平 + 垂直一起平均——棋盘纹 / 锯齿指标，平滑渐变应接近 0）、`adjDiffH`/`adjDiffV`/`adjDiffDiag`（DX-22，按方向拆开：横只算右邻、纵只算下邻、对角把 "\" 右下邻与 "/" 左下邻一起平均——十字纹 / 菱形纹在横 / 纵上经常被正常纹理的高频盖住量不出来，只有对角方向会明显偏高，此前只能靠 `handoff/C03-hf.py` 的 FFT 频谱才看得出，DEV_SOP「测量约定」记过这条区别）、`pctBright`/`pctDark`（luma ≥ 250 / ≤ 5 的像素占比，死白过曝 / 死黑欠曝的面积）、`maskedPixels`（见下面 `--mask`）。**DX-23 补**：`hsvSat` / `rgbSpread`（HSV 饱和度与 RGB max−min，C / TM 系列的色度口径，HSL 饱和度暗部会被放大）、`blownBlobs` / `blownMaxArea`（luma ≥ 250 的 4 邻域连通块个数与最大块像素数——**死白验收看最大块**）、`streak` / `streakShift`（斜纹指数：高通残差在 10 个位移上的归一自相关最大值，C12-metrics 口径，**只在静止同机位截图间比**，绝对值含画面结构）；`--halo <参照图> --mask-image <云不透明度图>`：光晕指标（泛化自 `handoff/TM02-halo.py`：本图 − 参照的差按参照亮度扣掉「逐点曲线」后，云内离边 1–2 / 3–4 / 5–8 / 9–16 / 17–24 px 的残差偏离内部多少，输出 `haloAmp`（级）/ `haloWidth`（px）与云外差 `skyD`）。`--json` 改成打印 JSON；有 `--measure` 时 `--out` 不再是必填，可以只量数值不出拼图（省得再手写 Python + PIL 脚本，见 `research/ART_REVIEW_wave6.md` 末尾「开发体验反馈」）。
  **`--diff <图2> [--threshold 8] [--heatmap 差异.png] [--mask x,y,w,h ...] [--json] <图1>`（DX-08；DX-11 加 `--mask`）**：<图1>（位置参数）与 `--diff` 的值（<图2>）必须尺寸相同，按 `(|ΔR|+|ΔG|+|ΔB|)/3`（0–255）算每个像素的差异幅度，输出均值 / p99 / 超过 `--threshold`（默认 8，和 T08.md 验收表「差 > 8 的像素」同一口径）的像素占比、`maskedPixels`；`--heatmap` 额外写一张假彩色差异图（黑 = 无差异，过阈值变黄，2 倍阈值封顶到红，`--mask` 排除的区域画成灰色），比读一堆数字更快看出「差异到底在画面哪里」。
  **`--mask x,y,w,h`（可重复，DX-11）**：这个矩形（原图像素坐标，和 `--measure`/`--crop` 同一套坐标系）内的像素从 `--measure` 与 `--diff` 的统计里排除（例如遮住调试面板残留的一角、水印、小地图角标），不影响拼图 / 缩略图 / `--row`/`--col` 本身的像素内容，只影响算不算进统计。
  **`--mask-image <图.png> [--mask-channel alpha|luma] [--mask-threshold 128] [--mask-labels 高组,低组]`（DX-22）**：用另一张和被测图**同分辨率**的图（例如云缓冲不透明度的可视化图，或手绘 / 用 `probe.mjs` 读出的「窗外 vs 舱内」剪影图）的某个通道当逐像素分组依据，把每个 `--measure` 区域**额外**拆成两组分别统计（不是排除，是「两组都要看」——原有那一行不分组的统计照常输出，分组结果作为多出来的两行追加，`group` 字段标出是哪一组）：`channel` 默认 `luma`，`threshold` 默认 128（≥ 阈值算 `--mask-labels` 第一个名字那组，默认 `"high"`，< 阈值算第二个，默认 `"low"`；例如拿云缓冲当 mask-image 时 `--mask-labels cloud,sky` 能分别看云区 / 非云区各自的 `adjDiffDiag`，两边数字混在一起容易把问题冲淡）。分辨率对不上就跳过那张图的分组统计并打印警告，不中断其余图片；`--mask` 矩形和 `--mask-image` 分组是「与」的关系，先排除矩形，剩下的再分组。
  **`--row y` / `--col x`（都可重复，DX-11）**：对每张输入图取第 `y` 行（或第 `x` 列）的整条像素曲线，人读模式只打印 min/max/mean（完整数组太长），`--json` 打印完整的 `{ image, row, width, r, g, b, luma }` 数组——找地平线附近的色带台阶、天空渐变有没有断层，比在截图上凭眼睛找准哪一行快。
  **`--thumb N [--thumb-out 目录]`（DX-11）**：把每张输入图等比缩到最长边 = N 像素（默认双线性平滑，不是 `--zoom` 那种保留像素边界的最近邻——缩略图就是要靠模糊掉细节看整体剪影），写一张 `<原文件名>.thumbN.png`，默认写在原图同目录。剪影误读检查：远景的云团 / 岛屿 / 建筑轮廓缩到几十像素后还能不能一眼认出「这是什么」，是游戏美术常用的快速检验法，也呼应 3A 铁律「宁可小，不要糊」。
  **`--cloud-dir <ab 的 job 目录> --ref <真值变体> [--dist <深度变体>] [--variants a,b] [--json]`（DX-26）**：云缓冲读回（`ab` 的 `job.cloudDump`）的固定指标——按距离分带的云边宽度、对真值 α 分档比值、云区 |Δα|、Y 比、云区 |ΔY|/Y，外加目录里步数读回的统计（口径见上面 `ab` 的 `cloudDump`）。纯 Node，不开浏览器，几秒出数；不给 `--variants` 就取目录里全部 α / Y 读回。
  **零回归判断的基准是「同一份代码跑两次」的噪声底，不是 0**：TAA、云的时间累积、海浪相位、翼尖颤动、随机闪电都会让同代码两次截图产生非零差异（前面「坑点」举过 low-sea-glint 平均差 7–9/255 的例子）。判断「这一版改动有没有引入真实差异」时，先量一次噪声底（改动前 vs 改动前，或用 `__voyage.freeze` 冻结后连拍两张——冻结后噪声底应该是 0，见上面 `flicker --step 0` 的验证），再和「改动前 vs 改动后」的数字比，明显超过噪声底才算数，不要直接看 mean/p99 是不是 0。
- **定位专用探针（DX-08，泛化自 `handoff/T45-probe.mjs`）**：`node scripts/probe.mjs --port <端口> --scene '<JSON>' [--patch 文件.mjs] [--read '<JSON>' ...] [--out 目录] [--angle vulkan|d3d11] [--settle]`。应用一个场景 → 可选按 `--patch` 文件（导出 `PATCHES = [{ mat, replace, target? }, ...]`，`mat` 是 `window.__voyage` 下材质的点号路径，如 `"clouds.marchMat"`、`"outsideMat"`；`replace` 是若干 `[查找文本, 替换文本]`，按这个材质从未改动过的原始 `fragmentShader` 做精确替换）替换着色器片段 → 借 `clouds.pass` 内部共享的全屏三角形（`renderer.compileAsync`）等新程序真正编译完成（不是盲等几秒，也不会像直接同步渲染那样有卡死丢上下文的风险）→ 截图 → 按 `--read`（可重复）读回指定渲染目标区域的数值，坐标是目标自身分辨率下的像素坐标（不是屏幕坐标）。`target` 别名：`cloud` = 云历史缓冲、`outside` = 窗外 HDR（`hdrOutside`）、`exposure` = 曝光适应结果（`exposure.adapted.0`，2×1：左像素是三个 log2 亮度 + 倒影增益，右像素是色度），也可以直接给任意点号路径。
  **`--patch` 编译 / 链接失败会直接报错退出（DX-11，C01 反馈）**：`renderer.compileAsync` 只保证「编译到 `KHR_parallel_shader_compile` 认为完成」，不检查链接是否成功——three.js 的链接错误检查（`WebGLProgram.js` 的 `onFirstUse`）要等这个材质真正被 `render()` 用过一次才会触发，`compileAsync` 不会主动调用它。以前的行为是：改坏的 `--patch` 编译 / 链接失败后，脚本毫无察觉地继续截图，拍出来的是一片点阵 / 乱码（GPU 用着不匹配的程序状态画的），得靠肉眼看截图才发现。现在 `compileWait` 在 `compileAsync` 之后补一次真正的 `render()`，再读 `renderer.properties.get(material).currentProgram.diagnostics`，`runnable === false` 就直接在 Node 侧抛出并带上 three.js 的 program/vertex/fragment 错误日志，不再悄悄出一张坏图。
- **按 pass 的 GPU 计时（DX-08，收编自散落在各任务 `tmp/perf(-cloud)/passes.mjs` 的手工副本）**：`node scripts/passes.mjs --port <端口> [--only a,b] [--frames 30] [--rounds 3] [--baseline 端口] [--param k[=v]] [--wait-quiet]`，猴子补丁 `__voyage.clouds.pass.render`（所有全屏 pass 共用的同一个方法），用 `EXT_disjoint_timer_query_webgl2` 给每次调用包一个查询，按材质对象认出「窗外 / 云步进 / 云 resolve / 舱内合成 / 机翼 / 测光 / 曝光适应 / 曝光合成」。
  **按材质名识别并归类（DX-10）**：识别顺序是①`material.name`（three.js 材质自带字段，非空就直接用——目前仓库里还没有材质设置它，但以后哪个任务照建议给材质命名时这里立刻能用上，不用再改 passes.mjs）②已知的 `__voyage` 字段做对象身份匹配（窗外 / 云步进 / 舱内合成……，覆盖当前核心 pass）③**fragmentShader 里的 `#define` 常量名**兜底——认出 `CLOUD_STORM` / `CLOUD_HURRICANE`（PERF-10 计划里的雷暴 / 台风变体命名）、`WONDER_LAYER`、`CLOUD_CIRRUS`、`GROUND_DETAIL`、`CABIN_CLASS_ECONOMY`，新变体只要照这个约定用 `#define`/`#ifdef`，不用改 passes.mjs 就能被正确归类④bloom 的上 / 下采样材质没有存在 `window.__voyage` 上（对象身份够不着）也没有 `#define`，改按各自独有的 uniform 名（`uSrcTexel` / `uFalloff`）识别成 `bloom-down` / `bloom-up`（收窄了「其他」桶，此前 bloom 全部内部调用都堆在这里）；仍然认不出的才归「其他」。批渲用已有的 `__voyage.benchFrame`，不需要改 main.ts。
  `--variants 文件.mjs`（导出 `VARIANTS = [[name, pairs], ...]`，和 `handoff/T37-variants-cost.mjs`、`handoff/W00-variants-cost.mjs` 的写法一致）：在 `--material`（默认 `clouds.marchMat`）上依次换上每个变体，等 `renderer.compileAsync` 真正编完、并检查这个材质**真的切到了新程序**（没切换就打印警告——量到的可能还是旧程序，W00 在坑点里踩过这个）。**切换检测按 `renderer.properties.get(mat).currentProgram` 的对象身份判断（DX-11/12，PERF-12/TR07 反馈）**：原来按「程序缓存 Map 的 size 有没有涨」判断，撞上 cacheKey 巧合复用旧条目时会误报「没切换」（其实已经切了），改成直接比 `currentProgram` 是不是同一个对象——这正是 three.js 内部（`WebGLRenderer.setProgram`）自己判断「要不要走新程序」用的同一个字段，语义上更准。**编译 / 链接失败同样直接报错退出（DX-11，和 `probe.mjs --patch` 同一套 `diagnostics.runnable` 检查）**：以前一个变体改坏了，量出来的是「静默画点阵」那份坏程序的计时数字，看着像正常的性能数据，容易被当真用来判断优化有没有效果；现在编译 / 链接失败会带着 three.js 的错误日志直接中断，不会把坏数据混进对照表。
  **DX-26：变体 / 端口之间的快慢比较仅供参考**——每个变体各测一段、不逐轮配对，并行开发的负载漂移直接进差值（±30% 常见）；要下结论改用上面的 `dev-browser.mjs gpu-ab`。本工具仍适合看「一帧的钱花在哪个 pass」。同时修了两处：`--variants` 模式改为先摆场景再换着色器（以前换完着色器又 `applyScene`，可能换掉这一帧实际画的云步进变体）、`clouds.marchMat` 解析为当前实际画的步进变体，测量期间没画到被改的材质会警告；「currentProgram 对象身份没变」的误报根因是换着色器与核对之间主循环没冻结、已经照常画了一帧换上新程序，现在换之前的程序在同一次 `evaluate` 里记下（typhoon-bands 复现并验证消失）。
  **DX-23/24**：`--only` 拼错场景名直接报错并列出已知场景（以前静默过滤成空表；`scenarios.mjs` 的 `pickScenes` 统一校验，`shots` / `bench` 同样生效）；渲染器上下文已丢失（`CONTEXT_LOST_WEBGL`）时跳过计时并警告，某场景一个样本都没拿到也会警告。`dev-browser.mjs bench` 的 GPU 列改用渲染器自己的上下文（以前取「页面第一个 webgl2 上下文」，可能是画质探测用的一次性画布），拿不到计时逐行打印原因。
  量 `typhoon-bands` 的「云步进」时会顺带打印它更接近已知的哪一档（3.2 / 5.2 ms，见下面坑点，与代码无关），避免误判成回归。
  **测量锁 + 负载感知（DX-10）**：整段测量期间持「测量锁」（见下面「测量锁」），开始与每轮（每个场景）前采样一次 CPU 占用，超过 50% 打印警告；`--wait-quiet` 先等 CPU 降到 50% 以下再开始。
- **node 直接跑 `src/*.ts` 离线单测的标准入口（DX-11，`scripts/lib/ts-resolve.mjs`，收编自 `handoff/T49-resolve.mjs`）**：`src/` 下的相对导入按仓库约定不带扩展名（`import { foo } from "./bar"`），但 node 原生的类型剥离（`--experimental-transform-types`）不会像 vite/tsc 那样自动补 `.ts` 后缀，直接跑会报 `ERR_MODULE_NOT_FOUND`。用法：`node --import ./scripts/lib/ts-resolve.mjs --experimental-transform-types --no-warnings <你的 .mts 脚本>`（在 `apps/voyage` 目录下跑）——它注册一个模块解析 hook，相对导入解析失败时补一个 `.ts` 后缀再试一次，其余情况原样交给下一个 resolver。已知在用：`handoff/T49-sim.mts` / `handoff/T49-test.mts`（T49 的航向 / 坡度曲线离线复现，导入 `src/*.ts` 不带扩展名，需要这个 hook）；`scripts/weather-stats.mts` 不需要这个 hook（它的导入本来就写了 `.ts` 扩展名），直接 `--experimental-transform-types` 即可，见下面「改天气场」一条。往后新的离线单测都用这一份入口，不用再各任务各自在 `handoff/` 下复制一份 resolve hook。
- **离线 GLSL 检查**：`pnpm --filter voyage check:glsl`，不开浏览器，几秒内跑完，能抓住 GLSL 保留字、同一程序内的同签名函数重名、场景 / 窗外程序 sampler 数超 16（已用真实 GPU 交叉验证过一次，见 `handoff/DX.md`「返工记录」；当前各程序的实测用量见文首「硬约束速查表」的 sampler 表格——那张表由本工具生成，这里不重复写死数字，见下面坑点「窗外着色器的 sampler 已满」的 DX-09 校正），以及 `src/` 下有没有 CRLF 行尾（DX-05；仓库靠 `.gitattributes` 统一 LF，Windows 上脚本误写 CRLF 时 git 提交才会提示，这里提前到 check:glsl 里扫一遍并列出文件，见下面坑点「Windows 上 Python 写回源文件会变成 CRLF」），以及「硬约束速查表」里的 sampler 表格是否与实测一致（DX-09；`node scripts/lint-shaders.mjs --emit-table` 重新生成表格内容）。提交前跑一次比等冷编译报错快得多。`node scripts/lint-shaders.mjs --self-test` 单独测检查逻辑本身，不用起 vite。

- **ANGLE 后端切换**：`dev-browser.mjs` 的 `shots` / `cold` / `bench` 都支持 `--angle d3d11|vulkan`，默认 `d3d11`（Windows 上与生产环境一致，**这是交付验收的口径，不要改**）。日常改代码想快速看效果，开一个专用的 vulkan 窗口：`node scripts/dev-browser.mjs cold --port <端口> --angle vulkan`或直接用桌面浏览器 `chrome.exe --use-angle=vulkan`（真冷启动能从约 100 秒降到几秒，见`research/DX_SHADER_COMPILE.md`）。vulkan 会藏住 D3D11 专属问题（sampler 上限 16 vs 32、FXC 编译暴涨、X3595 屏幕导数报错），**验收前一定要在默认 d3d11 上再跑一次**。
- **模拟高分屏 / 弱 GPU**（DX-04）：`dev-browser.mjs` 的 `shots` / `cold` / `bench` 都支持 `--viewport WxH`（浏览器视口，默认 `1600x1200`）和 `--dpr N`（`deviceScaleFactor`，默认 `1`）。二者组合改变实际绘制的画布像素数（画布 = 视口 × DPR），例如 `--viewport 1600x1200 --dpr 1.5` 实际绘制 2400×1800，用来在本机高性能 GPU 上人为制造过载，测「画质自动档」这类自适应逻辑的降档 / 回升；不传时行为与之前完全一致。PERF-5 验收时就是手工这样模拟出「高分屏 + 台风天气」的过载场景（见 `handoff/PERF-5.md`），现在收成了通用参数。
- **离线着色器编译预算**：`node scripts/shader-budget.mjs`（或 `pnpm --filter voyage shader-budget --<参数>`），不开完整浏览器场景、不占 GPU，用 ANGLE 的翻译器 + Windows SDK 的 `fxc.exe` 离线算出每个程序的真实编译时间和 sampler 数。`--only <程序>` 只测一个，`--quick` 用 `/Od` 几十秒内出「能不能编过」，`--bisect <模块>` 把场景程序里的某段换成桩，看它占了多少编译时间（`--bisect list` 看可换的模块）。和浏览器真冷编译对照过一次，误差 5.4%，在 ≤15% 的可信范围内（见 `handoff/SC-12.md`）。
  **`--keep-hlsl`（DX-08，T41 反馈）**：默认编完就删临时目录；传了就保留并打印路径，方便直接改 HLSL 本身再用 fxc 计时（比在 GLSL 层一轮轮 `--bisect` 更快定位「具体是哪几行贵」）。
  **`--rounds N`（DX-10，默认流程也支持，不止 `--baseline`）**：重复测 N 轮，程序表输出 **min / med / MAD** 与 `--out` JSON 里每轮原始值，**判定按最小值**——负载（别的代理占 CPU）只会让计时变慢，噪声是单向的（`research/PERF_REPORT_wave6.md` 的验证：两侧交替测 5 轮，MAD 只有个位数百分比）。程序表已知有几个 id 离线计时不可信（目前是 `exposure-meter`，离线 25 s、浏览器里 0.25 s，偏差百倍，原因未查证——猜测是 32×32 常量循环在 `fxc /O1` 下被整段展开，ANGLE 实际用的编译配置不同），会在程序表里标注「【离线不可信，浏览器实测远快，见 README 坑点】」，数字仍然打印，只是不建议拿它判贴线 / 超预算。
  **`--baseline <目录> --rounds N`（DX-08，DX-10 加了 min/MAD 与跨版本容错）**：和另一个 worktree 对照，GLSL→HLSL 翻译两侧各做一次（确定性，不是噪声来源，不用重复），fxc 编译按「当前一轮、基线一轮」交替测 `--rounds` 轮，**判定按最小值**，同时打印中位数 / MAD。只接受目录（另一个 voyage 应用根，或含 `apps/voyage` 的仓库根）——这个工具本来就不连接开发服务器，Windows 也没有 Linux `/proc/<pid>/cwd` 那样的机制能从端口反查进程的工作目录，传端口号会直接报错并提示改传目录（例如 `.claude/worktrees/agent-xxxx/apps/voyage`，不确定就先 `git worktree list` 查一下）。**基线树缺材质 / 程序时不再崩溃**：对照更老的提交（奇观 / 卷云 / 经济舱这类后来才加的功能还不存在）会跳过缺失的部分并在结果里列出（`—（新增，基线树没有）`），不会像以前那样因为一处链式属性访问（如 `clouds.marchWonderMat.fragmentShader`）就让整棵树的枚举崩掉（性能工程师第 6 波复测反馈踩过这个坑：「`shader-budget --baseline` 对不同时期的树直接失败」，只能各侧各跑各的再手工比）。**基线树没装依赖时先明确报错（DX-23）**：临时 worktree（`git worktree add tmp/xxx <提交>`）默认没有 `node_modules`，以前 vite 会在第一个 `import "three"` 处抛一串看不出原因的解析错误；现在从基线目录往上找不到 `node_modules/three` 就直接提示「在那棵树的仓库根 `pnpm install --frozen-lockfile --prefer-offline`」。
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
  - **持锁**（`tmp/measure.lock` 目录，`mkdirSync` 原子互斥，和 `tmp/browser.lock` 同一手法；`owner.txt` 写持有者 + 开始时间）：`shader-budget.mjs` 的离线 FXC 计时、`dev-browser.mjs cold`（真冷启动）、`passes.mjs` 的按 pass GPU 计时、`dev-browser.mjs ab` / `flight`（DX-23，先等锁再持锁）/ `gpu-ab`（DX-26）。
  - **查锁但不强制等待**：`dev-browser.mjs` 的 `check` / `shots`，发现锁存在只打印一句提示（不阻塞），传 `--respect-lock` 改成先等锁释放。
  - **不是本仓库脚本的 vite 构建 / 开发命令**（`pnpm --filter voyage build` / `vite build` / `vite dev` 等，管不到）：约定上手工跑一次 `node scripts/measure-lock.mjs check` 看一眼有没有人在测量；`node scripts/measure-lock.mjs wait [--timeout 分钟数]` 轮询等到锁释放再退出（默认最多等 20 分钟）。
  - 这不是严格的分布式互斥（两次读—写之间仍有极小的竞态窗口），目标是「大概率避免互相干扰」，不是绝对正确性；锁只是提醒，任何一边异常退出忘了释放，直接删掉 `tmp/measure.lock` 目录即可（和 `tmp/browser.lock` 的「残留超时删掉再取」同一处理方式）。
  - **可重入（DX-26，多个代理踩过「外层持锁、内层工具又等锁」）**：持锁成功时 `owner.txt` 多写「pid：」「令牌：」两行，令牌放进环境变量 `VOYAGE_MEASURE_LOCK_TOKEN`（子进程继承）。同一进程再次持锁、或子进程带着同一令牌来持锁，都视为已持有，直接返回空 release，不等、不删锁（嵌套计数归零才真正删）。自写脚本要持锁跑一串工具：`node scripts/measure-lock.mjs run -- node handoff/X.mjs …`，或在自己的脚本里 `acquireOrWait()`（`scripts/lib/measure-lock.mjs`）后再 spawn 工具。**自写脚本里不要再手写「锁存在就等」**（W-LAMP-ab / T48b-ab 那种 `readLock → waitForRelease` 不认令牌，会等自己）。
  - **排队名单与残留清理（DX-26）**：等锁时在 `tmp/measure.queue/` 登记，每次重查打印持有者、开始时间与**排在前面的等待者**（进程已退出的条目自动清掉）；`measure-lock.mjs check` 也列排队名单。持有者进程在本机已不存在且锁建了超过 60 s 的（只认带「pid：」行的新格式），等锁的一方直接清掉。

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
- **机翼程序冷编译的大头在着色、不在求交；只取决于 uniform 的量放在循环里算，FXC 照样整段内联**（PERF-WING，`handoff/PERF-WING.md`）：W-STAIR + W-LAMP 之后机翼成了启动关键路径（比窗外晚 0.35 s）。消融：去掉 `shadeWing` −69%，`sdWing` 各部件合计约 −30%，W-STAIR 下界 −0.2%；着色里最贵的是翼尖灯位置 `wingLampPos(i)`（只取决于翼尖弯曲），它在 `shadeWing` 的灯循环（套在 5 条子射线的循环里）和 `wingLights` 的灯循环里各内联一份（−13% / −6%）。
  修法：`main` 里 `wingLampsSetup()` 按**常数下标**调三次存进全局，两处灯循环读 `wingLampAt(i)`：离线 FXC wing 6.85 → 4.9 s（−28%）、wing-wet −31%，真冷启动机翼 −31%，关键路径回到窗外（机翼早约 2 s）。同页冻结 A/B 非机翼逐位 0；机翼有末几位差（相对 ≤ 3e-3），根因是旧程序里两份内联的灯位置被 FXC 和各自上下文一起重排——两边都去掉 `wingLights` 后新旧逐位相同。代价：机翼 pass 帧时间约 +2–3%（0.01–0.02 ms，gpu-ab 8 轮带 old/old A/A），「守卫循环算一次」「只提灯照那一份」「两个入口各算一次」都一样 +2–3%，不是寄存器寿命问题；「在两处灯循环前就地算」冷编译反而 +50%（又回到子射线循环里）。
  坑：守卫循环写法（下标不是常数）只有 −12%——FXC 靠常数下标折掉 `wingLampPos` 里按 i 的分支。把含隐式求导采样的函数（`wingEnv` → `skyRadiance`）挪出不连续循环时，ANGLE 不再生成 `…Lod0` 版本，fxc 报 X3511（试图展开循环）；包一层带 `break` 的 1 次循环即可。`[loop]` / `[fastopt]` 直接加在 HLSL 上对机翼程序都在 ±2% 内（循环本来就没被展开）。
  识别：`shader-budget --variants` 把一个只依赖 uniform 的函数换成常数，掉得多就说明它被内联在循环体里；给 W-EDGE B′ 留的余量见 handoff（新基线上 B′ +10.6% / wet +6.9%，仍比改动前 −24%）。
- **同一个数学表达式，写成 `max`+`abs` 比写成等价的 `clamp` 平方慢，FXC 对具体写法敏感、不是只看运算量**（TM01）：曝光合成里的一处软拐角，写成 `max(g, 0) + 0.5·max(0.5 − |g|, 0)²`（每个铰链各自 `max`，中间夹一次 `abs`）时 `exposure-final` 离线 FXC **+13%**；换成数学上逐点相等的写法 `0.5·clamp(g + 0.5, 0, 1)² + max(g − 0.5, 0)`（`clamp` 一次到位，不出现 `abs`）后回到噪声内。两种写法的浮点结果逐位相同（都是同一条 C¹ 连续的软拐角曲线），纯粹是 FXC 优化器对 `abs`/`max` 组合展开出的中间表示更啰嗦。识别 / 以后怎么避免：新写分段 / 钳位类的表达式时优先用 `clamp(x, lo, hi)` 一次夹到位，而不是拆成多个 `max`/`min` 再叠 `abs`；改完用 `shader-budget.mjs --variants` 对照写法本身（不只对照有没有这段代码），`fxc /O1 /Fc` 的 `Approximately N instruction slots used` 涨了但看不出为什么时，先怀疑是不是写成了 `max`+`abs` 的组合（`handoff/TM01-fxc.mjs`）。

<a id="pit-cloud"></a>
### 云

- **视场会变了（FOCUS-ZOOM 聚焦）：resolve 必须按上一帧的视场投影历史**。现象：只改 `uTanHalfFov`、resolve 还拿本帧视场去算历史的 ndc，放大 / 还原的 0.2 秒里整片云缓冲被按错误的比例取历史，云边拖出一圈缩放方向的重影（`handoff/FOCUS-ZOOM-cloud.mjs` sea-sc 4×：过渡中对真值误差 0.41–0.47、云边梯度能量比 0.36–0.65，正确投影后 0.12–0.13 / 0.80）。修法：`uPrevTanHalfFov`（`clouds.render` 末尾记下这一帧的视场）；视场不变时两者相等，resolve 逐位不变。另外放大时历史的角分辨率比这一帧粗（被拉伸、发糊），视场变化的帧把「reset 后帧数」压到 ≤ 8（`zoomSinceResetCap`），resolve 的等权兜底让新样本多占一些，过渡后第 4 / 8 / 16 帧误差 −12% / −17% / −15%；直接 reset 过渡中是 1 spp 噪点（误差 0.47–0.51），不可取。以后别处再改视场 / 投影（例如宽屏、换相机模型），同样要让 resolve 知道上一帧的投影。

- **雷暴程序的外壳空域跳跃**（PERF-STORM，`clouds.ts` 的 `laySeg` / `wxSeg`，只编进纯雷暴变体 `CLOUD_STORM_SKIP`）：够得着雷暴的视线（refineOn）原来整条走 0–15 km 外壳，现在只走层状云包络（首次进层 → 最后出层）和各雷暴包围柱（半径 7.5R + 0.5 km、高到砧顶 + 1.8 km）两段，之外一步跳到下一段起点。跳后第一步走半步、`lastEmpty` 同步到跳点（否则塔身表面细化会退回跳过的那段、反复撞同一处表面）。与默认程序从层顶起步是同一套采样，有无雷暴切换时近处云海逐带 Y 比与 master 相同（`handoff/PERF-STORM-switch.py`）。**改雷暴密度的形状 / 外延半径时，同步改 `cloudRayWeatherSpan` 的半径与顶高**，否则包围柱外的新密度被跳过（画面缺一块，α 读回对真值会掉）。
- **天气渐变不能走 `clouds.applyPreset` / `snap()`**（T19b）：会清掉时间累积，并让云影图整张在一帧里重建（3–8 ms）；连续航程每 0.25 s 推进一次云量，就会变成持续卡顿。修法：`clouds.setParams(p, true)`（gradual），云影图按后台分片节奏跟上；借遮挡的硬切才用 `setParams(p, false)`。
- **占据网格只保护 ±128 km 内的雷暴 / 台风**（T19b）：网格外照样逐点求值，4 个单体在 300 km 外仍 +1–1.5 ms/帧，台风在 750 km 外 +2–3 ms/帧（`handoff/T19b-storm-cost.mjs`）。天气驱动因此只在 280 km（雷暴）/ 600 km（台风）内摆放；以后要放得更远，先在云程序里给网格外的雷暴 / 台风做 LOD。
- **改天气场（`WeatherField`）的气候倾向之前和之后都要跑 `scripts/weather-stats.mts`**（WX10；DX-11 挂进了 `package.json`）：门禁是 `pnpm --filter voyage weather-stats -- --multi`（等价于 `node --experimental-transform-types --no-warnings scripts/weather-stats.mts --multi`，6 个种子全部通过，约 2.5 分钟，不开浏览器；不加 `--multi` 只跑一个种子并打印完整统计表，约 15 s）。它按月份和地区统计云型、雷暴、锋面、台风（100 年样本）、风场（WX11a），对照气候目标区间断言，退出码非 0 就是失败；每条断言都写了依据。T19b 的天气场就是在没有这类统计的情况下，把 1 月日本海做成了 63% 晴空、把台风做成了每年 59 个。
  写新断言时有两个坑（WX10 审查）：①只按一个种子调通的门限会随种子翻转，比如 4 年样本里「台风 8 月最多」20 个种子有 7 个失败，所以必须用 `--multi` 验；②门限要让改前的代码失败，否则分不出改前改后（「华北七下八上晴空 ≤ 45」改前就能过，已换掉）。
- **粗略海陆轮廓 `coarseLand` 分不出日本海一侧和太平洋一侧**（WX10）：本州是一条沿太平洋岸画的胶囊，东京落在中轴线上，新潟、金泽、秋田都算作海。拿它按「离海岸多远」判断寒潮阴雪时，北海道西部变成晴空，关东反而阴雪。修法：陆地按手画的脊梁折线 `JAPAN_SPINE` 分两侧。识别：打印 `surgeGeo(lat, lon, true)`，逐个核对札幌、新潟、东京、广岛这类城市在哪一侧。
- **值噪声集中在 0.5 附近，不能拿阈值直接当「时间比例」**（WX10）：三维 `vnoise` 的 p10 ≈ 0.25、p90 ≈ 0.75；z 取半整数的切片更窄，p10 ≈ 0.30、p90 ≈ 0.70。要表达「某件事有 60% 的时间发生」，先用 `rank()` 拉伸，再比较「活跃度 − rank」。
- **风场 `WeatherField.wind()` 不要每帧调，也不要把风向渐变进着色器**（WX11a）：`wind()` 约 4 µs 一次，按天气场取样的节奏（导演 300 模拟秒一次）算一条 `WindProfile` 缓存起来，每帧只用纯算术的 `windAt(profile, 高度)`（约 0.04 µs）。平流位移必须逐帧积分（`+= 风 × simDt`），不能写成 `t × 风速`（风一变云就跳）；风向只能在借遮挡硬切时换（噪声框架绕世界原点转，1000 km × 1° ≈ 17 km 平移，见 `research/WX11-DESIGN.md` 坑 A / B）。`WeatherSample.wind` 是惰性 getter，展开 / `JSON.stringify` 会触发计算。改风场同样过 `weather-stats --multi`（`--only wind` 单种子约 5 s）；地面风在海岸两侧本来就不同，连续性门限对地面放宽到 25%，云层高度（≥ 1 km）仍按 15%。雷暴系统的漂移改成出生时的引导气流（上限 60 km/h），`stormsNear` 的搜索半径随之从 +250 km 放到 +330 km。
- **只有乘性扰动的风场，在气候态矢量平均接近 0 的地方造不出风**（WX11a-b，WX11g 审查 D2）：现象是西太预设（30°N, 139.8°E）7 月海面风中位只有 1.5–1.8 m/s，平静（< 2 m/s）57–63%，海面几乎总是镜面；南海 7 月则反过来，一整月平静 0%，海况天天一样。根因：850 hPa 扰动原来只有「转 ±25°、乘 0.7–1.3」，副高脊线、季风转换期的矢量平均本来就小，乘出来还是小。真实大气里这些地方的标量平均风速远大于矢量平均，差的就是天气尺度扰动。修法：`wind()` 在乘性扰动之后再加一个随机风矢量，u、v 各自近似正态（`(vnoise − 0.5) / VNOISE_SD`，vnoise 的标准差实测 0.185）。每个分量的标准差为 4.5 m/s，冬季中纬度升到 6 m/s；气候态矢量 ≥ 9 m/s 的强而稳定的气流里降到六成（[Mon06]：信风、季风最稳定）。时间尺度取 48 h，取 30 h 时 850 hPa 的 1 小时连续性 p99 为 18%，超过门限。另外，地面风加了日变化：陆上 ±20%、海上 ±3%，当地 14 时最大，`WindProfile.diurnal` 往上按 ln z 回到 1。以后怎么识别：`weather-stats --only wind` 的「海面风」表和断言，看中位、平静比例，并对照 [JMA平年] / [HKO] 测站。**p850 相邻 25 km 连续性 p99 在 13.8–14.4%，离 15% 的门限很近**，再往 850 hPa 加空间变化之前先看这一条。已知缺口：西太 10 月中位约 3.1，八丈島 10 月平均 5.6，因为秋季东北季风在风场里要到 11 月才开始（`wN` 季节），不属于本修法的范围。
- **连续航程中途，白天的台风几乎摆不出来**（WX10 发现，T19b 的机制）：台风的卷云盖半径约 300 km，「整组在视野外」基本满足不了；巡航高度又在积云之上，遇不到穿云遮挡，只能等深夜。现在只有用户跳变（`onJump`）时会直接摆放，日志记 `[jump]`。截台风图的办法：场景 js 里打开连续航程，然后调用 `director.weather.onJump()`。跳变时也要先过 PERF-10 的预告门 `weatherReady`：冷启动后十几秒内换预设，如果变体还没编好，这一次不摆台风 / 雷暴。**合并时别丢掉预告门**：丢了 typecheck 照样能过，但会摆出画不出来的台风。
- **海上永远选不到浓积云、南海 / 冲绳盛夏几乎没有雷暴**（TW01，研究见 `research/TOWERING.md` §1）：现象是 7–8 月午后华南沿海 / 南海 / 东海 / 冲绳「头顶浓积云」全是 0%，400 km 内有雷暴的时间只有 15–30%，而航线大半在海上，所以普通航程看不到高塔。根因：海上对流潜势 `(0.3 + 0.25·清晨峰) × …` 只有陆地午后的一半，再被信风积云的加分压住；雷暴出生率又跟着对流潜势走。修法：`convection()` 给海上加「夏季风槽」（6–9 月 5–22°N，`monsoonTrough`，带 2–3 周的活跃 / 中断）与「盛夏暖洋面」（`warmOcean`，副高下再压 60%）两项，季风槽里信风积云的加分让掉 75%，暖洋面给浓积云加分；雷暴出生率公式没动（它跟着对流潜势走，海上自然变多）。试过把出生率再上调一档：模型雷暴日更接近平年，但 6 个种子的断言都分不出来，按下一条的规矩撤了。**以后怎么识别**：`weather-stats --only towering` 的 TW 断言（海上浓积云、400 km 内雷暴、雷暴日对照）；改天气场任何对流相关的项都先跑这一段。**「模型雷暴日」口径**：逐时检查单体边缘 20 km 内有没有单体，换算有不确定度，只能看量级（0.4–1.6 倍），别拿它精调。
- **只加一项、断言分不出来就删掉**（TW01）：试过「近岸按周围陆地比例混入陆地午后对流」，华南沿海午后浓积云 41% → 49%，改坏实验没有任何断言失败——既证明不了它有用，又多一组参数，删了。以后新加气候项，先写一条「去掉它必失败」的断言；写不出来就说明这一项不必要。
- **雷暴名额按距离挑会浪费在看不见的系统上**（TW01）：着色器只有 4 个单体名额，改前 `planStorms` 按离飞机的距离从近到远挑，机尾刚飞过的、在另一侧窗外的也占着，南海 / 华南沿海统计里挑中的单体只有 48 / 63% 看得见。现在走 `pickStormSystems`（`weather-director.ts`，纯函数，weather-stats 直接测）：飞过去 40 km 以上的不挑、已摆放的看不见了就撤掉让名额，另一侧窗外的不挑（转弯后下一次规划再摆）。**名额与 280 km 摆放半径没改**（那是 TW02），华南内陆 / 南海盛夏 400 km 内平均 5 个单体，名额仍然不够。
- **砧顶跟着对流层顶走，外壳会被撑到约 17 km**（TW01）：天气场的单体砧顶改为「对流层顶（急流轴以南 16.5 km、以北 11.5 km，按月的 `JET_LAT`）− 3~4 km + 0–1.8 km」，华南 / 南海盛夏中位 14.4 km（改前 13.5）。`updateShell` 取 `top + 1.8`，雷暴出现时步进外壳到约 17 km（台风本来就到 20.5 km），擦着雷暴的视线多走一点；面板预设的雷暴（13.5 km）与回归场景不受影响。
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
- **云边不锐的两个来源：表皮消光爬得慢（密度）、进云那一步太粗（步进）；只改前者会换来颗粒**（C10，`handoff/C10.md`）：沿视线 4 m 细步量表皮，视线光学厚度到 1 要进云约 100 m、到 3 约 200 m，进云 100 m 处 σ 中位只有 12–18 /km（真实积云 50–150 /km）——`layerDensity` 末尾 `min(d × 倍率, 1)` 的倍率 3.5 让侵蚀后的密度大多到不了饱和。把倍率提到 7 / 12，表皮缩到 60 / 45 m、云边 −15 / −20%，但 HDR 时间波动 ×1.6 / ×2.1：半透明薄丝在 1 spp 下变成「全中或全空」，受光样本在表皮里的深度随抖动乱跳（100 m 深处受光 od 已约 5），受光面满是颗粒。对症的是进云那一步：原来空白 → 有云时整个 2dt 区间按命中样本的 σ 算，受光深度在 [0, 2dt] 乱跳。修法：非天气程序里进云时在「上一个空白样本」与「这个样本」之间二分 4 次（同一个 `cloudDensity` 调用点、循环多走 4 步），从表面起先走半步——噪声 −12~−20%、云边 −6~−16%；再用省下的噪声预算把倍率提到 4.5。
  坑：①二分写成「在二分」「刚进云」两个 `continue` 分支离线 FXC +12.5%，合成一个分支 +7.4%；防重入的「刚二分过不再二分」变量是多余的（二分结果一定在上一个空白样本之后，不会反复退回同一处），去掉又 −1.3%。②C12 的「斜纹指数」按高通残差的方差归一，噪声变少时真实结构占比上升，指数会**假性升高**（本任务 ×1.2–1.6）；要判断有没有新条纹，在噪声分量（单帧 − 16 帧平均）上算（`handoff/C10-nstreak.py`）。③FFT 对角高频、归一相邻差按总能量 / 亮度归一：边变硬本身会抬相邻差，云里噪声降下去后对角高频占比反而升（结构占比变大），都要配噪声分量幅度一起看。
  **〔已解决 / 二分已撤，C10b〕二分定位对薄结构有偏**（C10 审查，`handoff/C10-review.md` 中 1）：二分只在粗样本碰巧命中时触发、命中后丢掉那个样本的 2dt 权重，比半步还薄的薄丝 / 小碎云被系统性低估（一维蒙特卡洛 dt = 80 m：20 m 厚的薄片新 / 旧期望 α 0.22–0.34；真实管线只二分时 α 0.01–0.3 档降到原来的 0.36–0.72，对 1/4 步长真值更远）。旧估计光学厚度期望无偏、只因 Jensen 偏淡，交付版更淡；天气程序的 refine（`fine = 8`）同样有这个性质——**凡是「粗样本命中才细化、丢掉粗样本权重」的做法都有这个偏差**。审查原型 fixF（二分后第一个样本为空就退回旧行为，按触发样本 2dt 计，零额外密度调用）：薄处恢复到原来的 0.63–0.92、边宽只回退 0.25 px，但 noon 的噪声也回到原来水平——说明那部分「降噪」本来就是薄丝被吃掉。α 均值、边宽、噪声这些汇总量都会掩盖它，要**按旧 α 分档看新 / 旧比值**（审查脚本 `scripts\c10rev-alpha.py`）。更好的路子是 C10b：近处只对有云的步减半步长（每个样本的光学厚度变小），做了以后二分可撤。
  **已推翻（C10b）：「只对有云的步减半」几乎没用**——20 / 40 km 内有云步 ×0.5、空白步维持 2dt，边宽、α、噪声与只撤二分逐项相同。云边与薄丝由**进云那一步**（空白区间 2dt）决定，杠杆是空白步。
- **云边 / 薄丝的杠杆是「空白步不加倍」，不是二分、不是有云步减半**（C10b，`handoff/C10b.md`）：现做法 60 km 内空白步也只走 dt（60–90 km 按 `smoothstep` 连续回到 2dt），撤掉 C10 的二分，第一步走半步，非天气步数上限 192 → 384。对 1/4 步长真值（同页 `ref` 变体）：边宽 noon 5.25 → 4.5（真值 3.75）、cu-side 7.0 → 5.5（3.75）、wonder 4.5 → 4.0（3.5）；α 0.1–0.3 档对真值 0.08–0.50 → 0.55–0.96；裁剪区 HDR relStd ×0.74、噪声分量 ×0.86；非天气场景云 render 比 C10 **省** 2–14%，离线 FXC cloud-march −6%、cirrus −12%。
  坑：①**C10 的二分本身很贵**（同页配对计时撤掉后云 render ×0.6–0.7）；C10 自报「GPU 持平」用的 `passes.mjs --variants` 当时打了「currentProgram 对象身份没变」警告，大概率量的是旧程序——**换云步进变体后必须核对程序真的换了**，或用 `handoff/C10b-time.mjs`（同页、GPU 计时查询包住 N 次 `clouds.render`、多轮配对比中位）。②边缘像素大多在 20–80 km（noon 中位 34 km），按 20 km 限近处几乎无效；步长本就正比于 t，屏幕上的样本间隔与距离无关，远处照样糊。③天气程序够得着雷暴 / 台风的视线要走整个 0–15 km 外壳，空白步全减会让 storm / typhoon 云 render +45~60%、远塔用完 448 步；只在层状云高度（上下留 300 m）里走细步后 +5~17%（+0.2~0.6 ms，超单任务 +0.2 ms 预算，已报协调者）。④撤二分后云里（飞机在云中）噪声 ×1.29——二分顺带把第一个样本锚到离相机 [0, dt/2]；第一步走半步即回到 C10 水平（×0.87）。⑤步数上限：空白步变密后 192 步只够走到约 13 km（掠射在层里的视线），必须同时提到 384。识别：改步进后按 `handoff/C10b-an.py` 看**按距离分带的边宽**与**对真值的 α 分档**，并用 `st_*` 变体（Y = 用掉的步数）看有没有用满上限。
- **进云样本的受光偏暗：命中样本在表面以下的深度 D ~ U[0, L] 均匀，而浓云亮度只由表面下十几到几十米决定、受光随深度凸下降（Jensen）**（C10c，`handoff/C10c.md`）：C10b 撤二分后巡航俯看浓层积云海（`sea-sc` / `sea-sc-low`）近处 0–60 km 对 1/4 步长真值 HDR 只有 0.85 / 0.60–0.71（C10 的二分顺带把样本收到表面附近）。修法（零额外密度调用）：进浓云那一步照常从命中点做受光步进，只从**离本点最近的前 3 步（约 240 m）**的 od 里减去「深度多出的那份」`odCut = min(0.4·κL, 3)·smoothstep(1, 3, σL)`、最多减掉这一段的一半，κ = σ·sinθ视/sinθ光（法线取 up）。σ、区间、不透明度不动（云边 / 薄丝的 α 与 C10b 逐位一致）。效果：sea-sc 0–60 km Y/真值 0.85 → 0.94–0.96（C10 0.90–0.94），sea-sc-low 0.60–0.71 → 0.72–0.89（C10 0.69–0.86），暗处（阴影缝）也更准、逐像素离散更小。
  坑：①**把受光求值点沿视线往回挪（δ = L/2 或按 κ 定）不行**——正午很准，太阳低时挪过的点跳出云顶、或跳出**邻近云块投下的影子**：阴影缝亮到真值 ×1.3–1.5、单帧放大是一片撒开的亮点（均值类指标看不出来，要按「真值最暗 30% 像素」的亮度比与对数离散看，`handoff/C10c-shadow.py` 的口径）。在 od 里减、只减近处一段，邻云的影子原样保留。②**二分探测（在 tS − L/2 多取一次密度、够浓才挪）画质最好但不划算**：放到下一步做（多走一步）GPU +10~14%（`prnever`：代码在、从不触发就 +4~9%——同一 warp 里受光块分散到更多迭代）；同一次迭代里多一个 `layerDensity` 调用点冷编译 +46%（单格点细节也 +23%），把主采样包进两次的循环共用调用点也 +25%。**云步进里任何新的密度调用点都先量离线 FXC**。③判「够浓」不能用 dens > 0.002：找到的是表皮外层极稀的絮，低太阳照样过亮；用命中密度的比例（0.3×）才对。④太阳很低、逆光看积云（sunset-wing）对 od 极敏感，不设「最多减一半」时 0–20 km 亮到真值 1.11；现做法 1.04–1.05（C10b 0.91–0.92），逐像素误差 0.093 → 0.124，是已知代价。⑤**天气程序的受光有两支**（普通 6 步、近雷暴 / 台风 8 步），改受光必须两支一起改：C10c 第一版只改了 6 步那支，场上一有雷暴，半径 c.z·7.5 + 15 km 内的近处云海就回到旧的偏暗，切程序时整片跳约 20%、半径边界一条亮度带（审查 P1）。验收加 `storm-sc` / `storm-sc-low`（同一片云海加雷暴）与 `sea-sc` / `sea-sc-low` 对比。
  识别：浓云海 / 云顶亮度偏暗先按距离分带看 Y/真值（`dev-browser ab` 的 `cloudDump` + `builtin: cloud-ref / cloud-dist`，C10c 的 `handoff/C10c-mkjobs.mjs` 能把补丁变体转成 ab / gpu-ab job）；改受光时必看阴影缝（上面的暗处口径）和逆光低太阳场景（sunset-wing）。**`flight` 在云里场景同页换多个变体时，第 2 个起的变体静止 relStd 会莫名 ×1.4**（C10c 实测两次，单独运行每个变体则与基准一致）：云里的噪声对照要每个变体单独跑一次，且冻结前把 `uCloudImmersion` 固定（`uniforms` 设 0.997），否则停在进场时的半截值。
  识别：云边问题先跑 `C10-ab.mjs` 的 `diag` 变体看表皮剖面（到 od 1 的深度、100 m 处 σ），再看边宽（`C10-edge.py` 的 10→90% 口径）与噪声分量幅度是不是一起动。
- **正午顺光的云「平」，压平在受光计算，不在色调映射：多次散射随受光 od 衰减太慢、粉末项压暗了正对太阳的面**（C-FLAT，`handoff/C-FLAT.md`）：美术总监 wave8 第 2 条量到正午受光面只占 7–15 级。曝光前读回云缓冲（`ab` 的 `cloudDump`，c = Y/α）才看清：noon-cu-close 受光那一半在 HDR 里只跨 0.21 档、受光 / 背光 1.75，而曝光 + TM01/TM02 + AgX 在云的亮度段给每档 25–34 级（TM 让它更陡，不是更平）。分量拆分（S 去掉环境光 / 多次散射 / 尾巴的变体相减，L 对 S 线性）：多次散射占受光面 80% 以上，环境光 1–5%、尾巴 1–16% 都不是主因；第 2 阶 e^(−0.25·od) 在 od 0.5 → 2.5 只降到 0.61，对照半无限保守散射层的反射（Chandrasekhar H 函数，≈ 朗伯余弦律）侧光 / 掠射受光面亮了约 2 倍；粉末项按**受光** od 算，恰好压暗 od 最小的受光面（反着余弦律走）。
  修法：顺光 / 侧光的普通云多次散射衰减 ×2（`CLOUD_MS_STEEP`，第 1 阶与单次同速，a ≤ b 更守恒），按 cosT 0.3 → 0.9 与飞机在云里退回 1；普通云去掉粉末项（雷暴 / 台风塔身都照旧）。正午受光面 p10–p90 7 → 13–15 级、受光 / 背光 1.75 → 2.55（noon-cu-close）、2.41 → 3.30（noon-cumulus）；逆光 / 夕照 / 雷暴塔 / 云里 / 黄昏逐位或近逐位不变；GPU、冷编译持平。
  代价（已知）：①受光 od 的随机误差按响应斜率放大，逐像素对自己真值的对数误差 ×1.6–1.8（云体对比也涨了同样比例，暗处约 1.2 → 1.7 级的颗粒），归 C13 降噪；②远处进云样本偏深的 Jensen 偏差同样放大，sea-sc 40–60 km Y/真值 0.94 → 0.87（显示上远处云带只暗 1.5–2 级）；③卷云等薄云去掉粉末后略亮（cirrus-noon 窗均值 +0.5）。
  识别：说「云平 / 不立体」先读回曝光前的 HDR 按分位看受光 / 背光比与 p50→p95 档数（`handoff/C-FLAT-an.py`），再用显示截图算「每档多少级」——每档 ≥ 25 级就不是色调映射的锅；分量用 `handoff/C-FLAT-diag-variants.json` 的相减法。**改多次散射的形状必须同时看对自己真值的逐像素误差（`C-FLAT-band.py`，MAD 口径——std 会被窗边零值像素污染到 3.0）**，否则会把颗粒当「细节」。
  **代价复测（C-FLAT 审查，以此为准）**：①时间噪声放大大于交接所报——flight 静止 relStd noon-cu-close ×2.57 / cu-side ×1.84 / sea-sc ×1.37，巡航误差 ×1.43–1.95，live ×1.21–1.72（同代码噪声底 ×0.91–1.09），绝对量约 0.4 级、目视不闪，暗面放大 2 倍可见细砂 → C13 降噪的输入，别当回归去查；②亮度对真值：近处也暗 3–5%（sea-sc 0–20 km 0.959→0.932，storm-sc 0.982→0.936），40–60 km 0.94→0.88，60–90 km 0.85→0.77——原有偏暗被更陡的响应放大，抵掉 C10c 一部分 → C10d 远处 odCut 放宽。
- **飞机在云里时窗外满是 2×2 棋盘纹 / 对角细纹，换抖动序列只换图样**（C11，诊断见 `handoff/INCLOUD-CHECKER.md`）：步进位置、受光挑格点两个 1 spp 随机源打在对受光 od 极敏感的深处介质上，blend 0.12 + 3×3 夹取的时间累积压不住，收敛后剩下的是抖动序列的空间图样。修法：resolve 把已经读进来的 3×3 邻域顺手求和，按 `uCloudImmersion` 把本帧值换成 3×3 平均（零额外取样，云缓冲上等于固定一次 3×3 盒式模糊；云里满窗是几十米内的雾，没有要保的细节）。in-cloud 8 个固定姿态：显示相邻像素差几何均值 2.88 → 0.43（最差 6.08 → 0.68），对角高频 ×0.07，HDR 时间 relStd ×0.18、relLow16 ×0.38。**不会跨深度边**：云缓冲左半只有云——步进不认识机翼 / 机身 / 地面（地面在窗外 pass 按右半深度合成，机翼在机翼 pass 盖上去），3×3 里没有别的物体的边；右半（深度）不做平均。机翼边上那些 2 px 阶梯 / 点阵（襟翼滑轨整流罩的阴影、亮三角的斜边）在改动前的 16 帧平均图里一模一样，是机翼 pass 自己的，原来被云的噪声盖住（`D:\Code\opus-test\tmp\screenshot\c11\wing\stair_z1.png`）。
  两个陷阱：①`uCloudImmersion`（= 曝光的 whiteout）出云后按 0.5 s 指数衰减，要约一分钟才真正到 0，直接当权重的话出云后几秒还在做 1% 量级的平均、云外不再逐位等于改动前——权重从 0.02 起算（`clamp(imm·1.0204 − 0.0204, 0, 1)`）。②**同页 A/B 时 `freeze()` 每调用一次都把冻结时刻重设成 `performance.now()`**：`uTime`、云偏移、whiteout 在两次调用之间各跳一帧，变体之间比的就不是同一个云场（C11 第一版 new / new2 平均差 0.6，以为是着色器不确定）。绕法：调 `freeze` 时临时把 `performance.now` 换成固定值（`handoff/C11-ab.mjs` 的 `__c11freeze`）。即使这样，偶尔还有**某一个变体**整体差一截（与着色器无关：同源的 old / old2 之间也出现过），判零回归要交替排 `old,new,old2,new2`，看有没有一对是 0，不要只看一对。识别：同一着色器的两个变体差得和新旧之间一样多。
- **云外时间累积降 blend 的真正障碍是重投影深度，不是双线性**（C12b，`handoff/C12b.md`）：静止时 blend 0.12 → 0.04 能让噪声减半，但直接降在巡航 / 转弯时云边出现错位的拖影（误差最多 ×1.8）。根因：resolve 用**本像素 1 spp 的深度**（`gl_FragDepth`）重投影，它随步进抖动、云边有 / 无云逐帧跳，取历史的位置每帧随机偏一下，blend 越低累积得越多。修法三件一起上：①重投影深度改 3×3 按不透明度加权的平均深度（单独这一条，巡航误差 ×0.90、转弯 ×0.85）；②历史改 Catmull-Rom（12 次 texelFetch），双线性每帧按小数位移叠一次 f(1−f) 的模糊，稳态约 1.1 px，Catmull-Rom 降到约 0.7 px；③blend = mix(0.04, 0.12, 4·(fx(1−fx)+fy(1−fy)))，按重投影位置的**小数部分**而不是位移大小（远云每帧 0.1–0.3 px 正是双线性最糊的区间）。结果：静止 HDR relStd ×0.49、对角高频 ×0.55、relLow16 ×0.58；巡航等效模糊 σ 1.08 → 0.73 px、对真值误差 ×0.90；转弯误差峰值最差 ×1.15；出云 ×0.91；云里（wImm > 0）与右半逐位不变。
  **reset 后收敛（C12b 审查返工）**：`snap()`（换预设 / 天气 / 云滑条 / `setSize` 即画质档自动升降）后 reset 帧只有 1 spp，blend 0.04 下它的权重按 0.96ⁿ 衰减，第 16 帧误差是 master 的 2.2–2.6 倍、约 48 帧才追上。修法：`uSinceReset`（reset 帧 0，之后每帧 +1，`render()` 里和 reset 标志一起维护），云外左半 `blend = max(blend, 1/(uSinceReset+1))`——前约 25 帧是等权平均，之后交还自适应 blend；修后第 16 帧误差比 master 还低（backlit-cu 0.051 对 0.072）。**时间累积类改动的验收必须加「reset 后收敛」一项**（`C12b-ab.mjs --modes reset`：snap 后第 1–64 帧对静止真值的误差曲线）——静止 / 巡航 / 转弯三个模式都在稳态上量，抓不到这个问题。
  三个坑：①**Catmull-Rom 单独上会让运动时噪声 ×1.16**——双线性的模糊顺带在降噪，换掉它要同时降 blend 才不亏；②**常数 0.04（即使有①②）转弯误差 ×1.74、出云 ×1.22**，必须按小数部分自适应；③方差裁剪（均值 ± 1.25σ，与 min/max 取交集）在这里没有收益（静止噪声反而 ×1.03，运动持平），没采用。识别：降 blend 后巡航截图云边出现亮 / 暗的错位细边（不是均匀的糊），先查重投影用的是哪个深度。测量：`handoff/C12b-ab.mjs` 的确定性航迹（手动推进 `uCloudOffset` 与 `clouds.render`，各变体逐位同一航迹）+ 每个检查点静止等权平均 256 帧的「真值」，比 `C12b-metrics.py` 的拟合模糊 σ 与对真值误差——冻结工具与真实 rAF 飞行都做不到逐位同一航迹。
- **积云的「垂直挤出豆腐块」：竖壁、平顶、邻云一样高、远处竖向肋纹**（C-TOFU，`handoff/C-TOFU.md`，根因见 `research/TOWERING.md` §2.1）：
  现象：散开的积云场、视线擦云层、20 km 以外（6 km 高最明显），云是把平面轮廓往上挤出来的长条块，壁上竖纹、顶一刀切平、一排排一样高。
  根因三个（都在 `layerDensity`）：①形状噪声竖直周期（nB 约 18 km、nA 5.4 km）远大于 2–5 km 的层厚 → 一层之内噪声只随水平位置变；
  ②积云剖面 h 0.12–0.45 是满密度平台，×4.5 饱和后侧壁竖直、顶被剖面下降段统一截平，局部云顶又来自 90 km 周期的天气图 → 邻云等高；
  ③远处（≳ 150 km）形状噪声取到 mip 4–5（4³ 纹素），三线性的平面小面连成竖肋。
  修法：竖直频率按层厚归一（`uCuShape.xy`，CPU 上 `cumulusShape()` 每帧算）；积云族（云型 > 0.45）去掉平台，改成「这一列的归一强度 σ 决定云顶」
  （`cumulusTop()`：σ = (d − 0.275) / max(覆盖率 − 0.275, 0.15)，云顶 = 0.25 + 0.75·σ^(1/1.2)）再用斜天花板 `d ≤ 0.275 + 0.6·(云顶 − h)` 压。成因③（远处 mip 4–5 的竖肋）在①②修好后远排几乎看不出，**试过形状噪声 mip 封顶 3，撤回了**：云 pass 贵 5–10%、远处时间噪声更高（C-TOFU 审查复测），只剩 tow-a8 约 200 km 地平线带很淡的竖纹。
  三个坑：**(a) 门槛要按「看得见的 d 段」归一**——d 最大只有覆盖率、细节侵蚀平均吃掉约 0.275，按 0..1 直接扣门槛时低覆盖率天气里所有云都成了扁饼；
  **(b) 天花板斜率决定云顶的质感**——太缓（约 0.2）云的上半截整段都是刚过阈值的淡密度，被细节侵蚀啃成悬空碎块（「爆米花」）；太陡（约 3）侵蚀没余地，云顶成了光滑的塑料团子、弱云被削薄、云量掉 10%；旧剖面下降段在 d 空间约 0.75，取 0.6；
  **(c) 着色器里按 uniform 算竖直倍率也贵**：`layerDensity` 被内联进步进 / 受光 / 云影十几处，`clamp(7/(1.3·层厚))` 这几次算术让 cloud-march 冷编译 +10%，挪到 CPU 的 `uCuShape` 后总增量 +4.4%。
  识别 / 测量：`ab --cloud-live` 加「高度出口」补丁（`L = vec3(length(ro + rd*depth) - BOTTOM) * (1 - T)`，cloudDump 的 Y/α = 云的加权高度 km）与 `cloud-dist`，
  按距离带数轮廓的竖壁游程（同一列连续 ≥ 5 行的侧边像素比例）和平顶游程（同一行连续 ≥ 12 列的顶边比例）、顶边高度 IQR；脚本见 `handoff/C-TOFU-metrics.py`。
  层积云 / 高积云 / 卷云不受影响。代价：云变高后视线在云里的步数变多，云 pass noon +5.5%、cu-6000 +9%、clouds-variety +12%、cu-side +15%（`gpu-ab` 8 轮带 A/A）。
- **新云种接进云步进：用宏换掉 main 里的调用，别改调用处的文本；远处的小区间要单独求交、中间空隙跳过**（SPEC-FUJI，`src/clouds/lenticular.glsl.ts`，`handoff/SPEC-FUJI.md`）：
  笠云 / 吊し雲做成 `CLOUD_LENTICULAR` 变体（键 `L`，`wantedKey` 里在 `uLens.w > 0.5` 且无奇观层时加）。①默认程序逐字不变的写法：变体里在 `main` 之前 `#define cloudDensity cloudDensityLens`、`#define layerDensity layerDensityLens`，包装函数内部照常调原函数（宏定义在包装函数之后，不会自递归）；同名函数写两份会被 `check:glsl` 的重名检查报错（它不展开条件编译），换名字 + 宏就没这个问题。验证：`node handoff/SPEC-FUJI-parity.mjs <合并基点的 apps/voyage>`，43 个已有程序预处理后逐字相同。
  ②**不能把透镜云的高度并进 `uShellTop` 让主循环走过去**：透镜云常在几十到一百多公里外，主循环近处 60 m 一步，空走过去就用完 384 步。做法：`lensRayInterval` 单独求包围盒区间，和普通云区间合并，中间的空隙（`lensGap`）在循环开头一步跳过。识别：远处的云「一格一格半透明 / 截出直边」先看是不是步数用完（`builtin: cloud-steps`）。
  ③变体里 `uCoverage = 0`（晴空）时原来的早退要绕开，否则晴天看不到笠云。④受光步进用的全局副产物（`gLensW` / `gLensH01`）会被展开的受光循环覆盖，主采样之后立刻存下来。
  ⑤冻结的同页 A/B（`ab` 冻结截图）对云是瞎的：只改 `weather` 状态的变体（如撤掉透镜云）截图逐位相同，不说明没生效；时间行为用 `live`，代价用 `gpu-ab`（本任务 `handoff/SPEC-FUJI-gpu-jobs.json`，js 变体要自己在每个变体里把状态设回来，ab 不复原 js 改的东西）。

- **远景对流塔层（TW02，`src/clouds/far-towers.ts`，`handoff/TW02.md`）：280 km 外、名额外的积雨云用独立小程序按解析几何画，叠进云步进的 raw**：普通航程看不到高塔的一个原因是体积云只摆 280 km 内 4 个单体、400 km 外不画，而 13 km 砧顶从巡航高度约 776 km 外都在地平线上。现在导演（`WeatherDirector.farTowerCells`）把天气场 760 km 内**没被体积雷暴占用、也没被占用过**的单体交给远景层（170–760 km，相机朝向 ±80°，最多 32 座，不占 `MAX_STORMS`）；远景层在 `clouds.render` 里步进之后、resolve 之前（`clouds.afterMarch`）用 GL 混合叠进 raw：`raw.rgb += raw.a·塔`、`raw.a *= 塔的透射率`，之后的时间累积、窗外合成、山前 / 山后都把它当成 400 km 处的云。没有远塔时整个 pass 不画（raw 逐位不变，`shader-parity` 44 个程序逐字相同），不在启动批次（第一次有远塔时后台编，离线 FXC 约 0.6 s）。
  坑一：**远塔在所有体积云后面**这个前提来自「体积雷暴只在 280 km 内摆、远景层不画被占用的系统」；以后若让体积云画到 400 km 以外的塔，或远景层画 170 km 以内，这个合成顺序就不对了（要改成按 raw 深度前后合成）。280–400 km 的层状云本来会挡在远塔前面、实际在塔后面的那一小段误差（塔脚那几公里）已接受。
  坑二：**看得见多少主要看几何，不是渲染**：巡航 10.7 km 时，550 km 外 14 km 的砧顶和 350 km 外 6.8 km 的浓积云顶几乎在同一条线上（都在水平线下 2.1–2.2°），有云层时 500 km 外的塔基本被地平线附近的云挡住；真正「地平线上一排塔」是 180–450 km 的那些。验收机位别用 500 km 以外的塔找角度（`handoff/TW02-scan.json` 按窗内 180–480 km 的塔数挑日期）。
  坑三：**空气透视把塔身洗掉是物理的**：300 km 外中低层的视线透射率只有 0.1–0.3，背光（朝太阳看）的塔身会接近天空亮度、像半透明；砧在 13–15 km 高，透射高、一直清楚。塔身按「厚云背光面仍有受光面三到四成」包裹光照（`diff` 下限 0.3），再暗就「只剩轮廓、中间透明」。
  坑四：〔已解决，VOY-HKG〕**连续航程 scs 预设的首段航线曾是 HKG → HKG 的圈**，自动驾驶一直压 25° 坡度，窗外只有海：截图 / 验收当时要 `director.setHeading(航向)` 保持航向（`handoff/TW02-accept.json`）。根因是接入航线网时「起点」和「终点」选到了同一个机场，见「地面与数据」一节「接入航线网时，前方没有真正覆盖的机场会选到『起点=终点』同一个机场」，`handoff/VOY-HKG.md`。
  识别：`__voyage.farTowers`（`towers` 这一帧的塔、`active`、`scissor`、`override` 手摆调试塔、`bench(n)` GPU 计时、`enabled` 开关，URL `?fartowers=0`）。

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
- **虹 / 云虹 / 环地平弧的几条（SPEC-BOW）**：
  ① **舷窗视场装不下一整圈虹**：虹半径 42°、云虹约 38°，相机竖直视场才 50°，从巡航高度「整圈都在地平线下」是物理上的全圆，窗里只看得到一段弧；想看到弧，窗的视线要离对日点约 40°（太阳高、在背后），想让宝光与云虹同框要贴窗（`view-preset: close`）、对日点在画面一角。挑时刻别手试：`handoff/SPEC-BOW.md` 里有「扫一天找窗中心离对日点 N° 的时刻」的场景 js。
  ② **雨区从巡航高度要看俯角 ≥ 10° 的**：俯角 5° 的视线落在 100 km 外，雨和虹都被空气光吃掉；演示雨区因此摆在窗下半部的方向。
  ③ **雨幕只能挡它后面的东西**：背景 L 里含相机到地面整段空气的内散射，直接 L·e^(−τ) 会把前面几十公里的蓝色空气光一起吃掉，雨成一块黑斑。要按 `L·Tv + (1 − Tv)·airL`（airL 取空气透视 LUT 到雨的那一段）合成。识别：雨区比周围海面还黑、边缘发蓝。
  ④ **雷暴雨幡从巡航高度大多被自己的塔身挡住**（视线先穿塔底再到雨），雨虹主要落在「阵雨雨区」（浓积云下、光学在 OW 里自己画雨幕）上；雷暴的只剩边上一段，物理如此。
  ⑤ **云虹按单次散射份额算只有 +10%，色调映射后在白云肩部只剩 3–4%，肉眼看不出**：按照片定标 ×2（`CLOUDBOW_GAIN`，估算）。量对比要拿同机位 on / off 两张相除（`shots --pair "v.optics.disabled=true" --pair "v.optics.disabled=false"`），单看一张截图判断不了有没有。
  ⑥ **环地平弧的光铺在几十度宽的方位上**：份额照幻日给 1e-3 时峰值只有幻日的 1/100，看不见；给 1e-2。
  ⑦ **雨的受光别在窗外程序里再调一次 `cloudShadow`**：它是三级 × 4 次取样，FXC 每个调用点整份内联，OW 离线编译多 6%；`opticsRainLit` 只查中间一级一次双线性。
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
- **局部色调映射的低通要有时间常数，并且不能把「近处的机翼」和「远处的城」一起适应**（T48c，`handoff/T48c.md`）：
  现象（T48b 审查 P2-1）：位置灯旁的翼面 15–20 px 处约 12 级暗环；频闪亮起的瞬间翼梢反而变暗、城区灯芯暗约 8 级；夜间闪电照亮的云芯被压最多 62–80 级。
  根因：局部适应按**当帧**的眩光低通算，50–200 ms 的瞬态一亮当帧就把周围压暗；机翼上「自身中等亮、紧挨极亮灯」的翼面被灯的低通压得比远处更暗，出现非单调的环。
  修法：① **闪光按已知事件处理**：main.ts 每帧写 `exposure.flash`（频闪开关、闪电亮度）；只在闪的时候，屏幕 1/16 粗网格的状态才按 τ 0.3 s 慢慢跟，
  扣除量 = 当帧粗格线性亮度 − 闪光前的状态，最终合成用「细低通 − 扣除量」算局部适应，并让这份闪光在像素里的份额不吃局部适应（灯周径向单调）。
  不闪时状态每帧等于当帧、扣除量 0，巡航中与 T48b 逐位相同（冻结 dt = 0 也按收敛）。
  **已推翻**：从画面里「猜」瞬态——整张低通平滑（运动抖动约 1.6 倍）、粗格对数平滑（审查 P1-a 巡航方格斑块、P1-b 灯周暗洞）、线性平滑 + 3×3 最小值 / 成片比值 / 相对跳变 / 邻格规则 / 140 px 区域净变化（返工里又试了五种）。
  巡航中一盏灯跨进粗格的跳变可到 5 倍，城区整体进出画面时一片区域的净变化也长期偏正，和频闪边缘分不开；另外**对数域平滑跟的是几何均值，闪烁的粗格「当帧 − 平滑」长期为正**（算术均值 ≥ 几何均值）。
  闪光期间状态被 τ 冻住，扣除量里会混进这几十毫秒里灯点跨格的运动差（只增不减、又整份不吃局部适应，远处城区按 16 px 方块跟着频闪亮，复审 P1-c）：扣除量再取 3×3 最小值。
  **新增闪烁光源（跑道闪光灯、防撞灯、地面信标）要并进 main.ts 的 `exposure.flash`，否则按 T48b 的即时适应处理；接防撞灯这类长脉冲光源之前，先用 `handoff/T48c-pulse.mjs` 确认 P1-c 在长脉冲下仍达标**（脉冲越长，混进来的运动差越多）。
  「按闪光前的状态适应」本身也不单调：常亮位置灯把自己周围压着，叠上来的闪光在灯旁跟着被压，径向 r 15 → 55 反而上升 15–25 级；所以闪光那一份要不吃局部适应。
  ② 机翼上（TM02 的 `notWing`）只压眩光那一份 + 翼面自身按 `uNightLocal.z = 0.85`。
  坑：**直接「门控乘非机翼」不行**——翼面完全不适应时，灯的眩光在剪影两侧一大一小（光晕在翼缘断开），贴着白灯的翼面出现上千像素的死白块；
  冻结后改云相关状态（闪电亮度）要 `freeze(true, { cloudLive: true })` 渲染几十帧再冻结，并且之后**至少等 ~30 帧再截图**，只等 4 帧截到的是旧画面（两张不同变体逐位相同就是这个信号）。
  识别：`handoff/T48b-ab.mjs` 变体里用 `v.exposure.localDt`（0 = 保持、0.05 + `v.benchFrame(1)` = 模拟 50 ms 瞬态）；飞行中扣除量的实际作用用 `handoff/T48c-live.mjs`（审查脚本改的：飞行中保持 + 冻结 vs 收敛，A − B 应为 0）；
  冻结对照看不到飞行中的状态（冻结即收敛），P1-a 这类问题只有 live 口径量得出。
  测运动抖动的坑：**不要用逐帧截图**——截图让帧间隔忽长忽短（12 ms / 100 ms 混着），带时间常数的一方被不均匀的 dt 额外调制，量出来的「抖动」是假的；
  也不要直接比两段的帧间差：飞机在飞、城区会慢慢移出裁剪，要同一轮里模式轮换配对、先按段去掉二次趋势再比残差。
- **夜里翼尖频闪让整个舷窗爆闪：是眩光把灯芯能量铺满全窗，T48c「闪光份额不吃局部适应」再原样放出来**（STROBE-FLASH，`handoff/STROBE-FLASH.md`）：
  现象（用户报）：夜间每次频闪整窗发白。live 逐帧读回（night-city）：频闪帧整窗均值 +58 级、灯周 250 px 外的远区 +36、灯周 80–250 px +156（纯白一大团）；夜里在云中整窗 +186（纯白），舱内 +7。
  根因（逐项消融）：① `wingLampIntensity` 的频闪朝眼睛按各向同性 1500 cd 画灯芯——照翼面按 W-LAMP 的配光（朝内漏光 0.15），照眼睛却按满光强，自相矛盾；
  ② 灯芯 530 kcd/m² 经 bloom（4% 能量、1/θ² 宽尾巴）铺开，灯周 256 px 处闪光的低通是场景自身的 40 倍，关掉眩光远区 +36 → +2；
  ③ T48c 让闪光那份不吃局部适应，巨大的眩光按原始曝光直出（让它吃即时局部适应能压到 +27，但回到 T48c 要修的「闪时翼梢变暗」）；
  ④ 雾里的单次散射也用朝眼睛的满光强 + 各向同性相函数；⑤ 自动曝光：晴空只抬 0.03 档，**云中每闪一次抬 0.3–0.5 档**，闪完整窗先暗再按 2.5 s 慢慢亮回（1 Hz 呼吸）。窗玻璃 / 舱内反射不是原因。
  修法：频闪按 W-LAMP 的配光（`strobeDistribution`）朝眼睛发光；夜里（太阳 −12° 以下）灯芯按软上限 `STROBE_CORE_CD` 30 cd 画（**显示取舍，不是物理**：灯芯怎样都是纯白，亮度只靠眩光显出来；翼面照度仍按真实光强）；
  雾散射按「沿视线积分 × 云滴前向散射相函数（Schlick，g 0.85）」的闭式解、眼睛一侧只拿朝内漏光；已知闪光期间全局适应不前进（`Exposure.render` 的 dt × (1 − flash)）；
  T48c 粗网格改存闪光**份额**（见下条坑）。整窗跳变 night-city 58 → 12.6、night-city-low 58 → 13、经济舱同 night-city、开灯 8 → 1.1、云中 186 → 95、薄雾 170 → 88（云中不再纯白：灯周一团亮雾、窗边只微亮），全局适应抬升全部 → 0。
  坑一：**频闪压小以后，T48c 在灯周出 16–32 px 的亮方块**（原来被整窗死白盖着）：粗网格存绝对扣除量 T、3×3 取最小值会把 1/r² 光晕的坡削掉一圈，只好给「亮了 6–12 倍」的格开例外，例外格内整份不适应、格外被削——
  改存份额 f = T / 当帧粗格（光晕里处处接近 1、最小值不削峰，删掉例外），最终合成用 f × 细低通。试过 3×3 开运算（腐蚀再膨胀）：坡恢复了，灯所在的例外格仍是方的；
  试过把频闪踢出 `exposure.flash`（按 T48b 即时适应）：没有方块，但近中区「闪时变暗」像素 7 → 40–164。
  坑二：雾散射逐像素只按「灯 → 视线最近点」方向取配光，出十字形亮瓣（配光在水平面附近集中、近竖直时按水平平均，棱角被最近点近似放大）；12 点数值积分平滑，但离线 FXC wing +11%、wing-wet +22%——换成闭式积分、两端 φ 由 x = tanφ 代数算（一次 vec2 atan）后持平。
  识别：`handoff/STROBE-FLASH-live.mjs`（每个 rAF 读回整个画布、按 main.ts 的时序标频闪帧，分区给跳变 / 远区爆闪像素 / 闪时变暗像素 / 非频闪闪烁 / 适应抬升；`shot` 变体冻结后模拟闪光第一帧截图）+ `STROBE-FLASH-table.py`（前后表）。
  **冻结对照看不到这个问题**：冻结时 dt = 0、闪光扣除按收敛处理，频闪钉亮的截图里闪光整份进了局部适应，比飞行中暗得多；要么用 live，要么冻结后 `exposure.localDt = 0` 再钉亮。
- **夜里云中频闪仍是整窗一亮（物理量级如此，压不动），真实航班按 SOP 在云中关防撞频闪**（STROBE-CLOUD，`handoff/STROBE-CLOUD.md`，源于 STROBE-FLASH-review.md §2.3/§3 的建议）：
  main.ts 的翼尖频闪时序上叠一层迟滞状态机（不改着色器）：夜（`sun.altitude < -6`，FAA 14 CFR 1.1 的「夜」定义，晚间民用暮光结束到早晨开始之间——**和 `wing-shading.glsl.ts` 里灯芯软上限用的 `night`（约 −12°→−3° 的平滑）是两回事**，那条是显示取舍不代表真的入夜，这条是行为判据，刻意不复用）
  且在云中（`EXPOSURE_WHITEOUT.value > 0.5`，复用 C02 起给曝光雪景补偿用的「飞机在云里的程度」信号，不新增探测）时关闭 `uStrobe`；连续满足 ≥2.5 s 才关、连续不满足 ≥4 s 才恢复（两个独立的累加计时器，条件一翻转另一边清零）。
  坑：`EXPOSURE_WHITEOUT` 自己已经按 0.5 s 平滑，但那是给曝光的雪景补偿用的（眼睛亮适应量级），不够慢——贴着云边飞时这个信号自己会在 0.5 阈值附近跳，频闪开关必须在它之上再叠一层更慢、且进出不对称的迟滞，否则又造出一个新的闪烁源（这正是本任务要消灭的问题类型）。
  验收：`handoff/STROBE-CLOUD-live.mjs`——直接打补丁摆 `clouds.cameraDensity`（停掉异步 GPU 探针，main.ts 的状态机与 `clouds.keyVisibility()` 照常按真实 dt 跑）量出进云 → 关闭 2.84 s、出云 → 恢复 4.33 s（都在验收区间附近，含信号本身爬升 / 衰减穿过 0.5 阈值的时间）；0.5 s 半周期快速穿云 0 次开关翻转，3 s/3 s 慢速穿云只翻转 1 次且此后保持关闭（出云间隔短于 4 s 迟滞，不足以恢复——设计内行为，不是 bug）；白天 / 云外场景 `strobeCloud.off` 全程为 false，频闪节律逐帧与 main.ts 的时序公式核对一致。
  坑二：这台开发机的 rAF 实测约 130 fps（不是想当然的 60 fps），量秒级延迟的脚本必须按墙钟毫秒数循环，不能按帧数臆测时长，否则窗口被砍到不到一半、量出假的「没恢复」。
  面板没有频闪相关控件，不用按「接管标自动」的规矩改控件；改成在 `#info` 追加一行「频闪：夜间云中自动关闭（按惯例避免反光晃眼，出云后恢复）」，不对用户静默（关闭时才出现，白天 / 云外这行是空字符串，其余信息栏文字逐位不变）。
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
- **云隙光 / 曙暮光条是「从 LUT 的内散射里减掉云影里那一段」，不是往画面上加亮条**（SPEC-RAYS，`src/atmosphere/rays.ts`，`handoff/SPEC-RAYS.md`）：
  现象（改前）：低太阳在积云后面时空气里没有影子——天空视图 / 空气透视 LUT 以相机为中心、只按「相对太阳的方位 × 天顶角 × 距离」存，整条视线都当受光；云影只画在海面上，霾层是一片均匀的橙色辉光。
  做法：独立的三个小 pass（1/4 分辨率步进 → 4×4 盒式模糊 → 全分辨率合成），沿视线在云顶以下的空气里查云影图得到阳光可见度 V，累计被挡掉的单次散射 ΔL，从 hdrOutside 里减掉后写一张新目标，舱内合成改读它（`main.ts` 一行 `u.uOutside.value = rays.render(hdrOutside)`）；
  多次散射不减（影子里的空气仍被天光照着），所以暗条偏灰蓝——真实照片里暗的曙暮光条就是蓝灰色的。不画时（夜里主光源是月亮、太阳 < −4°、没有云、云影图没建好、程序没编好）返回原 hdrOutside，逐位不变。
  坑一（紫点）：第一版逐通道 `max(src − ΔL, 5%·src)`：夕阳下 ΔL 偏红，红通道先触底、蓝通道照减，海浪暗像素被染成一粒粒紫色、地平线一条紫线。改成三通道共用一个缩放 k（最多减掉 90%）。
  坑二（冻结对照里「整窗发蓝」是假象）：`shots --pair` / `ab` 冻结后曝光与**舱内色适应**停在 A 变体，B 变体减掉暖色霾辉光后被按 A 的白平衡显示，看起来是一片饱和的紫蓝海。判颜色要用不冻结的两次 `shots`（`--query rays=0` 对照），判逐位零回归才用冻结对照。
  坑三：云影图只存 0 / 1 / 2 / 3 km 起点的透射率，3 km 以上的点按 3 km 取、在云底—云顶之间渐变回 1；浓积云（1.4–6.5 km）云层内部的空气误差最大，云层以下（光条主要在这里）是准的。
  坑四（诊断时读回的坐标系）：`probe.mjs --read` 的 x / y 直接交给 `readRenderTargetPixels`，是 **GL 左下原点**、rows 自下而上，不是它文件头注释说的左上原点——按屏幕坐标给 y 读到的是上下镜像的位置，把「天空 / 海面」读反（本任务误判过一次「海面受光但空气在影里」）。
  坑五（地形，审查 P1）：第一版步进终点是海平面球面，视线打到近处草地 / 山体后还一路走到海平面，把地面背后本没画进画面的空气也当成云影减掉（被 90% 上限兜着，看起来像「更通透」）：火车大糸线 17:30 前景草地发深绿、平均暗 14.5 级、最多 88 级。
  修法：低于 `uTerrainMax` 的步点查一次 `groundHeightAt`（窗外求交同一个高度场），落到地面以下就停。复测前景草地 ≤ 2 级（随距离增到 −2，是真实的云影空气），山脊线 1/4 分辨率 + 4×4 模糊看不出光晕。
  识别：近处地面开 / 关差超过 1–2 级就是减错了——近处只有几百米空气，没有那么多内散射可减。
  没管到：奇观（浮空城、建木、天梯）和远处飞机这类不透明物体后面的空气同样会被减（步进不知道它们），实测城体 / 机体上看不出，先不管；以后新增近处的大块不透明物体要让步进认得它。
  淡入：从不画到画（编译完成那一帧、云覆盖率从 0 变正、云影图刚建好）时 ΔL 在 0.5 s 内按挂钟从 0 升到 1（`rays.fade`），整窗不跳；冻结对照要等 0.5 s 以上再拍。
  显存：`rays.target` 是全分辨率 RGBA32F（与 hdrOutside 同类型，太阳辐亮度要 32 位），3840×1950 下约 120 MB；第 60 帧起编译时就分配，不分昼夜常驻。步进 / 模糊两张 1/4 分辨率半精度目标可忽略。
  识别：`__voyage.rays`（`enabled` 开关、`active` 这一帧画没画、`state` 编译状态、`downscale` 步进目标缩小倍数、`await rays.bench(__voyage.hdrOutside, 20, "all"|"march"|"blur"|"composite")` GPU 计时）；URL `?rays=0` 整个关掉。

<a id="pit-ground"></a>
### 地面与数据

- **加速播放（连续航程 60×）会把影像瓦片服务器打到限流**（T19a）：飞机每秒走 15 km，8–32 km 的细级别 clipmap 每一两帧就重建，EOX 每分钟约 7000 个请求，被拒时返回的错误页不带 CORS 头，控制台刷出上万条 `blocked by CORS policy`（看起来像 CORS 配置错误，其实是限流）。只给 `ground.update` 加时间节流没用：请求量约正比于「飞过的距离 × 细级别数」。
  修法：`ground.setMinLevel()` 按流速停用最细几级（10× 停 1 级，≥30× 停 3 级），60× 降到每分钟约 550 个，1× 基线约 95。以后怎么识别：`handoff/T19a-voyage.mjs` 的 summary 里有 `requestsPerRealMin` 和 `consoleErrorCount`。
- **连续航程不调 `setPreset`**（T19a）：接下一段只换 `state.preset`（导航目标、时区、霾），不换本地坐标原点，否则地面、云场都会重建。离原点太远时由导演借穿云或深夜「换原点」（`director.ts` 的 rebase 请求），经纬度、高度、航向都连续，只有云场和海浪的噪声原点会跳一下。
- **时间加速时「原地掉头、坡度一帧打满」**（T49，用户反馈「有时飞机会大幅转向倾斜，不知道怎么触发」）：现象是连续航程 10× / 60× 到达终点接下一段时，飞机在 2–3 真实秒内掉头 100–170°、坡度一帧到 25°。根因两条：①转弯与坡度平滑都按**模拟**时间算（ω = g·tanφ / v、坡度时间常数 1.4 模拟秒），60× 下航向变化率 63°/真实秒、滚转速率 500–760°/真实秒；②`pickNextLeg` 不看方向，接力时 71% 的下一段要转 > 90°（航线网是放射状的，到了新千岁 / 那霸 / 广州这种端点只能掉头）。修法（flight.ts 自动驾驶 + director.ts）：坡度按**真实时间**以 ≤ 3°/s 趋近目标坡度，时间加速时按「窗外转动 ≤ 6°/真实秒」降低坡度上限（10× 约 15°、60× 约 2.5°，转弯半径相应变大）；航向由实际坡度按协调转弯算，不再直接设角速度；接力优先挑与到达航向夹角 ≤ 90° 的下一段（离终点 400 km 预挑），按转弯半径提前开始转；只能掉头且时间加速（10× / 60×）时机翼改平直飞，等穿云（在云里直接换向）或入夜，最多等 8 模拟分钟或 45 真实秒再照常转；1× 直接照常转（25° 坡度约 3 分钟掉头）。**等待时限只能用导演自己累加的时钟**（审查 P1）：不开连续航程时 `state.simTime` 只随「时间流速」走（默认暂停），拖时间滑块还会倒退，拿它当时钟会让排队永远不放行、飞机一直直飞（`T49-test.mts` 第 9 项）。以后怎么识别：`handoff/T49-sim.mts 60 20` 列出的 > 60° 转向事件时长应在十几到几十真实秒、最大滚转速率 3°/s；`handoff/T49-test.mts` 全部通过。
- **时间加速下转弯半径很大，目的地又近时会绕着它转圈**（T49）：60× 巡航时转弯半径约 170 km，直飞一个 100 km 外、在身后的机场时，一直压坡度会让机场始终落在转弯圆里。`navDiff()` 在「终点落在转弯圆内」（距离 < 2r·sin|Δ|）时先改平直飞出去，再转回来。改转弯参数时跑 `T49-test.mts` 第 6 项（直飞伊丹后盘旋）。
- **接入航线网时，前方没有真正覆盖的机场会选到「起点 = 终点」同一个机场**（VOY-HKG，`src/routes.ts` 的 `airportAhead`、`src/director.ts` 的 `joinNetwork`）：
  现象：连续航程（`voyage=1`）下南海预设（scs）的首段是「HKG → HKG」——自动驾驶要把航向从场景设定的 225°（西南）转到 HKG 实际方位角（约 344°，接近正北），一个 119° 的大弯，一直压着接近最大坡度好几十秒回不了平，窗外只有海看不到东西（`handoff/TW02.md` 最先报告，当时靠手动 `setHeading` 绕过）。
  根因：`joinNetwork()` 先用 `nearestAirport()` 挑「离当前位置最近的机场」当 `makeLeg` 的占位起点 `here`，再用 `airportAhead()` 挑「机头前方的机场」当终点 `to`；`airportAhead` 不是按「是否真在机头前方」硬性筛选，而是按 `距离 × (1 + 转角 / 45)` 打分取最小的——航线网只覆盖东亚，南海预设朝西南飞出这个覆盖范围后，最近的机场（HKG）同时也是打分最低的候选（转角再大也架不住距离最小），`here` 和 `to` 选到了同一个机场。此时 `leg.distKm` 按当前位置真实算出一个非零值，`leg.bearing` 却是 `makeLeg(HKG, HKG)`（同点求方位角）的退化值 0——一段自相矛盾的航段。排查全部预设：`yangtze`（长江，SHA→SHA）也中招，只是转角恰好只有 1.2°、几乎感觉不到；`wpac` / `ecs` / `fuji` 因为航线网在它们的场景航向方向上确实有别的机场，没有「起终点相同」这一层问题（但 `wpac` 首段本来就要转 140°，VOY-DEFAULT 已经用「机头直接对准」修过一次）。
  修法：`nearestAirport` / `airportAhead` 都加一个 `excludeCode` 参数；`joinNetwork()` 用 `here.code` 排除，保证 `here !== to` 恒成立（南海预设排除 HKG 后选到广州白云 CAN，长江预设排除虹桥后选到浦东）。排除同名机场只解决了「起终点相同」，没解决「转弯角度可能仍然很大」——`joinNetwork()` 因此也补了 VOY-DEFAULT 那次同款处理：接入航线网时（`setActive(true, jump)` 的 `jump=true`、`onPresetChanged()` 换到非航线预设且连续航程已开着、`resumeRoute()` 没有缓存航段这三条路径）机头直接对准新航段、`bankDeg` 归零，不借自动驾驶去转；用户手动勾选开启连续航程（`jump=false`）时仍保留旧行为，照常转、不跳。
  以后怎么识别：`pnpm check-routes`（`scripts/check-routes.mts`，离线、不开浏览器）复现每个预设首段的实际选取并断言 `from !== to`；新增预设或改 `airportAhead` 评分逻辑时先跑一遍。验收细节见 `handoff/VOY-HKG.md`。
- **海面天空反射不能再乘相机→海面的透射率**。天空视图 LUT 是从相机算的，本身已经包含这段衰减。
  现象：黄昏时地平线下方有一条细暗线。起初以为是 LUT 在地平线处跨行插值，改了夹取以后暗线还在，才找到真正原因。
  修法：反射贡献 = F·(L相机(反射方向) − 内散射(相机→海面))。LUT 的地平线夹取也保留了，它本身没错。
  **这个近似在「相机在霾顶之上、水面在霾里」时失效**（SEA-3，`handoff/SEA-3.md`）：它默认水面往反射方向看到的天空 ≈ 相机往同一方向看到的天空。低空（1.5–2.6 km，霾顶 1.1–1.8 km）掠射时水面实际反射的是一整段霾，公式却给了霾顶之上的亮天空，地平线下一两个像素海面就比上方的暗带（视线擦过霾层，天空视图 LUT 算得没错，逐像素积分真值与 LUT 差 0.07 级）亮 15 级——美术 wave7 / wave8 的「低空海天暗墙」。修法（已落地，`outside-pass.ts`）：按水面处往反射方向到大气顶的透射率 tUp，在原公式与「相机看反射方位几何地平线处的天空」skyHz（天空视图 LUT 天空侧最后一行 + 月光 + 气辉）之间混合。**已推翻的第一版**：饱和源用 apT·apL/(1−apT)（开阔海面 tView·内散射/(1−tView)）——空气透视 LUT 与天空视图 LUT 地面侧都只有太阳一路，夜里 ≈ 0，远海反射整片归零、地平线下一行掉成纯黑（审查 P0，night-sea-milkyway）。以后给「反射 / 散射的源」挑 LUT 时先确认它含不含月光与气辉，夜景（无月 + 满月）必测。另：`skyRadiance` 在窗外程序里多一个调用点离线 FXC 就 +10–12%，放进 `uLoopGuard` 循环共用调用点又编不过（分支内循环里的隐式导数取样），同方位只换行时直接按列坐标 `textureLod` 取。识别：分量拆开看，硬边以下海面多出来的亮度全在反射项；`tintGround` 类染色变体先确认像素走哪条路径。
- **窗外 / 云程序里调 `integrateSegment` 当「真值」时没有边界层霾**（SEA-3）：`uHaze / uHazeShape` 只挂在 LUT 材质上，其他程序虽然声明了（`ATMOSPHERE_COMMON`）但值是默认 0。诊断变体要先把 `__voyage.atmosphere.hazeUniforms` 的两个对象挂进目标材质的 uniforms，否则真值是无霾大气、结论全错（SEA-3 第一轮就这样误判过）。识别：逐像素积分变体与 cur 整体亮度 / 饱和度差很多。
- **真实地面路径上的远海有约 39 行一条的等距横纹，来源是空气透视 3D LUT 的插值，不是海浪**（SEA-3，美术 wave7 / wave8 第 12 条）：去风痕 / 阵风斑 / 换水色 / 换粗糙度都不变，空气透视改逐像素积分（24 步即可）横纹消失，LUT 积分步数 24 → 64 不变，距离轴改「均匀介质段」插值（透射率对数线性）也不变。真正的根因在天顶角方向：LUT 每一行在**同一距离**上取值，陡的那一行积分早已截在海面，平的那一行还在半空少穿一截霾，两行线性混合就是每行一条折线（加密行数只会让折线变密，不是分辨率问题；最初「霾顶附近分辨率不够」的判断已推翻）。修法（已落地，`terrain-shading.glsl.ts` `groundHit`）：天顶角方向手动两行插值，每行取「到它自己那条视线的海平面交点的同一比例」处，LUT 本身不变；横纹指标与逐像素积分真值相同。开阔海面（不走 AP LUT）没有这个问题。以后在地面命中点上取任何「按方向 × 距离」参数化的 LUT，都要想一下相邻方向在同一距离上是不是已经钻到地下了。识别：`handoff/SEA-3-stripes.py`（逐行残差 RMS + 自相关周期，横 / 纵比 > 5 就是横纹）。
- **半透明的远处物体按「背景 × T + 自身光」合成时，要把挡掉的前景内散射补回来**（SEA-3，暗色尾迹）：背景辐亮度已含相机到无穷远的整段内散射，乘物体透射率会把「相机到物体」那段也挡掉。航迹云因此在正午侧光下比天空暗 3–4 级（逆光时自身够亮看不出）。正确合成：`背景·e^−τ + apL(相机→物体)·(1 − e^−τ) + apT·自身光`；已落地（`traffic.glsl.ts` 一行）。以后加任何远处半透明物（雨幡、烟、奇观薄雾）照此办理。识别：侧光下远处薄物体发暗、发灰。
- **低空时耀斑侧面有一道「竖直断层」，不是 bug**：那是耀斑波瓣的边缘。耀斑中心过曝，又是平滑的高斯分布，所以边界显得锐利；换风速后边界会跟着移动。
  排查时先后怀疑过风痕（确实太陡，已经放软）、闪烁、云影，用 `uDebug` 5–10 逐项排除后才确认。以后判断方法：改风速，看边界是否移动。
- **耀斑闪点不能照泊松抽成「全黑 / 亮 1/λ 倍」两值**（WX11g-b，ART-8 #4）：现象是低风速（0–3 m/s）耀斑两侧和近处成千上万个孤立的单像素亮点 / 黑点（椒盐），飞行中逐帧跳；大风时耀斑外缘同样是一片闪烁的碎点。根因：`oceanRadiance` 的闪点项把「像素里闪点数 N ~ 泊松(λ)」直接抽样，λ < 1 时像素要么全黑、要么亮 1/pHit 倍，一个闪点的亮度 ∝ 1/(σ²·足迹面积)，σ² 小（低风速）、足迹小（近处）时点点过曝；随机数每 1/8 s 硬换一次，格子只有 1–2 个像素大，飞机一动像素就换格子。粗糙度本身没错（σ² 已含 LEAN 过滤掉的方差 + Cox–Munk 毛细波），错在分布。
  修法：相对起伏改成 0.5·√λ/(1+λ)、均值 1 的连续随机数（λ → 0 回到连续的期望亮度，λ ≫ 1 时 ∝ 1/√λ），期望逐像素不变；两个时隙的随机数 smoothstep 过渡并按 √(w₀²+w₁²) 归一化（约 6 Hz），不再硬跳。实测（`handoff/WX11g-b.md`）：1.5 m/s 孤立亮点 632 → 9、飞行中闪烁像素 61278 → 2541–6402；14 m/s 闪烁像素 130389 → 647–1490，耀斑区平均亮度 +0.2–5%（原来闪点过曝被夹掉的能量回来了），非海面逐位 0。代价：大风时耀斑外缘从「黑底上的稀疏亮点」变成连续的暗金色，碎金质感只剩可分辨的 FFT 波面给的那部分。
  识别：同页 `ab` 对照（`handoff/WX11g-b-mkjobs.py` 生成的 jobs，old 变体把闪点段换回改前原文）+ `handoff/WX11g-b-metrics.py`（孤立亮 / 暗点、单像素死白块、非海面逐位差）；飞行中用 `ab` 的 `job.live`。**低空（< 4 km）画的是低空细节变体，换 `outsideMat` 碰不到**：job 的 `pre` 把 `groundDetail` 实际画的材质挂到 `__voyage.__outCur` 再 patch 它（见 mkjobs 的 `PRE`）。以后再往耀斑里加随机项，先问「λ < 1 时它会不会造出孤立的单像素点」。
- **海平面近处求交**：从 r≈6360 km 出发的通用球面求交在近处有约半米误差，会让海浪纹理出现与视角相关的颗粒噪点；`oceanRadiance` 里用 t = c / (−b + √(b²−c)) 重算。
- **海浪频谱不能在主线程随风速重算**（WX11g）：`buildSpectrum` 实测每次 20–40 ms（Node 与页面同量级，旧注释写的「十几毫秒」偏乐观），风速一变就同步重算、必掉帧；风速连续变化（连续航程按天气场写 `state.wind`）时每帧都会重算。
  修法（`ocean/waves.ts`）：频谱只在 `WIND_LEVELS`（0 / 1.5 / 3 / 5 / 7 / 10 / 13.5 / 17.5 / 22 m/s，一档约一个蒲福风级，7 必须是一档——面板默认值，默认场景逐位不变）上算，在 `ocean/spectrum.worker.ts` 里做，两侧各预取一档；风速在两档之间时相位推进 pass 按比例混合两档的 h0（`uH0` / `uH0b` / `uMix`，同一组高斯随机数，振幅线性混合，海况连续过渡），所以风速可以每帧连续写、不量化不限频；缺档时这一帧海况保持原样（`stats.holds`），只有启动第一帧同步算。方差按「标准差线性混合」估算、白浪阈值按实际风速的 Monahan 覆盖率连续算。
  识别：`__voyage.ocean.stats`（`wind` 实际用到的风速、`level` = [下档, 上档, 混合比]、`buildMs` / `syncBuildMs` / `uploadMs` / `builds` / `holds`）；主线程长帧用 `handoff/WX11g-hitch.mjs`（跳档 + 连续扫风速，记录每次 `ocean.update` 耗时与帧间隔，`--port2` 可对照改前）。
- **着色器里不能写「速度 × 时间」当漂移**（WX11g）：`gustFactor` 原来用 `uWind * uTime` 算阵风斑的漂移，`uTime` 是页面运行的秒数，风速一变整片阵风斑瞬移 Δ风速 × 运行秒数（运行 10 分钟后差 1 m/s 就跳 0.6 km），风速连续变化时则整片以「运行秒数 × 风速变化率」的假速度滑动。修法：漂移距离在 CPU 上逐段积分（`waves.ts` 的 `updateDrift`，放在 `uOceanFoam.z`），风速恒定时与原来的 `uWind·uTime` 至多差 1 ulp（CPU 双精度算完再转 float32，原来是着色器里 float32 相乘；耀斑闪烁格子边上可能翻转几个像素）。以后凡是随参数变化的量驱动的平移（云平流、航迹云漂移……）都要积分位移，不要写 `t × v`。识别：冻结后只改 `state.wind`，海面阵风斑 / 耀斑纹路不应当整体挪动。
- **海面风速由导演按天气场写**（WX11g；面板显示已修，UX-2）：连续航程开着时，`weather-director.ts` 每次取样取天气场的地面 10 m 风 `windSpeed(profile.sfc)`（weather.ts 已按周围海陆比例插值 z₀；审查 D1：第一版在近岸 / 陆地格点改套开阔海面的 Charnock 推导，骏河湾 1 月中位 13.8 m/s 偏高，已推翻），以 ≤ 4 m/s / 模拟小时限速逼近、写进 `state.wind`；换预设（jump）直接对齐。〔已解决，UX-2〕当时面板风速滑条的显示不会跟着变（`ui.ts` 只在拖动时写），停在上次手动 / 默认值，和 `state.wind` 的实际值对不上（WX11g 交接原话「要显示可以在 ui 的 sync 里读 state.wind」）；连续航程开着时云量 / 云底 / 云厚同样只停在旧值。修法：`ui.ts` 的 `setupWeatherAutoSync` 每 250 ms 从 `cloudUniforms` / `state.wind` 回写这四个滑条的 value 与 output 文字（不派发事件，拖动 / 聚焦中的控件不抢），标签旁标「自动」；天气系统 / 云型下拉在接管时锁定（disabled + title 写原因），不强行同步一个不存在的单一预设值。连续航程关着（回归场景默认）时这些控件仍是普通的面板值，行为不变。
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
- **Worker 里对 GPU 画布 / GPU 位图的读回会让主线程掉帧：1× 巡航偶发 23–47 ms 帧的真正来源**（G07b 查清，G06 起就有）：G06 / G07 审查怀疑过整组 generateMipmap、暂存上传、mip 临时缓冲的 GC，都不对。给 Worker 每次任务记精确起止与分阶段时刻（`imageryStats.worker.recent[].marks`：read / water / waterRead / detail / night / roads / mips）后，同页交替 16 分钟里 26 个尖峰有 23 个落在两段**GPU 读回**里：`readBitmap`（主线程 GPU 画布拼好的影像位图 `drawImage` 到 CPU 画布再 `getImageData`，尖峰只出现在这一步比平时慢一倍的那几次，读 51–63 ms 对中位 24 ms）和水体画布的 `getImageData`（默认 2D 画布是 GPU 加速的）。GPU 进程同步读回 16 MB 期间，页面的合成 / WebGL 命令排在后面，主线程帧跟着卡 3–5 个 vsync。mip 阶段、上传帧、背靠背任务都没有尖峰。修法：水体画布 `getContext("2d", { willReadFrequently: true })` 走 CPU 栅格（多约 5 ms，在 Worker 里），waterRead 阶段的尖峰归零；影像画布同样改 CPU 会把代价搬到主线程（每次建级约 59 ms 长任务），已否决（`ground.imageryCanvasCpu` 留作对照）。剩下的 read 阶段尖峰要根治得把瓦片拼接整个挪进 Worker（把瓦片 ImageBitmap 克隆过去在 CPU 画布上画），见 `handoff/G07b.md`。（2026-09-28 G08-STITCH 已做，见下面「影像瓦片拼接挪进 Worker」一条。）以后凡是 Worker / 主线程里对 2048² 画布 `getImageData`，先问一句这张画布是不是 GPU 的。识别：`node handoff/G07b-spikes.mjs <端口> 60 4 G07b,cpuWater`（每个尖峰标出落在哪个阶段；`ground.waterCanvasCpu = false` 退回旧做法）。
- **影像瓦片拼接挪进 Worker：主线程只取 Blob，拼接 Worker 在 CPU 画布上解码 + 拼 + 读回**（G08-STITCH，接上一条）：G07b 查出 1× 巡航剩下的尖峰落在合成 Worker 读回主线程 GPU 画布拼好的位图（read 段）。现在 `buildImagery` / `buildDetail` 只取 JPEG Blob（`tiles.ts` 的 `loadImageryBlob`，缓存 Blob，Blob 发给 Worker 只是引用复制），连同每张瓦片的画布矩形发给**单独的**拼接 Worker（`tile-compose.worker.ts`：`createImageBitmap(blob)` 解码成软件位图、按地址缓存 1200 张、`willReadFrequently` 的 CPU 画布拼、`getImageData` 只是内存拷贝），像素转回主线程再转给合成 Worker。主线程不再持有 GPU 画布、没有任何同步读回。同页交替各 20 分钟（`handoff/G08-spikes.mjs`，持锁）：> 16.7 ms 帧 G07b 63 个（3.1 / 分，47 个落在 read 段）→ G08 1 个（0.05 / 分，落在任务外），主线程长任务两边都是 0。
  坑一：**拼接不能放进合成 Worker 里串着做**——CPU 拼一级 2048² 要 40–100 ms，合成 Worker 是串行的，首载 7 级排队，粗版就位慢约 0.5 s（fuji-day 7.8 → 8.4 s）；单独一个拼接 Worker 与合成 Worker 并行后首载与 master 持平（`handoff/G08-load.mjs`）。
  坑二：**Worker 的 onmessage 写成 async 后，里面抛的异常不会触发 Worker 的 `error` 事件**（变成未处理的 Promise 拒绝），主线程永远等不到回复、这一级永远 building。两个 Worker 都 try/catch 后回 `{ id, error }`，主线程停用该 Worker 走回退：拼接 Worker 停用 → 合成 Worker 自己拼（同一份 `composeTiles`）；合成 Worker 也停用 → 主线程算（没有 OffscreenCanvas 时用 `<canvas>`，Safari 16.4 以前；功能对；G08 审查复现首载到 warmup 完成 24.2 s，与正常相近，代价在巡航：1× 每分钟约 26 帧超过 16.7 ms，不需要提示用户）。Worker 里 OffscreenCanvas 2D 要 Chrome 69 / Firefox 105 / Safari 16.4 起。测回退：`G08_NOWORKER=stitch|all node handoff/G08-diag.mjs <端口>`。
  坑三：**解码缓存换出时 close() 位图，任务必须串行**：解码是异步的，两个任务交错时后一个的换出会关掉前一个还没画的位图（drawImage 抛 InvalidStateError）。Worker 里用 Promise 链串行，缓存容量要大于一轮全部级别的瓦片数（约 900–1100），否则按级轮转访问整轮不命中。
  识别：`__voyage.ground.imageryStats.stitch`（拼接任务的起止 / `eoxDecode` / `eoxStitch` 时刻、解码 / 命中数、`queued` 在途数、`aa` 见下条）与 `.worker.queued`；`ground.imageryInWorker = false` 退回 G07b 做法同页对照（改后 `rebuildAll()`）。60× 加速航程两边在途任务都 ≤ 3（拼接 ≤ 1）、不积压（`handoff/G08-stream60.mjs`）。
- **CPU 画布画位图时边上不做抗锯齿，旧的瓦片矩形在东西相邻的瓦片之间留出整像素透明的缝 → 沿经线一条暗细线**（G08 发现）：瓦片画成轴对齐的矩形，G07b 以前左边按上沿纬度、右边按下沿纬度换算（本地坐标按各自纬度的 cos 换算经度），相邻两张在共用的经线上差 |x|·sinφ·Δφ，原点以西是缝、以东是重叠（第 3 级离原点 30 km 约 0.7 像素，航线上离原点几百公里时几个像素）。GPU 画布给边缘做覆盖率抗锯齿，缝被半透明地糊住（影像 A < 1，着色器只部分回退）；Chrome 的 CPU 画布对轴对齐 drawImage **不**抗锯齿（`handoff/G08-seam.mjs` 实测：GPU 画布接缝 A = 158–183，CPU 画布 255 或 0），缝里的像素整个透明，着色器整条回退到粗一级，fuji-day 同页最大差 26、放大一眼可见。修法：`tileRect` 左右边都按这一行瓦片的中间纬度算，同一行严格对接（上下行本来就共用纬线），矩形角点的最大位置误差也减半（`ground.tileEdgeShared = false` 对照）。代价：影像在离原点远的级别上挪了零点几到几个像素，夜里灯点跟着影像换一版（同页 route-hnd-cts-night 平均差 0.58、p99 8.3，白天平均差 ≤ 0.03），属于有意的一次性修正。别的浏览器若 CPU 画布做了边缘抗锯齿（启动时探测一次，`imageryStats.stitch.aa`），`drawTileCrisp` 改走「整像素裁剪 + 外扩 1 像素垫底 + 正片」，接缝仍是 A = 1。以后凡是把瓦片拼到画布上，先确认相邻瓦片的矩形在浮点上**完全相同**，别指望抗锯齿糊缝。
  G08c 补：**地形高度图（256²、最近邻）和夜光（1024²）当初漏改，仍用旧矩形**（G08 审查 M2）。它们一直在主线程的 CPU 画布上拼，原点以西每条瓦片竖缝都是整列底色：地形是 0 m 深沟（fuji 以西 112 km、1.2 km 低空实测 L0–L5 每级一条，L0 约 125 m 宽、两侧山地 590–740 m，飞机在缝上时 `heightAt` 返回 0，离地高度 / 云底下限等 CPU 逻辑都会用到），夜光是黑的无灯带（离线算 hnd-cts 以西 100 km 的 L0 约 180 列 ≈ 1.4 km）。修法：`buildHeight` / `buildNight` 也走 `tileRect`（开关 `ground.demNightEdgeShared`，false = 旧矩形，改后 `rebuildAll()`）。识别：`node handoff/G08c-rect.mjs`（纯离线，3 个预设 × 5 个位置 × 7 级，影像 / 地形 / 夜光新旧缝宽都列出，新算法应全为 0）；`node handoff/G08c-seam.mjs <端口>`（场景 `fuji-west-seam-low` / `night-city-low-west`，同页新旧切换，扫 `heightCpu` 竖缝、`heightAt` 剖面、各级夜光画布的整列黑带）。以后新增任何「瓦片 → 画布」的拼接，一律调 `tileRect`，不要自己按两个角点算矩形。
- **GPU 探测的临时上下文会被 dev-browser 的 GPU 计时钩子抓走 → `bench` 的 gpu 列静默消失**（G07 引入，G07b 发现并修）：`dev-browser.mjs` 的 `installGlProbe` 在 `HTMLCanvasElement.getContext` 上挂钩子，把页面里**第一个** webgl2 上下文存成 `window.__glProbe` 做 timer query；G07 的地面精度探测在模块加载时用 `<canvas>` 开了第一个 webgl2 上下文、读完就 `loseContext()`，钩子抓到的是这个已丢失的上下文，`gpuTimedFrame` 拿不到扩展、按设计静默返回 null，`bench` 输出里的 `gpu=` 那一段就没了（不报错）。修法：探测优先用 `OffscreenCanvas`（钩子不管它），不支持 OffscreenCanvas WebGL2 的浏览器才退回 `<canvas>`。以后任何在主渲染器之前开的临时 WebGL 上下文都照此办理。识别：`node scripts/dev-browser.mjs bench --port <端口> --only noon-cumulus --rounds 2` 的输出行应带 `gpu=`。
- **GPU 探测要和主渲染器同一个 `powerPreference`**（G07 审查 L2，G07b 修）：双显卡 Mac 上默认值会拿到 Intel 核显、判成 1024，而主渲染器是 `high-performance` 的独显。临时上下文在 `finally` 里 `loseContext()`，读参数中途抛异常也释放。
- **直传 GL 要在第一次渲染之前就拿到纹理对象**（G07）：three 要到这张纹理第一次被渲染用到才 `texStorage3D`，而首载的几层常在窗外程序编完之前就建好，那时只能退回 three 整组上传 + 整组 generateMipmap。`attachGl(renderer)` 里直接 `renderer.initTexture()` 让它立即分配（对全 0 内容做唯一一次整组 generateMipmap）。
- **跨版本比地面截图时，先确认两边的 `ground.pending` 都归零了**（G07）：EOX 限流严重的时段，master 在 fuji 低空 / night-city 首载后 120 s 里 `pending` 一直是 26–160（失败的瓦片随每次重建重试），近处退到粗级、夜里灯点成团——和「新版本变了」看起来一模一样。强制全部重建后 master 的画面与 G07 一致（`handoff/G07-rebuild-check.mjs`）。判零回归用同页 A/B（`handoff/G07-pair.mjs`，同一页面切换做法后原地重建全部级别），噪声底 0。
- **冻结后地面还在换版：`pending === 0` 不等于地面到位**（G-FREEZE）：现象是同页冻结、设置完全相同的两张截图地面来回变（T48c：night-city-low 差约 20 万像素；W-LAMP：night-city-off 噪声底 1.7 万–15 万像素）。根因不是冻结漏了什么（冻结期间 clipmap 按固定机位不会换级，也没有 LRU 换出重建、夜光随机相位），而是**等待判据太松**：`pending` 只数瓦片请求，瓦片取齐后还要拼接 Worker + 合成 Worker（2048² 每级 0.3–0.7 s，串行）+ 暂存上传，7 级排完要几秒；applyScene 最后才摆 `offset`，pinGeometry 又把飞机拉回原位，各级正在按新机位重建。ab 以前「冻结 → pending 归零 → 再等 2 s」，实测（`handoff/G-FREEZE-diag.mjs`）night-city-off 那一刻还有 3 级在建、2 个合成任务在途，t+1 s 又换上一级、整窗哈希变了；之后 30 s 逐秒哈希不变。1 km 低空差得多，是因为最后换上的是占满视野的 L0 / L1。
  修法：`ground.unsettled()`（`settled`）给出「再怎么渲染也不会换版」的判据——pending 0、上传队列空、拼接 / 合成 Worker 无在途、minLevel 起每级 valid 不在建，且按上一次 update 的机位 update 不会再重建（中心 / 高清细节 / fine 都已是想要的那一版）；`ground.uploads` 是换版计数（每换上一级 +1）。`scripts/lib/ab-live.mjs` 的 `groundSettle` 要求**连续 10 帧** unsettled 为 null 且 uploads 不变（只轮询状态会在「刚钉回机位还没跑一帧」「一级刚换上、下一帧才因 fine / 细节不符重建」的帧间隙误判）；ab / gpu-ab / flight 冻结后、`shots --freeze|--pair`、`flicker` 带地面的场景冻结后都等它；ab 每张图记 `groundUploads`，与稳定时的基线不同就标作废（`groundChanged`）。修后 night-city-low / night-city-off / fuji-day / route-hnd-cts-night 同代码 3 轮 6 张逐位 0。正常飞行不受影响（update 的重建条件只是抽成函数，逻辑不变）。
  识别：同一变体两轮不为 0 且差异集中在地面，先看 JSON 里的 `groundUploads` 是否各张不同；`__voyage.ground.levelState`（各级 cx/cz/valid/building/fine、在途任务、`unsettled` 原因），`ground.events = []` 打开构建 / 换上事件记录。以后给地面加任何异步阶段（新 Worker、新上传方式），都要让它计入 `unsettled()`。

<a id="pit-cabin"></a>
### 舱内与倒影

- **窗上的水要做成「折射」，不能画成线和圈**（T29）：旧版把水线画成深色细线加头上一个圆、水珠只剩一圈暗环，在亮背景前读成铅笔线、钉头和空心圆圈。
  现在 `waterOnPane` 只给水面坡度 / 覆盖率 / 暗边，`scene.ts` 按坡度偏折视线、`texelFetch` 偏移后的 `uOutside`，暗边只在下缘（月牙）。
  坑一：按真实折射率算，偏折是几十度 = 上百像素，点采样会在水珠里画出放射状条纹（像图钉），还读到窗板开口以外（那里 alpha = 0，黑）；`WATER_DEFLECT` 因此缩到物理值的约 1/10，开口外的样本退回不偏折。
  坑二：整圈暗环 = 空心圆圈；均匀的雾里折射前后一样，暗环是唯一可见的东西，必须弱且只留下缘。
  另：湿度按 ISA 气温门限（`flight.ts` 的 `outsideAirTempC`），高于约 4.6 km（ISA −15°C）不再挂水，已有的水按升华 / 吹干消退。
- **舱内只建了侧壁（沿机身无限长）、本排与前一排座椅**（FOCUS-ZOOM 追加）：头前伸贴窗再往两侧挪（相机总看向窗板中心，于是斜着沿舱壁看），视锥边上的视线平行 / 背离侧壁时什么都打不到——纯黑（`rd.z < 1e-4` 一支）；再斜一点是消失点附近无限重复的窗；往下看更远处是「该有座椅却只有光秃侧壁」的空白舱。修法不在着色器补模型，而在相机上限位（`src/head-limits.ts`，每帧按前伸、高度、视场、画面宽高比、座位、舱等求头部 x 两侧的上限）：① 视线必须打到侧壁，且打到的点沿机身方向离眼睛不超过「眼睛所在深度处、与侧壁成 12° 的水平视线」的落点（消失点只在沿机身方向；上下方向侧壁弯回来，俯仰不受限，头最高 / 最低贴窗的截图都没露馅）；② 视线在碰到真有的两排座椅或侧壁之前，不能进入按同一排距外推的「幽灵座椅」包围盒；③ 下一条的窗洞黑带。识别：截图里窗框外侧出现大片纯黑 / 灰白无细节区，或 `__voyage.headLimits.pos/neg` 与头部位置对不上。以后要是补建了更多排座椅 / 过道 / 行李架，把 `head-limits.ts` 的判据放宽（`PHANTOM_ROWS`、`MIN_GRAZE_DEG`），限位表用 `handoff/FOCUS-ZOOM-limits.mts` 重算。
- **很斜地看本窗时，窗板开口近侧有一条竖直纯黑带**（FOCUS-ZOOM 发现，着色器缺陷未修）：眼睛到窗板开口近侧边缘（x = ±0.12、z = 0.075）的视线与窗板法线夹角 ≥ 约 35° 时出现、越斜越宽（网格实测见 `handoff/FOCUS-ZOOM.md`；默认坐姿的视角到不了，前伸 + 侧挪 + 聚焦才看得到）。根因没查清（猜测是窗洞内衬挡住窗板的那一条，`scene.ts` 按窗板平面的 `inPane` 合成成窗外、而那里窗外 / 内衬都没有有效着色——**是假设，未验证**；`uDebug` 1 / 4 可以从这里查起）。现在由 `head-limits.ts` 的 `PANE_EDGE_MAX_DEG = 33°` 在相机上避开；修好 `scene.ts` 的合成后可以放宽。
- **`fwidth` 做抗锯齿要设上限**：视线几乎贴着舱壁时，平面交点在无穷远处，导数巨大，会把遮光板、内衬、舱壁的颜色混在一起。
- 舱内色适应不能拿舱内平均色直接当白点（灰世界）：舱壁本身是暖白，平均色偏暖就会被当成暖光抵消，白天舱壁依然冷灰。要先除以饰面的平均反照率（`uCabinRefAlbedo`）得到光源色。改了舱内主材的反照率要同步这个值。
- **机翼自阴影用的距离场必须处处是真实距离的下界，包围要覆盖各个方向**（T22）：襟翼滑轨整流罩旧版只按展向 `|z − zf|` 包围，翼面上方几米高的点也只报几十厘米；软阴影估计 `14·d / 走过的距离` 把它当成「擦边」，整片上翼面被压暗，而且按步进采样离散成一圈圈年轮纹（夜景最明显），穿云时成迷彩块，小翼上成竖向分面、像镀铬。识别：`uWingDebug` 的 8（去自阴影）一开纹就没了；1（去鼓包）、4（去环境反射）无效。修法：包围加上竖直方向，最终距离再对包围取大兜底。改任何部件的距离场后都用 8 位对照一次。
- **球体追踪贴着表面掠射时步数会爆**（T22）：外轮廓附近的射线几乎和翼面相切，每步只挪近一点；边缘超采样的子射线从半路出发、64 步走不到前缘，四条都算「没打中」，像素整个露出背景，前缘外轮廓成了 1 像素的硬台阶。全局加步数能修，但机翼 pass 慢 40%。修法：外轮廓（非内轮廓）的子射线从命中点前 16 像素处出发；中心射线「还在逼近」时步数可以延长。对照开关：`uWingDebug` 的 64 / 128。
- **分段改截面的距离场，段边界外侧要看得见隔壁更大的截面**（W-STAIR）：主翼在襟翼段（s 0.03–0.72）放下襟翼时截面只到整流罩末端，副翼段是完整翼型；旧版 `sdWingMain` 按「P 在哪一段」只算那一段的截面，段内离副翼内端面一两毫米的点报出的却是到整流罩的距离（几十厘米）。球体追踪一步跨过副翼内端面、落进翼型里面 3–8 个像素深，法线取的是翼内梯度（常朝下），副翼内端、整流罩后面一片逐像素乱跳的点阵阴影——16 帧平均也不收敛，原来被云噪声盖住，C11 去噪后成了云里窗外最显眼的锯齿（`tmp/screenshot/c11/wing/stair_z1.png`）。自阴影、环境反射、鼓包、边缘超采样的调试位都关不掉它，只有「只看反照率」时变成副翼缝线（`wingSeam(s − 0.72)`）的点阵——那是着色点位置错了、不是材质错了。
  修法：段内的截面都是完整翼型的子集，离开本段至少走 m（到段边界的距离），所以真实距离 ≥ min(本段距离, max(完整翼型距离, m))；下界放在 `uFlap > 1e-3 || uSlat > 1e-3` 的 uniform 分支里，襟翼、缝翼收起时逐位不变。按段分区：襟翼段的两道边界只对 xi > 0.52 生效、缝翼段的只对 xi < 0.14 生效（再与离这片弦向区域的距离取大），否则下界会在没有表面的地方（s = 0.06 平面上的后缘之后、s = 0.72 平面上的缝翼槽）降到 0，造出幻影墙——**下界降到 0 的地方必须真有表面**，改完除了 dHit 读回，还要查非机翼区有没有凭空多出的命中（`W-STAIR-diag.mjs` 的 `compare`）。坑中坑：完整翼型距离只取竖直项不够，后缘后面、和翼型同高的点下界变成 m，射线在段边界平面上「打中」一面不存在的墙（云里一千多个像素）。
  识别：把命中点的 `dHit / 像素宽` 写进颜色读回（`handoff/W-STAIR-jobs-diag8.json` 的 v4 变体），正常命中在 0–0.4 之间，< −1 就是跨进了体内；改任何部件的距离场后查一次。
- **边缘超采样的子射线共用步数，饿死的子样本会露出背景**（W-STAIR）：四条子射线共用 `uWingSteps/2` 步，前面的子射线擦着薄后缘挪、把预算吃完，后面的只剩 8 步，走不到后缘后面的短舱 / 襟翼就算「没打中」，这一格露出背后的天空或云。夕阳下后缘上一串亮珠、云里整流罩后缘压在襟翼上的内轮廓一串白点、商务舱正午后缘一条虚线（和 T22 的一串白点同一个外观，不同根因）。识别：`uWingDebug |= 1024`（每条子射线各给 `uWingSteps/2` 步）一开就消失。
  修法：分到的步数不足 `uWingSteps/4`、在包围盒里用完的子射线按打中算，沿用中心射线的颜色（不着色，免得踩 T22 的「着色点在空中」）。**不能一律按打中算**：擦过外轮廓以后贴着翼面慢慢远离、背后就是天空的子射线也会走不完，一律算打中时外轮廓外扩、斜边的过渡被吃掉，商务舱正午看前缘的台阶反而更硬。门槛按「与 1024 + 8192 的参考图逐像素比」选（`handoff/W-STAIR-vsref.py`）。对照开关：`uWingDebug` 的 8192。
  同时把内轮廓的擦边判定从 1 个像素放宽到 2 个：球体追踪的采样点常跨过最近点，同一条内轮廓隔一个像素判上一个，超采样做一格跳一格，边上是虚线似的台阶（`uWingEdgeAA = 2` 品红标记能看出来）。
- **翼尖灯照翼面要用「照翼面的配光」，不能直接拿灯本身的发光强度**（W-LAMP，`handoff/W-LAMP.md`）：`wingLampIntensity` 只有水平分布、上下各向同性，方向接近竖直时水平角由 `dir.xz` 的零头决定，「尾灯向后 20 cd / 向前 2 cd」随零头正负来回翻，灯正上方的小翼内侧、灯下的翼面是一块块硬边亮块；再加上 `max(d², 0.04)` 在 20 cm 内是照度处处相同的平台，被照亮的翼漆没有梯度。修法：`wingLampSurfI`（FAR 25.1393 / 25.1401 竖直分布的平滑近似、水平台阶放软、近竖直按水平平均；翼尖频闪朝内只漏 0.15）+ 圆盘光源 `I / (d² + R²)`。灯本身的亮点与云雾光晕（`wingLights`）用 `wingLampIntensity`（它在无机翼的像素上也写）；STROBE-FLASH 起其中的频闪也按同一套配光（见「大气与曝光」STROBE-FLASH 条）。
  识别：`W-LAMP-stats.py` 的灯周径向剖面（非单调 = 有硬边亮块）与翼面 ≥250 连通块（去掉灯芯 6 px）。
- **灯几乎贴着翼面照时，n·l 在 0 附近的起伏被 1/d² 放大成一串黑点**（W-LAMP）：尾灯、航行灯装在翼尖弯折段上，旁边的翼面几乎和灯共面，距离场法线零点几度的起伏让 n·l 来回过零——翼尖后缘一线隔几个像素一个黑点，改动前就有。W-STAIR 以为频闪时这条线的虚线是去亮点限幅压了中心样本，**实测不是**：`uWingEdgeAA = 0`（不超采样、不限幅）照样有；把灯光从限幅里拿出来（中位 / 第二亮 / 第二暗样本各试过）反而放出一串白点。修法：航行灯、尾灯的 n·l 用面光源地平线 `(n·l + sinα)² / (4 sinα)`，过渡宽度再和「像素内法线转角的一半」（`gWingCurv` × 像素足迹）取大；**频闪不加这道过渡**（同页消融：加了以后频闪帧孤立白点多一倍，不加比改前还少）。
  坑（审查返工）：`gWingCurv`（四面体拉普拉斯曲率）逐像素、逐帧都在跳，小翼前缘这种大曲率处 spreadN 还会顶到上限——**只能放进取 max 的地方，不能直接加进粗糙度**。曾把 spreadN² 加进灯的镜面 α²，航行灯旁的小翼前缘出现一条飞行中爬动闪烁的绿色高光细线（night-city-low 频闪灭的帧闪烁像素 1–4 → 203–272），冻结对照和只看频闪帧都看不出来。识别：飞行中页内逐帧 readPixels **全部帧**（不只频闪帧），看频闪灭的连续三帧的时间二阶差（`handoff/W-LAMP-live.py --all`）。
  识别：同页冻结 + `uWingEdgeAA = 0` 读回 hdrWing，逐像素写出每盏灯的 n·l 与照度（`W-LAMP.md` 的「编码变体」），暗点处 n·l ≈ −sinα、左右邻像素差几十倍就是这个。
- **外轮廓解析覆盖率：静帧最准的写法，飞行中反而爬得更凶——几种估计器逐帧来回切是根因，不是「边变锐了」**（W-EDGE，`handoff/W-EDGE.md`）：park 版 B′（弦内探测 + 解析覆盖率）静帧与参考图差和 −46%，但 sunset 小翼前缘飞行中闪烁像素 400 → 800–1300、小翼后缘 3 → 100+。参考图（25 子射线）自己在 live 里只有 180，说明锐边不必然爬。
  用冻结后按 0.12 mm 步进 `head.x` 的确定性序列（`handoff/W-EDGE-sweep-mk.py` / `-sweep-ana.py`：每帧读 new / ref / old 覆盖率 + 逐像素「走了哪条路」的路径码，算覆盖率的时间二阶差并按路径切换归因）查出四处「同一像素逐帧换估计器」：①中心射线命中阈值 0.4 像素，擦边射线算打中、探测段第一步就往上，深度取决于步进落点——阈值改 0.05，擦边的走外侧解析（主翼前缘二阶差 1035 → 516）；②「折角 → 超采样」判据随采样相位来回翻，超采样又偏高 +0.15——去掉；③只探测曲率判近的像素，拉普拉斯曲率逐像素跳、折角上是 0——所有命中都探测，判远的先在 0.75 像素深处验一次（多一次距离场）；④阈值改小以后着色点落到真表面，夜里翼尖灯照亮的薄边法线极端，单样本一串白点（夜间灯旁闪烁 15 → 60）——着色点仍取第一次进到 0.4 像素的那一步，覆盖率按真命中；以及单样本的极亮点（短舱唇口的夕阳反光）——中心样本比背后窗外亮 3 倍以上时改走超采样取色 + 去亮点，覆盖率仍用解析值。
  识别：飞行中闪烁用 `ab` 的 `live`（同代码两轮当噪声底）；定位用序列法看路径码组合（「前、中、后」三帧的码不一样就是切换）。无效的方向（都量过）：放宽过渡、全局外移、子射线阈值、薄板一律超采样、只在小翼关探测、按偏浅比例修正（静帧好一点、时间上更差）。「后缘与整流罩」这个 live 区域框进了云，同代码两轮差 50%，**不能只看热图**——要按冻结覆盖率（`covOld` / `covNew`）掩码，把机翼轮廓 ±4 px 的带内 / 机翼内部 / 窗外分开统计，云的噪声在带外，不会盖住轮廓本身的闪烁（`handoff/wedgerev_mask.py`，独立审查产物；用法见下面「审查返工」）。
  **审查返工**：硬门槛仍有一处没过——sunset 襟翼滑轨整流罩（`w.part == 5`）的外轮廓，按掩码统计带内闪烁像素基线 88–122、这个版本 367–536（约 ×4），实现者用「看热图，说全在云上」漏看了，根因是热图脚本 `W-EDGE-live-heat.py` 把已经翻好的录像又多翻了一次（详见下条）。修法：整流罩是盒子式拼接的距离场（`wingCanoe`），外侧最近距离偏小、内侧深度也偏浅（序列法按路径统计：码 1 外侧解析 +0.113、码 2 探测→解析 −0.155），探测段得出「部分覆盖」时命中部件若是整流罩就不走解析覆盖率、直接走原来的 RGSS 超采样（`wing.glsl.ts` 的 `wingTrace` 探测段末尾加一条 `else if (w.part == 5)` 分支）；光滑部件（前缘、小翼）这条路径的误差只有 +0.01，不受影响。返工后带内闪烁像素两轮 27 / 41（低于基线 88–122，也低于审查报告里 fairss 变体自己测到的 42 / 58），商务舱正午 / sunset 其他分区 / 夜间同步下降或持平，非机翼逐位 0，静帧差和从 −38.5% 回落到约 −53%（quick 5 场景，仍是下降，预期内）。
  顺手把「中心样本比背后窗外亮 3 倍以上才超采样」的逐像素硬开关改成 2–4 倍之间按 `smoothstep` 把单样本颜色与超采样颜色混合（`wing-shading.glsl.ts` 的 `wingView`，`fireflyMix`）：硬开关在门限附近颜色会跳（覆盖率不跳，因为用的是解析值 `covA`），商务舱正午小翼前缘反而因此多闪；混合后同一批场景闪烁像素没有回升。代价：从 2 倍起就要付出超采样的开销，机翼 pass 帧时间比返工前的定稿（×1.06–1.24）略升到 ×1.07–1.23（CPU 20–59% 负载下测的，仅供参考，权威数字留给安静窗口）。
- **同页冻结 A/B 的「非机翼逐位照抄」核对有两个假阳性**（W-LAMP）：① night-city-off（4 km 夜城）同页冻结也不确定，`old2` 对 `old` 的「非机翼」差异 1.7 万–15 万像素（城区灯点），这个场景只能看统计，逐位核对改用 night-city-low 或 night-wing-on（G-FREEZE 已查清并修掉：是等地面的判据太松、截图之间地面还在换版，修后两个场景同代码重拍都逐位 0，可以做逐位核对）；② 「旧版和不画机翼的变体逐位相同」会把旧版恰好画成纯黑（背景也是 0）的机翼像素算成非机翼，新版在那里给了一点灯光就被报成越界写入。核对时再读一张覆盖率（`W-LAMP-ab.mjs` compare 的第 4 项，`wing.a > 0` 的算机翼），W-LAMP 报出的 1311 个「非机翼差异」全部是覆盖率 > 0 的机翼像素。
- **云里 / 窗上有水时机翼 pass 画的是湿窗变体**（W-STAIR 踩到）：`wingVariant.pick` 在 `uWetness > 0.001` 时换成 `wingVariant.wet`，只改 `__voyage.wingMat.fragmentShader` 画面纹丝不动（七个诊断变体截出来逐位相同，还以为 patch 没生效）。页面里换机翼着色器要两个材质一起改（`handoff/W-STAIR-diag.mjs` 的 `__wsMats()`）；`shots --material` 用 `wingMat.current`。
- **两次运行之间的机翼不能逐像素比**：每次冻结的时刻不同，翼尖弯曲 / 颠簸相位不同，机翼整体挪几个像素。改动前后要在**同一页面、同一冻结时刻**换着色器对照（`handoff/W-STAIR-diag.mjs --base <对照端口>`：从对照服务器活页面读出旧着色器原文，变体里 `__wsPatch([], __wsBase)` 整段换上）。
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
- **窗上倒影默认关（REFLECT-OFF，用户 2026-09-29：「机舱反光过强了，也请弱化甚至默认关闭」）**：`uReflStrength`（`cabin-reflect.glsl.ts` 的 `CABIN_REFLECT_STRENGTH`，各舱等变体共用）默认 0；
  面板「舱内灯光」下面的「窗上倒影」滑条（`#cabin-reflect`，0–100%，双击复位到关）与 URL `?reflect=0..1`（也认 on / off）设它，优先级 URL > 用户亲手拖过的值（`voyage.pref.view` 的 `reflect`，只记 `isTrusted`）> 0。
  `scene.ts` 在强度 0 时整段跳过倒影（夜里开灯舱内合成约 −4–6%，正午在噪声内）；强度乘在软限幅**之后**（`view += uReflStrength * reflAdd`），是整层按比例变淡——乘在 `reflGain` 上会被 T34 的上限压回去，调小了看不出差别。
  验证：同页冻结 A/B，强度 1 与 master 着色器逐位 0（4 个场景），默认与强度 0 逐位 0；窗外框以外只有辉光（bloom 读窗内的光）带来的 ≤ 1 LSB、≤ 0.02% 像素的差。**回归场景现在默认看不到倒影**：要看 / 量倒影（T24 / T34 / T41 / T42 类问题）给场景 `p` 加 `"cabin-reflect": 1`，或 `--query reflect=1`；`uDebug` 31 / 33（只看倒影）不受强度开关影响。
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
- **夜里的巨构要比身后的光穹暗，才读得成剪影**（WS02）：灯城放大到 15–24 km 后，塔面「下方发光雾的补光」沿用 W02 的系数（反照率 × 灯海 × 0.15），加上一成亮的窗格平均成的底光，塔面比身后被照亮的空气还亮，整座金字塔读成一盏发光的纸灯笼。按竖直面看到半个下半球的发光雾估，补光应是 反照率 × 灯海 × 0.05，并随高度衰减；窗改成 3–4.5% 亮的「2 层 × 一格」窗块（110 km 外约 3 × 3 像素），光穹分塔前 / 塔后两段、塔后那段才勾出剪影。识别：临时让着色返回 0（塔全黑），剪影一下就出来了——说明补光 / 底光过量，先查补光系数，别去调光穹。
- **掠射看薄雾层，雾盘外缘的硬边来自「亮度跟着浓度走」和「露出的地面灯」**（WS02）：10.7 km 高处看 100 km 外 1–2 km 厚的雾，一条视线在雾里走十几 km，光学厚度到城边最后一两公里才从几十掉到 0；如果发光也跟浓度同一个范围收，雾盘就在那一两公里里一刀切（「一盘发光液体」）。另外雾在城边变薄时，直接露出的地面灯比雾亮好几倍，会在近边切出一条亮带。修法：发光包络比浓度提前约 20 km 渐隐（城边还浓着的雾是暗的），地面灯只在城区里面露出来；雾与光穹的范围收在包围盒以内（盒边不能切边）。识别：同机位拍「开 / 关事件」（`uWonderParams.w` 临时开关或 `volume.surface / medium`），硬边只在开事件时出现 → 是地面事件。
- **奇观 pass 的冷编译对「代码总量」超线性，单项撤回的比例加不起来**（WS02）：离线 FXC 逐项撤回，每一项都掉 20–40%，合起来远超 100%。真正有效的：删掉在新距离上本来就看不见的部件（W02 的车流光痕，90 km 外按设计已淡没）、共用函数少调用点（fcMask 有 atan 和几个 sin，调用处算好传进去）、点光合成一个循环。循环里的 break / continue 单独撤回量出 −21%，改成把不存在的塔挪到 1 万 km 外后复测却没有变化，属于噪声。负载下离线 FXC 的噪声在 ±15% 量级：判定看 3 轮的最小值，并与基线交替测（`shader-budget --baseline`）。`--variants` 的撤回要写成编译期常量（`if (false)`），写成 uniform 比较 FXC 照样编那一支。
- **Windows 上 Python 用文本模式写文件会把 `\n` 写成 CRLF**（WS02）：`open(p, "w")` 改源文件以后 `check:glsl` 报「CRLF 行尾」，`shader-budget --variants` 里带 `\n` 的多行锚点也就匹配不上（报「出现 0 次」）。写源文件一律 `open(p, "w", encoding="utf-8", newline="\n")`。
- **W02 的窗格用局部坐标的法线判断「哪一面」**（WS02 修）：塔按城市坐标（局部坐标绕 y 转了种子角）摆放，法线却没转，窗格沿错的轴被拉长成横条。着色里用到面朝向的地方，法线要和位置一样先转到城市坐标（`fcToCity(n)`）。
- **天幕层的粗大实体（锚塔、环站）按「像面」做就够精确，不用光线步进**（WS01）：每个像素取正交基 `nh = rd×a` 归一、`up = (a − b·rd)/sn`，相对基座的点 p 投到 `(p·nh, p·up)`，本像素是 `(X, s·sn)`——视线穿过 p 当且仅当两者相等，所以「打中没有」是沿视线的正交投影，精确；轴线上高 h、半径 R 的圆投成横半轴 R、纵半轴 |b|R 的椭圆（`b = rd·a`），b > 0（仰视）时朝相机的半圈在上。截锥 = 横向按该高度半径 + 纵向上下两个椭圆弧，环 = 到椭圆的距离 ≤ 环管半径，覆盖率都用三角核解析积分（`wonderFrustum` / `wonderEllipseNearest`）。WS05 建木加粗、WS07 巨柱群照这套写。识别：想给远处巨构写球面追踪 / 步进之前，先问它是不是「柱 + 台 + 环」。
- **巨构要被云「排到后面」，得先有云的深度**（WS01）：`cloudBufferDepth` 只在附近有高出海面的真实地形时才写（PERF-11，`clouds.ts` 的 `depthOn`），平时返回 0 = 云全在前面，`cloudBeforeGround(cloud, D, 塔的距离)` 什么都不做。修法：天幕层奇观在场（`uWonderOn`）时 `depthOn` 也开；窗外 OUTSIDE_WONDER 段按奇观盖住像素的比例混 `cloudBeforeGround`。另：从 10.7 km 看 220 km 外的塔，塔脚那一带的视线在 170 km 左右就扎进了 1–3 km 的云顶——塔脚是被**近处**的云海挡住的（对的），真正被塔挡掉的远云只有塔身下沿几百个像素。识别：`shots --pair "" --pair "v.sceneMat.uniforms.uCloudDepthOn.value = 0;"` 同机位冻结对照。
- **远处高空的暗色大面也「黑不下去」**（WS01）：环站朝下铺深色板（反照率 0.07）想让仰视时环管中间一道暗带，画面上几乎看不出——几百 km 外高处物体的亮度大半是它前面那段空气的内散射（W00 同一个道理），`wonderCap` 还给了「不暗过背景 60%」的地板。要层次就靠受光面与背光面（竖肋把法线左右偏）和尺度更大的结构（节点舱、退台），别靠反照率反差。
- **放射状辐条一画出来，环站就是一只自行车轮**（WS01）：4–8 根辐条从缆辐射到环上，250 km 外还剩 1 px 的线，整体读成车轮 / 玩具；真实的张拉索只有米级，本来就看不见。现在只画环上大小不一的节点舱，不画辐条。以后做「环 + 中心」类结构先缩成 64 px 高看剪影（同 W03 的蘑菇云教训）。
- **OW 变体（窗外 + 奇观 + 罕见光学）的 FXC 冷编译按「结构」涨，不按指令数**（WS01）：天梯巨构第一版让 OW 离线 FXC +34%（同轮「无天梯」对照 −35%），fxc 指令槽只 +18%。逐项消融（`tmp/ws01/fxc-variants*.mjs` 的写法，`shader-budget --variants`）没有一块单独占大头，拿回来的几刀：①远 / 近两层部件着色合成收成一个调用点（原来 6 处 `wonderIrr` + `wonderCap`）；②撤掉几何算完后「什么都没盖到就提前 return」的中途早退（−10%，GPU 上本来也量不出省了什么）；③循环外按编号动态取 uniform 数组（`uWonderRings[int(k)]`）改成在循环里存下来（−9%）；④默认关的开发者开关代码（塔身灯格）不编进默认变体，改成 URL `?towerwin` 时才拼进源码（−9%）；⑤研究里的扶壁、辐条、舱体表面在 220 km 外看不出来，砍掉。最后同轮对照 master 约 +22%（最小值）/ +14%（中位），负载下噪声 ±30%。识别：`shader-budget --only outside-extras` 的 `slots / temps` 是确定性的，时间要和基线交替 ≥ 3 轮看最小值；「把 continue 改成 if 块」「常量循环加 uLoopGuard」「三角函数换旋转递推」在这里都没用（噪声内或更慢）。
- **云间层奇观放大以后，奇观 pass 的开销大头是「在空盒子里走介质」**（WS04）：浮空古城放大 5 倍、包围盒 50 × 36 km 后，介质区间还是整个包围盒，每个像素走满 96 步（绝大多数步什么都没有），奇观 pass 比小岛版多约 1.1 ms；表面追踪只占 0.2–0.35 ms。修法：`mediumSeg` 按「介质实际在哪」收窄（浮空古城显形后只走台地底面以下的竖直圆柱，浮现时才放大到整团云），瀑布 / 云涡循环前先按半径、高度粗筛，增量降到约 +0.43 ms。识别：`gpu-ab` 用**编译期撤回**（变体的 `patch: {"clouds.wonderSurfMat": [["if (uWonderUse.y > 0.5) {", "if (false) {"]]}`）比，撤回介质那一档掉一半就是这个问题。
  坑中坑：在 `gpu-ab` 变体的 `js` 里改 `v.wonders.active.def.volume.medium = false` **不可靠**（WS04 实测和不改一样，而编译期撤回掉 1 ms；原因没查清，可能是冻结期间 `syncVolume` 没有每帧重写 `uWonderUse`），而且改的是 catalog 对象，之后的变体 / 轮次都被带歪。分项开销一律用 `patch`。
- **把一个造型整体放大 N 倍，和「绝对高度 / 绝对厚度」挂钩的东西要单独改**（WS04）：浮空古城用「模型坐标」放大（水平 ÷Kh、台地以上 ÷Ku、以下 ÷Kd，分段线性连续，SDF × min(K) 仍是距离下界），造型一次就对了；但原来的根须长度一放大就插到海里、岩锥尖插进海面、雾罩里均匀的薄雾光学厚度 ×5 把整座城蒙成蓝灰且逆光时一圈光晕、树冠外沿 0.18 km 的叶雾层变成 0.8 km 厚的一块块「霉斑」、瀑布化的雾成了一朵遮住半座城的积云。修法：根尖 / 岩锥尖按**真实海拔**给（根尖 1.4–3 km 正好扎进层积云顶），薄雾和叶雾在巨构版里去掉（空气交给大气本身的空气透视），介质密度按放大倍数稀释或减半。识别：放大后先逐项问「这个量是跟着造型走，还是跟着地球 / 空气走」。
- **尺度参照物被包围盒边缘淡出，恰好淡掉了唯一看得见的那一段**（WS04）：航迹云从城边擦过，在城轮廓里面的那段被城挡住，看得见的是城外面那段——而那段离城轴 17–23 km，正好是按包围盒（±25 km）淡出的范围，截图里什么都没有。修法：包围盒水平放到 ±45 km（只多了早退的空像素，介质区间另外收窄，不涨开销），航迹云在 34–44 km 淡出。识别：解析的发光事件临时把 τ 设成常数（不带任何淡出）拍一张，先确认几何对不对。
- **GLSL 保留字又一个：`patch`**（WS04，glslang 报 `'patch' : Reserved word`）；和 `sample`、`input`、`output` 一样，变量名别用。
- **奇观介质想自己算受光（例如光束要被树冠缝隙切开），反照率返回 0、散射光写进 emit**（W03）：`wonderLayer` 在反照率全 0 时跳过标准受光 `wonderMediumLight`（W03 加的判断），否则每步白算一次主光源 + 天光 + 4 瓣相函数。标准受光只有一个平滑的投影椭球挡光，切不出光束。
- **像面上解撑杆（`wonderStrut`）的牛顿法，仰看长枝时会不收敛，在天上画出横贯窗口的假弧线**（WS05）：建木的枝伸出 20–50 km，仰看（b ≈ 0.3–0.4）时朝着 / 背着相机伸的枝 k = b·(h·rd)/sn² 很大，两步牛顿解不出 σ，算出来的横向距离落在某条假曲线上，天上出现几道细弧和星形的斑。修法：解完再验残差 `|σ − s − k·r|·sn < 2 像素`，不满足就当没打中（天梯的稳定缆是直线，一步就精确，不受影响）。识别：只在仰看（头压低）的机位出现、和枝不相连的细弧。
- **暮色里逐像素封顶（`wonderCap`）会把被照亮的大块面压成一片平涂的剪纸**（WS05）：暮色天空比阳光暗几个数量级，被照亮的叶盘受光面和背光面都超过「天空 × 1.3–2」的上限，逐像素各自按比例压下来以后亮度一样，明暗全没了。修法：按部件「正对光源时最亮」的样子算一个封顶比例、整个部件共用（`wonderCapRef`），明暗关系保留。识别：大面积的奇观部件在黄昏一色平涂、看不出体积。
- **200 km 外、高过视平线的暗色粗柱，背光的一面在白天和天空一样亮**（WS05）：视线从 10 km 高处斜着往上，树干身后几乎只剩稀薄的平流层，天空的亮度几乎全来自树干前面那段空气的内散射，暗面 = 空气光 ≈ 天空；逆光（`ws-jianmu-day`）时整根树干中段几乎看不见（M6 上段对比只有下段的 0.7）。这是物理上对的，别去压空气透视。白天的可读性靠受光面（树皮反照率取 0.15，不是 0.05）、白色的云环 / 脚下云海、树冠的叶盘。识别：宽几十像素的实体在截图里只剩一半宽（受光的那半）。
- **长直枝上串一排小叶团，远看是树苗 / 天线，不是巨树**（WS05）：第一版九根 40–90 km 的直枝挂着 2–5 km 的叶团，和树干（20 px）比例像一棵刚发芽的苗；改成三层瓶形枝 + 枝梢托一片 8–15 km 的扁椭球叶盘（投到像面是横半轴 R、纵半轴 √(R²b² + T²sn²) 的椭圆，仰看看得见底面），读成层层的古松。另：叶盘里按噪声挖空当会成满盘圆洞的奶酪，空当只放外圈。识别：缩到 64 px 高看剪影（同 W03 蘑菇云、WS01 自行车轮的教训）。
- **板根（竖直平面上的一片）按像面反解是精确的**（WS05）：含轴线和方位 h 的竖直平面上一点 (ρ, σ) 投到像面是 (ρ·(h·nh), σ·sn − ρ·b·(h·rd)/sn)，线性，所以按像素横坐标直接 ρ = X / (h·nh)、再解 σ，和上沿 z(ρ) 比即可（不用牛顿）；深度 tF = t + (σ − s)·b + ρ·(h·rd)，和 tLimit 比就知道海面挡没挡住。正对 / 背对相机（|h·nh| < 0.06）的那片缩在树干后面，直接跳过。
- **新的天幕层奇观单独开一个窗外变体，比塞进 OW 便宜，而且 OW 一字不变**（WS07）：OW 已经是天梯 + 建木 + 罕见光学，冷编译比门槛高 13–22%，再加一个皮肤只会更重，还和同波的奇观改同一个函数。巨柱群做成 `WONDER_PILLARS` 宏（键 `OWP` = O + W + P），源码仍整段拼进 `WONDER_SKY_COMMON`（共用 `wonderStrip` / `wonderLightT` / `wonderCapRef` 等小工具，没被调用的 `wonderSky` 不进 FXC），只把调用点换成 `wonderPillars`。离线 FXC 同轮：OWP 13.7 s（最小值）对 OW 15.3 s；`shader-parity` 里 OW / DOW / DROW / 默认程序预处理后逐字不变。坑：`uWonderShape.z = 2` 在 OW / DOW 里会被 `wonderSky` 当成建木画（它只分「0 天梯 / 其余建木」），所以 `wantedOutsideKey` 见到皮肤 2 只能要 OWP、退路只有默认程序（不画奇观），不能退到 OW。识别：召唤新皮肤后窗里出现一棵建木。
- **圆柱 + 等距外凸环带 + 外张的柱头，远看就是一排烟囱**（WS07）：第一版巨柱群 5–6 km 粗的圆柱每 6–11 km 一道凸出 9% 的环、顶上外张 12% 的柱头，截图里读成工厂烟囱 / 水管，不是巨构。改：去掉柱头（平顶 + 一圈风化暗带），环带凸出降到 3%、三成缺着、节距 7–14 km，三分之一的柱子退一级台；另做**方柱**（六成的群是同一朝向的方柱：受光面 / 背光面在前棱处一刀分开，读成「一整块混凝土」而不是管子）。细纹也要收：施工缝 + 竖肋的对比太强时柱面是一张方格纸，尺度一下就小了——换成 3–5 km 一块的面板色差（大块的深浅比细缝更说明「大」）。识别：缩到 64 px 高看剪影（同 W03 蘑菇云、WS01 自行车轮）。
- **多个解析云团合成一层、用「按光学厚度加权的深度」排前后，会在柱子身上切出矩形缺口**（WS07）：两根柱的旗云叠在一起时，加权深度在某条竖线两侧跳过柱子的深度，云一半画在柱前、一半画在柱后，柱身上出现直边的缺口。修法：先定下最近的两根柱 A、B，再把每团云按它自己的深度分进「比 A 远 / A、B 之间 / 比 B 近」三格，着色时从远到近五步合成（一个循环、重函数各一个调用点，FXC 不因步数变多而变慢）。识别：云与柱交界处出现和像素列对齐的竖直直边。
- **远处的航迹云顺着视线方向看，曲率修正 + 断续调制会画成一圈圈同心的弧**（WS07）：航迹云方向按种子乱取时，有的正好顺着视线；闭式线积分本身没问题，但「离最近点 d km 下沉 d²/2R」的曲率项和沿线 `sin(sl·0.37)` 的断续在像面上被压成几十个像素里的几道弧。修法：召唤时按「从飞机看锚点」的方位，把航迹云的航向定在与视线夹 55°–90°（大致横穿窗口），这正好也是它当尺子最好读的角度。另：190 km 外 0.1–1 km 宽的管子比像素细，按能量守恒摊薄后只剩一两级灰，横截面光学厚度要取 1（浮空古城 90–140 km 用 0.5）。识别：柱脚附近一组同心细弧，关掉航迹云（`v.wonders.active.pillars.contrail[3] = -10`）就消失。
- **点星画在舱内程序里，只认窗外的 `gStarVis` 标记，天幕层奇观挡不住它**（WS07 发现，WS-STAR 核实并修）：星空像素的 `gStarVis = 1` 在奇观合成之前就定了，`main()` 只把它乘进 alpha（`1.0 + starVis * tr.a`），舱内程序按这个 alpha 决定点星亮不亮——RGB 上看着挡住了不代表点星也被挡住。WS07 版巨柱群已在 `#ifdef WONDER_PILLARS` 里补了 `gStarVis *= 1 − gWonderCov`；WS07 交付时留了一句「天梯 / 建木（OW）按代码看也有这个问题，未截图核实」。WS-STAR 核实：wonder-sky.glsl.ts 里确实**没有**这一行，天梯 / 建木夜景点星会穿透锚塔 / 树干。核实手法：直接对比 on/off 真实截图不够可靠（夜景曝光极高、又有跨帧的全屏眩光扩散，任何非零值截图都会泛白；分开两次跑 `shots` 拍到的「前 / 后」镜头位置、灯光动画相位也可能有细微漂移），改成把 `gl_FragColor` 临时替换成 `vec3(gStarVis>0.5?1:0, gWonderCov>0.5?1:0, 0)` 并把生效范围锁在屏幕上一个远离奇观边缘、只有几像素的小框（避免眩光把整个画面糊成白色），必要时回退代码重跑做对照。修法：把这一行从 `#ifdef WONDER_PILLARS` 分支里挪到 `#endif` 前、两个分支外统一乘一次——`gWonderCov` 是 `WONDER_SKY_COMMON` 里的共用全局变量，巨柱群 / 天梯 / 建木都会写它，挪到分支外对 OWP 预处理结果没有影响（`shader-parity` 核对逐字相同）。**副作用**：`OUTSIDE_WONDER` 宏同时也是 DOW（低空细节）、DROW（火车远景）两个变体的开关，两者和 OW 一样只在 `#else`（非巨柱群）分支里调 `wonderSky`，因此这一行修完以后 DOW / DROW 预处理后的文本也跟着变了（`shader-parity --base master`：`outside-extras`、`outside-ground-detail`、`outside-rail` 三个都报「预处理后仍不同」，只有 `outside-default`、`outside-pillars` 逐字相同）——这是符合预期的结果，不是误伤：DOW / DROW 走的是同一段 `wonderSky` 调用，原来就带着同样的漏洞，一并修掉才是对的；只是和「以为只有 OW 会变」的预判不一致，写这里备查。识别：夜景奇观实体轮廓内有不随奇观移动的亮点；调试可视化时轮廓内偏白（R、G 都亮）而不是纯绿（只有 G 亮）。

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

<a id="pit-perf"></a>
### 性能

- **雷暴天云步进最贵的一处是乳状云的口袋场 `pouchField`，不是步数**（PERF-STORM，2026-09-29，`handoff/PERF-STORM.md`）：
  - 现象：storm-sc-low（巡航俯看层积云海 + 雷暴）云步进是同一片云海无雷暴时的约 9 倍，预审记 5.7 ms @1600×1200、用户 3840×1950 整帧 9 ms。
  - 定位（`ab` 的 `cloud-steps` 内置变体 + 自定义计数补丁：每像素步数 / 有云样本 / 完整雷暴密度次数 / 精简雷暴密度次数 / 8 步受光样本；`gpu-ab` 逐项关掉）：每像素 168 步里 161 步是外壳里层状云高度以外的空白 2dt 步，有云样本只有约 2 个——但**把这些空白步跳掉（步数 168 → 75）GPU 几乎不变**（×0.99），空白步很便宜。真正的钱在「求雷暴密度的步」：砧与砧下的乳状云带里每像素 20+ 次完整 `stormDensity`；关掉乳状云 ×0.67–0.71，其中几乎全是 `pouchField`（两级 3×3 格点、每格两个哈希）。
  - 修法（几何逐位不变）：①`pouchField` 里格点中心离采样点 ≥ 0.75 格（口袋最大半径）先跳过第二个哈希；②`mammatusDensity` 按口袋最大下垂深度（≤ 0.75·1.68·cl·zone）剪掉砧底下更深的采样点。两条合起来雷暴云步进 ×0.88；之后空域跳跃（下一条）才显出来，再 ×0.85。
  - 识别：雷暴 / 台风类任务改密度函数前，先用计数补丁看「每像素求了几次完整密度、在哪」，再按函数逐个关掉量 `gpu-ab`，别只看步数热图。
- **云步进的天气变体对寄存器压力极敏感，「省步数」的改动要分变体量**（PERF-STORM）：空域跳跃（雷暴包围柱 + 层状云包络之外整段跳过）在雷暴变体里 ×0.85–0.88，同一段代码放进台风变体（台风包围柱 18 倍眼半径几乎罩住整窗，一步也跳不掉）却让台风云步进 **×1.36**——多了几个跨循环存活的量。所以跳跃只编进纯雷暴变体（`CLOUD_STORM_SKIP`）。反过来把闪电端点、相函数等挪进分支「省寄存器」、台风雨带单体循环里的等价早退、受光版单体参数缓存，实测都不省或更慢（×1.0–1.12）：别凭直觉改台风变体，改了必须 `gpu-ab` ≥ 16 轮。
- **`passes.mjs`（含预审用的 passes-vp 副本）在并行负载下同一场景两次能差 30–100%**（PERF-STORM 实测：master 上 storm-sc-low 云步进 3.2 / 3.9 ms、用户分辨率 6.2 / 11.1 ms 都出现过）：只用来看「一帧的钱花在哪个 pass」；前后对比一律 `gpu-ab`（同页 ABBA 配对 + A/A），用户分辨率用 `gpu-ab --viewport 2560x1300 --dpr 1.5 --time frame`。
- **「帧率很低、CPU 打满、GPU 利用很低」先查浏览器是不是退到了软件渲染，别先当代码回归查**（PERF-CPU，2026-09-28）：
  - 现象：用户的 Chrome 里整页 2–3 fps，任务管理器 CPU 满、显卡几乎闲着。
  - 根因：前一晚 23:59:37 NVIDIA 驱动重装（系统日志 UserPnp 20003「为设备添加服务 nvlddmkm」），Chrome 的 GPU 进程 4 秒后重启时拿不到硬件 D3D 设备，退到 **WARP**（`Microsoft Basic Render Driver`，D3D11 的 CPU 软件光栅），之后一直不会自己切回（浏览器进程从 9/13 起没重启过）。本页在 WARP 上约 2.4 fps，WARP 的光栅线程占约 26 个核。硬件模式（RTX 5090、有头、1600×1200 或 2560×1300@1.5）各场景稳态都顶在 160 fps vsync，主线程 JS 约 1 ms/帧，**不是回归**。
  - 修法：用户侧完全重启 Chrome（`chrome://restart`），再到 `chrome://gpu` 确认「WebGL: Hardware accelerated」。代码侧：`src/boot/software-gl.ts` 启动时读渲染器字符串，命中 Basic Render / SwiftShader / llvmpipe 就在页面顶部提示原因与办法（`?swgl=1` 强制显示，`__voyage.softwareRenderer` 看判定）。
  - 识别：①页面顶部出现上述提示；②PowerShell `(Get-Process -Id <Chrome GPU 进程>).Modules | ? ModuleName -match 'nvwgf|Warp'`：有 `D3D10Warp.dll`、没有 `nvwgf2umx.dll` 就是 WARP（Chrome GPU 进程 pid 用命令行里的 `--type=gpu-process` 找）；③复现：`node scripts/cpu-prof.mjs --port <端口> --angle d3d11-warp --no-gl`（注意 `--use-angle=warp` 不是合法值，会退到 SwiftShader）。
- **聚焦（放大）时整帧 GPU 约 ×1.2–1.6，主要是窗外占满全屏，不是 LOD 失控**（FOCUS-ZOOM，`gpu-ab` 8 轮带 A/A，1600×1200）：整帧 4× 时 sea-sc ×1.16、noon-cumulus ×1.43、fuji-day ×1.55、night-city ×1.56、sunset-wing ×1.41；分 pass 看云 ×1.18–1.89、机翼 ×1.3–2.2（机翼占满画面）、窗外 + 舱内 ×1.07–1.20。对照：不聚焦、头贴窗（z = −0.03，窗也占满全屏）的 noon-cumulus 本来就比默认坐姿贵 22%，4× 聚焦只比它再多 17%。用户分辨率下晴天积云约 5.4 → 7.7 ms，超 160 Hz 预算；所以聚焦中（含还原后 1.5 s）暂停自动调档（`quality.pauseDecisions`），宁可这几秒掉一点帧，也不在用户凝神细看时降档、云缓冲重置整片糊一下。以后若要真正省：聚焦时按倍率降云缓冲分辨率（窗外角分辨率已经高了 N 倍），或机翼在放大时减步数——另开 PERF 任务。
- **每帧 WebGL 调用的大头是空气透视 3D LUT**（PERF-CPU）：原来内散射 / 透射率分两遍各画 32 层，占全帧 111 次 draw 中的 64 次（每层一次 `framebufferTextureLayer` + three 的整套 `render()`），同一段 `integrateSegment` 算两遍。改成两附件 MRT 一遍画出（`luts.ts` 的 `aerialTarget`：three 的 `WebGL3DRenderTarget` 给 `count: 2` 时多出来的 `textures[1]` 仍是 2D `Texture`，要手动换成同设置的 `Data3DTexture`），draw 111 → 79，与旧做法逐 texel 逐位相同（`node handoff/PERF-CPU-aerial-check.mjs <端口>`）。
- **冗余的 GL 状态调用不是瓶颈**（PERF-CPU 实测）：three 每次 `render()` 末尾把深度测试 / 深度写入复位，全屏 pass 的材质又关掉，每帧约 220 次 `depthMask`、各 110 次 `enable` / `disable`（占调用数 40%）。在 JS 侧去重后同页交替对照，GPU 进程 CPU 在噪声内没有变化——ANGLE 把状态推迟到 draw 时才下发，这类调用很便宜。不值得绕开 three 的状态管理。
- **测 CPU / GPU 进程开销用 `scripts/cpu-prof.mjs`**（PERF-CPU，见「调试与验证」）：GPU 进程 CPU 同场景两次能差 ±30%（45–90%），前后对照要同页交替（`--scenes 场景,A,B,A,B --jsA … --jsB …`）或多轮交替跑两个端口，不要单次比。启动后头 10 s 与换场景后的几秒里，GPU 进程的 `ThreadPoolForegroundWorker`（后台变体着色器编译）会占 4–7 个核，是一次性的，量稳态要等过去。

<a id="pit-tools"></a>
### 工具与环境

- **测量工具的 URL 带 `?dev=<时间戳>`（防缓存），开发者区的 `?dev` 开关只认空值 / `1` / `true` / `on`**（FOCUS-ZOOM）：面板规范（`research/PANEL_UX_GUIDE.md` §2.1）用 `?dev` 打开开发者区，而 `dev-browser.mjs` 的 `openPage` 一直用 `dev=<时间戳>` 破缓存；按「有没有 dev 参数」判断的话，所有工具页面都会显示开发者区（UX 类任务截面板时面板变高、面积测量不对）。以后新增 URL 开关先 grep 一下 `scripts/` 里有没有同名参数。
- **id 撞了会让 CSS 规则套到错的元素上，`getElementById` 也总是拿第一个**（UX-3 发现，FOCUS-ZOOM 遗留）：开发者区「聚焦暗角」滑条原来和聚焦暗角的**叠层 div**（`<div id="focus-vignette">`，`focus-zoom.ts` 用来画四角压暗）共用同一个 `id="focus-vignette"`。后果两层：① `style.css` 里给叠层 div 写的 `#focus-vignette { position: fixed; inset: 0; }` 连带套到了这条滑条上——`#panel` 有 `backdrop-filter`，会给后代的 `fixed` 元素建立新的包含块，于是滑条被拉伸铺满了 `#panel` 自己的内容区，原生滑块画在面板纵向正中间，展开开发者区时会看到一条诡异的横杠叠在别的行上；② `ui.ts` 里 `document.getElementById("focus-vignette")` 永远拿文档序里第一个（那个叠层 div），`setupFocusUi` 给它挂的 `input` 事件、双击复位全挂在了一个 div 上——**这条滑条从 FOCUS-ZOOM 上线起，拖动就没真正改过 `focus.vignette`**（只能靠 URL 参数或脚本改）。修法：滑条 id 改成不冲突的 `focus-vig`（`index.html` / `ui.ts` 各一处），叠层 div 的 id 不动。识别：面板里出现一条位置诡异、和当前展开区无关的滑块；或者某个滑条拖动后 `output` 文字不跟着变。新增控件前排查一下 id 有没有已经被别处占用（尤其是「同名的叠层 / 提示 div」这类容易被忘掉的非控件元素）。
- **压缩面板控件的竖直高度：下拉 `flex-basis` 要用 `0%` 不要用 `auto`**（UX-3，为了让 1600×1200 默认面板不用滚动，`research/PANEL_UX_AUDIT_1.md` P2 报的 2622 px 压到约 1100 px）：把 `#panel label` 从 `flex-direction: column`（标签文字、数值、控件各占一行）改成 `flex-wrap: wrap`（同一行放不下才换行）后，下拉框如果写 `flex: 1 1 auto`，换行判断会按它**当前选项文字的天然宽度**参与计算——选项本来就长的下拉（地点名、天气名）会把整行提前挤到换行，看起来和没优化一样。改成 `flex: 1 1 0%` 后换行判断只看 `min-width`（给了 64 px），下拉本身按 flex 伸展占满剩余空间，选项文字再长也只在框内被原生裁切，不会撑破布局。滑条同理不用再强制单独占一行（去掉 `flex-basis: 100%`），标签 + 数值 + 滑条能挤下就单行。

- **面板元素设了 `display` 就会盖住 `hidden` 属性**（T49、UX-1 各踩一次）：现象：代码里 `el.hidden = true`，截图里那一行照样在（连续航程关着时的「航程流速」、自动曝光开着时的「手动曝光」）。根因：`#panel label { display: flex }`、`.row { display: flex }` 的优先级高于浏览器自带的 `[hidden] { display: none }`。修法（UX-1a）：`style.css` 全局 `[hidden] { display: none !important; }`，显示 / 隐藏一律用 `hidden` 属性，不要再给单个选择器补 `xxx[hidden]`。识别：截图场景 `js` 里对照 `el.hidden` 与 `getComputedStyle(el).display`（`handoff/UX-1a-scenes-panel.json` 的 `ux1a-default-bottom`）。
- **页面默认开启连续航程，测量脚本不带 `voyage=0` 截图就不确定**（VOY-DEFAULT）：现象：自写脚本 / 手动在 Playwright 里打开页面再 `applyScene`，同代码两次截图的云型、云影、海面、舱灯对不上。根因：载入到设场景之间导演已经按天气场硬切云参数（`type` / `density` 不在面板上）、摆了雷暴、写了海面风与舱灯，`applyScene` 的 `setActive(false)` 只停导演不撤回。修法：导航 URL 带 `?voyage=0`（仓库里的工具都已带，见「调试与验证」`applyScene` 一条）。识别：`__voyage.director.telemetry.legs.length > 0` 或 `director.weather.log` 非空，说明这一页进过连续航程。另：首载开启时机头直接对准第一段航线（`setActive(true, true)`）——默认地点西太平洋向南飞，前方没有机场，接入的第一段（羽田 → 关西）在西北，不对准的话首屏是 140° 的大坡度右转。
- **〔已解决，UX-2〕连续航程 / 脚本接管状态后，面板显示停在旧值**：现象（PANEL_UX_AUDIT_1 P1/ P9）：连续航程开着时云量滑条显示 42% 而 `uCoverage` 实际 34%、海面风速显示 7 而 `state.wind` 实际 1.0、「地点」下拉停在起飞前选的预设（实际航段已经是「羽田 → 关西」）；脚本直接改 `director.setActive(false)` / `wonders.enabled = false`（不经过面板控件、不 `dispatchEvent`）后，`voyage-on` / `wonders-on` 复选框仍勾着。根因：这些控件只在 `input` / `change` 事件（用户拖动或点击）时才写显示，系统（导演、天气场、脚本）直接改底层状态时没有任何代码把新值写回面板。修法：`ui.ts` 的 `setupWeatherAutoSync` 每 250 ms 从 `cloudUniforms` / `state.wind` / `director.weather.regime` / `state.preset` 回写云量 / 云底 / 云厚 / 海面风速 / 云型 / 地点的显示（只写 `value` 与文字，不派发事件），`setupVoyageUi` / `setupWonderUi` 的 `sync()` 也加上 250 ms 轮询；天气系统 / 云型下拉接管时锁定（disabled + title 写原因，见 `handoff/UX-2.md` 的 lock / nudge 语义）。以后新增「可能被系统接管」的控件，一律要么在系统写状态的地方顺手 `dispatchEvent`（如舱灯 `setCabinLight`），要么加一个只读轮询——不能假设「只有用户会改这个值」。识别：`research/PANEL_UX_GUIDE.md` §5.3 规则一「系统改了状态以后，面板显示跟得上，不只在用户拖动时才写控件」。
- **长时间帧测量期间别改 `src/` 里的任何文件**（G08 踩过）：vite 开发服务器热更新 / 整页重载，测量脚本 `Execution context was destroyed` 直接退出（持的测量锁由 finally 释放，但半小时白跑）。先提交再开测，测量期间只写文档 / 读结果。
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
- **`applyScene` 的 `--settle` 返回后、`pinGeometry` + 冻结之后，地面瓦片仍可能在加载**（T48b）：同页多变体对照第一轮，8 张图拍摄时 `ground.pending` 从 155 一路降到 12，冻结的画面仍在被新瓦片改写，变体之间不可比。修法：冻结后再 `waitForFunction(ground.pending === 0)` 并多等 2 s（`handoff/T48b-ab.mjs` 的做法），每张图的 JSON 里记截图那一刻的 pending 与 CORS 错误数。识别：同一变体拍两次（噪声底）不为 0。（G-FREEZE 更正：「pending 0 + 2 s」仍不够，拼接 / 合成 / 上传还在排队；现在统一用 `groundSettle`（`ground.unsettled()` 连续 10 帧为 null），见「地面与数据」的 G-FREEZE 一条。）
- **`shots --pair` / `--base-shader` 的噪声底不是 0：每拍一张后 `shootOne` 都跑一次 `benchFrame(30)`，而 benchFrame 不经过冻结**（PERF-14 发现，工具未改）：
  它按 16 ms 一帧推进 30 帧的模拟时间与曝光适应，a、b、a2 三张其实是三个不同时刻——自己换自己（master 着色器换 master 着色器）也有 5–48% 的像素差 > 8，夕阳场景连太阳眩光都不一样。
  绕法：`--pair` 的预设置 js 里写 `v.benchFrame = () => 0;`（截图 JSON 里的 frameMs 变成 0），噪声底立刻变成逐像素 0。另一个坑：`--base-shader` 不带 `--pair` 时整段被静默忽略，只拍普通截图。
  识别：a−a2 不是 0 就先别看 a−b。
- **`ab` / `gpu-ab` 变体里的 `js` 副作用不会被复原**（TW02 踩到）：工具只复原材质原文 / defines / uniform；`{"name":"off","js":"v.farTowers.enabled = false;"}` 之后按 ABBA 轮到 `cur` 时开关仍是关的，gpu-ab 量出「开 / 关一样快」的假结论。做法：每个变体都显式写全自己的状态（`cur` 也写 `enabled = true`）。识别：A/A 变体与基准一致、而「关」与「开」也一致时先怀疑这一条。
