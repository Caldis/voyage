# 着色器编译时间专项（开发体验官，2026-09-26）

> 用户原话：「每次编译着色器都特别久，严重影响了开发效率。这个有解吗？一般 3A 游戏开发的时候，改个东西要这么久？他们怎么做频繁的验证？」
>
> 测量环境：Windows 11、RTX 5090（驱动 616.64）、32 线程 CPU；Chromium 148.0.7778.96（Playwright 缓存的完整 chrome.exe，新版 headless，真实 GPU），视口 1600×1200。
> 主分支 dev server 5181：ANGLE 后端对比时是 `fa77f8d`，浏览器内原型与缓存测试时已前进到 `b6b2cb1`（T20 合入），两处分别注明。
> 「真冷」= 每个着色器注入随机 nonce，强制缓存不命中。按协调者新规，每个方案测一次。本机 GPU 同时被其他代理占用（采样时占用 12–99%），浏览器内的数字有 ±10–15% 的噪声。
> 离线 FXC 计时只用 CPU，不受 GPU 争用影响，但并行跑多个编译时单个会变慢，所以**只比较同一批里的数字**。
> 实验脚本、截图和导出的 HLSL 在 `tmp/screenshot/dx-shader/`（已被 git 忽略），没有改仓库里的任何代码。

## 一、结论先行

**这个问题有解，而且三步就能从约 90 秒降到几秒到十几秒。**

| 排名 | 方案 | 实测效果 | 代价 |
| --- | --- | --- | --- |
| 1 | **开发时让浏览器走 Vulkan 后端**（`--use-angle=vulkan`），不再走 D3D11 + FXC | 真冷启动 **97.7 s → 5.4 s**（快约 18 倍），画面与 D3D11 一致 | 不用改代码。风险是 D3D11 才有的问题会被藏住（sampler 上限 16、FXC 编译暴涨、X3595），所以**交付验收仍在 D3D11 上做** |
| 2 | **`oceanRadiance` 只内联一次**：现在地面路径里的水体又调了一次整份海面着色（`terrain-shading.glsl.ts:124`），FXC 在两个调用点各展开一份 | 浏览器内场景编译 **82.8 s → 31.9 s（−61%）**；离线同批 88.9 s → 49.4 s | 小改动，要重构 `groundRadiance` 与 `outsideRadiance` 的返回值。**用户首次打开也跟着变快** |
| 3 | **把场景着色器拆成「窗外」和「舱内合成」两个 pass**（沿用 T05 拆机翼的做法） | 离线：窗外部分（已去重海面）14.6 s、舱内部分 4.6 s，两个程序并行编译 → 冷编译约 15–20 s；改舱内只重编约 5 s 的那个程序 | 多一张全分辨率 HDR 目标（1600×1200 的 RGBA32F 约 31 MB，读写带宽在 5090 上不到 0.1 ms）。舱内程序会腾出多个 sampler，顺带缓解 16/16 的压力 |

另有两条小的：云光线步进程序现在是**在场景编译完之后才串行编译**（约 6.5–7 s），把它放进同一批并行编译，每次冷启动能再省约 6 s。
开发态特性隔离（`?dev=cabin`）原型实测场景编译只要 **5.9 s**，但有了 1 和 3 以后价值不大，列为可选。

**要回答用户的问题**：3A 团队改一处也要等编译，但他们几乎从来不在内循环里等「整份超级着色器 + 满优化」的冷编译。
他们靠四件事：内容寻址缓存（只编改动的那个排列）、开发态降优化、异步编译加占位材质、把巨型着色器拆开或用少量精心控制的 uber shader。
我们现在同时踩中了反面：一个巨型程序、FXC 满优化、重函数多处内联，而且每次都等它编完。上面三个方案分别对应「换编译器」「消重复内联」「拆小」。

## 二、ANGLE 后端实测（问题 2）

主分支 `fa77f8d`，私有 headless，每个后端测两次（后来按新规改为测一次）：

