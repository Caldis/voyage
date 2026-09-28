# C-TOFU 独立审查（兼美术 / 性能）

对象：`worktree-agent-a2341dfa7198ef2d1`（3f9ffd4，含 C-FLAT）。复核树：`tmp/ctofurev`（master add9f73 + merge --no-commit，自动合并无冲突），dev 5261；基线 master 5181。

## 结论（草稿，写到一半，最终以文末为准）

- 效果：cu-6000 / tow-a8 / noon 远排的平顶面包块、竖肋在 ×3 放大下确实消失，换成高低错落的圆顶。新问题：6 km 机位中距离出现**悬挑 / 拱形 / 细长横架**（`z/cu-6000-hook.png`）；cu-side 近处塔软成一团雾（C06 问题被暴露）。
- 性能（复测，比交接自报更差）：gpu-ab 云 pass noon ×1.156、variety ×1.173、cu-6000 ×1.174、cu-side ×1.230；sea-sc / storm-sc / storm-cu 在离散度内。mip 不封顶（lod6）：noon ×1.051、variety ×1.154、cu-6000 ×1.099、cu-side ×1.186。步数几乎不变（noon +1%、variety +5%、cu-6000 +2.6%），代价是每个有云样本变贵 / 有云样本变多 + mip 封顶的纹理带宽，不是步数。
- 冷编译：cloud-march +1.0%、storm +2.5%、probe +8.6%（噪声大）、cirrus +6.7%，都在门槛内。
- PERF-STORM 无文本冲突，但它只动天气程序，抵消不了默认程序的增量。
- 待补：时间噪声（flight）、「只在主步进封顶 mip」变体的 GPU。
