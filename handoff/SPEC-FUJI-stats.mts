// SPEC-FUJI：富士山笠云 / 吊し雲的出现统计（天气场 WeatherField.orographic）。
// 用法（apps/voyage 下）：node --experimental-transform-types --no-warnings handoff/SPEC-FUJI-stats.mts [年数=4] [种子,…]
// 输出：按月 / 按当地时刻的出现比例（cap > 0.5、chain > 0.5 的逐时比例），各因子中位，风速 / 风向分布。
// 对照：河口湖测候所 1933–52 年，笠云月平均 6.1 回、吊し雲 2.0 回（每天两次观测，约 60 次 / 月 → 约 10% / 3%）
import { WeatherField } from "../src/weather.ts";

const years = Number(process.argv[2] ?? 4);
const seeds = (process.argv[3] ?? "20260927,1,777").split(",").map(Number);
const H = 3.6e6;
const pct = (a: number, n: number) => ((100 * a) / Math.max(n, 1)).toFixed(1).padStart(5);

for (const seed of seeds) {
  const f = new WeatherField(seed);
  const t0 = Date.UTC(2023, 0, 1);
  const n = years * 365 * 24;
  const byMonth = Array.from({ length: 12 }, () => ({ n: 0, cap: 0, chain: 0, fast: 0 }));
  const byHour = Array.from({ length: 24 }, () => ({ n: 0, cap: 0 }));
  let cap = 0, chain = 0, both = 0, eps = 0, prev = false;
  const dirHist = new Array(8).fill(0);
  const speeds: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = t0 + i * H;
    const o = f.orographic(t);
    const m = new Date(t).getUTCMonth();
    const hl = (new Date(t).getUTCHours() + 9) % 24;
    const c = o.cap > 0.5, ch = o.chain > 0.5;
    byMonth[m].n++;
    byHour[hl].n++;
    if (c) (cap++, byMonth[m].cap++, byHour[hl].cap++, dirHist[Math.floor(((o.fromDeg + 22.5) % 360) / 45)]++);
    if (ch) (chain++, byMonth[m].chain++);
    if (c && ch) both++;
    if (o.speed >= 15) byMonth[m].fast++;
    if (c && !prev) eps++;
    prev = c;
    if (i % 7 === 0) speeds.push(o.speed);
  }
  speeds.sort((a, b) => a - b);
  console.log(`\n== 种子 ${seed}，${years} 年逐时 ==`);
  console.log(`笠云 ${pct(cap, n)}%  吊し雲 ${pct(chain, n)}%  两者同时 ${pct(both, n)}%  笠云过程 ${(eps / years / 12).toFixed(1)} 次/月、平均 ${(cap / Math.max(eps, 1)).toFixed(1)} h`);
  console.log(`山顶风速 中位 ${speeds[speeds.length >> 1].toFixed(1)} m/s、p90 ${speeds[Math.floor(speeds.length * 0.9)].toFixed(1)}`);
  console.log("月份  笠云%  吊し%  风≥15%");
  byMonth.forEach((b, i) => console.log(`${String(i + 1).padStart(2)}   ${pct(b.cap, b.n)}  ${pct(b.chain, b.n)}  ${pct(b.fast, b.n)}`));
  console.log("当地时刻（笠云%）：" + byHour.map((b, h) => `${h}:${pct(b.cap, b.n).trim()}`).join(" "));
  console.log("笠云时的风向（来向，N NE E SE S SW W NW）：" + dirHist.map((d) => pct(d, cap).trim()).join(" "));
}
