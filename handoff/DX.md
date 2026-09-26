# DX-01 + DX-02 + DX-03 交接：开发工具三件套

分支：`worktree-agent-a60f028cdce61a8da`（worktree `D:\Code\opus-test\.claude\worktrees\agent-a60f028cdce61a8da`），开发端口 5230。
任务来源：`apps/voyage/research/DX_REPORT_wave2.md`（开发体验官第 2 波报告）§4 的 DX-01/02/03。

## 已完成

- **DX-01** `apps/voyage/scripts/dev-browser.mjs`：私有 headless Chromium 联调脚本。
  - 自动定位本机 `ms-playwright` 缓存里的完整版 `chrome.exe`（排除 `chromium_headless_shell-*`），`--use-angle=d3d11` 钉死，启动后用一个临时 canvas 探测 `WEBGL_debug_renderer_info`，是 SwiftShader 就抛错退出。
  - 三个子命令：`shots`（跑 `scenarios.mjs` 的场景表，截图 + 每场景一份同名 `.json`，含 info / head / viewport / renderer / frameMs）、`cold`（真冷启动：nonce 破缓存 + 每次独立浏览器上下文）、`bench`（批渲帧时间，用 `window.__voyage.benchFrame(n)`，多轮交替剔除离群；`--baseline <port>` 两端口对照表；顺带用 `EXT_disjoint_timer_query_webgl2` 报一次 GPU 时间，没有该扩展就是 `null`，不影响主流程）。
  - `--port`、`--only`、`--out`、`--baseline`、`--frames`、`--rounds`、`--repeat` 参数；固定视口 1600×1200、dpr 1。
  - 浏览器崩溃（`Target crashed`，多个代理抢 GPU 时会撞上）时 `browser.close()` 可能永远等不到 CDP 回来，加了超时 race + `SIGKILL` 兜底，`main()` 无论成功失败都 `process.exit()`，不依赖 Node 自然收尾。
- **DX-02** `apps/voyage/scripts/lint-shaders.mjs`：离线 GLSL 检查，`pnpm --filter voyage check:glsl` 一条命令跑完，失败非零退出。
  - 用 vite `ssrLoadModule` 在 Node 里直接调用各材质构造函数（不开浏览器），枚举到 22 个程序：场景默认变体 / GROUND_DETAIL 变体、机翼、云的三个 pass、云噪声三张图、海浪 FFT 三个 pass、眩光两个 pass、曝光三个 pass、大气 LUT 五张图，拼出完整着色器交给 `glslangValidator` 语法校验。
  - 两项静态检查：同一程序内的同签名函数重名（按「已拼好的程序文本」扫，不是按源文件扫，避免不同程序的 `main()` 互相「撞名」的假阳性）；场景程序 sampler 数（≤16，处理了 `#ifdef GROUND_DETAIL` 宏，不然会把只在低空变体里用到的 sampler 也算进默认变体）。
  - 附带一项一致性检查：`scenarios.mjs` 的场景表和 `regression.playwright.js` 里的副本是否同步（见下面的「已知取舍」）。
  - 已用注入测试验证：临时把 `ground-detail.glsl.ts` 的 `detailLineCov` 改回 `lineCov`（复现 T02×T06 真实撞过的那次重名）、在 `cabin-shading.glsl.ts` 顶部加 `float half = 1.0;`（GLSL 保留字），两个都被正确抓住并指出文件/行号，测完已用 `git diff` 确认改动已完全还原（无残留）。
- **DX-03** `apps/voyage/scripts/regression.playwright.js` 加固：开头 `setViewportSize(1600×1200)`；返回值加 `renderer`（`WEBGL_debug_renderer_info`）、`viewport`、`origin`；`only` 可以从 `globalThis.__regressionOnly` 或页面 URL 的 `?only=a,b` 读（没有全局 `URL`/`setTimeout`，用正则 + `page.evaluate` 里的浏览器原生 `setTimeout`）；帧时间从原始 rAF 中位数改成 `window.__voyage.benchFrame(30)`（main.ts 已有的批渲 + `readRenderTargetPixels` 同步）；`head` 除了原来的数字（只设 z）也接受 `[x, y, z]` 三元组（headX，参考 T06 复核脚本的 forward-seat / own-seat 场景）。
- 新增 `apps/voyage/scripts/scenarios.mjs`：场景表单一源，`dev-browser.mjs` 直接 `import`；`regression.playwright.js` 保留一份文本逐字相同的副本（原因见下），`lint-shaders.mjs` 里的同步检查保证两边不会悄悄跑偏。
- `package.json`：新增 devDependencies `playwright-core@^1.63.0`、`glslang-validator-prebuilt-predownloaded@^0.0.2`；新增 scripts `check:glsl`、`shots`、`cold`、`bench`。`pnpm-lock.yaml` 已更新（`pnpm install` 跑过）。

