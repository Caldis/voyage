# UX-1a · 面板小修一批 · 交接

分支 `worktree-agent-a043de4d4e48b123f`，端口 5260。规范 `research/PANEL_UX_GUIDE.md`，审计 `research/PANEL_UX_AUDIT_1.md`（P3 全部 + P8 的对比度、焦点环、aria）。
改动只在归属文件：`src/ui.ts`、`index.html`、`src/style.css`；另改 `README.md`（「使用」的操作说明 + 坑点一条）。**控件 id 与选项 value 一个没改**（前后截图 JSON 的 `ids` / `opts` 逐字相同，只多了新元素 `vehicle-hint`）。

## 逐条对照（截图都在 `tmp/screenshot/ux1a/`，`before/` 是改前、`after/` 是改后，文件名相同）

| 审计条目 | 改法 | 证据（场景 `js` 返回 / 截图） |
| --- | --- | --- |
| P3-1 自动曝光开着时「手动曝光」一行仍显示 | `style.css` 全局 `[hidden] { display: none !important; }`，删掉 T49 的 `.row[hidden]` 特例 | `ux1a-default-bottom`：改前 `manualHidden:true, display:flex, 高 67px`，改后 `display:none, 高 0`；截图里「手动曝光 EV 14.0」一行消失 |
| P3-2 复选框浏览器默认红色 | `#panel input[type="checkbox"] { accent-color: var(--accent) }` | `checkboxAccent`：`auto` → `rgb(217,183,122)`；`ux1a-default-bottom.png` 复选框为金色 |
| P3-3 过时提示「移动鼠标 = 挪动头部」 | 删掉底部那行；「视角」标签里的括号说明挪成标签下一行 hint「在画面上按住拖动转头，滚轮前后挪，双击复位」（全面板只剩这一处）；README「使用」同步改 | `oldHint`：`true` → `false`；`ux1a-default-mid.png` 视角下方的 hint |
| P3-4 快捷键守卫不一致 | `ui.ts` 新增 `isTypingTarget()`（文字类 input 含日期框、select、textarea、contentEditable）+ `isLetterShortcut()`（再加「不带 Ctrl / Alt / Meta」），H / B / M / N 统一走它；方向键走 `ownsArrowKeys()`（任何 input / select / textarea / 可编辑区）并新增「带 Ctrl / Alt / Meta 不拦」（原来 `Alt + ←` 浏览器后退会被 `preventDefault` 吃掉） | `ux1a-keys`（合成事件）改前 `hInDate` 隐藏了、`ctrlH` 隐藏了，改后全部「对」；`handoff/UX-1a-kbd.mjs`（真实键盘）：日期框里按 H 不隐藏、点完复选框按 H 照常隐藏、Ctrl+H 不隐藏 |
| P3-5 火车模式禁用控件没有原因 | `setupVehicleUi`：9 个飞机专用控件、它们外面的 `<label>`、飞行阶段 / 航向模式按钮的 `title` 换成「火车模式下不可用（飞机专用）；把「交通工具」切回「飞机」即可使用」，切回飞机还原原来的 title；「交通工具」下方新增 `#vehicle-hint` 一行说明；调试「立即触发到达」在火车模式下也给这个原因。顺手：连续航程开着时「时间流速」整行变灰，也给了 title「连续航程开着时，时间按下面的「航程流速」走；取消勾选「连续航程」后可用」（P1 的一小部分，§5.3 规则四） | `ux1a-train`：改前各控件 title 为空，改后全部带原因、`vehicleHint` 显示；`ux1a-plane-after-train`：切回飞机后 title 还原、说明隐藏；`ux1a-expanded-top` 的 `timeRateTitle`；截图 `after/ux1a-train.png` |
| P3-6 下拉选完不还焦点 | `setupUi` 末尾给 `#panel select` 统一挂：**用鼠标 / 触摸选的**（`pointerdown` 之后的 `change`）才 `blur()`；键盘在下拉里用方向键挑选项时不抢焦点（Chrome 下方向键在收起的下拉上每按一下就触发一次 `change`，无条件 blur 会让键盘用户没法连续挑） | `ux1a-keys`：`selectBlurAfterPointer` 改前「仍聚焦」→ 改后「已还焦点」；`selectKeepFocusKeyboard` 两边都「保持焦点」 |
| P8 次要文字对比度 | 面板底色新变量 `--panel-bg-strong`（0.82 不透明度，只给 `#panel`；背景板提示 / 火车字幕仍用原 0.72 的 `--panel-bg`，画面上的叠层不变）；`--muted` `#9a978f` → `#b8b4ab`；数据来源去掉 `opacity: 0.7`，链接用正文色 | `ux1a-white-bg`（场景里在面板下面垫一块纯白，模拟压在正午白云上）：用 `handoff/UX-1a-contrast.py` 量底色——改前白底 `rgb(84,84,85)`，次要文字 **2.59:1**、正文 6.06:1；改后白底 `rgb(61,61,62)`，次要文字 **5.25:1**、正文 8.70:1。舱壁背景：改前 3.28:1 → 改后 6.08:1 |
| P8 焦点环 | `:is(#panel, #backdrop-hint) :is(button, input, select, a):focus-visible { outline: 2px solid var(--accent); outline-offset: 2px }` | `after/ux1a-focus-ring.png`（真实键盘聚焦日期框：金色 2px 描边）；`UX-1a-kbd.mjs` 输出 `focusVisible:true, outline: solid 2px rgb(217,183,122)` |
| P8 aria | 分段按钮（时间流速、航程流速、航向模式）用 `setPressed()` 同时管 `.on` 与 `aria-pressed`；四个按钮行加 `role="group"` + `aria-label`；`#panel` 加 `aria-label="控制面板"`；禁用的下拉 / 输入框变淡（`opacity .45`、`cursor: not-allowed`） | `ux1a-expanded-top` 的 `pressed`：改前全 `null`，改后 `0=true 1=false … 1=true … route=true …`；`ux1a-keys` 的 `panelAria` |

