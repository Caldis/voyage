import { LocalFrame } from "../ground/geo";
import type { CloudRegime } from "../weather";

/**
 * 调试小地图（DX-06）：可选的角落 2D 叠层，纯 Canvas 2D，不碰任何 WebGL 程序、不加着色器。
 * 关闭（enabled = false）时 update() 第一行就返回，canvas 本身 display: none，浏览器不会合成它——零开销。
 *
 * 画的东西：
 *   - 本机（图标固定在圆心，因为地图始终「航向朝上」）、已飞过的轨迹、当前航线（导演的航段或预设终点）；
 *   - 「云的多普勒」：仿气象雷达回波图。背景网格从 WeatherField.sample() 采样云量 / 云型换算出基础回波强度，
 *     叠加当前实际渲染中的雷暴单体、台风（weather.storms / weather.hurricane）——保证雷达图和窗外看到的天气一致，
 *     不论天气是导演按天气场摆的，还是面板手选的。这是「示意」而非真实雷达反演，尤其是台风螺旋雨带是按角度
 *     的正弦调制画出来的近似螺旋，不是 clouds.glsl.ts 里真正的密度场（那边没有暴露 CPU 可读的接口）；
 *   - 远处的其他飞机（traffic.ts 的位置，已经是相对本机的公里偏移，直接旋到「航向朝上」即可）；
 *   - 奇观（wonders.active 的经纬度 + 名字）。
 *
 * 性能：雷达回波网格（默认 40×40）只在开着小地图时，每约 800 ms 重新采样一次，且分帧算（每帧最多 3 行），
 * 避免单帧尖峰；采样完成前一直显示上一次的网格，不会有半张图的接缝。其余每帧只做：矢量画本机 / 轨迹 / 航线 /
 * 交通 / 奇观（几十次 canvas 绘制调用）+ 把网格位图贴上去（一次 drawImage）。
 */

const D2R = Math.PI / 180;
const clamp01 = (v: number) => Math.min(Math.max(v, 0), 1);
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** 量程档位（km，本机到边缘的距离 = 一半） */
export const MINIMAP_RANGES = [50, 200, 800] as const;

/** 各云型对「回波强度」的粗略折算：晴空不反射，卷云几乎透明，浓积云 / 对流最强——不是真实雷达反射率，
 *  只是让小地图上的云量 / 云型看起来像回波图（真实雷达测的是降水粒子，不是云本身） */
const REGIME_ECHO_FACTOR: Record<CloudRegime, number> = {
  clear: 0,
  cumulus: 0.4,
  towering: 0.9,
  stratocumulus: 0.55,
  altocumulus: 0.28,
  cirrus: 0.1,
};

/** 雷达色阶：弱→强按 绿→黄→橙红→品红→紫 走，仿常见气象雷达回波图配色 */
const COLOR_STOPS: [number, number, number, number][] = [
  [0.0, 55, 170, 70],
  [0.32, 210, 205, 60],
  [0.58, 220, 110, 40],
  [0.8, 205, 40, 140],
  [1.0, 165, 60, 220],
];
const ECHO_MIN_V = 0.06;

function radarColor(v: number): [number, number, number, number] {
  if (v < ECHO_MIN_V) return [0, 0, 0, 0];
  let i = 1;
  while (i < COLOR_STOPS.length - 1 && v > COLOR_STOPS[i][0]) i++;
  const [v0, r0, g0, b0] = COLOR_STOPS[i - 1];
  const [v1, r1, g1, b1] = COLOR_STOPS[i];
  const t = v1 > v0 ? clamp01((v - v0) / (v1 - v0)) : 1;
  const alpha = Math.min(235, 100 + v * 150);
  return [r0 + (r1 - r0) * t, g0 + (g1 - g0) * t, b0 + (b1 - b0) * t, alpha];
}

