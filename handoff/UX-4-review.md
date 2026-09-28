# UX-4 审查报告 · 手机 / 小窗底部抽屉 + 收起按钮

审查代理（独立子代理，中档），审查分支 `worktree-agent-aaced8ae7eb3c7803`（worktree
`D:\Code\opus-test\.claude\worktrees\agent-aaced8ae7eb3c7803`，提交 `873f898`）相对 `master`
（审查时 `master` 为 `f38e88c`）的改动。只读审查，未改实现代码。

## 结论：需返工

代码结构、控件契约、抽屉交互（点击 / 拖动 / 键盘 / 记忆 / 断点切换）本身实现扎实，实测全部符合预期；但
**展开态的高度上限用错了规范数字**：实现与交接文档从头到尾把「展开后 ≤ 70vh（70% 屏高）」当成既定目标核对，
而任务实际引用的规范 `research/PANEL_UX_GUIDE.md` §9「窄屏 / 手机」与 `research/PANEL_UX_AUDIT_1.md`
P6/UX-4 验收行都明确写的是**「展开后 ≤ 40% 视口高」**。70% 是 §9 里**桌面**面板的高度上限（「高度不超过
视口的 70%」），被套用到了窄屏抽屉上，展开态实际遮挡比规范多出 30 个百分点（超规范 1.75 倍），不是
DEV_SOP「细微视觉打磨（百分之几的误差）」可以降级为遗留的量级，判定为阻塞，需要返工。

其余项目（桌面逐位不变、控件 id / value 契约、收起态面积与不挡中心圆、点击 / 拖动 / 键盘可达性、记忆的
`isTrusted` 与 `try/catch`、断点切换无残留、typecheck / build / 0 字节 / `check:glsl` / 控制台零 error）
逐项核实全部通过，详见下文。

## 阻塞问题

### 1. 展开态 `max-height: 70vh`，规范要求 `≤ 40% 视口高`

- **位置**：`apps/voyage/src/style.css:117`（`@media (max-width: 720px), (max-height: 500px)` 块内
  `#panel { ...max-height: 70vh... }`），注释在 `style.css:112`；`ui.ts:1065` 的函数注释同样写「收起到
  ≤ 70vh」；`handoff/UX-4.md:47/51/93/95/154`、`README.md:56` 均以「70vh / ≤70% 屏高」复述这个（错误的）
  目标数字，验收表格（`UX-4.md:93/95`）里把 `591px = 70vh`、`273px = 70vh` 当作「符合预期」记录下来，
  没有对照规范原文核实过这个数字本身。
- **现象（实测，Playwright + `dev-browser.mjs shots --freeze`）**：
  - 390×844 展开：`rect 390×590.8`，590.8/844 = 70.0%。
  - 844×390（横屏）展开：`rect 844×273`，273/390 = 70.0%。
  - 规范原文（`research/PANEL_UX_GUIDE.md` §9）：「**窄屏 / 手机（宽 < 600 px）**：底部抽屉……展开后
    **≤ 40% 视口高**」；桌面规则单独一条「**桌面（宽 ≥ 900 px）**：……高度不超过视口的 **70%**」——两条
    分属不同断点，70% 是桌面数字，本任务的抽屉断点（≤720px 宽或 ≤500px 高）属于窄屏，理应对齐 40%。
  - `research/PANEL_UX_AUDIT_1.md` P6/UX-4 那一行的验收标准原文也是「……展开 **≤ 40% 高**」「展开后
    **≤ 40%**」，与 §9 一致，不是我个人的解读。
- **判断依据**：不属于 DEV_SOP「细微视觉打磨（百分之几的误差、零点几级颗粒、静帧指标差几个点）」的降级
  范围——这是直接引用错了规范里另一个断点的数字，偏差 30 个百分点（相对超标 75%），且交接文档没有像断点
  宽度那样注明「简报要求偏离规范、理由是……」，看起来是核对规范时漏看了窄屏与桌面是两条不同的规则。
