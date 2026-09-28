// SPEC-FUJI：找天气场里富士山有笠云 / 吊し雲的时刻（给连续航程的实机验证挑日期）
// 用法：node --experimental-transform-types --no-warnings handoff/SPEC-FUJI-find.mts [年=2026] [月=5]
import { WeatherField } from "../src/weather.ts";

const y = Number(process.argv[2] ?? 2026), m = Number(process.argv[3] ?? 5);
const f = new WeatherField();
const H = 3.6e6;
for (let t = Date.UTC(y, m - 1, 1); t < Date.UTC(y, m, 1); t += H) {
  const o = f.orographic(t);
  if (o.cap > 0.5 || o.chain > 0.5) {
    const d = new Date(t + 9 * H);
    console.log(`${d.toISOString().slice(0, 13)}（JST）cap ${o.cap.toFixed(2)} chain ${o.chain.toFixed(2)} 风 ${o.fromDeg.toFixed(0)}° ${o.speed.toFixed(1)} m/s λ ${o.wavelengthKm.toFixed(1)} km 湿 ${o.moist.toFixed(2)} 稳 ${o.stable.toFixed(2)}`);
  }
}