/** WeatherField 暴露给小地图的最小接口（结构类型，不依赖 weather.ts 的其余实现细节） */
export interface MinimapWeatherField {
  sample(lat: number, lon: number, t: number): { coverage: number; regime: CloudRegime };
}

export interface MinimapInput {
  /** 本机经纬度、航向（度，从正北顺时针）、模拟时间（ms，天气场取样用） */
  lat: number;
  lon: number;
  heading: number;
  simTime: number;
  /** 天气场（director.weather.field）：CPU 端按网格取样云量 / 云型 */
  field: MinimapWeatherField;
  /** 当前渲染中的雷暴单体（weather.storms），本地公里坐标（x 东、z 南，原点是地面 clipmap 的本地原点） */
  storms: { x: number; z: number; radius: number }[];
  /** 当前渲染中的台风（weather.hurricane），同上坐标系 */
  hurricane: { x: number; z: number; eye: number } | null;
  /** 本机在同一坐标系里的位置（cloudUniforms.uCloudOffset.value），换算 storms/hurricane 相对本机的偏移用 */
  localOffset: { x: number; z: number };
  /** 远处飞机（traffic.ts 的 planes）：已经是相对本机的公里偏移（x 东、z 南），忽略高度 */
  traffic: { x: number; z: number; dirX: number; dirZ: number; active: boolean }[];
  /** 当前奇观（wonders.active），没有则 null */
  wonder: { lat: number; lon: number; name: string; reveal: number } | null;
  /** 当前航线：导演的航段目的地，或预设的固定终点；都没有则 null */
  route: { toLat: number; toLon: number; toName: string } | null;
}

interface BuildState {
  frame: LocalFrame;
  sinH: number;
  cosH: number;
  simTime: number;
  halfRange: number;
  cellKm: number;
  field: MinimapWeatherField;
  storms: { f: number; r: number; radius: number }[];
  hurricane: { f: number; r: number; eye: number } | null;
  pixels: Uint8ClampedArray<ArrayBuffer>;
  row: number;
}

const CANVAS_W = 280;
const CANVAS_H = 300;
const HEADER_H = 20;
const CIRCLE_R = 96;
const CIRCLE_CX = CANVAS_W / 2;
const CIRCLE_CY = HEADER_H + CIRCLE_R + 4;
const GRID_N = 48;
const ROWS_PER_FRAME = 4;
const RADAR_INTERVAL_MS = 800;
const MAX_TRAIL = 200;

const ACCENT = "#d9b77a";
const COLOR_PLANE = "#f2f6ff";
const COLOR_TRAIL = "rgba(120, 200, 255, 0.85)";
const COLOR_TRAFFIC = "#ff9f4a";
const COLOR_WONDER = "#caa1ff";

export class DebugMinimap {
  enabled = false;
  rangeIdx = 1; // 默认 200 km

  private readonly el: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly gridCanvas = document.createElement("canvas");
  private readonly gridCtx: CanvasRenderingContext2D;

  private trail: { lat: number; lon: number }[] = [];
  private build: BuildState | null = null;
  private lastBuildStart = -Infinity;
  private frontReady = false;
  private broken = false;

  constructor() {
    this.gridCanvas.width = GRID_N;
    this.gridCanvas.height = GRID_N;
    this.gridCtx = this.gridCanvas.getContext("2d", { willReadFrequently: false })!;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const el = document.createElement("canvas");
    el.width = Math.round(CANVAS_W * dpr);
    el.height = Math.round(CANVAS_H * dpr);
    el.style.cssText = `position:fixed;left:16px;bottom:16px;width:${CANVAS_W}px;height:${CANVAS_H}px;` +
      "border-radius:14px;z-index:5;display:none;cursor:pointer;box-shadow:0 2px 18px rgba(0,0,0,.45);";
    el.title = "点击切换量程";
    el.addEventListener("click", () => this.cycleRange());
    document.body.appendChild(el);
    this.el = el;
    const ctx = el.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx = ctx;
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    this.el.style.display = on ? "block" : "none";
    if (on) {
      // 重新打开：立刻排一次采样，别等上一次关闭前的时间戳
      this.lastBuildStart = -Infinity;
      this.frontReady = false;
    }
  }

