# FOCUS-ZOOM 独立审查报告

审查对象：分支 `worktree-agent-a08d7bac992cb21ef`（代码提交 `528f5c9`；分支头 `fedac00` 只是看板/规范文档追加，不含代码）。
审查方式：只读 diff + 在临时合并 worktree（`tmp/fzrev`，已删除，见文末）里复现交接文档给出的全部验收脚本，硬件渲染（`ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 …) D3D11`）。

## 结论：通过

未发现正确性错误、可见回退、闪烁/拖影或交互失灵。核心声称的数字（限位表、云过渡误差、22 项交互）在独立复现中与交接文档一致或更好。发现的问题均为细微/遗留级别，按用户新规不阻塞合并，已列在下文，建议随合并一并记进 README 坑点或后续任务。

---

## 一、核实过程与结果

### 1. 构建与基础门禁（`tmp/fzrev` = detach master + merge --no-commit 本分支）

- `pnpm --filter voyage typecheck`：通过。
- `pnpm --filter voyage build`：通过，`dist/assets` 无 0 字节文件。
- `pnpm --filter voyage check:glsl`：全部 `[OK]`，含「场景表同步（scenarios.mjs ↔ regression.playwright.js）」「README 表格与实测比对」。
- `merge --no-commit worktree-agent-a08d7bac992cb21ef` 到当前 master（已含 SPEC-RAYS 的看板更新，但**不含** SPEC-RAYS 实际代码）：自动合并干净，无冲突。

### 2. 交互（`FOCUS-ZOOM-input.mjs`，端口 5272，真实鼠标/键盘/CDP 触摸）

**22 项全部复现通过**（与交接文档数字一致）：按住 0.18 s 平滑放大到 2.5×（peak 2.5，单调，相邻帧最大对数步 0.068）/ 松开平滑还原；按下即拖（160 px）不聚焦、头部 Δx = −0.0280 m；聚焦中拖动灵敏度 ÷ 倍率（Δx = −0.0112 m = −0.0280 / 2.5）；按住 Z 聚焦、日期框聚焦时 Z 不触发；触屏长按/抬起；`?zoom=4` 生效且 hint 注明「URL 参数 zoom 优先」、不写记忆；脚本 `dispatchEvent` 不写记忆、真实按键写记忆（`{"v":1,"mag":6.1}`）；刷新后恢复；双击复位；`Shift+D` 切换并记忆；`?dev=<时间戳>` 不显示开发者区、`?dev=1` 显示；限位在两侧座位/舱等下的数值与聚焦倍数、软限位拉回（相邻帧最大 8.75 mm / 8.28 mm）；自动画质档聚焦中不降档、松开 3.5 s 后降档；控制台 0 error。

### 3. 云 resolve 正确性（跨模块契约，重点复核项）

**逐位核对**（`FOCUS-ZOOM-bitwise.mjs`）：
- 不聚焦时，本分支 resolve 输出与「换回 master 写法」的版本在 `sea-sc`、`noon-cumulus` 的静止/巡航下**逐位差 = 0**（15,360,000 个浮点全部相同）——核心不变式确认成立。
- 主循环里不聚焦时 `uTanHalfFov` 与 master 常量 `Math.tan(25°)` 逐位相同；场景表所有 `head` 不被限位改动。
- **发现一个测量方法上的现象**（非本 PR 引入的回归）：`sea-sc` 场景下，把「本分支代码」连续跑两次（第三次重跑 `a2`，中间穿插了一次 shader 文本切换到「master 写法」再切回来的 `b` 运行）会有约 14%（2,128,194 / 15,360,000）的浮点不同；`noon-cumulus` 则两次都是 0 差。追查 `clouds.ts` 的 `updateShadow()` / `updateOccupancy()`，两者都是**跨帧分片增量重建**的状态机（`shadowSlice` / `occBuildLayer` 等实例字段），不被 `c.snap()` 重置，因此在同一页面里连续跑三段 64 帧序列时，云自阴影贴图的构建进度会在三段之间被继续推进而不是每段独立复现。这解释了为什么“同代码两次”会不同，而与本 PR 改动的 resolve 重投影逻辑无关（该逐位对比用的是相邻的 `a` vs `b`，两者共享同一段起始状态，因此仍能得到 0 差这个强结论）。**建议**：以后类似「同代码自比噪声底」的测量如果要用到有阴影贴图分片重建的场景，脚本里在每个 `run()` 前显式把 `shadowSlice=-1` 等状态复位，或换用没有渐进重建的场景；不建议现在为此返工。

**过渡期误差**（`FOCUS-ZOOM-cloud.mjs`，`sea-sc` 4×，独立复现）：

