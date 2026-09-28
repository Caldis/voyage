# UX-3 · 面板分区折叠 + 调试控件进开发者区 · 交接（WIP）

分支 `worktree-agent-ad8ed612d2a656888`，worktree `D:\Code\opus-test\.claude\worktrees\agent-ad8ed612d2a656888`，端口 5284。
规范 `research/PANEL_UX_GUIDE.md`（§2 分区、§4.2 滑条、§7 记忆）、审计 `research/PANEL_UX_AUDIT_1.md` 的 UX-3 条目。

## 当前状态：实现已完成，验收测量中（未卡住）

代码改动（`index.html` / `src/ui.ts` / `src/style.css`，三个归属文件）已经做完并跑过 typecheck / build / check:glsl，
全部通过。正在做的是「全部回归场景 `panel` 字段逐项对比 master」——已各自在本分支（5284）与 master 对照
worktree（`tmp/ux3-base`，端口 5364）跑完 40 个场景的 `shots`（截图 + `panel` JSON），两边都 0 console error；
接下来要写对比脚本逐场景比较 `panel` 字段（预期不会有差异：本任务没有改任何控件 id / value / 事件绑定逻辑，
只挪了 DOM 位置、改了标签文字、加了两个 CSS 布局规则）。

## 1600×1200 下面板高度（原始 2622 px → 现在）

默认状态（观景 + 航程展开，天气 / 声音 / 画质 / 页脚折叠，开发者区隐藏）：**内容高 1102 px**，
面板可视区（`max-height: calc(100% - 32px)`）在 1200 px 视口下是 1168 px —— **不需要滚动**，留了约 66 px 余量。
测量脚本：`p.scrollHeight` / `p.clientHeight`，用 `dev-browser.mjs shots` 的 `js` 字段读（见下面「复现」）。

达到这个高度经过几轮迭代，关键改动都在 `src/style.css`：
1. `<details>` 分区后，天气 / 声音 / 画质 / 页脚默认折叠，直接去掉了约 1200 px（这部分是分区折叠本身的效果）。
2. **标签布局从「文字 / 数值 / 滑条各占一行」改成「同一行，放不下再换行」**（`#panel label { flex-wrap: wrap }`，
   下拉 `flex: 1 1 0%`、滑条不再强制 `flex-basis: 100%`）——原来每个控件普遍占 2–3 行，现在多数选择器控件单行、
   滑条基本也单行（`label + 数值 + 滑条` 挤在一行，放不下才换行）。**这一条不在原简报字面要求里**，是为了达成
   「不需要滚动」这条硬指标而加的：只压缩了几十个已存在控件的布局密度，没有改任何控件类型（select 还是
   select、range 还是 range），也没有碰 id / value。
3. 下拉 `flex-basis` 用 `0%` 不用 `auto`：`auto` 会按下拉框「最长选项文字」的天然宽度参与换行判断，长选项
   （如地点名）会把整行挤到换行；改成 `0%` 后换行判断只看 `min-width`（64 px），下拉再长的文字也会在框内
   自然裁切，不会撑破布局。
4. 间距从 `10px` 压到 `6px`（`#panel` 顶层 gap、`.section-body` gap、summary 行 padding），外加两处文案精简
   （见下）。
5. `wing-pos`、`cabin-class` 的选项括号说明挪进 `<option title="…">`（按规范 §3.1「材质描述放 title」），
   减少了下拉本身的宽度，帮它们在一行放下。
6. `nav-status` 默认文案去掉了重复的「方向键 ← / → 转向」尾巴（左右转按钮的 `title` 里已经有，去重）。

## 控件迁移表

| 原位置 / 控件 | 新位置 | 改动 |
| --- | --- | --- |
| 座位、视角（+ hint）、座位相对机翼、遮光板、舱等、舱内灯光、窗上倒影、背景板模式、奇观模式、稀有度、奇观状态 | **观景**（默认展开） | 纯搬家；`wing-pos`/`cabin-class` 选项括号→`title`；「背景板模式」按钮加 `<kbd>B</kbd>` |
| 起点/航线（原「地点」）、日期/现在、当地时刻、时间流速、连续航程、航程流速、航向模式、转向+选定航向、直飞机场、飞行阶段、襟翼/减速板、高度 | **航程**（默认展开） | 纯搬家；「地点」→「起点 / 航线」（术语表）；`nav-dest` 占位「（选择机场）」→「选择机场…」；`nav-status` 默认文案去重复 |
| 天气系统（原「天气」）、云型（原「云」）、云量、云底高度、云层厚度、海面风速 | **天气**（默认折叠，summary 摘要「{自动 ·} 云型 云量%」） | 纯搬家 + 术语改名（UX-2 交接里明确留给 UX-3 的两处改名） |
| 声音开关、音量、空调、提示音、钢轨接缝 | **声音**（默认折叠，标题行本身带开关） | `sound-on` 挪进 `<summary>`；`click` 加 `stopPropagation`（否则点开关会连带把区折叠/展开，见 `setupSoundUi`）；summary 摘要「开 · NN%」/「关」 |
| 画质、地面精度、真实地理数据、人眼式自动曝光、曝光补偿 | **画质**（默认折叠，summary 摘要「自动 → 高」/「高（固定）」，复用 `#quality-status` 文字去掉括号里的 GPU ms） | 纯搬家 |
| 手动曝光（`manual-row`）、调试小地图、立即到达、召唤 + 立即召唤 + 让它退场、完整信息栏（`#info`） | **开发者区**（`#dev-section`，已有，本任务只搬家） | 标签去「（调试）」；`debug-arrive` 按钮文案「立即触发到达 / 接下一段（调试）」→「立即到达」；`minimap-on` 「调试小地图（…）」→「小地图 `<kbd>N</kbd>`」+ title |
| 信息栏（`<pre id="info">`） | 拆两份：完整版留在 `#info`（开发者区，id 不变，`dev-browser.mjs` 的 `info` 字段读它） + 新的「此刻」摘要 `#now-line1`/`#now-line2`（常驻，不折叠） | `updateInfo()` 内部拆分，导出签名不变（main.ts 调用点不用改） |
| 数据来源与许可（`.credits`） | **页脚**（默认折叠为一行） | 纯搬家 |

