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
- 声音（T11）：默认关；面板勾选「声音」或按 `M` 开启（浏览器要求用户手势），背景板模式下照常播放、`M` 仍可开关
- 时间：日期 + 当地时刻滑块，或用 60× / 600× 快进看日落
- 调试小地图（DX-06）：面板勾选「调试小地图」或按 `N` 开启（默认关），左下角显示航向 / 轨迹 / 航线 / 云回波 / 交通 / 奇观；点击地图切换 50 / 200 / 800 km 量程

## 渲染管线（每帧）

```
CPU：太阳 / 月亮位置、航线与航向、颠簸、天气调度（闪电）、地面 clipmap 更新（异步拉瓦片）
  → 大气：天空视图 LUT（太阳、月亮各一张）+ 空气透视 3D LUT
  → 云：光线步进（层状云 + 雷暴 + 台风）→ 时间累积（带重投影）；每 4 帧一次云密度探针（异步读回）
  → 窗外 pass（outside-pass.ts，全屏但只算本窗窗板以内）：地形求交或海面、天空、太阳、月亮、星星 + 云合成
      + 远处飞机与航迹云 + 云地闪通道，× 窗板透射率 → hdrOutside（全分辨率 32F）
  → 场景 pass（scene.ts，舱内合成）：舷窗几何（舱壁 / 内衬 / 遮光板 / 座椅）+ 读 hdrOutside + 窗板细节（划痕、油污、水痕）
      → HDR（kcd/m²，alpha 打包窗外遮罩与机翼参考，见 scene.ts 的 packWingRef）
  → 机翼 pass（wing-pass.ts）：读场景 HDR，把机翼与翼尖灯合成进窗外部分
  → 眩光 mip 链 → 测光（窗外 / 舱内分开，亮度 + 色度）→ 适应 → 曝光 + 舱内色适应 + 浦肯野 + AgX + 抖动 → 屏幕
```
启动时一次性计算：透射率 / 多次散射 / 天空辐照度 LUT、云噪声（GPU 生成后读回）、星图（CPU 溅射）。
首次打开或改了着色器后要冷编译着色器（Windows d3d11 上 SC-5 以后真冷启动约 17 秒，见坑点），期间显示加载遮罩。

## 目录与模块

| 文件 | 内容 |
| --- | --- |
| `src/main.ts` | 创建渲染器与各系统、主循环编排（各 pass 调度）、`setPreset` / `snapAll` / `resize`、调试句柄 `window.__voyage` |
| `src/state.ts` | 共享类型 `VoyageState` / `Preset`、`CRUISE_PITCH_DEG`、`$` 小工具 |
| `src/flight.ts` | 预设（地点 / 航线）、大圆航向与距离、每帧飞行更新：`updateTurbulence`（颠簸、湿度、滚转）、`advanceFlight`（航向、倾斜转弯、高度爬升、俯仰、位置推进） |
| `src/ui.ts` | 面板 DOM 绑定 `setupUi`、信息栏 `updateInfo`、时间 / 高度控件同步 |
| `src/astro.ts` | 太阳 / 月亮位置、月相、当地→赤道坐标矩阵（astronomy-engine） |
| `src/sky-assets.ts` | 星图（BSC5 溅射成 HDR；A 通道是银河）、月面贴图 |
| `src/light-pollution.ts` | 城市光污染的天空背景（T09）：从地面夜光估算，只压银河的可见度 |
| `src/traffic.ts` / `src/weather.ts` | 远处飞机的运动；天气预设、雷暴 / 台风摆放、闪电调度；天气场 `WeatherField`（T19b：按经纬度 + 时间取样云型 / 云量，雷暴系统与台风的出生、寿命、漂移，粗略东亚海陆分布） |
| `src/director.ts` / `src/weather-director.ts` / `src/routes.ts` | 导演（T19a）：航段接力、爬升—巡航—下降剖面、时间流逝、遮挡排队切换（`request` / `onCover`）、换原点；天气驱动（T19b）：按天气场插值云参数、借遮挡换云族、在视野外生成 / 移除雷暴台风、奇观之门云墙 `openGate`；东亚航线网 |
| `src/debug/minimap.ts` | 调试小地图（DX-06）：可选的角落 2D canvas 叠层，画本机 / 轨迹 / 航线 / 交通 / 奇观，以及从天气场采样的云回波「多普勒」图；不碰任何 WebGL 程序 |
| `src/atmosphere/common.glsl.ts` | 大气参数、相函数、LUT 参数化、视线积分（所有着色器共用） |
| `src/atmosphere/luts.ts` | 透射率 / 多次散射 / 辐照度 / 天空视图 / 空气透视 LUT；`setHaze` 设边界层霾 |
| `src/atmosphere/haze.ts` / `src/render/haze.glsl.ts` | 低空障眼法（T18）：边界层霾参数（按时段、地区、日期）、清晨谷地辐射雾 |
| `src/clouds/noise.ts` | 云的形状 / 细节噪声、天气图（GPU 生成） |
| `src/clouds/clouds.glsl.ts` | 云密度：层状云（天气场驱动）、雷暴（`towerShape`）、台风；云影 |
| `src/clouds/clouds.ts` | 云的光线步进、时间累积、云预设、密度探针 |
| `src/ground/geo.ts` / `tiles.ts` / `clipmap.ts` | 经纬度换算；瓦片加载（影像、地形、水体、夜光）；6 级 clipmap |
| `src/render/scene.ts` | 场景（舱内合成）着色器：舱内 uniform 声明、主函数（舱壁 / 内衬 / 遮光板 / 座椅 / 窗板效果、alpha 打包）、`createSceneMaterial`（持有所有 pass 共用的 uniforms） |
| `src/render/outside-pass.ts` | 窗外着色器（SC-5）：`outsideRadiance`（地面 / 海面 / 天空的唯一调用点）、交通、闪电；`createOutsideMaterial` / `createOutsideTarget`；低空细节变体 `GroundDetailVariant` |
| `src/render/noise.glsl.ts` | 窗外与舱内共用的小噪声（hash12 / vnoise / hash22 / fbm2）和 `uLoopGuard`；改它两个程序都重编 |
| `src/render/ocean.glsl.ts` | 海面：菲涅尔、12 波斜率场、风痕、`oceanRadiance` |
| `src/render/terrain-shading.glsl.ts` | 真实地面着色 `groundRadiance` |
| `src/render/wing-shading.glsl.ts` | 机翼着色 `shadeWing` 与航行灯 / 频闪 `wingLights` |
| `src/render/lightning.glsl.ts` | 闪电照度 `flashIlluminance` 与云地闪通道 `boltRadiance` |
| `src/render/view.glsl.ts` | 相机射线、舷窗尺寸 |
| `src/render/cabin.glsl.ts` | 窗洞内衬（漏斗）、窗板光源、划痕 / 油污 / 水痕 |
| `src/render/wing.glsl.ts` | 机翼 SDF、材质细节、机身投影 |
| `src/render/lights.glsl.ts` | 太阳 / 月亮 / 夜天光、直射主光源 `uKey*` |
| `src/render/stars.glsl.ts` | 星星、银河（物理定标 + 眼睛的对比度阈值）、月亮圆盘 |
| `src/render/ground.glsl.ts` | clipmap 采样、地形求交、地形阴影 |
| `src/render/islands.glsl.ts` | 程序生成的岛屿（仅在关闭真实地理数据时） |
| `src/render/traffic.glsl.ts` | 航迹云与远处飞机 |
| `src/render/exposure.ts` / `bloom.ts` / `pass.ts` | 曝光与色调映射；眩光；全屏 pass |
| `src/audio.ts` | 声音（T11）：Web Audio 程序化合成（频域合成的可循环噪声床 + 发动机谐波 + 事件），`Soundscape`（可建在 OfflineAudioContext 上）/ `CabinAudio`（面板与主循环用的控制器）；`scripts/audio-check.mjs` 离线出频谱表 |
| `scripts/build_stars.py` | 从 CDS 下载 BSC5，生成 `public/data/bsc5.json` |