| 后端（`--use-angle=`） | 真冷启动总耗时 | 其中编译 | 画面（noon-cumulus） | 帧时间（benchFrame，CPU 计时，有 GPU 争用） | 能用吗 |
| --- | --- | --- | --- | --- | --- |
| `d3d11`（Windows 默认，FXC） | **97.7 s** / 102.9 s | 场景 + 机翼后台编译 88.2 / 93.0 s，首帧 7.6 / 8.0 s | 基准 | 5.15 / 2.78 ms | 能用，就是慢 |
| `vulkan` | **5.4 s** / 6.4 s | 首帧同步编译 3.9 / 4.4 s（这个后端没有 `KHR_parallel_shader_compile`，编译在首帧里做） | 与 d3d11 一致：舱内、天空平均差约 0.1 级灰度，差异只在随时间变化的海面和云（两张截图的时刻不同） | 5.25 / 5.00 ms | **能用，快约 18 倍** |
| `gl`（Windows 上的 NVIDIA OpenGL） | 不可用 | 场景程序链接失败 `VALIDATE_STATUS false`，日志为空，画面全黑 | — | — | 不可用 |

帧时间受其他代理占用 GPU 影响太大，两种后端之间看不出可靠差别。这个后端只用于开发内循环，所以帧时间不是决定因素。

截图：`tmp/screenshot/dx-shader/noon-cumulus-d3d11.png`、`noon-cumulus-vulkan.png`。

### 两个后端的关键差异（切换的主要风险）

| 项 | d3d11 | vulkan |
| --- | --- | --- |
| `MAX_TEXTURE_IMAGE_UNITS` | **16**（场景着色器已用满 16/16：HLSL 头里 `textures2D[8] + textures2DArray[4] + textures3D[4]`） | 32 |
| `MAX_FRAGMENT_UNIFORM_VECTORS` | 1024 | 4096 |
| `KHR_parallel_shader_compile` | 有 | **没有** |
| FXC 专属问题（常量循环展开、多调用点内联导致编译暴涨、`X3595` 循环或分支里的导数、编译超时丢上下文） | 会出现 | **不会出现** |

也就是说，在 Vulkan 上开发时，第 17 个 sampler、超过 1024 的 uniform、编译时间暴涨和 X3595 都**不会报错**，而用户和默认 Chrome 走的是 d3d11。
所以 Vulkan 只能用在开发内循环。交付前的验收（冷编译预算、sampler 计数、控制台无 error）仍要在 d3d11 上做一次，下面 SC-2 的离线工具能不开浏览器就把这几项查掉。

### 有没有降低 FXC 优化级别的开关：没有，但离线量出了它的价值

- chrome://gpu 里列出的 ANGLE D3D11 feature 共约 55 个（`tmp/screenshot/dx-shader/gpuinfo-d3d11.txt`），**没有**一个控制 FXC 编译标志；相关的只有 `cacheCompiledShader`、`disableProgramCaching` 这类缓存开关。
- ANGLE 源码（`HLSLCompiler.cpp` / `ProgramD3D.cpp`）按「默认标志 → 跳过校验 → 跳过优化」的顺序逐级重试。`D3DCOMPILE_SKIP_OPTIMIZATION` **只在前面的配置编译失败时**才用到，是容错手段，不是开发开关（调研子代理根据源码与多个 issue 里的 ANGLE 日志交叉确认；没有找到命令行开关，这一条是推断）。
- 离线用 Windows SDK 的 `fxc.exe` 编译 ANGLE 翻译出的场景像素着色器，同一批次对比：`/O1` 103.7 s、`/O0` 103.7 s、`/O3` 104.5 s，**`/Od`（跳过优化）9.9 s**。另一批里 `/O1` 88.9 s 对 `/Od` 7.1 s。
  所以约 90% 的时间花在 FXC 的优化器上。浏览器里用不上这个开关，但**离线预算工具可以用 `/Od` 在 7–10 s 内确认「能不能编过」**（见 SC-2）。

