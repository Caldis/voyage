import * as THREE from "three";
import { FULLSCREEN_VERT } from "../atmosphere/common.glsl";
import type { FullscreenPass } from "../render/pass";

/**
 * 云用的可平铺噪声，启动时在 GPU 上算好，读回 CPU 后做成带 mipmap 的纹理。
 * 3D 纹理没法直接当渲染目标生成 mipmap，所以先把各层切片铺成一张 2D 图集，读回后重排。
 *
 * - 形状噪声 128³：R = Perlin-Worley（云团的大轮廓），GBA = 三个频率的 Worley fbm
 * - 细节噪声 64³：RGB = 三个频率的 Worley fbm，用来侵蚀云的边缘
 * - 天气图 512²：R = 覆盖率，G = 对流单体，B = 云顶高度 / 尺度变化，A = 小单体
 */

const NOISE_LIB = /* glsl */ `
vec3 hash33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}

// Worley 噪声：p 以格子为单位，period 个格子一周期；返回 1 − 到最近特征点的距离
float worley(vec3 p, float period) {
  vec3 id = floor(p);
  vec3 f = fract(p);
  float minD = 1e9;
  for (int x = -1; x <= 1; x++)
  for (int y = -1; y <= 1; y++)
  for (int z = -1; z <= 1; z++) {
    vec3 o = vec3(x, y, z);
    vec3 fp = o + hash33(mod(id + o, period)) - f;
    minD = min(minD, dot(fp, fp));
  }
  return 1.0 - clamp(sqrt(minD), 0.0, 1.0);
}

// 可平铺的梯度噪声（Perlin），大致在 [-1, 1]
float gradNoise(vec3 x, float period) {
  vec3 p = floor(x);
  vec3 w = fract(x);
  vec3 u = w * w * w * (w * (w * 6.0 - 15.0) + 10.0);
  float n[8];
  for (int i = 0; i < 8; i++) {
    vec3 c = vec3(float(i & 1), float((i >> 1) & 1), float((i >> 2) & 1));
    vec3 g = normalize(hash33(mod(p + c, period)) * 2.0 - 1.0);
    n[i] = dot(g, w - c);
  }
  return mix(
    mix(mix(n[0], n[1], u.x), mix(n[2], n[3], u.x), u.y),
    mix(mix(n[4], n[5], u.x), mix(n[6], n[7], u.x), u.y),
    u.z) * 1.6;
}

float perlinFbm(vec3 p, float freq, int octaves) {
  float amp = 1.0;
  float sum = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;
    sum += amp * gradNoise(p * freq, freq);
    freq *= 2.0;
    amp *= 0.55;
  }
  return sum;
}

float worleyFbm(vec3 p, float freq) {
  return worley(p * freq, freq) * 0.625
       + worley(p * freq * 2.0, freq * 2.0) * 0.25
       + worley(p * freq * 4.0, freq * 4.0) * 0.125;
}

float remap(float v, float a, float b, float c, float d) {
  return c + (v - a) / (b - a) * (d - c);
}
`;

const ATLAS_HEADER = /* glsl */ `
uniform float uSize;   // 3D 纹理边长
uniform float uTiles;  // 图集每行放几层切片
${NOISE_LIB}
vec3 atlasUvw() {
  vec2 px = floor(gl_FragCoord.xy);
  vec2 tile = floor(px / uSize);
  vec2 inTile = px - tile * uSize;
  float slice = tile.y * uTiles + tile.x;
  return (vec3(inTile, slice) + 0.5) / uSize;
}
`;

const SHAPE_FRAG = /* glsl */ `
${ATLAS_HEADER}
void main() {
  vec3 p = atlasUvw();
  // 「翻卷」的 Perlin：取绝对值后形成圆鼓鼓的团块
  float pfbm = mix(1.0, perlinFbm(p, 4.0, 7), 0.5);
  pfbm = abs(pfbm * 2.0 - 1.0);
  float w1 = worleyFbm(p, 4.0);
  float perlinWorley = clamp(remap(pfbm, 0.0, 1.0, w1, 1.0), 0.0, 1.0);
  gl_FragColor = vec4(perlinWorley, w1, worleyFbm(p, 8.0), worleyFbm(p, 16.0));
}
`;