| 帧 | 视场倍率 | cur（本分支） err/edge | naive（改前写法） err/edge | reset（对照） err/edge |
| --- | --- | --- | --- | --- |
| 预热末 | 1.00 | 0.039/1.02 | 同 | 同 |
| 放大过渡中 | 2.47 | 0.133/0.80 | 0.464/0.50 | 0.473/1.24 |
| 放大结束 | 4.00 | 0.122/0.82 | 0.409/0.66 | 0.508/1.34 |

与交接文档的数字（0.132/0.80、0.461/0.52、0.469/1.24 等）基本一致（小数点后第二位的差异是不同随机种子下的正常波动）。确认：改前写法（`naive`）在过渡中误差是本分支的 3.5 倍左右、云边梯度能量比腰斩（拖影/重影明显更严重）；直接清空累积（`reset`）在过渡中是 1 spp 噪点（edge > 1.2）。本分支的方案（`uPrevTanHalfFov` 重投影 + 视场变化帧压低 `uSinceReset` 到 ≤8）确实在两个失败模式之间取得了更好的折中，**没有拖影/重影/闪烁**。

代码走查：`uPrevTanHalfFov` 在 `render()` 末尾用**这一帧**的 `uTanHalfFov` 更新、供**下一帧** resolve 使用，时序正确（resolve 用的是「历史贴图被写入时的视场」而不是「读取历史时的视场」）；`uSinceReset` 的压低判断发生在 `r.uPrevTanHalfFov.value` 被覆盖**之前**，所以比较的是「这一帧视场」与「上一帧视场」，语义正确。C11 的云里 3×3 平均分支（`wImm > 0`）与 C12b 的自适应 blend／Catmull-Rom／reset 等权兜底（`blend = max(blend, 1/(uSinceReset+1))`）均未被替换，只是让 `uSinceReset` 在视场变化的帧里额外被压低——是对既有机制的调用方式改动，不是绕过或破坏。

### 4. 头部左右限位（几何判据）

- 离线重算 `FOCUS-ZOOM-limits.mts`（商务舱右座/左座默认头高）与交接文档表格**逐格一致**（如 z=−0.20：1× 给 0.278/45°，1.5×+ 放宽到 0.299/47°；z=−0.03：1× 0.097/43°，2.5×+ 0.188/61°）。
- 限位截图（`FOCUS-ZOOM-limit-scenes.json` 全部 9 个场景，含商务/经济舱前后、头最高+侧看、火车两侧、8× 聚焦、夜景）：控制台 0 error；目视核对 `lim-biz-right-mid-high`（头最高 y=0.18、z=−0.2、x=−0.45 极端位置）与 `lim-eco-right-aft` 均无黑洞/空白侧壁；夜景场景的黑色区域是合法的夜海/夜空（与交接文档说明一致）。
- 与自动测试一致：现有视角预设与场景表所有 `head` 均不在限位内被夹（`headsClamped` 为空数组）。

### 5. 面板 UX（PANEL_UX_GUIDE 合规）

- `#dev-section` 默认 `hidden`；由于 `[hidden] { display: none !important; }` 全局规则已存在（`style.css:15`），新增的 `.dev-section { display: flex; … }` 不会覆盖 `hidden`（`!important` 优先级更高）——正确规避了「T49/UX-1 踩过两次」的坑。
- URL 冲突已正确处理：`dev-browser.mjs` 的防缓存参数是 `?dev=<Date.now()>`（13 位时间戳），而开发者区的判断只认 `""`/`"1"`/`"true"`/`"on"`（大小写不敏感），两者不会互相触发；独立复现 `?dev=1` 打开、`?dev=<时间戳>` 不打开。
- 快捷键守卫：`Z` 复用既有的 `isLetterShortcut`（不带 Ctrl/Alt/Meta、焦点不在会吃字母的控件里），与 H/B/M/N 同一套逻辑，未见不一致；`Shift+D` 单独判断（`!e.shiftKey` 取反）符合「带 Ctrl/Alt/Meta 组合不拦截其它单字母键」的既有约定。规范文档 `PANEL_UX_GUIDE.md` 的快捷键表已在分支头提交（`fedac00`，由协调者代记）补上 `Z`、`Shift+D`。
- 记忆：只在 `event.isTrusted` 为真时写 `localStorage`；URL 生效的这次不写记忆；三项设置各自独立复位（双击）——均与规范第 7 节一致。
- 数值格式：倍率 `2.5×`（1 位小数）、过渡 `200 ms`（取整）、暗角 `40%`（整数百分比）；暗角/过渡的格式与规范一致，倍率用 1 位小数（规范里的「整数 + ×」条目针对的是时间流速等离散倍率，聚焦倍率是 0.1 步长的连续量，用小数位更合理，不算违规）。

### 6. main.ts（热点文件）改动核查