  toggle() {
    this.setEnabled(!this.enabled);
  }

  private cycleRange() {
    this.rangeIdx = (this.rangeIdx + 1) % MINIMAP_RANGES.length;
    this.frontReady = false;
    this.build = null;
    this.lastBuildStart = -Infinity;
  }

  get rangeKm() {
    return MINIMAP_RANGES[this.rangeIdx];
  }

  /** 每帧调用；关闭或出错时立即返回，不做任何工作 */
  update(input: MinimapInput) {
    if (!this.enabled || this.broken) return;
    try {
      this.pushTrail(input.lat, input.lon);
      this.maybeStartBuild(input);
      this.stepBuild();
      this.draw(input);
    } catch (err) {
      // 调试工具本身不该拖垮主渲染循环：出错就自己关掉，别每帧刷 console
      console.warn("调试小地图出错，已自动关闭", err);
      this.broken = true;
      this.setEnabled(false);
    }
  }

  private pushTrail(lat: number, lon: number) {
    const last = this.trail[this.trail.length - 1];
    if (last) {
      const dLatKm = (lat - last.lat) * 110.574;
      const dLonKm = (lon - last.lon) * 111.32 * Math.cos((lat * Math.PI) / 180);
      const dist = Math.hypot(dLatKm, dLonKm);
      const minStep = Math.max(this.rangeKm / 60, 0.5);
      if (dist < minStep) return;
    }
    this.trail.push({ lat, lon });
    if (this.trail.length > MAX_TRAIL) this.trail.shift();
  }

  // ---------- 雷达网格：分帧采样，避免单帧尖峰 ----------

  private maybeStartBuild(input: MinimapInput) {
    if (this.build) return;
    const now = performance.now();
    if (now - this.lastBuildStart < RADAR_INTERVAL_MS) return;
    this.lastBuildStart = now;
    const h = input.heading * D2R;
    const sinH = Math.sin(h), cosH = Math.cos(h);
    const toFR = (x: number, z: number) => ({ f: x * sinH - z * cosH, r: x * cosH + z * sinH });
    const storms = input.storms.map((s) => ({ ...toFR(s.x - input.localOffset.x, s.z - input.localOffset.z), radius: s.radius }));
    const hurricane = input.hurricane ? { ...toFR(input.hurricane.x - input.localOffset.x, input.hurricane.z - input.localOffset.z), eye: input.hurricane.eye } : null;
    this.build = {
      frame: new LocalFrame(input.lat, input.lon),
      sinH,
      cosH,
      simTime: input.simTime,
      halfRange: this.rangeKm / 2,
      cellKm: this.rangeKm / GRID_N,
      field: input.field,
      storms,
      hurricane,
      pixels: new Uint8ClampedArray(GRID_N * GRID_N * 4),
      row: 0,
    };
  }

  private stepBuild() {
    const b = this.build;
    if (!b) return;
    const rowsLeft = Math.min(ROWS_PER_FRAME, GRID_N - b.row);
    for (let k = 0; k < rowsLeft; k++) this.buildRow(b, b.row++);
    if (b.row >= GRID_N) {
      this.gridCtx.putImageData(new ImageData(b.pixels, GRID_N, GRID_N), 0, 0);
      this.frontReady = true;
      this.build = null;
    }
  }