### 给用户：现在就能做

**推荐：单独开一个开发专用的 Chrome 窗口，只让它走 Vulkan**，不影响日常浏览：

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --user-data-dir="$env:LOCALAPPDATA\voyage-dev-chrome" --use-angle=vulkan http://127.0.0.1:5181
```

打开后在地址栏输入 `chrome://gpu`，搜 `GL_RENDERER`，看到 `ANGLE (NVIDIA, Vulkan ...)` 就生效了。可以把这行命令存成桌面快捷方式。

**另一种（全局切换，日常浏览也跟着变）**：地址栏打开 `chrome://flags/#use-angle`，把「Choose ANGLE graphics backend」改成 **Vulkan**，点右下角 Relaunch；想改回来就选 Default。
风险：会影响所有网页。Windows 上 Vulkan 不是 Chrome 的默认路径，Chromium 的 issue 列表里有个别「angle vulkan 卡死」的报告（issues.chromium.org/41466697）；再加上上面那张差异表会把 d3d11 的问题藏住。所以更推荐单独开一个开发窗口。

**交付前**：在默认（d3d11）的浏览器里打开一次，或者跑 `dev-browser.mjs cold`（默认就是 d3d11），确认冷编译预算和控制台没有 error。DEV_SOP 的验收要求不变。

## 三、离线 FXC 二分：时间花在哪（为问题 3、4 提供依据）

方法：从浏览器抓到 three.js 实际提交的场景片元着色器 GLSL（`fa77f8d`），在 GLSL 里把某一块换成桩函数，放到 d3d11 的 `about:blank` 页里**只翻译不链接**（1 秒内拿到 ANGLE 的 HLSL），再补全 ANGLE 的输出占位符，用 `fxc.exe /T ps_5_0 /O1` 计时。
校验：未改动的 `full` 翻译结果与浏览器实际翻译逐字一致（数字以外），离线 `/O1` 88.9 s 对浏览器内 88.2 s，**离线计时能代表浏览器**。

| 变体（换成桩的部分） | 离线 FXC `/O1`（批 A：9 路并行） | 批 B（5 路并行，定稿对照） |
| --- | --- | --- |
| 全量 | 130.8 s | **88.9 s** |
| 去掉地面（`uGroundOn` 分支） | 34.7 s | |
| 去掉主海面调用 | 70.5 s | |
| **去掉地面里的那次海面调用（= 海面只内联一次）** | 80.4 s | **49.4 s** |
| 两处海面都去掉 | 28.4 s | |
| 去掉交通机 + 闪电 | 89.0 s | 39.6 s（在去重海面的基础上） |
| 只去交通机 / 只去闪电 | 86.4 / 94.1 s（批 C，全量 97.4 s） | |
| 去掉座椅 / 侧壁 / 窗洞内衬 / 遮光板 | 113.6 / 123.3 / 116.0 / 128.5 s | |
| 舱内四块全去 | 66.1 s | |
| 窗板细节（划痕、油污、擦痕、水珠） | 107.3 s | |
| **窗外全换桩 = 只剩舱内与窗板** | 5.1 s | **4.6 s** |
| **舱内全换桩 = 只剩窗外** | 45.5 s | **14.6 s**（在去重海面的基础上） |
| 只剩海面 + 天空 | 5.0 s | |
| 只剩地面（地面里仍带一份海面） | 10.9 s | |
| 全部换桩（下限） | 0.2 s | |

读法：

1. **编译时间对程序规模是超线性的**。舱内单独 5 s、窗外单独 15 s，合在一个程序里是 89 s。拆开比删功能有效得多，这也和 T05 拆机翼（104 s → 55 s）的经验一致。
2. **最大的一块是「海面被内联了两次」**：地面路径里的水体（`terrain-shading.glsl.ts:124`）和主路径（`scene.ts` 的 `outsideRadiance`）各内联一份 `oceanRadiance`，而每份里又带一份 `cloudShadow`。去掉其中一次，全量从 88.9 s 降到 49.4 s。
   这正好违反了 README 坑点里「重函数只调用一次」那一条，但 `oceanRadiance` 不在那条列出的重函数名单里，所以没被发现。
