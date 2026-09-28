# STROBE-CLOUD · 夜里在云中自动关频闪

STROBE-FLASH 修完后仍留了一条建议（`handoff/STROBE-FLASH-review.md` §2.3 / §3）：云中夜里频闪仍是整窗明显一亮
（单次散射物理量级本身如此，压不动），真实航班按 SOP 在云中常关防撞频闪（避免反光晃眼），可以做「夜间云中自动关频闪」。
本任务把这条建议实现为 main.ts 里的一小段迟滞状态机，不改着色器。

## 状态

- [x] 判据：复用现成信号（`sun.altitude` 判夜、`EXPOSURE_WHITEOUT` 判云），不新增探测逻辑
- [x] 迟滞：进云 ≥2.5 s 关、出云 ≥4 s 恢复，贴云边穿行不闪烁
- [x] 面板 / 信息栏：不对用户静默，`#info` 追加一行状态文字
- [x] 验收（typecheck / build / check:glsl / live 测量，见下）

## 归属

- `apps/voyage/src/main.ts`：
  - `import { EXPOSURE_WHITEOUT, Exposure } from "./render/exposure";`（新增 `EXPOSURE_WHITEOUT`）。
  - 新增状态 `const strobeCloud = { off: false, offDwell: 0, onDwell: 0 };`（挨着已有的 `wingDebug`）。
  - 翼尖频闪那几行（原来只有 `uStrobe.value = wingDebug.strobe ?? (ph<0.05||...)？1:0`）前面插入迟滞判定，
    `uStrobe.value` 的最终表达式在 `strobeCloud.off` 为 `false`（白天、云外、迟滞还没触发）时与改前逐字等价。
  - `updateInfo(...)` 调用多传一个参数 `strobeCloud.off`。
  - `__voyage` 调试句柄里加了 `strobeCloud`（暴露状态，测量脚本 / 以后调试用；不是新增可写的调试开关——
    真要强制常开对照测试，用已有的 `wingDebug.strobe` 整段覆盖 `uStrobe`，它的优先级在 `strobeCloud.off` 之前）。
- `apps/voyage/src/ui.ts`：`updateInfo` 签名加 `strobeCloudOff = false`，为真时在 `#info` 末尾追加一行
  `频闪：夜间云中自动关闭（按惯例避免反光晃眼，出云后恢复）`。没有改面板控件（本来就没有频闪相关的控件，
  `research/PANEL_UX_GUIDE.md` 的「接管标『自动』」规矩针对的是控件，这里按其精神在信息栏给状态文字）。
- 没有碰着色器：`uStrobe` 仍是 `wing.glsl.ts` 里原来那个 uniform，`wing-shading.glsl.ts` 里频闪的配光 / 软上限 /
  雾散射（STROBE-FLASH 的产物）一概不动——STROBE-CLOUD 只决定「这一帧 `uStrobe` 该不该按原节奏取值」，
  不改「取到值以后怎么画」。航行灯 / 尾灯用另一套配光分支（`i != 1`），不读 `uStrobe`，不受影响。

## 判据与迟滞：怎么定的、为什么

1. **夜**：`sun.altitude < -6`。取 FAA 14 CFR 1.1 对「夜」的定义（晚间民用暮光结束到早晨民用暮光开始之间，
   太阳中心低于地平线 6°）——这是有据可查的航空规章定义，不是随手挑的数。
   **注意和 `wing-shading.glsl.ts` 里灯芯软上限用的 `night = smoothstep(-0.21,-0.05,uSunDir.y)`（约 −12°→−3°）是两回事**：
   那条是显示取舍（灯芯怎样都是纯白，只是亮度上限跟着太阳高度渐变，不代表真的入夜），这条是「真的按规章算不算夜」，
   刻意不复用、也不该合并——以后谁touch这两处，先想清楚是要改「显示上限」还是「行为判据」。
2. **云**：`EXPOSURE_WHITEOUT.value > 0.5`。这是 `clouds.ts` 的 `keyVisibility()` 每帧写的「飞机在云里的程度」
   （C02 起给曝光的雪景补偿用，按密度探针 `smoothstep(cameraDensity, 0.01, 0.08)` 算瞬时值、再按 0.5 s 时间常数
   指数平滑），STROBE-FLASH-review 建议复用的正是这个信号，没有新增探测逻辑。
3. **迟滞**：连续满足「夜 && 云」≥2.5 s 才关，连续不满足 ≥4 s 才恢复（`strobeCloud.offDwell` / `onDwell` 两个
   累加器，条件一旦翻转另一边清零，见 `main.ts` 里的注释）。数字是任务简报给的「进云 2–3 s / 出云 3–5 s」区间内
   取的中点偏保守（关得稍慢、开得稍慢），实测的端到端延迟（含 `EXPOSURE_WHITEOUT` 自身 0.5 s 平滑爬升 / 衰减过
   0.5 阈值的时间）落在约 2.85 s / 4.35 s，仍在验收区间附近（见下「验收」）。
   这层迟滞是在 `EXPOSURE_WHITEOUT` 的 0.5 s 平滑**之上**再叠一层，不是同一件事：0.5 s 平滑是曝光模块本来就要的
   （眼睛亮适应量级），本身还不够慢，贴着云边飞时 `EXPOSURE_WHITEOUT` 自己也会在阈值附近跳，所以频闪开关必须
   自己再有一道更慢、且进出不对称的迟滞，见下面 B3/B4 的实测。

