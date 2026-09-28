# UX-3 · 面板分区折叠 + 调试控件进开发者区 · 交接

分支 `worktree-agent-ad8ed612d2a656888`，端口 5284。
规范 `research/PANEL_UX_GUIDE.md`（§2 分区、§4.2 滑条、§7 记忆）、审计 `research/PANEL_UX_AUDIT_1.md` 的 UX-3 条目。
状态：**完成，待审查**。归属文件（`index.html` / `src/ui.ts` / `src/style.css`）改动已做完，typecheck / build / check:glsl
全部通过，40 个回归场景 `panel` 字段与 master 逐项比对零差异，UX-2 / UX-1a / FOCUS-ZOOM / REFLECT-OFF 行为自测全部通过。

**开发期间 master 前进了一波**（STROBE-CLOUD / SPEC-BOW / SEA-3 / W-EDGE 合并），已 `git merge master` 拉平
（合并提交 `da5fe24`）。唯一的真实冲突在 `ui.ts` 的 `updateInfo`：STROBE-CLOUD 给它加了 `strobeCloudOff` 参数，
追加一行「频闪：夜间云中自动关闭…」到 `#info`（当时 `#info` 还是普通区可见的）。手工解决时**没有简单二选一**，
而是保留了 STROBE-CLOUD「不对用户静默」的原意：新增 `#now-line3`（常驻摘要的第三行，accent 色、不适用时
`hidden`），`strobeCloudOff` 为真时把这行状态放在这里，继续对普通用户可见；`#info` 里的完整版本也保留
（现在在开发者区）。合并后重新跑过 typecheck / build / check:glsl / 全部回归场景（新增 3 个 bow-* 场景，共 43 个）
/ 面板字段合并前后对比（0 差异），确认合并没有引入问题。

## 前后对比

截图：`tmp/screenshot/ux3/before/ux3-before-top.png`（master，`scrollHeight` 2681 px，面板从标题栏一路平铺到「高度」还没完）
vs `tmp/screenshot/ux3/measure11/ux3-default-1600.png`（本分支默认状态，`scrollHeight` 1102 px，从标题栏到「数据来源与许可」一屏放完，六个分区清晰可辨）。
（`tmp/` 已忽略，不进仓库；两张图都在 1600×1200、`d3d11`、`voyage=0` 下拍的。）

## 1600×1200 下面板高度：2681 px → 1102 px（可视区 1168 px，不需要滚动）

测量：`p.scrollHeight` / `p.clientHeight`（`#panel { max-height: calc(100% - 32px) }`，1200 px 视口下是 1168 px）。
默认状态：观景 + 航程展开，天气 / 声音 / 画质 / 页脚折叠，开发者区隐藏。

达到这个高度经过几轮迭代，改动都在 `src/style.css` / `index.html`：
1. `<details>` 分区后，天气 / 声音 / 画质 / 页脚默认折叠，去掉了约 1200 px（分区折叠本身的效果）。
2. **标签布局从「文字 / 数值 / 滑条各占一行」改成「同一行，放不下再换行」**（`#panel label { flex-wrap: wrap }`，
   下拉 `flex: 1 1 0%`、滑条不再强制 `flex-basis: 100%`）——原来每个控件普遍占 2–3 行，现在多数下拉单行、
   滑条也基本单行（标签 + 数值 + 滑条挤在一行，放不下才换行）。**这一条不在简报字面要求里**，是为了达成
   「不需要滚动」这条硬指标补的：只压缩了几十个已有控件的布局密度，没有改控件类型（select 还是 select、
   range 还是 range），也没有碰 id / value。
3. 下拉 `flex-basis` 用 `0%` 不用 `auto`：`auto` 会按下拉框「最长选项文字」的天然宽度参与换行判断，长选项
   （地点名、天气名）会把整行挤到换行；改成 `0%` 后换行判断只看 `min-width`（64 px），选项文字再长也只在
   框内被原生裁切，不撑破布局。
4. 间距从 `10px` 压到 `6px`（`#panel` 顶层 gap、`.section-body` gap、summary 行 padding）。
5. `wing-pos`、`cabin-class` 的选项括号说明挪进 `<option title="…">`（按规范 §3.1「材质描述放 title」），
   减少了下拉本身的宽度，帮它们在一行放下。