**热点文件**：`src/main.ts` 和 `src/render/scene.ts` 几乎每个功能都会改到，并行开发时按 `DEV_SOP.md` 的规则分配（T01 已把它们拆小，但新增 uniform 仍要同时改 scene.ts 的声明块和 `createSceneMaterial`；新增面板状态要同时碰 state.ts / main.ts / ui.ts）。

## 调试与验证

- `window.__voyage`：`state`、`head`、`cloudUniforms`、`snapAll`、`clouds`、`resize`、`sceneMat`、`exposure`、`traffic`、`ground`、`weather`、`minimap`（DX-06 调试小地图，见下）。
- **调试小地图**（DX-06，`src/debug/minimap.ts`）：面板底部「调试小地图」开关，或按 `N`（不在输入框里时）；默认关，纯 2D canvas 叠层，画在左下角（约 280×300、半透明深色底，不挡舷窗中心），关着时 `update()` 第一行就返回、canvas `display:none`，零开销。内容：本机（图标固定圆心，地图始终「航向朝上」）、已飞过的轨迹、当前航线（`director.leg` 的航段或 `state.preset.dest`）、远处的其他飞机（`traffic.ts`）、奇观（`wonders.active`）、以及「云的多普勒」——仿气象雷达回波图，背景网格从 `director.weather.field.sample()`（天气场）按经纬度采样云量 / 云型换算出回波强度，叠加当前**实际渲染中**的 `weather.storms` / `weather.hurricane`（不论天气是导演按天气场摆的还是面板手选的，雷达图都和窗外一致）。点击地图本体在 50 / 200 / 800 km 三档量程间切换。雷达网格（48×48）每约 800 ms 重采样一次，且分帧算（每帧最多 4 行），避免拖帧；台风的螺旋雨带是按角度做正弦调制的近似图形（用于「看起来像螺旋回波」），不是 `clouds.glsl.ts` 里真正的密度场（CPU 侧读不到那份数据）。
- `sceneMat.uniforms.uDebug.value`（窗外与舱内共用同一份 uniforms，1–4 在舱内程序，其余在窗外程序）：1 内衬命中深度，2 亮度伪彩，3 内衬受到的窗光，4 内衬法线，5 海面本身，6 海面天空反射，7 海面内散射，8 海面粗糙度 / 像素覆盖，9 海面直射照度，10 闪烁格子。
- `window.__voyageStartup`：启动各阶段耗时。
- URL 参数 `?lut16`：大气 LUT 强制用半精度（T36 改前的行为、没有 32 位浮点线性过滤的设备），用来对照深暮光的阶梯。
- 截图前：把 `head` 固定在 `{tx:0, ty:0.02, x:0, y:0.02, tz:-0.3, z:-0.3}`、`uCloudOffset` 归零或设成固定值、隐藏面板（加 `hidden` 类），前后对比才有意义；截图放 `tmp/screenshot/voyage-*.png`。
- 测帧率前先 `page.bringToFront()`（窗口被挡住时 Chrome 会节流到 1 fps）。
- 找程序生成的岛：在浏览器里用 JS 复刻 `hash22` 列出岛心（见 WORKLOG「岛屿」）。

- **私有 headless 联调**（不用共享浏览器锁）：`node scripts/dev-browser.mjs check --port <端口>`（只开页面、等启动完成、收集 console error / pageerror，有错误就打印并以非 0 退出码报告，没有就退出 0；提交前用它比跑 `shots` 快得多，不用等每个场景 2.5 s 的稳定等待）、`shots --port <端口> [--only a,b]`（跑回归场景表 + 截图 + 帧时间）、`cold --port <端口>`（真冷启动）、`bench --port <端口> --baseline <对照端口>`（批渲帧时间两端口对照，附 GPU timer query）。脚本会自动找本机 `ms-playwright` 缓存的完整版 `chrome.exe`，启动后校验渲染器不是 SwiftShader（用了 `chrome-headless-shell.exe` 或 `--use-angle=swiftshader` 会静默退化，见下面「坑点」）。GPU 被其他代理占满时可能报 `Target crashed`（等一等或换个时间再跑，`pnpm run` 套一层时偶发挂起，直接 `node scripts/dev-browser.mjs ...` 更稳，见 `handoff/DX.md`）。
- **临时场景（DX-05）**：`shots` 支持 `--scene '<JSON>'`（可重复，和 `--only` 可并用），不用再为每个任务新写一个 `T0x-shots.mjs`。字段和 `scenarios.mjs` 里 `SCENES` 数组的条目一致：`name`（必填，同时是文件名）、`p`（面板控件 id → 值，如 `preset` / `time` / `wing-pos` / `cabin-class` / `altitude` / `weather` / `coverage`）、`head`（数字只设 z，或 `[x,y,z]` 三元组——`[-0.42,0.1,-0.5]` 看前方、`[0.42,0.1,-0.5]` 看后方、`[0,0.02,-0.42]` 默认坐姿）、`offset`（云的世界偏移）、`wait`、`ground`（等真实地面瓦片）。例（商务舱看后方）：
  ```bash
  node scripts/dev-browser.mjs shots --port 5247 --out tmp/screenshot/x \
    --scene "{\"name\":\"biz-behind\",\"p\":{\"preset\":\"wpac\",\"time\":720,\"wing-pos\":\"8\",\"cabin-class\":\"business\"},\"head\":[0.42,0.1,-0.5]}"
  ```
  没有 `--scene` 时行为和以前完全一样（`--only` 过滤固定场景表，或跑全量表）。
