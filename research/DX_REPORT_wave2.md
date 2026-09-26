# 第 2 波开发体验报告

> 开发体验官产出，2026-09-26。只读审计：没有改 `src/`、`scripts/`、任何文档；文中给出的数字凡标「实测」的都是本次亲自在命令行 / 独立进程里跑出来的，凡引自代理反馈的都标了出处。**没有使用共享 Playwright MCP 浏览器**（T20、T04 正在用），涉及浏览器的验证全部用临时的私有 headless Chromium 进程完成，用完已清理，未提交任何代码。

## 0. 结论先行：这一波最大的 3 个效率瓶颈

1. **浏览器锁排队，不是编译或构建本身慢**。`pnpm --filter voyage typecheck` 实测 1.6–3.6 s，`build` 实测 2.9 s（`tsc --noEmit` + `vite build` 338 ms），`dist/assets` 无 0 字节文件——这条链路完全不是瓶颈。真正烧时间的是抢 `tmp/browser.lock`：把 `DX_FEEDBACK.md` 里 12 份报告中**明确给出分钟数**的「等锁」条目加总，**≥ 475 分钟（约 7.9 小时）**，另有 2 份报告（T03 审查、T02 复审）提到排队但没给总数，实际更高。锁是 `mkdir` 抢占式而非排队，15 秒轮询者反复被 1 秒轮询者截胡（T03、T14 反馈），造成的不是「大家平均多等一会」，而是「运气差的代理等到失去耐心」。
2. **冷编译预算失控且测量本身也要吃锁**。波次起点 45 s，波次收尾稳定在约 55–59 s（+22–31%，协调者接受为已知代价）；期间单次最坏值 T02 首次交付 85–94 s（伴随 1/2 次 `CONTEXT_LOST_WEBGL`）、T05 首次审查 104 s、T06 首次审查 +56%。每次「真冷启动」测量本身要 50–95 s（本次我用私有 headless 浏览器对当前主分支实测端到端约 **92.0 s**，细节见 §2），而一次锁最多约 10 分钟，审查代理常常一次锁只够做一次冷启动测量（T02 审查：「10 分钟锁里一次冷启动测量就占 1.5 分钟」），T02 复审为此要拿 3 次锁。7 轮返工（T02×2、T03×1、T05×3、T06×1）把这个成本又乘了一遍。
3. **测量工具全靠每个代理临时手搓，没有沉淀**。`tmp/` 下能数出 **12 个 `cold*.js`、8 个 `perf*.js`、约 16 个 `shots*/*.playwright.js`**，分散在 `review-t02/ review-t03/ review-t05/ review-t06/ T03/ T05/ t02/` 七个目录里，彼此做的事高度重合（nonce 破缓存冷启动、rAF 批渲 readPixels 测帧时间、冻结镜头），只是端口号不同。`apps/voyage/scripts/` 至今只有 `build_stars.py` 和 `regression.playwright.js` 两个文件——没有一个测量脚本「毕业」进正式目录。`regression.playwright.js` 本身也没修：帧时间测量仍是原始 rAF 中位数（第 77–94 行），会被 vsync 锁在约 6.2 ms（README 坑点已写明两次因此误判，这一波第三次靠人工绕过而不是修脚本）；脚本开头也没有 `setViewportSize`，这直接导致 T03 返工报告里「窗口被改成 2560×1249、1.5 倍缩放，帧时间涨约 40 倍，数据静默作废」的事故。

---

## 1. 我亲自验证的关键结论（供下节的建议引用）

### 1.1 私有 headless Chromium：WebGL2 可用、走真实 GPU，不是 SwiftShader

用 `playwright-core@1.63.0`（`npm view` 确认，仓库里未装但可秒装）配合本机已缓存的 `C:\Users\mail\AppData\Local\ms-playwright\chromium-1223\chrome-win64\chrome.exe`，起了 4 组独立进程（不经共享浏览器），探测 `canvas.getContext("webgl2")`：