## 已知取舍（写清楚原因，避免被当成没做完）

1. **`regression.playwright.js` 没有真的 `import scenarios.mjs`**：Playwright MCP 的 `browser_run_code_unsafe` 执行环境明确没有全局 `URL`、`setTimeout`（README 坑点已经写了），大概率是一个没有 `require`/`import` 的裸 V8 vm 上下文，不是完整 Node。贸然假设它能 `import` 会有把 MCP 版脚本改坏、连累正在用共享浏览器的其他代理的风险（我没有共享浏览器锁，也不该去试）。所以两边各放一份文本相同的场景表，`lint-shaders.mjs` 加了一致性检查兜底。**如果以后确认了这个沙箱其实支持某种模块加载**，可以把这部分去重。
2. **场景程序 sampler 检查是近似值，不是真正的链接期 active uniform 统计**：`check:glsl` 目前报 `scene-ground-detail` 是 17/16（超出 1 个，多出来的是 `uGroundAlbedo`），`scene-default` 精确匹配 README 记录的 16/16。这个近似法是「声明了 + 在挖掉 `#ifdef GROUND_DETAIL` 块之后的文本里还被引用至少一次」，对默认变体验证是准的（跟 README 文档完全对上），但没法完全复现真实驱动的死代码消除粒度。
   **没能用真实 GPU 确认 GROUND_DETAIL 变体是否真的会链接失败**：本机当前有 30+ 个 chrome.exe 进程在跑（其他代理 / 会话在用），两次尝试起私有浏览器降到低空高度触发 `groundDetail.pick()` 都在 `page.waitForFunction` 阶段 `Target crashed`，判断是 GPU 争用而不是我的探测脚本本身的问题（同一台机器上 `shots`/`bench`/`cold` 全部场景都成功跑过，`bench --baseline 5181` 也成功过）。**建议协调者找一个 GPU 空闲的时间窗口，用 `dev-browser.mjs` 或性能工程师的常规流程验证一次**：起 5181（或任意端口）、把高度调到 4 km 以下、等几秒，读 `window.__voyage.groundDetail.status`——如果是 `"failed"` 就确认了这是一个真实但目前静默失效的 bug（低空细节效果从未真正生效，`pick()` 会一直退回 `this.base`，不报错也不崩溃，纯粹是画面上少了本该有的细节），如果是 `"ready"` 就说明我的近似检查过严，需要把 sampler 检查放宽或改成真 GPU 校验。**这个发现不在 DX-01/02/03 的任务范围内，是顺手做 DX-02 时发现的，没有改 `src/`（归属范围不含 src/），留给协调者判断要不要排一个新任务。**
3. **`pnpm --filter voyage shots -- --port ... --only ...` 在 GPU 被其他代理占满时偶发挂起**：直接 `node scripts/dev-browser.mjs shots ...`（不经 pnpm）遇到 `Target crashed` 时能在几秒内打印错误并退出（`process.exit(1)`）；但同样的命令包一层 `pnpm run` 之后，个别情况下整个 `pnpm` 进程还是要挂到 bash 外层超时才结束——怀疑是 pnpm 自己的子进程收尾逻辑在等一个已经死掉的 chrome 子进程，不是 `dev-browser.mjs` 本身的问题（`dev-browser.mjs` 直接跑没有这个现象）。GPU 空闲时没复现过这个问题。建议：GPU 明显被占用时，优先用 `node scripts/dev-browser.mjs ...` 直接跑，不套 `pnpm run`；或者外层加个超时包一层。

## 已验证的结果（本次会话实测）