- **截图并排对照（DX-05）**：`node scripts/compare.mjs --out <输出.png> [--crop x,y,w,h] [--zoom N] <图1> [<图2> ...]`，把多张截图拼成一张，每张左上角标文件名（父目录/文件名，便于区分不同批次的同名场景）；不给 `--crop` 就是整图并排，给了就先裁剪再按 `--zoom` 用最近邻放大（不模糊，专门给锯齿 / 闪烁这类像素级问题用）。泛化自 `handoff/T35-crop.py`（Python + Pillow），改用 Node + Canvas2D（借一次性 headless 页面做合成，复用 `lib/chrome.mjs` 找 `chrome.exe` 的逻辑，但不需要真实 GPU）避免依赖本机 Python 环境。
- **离线 GLSL 检查**：`pnpm --filter voyage check:glsl`，不开浏览器，几秒内跑完，能抓住 GLSL 保留字、同一程序内的同签名函数重名、场景 / 窗外程序 sampler 数超 16（已用真实 GPU 交叉验证过一次，见 `handoff/DX.md`「返工记录」；SC-5 以后 `scene-default` 3/16、`outside-default` / `outside-ground-detail` 16/16），以及 `src/` 下有没有 CRLF 行尾（DX-05；仓库靠 `.gitattributes` 统一 LF，Windows 上脚本误写 CRLF 时 git 提交才会提示，这里提前到 check:glsl 里扫一遍并列出文件，见下面坑点「Windows 上 Python 写回源文件会变成 CRLF」）。提交前跑一次比等冷编译报错快得多。`node scripts/lint-shaders.mjs --self-test` 单独测检查逻辑本身，不用起 vite。

- **ANGLE 后端切换**：`dev-browser.mjs` 的 `shots` / `cold` / `bench` 都支持 `--angle d3d11|vulkan`，默认 `d3d11`（Windows 上与生产环境一致，**这是交付验收的口径，不要改**）。日常改代码想快速看效果，开一个专用的 vulkan 窗口：`node scripts/dev-browser.mjs cold --port <端口> --angle vulkan`或直接用桌面浏览器 `chrome.exe --use-angle=vulkan`（真冷启动能从约 100 秒降到几秒，见`research/DX_SHADER_COMPILE.md`）。vulkan 会藏住 D3D11 专属问题（sampler 上限 16 vs 32、FXC 编译暴涨、X3595 屏幕导数报错），**验收前一定要在默认 d3d11 上再跑一次**。
- **模拟高分屏 / 弱 GPU**（DX-04）：`dev-browser.mjs` 的 `shots` / `cold` / `bench` 都支持 `--viewport WxH`（浏览器视口，默认 `1600x1200`）和 `--dpr N`（`deviceScaleFactor`，默认 `1`）。二者组合改变实际绘制的画布像素数（画布 = 视口 × DPR），例如 `--viewport 1600x1200 --dpr 1.5` 实际绘制 2400×1800，用来在本机高性能 GPU 上人为制造过载，测「画质自动档」这类自适应逻辑的降档 / 回升；不传时行为与之前完全一致。PERF-5 验收时就是手工这样模拟出「高分屏 + 台风天气」的过载场景（见 `handoff/PERF-5.md`），现在收成了通用参数。
- **离线着色器编译预算**：`node scripts/shader-budget.mjs`（或 `pnpm --filter voyage shader-budget --<参数>`），不开完整浏览器场景、不占 GPU，用 ANGLE 的翻译器 + Windows SDK 的 `fxc.exe` 离线算出每个程序的真实编译时间和 sampler 数。`--only <程序>` 只测一个，`--quick` 用 `/Od` 几十秒内出「能不能编过」，`--bisect <模块>` 把场景程序里的某段换成桩，看它占了多少编译时间（`--bisect list` 看可换的模块）。和浏览器真冷编译对照过一次，误差 5.4%，在 ≤15% 的可信范围内（见 `handoff/SC-12.md`）。

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
| 卫星影像（运行时拉取） | EOX Sentinel-2 cloudless 2020（`tiles.maps.eox.at`） | CC BY-NC-SA 4.0，需署名；仅限非商业 |
| 地形（运行时拉取） | AWS Terrain Tiles，Terrarium 编码（`elevation-tiles-prod`） | 开放数据，各来源署名见其说明 |
| 水体（运行时拉取） | OpenFreeMap 矢量瓦片的 water / waterway 图层 | © OpenStreetMap contributors，ODbL |

**经验近似（不是物理量，后续要替换）**：舱内受窗外光的系数、夜间自动曝光的目标中灰曲线、水体反射率取值。代码里都标了注释。

## 坑点

- **窗上的水要做成「折射」，不能画成线和圈**（T29）：旧版把水线画成深色细线加头上一个圆、水珠只剩一圈暗环，在亮背景前读成铅笔线、钉头和空心圆圈。
  现在 `waterOnPane` 只给水面坡度 / 覆盖率 / 暗边，`scene.ts` 按坡度偏折视线、`texelFetch` 偏移后的 `uOutside`，暗边只在下缘（月牙）。
  坑一：按真实折射率算，偏折是几十度 = 上百像素，点采样会在水珠里画出放射状条纹（像图钉），还读到窗板开口以外（那里 alpha = 0，黑）；`WATER_DEFLECT` 因此缩到物理值的约 1/10，开口外的样本退回不偏折。
  坑二：整圈暗环 = 空心圆圈；均匀的雾里折射前后一样，暗环是唯一可见的东西，必须弱且只留下缘。
  另：湿度按 ISA 气温门限（`flight.ts` 的 `outsideAirTempC`），高于约 4.6 km（ISA −15°C）不再挂水，已有的水按升华 / 吹干消退。
