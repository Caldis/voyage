# SC-5（+ SC-3b）· 场景拆成「窗外」与「舱内合成」两个程序：交接

- 分支：`worktree-agent-a847f5817aacde68c`（基于 master `cfcb036`，与 master `d0fe8f4` 的 src 相同）；开发服务器 5241（在 apps/voyage 下 `npx vite --port 5241 --strictPort --host 127.0.0.1`）
- 状态：**已交付**，等审查。

## 架构
- **窗外 pass**（新文件 `src/render/outside-pass.ts`）：`outsideRadiance`（从 scene.ts 整段搬来，唯一调用点不变）+ 交通 + 闪电，× 窗板透射率，写到全分辨率目标 `hdrOutside`（有 `EXT_color_buffer_float` 时 32F，只用 texelFetch 读，Nearest；否则半精度并截到 uHdrMax）。
  - 只在本窗窗洞开口且窗板开口以内算：和舱内程序的 `inBezel > 0`、`inPane > 0` 同一公式（`wi == 0`、`dBezel < wB`、`dPane < wP`），放宽到 1.5 倍宽度 + 1e-5，防止两个程序的舍入差漏像素；其余像素写 0 立刻返回。
  - `GroundDetailVariant` 搬到这里，落在窗外程序上；构造时传入 `hdrOutside`，后台编译时绑定真实目标。
- **舱内合成**（`src/render/scene.ts`）：舱壁 / 内衬 / 遮光板 / 座椅 / 窗板效果，本窗窗板以内 `view = texelFetch(uOutside, …)`，其余与 master 一致。不再拼 CLOUD_COMMON、海面、地面、交通、闪电、星星（`uCoverage` 单独声明）。
- **alpha 约定不变**：`viewPre` 仍是「窗外加窗板效果之前」的颜色（= 窗外 pass 的输出，已乘窗板透射率），`paneK`、`packWingRef(outsideMask, col − m·k·viewPre)` 原样；机翼 pass 读合成后的 hdr，m 与 A 语义不变；曝光读机翼 pass 的输出 alpha，也不变。wing-pass.ts / exposure.ts 没改。
- **uniforms**：窗外材质与场景材质共用**同一个 uniforms 对象**（`createOutsideMaterial(sceneMat.uniforms)`），之后 Object.assign 进去的海浪、增升装置 uniform 两边都可见；窗外程序不声明 `uOutside`，没有读写反馈环。
- **公共噪声**：`hash12 / vnoise / hash22 / fbm2` 和 `uLoopGuard` 从 cabin.glsl.ts 移到新文件 `src/render/noise.glsl.ts`（CABIN_COMMON 开头拼它，机翼程序因此文本顺序略变、语义不变）。窗外程序只拼它，不拼 cabin.glsl.ts，改舱内文件不会让窗外重编。
- **main.ts**：compileAsync 批次加 `[outsideMat, hdrOutside]`；每帧先窗外 → 场景 → 机翼；`benchScene(n, "both"|"outside"|"cabin")`；`__voyage` 加 `outsideMat` / `hdrOutside`；启动计时多一项「窗外材质的程序数」。
- **启动清单**：`boot.finish("shaders")` 挪到「批次后第一次 render」之后。这一下冷启动约 4.8 s，原来被记进下一阶段「海面波浪程序」（估算 0.4 s），进度条在那里停住。`DEFAULT_TIMINGS.shaders` 80 s → 30 s。index.html 的清单文字没改（不在归属内）。
- **工具**：`lint-shaders.mjs` 枚举 `scene-default` / `outside-default` / `outside-ground-detail`，三个都做 sampler 审计；`shader-budget.mjs --bisect` 对 `outside-*` 也生效（模块表锚点 SC-3 后已大多失效，本来就会跳过）。

## SC-3b
- `main()` 里 `keyLight(uCamR, upW)` 合成一个 `eKeyUp`。
- 调试 3：`windowIrradiance` 不再在 scene.ts 多调一次，改为 `shadeReveal` 里 `if (uDebug == 3) return eWin;`（改了 cabin-shading.glsl.ts 一处；邻窗的调试 3 现在用邻窗自己的 lAperture，只影响调试视图）。
- `terrainShadow` 16 步、`terrainHit` 二分 6 次改为「常数 + uLoopGuard」。master 只换这份 ground.glsl 与原 master 对比：5 个场景**逐位一致**。

## T18 低空霾的接入点
`outside-pass.ts` 的 `outsideRadiance` 末尾、`return L * cloud.a + cloud.rgb;` 之前，有注释「【大气合成接入点（T18 低空霾）】」。为此把真实地面的提前返回改成 `L = groundFinish(...)` 落到同一个出口：真实地面、开阔海面、天空三条路径都经过这一行（只有调试 21–23 提前返回）。可用量：`L`（云背后的背景辐亮度，地面 / 海面已含空气透视）、`rd`、`hitGround`、`tGround`（km）、`onGround`、`gh`。只写一个调用点，例如 `L = lowHaze(L, rd, hitGround ? tGround : -1.0);`。