  private buildRow(b: BuildState, row: number) {
    const f = b.halfRange - (row + 0.5) * b.cellKm;
    for (let i = 0; i < GRID_N; i++) {
      const r = -b.halfRange + (i + 0.5) * b.cellKm;
      const dx = f * b.sinH + r * b.cosH;
      const dz = -f * b.cosH + r * b.sinH;
      const [lat, lon] = b.frame.toGeo(dx, dz);
      const s = b.field.sample(lat, lon, b.simTime);
      let v = clamp01(s.coverage * (REGIME_ECHO_FACTOR[s.regime] ?? 0.3));
      for (const st of b.storms) {
        const d = Math.hypot(f - st.f, r - st.r);
        const rad = Math.max(st.radius, 1) * 1.6;
        if (d < rad) v = Math.max(v, 0.95 * (1 - d / rad));
      }
      if (b.hurricane) {
        const h = b.hurricane;
        const d = Math.hypot(f - h.f, r - h.r);
        if (d < h.eye * 0.85) v = Math.min(v, 0.05);
        else if (d < h.eye * 1.3) v = Math.max(v, 0.95);
        else if (d < h.eye * 9) {
          // 螺旋雨带的近似：按角度做正弦调制、随半径衰减——只为「看起来像螺旋回波」，不是真实密度场；
          // 开平方把波峰变尖、波谷压扁，网格较粗时也能看出雨带和缝隙的对比
          const ang = Math.atan2(r - h.r, f - h.f);
          const band = Math.pow(0.5 + 0.5 * Math.sin(ang * 3 - d * 0.32), 0.6);
          const falloff = 1 - smoothstep(h.eye * 1.3, h.eye * 9, d);
          v = Math.max(v, clamp01(0.08 + 0.92 * band) * falloff);
        }
      }
      const [rr, gg, bb, aa] = radarColor(v);
      const idx = (row * GRID_N + i) * 4;
      b.pixels[idx] = rr;
      b.pixels[idx + 1] = gg;
      b.pixels[idx + 2] = bb;
      b.pixels[idx + 3] = aa;
    }
  }

  // ---------- 每帧绘制 ----------