3. 交通机（循环 2 次）约占 11%，闪电约 3%，舱内各块各占 2–13%，都不是主因。

## 四、开发态「特性隔离」原型（问题 3）

**浏览器内实测**（主分支 `b6b2cb1`，运行时替换着色器源码，没有改文件）：

| 场景程序 | 场景着色器后台编译 | 真冷启动总耗时 | 画面 |
| --- | --- | --- | --- |
| 主分支原样 | 82.8 s | 92.2 s | 基准 |
| 海面只内联一次（原型：地面路径里的水体换成近似色） | **31.9 s** | 42.0 s | noon-cumulus 正常；有地面的场景没核对，因为原型只是近似 |
| `dev=cabin`：窗外换成「天空 LUT × 云透射率 + 云」，去掉交通机和闪电 | **5.9 s** | 15.5 s（其中 6.8 s 是串行的云程序编译） | 舱内完整；窗外没有海面高光，地平线处有一条色带（`tmp/screenshot/dx-shader/noon-cumulus-d3d11-devcabin.png`） |

**可行性**：高。需要改的文件：

- `src/render/scene.ts`：`main()` 里的四五个调用点包上 `#ifdef DEV_STUB_OUTSIDE` / `#ifdef DEV_STUB_CABIN`。窗外桩是 `view = skyRadiance(rdW, rdW.y < 0.0) * cloud.a + cloud.rgb`，交通机和闪电换成零；舱内桩是座椅覆盖率 0、侧壁和遮光板用常数反照率乘 `eCabin`、跳过 `marchFunnel`。
- `src/main.ts`：读取 `?dev=` 参数，给 `sceneMat.defines` 加上宏（`GroundDetailVariant` 已经演示了用 defines 做变体）。
- 预计编译时间：`dev=cabin` 约 6 s（实测），`dev=outside` 约 15 s（离线，需要先去重海面，否则约 45 s）。

**但不建议优先做**：Vulkan 后端不改代码就能让全量编译只要约 5 s，SC-5 拆 pass 以后，默认构建里改舱内本来就只重编约 5 s 的那个程序。
特性隔离只在「必须在 d3d11 上反复验证某一块」时有价值，列为可选（SC-6）。

## 五、继续拆分超级着色器（问题 4）

| 拆法 | 收益（离线同批估算） | 代价 | 优先级 |
| --- | --- | --- | --- |
| **先去重海面（不拆）** | 场景 89 → 49 s（浏览器实测 83 → 32 s） | 几乎没有：重构返回值，画面应当逐像素一致 | **第一** |
| **窗外 pass + 舱内合成 pass** | 两个程序并行编译，墙钟约 max(15, 5) ≈ 15 s；改舱内只重编约 5 s，改窗外只重编约 15 s；低空细节变体 `GROUND_DETAIL` 只需要重编窗外那个程序 | 多一张全分辨率 HDR 目标（RGBA16F 约 15 MB、32F 约 31 MB，5090 上读写不到 0.1 ms，核显上要实测）。窗外 pass 要自己算窗口遮罩，窗外看不见的像素提前退出，否则会白算整屏。机翼的 alpha 打包留在舱内 pass（`viewPre` 改为从窗外纹理读）。舱内程序不再需要地面 clipmap、海面 FFT、大气透视、星图、月亮等 sampler，**16/16 的压力随之解除** | **第二**（在去重之后做，两者都要改 `outsideRadiance`） |
| 窗外再拆成地面 / 海面 | 去重后窗外只有 15 s，再拆收益小；地面分支本来就是按 `uGroundOn` 提前返回 | 又多一张目标，合成更复杂 | 不做 |
| 舱内再拆（座椅 / 侧壁） | 舱内只有约 5 s | 不值得 | 不做 |

