# TR02 · 火车模式与列车运动 · 独立审查

审查代理（只读，没开浏览器）。分支 `worktree-agent-a1212f32ed58c0345`（5f4c2f4，合并基 9984cb1），`git diff master...分支`：13 个文件，+1651 / −8。触发必审 (b)：main.ts 10 处、ui.ts、index.html。

## 结论：返工（小）

飞机模式零回归、坐标换算、超高 / 侧倾的公式与符号、数据真实性都没问题，代码质量好。**只有一个必须修的功能 bug**：终点停站时切回飞机再切回火车，列车会冲出终点、停在线路末端再也不动（见 B1）。修法很小（约十行），修完加一条单测即可合并，不需要重新整体审查。

## 跑过的离线检查

| 检查 | 结果 |
| --- | --- |
| `node src/rail/rail.test.mjs`（分支 worktree） | ✓ 43 项通过；输出与交接一致（24.0 分钟、最高 90 km/h、未平衡横加速度最大 0.67 m/s²、振动均方根 2.03 mm / 0.098° / 0.028° / 0.028°） |
| `node src/rail/shader-parity.mjs`，对照合并基 9984cb1 | ✓ 29 个程序逐字相同 |
| 同一脚本对照 master 698da47 | ✗ `outside-default` / `outside-ground-detail` 不同：只是 master 在 T38 审查后改了 `outside-pass.ts` 里一行 GLSL 注释，分支还没合进来。**这也说明比对脚本是灵敏的**（不是恒等于通过） |
| `git merge-tree master 分支` | 无冲突 |
| `pnpm typecheck`（分支） | ✓ |
| 自写探针（scratchpad，不入库）：越过终点 teleport、终点处 teleport、60× 连续航程（每帧 6 模拟秒）过终点、每帧耗时 | 见 B1；60× 下能正常到站、停车、折返；60× 一帧 `train.update` 约 0.18 ms，`pose()` 约 9 µs |

## 必须修

### B1. 在终点停站时切回飞机、再切回火车 → 列车冲出终点、永远停在线路末端

- 复现（node）：`t.teleport(t.terminalS[1], 1)` 后按 1/60 s 推进 300 s：s 停在 `sMax = 35071.6`（终点停车位 34994.9 之后 77 m），速度 0，不停站、不折返，永远不动。`teleport(sMax − 2, 1)`、`teleport(sMin + 2, −1)` 同样卡死。
- 面板上的路径：列车在信濃大町停站的 40 s 里（此时 `dir` 仍是 +1，停站结束才翻转），用户切回飞机、再切回火车 → `RailMode.enter()` 调 `teleport(this.train.s, dir = 1)`。
- 根因两处：
  1. `Train.teleport` 的初速 `min(cruise, curveLimit())` 没有把「到下一个停车点的制动曲线」算进去，停在终点上也给 25 m/s；到站判定要求 `before > 0`，而这时 `before = 0`，于是越过停车点，此后 `nextStop` 在身后，目标速度一直是 0。
  2. `enter()` 不传参数时 `dir` 默认 +1，**丢掉了列车当前的行驶方向**：往松本方向跑的列车切回来后变成往信濃大町，座位也按 +1 设成左座。
- 建议修法：`teleport` 的初速再与 `sqrt(2·BRAKE·max(dStop, 0))` 取小；位置夹到 `[terminalS[0], terminalS[1]]` 而不是 `[sMin, sMax]`；已经在行驶方向的终点上时直接进入停站（或翻转方向）。`enter()` 不传参数时沿用 `this.train.dir`，传 `startS` 才用默认方向。单测加一条「终点处 / 越过终点 teleport 后 60 s 内开始停站并折返」。
- 同一根因的次要表现：在进站制动段（终点前约 300 m 内）切回火车，初速恢复成 25 m/s，到停车点时一帧内从约 80 km/h 直接落到 0。

## 建议（不阻塞合并，可以随 B1 一起改或留给 TR08）