  private draw(input: MinimapInput) {
    const ctx = this.ctx;
    const halfRange = this.rangeKm / 2;
    const scale = CIRCLE_R / halfRange; // px / km
    const h = input.heading * D2R;
    const sinH = Math.sin(h), cosH = Math.cos(h);
    /** 世界坐标（东、南，km，相对本机）→ 屏幕像素（航向朝上） */
    const toScreen = (dx: number, dz: number) => {
      const f = dx * sinH - dz * cosH;
      const r = dx * cosH + dz * sinH;
      return { x: CIRCLE_CX + r * scale, y: CIRCLE_CY - f * scale, f, r };
    };

    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    // 面板底
    this.roundRect(ctx, 0, 0, CANVAS_W, CANVAS_H, 14);
    ctx.fillStyle = "rgba(12, 14, 18, 0.74)";
    ctx.fill();

    // 标题行
    ctx.fillStyle = "rgba(232, 230, 225, 0.92)";
    ctx.font = "12px system-ui, sans-serif";
    ctx.textBaseline = "top";
    ctx.fillText(`调试小地图 · 量程 ±${halfRange} km`, 12, 6);

    // 雷达圆
    ctx.save();
    ctx.beginPath();
    ctx.arc(CIRCLE_CX, CIRCLE_CY, CIRCLE_R, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = "rgba(6, 10, 16, 0.92)";
    ctx.fillRect(CIRCLE_CX - CIRCLE_R, CIRCLE_CY - CIRCLE_R, CIRCLE_R * 2, CIRCLE_R * 2);
    if (this.frontReady) {
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(this.gridCanvas, CIRCLE_CX - CIRCLE_R, CIRCLE_CY - CIRCLE_R, CIRCLE_R * 2, CIRCLE_R * 2);
    } else {
      ctx.fillStyle = "rgba(154, 151, 143, 0.8)";
      ctx.font = "11px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("采样中…", CIRCLE_CX, CIRCLE_CY - 6);
      ctx.textAlign = "left";
    }
    // 同心圈（1/2、满量程）
    ctx.strokeStyle = "rgba(255,255,255,0.14)";
    ctx.lineWidth = 1;
    for (const frac of [0.5, 1]) {
      ctx.beginPath();
      ctx.arc(CIRCLE_CX, CIRCLE_CY, CIRCLE_R * frac, 0, Math.PI * 2);
      ctx.stroke();
    }

    // 轨迹（分 4 段淡出，越新越亮，避免每个点都单独 stroke）
    this.drawTrail(ctx, input, toScreen);

    // 航线：本机 → 航段目的地 / 预设终点
    if (input.route) {
      const dxz = new LocalFrame(input.lat, input.lon).toLocal(input.route.toLat, input.route.toLon);
      this.drawWaypoint(ctx, toScreen(dxz[0], dxz[1]), ACCENT, `→ ${input.route.toName}`, halfRange, scale);
    }

    // 远处飞机（已经是相对本机的东/南公里偏移）
    for (const p of input.traffic) {
      if (!p.active) continue;
      const s = toScreen(p.x, p.z);
      if (Math.hypot(s.f, s.r) > halfRange) continue;
      // 三角形默认朝「上」；屏幕方向 = (r, -f)（f 前进/朝上，r 右侧），angle = atan2(r, f)
      const screenAng = Math.atan2(p.dirX * cosH + p.dirZ * sinH, p.dirX * sinH - p.dirZ * cosH);
      this.drawTriangle(ctx, s.x, s.y, screenAng, 5, COLOR_TRAFFIC);
    }

    // 奇观
    if (input.wonder && input.wonder.reveal > 0.02) {
      const dxz = new LocalFrame(input.lat, input.lon).toLocal(input.wonder.lat, input.wonder.lon);
      this.drawWaypoint(ctx, toScreen(dxz[0], dxz[1]), COLOR_WONDER, input.wonder.name, halfRange, scale, "★");
    }

    // 本机（固定在圆心，航向朝上，图标本身就是「朝上」）
    this.drawTriangle(ctx, CIRCLE_CX, CIRCLE_CY, 0, 7, COLOR_PLANE, true);

    ctx.restore(); // 结束圆形裁剪
    ctx.strokeStyle = "rgba(255,255,255,0.25)";
    ctx.beginPath();
    ctx.arc(CIRCLE_CX, CIRCLE_CY, CIRCLE_R, 0, Math.PI * 2);
    ctx.stroke();

    this.drawLegend(ctx, halfRange);
  }

  private drawTrail(ctx: CanvasRenderingContext2D, input: MinimapInput, toScreen: (dx: number, dz: number) => { x: number; y: number; f: number; r: number }) {
    const n = this.trail.length;
    if (n < 2) return;
    const frame = new LocalFrame(input.lat, input.lon);
    const buckets = 4;
    for (let bi = 0; bi < buckets; bi++) {
      const i0 = Math.max(0, Math.floor(((bi - 0.001) * n) / buckets));
      const i1 = Math.min(n - 1, Math.floor(((bi + 1) * n) / buckets));
      if (i1 <= i0) continue;
      ctx.beginPath();
      let started = false;
      for (let i = i0; i <= i1; i++) {
        const p = this.trail[i];
        const [dx, dz] = frame.toLocal(p.lat, p.lon);
        const s = toScreen(dx, dz);
        if (Math.hypot(s.f, s.r) > this.rangeKm / 2 + 4) {
          started = false;
          continue;
        }
        if (!started) {
          ctx.moveTo(s.x, s.y);
          started = true;
        } else ctx.lineTo(s.x, s.y);
      }
      ctx.strokeStyle = COLOR_TRAIL.replace("0.85", String(0.2 + 0.6 * ((bi + 1) / buckets)));
      ctx.lineWidth = 1.6;
      ctx.stroke();
    }
  }

  /** 目的地 / 奇观标记：在量程内画真实位置，超出量程就贴在边缘并标真实距离 */
  private drawWaypoint(
    ctx: CanvasRenderingContext2D,
    s: { x: number; y: number; f: number; r: number },
    color: string,
    label: string,
    halfRange: number,
    scale: number,
    glyph = "◆",
  ) {
    const dist = Math.hypot(s.f, s.r); // s.f / s.r 是公里，不是像素
    let x = s.x, y = s.y;
    const distKm = dist;
    if (dist > halfRange) {
      const t = (halfRange - 6) / dist;
      x = CIRCLE_CX + s.r * scale * t;
      y = CIRCLE_CY - s.f * scale * t;
      ctx.setLineDash([3, 3]);
    } else {
      ctx.setLineDash([4, 4]);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(CIRCLE_CX, CIRCLE_CY);
    ctx.lineTo(x, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = color;
    ctx.font = "11px system-ui, sans-serif";
    ctx.fillText(glyph, x - 4, y - 5);
    ctx.font = "9px system-ui, sans-serif";
    ctx.fillText(`${label} ${Math.round(distKm)}km`, Math.min(x + 6, CANVAS_W - 90), y + 2);
  }

  private drawTriangle(ctx: CanvasRenderingContext2D, x: number, y: number, angle: number, size: number, color: string, outline = false) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(0, -size);
    ctx.lineTo(size * 0.62, size * 0.8);
    ctx.lineTo(-size * 0.62, size * 0.8);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    if (outline) {
      ctx.strokeStyle = "rgba(0,0,0,0.5)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawLegend(ctx: CanvasRenderingContext2D, halfRange: number) {
    const top = CIRCLE_CY + CIRCLE_R + 8;
    // 色阶条
    const barX = 12, barW = CANVAS_W - 24, barY = top, barH = 8;
    const grad = ctx.createLinearGradient(barX, 0, barX + barW, 0);
    for (let i = 0; i <= 10; i++) {
      const v = i / 10;
      const [r, g, b] = radarColor(Math.max(v, ECHO_MIN_V + 0.001));
      grad.addColorStop(v, `rgb(${r | 0},${g | 0},${b | 0})`);
    }
    ctx.fillStyle = grad;
    ctx.fillRect(barX, barY, barW, barH);
    ctx.fillStyle = "rgba(154,151,143,0.9)";
    ctx.font = "9px system-ui, sans-serif";
    ctx.fillText("弱", barX, barY + barH + 2);
    ctx.fillText("超强", barX + barW - 20, barY + barH + 2);

    // 比例尺
    const scaleKm = halfRange >= 400 ? 200 : halfRange >= 100 ? 50 : 10;
    const scalePx = (scaleKm / halfRange) * CIRCLE_R;
    const sy = barY + barH + 16;
    ctx.strokeStyle = "rgba(232,230,225,0.85)";
    ctx.beginPath();
    ctx.moveTo(barX, sy);
    ctx.lineTo(barX + scalePx, sy);
    ctx.moveTo(barX, sy - 3);
    ctx.lineTo(barX, sy + 3);
    ctx.moveTo(barX + scalePx, sy - 3);
    ctx.lineTo(barX + scalePx, sy + 3);
    ctx.stroke();
    ctx.fillStyle = "rgba(232,230,225,0.85)";
    ctx.fillText(`${scaleKm} km`, barX + scalePx + 6, sy - 5);

    // 图例
    const items: [string, string][] = [
      [COLOR_PLANE, "本机"],
      ["rgba(120,200,255,0.9)", "轨迹"],
      [ACCENT, "航线"],
      [COLOR_TRAFFIC, "交通"],
      [COLOR_WONDER, "奇观"],
    ];
    let lx = barX;
    const ly = sy + 12;
    ctx.font = "9px system-ui, sans-serif";
    for (const [color, name] of items) {
      ctx.fillStyle = color;
      ctx.fillRect(lx, ly, 7, 7);
      ctx.fillStyle = "rgba(232,230,225,0.85)";
      ctx.fillText(name, lx + 10, ly - 1);
      lx += 10 + name.length * 9 + 10;
    }
  }

  private roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
}