- **加速播放（连续航程 60×）会把影像瓦片服务器打到限流**（T19a）：飞机每秒走 15 km，8–32 km 的细级别 clipmap 每一两帧就重建，EOX 每分钟约 7000 个请求，被拒时返回的错误页不带 CORS 头，控制台刷出上万条 `blocked by CORS policy`（看起来像 CORS 配置错误，其实是限流）。只给 `ground.update` 加时间节流没用：请求量约正比于「飞过的距离 × 细级别数」。
  修法：`ground.setMinLevel()` 按流速停用最细几级（10× 停 1 级，≥30× 停 3 级），60× 降到每分钟约 550 个，1× 基线约 95。以后怎么识别：`handoff/T19a-voyage.mjs` 的 summary 里有 `requestsPerRealMin` 和 `consoleErrorCount`。
- **连续航程不调 `setPreset`**（T19a）：接下一段只换 `state.preset`（导航目标、时区、霾），不换本地坐标原点，否则地面、云场都会重建。离原点太远时由导演借穿云或深夜「换原点」（`director.ts` 的 rebase 请求），经纬度、高度、航向都连续，只有云场和海浪的噪声原点会跳一下。
- **天气渐变不能走 `clouds.applyPreset` / `snap()`**（T19b）：会清掉时间累积，并让云影图整张在一帧里重建（3–8 ms）；连续航程每 0.25 s 推进一次云量，就会变成持续卡顿。修法：`clouds.setParams(p, true)`（gradual），云影图按后台分片节奏跟上；借遮挡的硬切才用 `setParams(p, false)`。
- **占据网格只保护 ±128 km 内的雷暴 / 台风**（T19b）：网格外照样逐点求值，4 个单体在 300 km 外仍 +1–1.5 ms/帧，台风在 750 km 外 +2–3 ms/帧（`handoff/T19b-storm-cost.mjs`）。天气驱动因此只在 280 km（雷暴）/ 600 km（台风）内摆放；以后要放得更远，先在云程序里给网格外的雷暴 / 台风做 LOD。
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
- 曝光的测光 / 适应目标（T28 起是 2×1：左像素亮度、右像素色度）只有一两个像素，耗时就是单个线程的串行采样链，GPU 再宽也不能并行。T28 的色度测光一开始跑两遍 16×16（先求均值再排除高光），曝光 pass 从 0.057 ms 涨到 0.084 ms；改成用上一帧的适应亮度判高光、只跑一遍后回到噪声内。识别：整帧 bench 看不出（GPU 被占满时噪声 ±15%），用 `handoff/T28-bench-exposure.mjs` 单测曝光 pass。以后往测光里加东西，采样数控制在亮度像素的 1024 次以内。
- 舱内色适应不能拿舱内平均色直接当白点（灰世界）：舱壁本身是暖白，平均色偏暖就会被当成暖光抵消，白天舱壁依然冷灰。要先除以饰面的平均反照率（`uCabinRefAlbedo`）得到光源色。改了舱内主材的反照率要同步这个值。
- 1×1 的曝光适应目标要用 `FloatType`。半精度在对数亮度约 8 附近的步长是 0.004，每帧的微小变化会被吞掉，适应会卡住。
- **深暮光天空的块状阶梯来自半精度 LUT 的下溢**（T36）：
  - 现象：太阳在 −10° 到 −18° 之间时，天空是一格一格的阶梯色块，云量为 0 也有。
  - 根因：大气 LUT 以「光源照度 = 1」为单位存辐亮度。实测天空视图 LUT 的中位数，−10° 时约 4e-8，−15° 时约 6e-10，−18° 时约 6e-11，都低于半精度的最小次正规数 5.96e-8。每个 texel 只剩 0 / 1 / 2 个最低位，双线性插值后被自动曝光放大成阶梯。
  - 修法：支持 `OES_texture_float_linear` 时，所有大气 LUT 都存成 32 位浮点（`Atmosphere.float32`）。性能在噪声以内，着色器没有变化。
  - 排查：URL 加 `?lut16` 可以强制回到半精度复现。逐张切 32 位的实验表明，只有天空视图 LUT 有影响；空气透视和多次散射 LUT 切不切都一样。
  - 识别：暗场景里出现和 LUT texel 网格对齐的块状台阶时，先看这张 LUT 的数值有没有掉到 6e-5 以下（半精度的正规数下限）。以后再加以「照度 = 1」为单位的 LUT，也要用 32 位。
  - 没有 32 位线性过滤的设备仍会退回半精度，阶梯还在。要修的话，可以按太阳高度乘一个缩放系数再存。
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
- **窗外着色器的 sampler 已满（16/16）**：ANGLE 上 `MAX_TEXTURE_IMAGE_UNITS = 16`，T14 加入 `uOceanWaves` 后场景程序活跃 sampler 正好 16；SC-5 拆开后满的是窗外程序（outside-pass.ts），舱内合成程序只用 3 个，舱内要加纹理放那边。再加纹理会链接失败（日志可能为空）。修法：合并进纹理数组 / 图集。识别：`gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS)` 逐个数 sampler 类型。合并任何碰场景着色器的分支前都要数一遍。
- **FXC 会把常量上界的循环整个展开**：循环多、函数内联多时冷编译从 45 s 涨到 80–90 s，甚至超时 → `VALIDATE_STATUS false`（日志为空）→ `CONTEXT_LOST_WEBGL`，还会让共享浏览器 `GL_RENDERER = Disabled`。修法：循环上界写成「常数 + 恒为 0 的 uniform」（T02 的 `uTerrainSteps`、T06 的 `uLoopGuard`），重函数只调用一处。识别：冷编译时间暴涨、日志为空的链接失败。
- **测帧时间**：本机 GPU 远快于刷新率，rAF 间隔被锁在约 6.2 ms，看不出着色器代价；`gl.finish()` 在 Chrome 里也不等 GPU。用 `EXT_disjoint_timer_query_webgl2`，或「一个 rAF 里连渲染 N 帧后 readPixels 1 像素」。多个代理同时占 GPU 时任何计时都不可信。
- **真冷启动**：同一端口的着色器缓存会让「冷启动」其实是热的；测编译时间要用 addInitScript 往着色器注入随机数强制缓存不命中（审查脚本 `tmp/review-t02/cold.js`）。
- **海平面近处求交**：从 r≈6360 km 出发的通用球面求交在近处有约半米误差，会让海浪纹理出现与视角相关的颗粒噪点；`oceanRadiance` 里用 t = c / (−b + √(b²−c)) 重算。
- **GLSL 没有命名空间**：所有 `*.glsl.ts` 拼进同一个程序，同签名函数重名会编译失败；而且只在某个变体把相关模块凑齐时才暴露（T02 的细节变体与 T06 的 `lineCov` 撞名）。**新增 GLSL 函数一律带模块前缀**（如 `detailLineCov`、`seatSdf`）。`renderer.compileAsync` 失败也会 resolve，切换变体前要检查程序是否有效。
- **重函数只调用一次、结果复用**：FXC 会把被多处调用的函数在每个调用点整份内联，冷编译随调用点线性变长。已知重函数：`oceanRadiance`、`cloudShadow`、`flashIlluminance`、`sampleGround`、`keyLight`、`marchFunnel`、`windowIrradiance`、`cloudDensity`（及雷暴 / 台风部分）。SC-3 把场景程序里的 `oceanRadiance`、`cloudShadow`、`flashIlluminance` 都收成一个调用点后，场景冷编译 71 → 19 s（浮点逐像素不变）。新代码需要它们时先找现成结果，不要再调一次（T02 多调一次 cloudShadow 就多约 15 s）。定位法：真冷启动脚本 + `#if 0` 逐段二分。
- **影像瓦片取不到时不能露底色**：`clipmap.buildImagery` 预先给画布涂深海色 `rgb(8,22,40)`，某张瓦片偶发失败（网络 / 限流）就露出一块直边的「深海色陆地」，而 `loadBitmap` 还把失败永久缓存。修法：除最粗一级外缺瓦片处留透明，`sampleGround` 按透明度回退到粗一级；失败不缓存、重建时重试。识别：陆地上出现直边、颜色恰为深海底色的色块。测回退：`page.route` 拦掉一部分瓦片（`page.unroute` 必须传同一个正则对象，否则拦截不解除）。
- **调试模式编号**：`uDebug` 1–10 原有；11 / 12 海浪（T14：白浪覆盖率、可分辨斜率）；21 地表分类、22 像素足迹、23 水体遮罩（T02）。新增前先查占用。
- **glslang-validator-prebuilt-predownloaded 没有 `bin` 字段**：不能 `npx` 直接跑，要 `require("glslang-validator-prebuilt-predownloaded").getPath()` 拿到可执行文件路径自己 `spawn`（`apps/voyage/scripts/lint-shaders.mjs` 已经封装好）。
- **离线校验 THREE 的 `#include <chunk>`**：不能直接展开 `THREE.ShaderChunk` 的原文喂给 `glslangValidator`——它的 `common` chunk 里的 `average()` 函数会被 glslangValidator 误报「redeclaration of existing name」（ANGLE / 真实浏览器编译完全正常，是 glslangValidator 自己符号表的问题）。`lint-shaders.mjs` 用手写的桩替换（`INCLUDE_STUBS`）绕开。
- **按文本数 sampler 引用，光展开 `#ifdef` 还不够，要连着做「从 main() 可达性剪枝」**：一个函数即使在源码里正常定义、正常读了某个 sampler，只要这个函数本身从场景程序的 `main()` 顺着调用链走不到（比如只被另一个程序调用），真实驱动的死代码消除会把它和它读的 sampler 一起砍掉——纯文本「这个名字出现过好几次」看不出「是否真的可达」。`lint-shaders.mjs` 的 `reachableFromMain`/`pruneUnreachable` 就是为了修这个坑（撞上的真实案例：`uMultiScatteringLut` 只被 LUT 预计算程序用，场景程序的 `main()` 到不了它）。加新的静态分析工具时留意这一条。
- **验证「静态数的 sampler 数」对不对，起一个真实 WebGL2 上下文比猜靠谱**：挂 `HTMLCanvasElement.prototype.getContext` 和 `gl.linkProgram` 的钩子把 `WebGLProgram` 对象截下来，再读 `gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS)` + 逐个 `gl.getActiveUniform` 数 sampler 类型（手法抄自 `tmp/review-t06/perf.js`），比任何文本分析都准。
- **`chrome-headless-shell.exe` 会静默退化成 SwiftShader**，且没有 `EXT_disjoint_timer_query_webgl2`：私有 headless 一定要用 `ms-playwright` 缓存里 `chromium-<版本>/chrome-win64/chrome.exe` 这个完整版二进制，不能用同一份缓存里的 `chromium_headless_shell-*`。
- **`regression.playwright.js` 的端口正则如果写太窄，会静默退回默认端口、覆盖别人的截图**：曾经只认 `51\d\d`（5100–5199），worktree 常用的 52xx 端口匹配不上时悄悄退回 `5181`，把截图写进主分支目录（本波发生 3 次）。现在认任意 `5\d{3}` 且不在范围内直接报错退出；以后类似的「按端口猜路径/猜配置」的脚本都要照这个模式改：宁可报错，不要猜一个默认值。
- **开发时用 Vulkan 后端，验收用 D3D11**（2026-09-26 编译专项实测）：`--use-angle=vulkan` 让真冷启动从约 98 s 降到约 5 s（绕开 FXC 优化器——离线实测 FXC `/O1` 占约 90% 编译时间）。画面与 D3D11 一致，但 Vulkan 的 sampler 上限 32、uniform 上限 4096，且不会暴露 FXC 专有问题（编译暴涨、X3595），所以**交付验收仍在 D3D11 上做**。GL 后端链接失败，不可用。开发用浏览器：`& "C:\Program Files\Google\Chrome\Application\chrome.exe" --user-data-dir="$env:LOCALAPPDATA\voyage-dev-chrome" --use-angle=vulkan http://127.0.0.1:5181`（独立用户目录，不影响日常浏览）。
- **离线计编译时间**：浏览器只做 GLSL→HLSL 翻译，再用 `fxc.exe` 离线计时（与浏览器内 88.9 s 对 88.2 s），不占 GPU。坑：three 链接后会删 shader 源码，要编译完立刻取翻译结果；Git Bash 会把 fxc 的 `/O1` 改写成路径，加 `MSYS_NO_PATHCONV=1`；ANGLE 翻译出的 HLSL 带占位符，离线编译前要补全。（工具见 SC-2 `scripts/shader-budget.mjs`。）
- **海面着色被内联了两次**：`terrain-shading.glsl.ts` 的地面水体又调用一次整个 `oceanRadiance`，场景编译 82.8 s 中约 51 s 来自这份重复（SC-3 在修）。`clouds.glsl.ts` 同时拼进场景、机翼、云三个程序，改它三个都会重编。
- **（已推翻，2026-09-27 T27）台风云影用的是解析大形，不是真实密度**（T04）——现在窗外程序查一张世界坐标预计算的云影图，用真实密度（带细节侵蚀）。以下为当时记录：：完整台风密度进场景程序会让场景冷编译 65 → 103 s，所以云影 / 探针只用不采样纹理的大形。已知偏差：雨带阴影缺相位扰动与断续遮罩（偏约 ±1/4 带间距、断处仍有影），眼壁阴影缺 shape / bump（几公里），眼底层积云无阴影。巡航高度基本看不出；改云影时别把完整密度塞回场景程序。
- **表面细化必须退回到最近一个空白采样点**（T04 修 T03）：固定退回 2dt 会反复「撞上 → 退回」到步数上限，远处出现等高线条纹；完全不退回又会漏检成平行明暗条纹。另：高度场只能用水平切片噪声（3D 噪声会让塔身上下断开成漂浮团块）；按固定高度间距量化的台阶从高处看是等高线地图。
- **`FRAG_PREFIX`（`lint-shaders.mjs`）的片元输出必须写 `layout(location = 0)`**：不写的话`glslangValidator` 不会报错（`check:glsl` 测不出来），但真实 ANGLE 编译 `cloud-march` 这类自己声明了 `layout(location = 1) out ...`（MRT）的程序会报 `EXT_blend_func_extended` 相关错误——GLSLES 3.00 规定一旦有多个片元输出，全部输出都要显式给 location。这也说明「静态语法校验通过」不能100% 代表「真实浏览器编译一定过」，MRT 相关的坑目前只能靠真实浏览器验证一次来兜底。
- **换预设后紧接着设高度，会被上一个地点的高度下限夹住**（T18）：回归脚本在同一帧里先切预设再设高度，这时 `state.floor` 和滑块 `min` 还是旧地点的，浏览器把 0.6 夹成了 2.6。修法：换预设 / 开关真实地理时立刻 `resetAltitudeFloor` 并同步滑块 `min`。识别：海上场景的高度恰好等于上一个陆地场景的下限。
- **霾（T18）的相函数要比背景米氏更「钝」**：沿用 g = 0.8 时侧光下霾层比地平线的瑞利天空还暗，霾线看不出来；霾单独用 g = 0.7（`HAZE_G`）。霾的 uniform 虽然在 `ATMOSPHERE_COMMON` 里，但只有 LUT 程序调用 `sampleMedium`，场景 / 云程序里不可达。
- **离线 fxc 计时对系统负载很敏感**：同一份程序在不同时刻测，`/O1` 编译时间可能差 20% 以上（本机被其他代理占用 GPU/CPU 时更明显）。用 `shader-budget.mjs` 的数字和浏览器冷编译对照时，两次测量要紧挨着做，中间不要插其它重活；同一个 `--bisect` 批次内部的相对比较不受影响（都在同一时刻测）。
- **场景拆成窗外 + 舱内两个程序以后（SC-5），改哪个文件重编哪个程序**：浏览器按程序的源码文本命中缓存。舱内程序（scene.ts）拼的是 cabin*.glsl.ts、seats.glsl.ts、wing.glsl.ts（ggxD / smithG）、lights、atmosphere；窗外程序（outside-pass.ts）拼的是 clouds.glsl.ts、ocean / ground / terrain / traffic / lightning / stars / islands、lights、atmosphere、noise.glsl.ts。
  d3d11 实测（RTX 5090）：只改 `cabin-shading.glsl.ts` 一个常数，重载后这一批编译 3.2 s；只改窗外一个常数 7.9 s；真冷全部 9 s 左右（原来单个场景程序约 20 s）。
  以后别把窗外模块拼进舱内程序（例如为了一个 uniform 拼整份 CLOUD_COMMON；舱内只需要 `uCoverage` 就单独声明），反之亦然，否则改一处两个都重编。两边都要的小工具放 noise.glsl.ts。