## 六、浏览器着色器缓存命中（问题 5）

d3d11，同一个浏览器上下文（主分支 `b6b2cb1`）：

| 步骤 | 总耗时 | 场景着色器 | 云光线步进程序 |
| --- | --- | --- | --- |
| 全部真冷 | 85.6 s | 75.8 s | 6.8 s |
| 什么都不改，刷新 | **1.4 s** | 0.1 s | 0.04 s |
| **只改云程序**（只给含 `uCloudResolution` 的两个着色器换 nonce） | **8.7 s** | **0.1 s（命中）** | 7.0 s（重编） |

结论：缓存**按程序、按源码内容**命中，改一个程序不会让其他程序失效。调研子代理查到 Chrome 的程序缓存键是各着色器源码的 SHA1 组合，与实测一致。
坑在于**哪些程序共用了同一段源码**：

- `CLOUD_COMMON`（`clouds.glsl.ts`）拼进了场景、机翼、云三个程序，改它会**三个一起重编**。
- `WING_COMMON`（`wing.glsl.ts`）拼进了场景和机翼两个程序。
- `ATMOSPHERE_COMMON` 拼进了几乎所有程序。
- 只有 `clouds.ts` 里云程序自己的 `main`、`wing-shading.glsl.ts` 这类只属于一个程序的文件，改了才只重编一个程序。

所以「改云会不会重编场景」取决于改的是哪个文件：改 `clouds.glsl.ts` 的密度函数会，改 `clouds.ts` 里的步进 / 时域累积不会。SC-5 拆开以后，把公共函数按「谁真正需要」拆细，命中率还能再高。

## 七、业界做法对照