「飞行阶段」四个按钮是一次性动作（设目标高度），不是开关，没加 `aria-pressed`。

## 其他验收

- **回归场景照常设值 / 画面不变**：`handoff/UX-1a-scenes-state.json` 7 个场景（default、noon-cumulus、storm-sc、dusk 左座、clouds-variety、night-city-off、经济舱 + 灯光睡眠档），改前改后各拍一次，比对 `applyScene` 之后的 `state`（座位、舱等、舱灯、机翼、襟翼、遮光板、风、高度、云型、地面、流速、预设、`simTime`）、云 uniform（云量 / 云底 / 云顶）、曝光 uniform（自动 / 补偿 / 手动 EV）、导演 / 奇观 / 画质档，以及截图 JSON 的 `panel`（16 个控件值）：**全部一致**，`applyScene` 没有「页面没有控件」警告。画面只读这些状态，本任务的 JS 改动只动 title / aria / 焦点 / 键盘守卫，不写任何渲染状态；面板在截图里是 `hidden` 类（opacity 0），CSS 改动碰不到画布。
  - 跨运行的像素差只作参考（云随 uTime 演化，README 坑点）：noon-cumulus 平均差 3.85 / 255、economy 0.8，和 VOY-DEFAULT 交接里 master 自己两次运行的差同一量级。**没有做同页逐位对照**：改动不在渲染路径上，同页 A/B 没有可切换的变体。
- 面板尺寸（1600×1200）：内容高 2719 → 2622 px（去掉底部提示、视角括号挪成 hint、手动曝光一行真的隐藏；新增的火车说明只在火车模式显示）；面积占比 18.3% 不变。390×844：2534 → 2436 px，面积 41.3% 不变（手机抽屉是 UX-4 的事）。
- typecheck、build（`dist/assets` 0 字节文件 0 个）、`check:glsl` 全部通过；`dev-browser check --query "&voyage=1"`（默认开连续航程）与各次 `shots` 都没有 console error / pageerror；渲染器 `ANGLE (NVIDIA GeForce RTX 5090 … D3D11)`，硬件渲染。

## 与规范的一处偏离（请交互设计师定夺，写进规范或推翻）

§8.1 说 `isTypingTarget` 对所有 `input` 返回真。我改成只对「会吃字母的」input（文字、日期、数字等）返回真，复选框 / 滑条 / 单选 / 按钮类 input 不算：否则点完「声音」复选框再按 `M`、拖完滑条再按 `H` 都不灵，而这些控件本来就不接收字母。方向键仍然对所有 input 让路（滑条要用方向键调值）。

## 没做 / 留给后续

- 标签里的括号说明（「连续航程（自动接续…）」「声音（…按 M 开关）」「调试小地图（…）」等）、术语改名、键帽 `<kbd>`：UX-3。
- 面板显示跟系统实际值（P1 / P9）：UX-2。截图 `after/ux1a-train.png` 里「时间流速」变灰、「连续航程」仍勾着，是前一个场景 `applyScene` 直接调 `director.setActive(false)`、面板没同步（P9），不是本任务引入的。
- 滑条 `aria-valuetext`、`prefers-reduced-motion`：规范 §8.2 有，简报没列，没做（改动小，UX-3 / UX-7 框架里一并做更省事）。
- 原生 `title` 提示框截不到图，只能用场景 `js` 读属性核对。

## 复现

```
pnpm --filter voyage exec vite --port 5260 --strictPort --host 127.0.0.1
node apps/voyage/scripts/dev-browser.mjs shots --port 5260 --angle d3d11 --respect-lock --out tmp/screenshot/ux1a/after --scenes-file apps/voyage/handoff/UX-1a-scenes-panel.json
node apps/voyage/scripts/dev-browser.mjs shots --port 5260 --angle d3d11 --respect-lock --viewport 390x844 --out tmp/screenshot/ux1a/after/390x844 --scenes-file apps/voyage/handoff/UX-1a-scenes-small.json
node apps/voyage/scripts/dev-browser.mjs shots --port 5260 --angle d3d11 --respect-lock --out tmp/screenshot/ux1a/after-state --scenes-file apps/voyage/handoff/UX-1a-scenes-state.json
node apps/voyage/handoff/UX-1a-kbd.mjs 5260          # 真实键盘：快捷键守卫与焦点环（脚本里的路径写死了本 worktree，换地方跑要改开头三行）
python apps/voyage/handoff/UX-1a-contrast.py <白底截图> <默认截图>
```

`ux1a-white-bg` 场景会往页面里插一块白色 div，放在场景文件最后，别把它挪到别的场景前面。
