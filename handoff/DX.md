# DX-01 + DX-02 + DX-03 交接：开发工具三件套

分支：`worktree-agent-a60f028cdce61a8da`（worktree `D:\Code\opus-test\.claude\worktrees\agent-a60f028cdce61a8da`），开发端口 5230。
任务来源：`apps/voyage/research/DX_REPORT_wave2.md`（开发体验官第 2 波报告）§4 的 DX-01/02/03。

**2026-09-26 审查「有条件通过」后的两轮返工，已完成，见下面「返工记录」。** 结论：DX-01、DX-03 直接通过；
DX-02 的 sampler 检查第一次交付时方法有误（把 `#else` 分支也挖掉了），返工后用私有 headless 对主分支 5181
读了真实 `gl.getProgramParameter(ACTIVE_UNIFORMS)`：**scene-default 和 scene-ground-detail 都是 16/16**，
没有真 bug，不需要再派修复任务给 T02。

## 已完成

- **DX-01** `apps/voyage/scripts/dev-browser.mjs`：私有 headless Chromium 联调脚本。
  - 自动定位本机 `ms-playwright` 缓存里的完整版 `chrome.exe`（排除 `chromium_headless_shell-*`），`--use-angle=d3d11` 钉死，启动后用一个临时 canvas 探测 `WEBGL_debug_renderer_info`，是 SwiftShader 就抛错退出。
  - 三个子命令：`shots`（跑 `scenarios.mjs` 的场景表，截图 + 每场景一份同名 `.json`，含 info / head / viewport / renderer / frameMs）、`cold`（真冷启动：nonce 破缓存 + 每次独立浏览器上下文）、`bench`（批渲帧时间，用 `window.__voyage.benchFrame(n)`，多轮交替剔除离群；`--baseline <port>` 两端口对照表；顺带用 `EXT_disjoint_timer_query_webgl2` 报一次 GPU 时间，没有该扩展就是 `null`，不影响主流程）。
  - `--port`、`--only`、`--out`、`--baseline`、`--frames`、`--rounds`、`--repeat` 参数；固定视口 1600×1200、dpr 1。
  - 浏览器崩溃（`Target crashed`，多个代理抢 GPU 时会撞上）时 `browser.close()` 可能永远等不到 CDP 回来，加了超时 race + `SIGKILL` 兜底，`main()` 无论成功失败都 `process.exit()`，不依赖 Node 自然收尾。
- **DX-02** `apps/voyage/scripts/lint-shaders.mjs`：离线 GLSL 检查，`pnpm --filter voyage check:glsl` 一条命令跑完，失败非零退出。
  - 用 vite `ssrLoadModule` 在 Node 里直接调用各材质构造函数（不开浏览器），枚举到 22 个程序：场景默认变体 / GROUND_DETAIL 变体、机翼、云的三个 pass、云噪声三张图、海浪 FFT 三个 pass、眩光两个 pass、曝光三个 pass、大气 LUT 五张图，拼出完整着色器交给 `glslangValidator` 语法校验。
  - 两项静态检查：同一程序内的同签名函数重名（按「已拼好的程序文本」扫，不是按源文件扫，避免不同程序的 `main()` 互相「撞名」的假阳性）；场景程序 sampler 数（≤16，`resolveConditionals` 按变体正确展开 `#ifdef/#ifndef/#if defined(...)/#else/#elif`，再用 `reachableFromMain` 剪掉从 `main()` 到不了的死代码，见下面「返工记录」）。
  - 附带一项一致性检查：`scenarios.mjs` 的场景表和 `regression.playwright.js` 里的副本是否同步（见下面的「已知取舍」）。
  - `node scripts/lint-shaders.mjs --self-test`：9 条 fixture 直接测 `samplerAudit`/`resolveConditionals`/可达性剪枝本身（`#ifdef/#else`、嵌套、`#if defined(...)`、未引用声明、死代码函数、链式调用可达），不用起 vite，几十毫秒跑完。
  - 已用注入测试验证：临时把 `ground-detail.glsl.ts` 的 `detailLineCov` 改回 `lineCov`（复现 T02×T06 真实撞过的那次重名）、在 `cabin-shading.glsl.ts` 顶部加 `float half = 1.0;`（GLSL 保留字），两个都被正确抓住并指出文件/行号，测完已用 `git diff` 确认改动已完全还原（无残留）。