- 改动集中在：imports、`setupViewControls` 调用（新增可选 `opts`）、`setupUi` 传参、每帧 `renderFrame` 里的视场/限位/头部 x 计算段、`frame()` 里的 `quality.pauseDecisions`、`__voyage` 句柄追加 `focus`/`headLimits`。均是新增/在既有语句上局部替换，未见误删其他任务逻辑的迹象。
- `head.x = headLimits.clamp(head.x + (head.tx - head.x) * k)` 与原 `head.x += (head.tx - head.x) * k` 在未触发限位时数学等价（先加后夹，夹不生效时结果相同）。
- `headLimits.update()` 使用的是**这一帧**已推进的 `head.y/head.z` 与**这一帧**刚写入的 `tanHalfFov`，随后夹取 `head.x`，顺序正确，与交接文档描述一致。

### 7. 与在途分支的 merge-tree 冲突排查

用 `git merge-tree --write-tree` 模拟（未产生任何真实提交/推送）：

- **FOCUS-ZOOM 合并进当前 master**（已含 SPEC-RAYS 的看板记录、不含其代码）：**干净**，`__voyage` 句柄正确追加 `focus, headLimits`。
- **FOCUS-ZOOM ∪ REFLECT-OFF**（`worktree-agent-a2014be3412897d94`，端口 5269，同样改了 `index.html`/`src/ui.ts`）：**干净**，无文本冲突。
- **FOCUS-ZOOM ∪ SPEC-RAYS 实际代码**（`worktree-agent-a148424e65b711419`，尚未合并，`rays.ts` 425 行 + `main.ts` 12 行改动）：**冲突**，落在 `apps/voyage/src/main.ts` 的多处热点：`setupViewControls`/`setupUi` 调用行、`renderFrame` 里 `head.x` 那几行与 SPEC-RAYS 的 `rays.render(hdrOutside)` 合成改动紧邻、以及末尾 `__voyage` 字段行。两边改动在**逻辑**上不冲突（FOCUS-ZOOM 管头部/视场/限位，SPEC-RAYS 管窗外合成后再减一层云隙光），只是**文本行**相邻导致 git 自动合并失败，需要协调者合并时手工接一次（预计几分钟，风险低）。这是 DEV_SOP 里「一波里热点文件只分一个任务」被两个并行任务同时触碰的正常后果，**不是 FOCUS-ZOOM 的代码缺陷**，仅供协调者合并排期参考。

---

## 二、问题清单（均为遗留，不阻塞合并）

1. **【遗留·测量工具】** `sea-sc` 场景下连续 3 次调用 `Clouds.render()` 序列会因云自阴影贴图的增量重建状态（`shadowSlice`）跨次残留而产生约 14% 的「同代码自比」差异，与本 PR 的改动无关。建议以后写类似「同代码噪声底」测量脚本时，在每个 `run()` 前显式复位 `shadowSlice=-1`（或选用不触发分片重建的场景）。不建议现在为此返工。
2. **【遗留·已知问题，已建任务】** 窗洞近侧黑带根因未查（README 已记录，任务 W-WINDOW）、机翼襟翼/后缘亚像素缝在放大后可见（同任务 W-WINDOW）、聚焦时整帧 GPU ×1.16–1.56（任务 PERF-ZOOM，用户/协调者已接受为短暂行为、不作为返工理由）——均已建看板任务，交接文档与 TASKS.md 一致，无需本次处理。
3. **【极细节·可选】** 面板开发者区三个滑条的数值格式里，倍率用 1 位小数（`2.5×`）而不是 PANEL_UX_GUIDE 数值表字面写的「整数 + ×」；判断是该表格未覆盖 0.1 步长连续倍率这一情形，不算违规，无需改动。

---

## 三、开发体验反馈

- 交接文档质量高：给出的判据、表格、命令行均可直接复现，逐格/逐位对得上，大幅减少了审查里「重新定位实现细节」的时间。
- 复用测量库（`measure-lock.mjs`、`dev-browser.mjs shots`）体验良好；唯一摩擦点是复核开始时撞上了一把 60 秒以上的残留锁（持有进程已不存在），`acquireOrWait`/`waitForRelease` 自动识别并清掉，没有额外操作，符合预期。
- 建议（不要求本次处理）：`FOCUS-ZOOM-bitwise.mjs` 的「同代码两次」这一栏在 `sea-sc` 上目前更多反映的是阴影贴图分片重建的残留状态而不是 shader 本身的噪声，容易让后续审查者误判成「shader 有隐藏噪声」；加一行注释或复位一下 `shadowSlice` 会更省后来者的时间。

---

## 四、临时工作区清理

复核用 worktree `D:\Code\opus-test\tmp\fzrev`（detach master + `merge --no-commit`，未推送，含一个仅用于本地 `merge-tree` 比对的 WIP 提交）已在审查结束后删除；开发服务器（5272）已停止。未改动/未提交任何主分支或被审分支的内容。