1. **火车模式下打开「连续航程」会改写地点**：`director.setActive(true)` → `joinNetwork()` 按松本当前位置建一个航段、把 `state.preset` 换成「当前位置 → 某机场」。`rail.exit()` 会恢复预设，但 `director.leg` 仍是日本出发的那一段。建议火车模式下禁用 `#voyage-on`（或让导演在 `rail.active` 时不接入航线网）；只借它的流速（`simDt`）是交接里说的本意。
2. `exit()` 里 `state.floor = snap.floor` 紧接着被 `resetAltitudeFloor(state)` 覆盖，是一行死代码。要么删掉，要么注释说明「故意按新地点重估」。
3. 加载中切回飞机无效：`loading` 时下拉框被 `sync()` 拉回「火车」，加载完照样进入火车。可以接受，但最好在 `enter()` 的 `await` 之后检查一个「用户已取消」标志。
4. `ensureLoaded` 的成功回调里如果 `new Corridor(data)` 抛错，`loading` 会一直是 true、面板一直显示「加载线路数据…」。把构造放进 try，或者在 reject 路径里统一复位。
5. `groundLiftM` 「立刻抬」：clipmap 级别切换时眼睛会一帧跳高 1 m 以上（弯道截图里抬了 1.3 m）；慢慢放下的系数 0.02 是按帧不是按 dt。TR03 接好 DEM 后应当基本不用抬，届时顺手改成按 dt。
6. `BOGIE_SPACING_M = 13.8` 引的是 E231 系；本区间实际跑的是 E127 系 / 211 系 / E353 系。20 m 车的台车中心距多在 13.8 m 附近，数值可以沿用，但注释里应写明「借 E231 系的值，估」。
7. 交接里「切回飞机后与 master noon-cumulus 平均差 4.75/255，在噪声范围内」这个证据**不成立**：两张图的 info 显示太阳高度 76.6° 与 57.7°、月相 61% 与 100%，日期不同（火车场景的 2026-08-05 在切回飞机后没有复原）。master 图右下窗框上的阳光亮斑在分支图里没有，就是这个原因，不是回归。零回归应以着色器逐字比对 + 下面的逐处核对为准；若要画面对照，请在同一日期、冻结下重拍。

## 逐项核对

### 1. 飞机模式零回归

main.ts 10 处在 `rail.active === false` 时逐一核对：

| 接入点 | 飞机模式下 |
| --- | --- |
| import | 只 import，`rail/mode.ts` 顶层没有副作用（常量 + 类） |
| `setPreset` 第一行 `if (rail.active) rail.exit()` | 跳过；`setPreset` 首次调用（第 340 行）在 `const rail` 之后，没有暂时性死区问题 |
| `new RailMode(...)` | 构造只存 host，不拉数据、不注册监听、不开定时器 |
| `setupUi({... vehicle: rail})` | `setupVehicleUi` 注册一个 `#vehicle` 的 change 监听，初始 `sync()` 把地点 / 高度 / 机翼位置 / 襟翼 / `[data-alt]` 设为 `disabled = false`。全仓库没有别的代码改这些控件的 disabled，不会冲掉别人的状态 |
| `updateAltitudeFloor` | 原表达式，位置不变 |
| `stepFlight` / `director.update` | 原表达式、原顺序 |
| `uHead` | `head.y + bump`，与原来相同 |
| `uWingRootLE` | `state.wingRootLE`，与原来相同 |
| `updateInfo(..., director.describe())` | 与原来相同 |
| 调试句柄 | 只在末尾加 `rail`，原有键一个不少 |

state 默认值、benchFrame、freeze（冻结时 `simDt = 0`，`train.update` 直接返回）、quality、wonders、traffic 都没有被改动。每帧多出的只是几次 `rail.active` 布尔判断。index.html 只在「地点」前面加了一个 label，没有按位置写的选择器（style.css 里只有 `#panel label` 这类通用规则）。

### 2. 坐标与物理

- **经纬度路径**：`mode.applyPose` 的位置和「前方 20 m」的航向参考点都是 线路 ENU → `EnuFrame.inv`（真实经纬度）→ `ground.localFrame.toLocal`，没有任何地方把 ENU 米直接除以 1000 当本地公里。`EnuFrame` 与 `scripts/rail/common.py` 的 `ENU` 逐项同式（WGS84 → ECEF → 切平面东 / 北分量）。航向 `atan2(Δx, −Δz)`，本地 z 朝南，符号正确。clipmap 原点换到 `meta.format.crs`，与 ENU 切点一致。
- **超高**：C = G·V²/(127R)，G = 1067，夹到 G²/(6H)；V = 90、H = 1300、轨头中心距 1130、变化率 1.67 mm/m、死区都标了「估」。「105 mm」没有用（注释里写明了）。侧倾角 = asin(C / 1130)。
- **符号**逐条推了一遍：往大町左转 → 外轨是右轨 → 右侧高 → roll < 0（roll + = 右侧下沉）✓；反方向行驶时 cant、曲率都乘 dir，世界里是同一个轨道倾斜 ✓（单测也核了 up 向量）；悬挂外倾在欠超高时朝外、过超高时朝内（单测：60 km/h 低于平衡速度 85 km/h → −0.60°，向内）✓。
- **限速与制动**：曲线限速 v²|k| − g|C|/1130 ≤ 0.65 m/s²，按车长 ±10 m 取最小，再按 0.7 m/s² 反推提前制动，逻辑正确；实测最大 0.67 m/s²。加速 0.6、制动 0.7（执行时允许 1.05）的量级合理，都标了估。
- **振动**：激励是里程 s 的函数（带哈希梯度的多波长噪声），经二阶悬挂滤波；幅度 ∝ 车速，停车时衰减到 0；确定性。`MAX_SUBSTEP = 1/60`，60× 时每帧 360 个子步，没触到 600 步的封顶。
- **降级**：拉取失败、HTTP 非 2xx、格式错 / 越界 / 不等间距都会 reject → 状态文字显示原因、下拉回到「飞机」、下次切换重试；飞机模式不受影响（除建议 4 那一种情形）。