- `pnpm --filter voyage typecheck && pnpm --filter voyage build`：通过，`dist/assets` 无 0 字节文件。
- `node scripts/lint-shaders.mjs`：22 个程序全部语法通过，重名检查通过，`scene-default` sampler 16/16，场景表同步检查通过；`scene-ground-detail` sampler 17/16（见上面「已知取舍」第 2 条）。
- 注入测试（`half` 保留字 + `lineCov` 重名撞名）：两个都被抓住，测完已还原（`git diff` 确认两个文件无残留改动）。
- `node scripts/dev-browser.mjs shots --port 5230`：11 个场景全部成功，截图 + JSON 都在 `tmp/screenshot/dev-5230/`，抽查 `noon-cumulus` / `night-city` / `typhoon-eye` 画面正常（机翼、云、真实地面夜景灯光都对）。
- `node scripts/dev-browser.mjs cold --port 5230`：`totalMs=92631`，各阶段耗时与开发体验官报告里对主分支的实测（92007 ms）高度吻合。
- `node scripts/dev-browser.mjs bench --port 5230 --baseline 5181 --only noon-cumulus,sunset-wing`：两端口渲染器一致（RTX 5090 D3D11），CPU 批渲 ~6ms/帧、GPU timer query ~3ms/帧，5230 相对 5181（此时代码完全相同）的差异在噪声范围内（0.2%~6.9%），符合预期。

## 复现

```bash
cd apps/voyage
node scripts/lint-shaders.mjs
node scripts/dev-browser.mjs shots --port 5230 --only noon-cumulus
node scripts/dev-browser.mjs cold --port 5230
node scripts/dev-browser.mjs bench --port 5230 --baseline 5181 --frames 30 --rounds 5
```
worktree 里 vite dev server 已经起在 5230（`node_modules/.bin/vite --port 5230 --strictPort`），主分支 5181 由协调者/其他会话跑着。

## 给 README / DEV_SOP 的建议文字（协调者写入，我没改 .md）

**`apps/voyage/README.md`「调试与验证」追加：**

> - **私有 headless 联调**（不用共享浏览器锁）：`node scripts/dev-browser.mjs shots --port <端口> [--only a,b]`（跑回归场景表 + 截图 + 帧时间）、`cold --port <端口>`（真冷启动）、`bench --port <端口> --baseline <对照端口>`（批渲帧时间两端口对照，附 GPU timer query）。脚本会自动找本机 `ms-playwright` 缓存的完整版 `chrome.exe`，启动后校验渲染器不是 SwiftShader（用了 `chrome-headless-shell.exe` 或 `--use-angle=swiftshader` 会静默退化，见下面「坑点」）。GPU 被其他代理占满时可能报 `Target crashed`（等一等或换个时间再跑，`pnpm run` 套一层时偶发挂起，直接 `node scripts/dev-browser.mjs ...` 更稳，见 `handoff/DX.md`）。
> - **离线 GLSL 检查**：`pnpm --filter voyage check:glsl`，不开浏览器，几秒内跑完，能抓住 GLSL 保留字、同一程序内的同签名函数重名、场景程序 sampler 数超 16。提交前跑一次比等冷编译报错快得多。

**`apps/voyage/README.md`「坑点」追加：**

> - **glslang-validator-prebuilt-predownloaded 没有 `bin` 字段**：不能 `npx` 直接跑，要 `require("glslang-validator-prebuilt-predownloaded").getPath()` 拿到可执行文件路径自己 `spawn`（`apps/voyage/scripts/lint-shaders.mjs` 已经封装好）。
> - **离线校验 THREE 的 `#include <chunk>`**：不能直接展开 `THREE.ShaderChunk` 的原文喂给 `glslangValidator`——它的 `common` chunk 里的 `average()` 函数会被 glslangValidator 误报「redeclaration of existing name」（ANGLE / 真实浏览器编译完全正常，是 glslangValidator 自己符号表的问题）。`lint-shaders.mjs` 用手写的桩替换（`INCLUDE_STUBS`）绕开。
> - **场景程序 sampler 数的静态检查是近似值**：只能做到「声明了但从没被引用过就不算」，没法完全模拟真实驱动的死代码消除（尤其是 `#ifdef` 宏内的引用）。真正精确的数字仍要用 `dev-browser.mjs` 或 Playwright 起一个真实 WebGL2 上下文读 `gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS)`。
> - **`chrome-headless-shell.exe` 会静默退化成 SwiftShader**，且没有 `EXT_disjoint_timer_query_webgl2`：私有 headless 一定要用 `ms-playwright` 缓存里 `chromium-<版本>/chrome-win64/chrome.exe` 这个完整版二进制，不能用同一份缓存里的 `chromium_headless_shell-*`。

**`apps/voyage/DEV_SOP.md`「浏览器锁」前追加一句：** 「自测 / 联调 / 冷启动测量 / 批渲对照，改用 `apps/voyage/scripts/dev-browser.mjs`（每个代理各自起私有浏览器），不用碰 `tmp/browser.lock`；这把锁只留给确实要用 Playwright MCP 的场合（例如需要真人可见的截图核验、或多任务合并后的权威回归）。」
