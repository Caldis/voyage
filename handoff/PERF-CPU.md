# PERF-CPU · 「帧率很低、CPU 打满、GPU < 40%」定位与优化

分支：worktree-agent-af7ee412adf4b466c；端口 5249（对照 5309）。测量工具：`scripts/cpu-prof.mjs`（本任务新增，有头 Chrome）。

## 定位结论（第一份，2026-09-28 15:00）

**根因不是代码回归，是用户那台 Chrome 的 GPU 进程掉到了 WARP（D3D11 软件光栅，用 CPU 画 WebGL）。**

证据链：

1. **用户 Chrome 的 GPU 进程加载的是 WARP，不是 NVIDIA 驱动。** 只读查看用户的 Chrome（`C:\Program Files\Google\Chrome\Application\chrome.exe`，153.0.8010.37，浏览器进程 9/13 起一直开着）GPU 进程 pid 78208 的模块表：
   有 `D3D10Warp.dll`、`Microsoft.Internal.WarpPal.dll`、`d3d11.dll`，**没有** NVIDIA 的 D3D11 用户态驱动 `nvwgf2umx.dll` / `nvldumdx.dll`。
   对照：本机 Playwright 的 chrome.exe 用 `--use-angle=d3d11`（硬件）时 GPU 进程加载 `nvwgf2umx.dll` + `nvldumdx.dll`，WebGL 渲染器是 `ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 … D3D11)`；
   用 `--use-angle=d3d11-warp` 时模块表与用户的完全一致（`D3D10Warp.dll`、无 NVIDIA UMD），渲染器是 `ANGLE (Microsoft, Microsoft Basic Render Driver (0x0000008C) Direct3D11 …)`。
2. **时间对得上一次显卡驱动重装。** 系统日志 2026-09-27 23:59:37 / 23:59:38：UserPnp 20003「为设备添加服务 nvlddmkm / NVDisplay.ContainerLocalSystem」（RTX 5090，PCI\VEN_10DE&DEV_2B85）——NVIDIA 驱动被（重新）安装；
   用户 Chrome 当前的 GPU 进程创建于 **23:59:41**，即驱动切换的 4 秒后重启。驱动切换期间 D3D 硬件设备不可用，Chrome 重建 GPU 进程时退到 WARP，之后**不会自己切回**（浏览器进程一直没重启）。
3. **在本机复现出一模一样的症状**（`cpu-prof.mjs --angle d3d11-warp`，默认场景，1600×1200）：
   | | 硬件 D3D11（RTX 5090） | D3D11 WARP（复现用户环境） |
   | --- | --- | --- |
   | 帧率 | 160 fps（vsync 顶格） | **2.4–2.5 fps** |
   | rAF 间隔中位 / p95 | 6.2 / 6.4 ms | 431 / 881 ms（p95 最高 1314 ms） |
   | GPU 进程 CPU（100% = 一核） | 55%（稳态） | **2460–2617%（≈ 25–26 个核）** |
   | 页面主线程忙 | 33% | 19–23%（大部分时间在等 GPU 进程） |
   | NVIDIA GPU | 在干活 | 基本闲着 |
   32 逻辑核里 26 个被 WARP 的光栅线程占满 → 任务管理器看就是「CPU 打满、GPU 利用很低、帧率很低」。
4. **硬件模式下代码本身没有 CPU 瓶颈**（有头 Chrome、RTX 5090，稳态，各场景都顶在 160 fps vsync）：
   | 场景 | rAF 中位 / p95（ms） | 主循环 JS 中位 / p95（ms） | 主线程忙 | 渲染进程 CPU | GPU 进程 CPU |
   | --- | --- | --- | --- | --- | --- |
   | default（启动 50 s 后） | 6.2 / 6.4 | 0.9 / 1.2 | 33% | 71% | 55% |
   | noon-cumulus | 6.3 / 6.4 | 0.9 / 1.2 | 31% | 66% | 45% |
   | night-city | 6.3 / 6.3 | 0.9 / 1.2 | 32% | 92% | 64% |
   | storm-day | 6.3 / 6.3 | 1.0 / 1.3 | 36% | 69% | 92% |
   | in-cloud | 6.3 / 6.3 | 1.0 / 1.2 | 32% | 56% | 49% |
   | route-1x（hnd-cts 连续航程） | 6.3 / 6.3 | 1.1 / 1.4 | 38% | 101% | 60% |
   | route-60x | 6.3 / 6.3 | 1.1 / 1.5 | 44% | 192% | 201% |
   用户的屏幕是 3840×2160@160 Hz、150% 缩放；按 2560×1300 视口 × DPR 1.5 测，稳态同样 160 fps、GPU 进程 47–90%。
   启动后头 10 s（后台变体编译）GPU 进程会到 400–630%，是一次性的；night-city 换场景后的地面 / 变体准备期间也到过 714%，几秒内回落。
   主线程每帧 JS 约 1 ms，Top 自耗时都是 three.js 的常规开销（`needsUpdate` 0.08 ms、`renderBufferDirect` 0.05 ms、`upload` 0.05 ms），GC 0.02 ms/帧。
   **不是回归**：硬件模式下各场景都顶在 vsync，没有可二分的退化；用户的问题从 9/27 23:59 驱动重装那一刻开始，与哪次合并无关。
