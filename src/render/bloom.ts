import * as THREE from "three";
import { FULLSCREEN_VERT } from "../atmosphere/common.glsl";
import type { FullscreenPass } from "./pass";

/**
 * 眩光（veiling glare）：人眼和窗板会把强光散射到周围，直视太阳时看到一大片光晕。
 * 做法是 HDR 图的 mip 链：13 点下采样（Jimenez 2014, Call of Duty: Advanced Warfare）逐级缩小，
 * 再用 3×3 帐篷滤波逐级放大并累加，得到一个宽尾巴的点扩散函数。
 * 这里保能量：输出是各级模糊的平均，乘上「被散射掉的能量比例」后加回原图。
 */

const DOWN_FRAG = /* glsl */ `
uniform sampler2D uSrc;
uniform vec2 uSrcTexel;
varying vec2 vUv;
vec3 s(vec2 o) { return texture(uSrc, vUv + o * uSrcTexel).rgb; }
void main() {
  vec3 a = s(vec2(-2.0, 2.0)), b = s(vec2(0.0, 2.0)), c = s(vec2(2.0, 2.0));
  vec3 d = s(vec2(-2.0, 0.0)), e = s(vec2(0.0, 0.0)), f = s(vec2(2.0, 0.0));
  vec3 g = s(vec2(-2.0, -2.0)), h = s(vec2(0.0, -2.0)), i = s(vec2(2.0, -2.0));
  vec3 j = s(vec2(-1.0, 1.0)), k = s(vec2(1.0, 1.0)), l = s(vec2(-1.0, -1.0)), m = s(vec2(1.0, -1.0));
  vec3 col = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  gl_FragColor = vec4(col, 1.0);
}
`;

const UP_FRAG = /* glsl */ `
uniform sampler2D uLow;     // 更低一级（已经累加过）
uniform sampler2D uCurrent; // 同一级的下采样结果
uniform vec2 uLowTexel;
uniform bool uHasLow;
uniform float uFalloff;     // 每往外一级（尺度翻倍）权重乘这个数：人眼眩光大致按 1/θ² 衰减，远处的尾巴要弱
varying vec2 vUv;
void main() {
  vec3 up = vec3(0.0);
  if (uHasLow) {
    vec2 t = uLowTexel;
    up = texture(uLow, vUv).rgb * 4.0
       + (texture(uLow, vUv + vec2(t.x, 0.0)).rgb + texture(uLow, vUv - vec2(t.x, 0.0)).rgb
        + texture(uLow, vUv + vec2(0.0, t.y)).rgb + texture(uLow, vUv - vec2(0.0, t.y)).rgb) * 2.0
       + (texture(uLow, vUv + t).rgb + texture(uLow, vUv - t).rgb
        + texture(uLow, vUv + vec2(t.x, -t.y)).rgb + texture(uLow, vUv + vec2(-t.x, t.y)).rgb);
    up /= 16.0;
  }
  gl_FragColor = vec4(texture(uCurrent, vUv).rgb + up * uFalloff, 1.0);
}
`;

function mat(fragmentShader: string, uniforms: Record<string, THREE.IUniform>) {
  return new THREE.ShaderMaterial({
    vertexShader: FULLSCREEN_VERT,
    fragmentShader,
    uniforms,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
}

export class Bloom {
  static readonly LEVELS = 7;
  static readonly FALLOFF = 0.55;
  /** 各级权重之和：最终结果除以它，保证能量守恒 */
  static readonly WEIGHT_SUM = (1 - Math.pow(Bloom.FALLOFF, Bloom.LEVELS)) / (1 - Bloom.FALLOFF);
  private down: THREE.WebGLRenderTarget[] = [];
  private up: THREE.WebGLRenderTarget[] = [];
  private readonly downMat = mat(DOWN_FRAG, { uSrc: { value: null }, uSrcTexel: { value: new THREE.Vector2() } });
  private readonly upMat = mat(UP_FRAG, {
    uLow: { value: null },
    uCurrent: { value: null },
    uLowTexel: { value: new THREE.Vector2() },
    uHasLow: { value: false },
    uFalloff: { value: Bloom.FALLOFF },
  });

  constructor(
    private readonly pass: FullscreenPass,
    private readonly type: THREE.TextureDataType,
  ) {}

  setSize(w: number, h: number) {
    for (const t of [...this.down, ...this.up]) t.dispose();
    this.down = [];
    this.up = [];
    for (let i = 0; i < Bloom.LEVELS; i++) {
      w = Math.max(1, Math.floor(w / 2));
      h = Math.max(1, Math.floor(h / 2));
      const opts = { type: this.type, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false };
      this.down.push(new THREE.WebGLRenderTarget(w, h, opts));
      this.up.push(new THREE.WebGLRenderTarget(w, h, opts));
    }
  }

  /** 返回半分辨率的眩光纹理：各级模糊的加权和（除以 WEIGHT_SUM 后就是归一化的点扩散结果） */
  render(src: THREE.WebGLRenderTarget): THREE.Texture {
    let prev: THREE.WebGLRenderTarget = src;
    for (const t of this.down) {
      this.downMat.uniforms.uSrc.value = prev.texture;
      this.downMat.uniforms.uSrcTexel.value.set(1 / prev.width, 1 / prev.height);
      this.pass.render(this.downMat, t);
      prev = t;
    }
    for (let i = Bloom.LEVELS - 1; i >= 0; i--) {
      const u = this.upMat.uniforms;
      u.uCurrent.value = this.down[i].texture;
      u.uHasLow.value = i < Bloom.LEVELS - 1;
      if (i < Bloom.LEVELS - 1) {
        u.uLow.value = this.up[i + 1].texture;
        u.uLowTexel.value.set(1 / this.up[i + 1].width, 1 / this.up[i + 1].height);
      }
      this.pass.render(this.upMat, this.up[i]);
    }
    return this.up[0].texture;
  }
}