6. `nav-status` 默认文案去掉了重复的「方向键 ← / → 转向」尾巴（左右转按钮的 `title` 里已经有，去重）。

390×844 下不更差：面板 `rectW/rectH` 与 master 逐位相同（`max-height:45%` 那条媒体查询限死了高度，改动前后
都是 358×380，面积占比仍是审计记录的 41.3%；抽屉留给 UX-4）。

## 控件迁移表

| 原位置 / 控件 | 新位置 | 改动 |
| --- | --- | --- |
| 座位、视角（+ hint）、座位相对机翼、遮光板、舱等、舱内灯光、窗上倒影、背景板模式、奇观模式、稀有度、奇观状态 | **观景**（默认展开） | 纯搬家；`wing-pos` / `cabin-class` 选项括号→`title`；「背景板模式」按钮加 `<kbd>B</kbd>` |
| 起点 / 航线（原「地点」）、日期 / 现在、当地时刻、时间流速、连续航程、航程流速、航向模式、转向 + 选定航向、直飞机场、飞行阶段、襟翼 / 减速板、高度 | **航程**（默认展开） | 纯搬家；「地点」→「起点 / 航线」（术语表）；`nav-dest` 占位「（选择机场）」→「选择机场…」；`nav-status` 默认文案去重复 |
| 天气系统（原「天气」）、云型（原「云」）、云量、云底高度、云层厚度、海面风速 | **天气**（默认折叠，summary 摘要「{自动 ·} 云型 云量%」，见 `setupWeatherAutoSync` 里新加的几行） | 纯搬家 + 术语改名（UX-2 交接里明确留给 UX-3 的两处改名） |
| 声音开关、音量、空调、提示音、钢轨接缝 | **声音**（默认折叠，标题行本身带开关） | `sound-on` 挪进 `<summary>`；`click` 加 `stopPropagation`（否则点开关会连带把区折叠 / 展开）；summary 摘要「开 · NN%」/「关」 |
| 画质、地面精度、真实地理数据、人眼式自动曝光、曝光补偿 | **画质**（默认折叠，summary 摘要「自动 → 高」/「高（固定）」，复用 `#quality-status` 文字去掉括号里的 GPU ms） | 纯搬家 |
| 手动曝光（`manual-row`）、调试小地图、立即到达、召唤 + 立即召唤 + 让它退场、完整信息栏（`#info`） | **开发者区**（`#dev-section`，FOCUS-ZOOM 已建，本任务只搬家） | 标签去「（调试）」；`debug-arrive` 按钮文案「立即触发到达 / 接下一段（调试）」→「立即到达」；`minimap-on` 「调试小地图（…）」→「小地图 `<kbd>N</kbd>`」+ title |
| 信息栏（`<pre id="info">`） | 拆两份：完整版留在 `#info`（开发者区，id 不变，`dev-browser.mjs` 的截图 JSON `info` 字段读它） + 新的「此刻」摘要 `#now-line1` / `#now-line2` / `#now-line3`（常驻，不折叠） | `updateInfo()` 内部拆分，导出签名保持与合并后的 master 一致（`strobeCloudOff` 参数不变，main.ts 调用点不用改）；`#now-line3` 是合并 STROBE-CLOUD 时新加的，只在夜间云中自动关频闪时显示 |
| 数据来源与许可（`.credits`） | **页脚**（默认折叠为一行） | 纯搬家 |

**控件 id / 选项 value 一个没改**（唯一的 id 改动见下面「顺手修复的 bug」，不影响任何场景表用到的 id）。
新增的纯装饰 / 结构 id（`section-view` / `section-voyage` / `section-weather` / `section-sound` / `section-quality` /
`section-footer`、`now-line1` / `now-line2`、`weather-summary`、`sound-summary-text`、`quality-summary`）不在场景表
契约里，不影响回归。

## 顺手发现并修复的 bug（不在简报范围内，但值得报告）

**`#focus-vignette` id 冲突**：FOCUS-ZOOM 任务给「聚焦暗角」叠层 div 用了 `id="focus-vignette"`
（`<div id="focus-vignette">`，`focus-zoom.ts` 用它控制暗角不透明度），**同时**给开发者区那条「聚焦暗角」滑条
也用了同一个 id（`<input id="focus-vignette" type="range">`）。两个后果：