- **拆程序、换写法后做逐像素对比，海面闪光和城市夜光会有成片的单像素翻转，这是正常的**：它们按世界坐标取 hash 决定亮不亮，视线方向差 1 ulp（换一种编译顺序就会差这么多）就会让格子边界上的像素换一个 hash。
  SC-5 的校准：master 与「只给 rdW 多做一次 normalize 的 master」对比，night-city 平均相对差 3.95e-4、sunset 单像素最大相对差 0.96，和 master 与 SC-5 的差（3.93e-4、0.92）是同一量级；而天空、云、舱内这些没有 hash 的部分逐位一致或只差 1e-5。
  判断方法：差异是否两个方向都有（A 比 B 亮和 B 比 A 亮的像素都有）、是否集中在闪光 / 夜光这类稀疏亮点上、与「1 ulp 扰动」的校准是否同量级。系统性的错误会是单向的、成片的。
- **机翼自阴影用的距离场必须处处是真实距离的下界，包围要覆盖各个方向**（T22）：襟翼滑轨整流罩旧版只按展向 `|z − zf|` 包围，翼面上方几米高的点也只报几十厘米；软阴影估计 `14·d / 走过的距离` 把它当成「擦边」，整片上翼面被压暗，而且按步进采样离散成一圈圈年轮纹（夜景最明显），穿云时成迷彩块，小翼上成竖向分面、像镀铬。识别：`uWingDebug` 的 8（去自阴影）一开纹就没了；1（去鼓包）、4（去环境反射）无效。修法：包围加上竖直方向，最终距离再对包围取大兜底。改任何部件的距离场后都用 8 位对照一次。
- **球体追踪贴着表面掠射时步数会爆**（T22）：外轮廓附近的射线几乎和翼面相切，每步只挪近一点；边缘超采样的子射线从半路出发、64 步走不到前缘，四条都算「没打中」，像素整个露出背景，前缘外轮廓成了 1 像素的硬台阶。全局加步数能修，但机翼 pass 慢 40%。修法：外轮廓（非内轮廓）的子射线从命中点前 16 像素处出发；中心射线「还在逼近」时步数可以延长。对照开关：`uWingDebug` 的 64 / 128。
- **窗板对舱内的反射要有结构**（T24）：均匀的侧壁亮度会在夜里窗外暗时变成一层无结构的灰纱。现用 `cabin-reflect.glsl.ts` 沿镜面方向与简化舱内盒子求交（灯槽、行李架、对面洗墙光与暗舷窗、座椅暗区、自己头肩暗剪影），按「瞳孔 + 1.7° 角弥散 × 虚像距离」虚化；白天倒影低于窗外 0.3% 时整段跳过。坑：洗墙光在灯高处硬截断，不先按虚化宽度摊平会成一条刺眼白线；近处座椅按平面算的虚化太小，要给 0.25 m 下限；头按「被灯照亮」着色会成发亮的蛋，要画成暗剪影。
  **T34 修正**：暗剪影在开灯时读成倒影正中的「黑洞」，一刀切的 1.7° 虚化又把灯带抹成「天边的糊带」。现在按层虚化（大面 0.7°、边和亮线 0.35°、阅读灯光点 0.1° + 像素下限），开灯时头肩只是把背后的倒影压暗 13%、边缘按 3 倍虚化的一片（画成被照亮的脸 + 头发 + 肩膀试过，仍读成发亮的浅色蛋，协调者否掉），睡眠 / 全关不画头。
