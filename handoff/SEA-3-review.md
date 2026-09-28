# SEA-3 独立审查报告

对象：分支 `worktree-agent-a08046917b3852aff`（8cc6132），审查环境 `git -C D:\Code\opus-test diff master...worktree-agent-a08046917b3852aff`，
复核临时工作区 `D:\Code\opus-test\tmp\sea3rev`（detach 当前 master 80e8bba + `merge --no-commit` 本分支，`pnpm install`），dev server 5274。

## 结论：返工

三项里①（暗墙）②（横纹）③（暗尾迹）在**白天 / 有真实地面路径**的场景下改得对，指标与实现者报告一致，已独立复现。
但①的**开阔海面分支**（`outside-pass.ts` 的 `OS_REFL_SURF`）在**夜间 / 无月**场景下有真实的正确性缺陷：远海从「有暗淡星光反射」变成**逐像素纯黑 `(0,0,0)`**，地平线正下方一行之内从 Y≈65 掉到 Y≈0（旧版本是 Y≈45–66 的平滑渐变），是一条比改前的「暗墙」更硬的断层。这正是实现者自己点名「本轮只测了白天场景」的那条审查重点，复测即复现，且是**正确性错误 + 可见回退 + 硬边**，按给定判据必须返工。

**返工范围很小**：只需重新推导 `outside-pass.ts` 里 `OS_REFL_SURF`（约 168–171 行）在 `tUpR → 0` 分支的"饱和源"取值，`onGround` 分支（①的主路径）、②（`terrain-shading.glsl.ts` 两行插值）、③（`traffic.glsl.ts` 尾迹）三处独立验证均通过，不必动。

---

## 一、逐项复核结果

### ① 暗墙（outside-pass.ts，`skyCam` / `refl` 按 `tUpR` 混合）

**onGround 分支（真实地面路径）——通过。**
- 代数复核：`skyCam' = apL + mix(apT·apL/(1−apT), max(skyCam−apL,0), tUpR)`，代入 `groundFinish` 里既有的 `fView·max(skyCam−apL,0)`，`tUpR→1` 时退化为改前公式（逐位一致，实现者已验证），`tUpR→0` 时等价于 `fView·apT·apL/(1−apT)`，与交接文档「反射视线这段霾的饱和内散射」描述一致，且 `apL`、`apT` 来自**同一张** 3D 空气透视 LUT、同一条相机→命中点积分路径，比值物理上自洽。
- 实测复现：hnd-low-day 地平线处逐行亮度剖面（x=950，仓库根 `tmp/sea3rev/tmp/screenshot/sea3rev/accept/hnd-low-day/{old,new}.png`）——
  - old：y=527→528→529 依次 145.32 → 149.10 → 158.38（**一行内跳 +9.3**，硬边）
  - new：同一段 145.32 → 145.32 → 144.60 → …→141.74，**单调平滑下降，无跳变**
  与实现者「8.4→3.2」的方向一致，硬边确实消失。
- fuji-day（6 km，山地，默认程序）、fuji-west-seam-low（1.2 km，山地，低空细节程序）、night-city（4 km，land+小水面）、route-hnd-cts / route-hnd-cts-night（真实地面路径，日/夜）：整图 old/new 差异 mean 0.06–0.8、over8 像素占比 < 0.06%，目视无差异、无新增断层（见下方「新增追加验证」）。

**开阔海面分支（!onGround，`OS_REFL_SURF`）——返工，见下「问题」。**

### ② 远海横纹（terrain-shading.glsl.ts，`groundHit` 两行插值）

**通过。** 独立重跑 `SEA-3-stripes.py`（未直接引用实现者数字，自己在复核环境重新截图、重新计算）：

| | 行残差 RMS | 主周期 / 自相关 |
|---|---:|---|
| old | 0.738 | 39 行 / 0.46 |
| new | 0.455 | 22 行 / 0.10（低于「无周期」阈值 0.12） |

与交接文档「0.769→0.452，周期消失」一致（我这边 old/new 截图是本次复核环境重新生成的，非实现者原图，数字独立复现）。

山地场景（fuji-day、fuji-west-seam-low）逐图比对未见新增横向断层/条带（见上）；LUT 本身未改，`check:glsl` 对空气透视相关程序全部 `[OK]`。

### ③ 暗尾迹（traffic.glsl.ts，补前景内散射）

**通过。** `accept` / `accept-trail` job 组在复核环境重新生成、重新跑（`SEA-3-mkjobs.py` 的 `old_patches()` 用 `git diff master` 反推，在本工作区独立复现，不是复制实现者的截图）：maskT（尾迹外区域）与 new 逐位一致，noon-cu-close / noon-cumulus / sunset 三个场景的 over8、mean 差与交接文档同量级；console error 全程 0。未见新的伪影。

---

## 二、问题（按严重度）

### P0（返工阻塞）—— 开阔海面分支夜间反射塌缩为纯黑，地平线出现硬边