1. `style.css` 的 `#focus-vignette { position: fixed; inset: 0; ... }`（给叠层 div 用的）连带套到了这条滑条上；
   `#panel` 有 `backdrop-filter`，会给后代的 `position:fixed` 元素建立新的包含块，于是这条滑条被拉伸铺满了
   `#panel` 自己的整个内容区，原生滑块画在了面板纵向正中间——展开开发者区时会看到一条诡异的横杠叠在别的行上
   （复现：`?dev=1` 打开页面，横杠出现在「当地时刻」行附近，与开发者区完全无关；截图对比见
   `tmp/screenshot/ux3/devurl/crop.png`（改前）与 `tmp/screenshot/ux3/verify/crop.png`（改后））。
2. **更严重**：`ui.ts` 里 `$("focus-vignette")`（`document.getElementById` 总是取文档序里第一个匹配）拿到的
   其实是那个叠层 div，不是滑条本身——`setupFocusUi` 给它挂的 `input` 事件监听、双击复位，全部挂在了一个
   div 上，从来没生效过。**这条滑条从 FOCUS-ZOOM 上线起，拖动就没真正改过 `focus.vignette`**（`focus.vignette`
   只能靠 URL 参数或别处的脚本改）。

修法：滑条的 id 改成 `focus-vig`（`focus-vignette-out` 同步改成 `focus-vig-out`），叠层 div 的 id 不动
（`focus-zoom.ts` 不在我的归属文件里，没碰它）。已用 `tmp/ux3-misc-check.mjs` 验证：拖动滑条后
`window.__voyage.focus.vignette` 真的跟着变了（之前不会）。这条已经写进 README「工具与环境」坑点。

## 验收结果

| 项 | 结果 |
| --- | --- |
| typecheck / build（`dist/assets` 0 字节文件） / check:glsl | 全部通过 |
| 1600×1200 默认面板不滚动 | 通过，`scrollHeight` 1102 px，可视区 1168 px（余量 66 px） |
| 390×844 不更差 | 通过，`rectW/rectH` 与 master 相同（358×380） |
| 全部 40 个场景 `shots`（本分支 + master 对照）控制台 0 error | 通过 |
| 全部场景 `panel` 字段逐项对比 master 零差异 | 通过（`night-city-low-west` 的 `altitude` 首轮出现 2.9→2.7 的偶发差异，复测两次都是 2.9，确认是地形数据异步加载时序噪声，不是代码改动引入，见「已知噪声」） |
| UX-2 自动标记 / 锁定（连续航程接管、nudge 标记、换航段清空标记、天气 / 云型锁定、P9 脚本旁路回归） | 通过，`tmp/ux3-UX-2-check-patched.mjs` 全部 OK（原 `handoff/UX-2-check.mjs` 假设控件常驻可见，天气区默认折叠 / `debug-arrive` 挪进默认隐藏的开发者区后直接点击会超时，补丁版先展开对应区再交互，见下面「工具兼容性」） |
| UX-1a 快捷键守卫、焦点环 | 通过（`tmp/ux3-kbd-check.mjs`：日期框内 H 不隐藏、无焦点时 H 隐藏 / 恢复、select 聚焦有可见 outline、折叠分区不改变 state、Shift+D 开开发者区） |
| FOCUS-ZOOM 开发者区（倍率 / 过渡 / 暗角滑条、按住 Z 聚焦） | 通过（`tmp/ux3-misc-check.mjs`），顺带验证了上面那条 id 冲突修复 |
| REFLECT-OFF 窗上倒影滑条（拖动、双击复位） | 通过（`tmp/ux3-misc-check.mjs`） |
| 控制台零 error | 全程通过（40 场景回归 + 各自测脚本） |

### 已知噪声（非本任务引入）

`night-city-low-west` 场景的 `altitude` 面板值在一次全量回归里读到 2.7，master 是 2.9；同分支单独重跑两次
`night-city-low-west` 都稳定得到 2.9。根因：这个场景 `ground: true`，高度下限（`state.floor`）按地形数据异步
加载结果估算，在瓦片还没到齐时用保守估计（`FLOOR_LAND_AGL_KM` 兜底），到齐后可能小幅上调；两次页面加载的
网络时序不同，偶尔会在「瓦片到齐前」和「到齐后」之间抓到不同的帧。与本任务的分区 / 布局改动无关（没有改
`resetAltitudeFloor` / `state.floor` 相关代码），单是环境噪声。

