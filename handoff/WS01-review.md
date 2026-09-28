# WS01 天梯巨构化 · 独立审查报告

审查对象：分支 `worktree-agent-afe60cd08b749d510`（`git -C D:\Code\opus-test diff master...worktree-agent-afe60cd08b749d510`）。
复核环境：临时 worktree `tmp/ws01rev`（detach 当前 master `ae9c339` + `git merge --no-commit` 该分支，无冲突），dev server 5277，审查完已清理（worktree、进程、端口均已释放，未动 5181）。
范围：按用户原则「看得见的优先、细微打磨晚做」，**只看回归安全与正确性，不评审美细节**。

## 结论：通过

四条核查项全部通过，未发现回归。以下逐条给证据。

## 1. 归属外改动的安全性（`clouds/clouds.ts` depthOn）

```diff
- const depthOn = (v.uGroundOn?.value ?? 0) > 0.5 && (...)
+ const depthOn =
+   ((v.uGroundOn?.value ?? 0) > 0.5 && (...)) ||
+   (v.uWonderOn?.value ?? 0) > 0.5;
```

这是一个纯布尔 OR：新增的 `uWonderOn > 0.5` 分支只在有天幕层奇观（天梯/建木）在场时为真。非奇观场景 `uWonderOn` 恒为 0，表达式代数上退化为改动前原样，**不是近似、是恒等**。

- **静态证据**：`outside-pass.ts` 里新增的云前后排序代码整段包在 `#ifdef OUTSIDE_WONDER` 内；`check:glsl` 的 PERF-13 断言（窗外默认程序不含天幕层奇观代码）通过，且把标识符检查从 `wonderSpheroid` 更新成了新的 `wonderFrustum`，说明检查确实在跑、不是形同虚设。
- **实测证据**（同页 `--base-shader` 材质替换，noon-cumulus / storm-day 两个场景，master=5181）：
  - `clouds.marchMat`（云步进程序）换成 master 原文 vs 不换：noon-cumulus **逐位 0**；storm-day mean=0 / max=0.67 / 0.299% 像素超阈值 0，**与噪声底同量级**（同一份原文换两次的自噪声 max=4 / 0.549%）。即云程序文本、渲染结果两侧一致。
  - `depthOn` 只影响 `next.scissorTest`（决定 resolve 是否顺带写云缓冲右半「平均深度」）与 `uCloudDepthOn` 这个 uniform，不参与任何着色器分支编译（不是 `#define`），JS 端改动不可能造成着色器文本差异。
- **有奇观时**：对 `ws-tether-sea`（天梯 + 60% 层积云）做 `flicker --cloud-live`（32 帧，冻结除云外一切）：块能量 CV 中位 **0.0000**、p98 **0.0003**；爬行指标 **0.0027**；云时间波动 relStd **0.0011**、relLow16 **0.0002**——全部处于健康区间，未见拖影 / 闪烁。`grep` 确认 `uCloudDepthOn` / `cloudBufferDepth` / `uResetDepth` 只出现在 `clouds.glsl.ts`、`clouds.ts`、`outside-pass.ts` 三个文件里，**SPEC-RAYS（rays.ts）与 FOCUS-ZOOM（focus-zoom.ts/head-limits.ts）都不读云深度**，代码层面没有交叉耦合；唯一间接路径是 FOCUS-ZOOM 改 `uTanHalfFov` 时 resolve 的重投影逻辑本来就对整条双宽缓冲生效（不区分左右半），深度半只是多了个「顺带被投影」，逻辑上和一直存在的颜色半用的是同一套代码，不是新风险点。`?zoom=4` 截图（ws-tether-sea）画面正常、控制台 0 error，未见异常伪影。
  - 说明：这一步是抽样 smoke test，不是针对 C11/C12b 指标的定量复核；如果协调者对聚焦过渡期间的云缓冲深度半有更高把握要求，建议合并后另跑一次 `FOCUS-ZOOM-cloud.mjs` 量化。

## 2. 非奇观场景逐位 0

用同页 `--base-shader 5181 --material outsideMat`（把 `outside-default` 换成 master 原文再换回来）在 noon-cumulus、storm-day 两个场景上测：

| 场景 | a vs b（换 master 原文） | a vs a2（噪声底，换回原文） |
| --- | --- | --- |
| noon-cumulus | mean=0 / max=0 / 0% | mean=0 / max=0 / 0% |
| storm-day | mean=0.04 / max=2.33 / 7.06% | mean=0.04 / max=4 / 7.16% |

noon-cumulus 逐位 0；storm-day 的差值和噪声底几乎同量级（材质换文再换回本身就有的重编译抖动），可判定为等价。`outside-default` 178596 字符原文两侧一致，`check:glsl` 也独立确认了这一点。

（备注：最初尝试用两个独立 `shots --freeze --settle` 进程分别拍 master / merged 再逐位比较，noon-cumulus 上出现了 78% 像素超阈值——这是预期内的假阳性，DEV_SOP「冻结工具对云是瞎的」已经记过：两次独立开页的云历史缓冲、海面泊松闪点都是各自会话的时序结果，freeze 只冻结当次会话已经积累的状态，不能跨会话比较；换成同页 `--base-shader` 材质替换后噪声完全消失，方法correct后结论也随之反转为「逐位一致」。这个坑之前 README 没写过，建议记一条。）