**场景**：`night-sea-milkyway`（scs 预设，2026-05-15 22:30，无月，coverage 0.15，开阔海面、无 `ground:true`）。

**现象**（`D:\Code\opus-test\tmp\sea3rev\tmp\screenshot\sea3rev\extra\night-sea-milkyway\{old,new}.png`，及放大裁剪 `*-horizon.png`）：
- old：地平线以下有暗淡但清晰可见的海面纹理与星光反射，逐行剖面（x=800）Y 从 65→44 缓慢渐变。
- new：地平线正下方**一行之内**从 Y=65.66 掉到 **Y=0.00**（rgb 精确为 `(0,0,0)`，个别像素 `(1,0,1)` 级别的量化噪声），此后一路到窗框全部是纯黑，星光反射整体消失。

**根因定位**（诊断变体 `sea3rev-diag2-mkjobs.py`，把 `L = refl*200` / `L = inscatter*200` 单独可视化）：
- `outside-pass.ts` 的开阔海面分支：`refl = fView · mix(tView·inscatter/(1−tView), max(skyCam−inscatter,0), tUpR)`。
- 该场景反射视线接近水平掠射，`tUpR → 0`，落进第一分支 `tView·inscatter/(1−tView)`。
- `inscatter` = `L`，即 `skyRadiance(rd, hitGround=true)`——天空视图 LUT 的**地面侧**取值。诊断截图（`new-inscatter.png`）证实这个量在本场景**整片视野内 ≈ 0**（夜间、沿直接视线方向的地面侧 LUT 值本来就没有设计成携带星光等环境光）。
- 而 `tView` 是另一条独立公式 `transmittanceToTop(BOTTOM,·)/transmittanceToTop(uCamR,·)` 算出来的，**和 `inscatter` 不是同一次物理积分的产物**——不像 `onGround` 分支里 `apL`/`apT` 出自同一张 3D LUT、比值天然自洽。`inscatter≈0` 直接让 `tView·inscatter/(1−tView) ≈ 0`，`refl` 随之塌缩为 0，海面反射的「饱和源」不再是「视线这段霾本身该有的亮度」，而是错误地继承了 `inscatter` 的夜间失真。
- 对照：旧公式 `refl_old = fView·max(skyCam−inscatter,0)` 用的是 `skyCam`（天空视图 LUT 的**天空侧**，正确包含星光/银河亮度），`inscatter≈0` 时 `refl_old ≈ fView·skyCam`，这才是海面正确反射夜空的物理行为——也正是 old 截图里看到的暗淡星光反射带。

**为什么是正确性错误而不是取向问题**：这不是"要不要让远海更灰"的美术取舍，是 `tUpR→0` 分支里配对的 `tView`/`inscatter` 来自不同来源、比值不满足"饱和源函数"假设，导致该公式对**任何 `inscatter` 明显小于其应有量级的场景**都会给出错误的（塌缩为 0 的）结果——白天因为 `inscatter`（地面侧 LUT，含日照散射）本身量级足够大而被掩盖，夜间/低照度直接暴露。

**影响面**：任何夜间/月光很弱、**开阔海面**（没有真实地面路径覆盖，即远洋巡航，很常见的场景）都会中招；有云遮挡的场景（如 `dusk-earthshadow`）因为可见海面被云挡住大半，问题不明显但同一公式仍在起作用，未逐一验证是否同样塌缩（见「遗留」）。有真实地面路径的场景（`onGround`，包括沿海、near-shore 巡航）不受影响，因为它们走的是 ① 的 `onGround` 分支，用的是自洽的 `apL`/`apT`。

**修法方向（供实现者参考，不代替其判断）**：`tUpR→0` 分支不能用 `inscatter` 做饱和源。либо 复用 `skyCam` 自身的星光/夜空量级做一个类似 `onGround` 分支「同一物理路径产物」的替代量，либо干脆在开阔海面分支也去查一次空气透视 3D LUT（像 `onGround` 分支的 `gh.apL/apT` 一样，为开阔海面单独取 `apL_open/apT_open`），保证配对项来自同一次积分。两种做法都要回到「视线这段霾的饱和内散射该是多少」这个物理问题本身，而不是简单换一个非零的替代量掩盖夜间归零的现象。

### 遗留（不阻塞，记录供后续观察）

- `dusk-earthshadow`（wpac，−4.7° 太阳高度，开阔海面，coverage 0.3 部分云遮挡）：整图 mean 差 0.83、over8 占比 1.3%，可见海面被云大幅遮挡，未能确认是否存在同一塌缩（P0 问题的公式在该场景同样会被触发，只是可见影响小）。建议返工时一并在这个场景复测。
- `low-sea-glint`（wpac 白天开阔海面，altitude 0.6 km）：mean 差 1.39、over8 占比 7.4%，目视是「霾里远海变灰」的预期效果（与 hnd-low-day / sea-mod-low 同方向），非新问题。
- 真实地面路径与开阔海面分支交界线：在 `cruise-ground`（10.7 km，ground:true，可见海岸线）未发现比改前更明显的接缝；受限于复核时间，未覆盖所有高度/航段组合。

