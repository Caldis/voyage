// W03：wpac（30°N 139.8°E，UTC+9）在给定日期各时刻的太阳高度 / 方位，挑场景时间用。
// 用法：node apps/voyage/handoff/W03-sun.mjs [2026-09-27] [开始时 结束时 步长分钟]
import * as A from "astronomy-engine";
const date = process.argv[2] ?? "2026-09-27";
const h0 = +(process.argv[3] ?? 6), h1 = +(process.argv[4] ?? 19), step = +(process.argv[5] ?? 30);
const obs = new A.Observer(30.0, 139.8, 10700);
for (let m = h0 * 60; m <= h1 * 60; m += step) {
  const t = new Date(`${date}T00:00:00+09:00`);
  t.setMinutes(t.getMinutes() + m);
  const eq = A.Equator(A.Body.Sun, t, obs, true, true);
  const hor = A.Horizon(t, obs, eq.ra, eq.dec, "normal");
  console.log(`${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}  time=${m}  高度 ${hor.altitude.toFixed(1)}°  方位 ${hor.azimuth.toFixed(0)}°`);
}