- **DX-03** `apps/voyage/scripts/regression.playwright.js` 加固：开头 `setViewportSize(1600×1200)`；返回值加 `renderer`（`WEBGL_debug_renderer_info`）、`viewport`、`origin`（`origin` 额外在最开头 `console.log` 一次，后面步骤失败也能看到这次跑的是哪个端口）；`only` 可以从 `globalThis.__regressionOnly` 或页面 URL 的 `?only=a,b` 读（没有全局 `URL`/`setTimeout`，用正则 + `page.evaluate` 里的浏览器原生 `setTimeout`）；帧时间从原始 rAF 中位数改成 `window.__voyage.benchFrame(30)`（main.ts 已有的批渲 + `readRenderTargetPixels` 同步）；`head` 除了原来的数字（只设 z）也接受 `[x, y, z]` 三元组（headX，参考 T06 复核脚本的 forward-seat / own-seat 场景）；端口正则从只认 `51\d\d` 改成任意 `5\d{3}`，且当前页面不在这个范围时直接抛错退出，不再有「猜一个默认端口」这条路（见下面「返工记录」）。
- 新增 `apps/voyage/scripts/scenarios.mjs`：场景表单一源，`dev-browser.mjs` 直接 `import`；`regression.playwright.js` 保留一份文本逐字相同的副本（原因见下），`lint-shaders.mjs` 里的同步检查保证两边不会悄悄跑偏。
- `package.json`：新增 devDependencies `playwright-core@^1.63.0`、`glslang-validator-prebuilt-predownloaded@^0.0.2`；新增 scripts `check:glsl`、`shots`、`cold`、`bench`。`pnpm-lock.yaml` 已更新（`pnpm install` 跑过）。

## 返工记录（2026-09-26 审查「有条件通过」之后）

协调者审查发现 DX-02 的 sampler 检查有方法错误，指出后按下面四点返工：

1. **修 `samplerAudit` 的条件编译处理**：旧版 `GROUND_DETAIL_BLOCK_RE = /#ifdef\s+GROUND_DETAIL\b[\s\S]*?#endif\b/g` 给默认变体 strip 时把整个 `#ifdef…#endif` 挖掉，连 `#else` 分支也删了——真实预处理器在宏未定义时是「保留 `#else`、删掉 `#ifdef` 分支」。`terrain-shading.glsl.ts` 第 25–29 行 `uGroundAlbedo` 在 `#else` 分支（默认变体真正会跑的那条路）里也有一次采样，被旧版误删，导致「默认变体 16/16 与 README 吻合」只是巧合不是证据。**改成 `resolveConditionals(text, defines)`**：支持 `#ifdef`/`#ifndef`/`#if defined(...)`/`#else`/`#elif`/任意深度嵌套的最小条件编译展开，按「这个变体真正会编译到的文本」保留代码。
2. **补自检**：`node scripts/lint-shaders.mjs --self-test`，9 条 fixture（`#ifdef/#else`、只有 `#ifdef` 没 `#else`、`#else` 和 `#ifdef` 都引用同一个 sampler、嵌套、`#if defined(...)`、完全未引用、死代码函数里的引用不算、链式调用可达性），全部通过。
3. **用真实 GPU 定案**：修好 `#else` 之后，`scene-default` 和 `scene-ground-detail` 静态都数出 17（多出来的是 `uMultiScatteringLut`）。用私有 headless（新起浏览器，不碰共享 MCP 浏览器）连到主分支 5181，挂 `linkProgram` 钩子拿到真实 `WebGLProgram`，读 `gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS)` + 逐个 `gl.getActiveUniform` 数 sampler 类型：
   - **scene-default（默认变体）：真实 active sampler = 16/16**（`linkStatus: true`）。
   - **scene-ground-detail（低空细节变体，把高度压到 2.5 km 触发 `groundDetail.pick()` 后台编译）：真实 active sampler = 16/16**（`linkStatus: true`，新链接的程序和默认变体的 sampler 名单完全一致）。
   两个变体都在预算内，**T02 没有真 bug，不需要派修复任务**。
   根因追查：`uMultiScatteringLut` 只被 `ATMOSPHERE_COMMON` 里的 `multiScattering()` 读，而 `multiScattering()` 只被 `luts.ts` 的 `IRRADIANCE_FRAG`/`SKY_VIEW_FRAG`/`AERIAL_FRAG`（LUT 预计算，另外的程序）调用——场景程序的 `main()` 顺着调用链走下去根本到不了这个函数，真实驱动的死代码消除会把它和它读的 sampler 一起砍掉，纯文本「这个名字在哪都出现过」的计数看不出「是否真的从 `main()` 可达」。