- **倒影「不比来源亮」不等于「不比屏幕上的舱壁亮」**（T34）：T30 的 ⑦ 只限曝光差，睡眠档倒影的来源（紧挨氛围灯的侧壁）比可见舱壁亮 30 倍，倒影在屏幕上仍是舱壁的 2.8 倍。修法：`exposure.ts` ⑧ 按显示亮度加硬上限（面状倒影 ≤ k · 舱内均值，暗处 k = 0.2），阅读灯光点不进上限。识别：`handoff/T34-stats.py` 看「面/墙」。
  坑一：上限公式里 `log2(窗外亮度)` 夜里是 −inf，乘权重 0 得 NaN，NaN 进测光后整屏曝光崩（舱壁一起跳）——log 的参数先 max 一个小正数。
  坑二：切 `uDebug` 拍调试图时适应还在走，窗外置黑几百毫秒后曝光就变了；拍之前把 `exposure.adaptMat.uniforms.uDt` 钉成 0。
- **色适应的白点不能用灰世界**（T28）：舱内平均色含饰面本身的暖白，直接当白点会把暖白抵消成冷灰；要除以饰面平均反照率得到光源色。测光像素上的串行采样很贵（测光 pass 只有两个像素、无法并行），高光排除用上一帧适应亮度判断、只跑一遍。
- **GPU 耗时看的是 warp 里最慢的那条射线**（PERF-3）：边缘超采样贵在求交步数的长尾，不在着色（把子射线着色换成常数只省 0.01–0.02 ms）；要压步数上限而不是平均值。`shadowSteps=0` 曾经并不跳过阴影段，只是少算了循环总数。
- **对比截图前冻结翼尖姿态**：`uWingFlex` 每帧按时间摆动（turbulence 0 也在动），同一端口前后两张图边缘会错开 1 像素；1:1 对比要把它冻结。同一版本前后两次截图也可能差一两颗云 / 海面高光，看到亮点先同版本再拍一次确认。
- **测「省了多少」要带关掉该功能的对照组**：只看总时间会被别处的开销（例如多开的数组让所有像素都慢 0.02 ms）误导。
- **MRT 程序在 ANGLE / D3D11 上并行编译后，第一次 draw 会同步重编整个像素着色器**（与绑哪个目标无关，PERF-1）：云步进曾因此冷启动卡 4.7–8 s。新程序尽量单输出，需要第二个量时用深度附件（gl_FragDepth）或打包。识别：冷启动里某个程序第一次 draw 卡住的时间 ≈ 它一次完整 FXC 编译的时间。
- **three 的 3D 渲染目标每画一层都会按 generateMipmaps 重新生成整张 mipmap**：只在最后一层打开。用 mip 做「膨胀」最多到 mip 2（R8 下 mip 3 会把单个有云格点舍成 0）。
- **云影要插值透射率，不能插值光学厚度再取 exp**（边缘会变回一刀切）；太阳低时影子对光源方向极敏感，云影图重建阈值要到 0.01° 量级。
- **同页 `material.clone()` 做 A/B 计时，排第一个的场景数字不可信**（能差 2 倍，根因未明）；最终数字用两个端口整轮交替测。
- **three.js 的输出抖动（dithering）会在自相关里冒充周期峰**（T32）：在 (6,−1)/(6,−3) 处留 0.5–0.9 的假峰（舱壁上也有）。查纹理周期要先滤掉 5 px 以下成分；带通自相关的底噪约 0.13–0.19，「≤0.05」只适用于已知周期位移。
- **细节噪声周期太短时，中远处 mip 滤掉细级只剩最低一级，就是规则格子**（T32）：云细节噪声 0.9 km 周期曾导致云海一排排等距小云团；已改世界坐标随机平铺。雷暴 / 台风细节侵蚀、云街（纯 4 km 正弦）仍是周期的，留意。
- **有雷暴 / 台风时开销与距离无关**（T33）：场上一有天气系统，每个像素都切到天气模式（云壳撑到 0–15/20 km、近水平视线空走几百公里）。判断先做「放到 2000 km 外」的对照。现按视线是否够得着天气系统分路径。
- **步数用完会表现成纱窗点阵 + 直边透明方盒**（T33）：用完位置随像素抖动变 → 半透明点阵，连起来是直边。识别：临时调大上限看是否变实心。天气模式上限 448、普通云 192。
- **眼墙顶沿后面露出一根水平「栏杆」**（T37）：从台风眼往外看，顶沿后方任何一层处处等高的云顶（卷云盖顶约 16 km）在顶沿低处都会露成光滑横管。识别：只关卷云盖看管子是否消失。修法：卷云盖顶在眼壁附近压到顶沿以下、随顶沿起伏，探针 / 云影用同一个高度函数。
- **往上加细节会飘出碎云**（T37）：眼壁内壁随高度起伏时，在顶沿高度往上叠细尖峰会切出悬空小片。细节只往下刻。
- **找塔窗口截出直边**（T37）：雨带找塔的 3×3 窗口只完整覆盖离塔心约 13 km，砧 / 侧泡伸得更远就被截成直线。高处窗口顺高空风偏移 5 km；新加部件先核对窗口够不够。
- **相机紧贴稀薄云层底面时步进变贵**（T37）：给卷云盖底面加丝缕软化使 typhoon-outer 涨 35%（+0.7 ms），因为相机正下方多出大片稀薄云、步进要走细。已撤回；这类改动先用按 pass 的 GPU 计时（handoff/T37-variants-cost.mjs）逐项归因。
- **舱内只乘直射透射率会发蓝发暗**（T31）：被云挡掉的直射要按二流近似补成白色漫射；探针用的台风大形卷云盖高度要和完整版一致。
- **Web Audio 的 DynamicsCompressorNode 自带补偿增益**（T11）：规范里压缩器按阈值 / 比率自动抬高输出（阈值 −6、比率 12 约 +3 dB），拿它当兜底限幅器时，所有安静的声音也被抬了。噪声床的高斯峰值因数 4–5 σ，床本身若放在 −17 dBFS 就会一直碰阈值。
  修法：噪声床放到 −26 dBFS（音量 100%），压缩器改阈值 −3 / 比率 20（补偿约 +1.7 dB），只有近雷碰得到。识别：`scripts/audio-check.mjs` 的峰值列应比阈值低 4 dB 以上。
