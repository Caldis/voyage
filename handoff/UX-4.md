# UX-4 · 手机 / 小窗底部抽屉 + 收起按钮 · 交接

分支 `worktree-agent-aaced8ae7eb3c7803`，端口 5292。
规范 `research/PANEL_UX_GUIDE.md` §9「布局：小窗、窄屏与遮挡」、审计 `research/PANEL_UX_AUDIT_1.md` 的 UX-4 条目（P6）。
先读 `handoff/UX-3.md` / `UX-3-review.md`（分区折叠是本任务的地基）。
状态：**完成**。归属文件（`index.html` / `src/ui.ts` / `src/style.css`）改动已做完，typecheck / build / check:glsl
全部通过，`dist/assets` 无 0 字节文件；390×844、844×390（横屏）、1600×1200 三视口截图与 master 对照，桌面逐位不变、
手机默认收起态面积从 master 的 41.3%（且盖住舷窗中心）降到 4.74%（不盖），横屏从盖住整个舷窗降到 10.26%（不盖）。

## 背景：现状问题

`research/PANEL_UX_AUDIT_1.md` P6：390×844 下面板（`max-width:600px` 媒体查询给的固定底部块，`max-height:45%`）
占画面 41.3%、盖住舷窗中心，且没有专门的收起按钮（唯一途径是会顺带打开连续航程的「背景板模式」）。
`handoff/UX-3.md` 分区折叠只解决了桌面（1600×1200 从 2681 px 压到 1102 px），390×844 明确「不更差，改善留给 UX-4」。

## 断点：宽 ≤ 720px 或高 ≤ 500px

简报给的是「按指南断点，约 ≤ 720px 宽或矮屏」——比规范 §9 字面的「窄屏 < 600px 宽」宽一点，专门把手机**横屏**
（844×390：宽 844px 不算窄，但高 390px 算矮屏）也纳入抽屉模式，覆盖了 UX-3 测过但没改善的那个尺寸。
`style.css` 与 `ui.ts` 用同一个字符串常量（`DRAWER_MEDIA`）维护，改断点两处一起改：

```css
@media (max-width: 720px), (max-height: 500px) { ... }
```

未落进这个断点的尺寸（1600×1200、1280×720 等）完全不受影响——`.panel-handle` 常年 `display:none`，
`#panel` 的 CSS 与 DOM 结构对桌面渲染逐位相同（见下面「桌面零回归的证明」）。

## 实现

### DOM（`index.html`）

`<aside id="panel">` 内新增一个把手 `<button id="panel-handle">`（抓手 `.panel-grip` + 摘要 `#panel-peek` +
箭头图标 `.panel-handle-icon`），随后把原来直接挂在 `#panel` 下的全部内容（`<h1>` 到页脚 `<details>`）
包进新的 `<div id="panel-body">`。**没有改动、删除、新增任何既有控件的 id 或 `<option value>`**——只加了
4 个新的结构性 id/class（`panel-handle` / `panel-body` / `panel-peek` / `panel-grip` / `panel-handle-icon`），
均不在 `scripts/scenarios.mjs` 的契约表里。

### CSS（`src/style.css`）

- `#panel` 本身的 `display:flex;flex-direction:column;gap:6px` 挪到新增的 `.panel-body` 规则上（一字不改地
  复刻），`.panel-handle` 默认 `display:none`。桌面下 `#panel` 只剩 `.panel-body` 一个可见 flex 子项，
  等价于拆分前的样子——这是「桌面逐位不变」成立的关键，不是靠媒体查询例外撑起来的。
- 窄屏媒体查询里：`#panel` 改成 `position:fixed;bottom:0;left:0;right:0;width:100%`，自己 `overflow:hidden`
  （不再自己滚，让把手挪不动）；`.panel-handle` 变成 `display:flex` 的一条 40px 上下的把手（抓手 4×20px
  竖条 + 摘要单行省略 + 箭头，`touch-action:none` 把手势交给 JS）；`.panel-body` 改成 `overflow:auto`、
  `flex:1 1 auto`，展开态跟着 `#panel` 的 `max-height:70vh` 一起被夹住。