4. **加「从 main() 可达性剪枝」把静态法修准，而不是留一个不可信的近似值**：新增 `extractFunctions`（按花括号配对取出每个函数体的字符区间）+ `reachableFromMain`（从 `main` 出发做 BFS，函数体里出现「已知函数名 + `(`」当作调用边）+ `pruneUnreachable`（把到不了 `main()` 的函数体整段挖掉）。剪枝后再数，**`scene-default` 和 `scene-ground-detail` 静态数字都变成 16/16，和真实 GPU 读数完全一致**——不再是近似，是经过交叉验证的确切值。检查已恢复为致命（超限会让 `check:glsl` 非零退出），`--self-test` 也加了两条 fixture 直接复现这个场景（死代码函数不算、链式调用要算）。
5. **`regression.playwright.js` 端口正则的独立返工**（协调者在同一轮追加）：旧正则 `/^http:\/\/127\.0\.0\.1:51\d\d/` 只认 5100–5199，worktree 常用的 52xx 端口（例如这次的 5230）匹配不上时会**静默退回默认值 `http://127.0.0.1:5181`**，把截图写进主分支目录、覆盖别人的基线（本波已发生 3 次：T16、T23 等）。改成 `/^http:\/\/127\.0\.0\.1:5\d{3}\b/`（认任意 5000–5999），**当前页面不在这个范围时直接 `throw` 报错退出，不再有「猜一个默认端口」这条路**；`origin` 在最开头就 `console.log` 一次。用私有 headless 实测两个用例：页面在 5230 时 `origin` 正确识别为 5230（不是 5181）；页面在 `about:blank` 时正确抛错退出。

## 已知取舍（写清楚原因，避免被当成没做完）

1. **`regression.playwright.js` 没有真的 `import scenarios.mjs`**：Playwright MCP 的 `browser_run_code_unsafe` 执行环境明确没有全局 `URL`、`setTimeout`（README 坑点已经写了），大概率是一个没有 `require`/`import` 的裸 V8 vm 上下文，不是完整 Node。贸然假设它能 `import` 会有把 MCP 版脚本改坏、连累正在用共享浏览器的其他代理的风险（我没有共享浏览器锁，也不该去试）。所以两边各放一份文本相同的场景表，`lint-shaders.mjs` 加了一致性检查兜底。**如果以后确认了这个沙箱其实支持某种模块加载**，可以把这部分去重。
2. **`samplerAudit` 仍然是静态近似，不是真正的链接期统计**：可达性剪枝解决了「函数体到不了 `main()`」这一类死代码，但不做跨函数的数据流分析（例如一个可达函数把采样结果赋给一个从没被读过的变量，这种情况看不出来）。目前已经用真实 GPU 交叉验证过一次（结果完全吻合），以后这里报 FAIL 时，如果怀疑是静态法的盲区而不是真的超限，按「返工记录」第 3 条的手法（`linkProgram` 钩子 + `gl.getProgramParameter`）用 `dev-browser.mjs` 或类似脚本复核。
3. **`pnpm --filter voyage shots -- --port ... --only ...` 在 GPU 被其他代理占满时偶发挂起**：直接 `node scripts/dev-browser.mjs shots ...`（不经 pnpm）遇到 `Target crashed` 时能在几秒内打印错误并退出（`process.exit(1)`）；但同样的命令包一层 `pnpm run` 之后，个别情况下整个 `pnpm` 进程还是要挂到 bash 外层超时才结束——怀疑是 pnpm 自己的子进程收尾逻辑在等一个已经死掉的 chrome 子进程，不是 `dev-browser.mjs` 本身的问题（`dev-browser.mjs` 直接跑没有这个现象）。GPU 空闲时没复现过这个问题。建议：GPU 明显被占用时，优先用 `node scripts/dev-browser.mjs ...` 直接跑，不套 `pnpm run`；或者外层加个超时包一层。

## 已验证的结果（本次会话实测）

