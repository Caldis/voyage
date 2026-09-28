# FOCUS-ZOOM · 聚焦观察 + 头部左右限位 · 交接

分支 `worktree-agent-a08d7bac992cb21ef`，端口 5264（对照 master 5324：`tmp/fz-base`，交付前删）。
用户原话：「按住鼠标左键能有一个"聚焦观察"的效果，类似 FPS 游戏里面放大查看一样，而且在调试模式中我可以设置这个放大倍率便于调试」；
追加：「如果将镜头放大到最大，再向左右两侧查看，则会能看到空白的前后机舱导致露馅，这方面我希望能随着镜头前伸而限制一下左右旋转角度」。

## 改了什么（文件）

| 文件 | 改动 |
| --- | --- |
| `src/focus-zoom.ts`（新） | `FocusZoom`：按住来源（pointer / key / script）、过渡（smootherstep + 对数插值倍率）、设置与记忆（URL > localStorage `voyage.focus` > 默认，只记 isTrusted）、暗角叠层 |
| `src/head-limits.ts`（新） | 头部左右限位的几何判据、每帧求解（热启动二分）、拖动弹性阻尼 `HeadLimiter.drag` |
| `src/view-presets.ts` | `setupViewControls` 加可选依赖：按住不动（180 ms 内位移 ≤ 5 px）进入聚焦、按下即拖不聚焦、聚焦中拖动灵敏度 ÷ 倍率、拖动走弹性阻尼；`lostpointercapture` / 窗口失焦时松开 |
| `src/main.ts`（热点，最少改动） | ① import 两个模块；② 创建 `focus` / `headLimits` 并传给 `setupViewControls`；③ 头部平滑跟随处：y / z 先跟，写 `uTanHalfFov = 默认 / focus.update(dt)`，按这一帧的 y / z / 视场 / 宽高比 / 座位 / 舱等更新限位，x 跟随后硬夹进限位；④ `setupUi` 多传 `focus`；⑤ `__voyage` 多挂 `focus`、`headLimits` |
| `src/clouds/clouds.ts` | resolve 的历史按上一帧视场投影（`uPrevTanHalfFov`，CPU 在 `render` 末尾记下）；视场变化的帧把 `uSinceReset` 压到 ≤ `zoomSinceResetCap`（8）。**没动步进 / 云形状** |
| `index.html` / `src/style.css` / `src/ui.ts` | 开发者区 `#dev-section`（新 id，`?dev`、`?dev=1` 或 Shift + D，记在 `voyage.pref.panel`）：聚焦倍率 `#focus-mag`、聚焦过渡 `#focus-ms`、聚焦暗角 `#focus-vignette`、说明 `#focus-hint`；暗角叠层 `#focus-vignette`；按住 Z 聚焦。**没改任何现有控件** |
| `README.md` | 使用说明、调试句柄、模块表、坑点 4 条（云：视场变化的重投影；舱内：未建模区域与限位、窗洞黑带；工具：`?dev=<时间戳>`） |
| `handoff/FOCUS-ZOOM-*.mjs / .mts / .json` | 限位表、交互验收、云重投影测量、GPU 对照、截图场景 |

## 交互说明

- 画面上**按住不动**（180 ms 内位移 ≤ 5 px）→ 进入聚焦：视场收窄到「默认 / 倍率」，过渡 200 ms（smootherstep 缓入缓出，倍率在对数域插值）；松开同样 200 ms 还原。
- **按下就拖走**（180 ms 内超过 5 px）→ 原来的转头，这一按不再聚焦。聚焦后照样可以拖动转头，灵敏度 ÷ 当前倍数（画面上的移动速度和不放大时相当）。
- 触屏长按同理（pointer 事件，`touch-action: none` 原本就有）。键盘**按住 Z**（守卫与 H / B / M / N 相同：焦点在文字框 / 日期框 / 下拉里不触发；松开 Z 时不看焦点，免得卡在放大状态）。
- 暗角：CSS 径向渐变叠层，强度 × 过渡进度；默认 40%（四角最多压暗约 18%），不聚焦时 `hidden`，画布逐位不变。
- 双击画布复位视角（原行为），双击滑条 / 标签复位该项。

## 参数

| 项 | 范围 / 默认 | 来源优先级 | 记忆 |
| --- | --- | --- | --- |
| 聚焦倍率 | 1.5–8×，步长 0.1，默认 2.5× | `?zoom=`（允许 1 = 关掉）> `voyage.focus.mag` > 默认 | 只记真实操作 |
| 聚焦过渡 | 0–600 ms，步长 10，默认 200 ms | `?zoomms=` > `voyage.focus.ms` > 默认 | 同上 |
| 聚焦暗角 | 0–100%，步长 5%，默认 40% | `voyage.focus.vignette` > 默认 | 同上 |
| 按住判定 | 180 ms、5 px | 常量 `FOCUS_HOLD_MS` / `FOCUS_HOLD_PX`（view-presets.ts） | — |
| 开发者区显示 | 默认隐藏 | `?dev` / `?dev=1|true|on` > `voyage.pref.panel.dev` | Shift + D 真实按键才记 |

（结果与证据见下文各节，测量完成后补全）