## 数字（d3d11，RTX 5090，本机 GPU 与其他代理共享）
| 项 | master（5181） | SC-5（5241） |
| --- | --- | --- |
| 真冷启动总耗时（`dev-browser.mjs cold`） | 27.5 s | **16.7 s / 17.4 s**（两次） |
| 其中着色器批次（后台） | 19.6 s | 9.2 / 9.6 s |
| 其中批次后第一次 render（「云光线步进程序编译」） | 5.0 s | 4.7 / 4.9 s |
| 同一浏览器、什么都不改再加载 | — | 1.2 s |
| 只改 `cabin-shading.glsl.ts` 一个常数后重载 | ≈ 整个场景程序重编（批次约 20 s） | **总 4.3 s，批次 3.2 s** |
| 只改窗外一个常数（outside-pass.ts）后重载 | 同上 | 总 9.1 s，批次 7.9 s |
| sampler（`check:glsl`） | 场景 16/16 | 舱内 **3/16**，窗外 16/16，窗外细节变体 16/16 |

帧时间（`bench --baseline 5181`，CPU 计时 / GPU timer）：noon-cumulus −8.6%，sunset-wing −14.1%，low-sea-glint −14.3%，in-cloud −6.3%，night-city −9.7%；GPU 计时同方向。两个较小的程序寄存器压力低，比一个大程序快；多出的 32F 目标读写在 5090 上看不出。

## 逐像素（d3d11，同页同帧，32F）
工具：`tmp/sc5-tools/`（worktree 下，已忽略）。`_m_*.ts` 是 master 的 scene / cabin / ground / cabin-shading 拷贝，`_sc5_compare.ts` 在页面里画 master 单程序与本分支两个 pass 并比较（RGB 相对差 + alpha 32 位），`_sc5-compare.mjs` 是驱动，`_sc5-edit.mjs` 测「改一处后重编」。用法：前两类放回 `src/render/`、两个 mjs 放回 `scripts/`，`node scripts/_sc5-compare.mjs --port 5241 [--only …] [--angle vulkan] [--dbg 3,5]`。
- in-cloud：最大相对差 2.7e-5，没有像素超过 1e-4；alpha 遮罩全一致。
- noon-cumulus / sunset-wing / low-sea-glint / night-city：海面闪光、城市夜光有单像素翻转（两个方向都有），平均相对差 1e-6 ~ 4e-4；alpha 里的窗外遮罩 m **全部一致**（只有 A 随 view 变）。
- **校准**：同时画「master 只给 rdW 多做一次 normalize」（视线差约 1 ulp）：与 master 的差是同一量级（night-city 平均 3.95e-4 对本分支 3.93e-4；sunset 最大 0.96 对 0.92；low-sea-glint >1e-4 像素 48k 对 51k）。所以这是 hash 类效果对 ulp 的敏感，不是拆分引入的系统误差（坑点已写进 README）。
- 调试模式：uDebug 1、3（舱内）、5、10（窗外）两边都比过，量级同上；3 在 in-cloud / night-city / noon 逐位一致。
- Vulkan 上同样的对比：night-city 逐位一致，其余 ≤ 2e-3。

## 坑
- **Python heredoc 在 Git Bash 里把 `\\n` 变成了真换行**（写进 TS 字符串里成了未闭合字面量）；带反斜杠的替换改用 Write 写脚本文件再执行（AGENTS.md 早有这条）。
- 「只加一个 `if (uDebug == 98) return …` 的 master」和 master 逐位一致：FXC 把这种 uniform 分支完全优化掉了，**不能当扰动校准用**；有效的校准是改一个真实参与计算的量（rdW 多 normalize）。
- 批次后第一次 render 仍有约 4.8 s 同步卡顿（SC-4 已记录），缓存命中时是 0，只改舱内或只改窗外时也是 0——说明它跟某个被缓存的、不随 scene/outside 变化的东西有关（怀疑 ANGLE D3D11 按输入布局延迟编译的顶点着色器，或云步进的 MRT 布局），没查，值得单独立项：现在它是冷启动里第二大的一块。

## 开发体验反馈
- 改舱内（cabin*.glsl.ts、seats、scene.ts 的 main）在 d3d11 上重载只要约 4 s，可以直接在默认后端上迭代，不必切 Vulkan。
- 改窗外约 9 s，其中大头仍是海面 + 地面；窗外程序 sampler 仍 16/16，加纹理只能放舱内程序或做数组。
- `noise.glsl.ts`、`lights.glsl.ts`、`atmosphere/common.glsl.ts` 是两个程序共享的，改它们两个都重编（约 10 s）。
- 逐像素对比务必带一个「1 ulp 扰动」的校准组，否则 hash 类效果的翻转会让人以为出了错。