- **收起态刻意不写死数字**：`#panel.drawer-collapsed .panel-body { display:none; }`，`#panel` 自己没有
  `max-height`——高度交给唯一可见的子项（把手）自然撑开。算过手动写死一个「大概 44px」的临界值，但字体
  渲染的实际行高有 ± 几像素的余量，写死数字要么留太多富余、要么冒着某个浏览器 / 字体下被裁切一行文字的
  风险，不如让浏览器自己算。副作用：`max-height` 在 `none` 与 `70vh` 之间不能用 CSS transition 做平滑动画
  （`max-height:none` 不是可插值的长度），收起 / 展开是瞬时切换，没有过渡动效——本任务的验收标准里没有要求
  动效，按「够用就停」先不做，需要的话是后续一个独立的小任务（数字先测「真实渲染下把手到底多高」再定）。

### JS（`src/ui.ts`，新增 `setupDrawerUi`）

- **状态**：一个闭包变量 `open`（默认 `false` = 收起），`apply()` 只做两件事——切换
  `#panel.drawer-collapsed`（`isNarrow() && !open`）、更新把手的 `aria-expanded` / `aria-label`。
- **记忆**：复用 UX-3 的 `PANEL_PREF_KEY`（`voyage.pref.panel`）和它已经验证过的模式——`try/catch` 包住
  读写，`localStorage` 拿不到就按默认；只在 `setOpen(v, trusted)` 的 `trusted` 为真时才写（对应把手
  `click` / `pointerup` 事件的 `e.isTrusted`）。JSON 结构加一个新字段 `drawer`（与已有的 `dev`、`sections`
  字段共存，互不覆盖，写法完全照抄 `setupPanelFoldUi`）。
- **点击**：整条把手是一个原生 `<button>`，`click` 事件里 `setOpen(!open, e.isTrusted)`——鼠标点击、
  触屏轻触、键盘 `Enter` / `Space`（浏览器把它们都合成为 `click`，`isTrusted` 为真）都走这一条路径，
  不用分别写键盘事件。
- **拖动**（`pointerdown` / `pointermove` / `pointerup`，只在 `isNarrow()` 且 `pointerType !== "mouse"` 时
  接管——鼠标点一下就够，拖动只为触屏）：按住不动记录起点 `Y`，位移超过 8px 才算「真的拖了」
  （`dragMoved`），松手时按方向（上拉 `dy<0` 展开、下拉收起）调用 `setOpen`，并把 `suppressClick` 置真，
  吞掉浏览器紧跟着自动触发的那次 `click`，避免拖完又被当成一次点击再切一次。
- **「此刻」摘要**：`#panel-peek` 的内容直接跟 `#now-line1`（UX-3 已有的摘要第一行：航段 / 导航一句，
  没有就是「高度 X km」）同步，在 `updateInfo()` 里加一行 `panelPeek.textContent = nowLine1.textContent`，
  不重复一份文案逻辑。
- **调试句柄**：往既有的 `window.__voyageUi` 上合并挂了 `setDrawerOpen(v)` / `drawerOpen()`（非 `isTrusted`，
  不写记忆，和 `setBackdrop` 同一惯例），给截图 / 回归脚本一个不用模拟真实拖动手势就能切换抽屉状态的入口。

### `H` 与抽屉的关系

没有改动 `H` 的既有行为（`ui.ts` 里 `isLetterShortcut(e,"h")` 仍然 `classList.toggle("hidden")`，整个
`#panel` 隐藏 / 显示）。`H` 与抽屉展开状态是两件正交的事：`H` 隐藏时整个面板（含把手）都不见；抽屉状态
只决定「面板显示的时候，露出来的内容有多少」。手机没有物理键盘，这条本来就不是给手机用户设计的主要途径，
简报也只要求「H 仍然开关面板」（不倒退），没有要求给抽屉单独发明新的键盘绑定。

## 验收结果

用 `scripts/dev-browser.mjs shots --scenes-file` 跑自定义场景（`tmp/screenshot/ux4/scenes.json`，已忽略
不进仓库，场景 `js` 字段在 `applyScene` 隐藏面板后再 `classList.remove("hidden")` 显形并读取
`getBoundingClientRect()` / `scrollHeight` 等，手法与 UX-3 一致）分别测三个视口，另建临时对照 worktree
（`git worktree add --detach tmp/ux4-base master`，跑完已删除）在同一份场景表上跑 master 基线对照。

