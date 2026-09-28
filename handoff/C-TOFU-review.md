# C-TOFU 独立审查（兼美术 / 性能）

对象：`worktree-agent-a2341dfa7198ef2d1`（3f9ffd4，含 C-FLAT）。复核树：`tmp/ctofurev`（master add9f73 + merge --no-commit，自动合并无冲突），dev 5261；基线 master 5181。

## 结论（写到一半的草稿，最终以文末为准）

- 进行中。读 diff 阶段：逻辑自洽，只动 `layerDensity` 形状段 + CPU 的 `cumulusShape()`；层积云 / 高积云（云型 0.45 → 权重 0）/ 卷云只受 mip 封顶影响；雷暴 / 台风系统本身的密度函数没动。
- 冷编译复核（`shader-budget --baseline master --rounds 5`，min；期间有别人的 gpu-ab 在跑，只作参考）：cloud-march +1.0%、cloud-march-storm +2.5%、cloud-shadow-map −1.1%、cloud-probe +8.6%（MAD 很大）、cloud-march-cirrus +6.7%。全部在 SOP 单任务 10% 内；storm 在预审 +5% 内。
- 与 PERF-STORM（671929d）`git merge-tree` 无文本冲突；PERF-STORM 只动天气程序（`#ifdef CLOUD_WEATHER` 的空域跳跃），**抵消不了默认云程序（noon-cumulus / clouds-variety / cu-6000）上的增量**。
- 待复测：GPU、时间噪声、画面。