| 配置 | 渲染器 | `MAX_TEXTURE_IMAGE_UNITS` | `EXT_disjoint_timer_query_webgl2` | 启动耗时 |
| --- | --- | --- | --- | --- |
| `chrome.exe`，`headless: true`（Playwright 默认，即 `--headless=new`） | `ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 …) D3D11` | **16**（与生产环境 / 共享浏览器一致） | 有 | 1.38 s |
| 同上 + 显式 `--use-angle=d3d11` | 同上（与默认完全一致） | 16 | 有 | 1.43 s |
| 同上 + 显式 `--use-angle=swiftshader` | `ANGLE (Google, Vulkan … SwiftShader Device)` | **32**（与生产不一致） | 有 | 1.08 s |
| `chrome-headless-shell.exe`（旧版 headless 二进制） | 同样掉到 SwiftShader | 32 | **没有** | 0.63 s |

结论：**只要用常规 `chrome.exe` 走 Playwright 的新版 headless（不要用 `chrome-headless-shell.exe`），默认就是真实 GPU 的 ANGLE/D3D11 路径**，`MAX_TEXTURE_IMAGE_UNITS = 16` 与 sampler 满编检查、`EXT_disjoint_timer_query_webgl2` 与性能预算测量都对得上共享浏览器的行为。`--use-angle=d3d11` 可以加上做「防御性钉死」（防止未来 Chromium 版本改默认值），但不是必需。**明确反例**：`chrome-headless-shell.exe`（很多教程里推荐的「更轻量」headless 二进制）会静默退化到 SwiftShader 软渲染且没有 timer query 扩展——如果实现代理选错了这个二进制，冷编译时间、sampler 上限、GPU 计时全部失真且不报错，非常危险，必须在文档里明确排除。

### 1.2 端到端验证：私有 headless 浏览器能完整跑通真冷启动测量

起了一个独立的 vite dev server（临时端口，测完已关闭），用同一套「`shaderSource` 注入 nonce 破缓存」手法（抄自 `tmp/review-t02/cold.js`）在私有 headless Chromium 里跑通了当前主分支：

```json
{
  "totalMs": 92007,
  "navToReadyMs": 91185,
  "startup": {
    "大气 LUT": 503, "云噪声": 869, "首帧之前的初始化": 569,
    "场景着色器编译（后台）": 80322, "首帧（含着色器编译）": 8421,
    "场景材质的程序数": 1, "机翼材质的程序数": 1
  },
  "renderer": "ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 …) D3D11"
}
```

**全程没有碰 `tmp/browser.lock`**，也没有让共享浏览器承担风险。数字比波次收尾报告的 55–59 s 高，最可能的原因是测量时 T20 / T04 仍在共享浏览器里跑各自的场景，同一块物理 GPU 被并发占用——这恰恰印证了 README 坑点「多个代理同时占用 GPU 时任何计时都不可信」：**私有 headless 解决的是「排队」和「一个代理拖垮所有人」两个问题，不解决「同一张显卡被多进程同时压」这一条**，权威的性能预算数字仍需按 SOP 6.6 在没有其他代理占 GPU 时测。

### 1.3 离线 GLSL 检查全链路跑通，且真的能抓到「重名函数」这类坑

`tmp/dx/tmp-dump-shader.mjs`（T06 备份、未提交）用 `vite.createServer({middlewareMode:true}).ssrLoadModule` 在 Node 里直接调用 `createSceneMaterial`，拼出完整片元着色器字符串，**耗时约 1 秒**，不经浏览器。有两个坑需要注意：

- 该脚本必须放在 `apps/voyage/` 目录树内执行（比如 `apps/voyage/scripts/`），不能留在仓库根的 `tmp/` 下直接 `node tmp/dx/...mjs` 跑——Node 的 ESM 解析是从脚本自身所在目录向上找 `node_modules`，`tmp/` 不在这棵树里，会报 `ERR_MODULE_NOT_FOUND: vite`。这是我第一次尝试时踩的坑，复制到 `apps/voyage/` 内才跑通。
- `glslang-validator-prebuilt-predownloaded` 这个 npm 包**没有 `bin` 字段**，`npx glslang-validator-prebuilt-predownloaded` 会报 `could not determine executable to run`。正确用法是 `require("glslang-validator-prebuilt-predownloaded").getPath()` 拿到 `bin/glslangValidator.exe` 的路径自己 `spawn`。T06 报告里写「用 npm 包」容易让后来者以为能直接 `npx` 跑，收进 `scripts/` 时要把这一步封装好。

装好之后验证了两类真实场景（用当前主分支实际的函数签名，不是编造的最小复现）：