| 视口 | 状态 | 测量 | 结果 |
| --- | --- | --- | --- |
| 390×844 | 收起（默认） | rect 390×40、top=804；`areaPct` | **4.74%**（要求 ≤ 12%）；`centerCircleOverlap` **false** |
| 390×844 | 展开 | rect 390×591（= 70vh）；6 个分区 `present` 全 true；`bodyScrollable` | **true**（≤ 70% 屏高、可滚动、分区可达） |
| 844×390（横屏） | 收起（默认） | rect 844×40、top=350；`areaPct` | **10.26%**（要求 ≤ 12%）；`centerCircleOverlap` **false** |
| 844×390（横屏） | 展开 | rect 844×273（= 70vh）；6 个分区全 present；`bodyScrollable` | **true** |
| 1600×1200 | （媒体查询不命中，抽屉不生效） | rect 300×1102、top=16、left=1284；`scrollHeight===clientHeight===1102` | 与 `handoff/UX-3.md` 记录的 master 基线数字**逐位相同**（UX-3 交接原话「1102 px（可视区 1168 px，不需要滚动）」） |

- **控制台**：三个视口 × 两个状态，共 6 次截图，全程 **0 error / 0 pageerror**（地面瓦片 CORS 聚合警告是
  已知行为，不计入）。
- **1600×1200 桌面像素级核对**：`compare.mjs --diff` 显示整图有差异（云 / 海面纹理有随机噪声，属于
  README「零回归判断的基准是同一份代码跑两次的噪声底，不是 0」的已知现象——`--heatmap` 出图确认差异
  **全部集中在舷窗内的云海纹理**，面板所在的右侧 300px 列几乎没有红色）；单独裁剪面板区域
  （`--crop 1280,0,320,1200`）拼成左右对照图肉眼逐控件核对，**每一行文字、控件、间距、分区展开 / 折叠
  状态完全一致**（见 `tmp/screenshot/ux4/panel-side-by-side.png`，已忽略未进仓库，截图路径列在下面）。
- **交互路径核对**（`tmp/screenshot/ux4/scenes-click.json`，同样用 `dev-browser.mjs shots` 在真实页面里
  `dispatchEvent`，不是走 `__voyageUi` 旁路）：
  - 连续两次 `panel-handle.click()`：`drawer-collapsed` 依次从 `true → false → true`，`aria-expanded`
    同步跟着变 `"true"`；
  - 模拟触屏拖动（`PointerEvent` 序列，`pointerType:"touch"`，位移 60px 超过 8px 阈值）：手指上拉
    （`clientY` 变小）→ 展开；下拉 → 收起，方向判断符合预期。
- **对照截图（收起态，最直观的改善）**：

  | | master（改动前） | 本分支（改动后） |
  | --- | --- | --- |
  | 390×844 | 面板从底部往上盖到接近机翼，压住大半个云海 | 只剩一条 40px 的把手，舷窗完整可见 |
  | 844×390 | 面板铺满屏幕中央，**整个舷窗被盖住** | 只剩底部一条把手，舷窗完整可见 |

  截图：`tmp/screenshot/ux4/mobile-collapsed-compare-390.png`、
  `tmp/screenshot/ux4/mobile-collapsed-compare-844x390.png`（左右并排图，均已忽略未进仓库，路径供复现用）。

## 复现

```bash
# 起本分支的开发服务器（本任务用的端口）
pnpm --filter voyage exec vite --port 5292 --strictPort --host 127.0.0.1

# 三个视口 × 收起 / 展开两个场景（scenes.json 需要自己按下面「场景 js 写法」重建，已忽略未进仓库）
node apps/voyage/scripts/dev-browser.mjs shots --port 5292 --angle d3d11 --viewport 390x844 \
  --out apps/voyage/tmp/screenshot/ux4/390x844 --scenes-file apps/voyage/tmp/screenshot/ux4/scenes.json
node apps/voyage/scripts/dev-browser.mjs shots --port 5292 --angle d3d11 --viewport 844x390 \
  --out apps/voyage/tmp/screenshot/ux4/844x390 --scenes-file apps/voyage/tmp/screenshot/ux4/scenes.json
node apps/voyage/scripts/dev-browser.mjs shots --port 5292 --angle d3d11 --viewport 1600x1200 \
  --out apps/voyage/tmp/screenshot/ux4/1600x1200 --scenes-file apps/voyage/tmp/screenshot/ux4/scenes.json

# 场景 js（收起态测量）：
#   const p=document.getElementById('panel'); p.classList.remove('hidden'); p.scrollTop=0;
#   await new Promise(r=>requestAnimationFrame(r));
#   const r=p.getBoundingClientRect(); const vw=innerWidth, vh=innerHeight;
#   const cx=vw/2, cy=vh/2, rad=0.3*Math.min(vw,vh);
#   const overlap=!(r.right<cx-rad||r.left>cx+rad||r.bottom<cy-rad||r.top>cy+rad);
#   return JSON.stringify({collapsed:p.classList.contains('drawer-collapsed'),
#     rect:{w:r.width,h:r.height,top:r.top}, areaPct:(r.width*r.height)/(vw*vh)*100, centerCircleOverlap:overlap});
# 场景 js（展开态测量）：同上，先 window.__voyageUi.setDrawerOpen(true) 再等两帧

# master 对照（临时 worktree，跑完删除，端口按 DEV_SOP 惯例用 5292+90=5382）
git worktree add --detach tmp/ux4-base master
cd tmp/ux4-base && pnpm install
pnpm --filter voyage exec vite --port 5382 --strictPort --host 127.0.0.1
# 用同一份 scenes.json（绝对路径）对 5382 跑一遍 shots，再用 compare.mjs --diff / --out --crop 比对
```

