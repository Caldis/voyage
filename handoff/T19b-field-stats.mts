// T19b 天气场离线统计：沿一串东亚城市对（大圆、850 km/h）飞 N 小时，每 5 分钟取样一次，
// 打印云型时间线、附近雷暴系统数、最近台风距离。不开浏览器，调场的倾向 / 频率用。
// 用法：node --experimental-transform-types handoff/T19b-field-stats.mts [小时=30] [起始 ISO 时间] [seed]
import { WeatherField, REGIME_NAMES, coarseLand } from "../src/weather.ts";

const hours = Number(process.argv[2] ?? 30);
const t0 = Date.parse(process.argv[3] ?? "2026-09-27T06:30:00Z");
const field = new WeatherField(process.argv[4] ? Number(process.argv[4]) : undefined);
// 羽田 → 新千岁 → 台北 → 香港 → 上海 → 广州 → 首尔 → 马尼拉 → 羽田（与 routes.ts 的机场同坐标量级）
const pts: [number, number, string][] = [
  [35.55, 139.78, "HND"], [42.77, 141.69, "CTS"], [25.08, 121.23, "TPE"], [22.31, 113.91, "HKG"], [31.14, 121.81, "PVG"],
  [23.39, 113.3, "CAN"], [37.46, 126.44, "ICN"], [14.51, 121.02, "MNL"], [35.55, 139.78, "HND"], [42.77, 141.69, "CTS"], [25.08, 121.23, "TPE"],
];
const D2R = Math.PI / 180;
function lerpGc(a: [number, number], b: [number, number], f: number): [number, number] {
  const [la1, lo1] = [a[0] * D2R, a[1] * D2R], [la2, lo2] = [b[0] * D2R, b[1] * D2R];
  const v = (la: number, lo: number) => [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
  const p = v(la1, lo1), q = v(la2, lo2);
  const d = Math.acos(Math.min(1, p[0] * q[0] + p[1] * q[1] + p[2] * q[2]));
  const s1 = Math.sin((1 - f) * d) / Math.sin(d), s2 = Math.sin(f * d) / Math.sin(d);
  const r = [p[0] * s1 + q[0] * s2, p[1] * s1 + q[1] * s2, p[2] * s1 + q[2] * s2];
  return [Math.atan2(r[2], Math.hypot(r[0], r[1])) / D2R, Math.atan2(r[1], r[0]) / D2R];
}
const gcKm = (a: [number, number], b: [number, number]) => {
  const x = Math.sin(((b[0] - a[0]) * D2R) / 2) ** 2 + Math.cos(a[0] * D2R) * Math.cos(b[0] * D2R) * Math.sin(((b[1] - a[1]) * D2R) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(x));
};
let leg = 0, legKm = 0;
const counts: Record<string, number> = {};
let last = "";
let switches = 0;
let stormSamples = 0, tySamples = 0;
const seenStorms = new Set<string>();
for (let m = 0; m <= hours * 60; m += 5) {
  const t = t0 + m * 60e3;
  // 推进位置
  let [a, b] = [pts[leg], pts[leg + 1]];
  let dist = gcKm([a[0], a[1]], [b[0], b[1]]);
  while (legKm > dist && leg < pts.length - 2) {
    legKm -= dist;
    leg++;
    [a, b] = [pts[leg], pts[leg + 1]];
    dist = gcKm([a[0], a[1]], [b[0], b[1]]);
  }
  const [lat, lon] = lerpGc([a[0], a[1]], [b[0], b[1]], Math.min(1, legKm / dist));
  legKm += (850 * 5) / 60;
  const s = field.sample(lat, lon, t);
  counts[s.regime] = (counts[s.regime] ?? 0) + 1;
  const storms = field.stormsNear(lat, lon, t, 300);
  storms.forEach((x) => seenStorms.add(x.id));
  if (storms.length) stormSamples++;
  const ty = field.typhoonNear(lat, lon, t, 900);
  if (ty) tySamples++;
  const tag = s.regime;
  if (tag !== last) {
    if (last) switches++;
    const local = new Date(t + 9 * 3.6e6).toISOString().slice(11, 16);
    console.log(
      `${(m / 60).toFixed(2).padStart(6)} h  JST ${local}  ${a[2]}→${b[2]}  (${lat.toFixed(1)}, ${lon.toFixed(1)}) ${coarseLand(lat, lon) ? "陆" : "海"}  ${REGIME_NAMES[s.regime]}  云量 ${s.coverage.toFixed(2)} 顶 ${s.top.toFixed(1)}  对流 ${s.convection.toFixed(2)} 锋 ${s.front.toFixed(2)}  雷暴系统 ${storms.length}${ty ? `  台风 ${Math.round(gcKm([lat, lon], [ty.lat, ty.lon]))} km` : ""}`,
    );
    last = tag;
  }
}
const n = Object.values(counts).reduce((a, b) => a + b, 0);
console.log("\n云型占比：", Object.fromEntries(Object.entries(counts).map(([k, v]) => [REGIME_NAMES[k as keyof typeof REGIME_NAMES], `${Math.round((v / n) * 100)}%`])));
console.log(`云型切换 ${switches} 次 / ${hours} h；300 km 内有雷暴系统的时间 ${Math.round((stormSamples / n) * 100)}%，遇到的系统 ${seenStorms.size} 个；900 km 内有台风的时间 ${Math.round((tySamples / n) * 100)}%`);