- **OfflineAudioContext 一次性预排所有事件会把 CPU 量大**（T11）：离线渲染前就把 60 秒的几十个闷响全建好，它们的滤波 / 增益节点从 0 秒起就在图里，量出 4.6% 核；实时只预排 0.3 秒，真实开销约 2%。
  修法：量 CPU 时用 `ctx.suspend(t)` 每 0.25 s 停一下再 `update`，和实时一样滚动排程（`scripts/audio-check.mjs` 的 `cpu()`）。
- **面板雷暴摆在 55–75 km 外**（T11）：雷声按 340 m/s 延迟近三分钟，隔着机舱本来也听不见。声音把打雷的距离上限放到 90 km，远雷只剩 90 Hz 以下、低于底噪约 11 dB 的闷响（一片断续的低沉滚动）；想听清楚的雷要导演把雷暴摆近（10 km 内雷声在 150 Hz 以下与底噪相当或更响）。
- **headless 里听不见声音，但可以离线分析**（T11）：`node scripts/audio-check.mjs [--port 5211]`（没有开发服务器会自己起 vite）直接打开 `/src/audio.ts` 这个地址（同源、不启动渲染器）再动态 import，用 OfflineAudioContext 渲染各状态并输出倍频程表 / A 计权 / 峰值 / 左右相干度到 `tmp/audio-check/spectra.json`。页面上那条 404 是 favicon，无关。
- **只抬高可见度阈值、不改画出来的底色，银河几乎不会变淡**（T09）：城市人工天光和舱内光幕没有画进天空，按真实背景算出的阈值只砍掉超出部分的一点点（城市里 C ≈ 0.7、阈值 0.08 → 还剩 88%），画面上的对比度照旧。修法：再乘「画出来的底色 ÷ 真实底色」，让银河相对画面底色的对比度等于真实对比度（`milkyWayVisibility`）；月光照亮的天空本来就画在底色里，这一项对它是 1。识别：强行把 `uSkyGlow` 设成几倍夜天光，截图里银河几乎不变。
- **回归场景的日期默认是「今天」，夜景的月相每天不同**（T09）：场景只设 `time` 时日期沿用页面打开那天，月亮在不在天上、多亮随运行日期变，夜间场景的基线不可比。要稳定的夜景写 `date`（`applyScene` 对日期框发 `change`，没写 `date` 的场景恢复成页面打开时的日期）。选银河场景的办法：用 astronomy-engine 扫全年「太阳 < −18°、月亮 < −5°、人马座大星云高 4–16°、方位对着窗」，本仓库的 `night-sea-milkyway` 就是这样挑出来的（南海、左座朝东南、2026-05-15 22:30）。
- **窗板高度只看得到仰角约 20° 以下的天**（T09）：默认头位下窗上沿约 +20°，银河要低低地在窗里才看得见；判断「银河出没出来」先算它的高度角和方位，别先怀疑着色器。
- **`svs.gsfc.nasa.gov` 的 TLS 握手在本机经常失败**（T09）：Git Bash 的 curl（schannel）直接 `SSL/TLS connection failed`，Python 的 urllib 也会间歇 `UNEXPECTED_EOF_WHILE_READING`；重试几次就好（`build_milkyway.py` 自带重试）。

