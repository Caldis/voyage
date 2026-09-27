// T49 离线复现 / 回归：不开浏览器，按 main.ts 的调用方式（每帧 simDt = dt × 流速，拆成 ≤ 0.5 模拟秒的小步调 advanceFlight，
// 到达终点交给 director.relay()）模拟飞行，按**真实时间**记录航向 / 坡度曲线，列出连续转向 > 60° 的事件。
// 用法：node --import ./handoff/T49-resolve.mjs --experimental-transform-types handoff/T49-sim.mts [流速=60] [真实分钟=10] [预设=hnd-cts] [seed=1] [--csv 路径]
import * as THREE from "three";
import { advanceFlight, greatCircleBearing, PRESETS } from "../src/flight.ts";
import { Director, type DirectorHost } from "../src/director.ts";
import type { VoyageState } from "../src/state.ts";
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const rate = Number(args[0] ?? 60);
const realMin = Number(args[1] ?? 10);
const presetId = args[2] ?? "hnd-cts";
let seed = Number(args[3] ?? 1);
const csvIdx = process.argv.indexOf("--csv");
const csvPath = csvIdx > 0 ? process.argv[csvIdx + 1] : null;

// 可复现的随机数（pickNextLeg、makeLeg 用 Math.random）
Math.random = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};

export function runSim(opts: { rate: number; realMin: number; presetId: string; fps?: number; setup?: (d: Director, s: VoyageState) => void; perFrame?: (t: number, d: Director, s: VoyageState) => void; cloudCover?: (t: number) => number }) {
  const preset = PRESETS.find((p) => p.id === opts.presetId)!;
  const state = {
    preset,
    simTime: Date.parse("2026-09-27T03:00:00Z"),
    playRate: 0,
    seat: "right",
    altitudeKm: 10,
    targetAltKm: 10,
    heading: preset.dest ? greatCircleBearing(preset.lat, preset.lon, preset.dest[0], preset.dest[1]) : preset.heading,
    bankDeg: 0,
    pitchDeg: 2.5,
    rollDeg: 0,
    floor: { km: 0.5, known: true, groundKm: 0, reason: "sea" },
  } as unknown as VoyageState;
  // 本地坐标：以原点经纬度为中心的简化投影（x 东、z 南，km），换原点时挪到飞机正下方
  let lat0 = preset.lat, lon0 = preset.lon;
  const off = new THREE.Vector2();
  const KM = 111.195;
  const toGeo = (x: number, z: number): [number, number] => {
    const lat = lat0 - z / KM;
    return [lat, lon0 + x / (KM * Math.cos(lat * Math.PI / 180))];
  };
  let tReal = 0;
  const host = {
    state,
    geo: () => toGeo(off.x, off.y),
    offsetKm: () => off.length(),
    rebase: () => {
      [lat0, lon0] = toGeo(off.x, off.y);
      off.set(0, 0);
    },
    cloudDensity: () => opts.cloudCover?.(tReal) ?? 0,
    sunAltDeg: () => 30,
    setCabinLight: () => {},
    weather: {} as never,
    cloudParams: () => ({}) as never,
    setCloudParams: () => {},
    toLocal: () => [0, 0],
    localPos: () => [off.x, off.y],
    landBelow: () => null,
  } as unknown as DirectorHost;
  const director = new Director(host);
  director.onPresetChanged();
  // 连续航程开着（流速才生效）；天气驱动在离线模拟里不跑
  (director.weather as unknown as { update: () => void }).update = () => {};
  director.active = true;
  director.rate = opts.rate;
  opts.setup?.(director, state);
  const fps = opts.fps ?? 60;
  const dt = 1 / fps;
  const rows: { t: number; heading: number; bank: number; lat: number; lon: number; leg: string }[] = [];
  const frames = Math.round(opts.realMin * 60 * fps);
  for (let f = 0; f < frames; f++) {
    tReal = f * dt;
    opts.perFrame?.(tReal, director, state);
    const simDt = director.simDt(dt);
    state.simTime += simDt * 1000;
    const n = Math.max(1, Math.ceil(simDt / 0.5));
    let speed = 0;
    for (let i = 0; i < n; i++) {
      const [lat, lon] = toGeo(off.x, off.y);
      const r = advanceFlight(state, { dt: simDt / n, curLat: lat, curLon: lon, cloudOffset: off, onReachDest: () => director.relay() });
      speed = r.speedKms;
    }
    director.update(dt, simDt, speed);
    const [lat, lon] = toGeo(off.x, off.y);
    rows.push({ t: tReal, heading: state.heading, bank: state.bankDeg, lat, lon, leg: director.leg ? `${director.leg.from.code}-${director.leg.to.code}` : "" });
  }
  return { rows, director, state };
}