```
$ glslangValidator -S frag scene_with_reserved_word.frag
ERROR: 0:3804: 'half' : Reserved word.

$ glslangValidator -S frag scene_with_duplicate_outsideRadiance.frag
ERROR: 0:3804: 'outsideRadiance' : function already has a body
```

**保留字**和**同签名函数重名**（T02 × T06 撞上的 `lineCov` 就是这一类）都能被抓住，总耗时（拼装 + 校验）约 **1.1 秒**，比排队等浏览器再冷编译快两个数量级。已知局限：`glslangValidator` 校验的是标准 GLSL 语义，**不会**重现 ANGLE → FXC 的 Windows 专属问题（比如分支/循环里用屏幕导数的 `X3595`、FXC 展开常量循环导致的冷编译暴涨），这两类坑仍要靠冷编译计时或代码审查抓；而且目前的 dump 脚本**只拼出默认变体**，`GROUND_DETAIL` 变体（`src/render/scene.ts:397` 的 `defines: { GROUND_DETAIL: 1 }`）和机翼 pass 另一个程序都没有被枚举到——T02 × T06 那次撞名之所以在早期检查里被漏过，正是因为「只在某个变体把两个模块凑齐时才暴露」，离线检查要收编就必须把已知变体组合也枚举一遍。

---

## 2. 问题 → 证据 → 建议 → 预计收益 → 工作量

