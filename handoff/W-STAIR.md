# W-STAIR · 机翼边 2 px 阶梯 / 点阵

- 分支 `worktree-agent-abbe8a37c6af3d120`（已合并 master 22a5988，含 TM02）。对照 worktree `D:\Code\opus-test\tmp\wstair-base`（master，端口 5273），本分支 5213。
- 归属内改动：`src/render/wing.glsl.ts`（`sdWingMain` 分段下界、`wingTrace` 擦边判定与饿死子射线）、`src/render/wing-shading.glsl.ts`（`wingView` 沿用中心颜色的条件）、README 坑点四条、本目录 `W-STAIR-*` 工具。没碰 exposure.ts / clouds / ground。

## 诊断：C11 看到的其实是两个缺陷

`stair_z1.png` 里「整流罩下面的点阵阴影」和「亮三角斜边的一串亮点」外观相近、根因不同。逐个开关排除（同页、同冻结时刻，`W-STAIR-diag.mjs`；截图 `D:\Code\opus-test\tmp\screenshot\wstair\diag1…16`）：

| 候选 | 开关 | 点阵 | 斜边亮点 |
| --- | --- | --- | --- |
| 自阴影（阴影步进 / 软阴影估计） | `uWingDebug` 8 | 不变 | 不变 |
| 边缘超采样（RGSS） | `uWingEdgeAA` 0 | 不变 | 变成暗点 |
| 油罐鼓包法线 | `uWingDebug` 1 | 不变 | 不变 |
| 环境反射 / 高光 | `uWingDebug` 4、只留漫反射 | 不变 | 不变 |
| 材质（只看反照率） | `uWingDebug` 16 | **仍在**，关掉副翼缝线 `wingSeam(s − 0.72)` 后大半消失 | 仍在 |
| 分辨率 / 上采样 | 机翼 pass 本来就是全分辨率 `texelFetch`，高画质档 DPR 1 | — | — |
| TAA | 机翼 pass 没有时间累积，16 帧平均不收敛正说明是确定性的逐像素错误 | — | — |

**点阵（主因）**：命中点的位置错了。把「命中时的距离场值 / 像素宽」写进颜色读回：正常命中在 0–0.4，副翼内端那一片是 −3 到 −8——射线跨进了翼型里面。根因是 `sdWingMain` 分段改截面：襟翼放下时襟翼段（s 0.03–0.72）只到整流罩末端，副翼段是完整翼型，旧写法只按 P 所在的段算截面，段内离副翼内端面一两毫米的点报出几十厘米的距离，球体追踪一步跨过内端面。落在体内的点法线取翼内梯度（常朝下），副翼缝线、漫反射按逐像素乱跳的位置算，成了点阵。in-cloud 的高度 1.35 km 放着襟翼 / 缝翼，所以只在云里（和其他低空场景）出现。

**斜边亮点**：边缘超采样的子样本漏了背景。子射线共用 `uWingSteps/2` 步，前面的擦着薄后缘挪、把预算吃光，后面的只剩 8 步，走不到后缘后面的襟翼 / 短舱就算「没打中」，露出背后的云 / 天空。`uWingDebug |= 1024`（每条各给 64 步）一开就消失。夕阳场景同一个缺陷是后缘上一串亮珠（旧版以为是轮廓光）。另有内轮廓擦边判定只取 1 个像素、采样点常跨过最近点，同一条边隔一格判上一格（`uWingEdgeAA = 2` 的品红是虚线），超采样做一格跳一格。

## 修法

1. `sdWingMain`：段内截面都是完整翼型的子集，离开本段至少走 m，所以真实距离 ≥ min(本段距离, max(完整翼型距离, m))。下界 `lb` 只在两个段内分支里赋值（襟翼、缝翼收起时 lb = 1e3，`min` 后逐位不变），完整翼型距离用 `wingCoord` 已算好的量（`wingFullSectionDist`，含弦向项——只取竖直项时后缘后面会在段边界平面上打中一面不存在的墙，云里一千多个像素，已修）。
2. `wingTrace`：分到步数不足 `uWingSteps/4`、还在包围盒里就用完的子射线（「饿死」的）按打中算，`bumpVar = −1` 标记，不求法线不着色；`wingView` 里沿用中心射线的颜色。一律按打中算不行（商务舱正午前缘外轮廓外扩、斜边台阶变硬），只算「还在逼近」的也不行（夕阳后缘仍漏）；门槛 1/4 是与给足步数的参考图逐像素比选出来的（见下）。调试位 8192 关掉。
3. 内轮廓擦边判定 1 → 2 像素（`rPrev < 2.0`），边缘超采样沿内轮廓连续。
4. 边缘像素的平均加上中心射线（4 条 RGSS + 像素中心 = 5 个样本，覆盖率 /5）。夜里频闪照亮的钝后缘端面（约 4 mm 厚，一两成像素宽、比翼面亮 20 倍）
   被 4 个样本的固定图案沿斜线轮流碰上 / 碰不上，成了一段一段的虚线（改动前就有，频闪一闪就是一串亮点）；中心样本每个像素都碰上，线变连续。
   中心射线进到超采样分支时一定打中了，所以不会把轮廓外扩；中心颜色本来就算好了，零额外开销。

## 前后指标

同页 A/B（`W-STAIR-diag.mjs --base 5273`，同一冻结时刻、换机翼着色器原文；`old2` 自比逐位为 0）。

（数字见下方各节，由 ab4 运行填写）

## 截图

- `D:\Code\opus-test\tmp\screenshot\wstair\ab4\`：各场景 `old/new/nowing` 整屏，`compare.jsonl`
- `ab4\ic-grid.png`（云里 4 姿态：old | new | 差 ×8）、`ab4\other-grid.png`（sunset-wing / 商务舱正午 / 夜间开灯）
- 诊断过程：`diag2\v.png`（法线 / 部件 / 边缘标记）、`diag3\v.png`（反照率二分）、`diag8\v.png`（距离场修复前后）、`diag12\v.png`（给足步数后亮点消失）、`sun3\v.png`、`lim1\*.png`

## 复现

```bash
# 对照：git -C <本 worktree> worktree add --detach D:/Code/opus-test/tmp/wstair-base master；两边各起 vite（5213 / 5273）
node handoff/W-STAIR-diag.mjs --port 5213 --base 5273 --out D:/Code/opus-test/tmp/screenshot/wstair/ab4 --jobs handoff/W-STAIR-jobs-ab.json
python handoff/W-STAIR-grid.py D:/Code/opus-test/tmp/screenshot/wstair/ab4 <输出.png> 600,470,200,110 3 ic_-10_-5,ic_-30_-25,...
node handoff/W-STAIR-diag.mjs --port 5213 --base 5273 --out ... --jobs handoff/W-STAIR-jobs-iter.json --hdr   # 迭代计数
python handoff/W-STAIR-iter.py <输出>/sunset-wing old new
node handoff/W-STAIR-diag.mjs --port 5213 --base 5273 --out ... --jobs handoff/W-STAIR-jobs-bench10.json      # 批渲计时
```