/** 连续转向事件：航向朝同一方向持续变化（> 0.3°/模拟秒，或 > 1°/真实秒）累计超过 minDeg 的一段 */
export function turnEvents(rows: { t: number; heading: number; bank: number; leg: string }[], minDeg = 60, rate = 1) {
  const ev: { t0: number; t1: number; deg: number; peakBank: number; maxBankRateReal: number; maxYawRateReal: number; leg: string }[] = [];
  let cur: (typeof ev)[number] | null = null;
  let dir = 0;
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1], b = rows[i];
    const dtr = b.t - a.t;
    const dh = ((b.heading - a.heading + 540) % 360) - 180;
    const yaw = dh / dtr;
    const bankRate = Math.abs(b.bank - a.bank) / dtr;
    const s = Math.abs(yaw) > Math.min(0.3 * rate, 1) ? Math.sign(yaw) : 0; // 0.3°/模拟秒或 1°/真实秒：比大圆航向的自然漂移大一个量级
    if (s !== 0 && s === dir && cur) {
      cur.t1 = b.t;
      cur.deg += dh;
      cur.peakBank = Math.max(cur.peakBank, Math.abs(b.bank));
      cur.maxBankRateReal = Math.max(cur.maxBankRateReal, bankRate);
      cur.maxYawRateReal = Math.max(cur.maxYawRateReal, Math.abs(yaw));
    } else {
      if (cur && Math.abs(cur.deg) >= minDeg) ev.push(cur);
      cur = s !== 0 ? { t0: a.t, t1: b.t, deg: dh, peakBank: Math.abs(b.bank), maxBankRateReal: bankRate, maxYawRateReal: Math.abs(yaw), leg: b.leg } : null;
      dir = s;
    }
  }
  if (cur && Math.abs(cur.deg) >= minDeg) ev.push(cur);
  return ev;
}

/** 整段的最大真实滚转速率（°/真实秒） */
export function maxBankRate(rows: { t: number; bank: number }[]) {
  let m = 0;
  for (let i = 1; i < rows.length; i++) m = Math.max(m, Math.abs(rows[i].bank - rows[i - 1].bank) / (rows[i].t - rows[i - 1].t));
  return m;
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}` || process.argv[1].endsWith("T49-sim.mts")) {
  const { rows, director } = runSim({ rate, realMin, presetId });
  const ev = turnEvents(rows, 60, rate);
  console.log(`流速 ${rate}×，真实 ${realMin} 分钟，预设 ${presetId}`);
  console.log("航段：", director.telemetry.legs.map((l) => `${l.from}-${l.to}`).join(" → "));
  console.log(`整段最大真实滚转速率 ${maxBankRate(rows).toFixed(2)}°/s，最大坡度 ${Math.max(...rows.map((r) => Math.abs(r.bank))).toFixed(1)}°`);
  console.log("遮挡切换：", director.telemetry.switches.map((w) => `${w.id}/${w.how}`).join(" ") || "无");
  console.log("连续转向 > 60° 的事件（真实时间）：");
  for (const e of ev)
    console.log(
      `  t=${e.t0.toFixed(1)}–${e.t1.toFixed(1)} s（${(e.t1 - e.t0).toFixed(1)} s）${e.leg}：转 ${e.deg.toFixed(0)}°，峰值坡度 ${e.peakBank.toFixed(1)}°，最大滚转速率 ${e.maxBankRateReal.toFixed(1)}°/s，最大航向变化率 ${e.maxYawRateReal.toFixed(1)}°/s`,
    );
  if (csvPath) writeFileSync(csvPath, "t,heading,bank,leg\n" + rows.filter((_, i) => i % 6 === 0).map((r) => `${r.t.toFixed(2)},${r.heading.toFixed(2)},${r.bank.toFixed(2)},${r.leg}`).join("\n"));
}