## 验收（`handoff/STROBE-CLOUD-live.mjs`，d3d11，RTX 5090，1600×1200 视口用于 A/B 场景截图口径不变，本任务用 800×600 纯逐帧读 uniform、不读像素）

坑：这台机器的 rAF 节奏实测约 130 fps，比想当然的 60 fps 快一倍多；脚本按「墙钟毫秒数」计时（不是帧数），
否则按帧数臆测的时长会被砍到实际时长的不到一半，量出假的「没恢复」。

```
node handoff/STROBE-CLOUD-live.mjs --port <端口> --out tmp/screenshot/STROBE-CLOUD/live
```

| 测试 | 场景 | 结果 |
| --- | --- | --- |
| A1 进云会关、关了不再闪 | night-incloud（夜、低空厚层积云，飞机确定在云里，同 STROBE-FLASH 的场景定义） | 太阳高度角 −63.4°；录制开始前（场景加载 + 1 s 热身期间）已经关闭；关闭后 10 s 内 0 帧还在闪；console error 0 |
| A2 白天云中频闪照常，不被网关关 | in-cloud（同样低空厚云，14:00） | 太阳高度角 +42.0°；`strobeCloud.off` 全程 false；5 s 内 9 个频闪段；逐帧与 main.ts 的 `ph` 公式核对，0 帧不符——白天逐帧行为与改前一致 |
| A3 夜里云外频闪照常，不被网关关 | night-city（夜，coverage 0.15，飞机多半不在云里） | 太阳高度角 −49.4°；`strobeCloud.off` 全程 false；whiteout 峰值 0；5 s 内 8 个频闪段 |
| B1 进云 → 关闭的实际延迟 | night-incloud，打补丁直接摆 `clouds.cameraDensity`（停掉异步 GPU 探针，main.ts 的状态机、`clouds.keyVisibility()` 照常按真实 dt 跑） | 2.84 s（关闭时 whiteout=0.997，已经很接近饱和——因为「关闭」本身要等 offDwell 攒够 2.5 s，这段时间里 whiteout 早就爬过了 0.5 的阈值继续往上冲） |
| B2 出云 → 恢复的实际延迟 | 同上，紧接着摆回 0 | 4.33 s（与预期的「whiteout 衰减穿过 0.5 的时间（约 0.35 s）+ 4 s 迟滞 ≈ 4.35 s」几乎吻合） |
| B3 贴云边快速穿行（0.5 s 半周期，共 10 s，远小于两条迟滞窗口） | 同上 | `strobeCloud.off` 翻转 **0 次**；whiteout 本身在 0.014–0.736 之间来回摆（网关信号自己在跳），但迟滞状态机把它吸收掉了，没有传导成开关频闪 |
| B4 贴云边慢速穿行（3 s / 3 s，量级接近迟滞窗口，共 18 s） | 同上 | 翻转 1 次：第 2 个周期起关闭，此后一直保持关闭（采样轨迹见下）。**这是设计内行为，不是 bug**：出云每次只维持 3 s，短于 4 s 的恢复迟滞，所以短暂钻出云缝不会把频闪重新点亮——真按这个节奏来回穿云边的飞机，防撞灯保持关闭反而更符合「不要一路闪烁」的初衷 |

原始逐帧数据：`tmp/screenshot/STROBE-CLOUD/live/{A1,A2,A3,B3,B4}_*.json`、`summary.json`（gitignore，未提交，复现命令见上）。

**面板 / 信息栏**（Playwright 手动核对，`?dev=1&voyage=0`，night-incloud 同款场景）：`#info` 在 `strobeCloud.off`
为真时追加一行

```
频闪：夜间云中自动关闭（按惯例避免反光晃眼，出云后恢复）
```

白天 / 云外场景不出现这一行（`updateInfo` 的 `strobeCloudOff` 参数为 false 时该行是空字符串，其余行逐位不变）。

**typecheck / build / check:glsl**：全部通过（`pnpm --filter voyage typecheck`、`pnpm --filter voyage build`、
`pnpm --filter voyage check:glsl`），`dist/` 无异常警告（只有预置的 chunk 体积警告，与本任务无关）。

**console**：A1–A3、B 四段测试全程 `page.on("pageerror"/"console" error)` 计数均为 0；Playwright 手动核对时
控制台同样 0 error（有若干与本任务无关的既有 warning，未新增）。

## 复现

```
pnpm --filter voyage typecheck
pnpm --filter voyage build
pnpm --filter voyage check:glsl
node handoff/STROBE-CLOUD-live.mjs --port <端口> --out tmp/screenshot/STROBE-CLOUD/live
```

## 没做 / 交给以后

- 迟滞的两个数字（2.5 s / 4 s）取的是任务给的区间内偏保守的点，没有做用户可调（不需要，这是行为判据，不是显示旋钮）。
- 没有给这条行为加面板开关（例如「强制常开」的用户可见控件）——现状可以用 `__voyage.wingDebug.strobe = 1` 强制点亮
  做对照测试（不受 `strobeCloud.off` 影响，优先级在它之前），但这是开发者调试句柄，不是面向用户的控件。
  如果以后有用户诉求「我就是想在云里也看到频闪」，按 `research/PANEL_UX_GUIDE.md` 的规矩再加一个真正的控件、
  接管时机板标「自动」。
- 没有统一航行灯 / 尾灯的云雾表现——它们不读 `uStrobe`，本来就不受这次改动影响，云里的常亮灯本身是否也需要类似
  的「云中调整」不在本任务范围（STROBE-FLASH 交接文档里提过「航行灯 / 尾灯的雾散射仍是各向同性相函数」，是另一件事）。