const DETAIL_FRAG = /* glsl */ `
${ATLAS_HEADER}
void main() {
  vec3 p = atlasUvw();
  gl_FragColor = vec4(worleyFbm(p, 2.0), worleyFbm(p, 4.0), worleyFbm(p, 8.0), 1.0);
}
`;

const WEATHER_FRAG = /* glsl */ `
uniform float uSize;
${NOISE_LIB}
void main() {
  vec3 p = vec3(gl_FragCoord.xy / uSize, 0.0);
  // R：大尺度覆盖率；G：约 15 km 的对流单体（Worley，1 = 单体中心）；
  // B：云顶高度与云团尺度的变化场；A：约 5 km 的小单体
  float cov = 0.5 + 0.55 * perlinFbm(p, 4.0, 6);
  float cells = worley(p * 6.0 + vec3(0.0, 0.0, 0.37), 6.0);
  float var = 0.5 + 0.5 * perlinFbm(p + vec3(0.0, 0.0, 0.61), 3.0, 4);
  float small = worley(p * 18.0 + vec3(0.0, 0.0, 0.83), 18.0);
  gl_FragColor = vec4(clamp(cov, 0.0, 1.0), cells, clamp(var, 0.0, 1.0), small);
}
`;

function noiseMaterial(fragmentShader: string, uniforms: Record<string, THREE.IUniform>) {
  return new THREE.ShaderMaterial({
    vertexShader: FULLSCREEN_VERT,
    fragmentShader,
    uniforms,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
}

function readback(renderer: THREE.WebGLRenderer, pass: FullscreenPass, mat: THREE.Material, w: number, h: number) {
  const rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.UnsignedByteType, depthBuffer: false });
  // 按行分几次画，避免单次绘制过久触发 Windows 的 GPU 超时重置（TDR）
  const bands = Math.max(1, Math.ceil(h / 128));
  renderer.setScissorTest(true);
  for (let b = 0; b < bands; b++) {
    const y = Math.floor((b * h) / bands);
    const y2 = Math.floor(((b + 1) * h) / bands);
    rt.scissor.set(0, y, w, y2 - y);
    rt.scissorTest = true;
    pass.render(mat, rt);
  }
  renderer.setScissorTest(false);
  const data = new Uint8Array(w * h * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, w, h, data);
  rt.dispose();
  return data;
}

function make3D(renderer: THREE.WebGLRenderer, pass: FullscreenPass, frag: string, size: number) {
  const tiles = Math.ceil(Math.sqrt(size));
  const w = tiles * size;
  const h = Math.ceil(size / tiles) * size;
  const atlas = readback(renderer, pass, noiseMaterial(frag, { uSize: { value: size }, uTiles: { value: tiles } }), w, h);
  const vol = new Uint8Array(size * size * size * 4);
  for (let z = 0; z < size; z++) {
    const tx = (z % tiles) * size;
    const ty = Math.floor(z / tiles) * size;
    for (let y = 0; y < size; y++) {
      const src = ((ty + y) * w + tx) * 4;
      vol.set(atlas.subarray(src, src + size * 4), (z * size + y) * size * 4);
    }
  }
  const tex = new THREE.Data3DTexture(vol, size, size, size);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}

export interface CloudNoise {
  shape: THREE.Data3DTexture;
  detail: THREE.Data3DTexture;
  weather: THREE.DataTexture;
}

export function generateCloudNoise(renderer: THREE.WebGLRenderer, pass: FullscreenPass): CloudNoise {
  const shape = make3D(renderer, pass, SHAPE_FRAG, 128);
  const detail = make3D(renderer, pass, DETAIL_FRAG, 64);
  const size = 512;
  const wdata = readback(renderer, pass, noiseMaterial(WEATHER_FRAG, { uSize: { value: size } }), size, size);
  const weather = new THREE.DataTexture(wdata, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  weather.wrapS = weather.wrapT = THREE.RepeatWrapping;
  weather.minFilter = THREE.LinearMipmapLinearFilter;
  weather.magFilter = THREE.LinearFilter;
  weather.generateMipmaps = true;
  weather.needsUpdate = true;
  return { shape, detail, weather };
}