## 已知简化（不阻塞验收，供后续打磨参考）

1. **收起 / 展开没有过渡动效**：`max-height:none` 到 `70vh` 之间无法用 CSS transition 平滑插值，见上面
   CSS 一节的解释。简报验收标准没有要求动效；要做的话需要先实测把手在各字号 / 系统字体下的真实渲染高度，
   把收起态的 `max-height` 换成一个有安全余量的具体数字（而不是 `none`），才能让 transition 生效。
2. **抽屉展开时不会把 canvas 视口一起上移**：`PANEL_UX_GUIDE.md` §9 原文就把这一条标成「方向，落地另议」，
   本任务没有实现（展开态本身覆盖屏幕下方 70%，这是预期行为，用户主动展开时能接受暂时遮挡）。
3. **触屏拖动的视觉反馈是「松手后瞬间切到目标态」，不是跟手实时拖拽**：没有做「手指移动多少、把手跟着移动
   多少」的实时跟手效果（那需要在拖动过程中把 `max-height` 或 `transform` 绑到指针位置，松手再决定吸附到
   哪一端）。当前实现松手前没有任何视觉反馈，只有松手瞬间的最终状态切换。功能上（能展开 / 能收起）没有
   问题，观感上不如原生 App 的跟手抽屉精致，如果美术总监后续挑出这一条，是一个可以单独立项的小任务。

## 开发体验反馈

- **哪里慢**：想清楚「怎么让桌面逐位不变」花的时间最多——一开始想直接在 `#panel` 内部插入把手元素、
  用 CSS `:has()` 或者给桌面单独写一套「跳过把手」的规则，后来发现最干净的做法是把原来挂在 `#panel` 上的
  `flex/gap` 布局原样搬到新增的 `.panel-body` 上，`.panel-handle` 默认 `display:none`——`display:none`
  的元素完全不参与 flex 布局与 `gap`，桌面下 `#panel` 只有一个可见子项，等价于拆分前，不用写任何
  「桌面例外」的 CSS。想清楚这一点之后，实现本身很快。
- **哪里卡**：`compare.mjs` 的路径解析是相对**仓库根**（`opus-test`）而不是 `apps/voyage`，我在
  `apps/voyage` 目录下直接传 `tmp/screenshot/...`（没加 `apps/voyage/` 前缀）会报「找不到图片」，
  `dev-browser.mjs` 的 `--out` / `--scenes-file` 同理。README「调试与验证」里其实写了这一条
  （"`--out` 同样相对仓库根解析"），是我自己没细看，浪费了两次命令；建议这类工具在报错信息里顺手提示一句
  「路径相对仓库根 `<repo-root>` 解析，当前 cwd 是 `<cwd>`，是不是少了 `apps/voyage/` 前缀」，能省掉这类
  低级失误的排查时间。
- **怎么绕过去的 / 想要什么**：验证「抽屉展开时机位没有大幅漂移导致对照截图不可比」这件事，靠的是
  `window.__voyageUi.setDrawerOpen(v)` 这种非 `isTrusted` 的调试句柄，而不是去真的模拟一次触屏拖动手势——
  写完之后又额外补了一版用 `PointerEvent` 序列模拟真实拖动的测试场景（`scenes-click.json`），因为怕
  「只测了逃生门（调试句柄），没测真实交互路径」会被审查抓到。如果以后新增面板交互控件时，`panel-kit.ts`
  框架（`PANEL_UX_GUIDE.md` §10，还没落地）能顺带提供一个「模拟真实指针拖动」的小工具函数
  （给定起点/终点/位移，自动派发一串 `pointerdown/move/up`），会比每个任务各写一份稍微省事一点——
  但这个工具本身工作量不大，不值得为了这一次专门抽出来，留给以后真的需要多次复用时再抽。