- `pnpm --filter voyage typecheck && pnpm --filter voyage build`：通过，`dist/assets` 无 0 字节文件。
- `node scripts/lint-shaders.mjs --self-test`：9 条 fixture 全部通过。
- `node scripts/lint-shaders.mjs`：22 个程序全部语法通过，重名检查通过，`scene-default` / `scene-ground-detail` sampler 都是 16/16（致命检查，已用真实 GPU 交叉验证），场景表同步检查通过。
- 注入测试（`half` 保留字 + `lineCov` 重名撞名）：两个都被抓住，测完已还原（`git diff` 确认两个文件无残留改动）。
- 真实 GPU sampler 验证（私有 headless 连主分支 5181）：`scene-default` 16/16、`scene-ground-detail` 16/16（把高度压到 2.5 km 触发后台编译，新链接的程序 `linkStatus: true`，sampler 名单和默认变体完全一致）。
- `regression.playwright.js` 端口修复验证（私有 headless，模拟 MCP 的 `(文件内容)(page)` 包装方式跑真实脚本文件）：页面在 5230 时 `origin` 正确识别为 `http://127.0.0.1:5230`（不是静默退回的 5181）；页面在 `about:blank` 时正确抛错退出。
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
> - **离线 GLSL 检查**：`pnpm --filter voyage check:glsl`，不开浏览器，几秒内跑完，能抓住 GLSL 保留字、同一程序内的同签名函数重名、场景程序 sampler 数超 16（已用真实 GPU 交叉验证过一次，`scene-default` / `scene-ground-detail` 都是 16/16，见 `handoff/DX.md`「返工记录」）。提交前跑一次比等冷编译报错快得多。`node scripts/lint-shaders.mjs --self-test` 单独测检查逻辑本身，不用起 vite。

**`apps/voyage/README.md`「坑点」追加：**

> - **glslang-validator-prebuilt-predownloaded 没有 `bin` 字段**：不能 `npx` 直接跑，要 `require("glslang-validator-prebuilt-predownloaded").getPath()` 拿到可执行文件路径自己 `spawn`（`apps/voyage/scripts/lint-shaders.mjs` 已经封装好）。
> - **离线校验 THREE 的 `#include <chunk>`**：不能直接展开 `THREE.ShaderChunk` 的原文喂给 `glslangValidator`——它的 `common` chunk 里的 `average()` 函数会被 glslangValidator 误报「redeclaration of existing name」（ANGLE / 真实浏览器编译完全正常，是 glslangValidator 自己符号表的问题）。`lint-shaders.mjs` 用手写的桩替换（`INCLUDE_STUBS`）绕开。
> - **按文本数 sampler 引用，光展开 `#ifdef` 还不够，要连着做「从 main() 可达性剪枝」**：一个函数即使在源码里正常定义、正常读了某个 sampler，只要这个函数本身从场景程序的 `main()` 顺着调用链走不到（比如只被另一个程序调用），真实驱动的死代码消除会把它和它读的 sampler 一起砍掉——纯文本「这个名字出现过好几次」看不出「是否真的可达」。`lint-shaders.mjs` 的 `reachableFromMain`/`pruneUnreachable` 就是为了修这个坑（撞上的真实案例：`uMultiScatteringLut` 只被 LUT 预计算程序用，场景程序的 `main()` 到不了它）。加新的静态分析工具时留意这一条。
> - **验证「静态数的 sampler 数」对不对，起一个真实 WebGL2 上下文比猜靠谱**：挂 `HTMLCanvasElement.prototype.getContext` 和 `gl.linkProgram` 的钩子把 `WebGLProgram` 对象截下来，再读 `gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS)` + 逐个 `gl.getActiveUniform` 数 sampler 类型（手法抄自 `tmp/review-t06/perf.js`），比任何文本分析都准。
> - **`chrome-headless-shell.exe` 会静默退化成 SwiftShader**，且没有 `EXT_disjoint_timer_query_webgl2`：私有 headless 一定要用 `ms-playwright` 缓存里 `chromium-<版本>/chrome-win64/chrome.exe` 这个完整版二进制，不能用同一份缓存里的 `chromium_headless_shell-*`。
> - **`regression.playwright.js` 的端口正则如果写太窄，会静默退回默认端口、覆盖别人的截图**：曾经只认 `51\d\d`（5100–5199），worktree 常用的 52xx 端口匹配不上时悄悄退回 `5181`，把截图写进主分支目录（本波发生 3 次）。现在认任意 `5\d{3}` 且不在范围内直接报错退出；以后类似的「按端口猜路径/猜配置」的脚本都要照这个模式改：宁可报错，不要猜一个默认值。

**`apps/voyage/DEV_SOP.md`「浏览器锁」前追加一句：** 「自测 / 联调 / 冷启动测量 / 批渲对照，改用 `apps/voyage/scripts/dev-browser.mjs`（每个代理各自起私有浏览器），不用碰 `tmp/browser.lock`；这把锁只留给确实要用 Playwright MCP 的场合（例如需要真人可见的截图核验、或多任务合并后的权威回归）。」