| # | 问题 | 证据 | 建议 | 预计收益 | 工作量 |
| --- | --- | --- | --- | --- | --- |
| A | **浏览器争用**：单一共享浏览器 + 抢占式锁，5 个实现代理 + 5 个审查代理 + 若干返工全部串行 | `DX_FEEDBACK.md` 汇总 ≥475 分钟等锁；T14/T03/T02 返工都反映「15 秒轮询被 1 秒轮询者截胡」；T02/T03 都遇到过共享浏览器 `GL_RENDERER=Disabled` 连累所有人 | 拆成两类使用场景：①**自测 / 联调 / 编译检查 / 冷启动测量 / 单代理截图**——改用每代理私有 headless `chrome.exe`（§1.1 已验证走真实 GPU，`--use-angle=d3d11` 钉死），**完全不碰共享锁**；②**跨代理必须严格可比的权威测量**（性能工程师的预算判定、需要真人看的最终视觉核验）——保留共享浏览器 + 锁，但使用频率会因为①分流而大幅下降。锁本身也改成时间戳文件 FIFO 而非 `mkdir` 抢占 | 预计把 ≥7.9 小时的等锁时间压缩到「只剩权威测量」这一小部分，估计减少 70–90% | 中：写一个 `scripts/dev-browser.mjs`（自动发现 `ms-playwright` 缓存的 `chrome.exe`、起独立端口的 vite dev server、返回 `{page, close}`），FIFO 锁是给 `browser.lock` 加一个按创建时间排序的等待逻辑，改动小 |
| B | **测量工具零散、重复造轮子**：批渲 bench、真冷启动、冻结镜头、GPU timer 全靠各代理现写 | `tmp/` 下 12 个 `cold*.js` + 8 个 `perf*.js` + ~16 个截图脚本，`apps/voyage/scripts/` 只有 2 个文件；`EXT_disjoint_timer_query_webgl2` 从未被实际使用（`grep` 全仓库为空），尽管 §1.1 证实私有 headless 里该扩展可用 | 把 `tmp/review-t06/perf.js`（批渲 + 冻结 `uCloudOffset` + sampler 计数，是目前最完整的一版）和 `tmp/review-t02/cold.js`（nonce 破缓存真冷启动）收进 `apps/voyage/scripts/perf/`，参数化端口；新增基于 `EXT_disjoint_timer_query_webgl2` 的 GPU 计时封装作为批渲法的备选（更准，噪声更小） | 每个实现 / 审查代理省下「重新发明测量方法」的 10–20 分钟，且方法统一后不同代理的数字才能互相比较 | 中：主要是整理 + 加参数，逻辑已经被验证过多次 |
| C | **回归脚本不够健壮**：无固定视口、`only` 不可从外部传参、帧时间仍用 rAF 中位数、无 GPU 渲染器回读、无「等异步状态」通用钩子 | 直接读 `apps/voyage/scripts/regression.playwright.js`：第 77–94 行仍是原始 rAF；第 13 行 `only` 硬编码 `null`；全文没有 `setViewportSize`；T03 返工「视口被改，帧时间涨 40 倍且静默作废」就是这一版脚本造成的 | 脚本开头加 `page.setViewportSize({width:1600,height:1200})` 并把渲染器名（`WEBGL_debug_renderer_info`）和视口一起写进返回值；`only`/`headX`/端口改成从 `filename` 之外传不了参数的限制下用「读取一个约定的 JSON 参数文件」或者干脆迁移执行方式到 §A 的私有 headless 脚本（Node 侧天然能传 `process.argv`）；帧时间统一换成批渲法或 timer query；新增可选的「等到 `ground.pending<5`」之外的通用 `waitFor` 断言列表 | 直接消除「视口被别人改」这类数据静默作废的事故；`only` 可传参后审查代理不用整份跑 11 个场景 | 小–中：脚本已有骨架，主要是补齐固定项和把执行方式挪到 Node 侧 |
| D | **离线着色器检查未收编**，且只覆盖默认变体 | §1.3 实测：拼装 1 s + 校验 0.1 s，能抓保留字和重名函数；`tmp/dx/tmp-dump-shader.mjs` 至今未提交、只在一个代理的 worktree 里出现过 | 收进 `apps/voyage/scripts/lint-shaders.mjs`：枚举已知变体组合（默认场景、`GROUND_DETAIL`、机翼 pass，未来新变体在这里登记）分别 dump + 校验；`pnpm --filter voyage build` 前置一步跑它（几乎不增加时间） | 把「重名函数只在某个变体凑齐时才暴露」这类坑从「合并后才发现」提前到「写完就能查」，本波 T02×T06 撞名的返工成本可完全避免 | 小：拼装脚本已验证可用，主要是变体枚举 + 打包 npm 包依赖 |
| E | **热点文件接入方式不稳定**：接入片段 / 按段归属 / 直接提交接入后的文件，三种都试过 | T05 交付走「接入片段」，T05 审查明确说「按 handoff 手工接入 scene.ts 再审容易出错」；T06 试「按段归属」（只改 `main()` 的舱内合成段）；T05 返工时改成「直接提交接入后的 `scene.ts`」，合并时只剩 git 冲突，效果更好（T05 审查报告原话） | 长期方向：把 `scene.ts` 的组合根改造成「固定挂载点」——比如 `main()` 固定调用 `wingView(ctx)`、`cabinView(ctx)` 这样签名固定的模块函数，任务只需要新建/替换模块文件、不用碰 `scene.ts` 本体；短期（下一波就能用，不用等架构重构）：**统一要求「直接在分支提交接入后的热点文件」而不是交接片段**，冲突留给协调者用 `git merge` 而不是手工誊抄 | 短期：减少协调者手工接入出错率（这波至少 3 个任务因为手工接入/还原被记录为「别扭」「容易漏还原」）；长期：并行度可以不受热点文件数量硬限制 | 短期：零工作量（只是流程约定）；长期（固定挂载点重构）：大——涉及渲染架构改动，要走完整任务 + 审查流程 |
| F | **worktree 与主仓库 `tmp/` 隔离**导致代理写不了脚本、MCP 读不到 scratch | `.gitignore` 第 7 行 `tmp/`——已验证：`tmp/` 未纳入版本控制，`git worktree add` 检出的新工作树里**根本没有这个目录**，这是文件系统事实不是策略限制；T02/T05/T14 反馈都撞上「worktree 写不了主仓库 tmp/」；Playwright MCP 的 `browser_run_code_unsafe` 只能读主仓库路径下的脚本 | 两选一：①每个 worktree 创建后自动加一条 Windows junction/symlink，把 `<worktree>/tmp` 指回主仓库的 `tmp/`（T06 报告里提过用 junction 指 `node_modules` 的先例，思路相同）；②在 SOP 里写死约定——凡是要给 Playwright MCP 读的脚本，一律先 `Write` 到 scratchpad 再 `cp` 到主仓库 `tmp/<任务>/`（T14 已经这么做），把这条从「代理各自摸索」变成「文档写明」 | 减少「Write 不允许写主仓库路径」「heredoc 判定为越界」这类被拦截、要绕路的报告（本波至少 4 份反馈提到） | 小：①是一次性加一行 junction 创建逻辑；②是纯文档 |