---

## 三、契约与冲突检查

- **`check:glsl` / `typecheck` / `build`**：复核环境（80e8bba + 本分支 merge）全部通过，`dist/assets` 无 0 字节文件。
- **outside-default 冷编译**：首次测量恰逢另一代理占用测量锁（CPU 97%），Δ+57.4%，工具自报「可能不可信」；安静一点后复测 Δ+3.7%（8451 ms vs 基线 8125 ms），与实现者「−2.8%」同量级噪声范围内，**不构成回退**。
- **GPU 帧时间**（`gpu-ab --time frame`，8 轮 ABBA，复核环境独立重跑 `SEA-3-gpu-final-jobs.json`）：hnd-low-day ×1.002、cruise-ground ×1.004、sea-mod-low ×0.996、noon-cumulus ×1.003，全部「在离散度内」，与交接文档一致。
- **SPEC-RAYS**：本分支未改 `atmosphere/rays.ts` / `atmosphere/luts.ts`，diff 与 rays 零交集；全部 ab / gpu-ab 运行（含多个有云场景，rays 默认开）console error 均为 0，未见异常。
- **在途分支 merge-tree**：
  - STROBE-FLASH（`worktree-agent-afec71348fb662881`）、PERF-STORM（`worktree-agent-ae5c1bc2f798e9a35`）：`git diff master...<分支> -- outside-pass.ts terrain-shading.glsl.ts traffic.glsl.ts` 均为空，**零交集**。
  - WS01（`worktree-agent-afe60cd08b749d510`）：只改 `outside-pass.ts`，在 `#ifdef OUTSIDE_WONDER` 云裁切段（约 198–206 行），与 SEA-3 的改动（约 133–171 行）文本上不相邻；`git merge-tree <merge-base> SEA-3分支 WS01分支` 全文无 `CONFLICT` 标记，两处改动可自动合并。

---

## 四、开发体验反馈

- `dev-browser.mjs ab` + `old_patches()`（对 master 做 diff 反推「改前」变体）的机制非常好用：不依赖实现者截图，审查这边在全新的合并工作区里独立重建 old/new 对照，数字与实现者报告吻合，同时能自由追加新场景（本次追加了 fuji / 夜间 / 黄昏共 8 个场景，脚本 `apps/voyage/handoff/sea3rev-extra-mkjobs.py`、诊断脚本 `sea3rev-diag2-mkjobs.py` 留在复核工作区，未提交）。
- 卡的地方：`ab` 的 `--crop` 只能写在 job JSON 里，不是 CLI 全局参数；我第一次传 `--crop x,y,w,h` 被静默忽略（拿到整图，不算浪费太多但排查花了几分钟）。建议 `--help` 里明确标注「仅 job 级」，或者干脆支持一个全局默认 crop 覆盖所有未显式指定 crop 的 job。
- `old_patches()` 反推机制是实现者写在 `SEA-3-mkjobs.py` 里的私有函数，`SCENES` 字典也只覆盖了 hnd-cts/wpac 两个预设，我要测 fuji/scs 预设的场景时只能复制一份这段样板代码。如果这类"对 master 做 diff 反推 old 变体"的辅助函数能提到 `scripts/` 下一个公共小模块（给个 `--src-files` 参数），以后任何任务的审查都能直接引用，不用每次照抄。
- 诊断夜间反射塌缩问题时，把 `L` 强行替换成某个中间量 `×200` 做可视化，会被自动曝光/色适应按"这一帧就是这么亮"重新校准，导致debug 图的绝对亮度不能直接当作该中间量的真实数值来读（哪怕 `ab` 按标准做法冻结了曝光状态，冻结的是"改动前后同一次曝光"，不是"debug 覆写值 vs 真实值"这种量级悬殊的对照）。这次靠"old vs new 用同一套 debug 覆写互相比"绕过去了（两边同样失真，相对比较仍然有效），但如果以后要做这类"单独看某个中间量的绝对量级"的诊断，可能需要专门的"读回 HDR render target 原始浮点值"通道（`ab` 的 `job.hdr` 读回功能，本次没用上，值得下次尝试）。

---

## 五、复现方式

```bash
# 复核工作区（已建好，仍在 D:\Code\opus-test\tmp\sea3rev，审查完毕后按"谁建谁删"清理）
cd D:\Code\opus-test\tmp\sea3rev\apps\voyage
node scripts/dev-browser.mjs ab --port 5274 --jobs apps/voyage/handoff/sea3rev-extra-jobs.json --rounds 1 --out tmp/screenshot/sea3rev/extra
node scripts/dev-browser.mjs ab --port 5274 --jobs apps/voyage/handoff/sea3rev-diag2-jobs.json --rounds 1 --out tmp/screenshot/sea3rev/diag2
python apps/voyage/handoff/sea3rev-profile.py tmp/screenshot/sea3rev/extra/night-sea-milkyway/new.png 800 570 600
```
