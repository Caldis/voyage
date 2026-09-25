import * as THREE from "three";
import type { CloudUniforms } from "./clouds/clouds";

/**
 * 天气系统：在普通云层之外叠加雷暴单体和台风，并调度闪电。
 * 雷暴、台风都固定在地面（本地公里坐标），飞机飞过时从窗外经过。
 *
 * 闪电按泊松过程发生（每个单体平均几秒一次）；一次闪电有 2–4 次回击，间隔几十毫秒，所以会连闪几下。
 * 约 35% 是云地闪：生成一条从云底到地面的折线主通道（带一条分叉），由场景着色器画出来。
 */

export interface WeatherPreset {
  id: string;
  name: string;
}

export const WEATHER_PRESETS: WeatherPreset[] = [
  { id: "fair", name: "无特殊天气（只有云层）" },
  { id: "storm", name: "孤立雷暴（积雨云）" },
  { id: "squall", name: "飑线（一排雷暴）" },
  { id: "typhoon-bands", name: "台风外围螺旋雨带" },
  { id: "typhoon-eye", name: "台风眼内（体育场效应）" },
];

interface Storm {
  x: number;
  z: number;
  radius: number;
  top: number;
  nextFlash: number;
}

interface Stroke {
  t0: number;
  intensity: number;
}

const MAX_BOLT_POINTS = 16;

export class WeatherSystem {
  storms: Storm[] = [];
  hurricane: { x: number; z: number; eye: number } | null = null;
  private strokes: Stroke[] = [];
  private flashPos = new THREE.Vector3();
  /** 云地闪的主通道（本地公里坐标，y 是高度），给场景着色器 */
  readonly bolt = Array.from({ length: MAX_BOLT_POINTS }, () => new THREE.Vector3());
  boltCount = 0;
  boltIntensity = 0;
  private time = 0;

  constructor(private readonly u: CloudUniforms) {}

  /** 按预设在飞机附近摆放天气。pos：飞机本地坐标；fwd / out：航向与窗外方向（水平单位向量，x 东 z 南） */
  apply(id: string, pos: THREE.Vector2, fwd: THREE.Vector3, out: THREE.Vector3) {
    this.storms = [];
    this.hurricane = null;
    const at = (ahead: number, side: number) => ({ x: pos.x + fwd.x * ahead + out.x * side, z: pos.y + fwd.z * ahead + out.z * side });
    const storm = (ahead: number, side: number, radius: number, top: number) => {
      const p = at(ahead, side);
      this.storms.push({ ...p, radius, top, nextFlash: this.time + Math.random() * 3 });
    };
    // 窗户的视野左右各约 25°：天气主要摆在窗外侧，稍微偏前，随着飞机前进慢慢移过窗前
    if (id === "storm") storm(4, 60, 6.5, 13.5);
    if (id === "squall") {
      // 一排雷暴，和航线大致平行，间距约 12 km
      for (let i = 0; i < 4; i++) storm(-15 + i * 16, 55 + i * 5, 4 + Math.random() * 2, 11.5 + Math.random() * 3);
    }
    if (id === "typhoon-bands") this.hurricane = { ...at(40, 180), eye: 20 };
    if (id === "typhoon-eye") this.hurricane = { ...at(0, 0), eye: 30 };
    this.syncUniforms();
  }

  private syncUniforms() {
    const u = this.u;
    u.uStormCount.value = this.storms.length;
    this.storms.forEach((s, i) => u.uStorms.value[i].set(s.x, s.z, s.radius, s.top));
    if (this.hurricane) u.uHurricane.value.set(this.hurricane.x, this.hurricane.z, this.hurricane.eye, 1);
    else u.uHurricane.value.w = 0;
    this.updateShell();
  }

  /** 步进的外壳高度范围：层状云、雷暴、台风合起来 */
  updateShell() {
    const u = this.u;
    let bottom = u.uCloudBottom.value;
    let top = u.uCloudTop.value;
    if (this.storms.length) {
      bottom = 0.0; // 雨幡一直落到地面
      top = Math.max(top, ...this.storms.map((s) => s.top + 1.3));
    }
    if (this.hurricane) {
      bottom = Math.min(bottom, 0.8);
      top = Math.max(top, 15.5);
    }
    u.uShellBottom.value = bottom;
    u.uShellTop.value = top;
  }

  update(dt: number) {
    this.time += dt;
    // 触发新的闪电
    for (const s of this.storms) {
      if (this.time < s.nextFlash) continue;
      s.nextFlash = this.time + -Math.log(1 - Math.random()) * 5; // 平均 5 秒一次
      this.trigger(s);
    }
    // 回击序列：每次回击亮度按 ~50 ms 衰减
    let intensity = 0;
    this.strokes = this.strokes.filter((k) => this.time - k.t0 < 0.4);
    for (const k of this.strokes) {
      const age = this.time - k.t0;
      if (age >= 0) intensity += k.intensity * Math.exp(-age / 0.05);
    }
    this.u.uFlash.value.set(this.flashPos.x, this.flashPos.y, this.flashPos.z, intensity);
    this.boltIntensity = this.boltCount > 0 ? intensity : 0;
    if (intensity < 1e-3) this.boltCount = 0;
  }

  private trigger(s: Storm) {
    const cg = Math.random() < 0.35;
    const ang = Math.random() * Math.PI * 2;
    const rr = Math.random() * s.radius * 0.7;
    const fx = s.x + Math.cos(ang) * rr;
    const fz = s.z + Math.sin(ang) * rr;
    // 云内闪电在云体中上部；云地闪的光主要在云底附近
    this.flashPos.set(fx, cg ? 2.0 : 3 + Math.random() * 6, fz);
    const n = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < n; i++) this.strokes.push({ t0: this.time + i * (0.05 + Math.random() * 0.08), intensity: 300 * (i === 0 ? 1 : 0.5 + Math.random() * 0.5) });
    this.boltCount = 0;
    if (cg) this.makeBolt(fx, fz);
  }

  /** 云地闪主通道：从云底往下走的折线，每段随机偏折；中途分出一条短分叉（用剩余的点） */
  private makeBolt(x: number, z: number) {
    const main = 11;
    let px = x;
    let pz = z;
    for (let i = 0; i < main; i++) {
      const alt = 1.2 * (1 - i / (main - 1));
      this.bolt[i].set(px, alt, pz);
      px += (Math.random() - 0.5) * 0.35;
      pz += (Math.random() - 0.5) * 0.35;
    }
    // 分叉：从主通道第 3 个点斜着往下，不落地
    const b0 = this.bolt[3];
    let bx = b0.x;
    let bz = b0.z;
    let balt = b0.y;
    const dir = Math.random() * Math.PI * 2;
    for (let i = main; i < MAX_BOLT_POINTS; i++) {
      bx += Math.cos(dir) * 0.25 + (Math.random() - 0.5) * 0.15;
      bz += Math.sin(dir) * 0.25 + (Math.random() - 0.5) * 0.15;
      balt -= 0.12;
      this.bolt[i].set(bx, balt, bz);
    }
    this.boltCount = MAX_BOLT_POINTS;
  }
}