---

## 3. 分工评估

### 3.1 本波各角色实际负载与摩擦

- **实现代理（5 个并行：T02/T03/T05/T06/T14）**：负载不均——T05 返工 3 轮、等锁累计超 1 小时，是本波压力最大的任务（机翼是复杂度最高的视觉任务，且一度独占 `main.ts`/`scene.ts` 接入点，冷编译一度到 104 s）；T14 等锁最多（40 分钟）但只返工 0 轮，说明锁排队和任务复杂度是两个独立的摩擦源，不能只靠「减少任务数」解决锁问题（见 §2 的 A 项）。
- **审查代理**：本波起「审查一律用主分支合并本分支的临时工作区对比」（T03 审查发现问题后补进 SOP），每次审查多花约 3 分钟装依赖/建工作区，但避免了把海浪/云等其他任务的开销混进对比——这个改动是本波唯一一次「审查代理自己发现流程漏洞并当场推动 SOP 修订」，值得作为范例：**审查代理不该只是被动执行清单，也要能反馈流程问题**，这条已经在生效，不用额外调整。
- **协调者（主会话）**：本波要处理 5 个任务的接入片段（T05/T06/T14 均以片段或按段交付）、多次中途纠偏（T03 塔身「土豆块」）、额度耗尽后的断点续做协调；另外我核查发现 `git worktree list` 里有 **6 个已合并但未清理的 worktree**（T02/T03/T05/T06/T14 的 worktree 全部还在，其中 T06 的还处于 `locked` 状态），说明 SOP 第 6 步「清理已合并的 worktree」在本波没有被执行——这是协调者负载已经饱和的一个信号，不是遗漏一次那么简单。
- **美术总监**：本波前几次审查由审查代理「兼」美术总监视角（T05 审查、T06 审查、以及本次写这份报告时并行进行的美术总监审查也说明「没用共享浏览器，判断全靠静态截图」），说明「兼任」在实践中已经是默认做法，不是例外。

### 3.2 每波并行度建议

- **现状（浏览器仍是单点共享资源）**：5 个实现任务同时跑，产生了 ≥7.9 小时的锁等待，且返工会让同一批任务再抢一轮锁。**建议在 §2-A 的私有 headless 方案落地之前，把每波视觉类实现任务的并行度降到 3–4 个**：理由是锁竞争带来的等待不是线性增长——「谁能抢到」是概率事件，任务数越多，单个任务被连续截胡到失去耐心的概率越高（T03「15 秒轮询总被 1 秒轮询者抢走」、T02 返工「改成 1 秒轮询才拿到」，说明代理已经在自发内卷轮询频率，这是要修的信号，不是要接受的常态）。
- **落地 §2-A（私有 headless）之后**：多数自测 / 联调 / 冷启动测量不再依赖共享锁，届时约束条件变回 SOP 原有的「热点文件每波只分给一个任务」，5 个并行任务可以维持，甚至可以放宽到 6 个（只要文件归属不重叠）。**这是一个两阶段建议，不是一次性调整**。

### 3.3 集成测试员：不建议新增角色，建议脚本化

DEV_SOP 6.5 节留了一个开放问题：「是否需要新增『集成测试员』或把职责做成脚本」。我的判断：**不新增角色**。理由——一个「集成测试员」要做的事（typecheck、build、0 字节检查、离线 shader 检查、sampler 计数、回归截图对比、冷编译预算校验）全部是**确定性、无需判断力、可重复**的步骤，正是脚本该做的事，用一个 Agent 来做只是多了一层不必要的（而且不便宜的）判断开销。建议把 §2 表里 B/C/D 三项做完之后，组合成一个 `apps/voyage/scripts/wave-gate.mjs`，串联全部检查，协调者在 SOP 第 6 步「主分支上跑完整验证」时跑这一条命令而不是分别记住 6 件事。

### 3.4 模型搭配建议