### 3. 数据真实性

没有把未核实的数当事实用：105 mm 没用，定尺钢轨 / 接缝本任务没碰，95 km/h 注明是二手出处且没超过。下拉选项、预设名、信息栏都标了「示例」，超高在信息栏标「（估）」。台车距的出处见建议 6。

### 4. 切换健壮性

- 反复切换：监听只在 `setupVehicleUi` 注册一次；`enter` / `exit` 不注册监听、不开定时器；数据只拉一次（`loadPromise` 缓存，失败才清空）。不泄漏。
- 恢复：`exit()` 恢复预设、clipmap 原点、`uCloudOffset`、高度 / 目标高度、航向、俯仰、坡度、滚转、爬升率、座位，再 `snapAll` / `syncTimeUi`。机翼没有改 `state.wingRootLE`，只在 uniform 那一处换值，切回自然归位。高度滑块在火车模式下从没被同步过，切回后与恢复的状态一致。模拟时间不复原（设计如此，见建议 7）。
- 问题：B1、建议 1、3。

### 5. 单测覆盖

测的是真东西，不只是自洽：超高与独立重算的规范公式比对；平均曲率与切向角变化率（两条不同路径）比对；俯仰与 DEM 坡度比对；车站里程与营业キロ（外部数据）比对；全程速度曲线、终点停车与折返、偏航角速度连续性（有针对 OSM 折角的回归阈值）；振动幅度、平滑、停车静止、确定性；ENU 往返与 LocalFrame 比例。
缺口：`mode.ts`（航向换算、`exit` 恢复、重复进入）没有测；终点 / 越界 teleport 没有测（正是 B1 的漏点）；LocalFrame 是照抄公式（注释已提醒要同步）；ENU 只测了自身往返，没有拿一个已知经纬度的点（例如信濃大町站的 OSM 坐标）做外部锚定。

### 6. 截图（只看文件）· 美术总监视角

- `tr02-train-default.png`：北阿尔卑斯轮廓和积云有模有样；近处一片均匀的暗绿平涂，山脚与平原之间一条发白的横带，边缘有锯齿；窗框仍是飞机舷窗。**远景问题归 TR03、车厢归 TR06，不作为本任务返工理由。**
- `tr02-train-curve.png`：近处整片画成海面，岸线是明显的阶梯锯齿（水体掩膜在贴地相机下被放大），违反「宁可小，不要糊 / 锯齿是最高优先级缺陷」。归 TR03，但建议 TR03 把它列为第一优先。
- `plane-vs-master.png`：机翼、云、天空都正常恢复；两边的差异来自日期不同（见建议 7），不是回归。

## 开发体验反馈

- **哪里慢**：`shader-parity.mjs` 对照目录要有 `node_modules`。新建的 `git worktree` 里没有，得手工做目录联接（junction）到主仓库的 `node_modules`；清理时必须先 `cmd /c rmdir` 解联接，否则 `Remove-Item -Recurse` 可能顺着联接删掉主仓库的依赖。每次比对 vite 起两个 SSR 服务器，约半分钟，可以接受。
- **哪里卡**：master 在分支合并后又改了一行 GLSL 注释，按简报「对照 master」会报 2 个程序不同，要自己判断是不是分支的问题。建议脚本在有差异时顺手打印第一处不同的行（上下文几行），一眼就能看出是注释。
- **希望有**：① `shader-parity.mjs` 支持直接传一个 git 提交号（内部用 `git show <rev>:path` 读文件或者自动建临时 worktree 并联接依赖），省掉建 / 删 worktree 这一套；② 交接里的「画面对照」要求写明日期 / 时间一致、冻结，否则证据不可用（本次就踩到）。