- **验证过修法可行**（未改动仓库文件，只在浏览器里临时改了 `#panel.style.maxHeight` 预览，未落盘）：
  ```js
  document.getElementById('panel').style.maxHeight = '40vh';
  ```
  390×844 下抽屉正确收缩到 337.6px（= 40vh），`.panel-body` 依然可以内部滚动
  （`scrollHeight 1086 > clientHeight 292`），6 个分区依旧可达，没有因为变矮出现布局错乱或内容裁切
  异常——只是一屏能看到的内容更少、需要多滚一点，这是预期的正常代价，不是新缺陷。
- **修法**：
  1. `apps/voyage/src/style.css:117` 的 `max-height: 70vh` 改成 `max-height: 40vh`（同时改第 112 行注释）。
  2. `apps/voyage/src/ui.ts:1065` 函数注释「收起到 ≤ 70vh」同步改成 `40vh`。
  3. `apps/voyage/handoff/UX-4.md` 与 `README.md:56` 里所有「70vh / ≤70% 屏高」的表述同步改成 `40vh`
     / `≤40% 屏高`，验收表格（`UX-4.md` 第 90–96 行那张表）的展开态几行需要重新实测三个视口的
     `rect`/`bodyScrollable` 数字并更新。
  4. 改完后建议实测一下 844×390 横屏下 40vh（≈156px）展开态露出的内容量是否还够用（比如一次只能看到
     标题栏 + 半行「此刻」摘要，需不需要把摘要行整体挪到把手上而不是展开区顶部——这是观感判断，留给
     实现代理按实际截图判断，不在本审查代表下判断）；数字达标是硬指标，好不好用是可以在返工里顺手看一眼
     的加分项，不是本条阻塞的必要条件。

## 逐项核对（均通过）

### 2. 桌面 1600×1200 逐位不变

- `dev-browser.mjs shots --freeze --viewport 1600x1200` 对同一份场景（`panel-desktop`）分别测本分支
  （端口 5353）与 `master`（端口 5354，`D:\Code\opus-test` 主仓库，`f38e88c`）：两边面板量测完全一致
  —— `rect {w:300, h:1101.5, top:16, left:1284}`，`scrollHeight === clientHeight === 1102`，与
  `handoff/UX-3.md` 记录的桌面基线（1102 px）一致。
- 像素级核对：分别把两张截图裁到面板区域（`--crop 1280,0,320,1200`）后 `compare.mjs --diff`：
  `mean 0.66`、`overThresholdPct 0.269%`；`--heatmap` 出图确认唯一可见的差异集中在裁剪区最上沿
  （面板顶部 `top:16px` 以上的背景天空区域，云海随机噪声底导致，不属于面板本身），面板内容区域本身
  没有可见的结构性差异。
- 原因核实：`.panel-handle` 桌面下 `display:none` 不参与 flex 布局与 `gap`，`.panel-body` 完整复刻了
  拆分前 `#panel` 自身的 `display:flex;flex-direction:column;gap:6px`，桌面下 `#panel` 视觉上只剩
  `.panel-body` 一个可见子项——读代码与实测结果一致。
- CSS 选择器核查：`style.css` 里所有 `#panel xxx` 都是**后代选择器**（`#panel select`、`#panel label`
  等），不是直接子代选择器（`#panel > xxx`），全仓库未发现任何 `#panel >` 用法；`ui.ts` 里
  `document.querySelectorAll("#panel select")`、`$("panel")` 同理不受嵌套深度影响；唯一一处
  `:first-of-type`（`#panel details.panel-section:first-of-type`）作用的元素集合仍然完整搬进了
  `.panel-body` 内部、相对顺序不变，语义不受影响。

### 3. 控件 id / option value 契约

- `id="..."` 全集去重排序后 diff：本分支只新增 `panel-body`、`panel-handle`、`panel-peek` 三个结构性
  id，master 现有 id 一个未删、一个未改名。
- `<option value="...">` 全集 diff：与 master 完全一致（逐值相同）。
- `git diff master --stat -- apps/voyage/scripts` 为空，`scripts/scenarios.mjs` /
  `scripts/regression.playwright.js` 均未被本分支触碰；`pnpm --filter voyage check:glsl` 里「场景表同步
  （scenarios.mjs ↔ regression.playwright.js）」一项回报「两边一致」。

### 4. 抽屉交互（Playwright 真实浏览器，390×844 / 844×390 / 断点切换）