- 继续用 **Opus**：着色器 / 物理 / 渲染架构的实现与审查（本波 T02/T03/T05/T06/T14 全部是这一类，Opus 是对的选择）；§2-E 的「固定挂载点」架构重构（风险高，需要判断力）。
- 改用 **Sonnet**（参照第 1 波 T01 纯机械重构用 Sonnet 且一次审查通过的先例）：§2 表里的 A/B/C/D/F 五项 DX 任务——它们都是「照抄已经验证过的模式、整理成参数化脚本」，不需要美术判断或物理推导。开发体验官本身（这次审计）也全程在 Sonnet 上完成，命令行验证类工作不需要 Opus。

### 3.5 审查是否应默认兼美术总监视角

**建议正式转正**。本波至少 3 次实践（T05 审查、T06 审查、以及协调者对 T02 的核验）都是「审查代理顺带看画面像不像」，且每次都抓到了有价值的「出戏」问题（T06 的夜间划痕、织物质感）。建议把 DEV_SOP 第 5 节「独立审查」的第 2 步（画面）显式加一句：**审查视觉相关任务时默认带美术总监视角**（对照真实照片 / 铁律判断，不只是和主分支像素对比），独立的美术总监批次保留给「整体协调」这种单任务审查看不到的跨任务问题（本波真实案例：T14 的窗板指纹同心圆环是多任务叠加后才明显的）。

---

## 4. 建议排进 TASKS 的 DX 任务清单

按「预计收益 ÷ 工作量」排序，**前 3 条建议下一波就做**：

| 编号 | 标题 | 归属文件 | 验收标准 | 收益/工作量 |
| --- | --- | --- | --- | --- |
| **DX-01**（下一波） | 私有 headless Chromium 联调脚本 | 新建 `apps/voyage/scripts/dev-browser.mjs`（launch 封装：自动定位 `ms-playwright` 缓存的 `chrome.exe`、钉死 `--use-angle=d3d11`、起独立端口 vite dev server、暴露 `page`） | 在没有 `tmp/browser.lock` 的情况下，跑通「打开页面 → 等 `__voyageStartup` → 截图」全流程；`WEBGL_debug_renderer_info` 回读结果里渲染器字符串包含 `D3D11`（不是 SwiftShader）；不创建、不检查 `tmp/browser.lock` | 大 / 中 |
| **DX-02**（下一波） | 离线 GLSL 检查收进 scripts，覆盖已知变体 | 新建 `apps/voyage/scripts/lint-shaders.mjs`；依赖 `glslang-validator-prebuilt-predownloaded`（写入 `apps/voyage/package.json` 的 `devDependencies`） | 对默认场景变体、`GROUND_DETAIL` 变体、机翼 pass 三个已知组合分别 dump + 校验；故意在源码里引入一个重名函数能让脚本以非 0 退出码报错并指出文件；整体运行时间 < 5 s | 大 / 小–中 |
| **DX-03**（下一波） | 回归脚本加固：固定视口、GPU 渲染器回读、`only`/端口可传参 | `apps/voyage/scripts/regression.playwright.js` | 脚本开头固定调用 `setViewportSize`；返回值里带 `renderer` 字段；跑「只测 2 个场景」不需要改文件本身（通过 Node 侧参数或 §DX-01 的私有浏览器脚本传入）；用另一个代理改视口后重跑，帧时间数字不受影响或脚本能检测到视口不一致并报警 | 大 / 小–中 |
| DX-04 | 批渲 bench / 冻结镜头 / 真冷启动三件套收编 | 新建 `apps/voyage/scripts/perf/bench.mjs`、`freeze.mjs`、`cold.mjs`（从 `tmp/review-t06/perf.js`、`tmp/review-t02/cold.js` 整理，参数化端口） | 用同一套脚本分别测主分支和任意 worktree 端口，输出的数字与原 tmp 脚本对同一场景的历史数字在噪声范围内一致；`tmp/` 下不再需要新开 `cold*.js`/`perf*.js` | 中–大 / 中 |
| DX-05 | `wave-gate.mjs` 集成校验脚本 | 新建 `apps/voyage/scripts/wave-gate.mjs`（依赖 DX-01~04） | 一条命令跑完 typecheck + build + 0 字节检查 + DX-02 离线 shader 检查 + DX-03 回归截图 + 冷编译预算对比（阈值 ±20%），任一项失败非 0 退出并指出具体项 | 中–大 / 中 |
| DX-06 | worktree 自动打通 `tmp/` | `.claude/`（worktree 创建脚本，若可配置）或 SOP 文档约定 | 新建的 worktree 里 `tmp/` 能读写到主仓库同一份内容（junction 或明确的「先写 scratch 再 cp」约定写进 DEV_SOP） | 中 / 小 |
| DX-07 | `__voyageStartup` 拆分云程序 / 场景程序编译耗时 | `apps/voyage/src/main.ts`（`startup` 计时段） | 能区分「云噪声/云密度相关的编译增量」与「地面/机翼等其他模块的编译增量」——目前云密度函数是内联进场景程序的，需要设计一种可关闭子模块重新编译对比的机制（比如构建时的 stub 开关），不是简单加 `tick()` 就能做到，验收标准需要在实现前再细化 | 中 / 中–大 |
| DX-08 | 热点文件固定挂载点重构 | `apps/voyage/src/render/scene.ts`、`apps/voyage/src/main.ts`，新建模块按需 | `scene.ts` 的机翼/舱内合成段改为调用签名固定的模块函数（如 `wingView(ctx)`）；全部 11 个回归场景像素级不变；新增一个模拟任务（改动仅限一个新模块文件）验证不需要碰 `scene.ts` 本体 | 大（长期） / 大 |