**控件 id / 选项 value 一个没改**，唯一的 id 改动是修复一个附带发现的 bug（见下），不影响任何场景表用到的 id。

## 顺手发现并修复的 bug（不在简报范围内，但值得报告）

**`#focus-vignette` id 冲突**：FOCUS-ZOOM 任务给「聚焦暗角」叠层 div 用了 `id="focus-vignette"`
（`<div id="focus-vignette">`，`focus-zoom.ts` 用它控制暗角不透明度），**同时**给开发者区那条「聚焦暗角」滑条
也用了同一个 id（`<input id="focus-vignette" type="range">`）。两个后果：
1. `style.css` 的 `#focus-vignette { position: fixed; inset: 0; ... }`（给叠层 div 用的）连带套到了这条滑条上；
   `#panel` 有 `backdrop-filter`，会给后代的 `position:fixed` 元素建立新的包含块，于是这条滑条被拉伸铺满了
   `#panel` 自己的整个内容区，原生滑块画在了面板纵向正中间——展开开发者区时会看到一条诡异的横杠叠在别的行上
   （复现：`?dev=1` 打开页面，横杠出现在「当地时刻」行附近，与开发者区完全无关）。
2. **更严重**：`ui.ts` 里 `$("focus-vignette")`（`document.getElementById` 总是取文档序里第一个匹配）拿到的
   其实是那个叠层 div，不是滑条本身——`setupFocusUi` 给它挂的 `input` 事件监听、双击复位，全部挂在了一个
   div 上，从来没生效过。**这条滑条从 FOCUS-ZOOM 上线起，拖动就没真正改过 `focus.vignette`**（`focus.vignette`
   只能靠 URL 参数或别处的脚本改）。
   
修法：滑条的 id 改成 `focus-vig`（`focus-vignette-out` 同步改成 `focus-vig-out`），叠层 div 的 id 不动
（`focus-zoom.ts` 不在我的归属文件里，没碰它）。`index.html` 和 `src/ui.ts` 里各改了一处，已重新截图验证：
展开开发者区后滑条画在正确位置（`聚焦暗角 40% [====滑条====]`），不再有横杠叠加。

## 验收进度

| 项 | 状态 |
| --- | --- |
| typecheck | 通过 |
| build（`dist/assets` 0 字节文件） | 通过，0 个 |
| check:glsl | 通过 |
| 1600×1200 默认面板不滚动 | 通过，1102 / 1168 px |
| 全部 40 个场景 `shots`（本分支 + master 对照）控制台 0 error | 通过 |
| 全部场景 `panel` 字段逐项比对 master | **进行中**，两边截图已跑完，还没写比对脚本 |
| 390×844 不更差 | 未测 |
| UX-2 自动标记 / 锁定、UX-1a 守卫 / aria、FOCUS-ZOOM 开发者区、REFLECT-OFF 滑条 | 视觉上看着正常（截图里天气区自动标记、声音区开关、开发者区聚焦三条滑条都在），未逐项过一遍验收脚本 |
| README 坑点 | 未写 |
| 提交 | 本次 WIP 提交后，交付前还要再提交一次带完整 handoff 的版本 |

## 复现

```bash
# 本分支
pnpm --filter voyage exec vite --port 5284 --strictPort --host 127.0.0.1
node apps/voyage/scripts/dev-browser.mjs shots --port 5284 --angle d3d11 --respect-lock --out tmp/ux3-regress/new

# master 对照（worktree 在 tmp/ux3-base，未删，port 5364，交付前会清理）
node apps/voyage/scripts/dev-browser.mjs shots --port 5364 --angle d3d11 --respect-lock --out tmp/ux3-regress/base

# 面板高度测量（js 字段读 scrollHeight/clientHeight）
node apps/voyage/scripts/dev-browser.mjs shots --port 5284 --angle d3d11 --viewport 1600x1200 \
  --out tmp/screenshot/ux3/measure \
  --scenes-file <场景 JSON，job.js: "p.classList.remove('hidden');...return JSON.stringify({scrollHeight:p.scrollHeight,clientHeight:p.clientHeight})">
```

## 下一步

1. 写 / 跑面板字段比对脚本（`tmp/ux3-regress/new` vs `base` 的 40 个 JSON，比较 `.panel` 对象）。
2. 390×844 截图，确认不比现状差（抽屉是 UX-4 的事，这里只要求不更差）。
3. 抽查 UX-2 / UX-1a / FOCUS-ZOOM / REFLECT-OFF 相关行为（自动标记轮询、快捷键守卫、聚焦滑条、倒影滑条）。
4. 删除 `tmp/ux3-base` 对照 worktree、关掉两个开发服务器（5284、5364）。
5. 补 README「坑点」一条（`focus-vignette` id 冲突）。
6. 交付前再提交一次（完整改动 + 这份 handoff 的定稿版）。
