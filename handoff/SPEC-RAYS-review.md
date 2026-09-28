# SPEC-RAYS 独立审查（审查员兼美术视角）

对象：`worktree-agent-a148424e65b711419`（b8a5cb4）。复核工作区 `tmp/raysrev`（master e272ad8 + merge --no-commit），dev server 5269（5268 已被 PERF-STORM 占用）。

## 结论（写作中，先记要点）

- 读 diff 结论：接线本身干净——舱内合成（含经济舱变体，共用 uniforms 对象）与水珠折射两处读 uOutside 都拿到 rays.target；TM02 的 uPreWing 是 hdr（舱内合成之后），与机翼后图同在 rays 下游，dW 判据不受影响；曝光 / 测光 / bloom / T48c 都读 hdrWing，不受影响；resize 与自动降档（quality 调 main.resize）都走 rays.setSize。
- 待验证的疑点（可能返工项）：
  1. 步进只在「海面—云顶」求交，**不知道地形 / 奇观 / 远处飞机等不透明物体的深度**：物体背后那段本来就没画进画面的空气散射也被减掉 → 近处山体、浮空城等在云影天里可能被压暗（最多 90%）。
  2. 开关边界是硬切：太阳 −4°（与主光源换月亮同一门限）、编译完成那一帧、云影图 ready 那一帧——ΔL 非零时会跳一下。
  3. rays.target 全分辨率常驻（第 60 帧起无论白天黑夜都会分配），显存成本。

（下文补齐证据后更新）