5. 每帧 WebGL 调用（硬件、默认场景）：约 1056 次；draw 111、uniform 158、`depthMask` 220、`enable`/`disable` 各 110、`framebufferTextureLayer` 67、`bindFramebuffer` 48、`useProgram` 17。
   同步类调用很少：`getQueryParameter` 3–4 次（画质档的 GPU 计时查询）、`getParameter` 1、`clientWaitSync` / `readPixels` / `getBufferSubData` 各 0.25（每 4 帧一次的云密度探针，走 PBO + fence），没有每帧 `getError` / `checkFramebufferStatus`。
   111 个 draw 里 **64 个是空气透视 3D LUT**（2 张 × 32 层，每层一次 draw + `framebufferTextureLayer`），每帧都重算。

## 给用户的处理办法（最有效，协调者转告）

- **完全退出 Chrome 再打开**（地址栏输入 `chrome://restart` 回车，会恢复所有标签页）。之后在 `chrome://gpu` 里看「WebGL: Hardware accelerated」，GL_RENDERER 应是 NVIDIA 而不是 Microsoft Basic Render Driver / SwiftShader。
- 以后装完显卡驱动都要重启一次 Chrome。

## 计划的代码改动

1. **软件渲染检测 + 提示**（本任务最有价值的代码改动）：启动时读 WebGL 渲染器字符串，命中 `Microsoft Basic Render Driver` / `SwiftShader` / `llvmpipe` 等软件光栅时，页面顶部显示醒目提示（原因 + `chrome://restart` + `chrome://gpu` 核对方法），画质档直接落到最低；`__voyage.softwareRenderer` 调试句柄。
2. 硬件模式下的 GPU 进程命令量：空气透视 / 天空视图 LUT 在输入不变时跳过重算（逐位不变的缓存，画面零变化）；看 `depthMask` / `enable` / `disable` 每帧 220 次的来源能否去掉。
3. README「性能」坑点：记这次的现象 / 根因 / 识别方法（模块表、渲染器字符串、`cpu-prof.mjs --angle d3d11-warp` 复现）。

## 已做的改动与前后数字（检查点 2）

1. `src/boot/software-gl.ts`（新）+ `src/main.ts` 3 行接入 + `src/style.css`：渲染器是 WARP / SwiftShader / llvmpipe 时页面顶部提示（可关闭，压在加载遮罩之上）；`?swgl=1` 强制显示；`__voyage.softwareRenderer`。截图 `tmp/screenshot/perfcpu-banner/noon-cumulus.png`。
2. `src/atmosphere/luts.ts`：空气透视 LUT 改成两附件 MRT 一遍画出（32 次 draw 代替 64 次，`integrateSegment` 只算一遍）。
   与旧做法逐位对照（同页还原旧着色器、同样输入，32 位浮点逐 texel 读回）：内散射 262144 个值 0 差、透射率 262144 个值 0 差（`node handoff/PERF-CPU-aerial-check.mjs 5249`）——画面零变化。
   `src/main.ts` 的 `__voyage` 多挂了 `atmosphere`（给上面的核对脚本用）。
   有头 Chrome、1600×1200，对照 5309（04dc11f）/ 新 5249：
   | 场景 | 每帧 GL 调用 | draw | uniform | 主循环 JS 中位（ms） |
   | --- | --- | --- | --- | --- |
   | default（稳态） | 1056 → 858 | 111 → 79 | 159 → 125 | 1.0 → 0.8 |
   | noon-cumulus | 1056 → 861 | 111 → 79 | 159 → 125 | 0.9 → 0.9 |
   | night-city | 1061 → 864 | 111 → 79 | 163 → 128 | 0.9 → 0.8 |
   帧率两边都顶在 160 fps；GPU 进程 CPU 同场景两次能差 ±30%（45–90%），这个量级的改动在它的噪声内。
3. 试过没采用：JS 侧去重冗余的 `depthMask` / `enable` / `disable`（每帧 440 次，占调用 40%），同页 A/B/A/B GPU 进程 CPU 无可见差别（ANGLE 延迟下发状态），不值得绕开 three 的状态管理。
4. `scripts/cpu-prof.mjs` + `scripts/lib/thread-cpu.ps1`（新，DX 工具）；README「调试与验证」「坑点 · 性能」。

## 怎么复现

```bash
node scripts/cpu-prof.mjs --port 5249 --scenes default,noon-cumulus,night-city,storm-day,in-cloud,route-1x,route-60x
node scripts/cpu-prof.mjs --port 5249 --angle d3d11-warp --scenes default --no-gl     # 复现用户的软件渲染
```
PowerShell 查某个 Chrome GPU 进程是不是 WARP：`(Get-Process -Id <GPU 进程 pid>).Modules | ? ModuleName -match 'nvwgf|Warp'`。