---

## 摘要（给协调者）

- 报告：`D:\Code\opus-test\apps\voyage\research\DX_REPORT_wave2.md`（本文件，未提交 git）。
- **一句话结论**：这一波的效率问题几乎全部来自「共享一个浏览器」这一个设计决定——≥7.9 小时的锁等待、冷编译测量本身要吃锁、20 多个重复的临时脚本，都是这个单点约束的连锁反应；typecheck/build 本身很快（<3 s），不是瓶颈。
- **验证过、可以直接排的三件事**：私有 headless Chromium 在本机默认就走真实 GPU（ANGLE/D3D11，`MAX_TEXTURE_IMAGE_UNITS=16`、`EXT_disjoint_timer_query_webgl2` 都在，唯独要避开 `chrome-headless-shell.exe` 这个会静默退化到 SwiftShader 的二进制）；离线 GLSL 检查全链路跑通、1.1 秒内能抓到保留字和重名函数；`regression.playwright.js` 缺固定视口是本波一次数据报废事故的直接原因。
- **分工**：不建议新增「集成测试员」角色（脚本化即可）；建议审查代理默认带美术总监视角（已是事实上的做法）；短期把每波视觉类并行任务数降到 3–4，落地私有 headless 方案后可以回到 5–6；DX 工具任务建议用 Sonnet，架构级重构（DX-08）和所有着色器/物理任务继续用 Opus。

---

## 开发体验反馈（我自己的）

- **慢**：没有；本次审计全程命令行 + 独立进程，最长的单步是验证 `playwright-core` 私有浏览器端到端冷启动（约 92 s，属于被测对象本身的耗时，不是我的工具卡顿）。
- **卡**：①第一次直接 `node tmp/dx/tmp-dump-shader.mjs` 从仓库根跑失败（`ERR_MODULE_NOT_FOUND: vite`）——Node 的 ESM 解析是从脚本自身目录向上找 `node_modules`，脚本得放进 `apps/voyage/` 树内才能找到 `vite`；②`npx glslang-validator-prebuilt-predownloaded` 直接失败，因为这个包没有 `bin` 字段，得 `require(...).getPath()` 拿路径自己 spawn，这个细节容易被后来者当成「能直接 npx 跑」而踩坑。
- **怎么绕过 / 希望有什么**：为了验证「每代理私有 headless 浏览器」是否可行，我在临时目录 `npm install playwright-core` 后直接 `chromium.launch({executablePath: <ms-playwright 缓存的 chrome.exe>})`，全程不碰共享锁，验证完把安装的临时包和产物都删了。这个探测边界（「装临时 npm 包、起独立浏览器进程算不算越界」）目前全靠我自己判断，DEV_SOP 里没有明确写「开发体验官在验证工具链设想时可以做什么」。希望能在 DEV_SOP 里补一条：开发体验官验证工具链可行性时，允许在临时目录安装依赖、起独立进程做验证，前提是不改 `src/`、不碰共享浏览器锁、验证完清理干净——这样下次不用每一步都自己权衡「这算读写代码吗」。