| 业界做法 | 要点 | 对应到我们 | 出处 |
| --- | --- | --- | --- |
| 着色器缓存 / DDC（本地、共享、云） | 编一次，全队复用；按内容哈希寻址 | Chrome 的程序缓存已经在做（第六节实测），我们缺的是「少让共享源码牵连多个程序」 | [UE：Using DDC](https://dev.epicgames.com/documentation/en-us/unreal-engine/using-derived-data-cache-in-unreal-engine) · [Unreal Cloud DDC](https://learn.microsoft.com/en-us/gaming/azure/unreal-cloud-ddc/overview) |
| 增量编译，只编改动的排列 | ShaderCompileWorker 按排列编译；Unity 只编场景里实际用到的 variant | SC-5 拆 pass 后，改舱内只重编舱内程序 | [UE：Debugging the Shader Compile Process](https://dev.epicgames.com/documentation/en-us/unreal-engine/debugging-the-shader-compile-process-in-unreal-engine) |
| 开发态降优化（`r.Shaders.Optimize=0`、fxc `/Od`、DXC `-O0`） | 编译快一个数量级，只在调试时用 | 浏览器里没有这个开关；**换成 Vulkan 后端是等效的开发态捷径**；离线工具可以用 `/Od` 在 7 s 内确认能否编过 | [D3DCOMPILE 常量](https://learn.microsoft.com/en-us/windows/desktop/direct3dhlsl/d3dcompile-constants) · [Tom Looman：UE 着色器编译提速](https://tomlooman.com/unreal-engine-optimize-shader-compile-time/) |
| 异步编译 + 占位材质 | Unity 用青色占位 shader，编完再替换；UE 用 DefaultMaterial 兜底 | 我们已有 `KHR_parallel_shader_compile` + 加载遮罩；`GroundDetailVariant` 就是「先用默认材质、变体编完再切」的同一模式 | [Unity：异步着色器编译](https://docs.unity3d.com/6000.1/Documentation/Manual/AsynchronousShaderCompilation-introduction.html) |
| 热重载（`recompileshaders changed`、Live++） | 只重编改动的、正在用的着色器，不重启 | Vite 热更新整页刷新 + 程序缓存，未改动的程序 0.1 s 命中，已经接近；瓶颈在被改的那个程序太大 | [RecompileShaders](https://indxzero.github.io/ue544cvarwiki/articles/recompileshaders/) · [Live++](https://liveplusplus.tech/) |
| 编译农场（Incredibuild / FASTBuild / XGE） | 分发到多台机器；社区经验是着色器分发常被调度开销吃掉 | 不适用：WebGL 的编译在浏览器 GPU 进程里，没法分发 | [Incredibuild for UE](https://www.incredibuild.com/unreal-engine-acceleration) |
| uber shader 与特化的取舍 | DOOM Eternal：全游戏约 100 个着色器、350 个 PSO，靠少量受控的 uber shader 保证迭代快；Destiny 的特化排列曾膨胀到数百上千种 | 我们的「一个程序装下整个画面」走到了 uber 的极端，而且没有控制内联。合理的点在中间：按 pass 拆成 3–4 个中等程序（SC-5） | [SIGGRAPH 2020：Rendering DOOM Eternal](https://advances.realtimerendering.com/s2020/RenderingDoomEternal.pdf) · [GDC 2017：Destiny Shader System](https://advances.realtimerendering.com/destiny/gdc_2017/Destiny_shader_system_GDC_2017_v.4.0.pdf) |

## 八、建议排进 TASKS 的任务（可以立即派发，尽量互不冲突）

编号用 SC-*（Shader Compile），协调者可以改成正式编号。SC-1、SC-2、SC-3、SC-4 之间没有文件冲突，**可以同时派**；SC-5 要等 SC-3 合并。

| 编号 | 任务 | 归属文件 | 验收 | 规模 / 冲突 |
| --- | --- | --- | --- | --- |
| **SC-1** | Vulkan 开发内循环：`dev-browser.mjs` 加 `--angle vulkan\|d3d11`（默认保持 d3d11，这是验收口径），启动时打印后端；README「调试」一节写用户的开发专用 Chrome 命令；DEV_SOP 写明「内循环用 vulkan，验收用 d3d11」 | `scripts/dev-browser.mjs`、`README.md`、`DEV_SOP.md` | `cold --angle vulkan` ≤ 10 s，并且 renderer 显示 Vulkan；`cold`（默认）仍然是 D3D11；文档里有两个后端的差异表 | 小 / 不碰 src |
| **SC-2** | 离线着色器预算工具 `scripts/shader-budget.mjs`：用 Vulkan headless 约 5 s 起页，抓全部程序的 GLSL（含已知变体）→ 在 d3d11 的 `about:blank` 里只翻译 → 用 `fxc.exe` 并行计时每个像素着色器（`/O1` 出预算，`--quick` 用 `/Od`）→ 从 HLSL 头统计 sampler 数（`textures2D[n]` 等求和，≤ 16）→ 可选 `--bisect` 按预置桩逐模块计时（本文第三节的方法）。找不到 fxc（例如 macOS）时跳过并提示 | 新文件 `scripts/shader-budget.mjs`，`package.json` 加一行脚本 | 场景程序离线 `/O1` 与浏览器冷编译误差 ≤ 15%；sampler 计数与 d3d11 实际一致（16/16）；`--quick` 全部程序 ≤ 20 s；**不占 GPU，不需要浏览器锁** | 中 / 不碰 src |
| **SC-3** | 海面只内联一次：`groundRadiance` 不再调 `oceanRadiance`，而是返回「命中点、距离、水体标记与水体反照率」；`outsideRadiance` 对地面水体和开阔海面**只调一次** `oceanRadiance`。README「重函数只调用一次」的名单补上 `oceanRadiance` | `src/render/terrain-shading.glsl.ts`、`src/render/scene.ts`（只改 `outsideRadiance`）、`README.md` 坑点 | d3d11 真冷的场景编译 ≤ 40 s（原型 31.9 s，基线 82.8 s）；fuji-day、route-hnd-cts、night-city、low-sea-glint、noon-cumulus 与主分支逐像素对比只剩噪声；帧时间不变差 | 小–中 / 碰 scene（与 T24 改的舱内反射段不在同一处） |
| **SC-4** | 云程序与场景并行编译：把云光线步进（以及海面 FFT、曝光）程序放进启动时同一批 `compileAsync`，各自绑定真正的渲染目标 | `src/main.ts`（启动段），`src/clouds/clouds.ts`（暴露材质与目标） | `__voyageStartup` 里「云光线步进程序编译」≤ 0.5 s；真冷总耗时减少约 6 s；程序数仍然是 1（没有首帧重编） | 小 / 不碰 scene |
| **SC-5** | 拆出「窗外 pass」：新增 `outside-pass.ts`，输出全分辨率 HDR「窗外辐亮度」（窗口遮罩外提前退出）；场景程序只留舱内、窗板和合成，从纹理读 `view`；机翼的 alpha 打包逻辑不变 | 新文件 `src/render/outside-pass.ts`，`src/render/scene.ts`，`src/main.ts` | d3d11 真冷墙钟 ≤ 25 s；只改 `cabin-shading.glsl.ts` 时重编 ≤ 8 s；回归 11 个场景逐像素一致（噪声内）；帧时间 ≤ +3%；舱内程序 sampler ≤ 12 | 大 / 碰 scene、main，**等 SC-3 合并后再做** |
| SC-6（可选） | `?dev=cabin\|outside` 特性隔离（第四节的原型） | `src/render/scene.ts`（`main` 里的宏）、`src/main.ts`（URL → defines） | `dev=cabin` 场景编译 ≤ 8 s；不带参数时着色器源码与主分支逐字一致 | 小 / 碰 scene；有 SC-1、SC-5 以后优先级低 |

顺带一个小项：交通机约占场景编译的 11%，可以在 SC-2 就绪后用 `--bisect` 看看 `trafficRadiance` 里的 2 次循环能不能换成 `uLoopGuard` 写法，不单独立项。

## 九、开发体验反馈（本次专项）

- **最大的发现是方法**：「浏览器只做翻译、离线 fxc 计时」完全不占 GPU，结果和浏览器内一致（88.9 s 对 88.2 s），而且能并行跑十几个变体。这次二分 20 多个变体一共只花了约 7 分钟墙钟。以前的 `#if 0` 加浏览器冷启动二分，一个变体就要约 90 s，还要排队抢 GPU。SC-2 值得优先做。
- `dev-browser.mjs` 能直接复用（我复制了启动与 nonce 注入的逻辑，加了 `--angle`、源码替换、只给部分程序换 nonce），这说明 DX-01 的设计是对的。缺的主要是 `--angle` 参数和「只改某个程序」的缓存测试模式，SC-1 可以顺手加上。
- 坑 1：`WEBGL_debug_shaders.getTranslatedShaderSource` 在 three.js 链接后返回空字符串（three 会删除 shader 对象），要在 `compileShader` 之后立刻取。
- 坑 2：Git Bash 会把单独的 `/O1` 参数改写成 `C:/Program Files/Git/O1`，调 fxc 时要加 `MSYS_NO_PATHCONV=1`。
- 坑 3：ANGLE 翻译出的 HLSL 里带 `@@ PIXEL OUTPUT @@` 等占位符（链接时才生成输出结构），离线编译前要补上；没用到 `gl_FragCoord` 的着色器，入口序言里不能写它。
- 主分支在测量中途前进了（`fa77f8d` → `b6b2cb1`），所以本文的浏览器内原型与基线都重测在同一个提交上，没有和前面的数字混比。
- 这几条坑建议协调者收进 README 的「坑点」一节（本任务只允许写这一个文件，所以没有动 README）。