- **掠射的侧壁不能用一个各向同性的像素足迹淡出纹理**（T35）：「看前方 / 看后方」时视线贴着侧壁，像素只在「视线在墙面上的投影方向」被拉长 1/cos，垂直方向不拉长。原来的 `t·pixAng / max(cos, 0.2)` 让所有细纹一起被抹平（画面上是一整片平灰墙），而在 cos < 0.2 的地方又欠估足迹、会闪。修法：`shadeWall` 算出 `pixX` / `pixY` 两个方向的足迹，沿 x、沿 y 变化的纹理和缝各按自己的淡出。识别：斜看的墙面上横纹、竖纹同时消失，或者只在极掠射处出现摩尔纹。
- **座椅几何往正面长，就会挤进默认坐姿的画面**（T35）：本排头枕的正面离眼睛的横向视角只比视场边缘多 2°，商务舱头枕往前加厚 1 cm、护翼再鼓 2.8 cm，画面右下角就多出一大块模糊的浅色皮。修法：加厚改成往背后，护翼只往前 2 cm。识别：改了 `seatSection` / `sdSeatBack` 以后，默认坐姿（head = [0, 0.02, −0.42]）拍一张，和 master 对照（`handoff/T35-shots.mjs --only biz-seated,econ-seated`）。
- **Windows 上 Python 写回源文件会变成 CRLF**（T35）：`open(p, 'w')` 在文本模式下会把 `\n` 写成 `\r\n`，提交时 git 会提示 "CRLF will be replaced"。修法：读写都加 `newline=''`。识别：`grep -c $'\r' 文件` 不是 0。