全部用真实 `page.click()` / `page.keyboard.press()`（CDP 派发，`isTrusted: true`）与手写
`PointerEvent`/`MouseEvent`（`dispatchEvent`，`isTrusted: false`，用来验证记忆守卫）交叉测试：

- **默认收起态面积与遮挡**：390×844 实测 `rect 390×40, top:804`，面积 4.74%；844×390 实测
  `rect 844×40, top:350`，面积 10.26%——均优于 `PANEL_UX_AUDIT_1.md` P6 验收线「≤8%」（也优于交接文档
  自称的「≤12%」），`centerCircleOverlap` 均为 `false`。对照同场景下 `master`（沿用旧
  `@media (max-width: 600px)` 断点，844×390 不命中，走桌面右上角定位规则）实测 `rect 300×358, top:16`，
  面积 32.6%，与中心圆确有重叠——证实抽屉方案切实解决了横屏遮挡问题（交接文档「整个舷窗被盖住」的描述
  比实测偏夸张，是非阻塞的文字精度问题，见下文遗留 1）。
- **点击**：真实鼠标点击把手，`drawer-collapsed` / `aria-expanded` 正确切换；localStorage
  `voyage.pref.panel` 正确写入 `{"v":1,"drawer":true/false}`；刷新页面后记忆生效（展开态刷新后仍展开）。
- **键盘可达性**：从 `body` 按一次 `Tab`，焦点直接落在 `#panel-handle`（DOM 里第一个可聚焦元素）；
  `a.matches(':focus-visible')` 为真，实测 `outline: 2px solid rgb(217,183,122)`（`--accent`）、
  `outline-offset: 2px`，焦点环清晰可见；`Enter`、`Space` 均能正确切换展开 / 收起（原生 `<button>`
  语义，未额外写键盘事件）。
- **拖动**（`PointerEvent`，`pointerType:"touch"`）：上拉 60px 展开、下拉 60px 收起，方向判断正确；
  位移 3px（< 8px 阈值）不触发拖动切换，正确交给后续 `click` 兜底处理；拖动结束后紧跟的合成 `click`
  被 `suppressClick` 正确吞掉，不会出现「拖完又被点击再切一次」的双重切换。
- **`H` 与抽屉正交**：收起 / 展开两种状态下按 `H`，只切换 `#panel.hidden`，不影响 `drawer-collapsed`；
  再按一次 `H` 恢复显示，抽屉状态原样保留。
- **断点切换（390×844 → 1600×1200 → 390×844）**：切到桌面宽度后 `.panel-handle` 计算样式
  `display:none`、`.panel-body` 正常 `display:flex`、`drawer-collapsed` 自动为 `false`；切回窄屏后
  正确按内存里的 `open` 值（不重新读 localStorage，闭包变量常驻）恢复对应展开 / 收起状态；全程
  `#panel` / `.panel-body` / `#panel-handle` 的 `style` 属性均为 `null`，没有任何残留内联样式。
- **记忆的 `isTrusted` 守卫**：连续多次非可信（`dispatchEvent`）点击 / 拖动切换状态后，
  `localStorage.getItem('voyage.pref.panel')` 仍停留在**最后一次可信操作**写入的值，与当前真实
  `drawer-collapsed` 状态不同步——这正是设计意图（脚本操作不得覆盖用户真实偏好），实测符合预期；
  调试句柄 `window.__voyageUi.setDrawerOpen(v)` 同样确认切换状态但不写 localStorage。
- **`try/catch`**：把 `Storage.prototype.getItem/setItem` 替换成抛异常（模拟隐私模式）后点击把手，
  切换动作正常完成、无未捕获异常、控制台零 error；恢复原型后行为正常。

### 5. 构建与静态检查

| 项 | 结果 |
| --- | --- |
| `pnpm --filter voyage typecheck` | 通过，无输出 |
| `pnpm --filter voyage build` | 通过（400ms；`chunk larger than 1000 kB` 告警与本任务无关，UX-3 审查已记录为既有状况） |
| `find dist/assets -type f -size 0` | 无输出（没有 0 字节文件） |
| `pnpm --filter voyage check:glsl` | 全部 `[OK]`，含场景表同步 |
| 控制台 | 全程（桌面截图对照、三视口截图、以上全部真实浏览器交互、模拟隐私模式）**0 error** |

