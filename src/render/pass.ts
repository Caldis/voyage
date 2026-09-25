import * as THREE from "three";

/** 全屏三角形：所有后期与 LUT 计算都通过它把一个着色器画满目标 */
export class FullscreenPass {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly mesh: THREE.Mesh;

  constructor(private readonly renderer: THREE.WebGLRenderer) {
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
