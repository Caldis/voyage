import * as THREE from "three";

/**
 * 全屏三角形：所有后期与 LUT 计算都通过它把一个着色器画满目标。
 *
 * PERF-6：关掉 `renderer.autoClear`。全屏三角形（顶点 [-1,-1]/[3,-1]/[-1,3]，裁剪空间下已经盖满整个视口
 * 或当前 scissor 矩形）每次调用都会给目标的每个像素写一份新颜色，再清一遍纯属多余
 * （three.js 每次 `render()` 默认都会 clear，全仓库 107→119 次/帧的 `gl.clear` 几乎全来自这里：
 * 每张 LUT 切片、FFT 蝶形、每个全屏 pass 各清一次）。
 * `renderer.render()` 是本仓库唯一的 GL 绘制入口（`grep renderer.render(` 只在这一处命中，
 * 场景里从来没有真正的透视相机 / 多物体绘制），所以在这里一次性关掉即可，不用逐个调用点改。
 * 已按「部分覆盖 / 深度 / 累积」三类逐个核对过所有调用点（见 handoff/PERF-6-8.md 的清单），确认没有
 * 一个目标依赖「关掉的 pass 帮我们清掉旧内容」：
 *   - 部分覆盖（`clouds.ts` 的云影图用 `scissor` 分帧建）：绘制本身已经被 scissor 矩形裁剪到「本帧新建的那部分」，
 *     清不清都只影响这个矩形内部，反正马上被同一次绘制整个覆盖，等价。
 *   - 深度（云光线步进的 `raw` 目标，唯一带真实深度附件的目标）：`depthFunc` 显式设成 `AlwaysDepth`
 *     （见 `clouds.ts` 里 `depthTest: true` 处的注释），深度测试恒通过，写不写旧深度都不影响这次写入。
 *   - 累积（云 resolve 的时间累积、眩光 mip 链上采样、曝光适应）：都是着色器里显式读上一帧 / 上一级纹理再
 *     算出全新值写回，不是 GL blending，每次绘制同样是 100% 覆盖目标。
 *   - 全仓库没有任何全屏着色器写 `discard`（`grep discard src/` 零命中），也没有用到 `blending: Additive/Custom`。
 * 以后新增全屏 pass 如果真的需要「只画一部分、其余保留」，也不必依赖 clear：让绘制本身用 scissor 限定范围
 * 即可（和现有的云影图做法一致）；只有当同一目标要靠 GL blending 叠加多次绘制时才需要显式
 * `renderer.clear()`（目前没有这种用法）。
 */
export class FullscreenPass {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly mesh: THREE.Mesh;

  constructor(readonly renderer: THREE.WebGLRenderer) {
    renderer.autoClear = false;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
    this.mesh = new THREE.Mesh(geometry);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }

  /** layer：渲染到 3D 目标时的层号 */
  render(material: THREE.Material, target: THREE.WebGLRenderTarget | null, layer = 0) {
    this.mesh.material = material;
    this.renderer.setRenderTarget(target, layer);
    this.renderer.render(this.scene, this.camera);
  }
}