## 非阻塞遗留

1. **`handoff/UX-4.md` 对 master 844×390 基线的文字描述偏夸张**：表格里写「面板铺满屏幕中央，整个舷窗
   被盖住」，实测 master 该视口下面板走的是旧桌面规则（`top:16,right:16,width:300`），面积 32.6%、
   位于右侧、与中心圆确有重叠，但视觉上不是「整个舷窗」都被盖住（左侧仍可见）。底层判定用的是精确的
   `centerCircleOverlap` 布尔量，结论本身没错，只是这句描述性文字比实测偏夸张，供下次修订文档时顺手改
   得更准确，不影响本次验收结论。
2. **收起态把手实测高度 40px，比 `PANEL_UX_GUIDE.md` §9 举例的「48 px」小 8px**：40px 精确压在
   §8.2「触屏（`pointer: coarse`）点击目标 ≥ 40×40 px」的硬性下限上（不是低于下限），面积 / 遮挡验收
   数字（4.74%/10.26%）都优于审计要求的 ≤8%，判定非阻塞；如果以后要统一到示例的 48px，是一个可以顺手
   做的小调整。
3. **`TASKS.md`/`README.md` 相对当前 `master` 的 diff 混入了与本任务无关的看板改动**（`NIGHT-AP` /
   `TW02-b` 两条任务从列表消失、TW02 的合并记录条目变化）：核实是本分支合并 `master` 的时间点落在
   `1ac7802`（合并 TW02 远景对流塔层），而当前 `master` 已经往前走了一个纯看板提交 `f38e88c`（看板：
   TW02 合并，立 NIGHT-AP、TW02-b）。这不是 UX-4 分支引入的改动，只是分支落后当前 master 一个看板提交，
   属于多代理并行开发的正常时间差，合并时协调者按正常流程合并 `TASKS.md`/`README.md` 即可，不需要 UX-4
   为此返工。
4. **已知简化（实现代理已在 `handoff/UX-4.md`「已知简化」一节自行记录，复核后同意维持现状）**：收起 /
   展开无过渡动效（`max-height:none↔<定值>` 无法用 CSS transition 插值，这个限制在改成 40vh 后依然存在，
   因为一端仍是 `none`）；抽屉展开时不联动 canvas 视口上移（`PANEL_UX_GUIDE.md` §9 原文标注「方向，
   落地另议」）；触屏拖动没有跟手实时反馈（松手才切换到目标态）。三条均属细微打磨类，按 DEV_SOP
   降级规则记遗留，不阻塞本次返工范围。

## 复现方式

```bash
git -C "D:\Code\opus-test\.claude\worktrees\agent-aaced8ae7eb3c7803" log --oneline -5
pnpm --filter voyage typecheck
pnpm --filter voyage build
cd apps/voyage && find dist/assets -type f -size 0
pnpm --filter voyage check:glsl

# 桌面对照（本分支端口 5353，master 主仓库端口 5354）
pnpm --filter voyage exec vite --port 5353 --strictPort --host 127.0.0.1
# 另一个终端，在 D:\Code\opus-test 主仓库（master）下：
pnpm --filter voyage exec vite --port 5354 --strictPort --host 127.0.0.1

node apps/voyage/scripts/dev-browser.mjs shots --port 5353 --angle d3d11 --freeze --viewport 1600x1200 \
  --out apps/voyage/tmp/screenshot/<任务>/desktop-ux4 --scenes-file <场景表：js 取 #panel.getBoundingClientRect()>
# 同一份场景表对 5354 跑一遍，--crop 1280,0,320,1200 裁到面板区域后 compare.mjs --diff 核对

# 抽屉交互：Playwright MCP 打开 http://127.0.0.1:5353/?voyage=0，390x844 / 844x390 两个视口下
# 依次核对：默认收起态 rect/areaPct、真实点击展开/收起 + localStorage、Tab+Enter/Space、
# PointerEvent(pointerType:"touch") 拖动、H 键正交性、断点切换（resize 到 1600x1200 再切回）无残留内联样式
```