## 3. 冷编译 +14–22% 不在关键路径

- **代码证据**：`outside-pass.ts` 第 271、410 行注释明确写着「OW」（罕见光学 + 天幕层奇观合并变体）「首帧后 `PREWARM_AFTER_FRAMES` 帧开始后台预编」，走 `KHR_parallel_shader_compile` 非阻塞编译；这条调度架构是 PERF-13 就有的，WS01 只是往 OW 变体的着色器体内加代码，没有碰调度时机。
- **实测证据**：`dev-browser cold --port 5277 --repeat 1`（负载下测的，仅看结构不看绝对值）—— 启动批次「窗外材质的程序数: 1」，批次清单 `{"云#0":937,"云#1":937,"云#2":937,"座椅":2053,"舱内":7258,"机翼":7720,"窗外":15060}` 里「窗外」只有一项，就是默认程序；OW 变体没有出现在冷启动阻塞批次里，符合「首帧后后台预编」的说法。

## 4. typecheck / build / check:glsl / 控制台 / merge-tree

- `pnpm --filter voyage typecheck`：通过。
- `pnpm --filter voyage build`：通过，`dist/assets` 无 0 字节文件。
- `pnpm check:glsl`：全部通过（49 个程序语法校验、PERF-10/13/14 断言、sampler 数、场景表同步、README 速查表一致性）。
- 控制台：`check` 与多次 `shots` 期间均 **0 console error / pageerror**；GPU 渲染器确认为 `ANGLE (NVIDIA, RTX 5090 ... D3D11)`，硬件渲染，非 WARP 软渲染。
- **merge-tree 冲突**（`git merge-tree <merge-base> WS01 <对方分支>`，git 2.47）：
  - 与 **WS02**（`worktree-agent-a244e5bef012ec606`）：干净合并，无冲突标记。唯一共同改动文件是 `wonders/catalog.ts`——WS01 改 `tether` 条目（distanceKm/look），WS02 改 `fogcity` 条目（distanceKm/volume），两处在数组里相隔较远，3-way 合并自动拼接成功。
  - 与 **SEA-3**（`worktree-agent-a08046917b3852aff`）：干净合并，无冲突标记。共同改动文件是 `outside-pass.ts`——SEA-3 改的是 `onGround` 地面反射那段（约第 133–167 行，「低空海天暗墙」修法），WS01 改的是云合成处新增的 `#ifdef OUTSIDE_WONDER` 三行（约第 198–207 行），两处行区间不重叠，diff3 自动合并。SEA-3 交付文档里也写明「没碰 `#ifdef OUTSIDE_WONDER` 那几行（WS01 在改）」，双方已经互相避让。

## 次要观察（不阻塞，供参考）

读 `wonder-sky.glsl.ts` 全量 diff 时注意到两点结构性变化，记录以防以后排查：

1. 建木（skin 1）分支的早退检查顺序变了：原来先判 `dist > reach` 早退，再判 `visF <= 0` 早退；现在反过来。两个早退条件互相独立（不依赖对方产出的中间变量），顺序对最终结果无影响，纯粹是为了塔身/环站几何要先算完 `H`、`ringLamp` 等变量才能算出 `reach`。
2. 塔身/环站的几何探测循环（退台 `wonderFrustum`、环站 `wonderEllipseNearest` 等）现在跑在 `reach` 截断之前，理论上比旧版（先 `reach` 截断再进入重计算）多算一些边界像素；代码注释里写明这是刻意为之并已经测过（「试过在这里提前返回…GPU 上量不出来，却让 OW 变体的离线 FXC 多约 10%，撤了」），且 handoff 的 `gpu-ab` 结果（正午 ×1.005、夜仰看 ×1.020，均在离散度内）与本次 `flicker --cloud-live` 结果都支持「没有可感知的代价」。不算问题，只是提醒以后如果 OW 变体的整体帧时间在安静窗口复测时出现异常，这里是第一个该看的地方。

## 复现

```bash
cd D:\Code\opus-test
git worktree add --detach tmp/ws01rev master
git -C tmp/ws01rev merge --no-commit --no-ff worktree-agent-afe60cd08b749d510
cd tmp/ws01rev/apps/voyage && pnpm install
pnpm --filter voyage typecheck && pnpm --filter voyage build && pnpm check:glsl
pnpm exec vite --port 5277 --strictPort &
node scripts/dev-browser.mjs check --port 5277
node scripts/dev-browser.mjs shots --port 5277 --only noon-cumulus,storm-day --freeze --settle --pair "" --base-shader 5181 --material outsideMat --out tmp/screenshot/WS01-review/pair-outside
node scripts/dev-browser.mjs shots --port 5277 --only noon-cumulus,storm-day --freeze --settle --pair "" --base-shader 5181 --material clouds.marchMat --out tmp/screenshot/WS01-review/pair-cloud
node scripts/dev-browser.mjs flicker --port 5277 --only ws-tether-sea --cloud-live
node scripts/dev-browser.mjs cold --port 5277 --repeat 1
```
（用完 `git worktree remove --force tmp/ws01rev` 失败是正常的，Windows 文件占用；改用 PowerShell `Remove-Item -Recurse -Force` 删目录 + `git worktree prune`。）