### 工具兼容性（写给后面维护验收脚本的人）

`handoff/UX-2-check.mjs`（UX-2 遗留）假设「天气区常驻可见、`#debug-arrive` 常驻可见」，本任务把天气区改成
默认折叠、`debug-arrive` 挪进默认隐藏的开发者区后，脚本直接 `page.locator("#wind").focus()` 会静默 no-op
（`<details>` 关闭时内容不可聚焦，不报错但按键也无效）、`page.locator("#debug-arrive").click()` 会因为
「元素不可见」在 30 秒后抛 `TimeoutError` 让整个脚本崩掉。我在 `tmp/ux3-misc-check.mjs`（已删，仅本次验证用）
基础上写了一份补丁版 `tmp/ux3-UX-2-check-patched.mjs`（同样未提交，仅记录做法）：交互前先
`page.evaluate(() => { document.getElementById("section-weather").open = true; })` /
`document.getElementById("dev-section").hidden = false`。**如果协调者或后续任务要长期维护
`handoff/UX-2-check.mjs`，建议照这个思路更新一次**（不在我的归属文件里，没有直接改动它）。

## 复现

```bash
pnpm --filter voyage exec vite --port 5284 --strictPort --host 127.0.0.1

# 面板高度（1600×1200，默认状态）：job.js 用
#   const p=document.getElementById('panel'); p.classList.remove('hidden'); p.scrollTop=0;
#   return JSON.stringify({scrollHeight:p.scrollHeight, clientHeight:p.clientHeight});
node apps/voyage/scripts/dev-browser.mjs shots --port 5284 --angle d3d11 --viewport 1600x1200 \
  --out tmp/screenshot/ux3 --scenes-file <场景 JSON>

# 回归场景 + panel 字段对比 master（建 tmp/<task>-base 临时 worktree，装依赖、起服务器、shots，比较后删）
node apps/voyage/scripts/dev-browser.mjs shots --port 5284 --angle d3d11 --respect-lock --out tmp/ux3-regress/new
node apps/voyage/scripts/dev-browser.mjs shots --port <master 对照端口> --angle d3d11 --respect-lock --out tmp/ux3-regress/base
# 然后逐场景比较两边 JSON 的 .panel 字段（本任务写过一次性脚本，未留仓库，逻辑是逐 key 比较）
```

## 开发体验反馈

- **哪里慢**：定位「1600×1200 不许滚动」这条硬指标花的时间最多（约占总工时一半）——单靠分区折叠只把 2681 px
  压到约 1350 px，离 1168 px 的可视区还差一截，得再动标签本身的布局（column → flex-wrap 单行）才够；这部分
  规范里没写具体做法，是自己试出来的（中途走过一次弯路：先以为要做「更多」子折叠、纯参数微调，实测发现真正
  占大头的是每个控件本身占 2–3 行的列式布局，不是控件数量本身）。
- **哪里卡**：`--only` 只认 `scripts/scenarios.mjs` 里的内置场景名，传自定义 `--scenes-file` 时不能用 `--only`
  过滤到某一个自定义场景（想只跑一个自定义场景得把 `--scenes-file` 本身只写一条）——一开始不知道，浪费了几次
  命令；另外调试「开发者区展开后画面有条诡异横杠」那阵，一路怀疑到 GPU 合成层 bug（换了 d3d11 / vulkan 两个
  后端复现都一样），最后才发现是最朴素的 HTML id 冲突——如果面板有「重复 id 检查」这类静态检查（比如
  `check:glsl` 同类的脚本扫一遍 `index.html`），这个坑本可以在 FOCUS-ZOOM 那波就被拦住，不用等到 UX-3 展开
  开发者区才暴露。
- **怎么绕过去的**：用 `getBoundingClientRect()` + `document.querySelectorAll('#focus-vignette')` 直接列出所有
  同 id 元素的 `computedStyle`，比靠截图肉眼猜位置快得多；建议以后遇到「元素位置诡异但布局代码看起来没问题」
  时，第一步就查有没有 id 冲突（`document.querySelectorAll('#xxx').length > 1`）。
