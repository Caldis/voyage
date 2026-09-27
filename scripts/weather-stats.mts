// 天气场气候态统计 + 断言（WX10，收编自 research/METEOROLOGY.md 附录 A 的 meteo-stats / meteo-ty）
//
// 不开浏览器、不占 GPU，几秒跑完。对 WeatherField 在「月份 × 地区 × 时段」上取样，统计云型频率、15 时雷暴、
// 锋面带位置与活跃度、台风年频数 / 月份分布，并对照目标区间做断言：任何一条不满足，退出码非 0。
//
// 用法（在 apps/voyage 下）：
//   node --experimental-transform-types --no-warnings scripts/weather-stats.mts [--seed N] [--years 2023,2024,2025,2026] [--json 输出.json] [--quiet]
//
// 取样口径（与附录 A 相同）：每个地区 3 个点；每月 1–28 日 × UTC 每 3 小时；当地时 ≈ UTC + 经度 / 15。
// 雷暴：当地 15 时，150 km 内 stormsNear 非空的比例。锋面：每天 UTC 0 / 12 时、110–145°E 每 5°，扫 10–50°N 找 front().strength 最大处，
// 最大值 ≥ 0.5 记「活跃」。台风：每 6 小时列一次 activeTyphoons，按 id 去重，月份记首次出现的月份。
//
// 目标区间的出处写在每条断言的 src 里：
//   [JMA台风] 气象厅台风平年值（1991–2020）https://www.data.jma.go.jp/typhoon/statistics/average/average.html
//   [JMA梅雨] 气象厅梅雨入り・明け平年值（1991–2020）https://www.data.jma.go.jp/cpd/baiu/sokuhou_baiu.html
//   [CMA梅雨] 国家气候中心：长江中下游常年 6 月 14 日入梅、7 月 16 日前后出梅（中国气象局 2024-06-20 新闻稿）
//   [CMA七下八上] 华北雨季集中在 7 月下旬到 8 月上旬（中国气象局科普口径）
//   [K&H93] Klein & Hartmann (1993) J. Climate 6:1587：中国东部冷季层状云，10–3 月多、7 月最少
//   [估算] 按气候常识定的量级区间，不是测量
import { WeatherField, type CloudRegime } from "../src/weather.ts";

const args = process.argv.slice(2);
const opt = (k: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
const seed = opt("--seed") ? Number(opt("--seed")) : undefined;
const years = (opt("--years") ?? "2023,2024,2025,2026").split(",").map(Number);
const quiet = args.includes("--quiet");
const field = new WeatherField(seed);
const H = 3.6e6;

// ---------- 地区（每个 3 点，(纬度, 经度)） ----------
const REGIONS: Record<string, [number, number][]> = {
  日本海: [[39, 134], [40.5, 136.5], [38, 132]],
  北海道西: [[43.1, 141.4], [43.8, 141.7], [43.5, 141.9]],
  关东: [[35.8, 139.6], [36.1, 140.1], [35.5, 139.3]],
  长江: [[30.6, 114.3], [31.5, 117.3], [30.9, 119.8]],
  华北: [[36.5, 115.5], [38.5, 116], [35.5, 117]],
  华南: [[23.1, 113.3], [24.3, 110.3], [24, 114.5]],
  冲绳东: [[25.5, 128.5], [24.5, 127.5], [26.5, 130]],
  副高: [[28.5, 138], [29.5, 142], [27.5, 145]],
};

type Tally = { n: number; reg: Record<CloudRegime, number>; storm: number; stormN: number };
const empty = (): Tally => ({ n: 0, reg: { clear: 0, cumulus: 0, towering: 0, stratocumulus: 0, altocumulus: 0, cirrus: 0 }, storm: 0, stormN: 0 });

/** 统计一个地区在某月 [d0, d1] 日的云型频率与 15 时雷暴 */
function regionStats(name: string, month: number, d0 = 1, d1 = 28): Tally {
  const tl = empty();
  for (const y of years)
    for (let d = d0; d <= d1; d++) {
      const day0 = Date.UTC(y, month - 1, d);
      for (const [lat, lon] of REGIONS[name]) {
        for (let h = 0; h < 24; h += 3) {
          const s = field.sample(lat, lon, day0 + h * H);
          tl.n++;
          tl.reg[s.regime]++;
        }
        // 当地 15 时
        const t15 = day0 + (15 - lon / 15) * H;
        tl.stormN++;
        if (field.stormsNear(lat, lon, t15, 150).length) tl.storm++;
      }
    }
  return tl;
}
const pct = (a: number, n: number) => (n ? (100 * a) / n : 0);
const cuFam = (t: Tally) => pct(t.reg.cumulus + t.reg.towering, t.n);

/** 锋面：某月 [d0, d1] 日的活跃比例、活跃时的平均中心纬度、30–34°N 活跃比例 */
function frontStats(month: number, d0 = 1, d1 = 28) {
  let n = 0, act = 0, latSum = 0, band = 0;
  for (const y of years)
    for (let d = d0; d <= d1; d++)
      for (const h of [0, 12]) {
        const t = Date.UTC(y, month - 1, d) + h * H;
        for (let lon = 110; lon <= 145; lon += 5) {
          let m = 0, mLat = 0, mBand = 0;
          for (let lat = 10; lat <= 50; lat += 0.25) {
            const s = field.front(lat, lon, t).strength;
            if (s > m) (m = s), (mLat = lat);
            if (lat >= 30 && lat <= 34) mBand = Math.max(mBand, s);
          }
          n++;
          if (m >= 0.5) act++, (latSum += mLat);
          if (mBand >= 0.5) band++;
        }
      }
  return { active: pct(act, n), center: act ? latSum / act : NaN, band3034: pct(band, n) };
}

/** 台风：每年个数、按首次出现月份的分布；7–9 月离几个城市 600 km 内的时间比例 */
function typhoonStats() {
  const perYear: number[] = [];
  const perMonth = new Array(12).fill(0);
  const cities: Record<string, [number, number]> = { 台北: [25.03, 121.5], 冲绳: [26.2, 127.7], 香港: [22.3, 114.2], 浦东: [31.15, 121.8], 羽田: [35.55, 139.78], 马尼拉: [14.6, 121] };
  const near: Record<string, number> = Object.fromEntries(Object.keys(cities).map((c) => [c, 0]));
  let nearN = 0;
  let maxLat = -90, minLon = 999, maxLon = -999;
  for (const y of years) {
    const seen = new Set<string>();
    const t0 = Date.UTC(y, 0, 1), t1 = Date.UTC(y + 1, 0, 1);
    for (let t = t0; t < t1; t += 6 * H) {
      const list = field.activeTyphoons(t);
      const mon = new Date(t).getUTCMonth();
      for (const ty of list) {
        maxLat = Math.max(maxLat, ty.lat);
        minLon = Math.min(minLon, ty.lon);
        maxLon = Math.max(maxLon, ty.lon);
        if (seen.has(ty.id)) continue;
        seen.add(ty.id);
        perMonth[mon]++;
      }
      if (mon >= 6 && mon <= 8) {
        nearN++;
        for (const [c, [la, lo]] of Object.entries(cities)) if (list.some((ty) => gc(la, lo, ty.lat, ty.lon) < 600)) near[c]++;
      }
    }
    // 跨年：上一年年末生成、跨进今年的不算今年（按首次出现去重已处理）
    perYear.push(seen.size);
  }
  return {
    perYear,
    mean: perYear.reduce((a, b) => a + b, 0) / perYear.length,
    perMonth: perMonth.map((v) => v / years.length),
    near: Object.fromEntries(Object.entries(near).map(([c, v]) => [c, pct(v, nearN)])),
    extent: { maxLat, minLon, maxLon },
  };
}
function gc(a1: number, o1: number, a2: number, o2: number) {
  const r = Math.PI / 180;
  const a = Math.sin(((a2 - a1) * r) / 2) ** 2 + Math.cos(a1 * r) * Math.cos(a2 * r) * Math.sin(((o2 - o1) * r) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
}

// ---------- 统计 ----------
const t0 = performance.now();
const MONTHS = [1, 2, 4, 5, 6, 7, 8, 10];
const table: Record<string, Record<number, Tally>> = {};
for (const r of Object.keys(REGIONS)) {
  table[r] = {};
  for (const m of MONTHS) table[r][m] = regionStats(r, m);
}
const hbRainy = regionStats("华北", 7, 16, 31); // 七下（8 月上旬另算）
const hbRainy2 = regionStats("华北", 8, 1, 10);
const hbRainyClear = pct(hbRainy.reg.clear + hbRainy2.reg.clear, hbRainy.n + hbRainy2.n);
const frontM: Record<string, ReturnType<typeof frontStats>> = {};
for (const m of [1, 3, 4, 5, 6, 7, 8, 9, 10, 11]) frontM[`${m}月`] = frontStats(m);
frontM["6月15-28日"] = frontStats(6, 15, 28);
frontM["7月1-14日"] = frontStats(7, 1, 14);
frontM["7月20-31日"] = frontStats(7, 20, 31);
frontM["8月1-10日"] = frontStats(8, 1, 10);
const ty = typhoonStats();
const elapsed = (performance.now() - t0) / 1000;

// ---------- 输出 ----------
const f0 = (v: number) => v.toFixed(0).padStart(3);
if (!quiet) {
  console.log(`# 天气场气候态统计（seed ${field.seed}，年份 ${years.join("/")}，${elapsed.toFixed(1)} s）\n`);
  console.log("## 云型频率 %（晴 / 积云族 / 层积 / 高积 / 卷云 · 15 时雷暴）\n");
  console.log(`| 地区 | ${MONTHS.map((m) => `${m} 月`).join(" | ")} |`);
  console.log(`| --- | ${MONTHS.map(() => "---").join(" | ")} |`);
  for (const r of Object.keys(REGIONS)) {
    const cells = MONTHS.map((m) => {
      const t = table[r][m];
      return `${f0(pct(t.reg.clear, t.n))}/${f0(cuFam(t))}/${f0(pct(t.reg.stratocumulus, t.n))}/${f0(pct(t.reg.altocumulus, t.n))}/${f0(pct(t.reg.cirrus, t.n))} · ${f0(pct(t.storm, t.stormN))}`.replace(/ +/g, "");
    });
    console.log(`| ${r} | ${cells.join(" | ")} |`);
  }
  console.log(`\n华北 7/16–8/10（七下八上）晴空 ${hbRainyClear.toFixed(0)}%\n`);
  console.log("## 锋面带（活跃 % / 活跃时中心纬度 / 30–34°N 活跃 %）\n");
  console.log("| 时段 | 活跃 | 中心 | 30–34°N |\n| --- | --- | --- | --- |");
  for (const [k, v] of Object.entries(frontM)) console.log(`| ${k} | ${v.active.toFixed(0)} | ${isNaN(v.center) ? "—" : v.center.toFixed(1)} | ${v.band3034.toFixed(0)} |`);
  console.log(`\n## 台风\n\n每年：${ty.perYear.join(" / ")}（平均 ${ty.mean.toFixed(1)}；气象厅平年值 25.1）`);
  console.log(`按月（首次出现，年均）：${ty.perMonth.map((v, i) => `${i + 1}月 ${v.toFixed(1)}`).join("，")}`);
  console.log(`平年值：1–12 月 0.3 0.3 0.3 0.6 1.0 1.7 3.7 5.7 5.0 3.4 2.2 1.0`);
  console.log(`7–9 月 600 km 内有台风的时间比例：${Object.entries(ty.near).map(([c, v]) => `${c} ${v.toFixed(1)}%`).join("，")}`);
  console.log(`活动范围：最北 ${ty.extent.maxLat.toFixed(1)}°N，经度 ${ty.extent.minLon.toFixed(1)}–${ty.extent.maxLon.toFixed(1)}°E\n`);
}

// ---------- 断言 ----------
type Check = { name: string; value: number; ok: boolean; target: string; src: string };
const checks: Check[] = [];
const check = (name: string, value: number, ok: boolean, target: string, src: string) => checks.push({ name, value, ok, target, src });
const T = (r: string, m: number) => table[r][m];
const clr = (r: string, m: number) => pct(T(r, m).reg.clear, T(r, m).n);
const sc = (r: string, m: number) => pct(T(r, m).reg.stratocumulus, T(r, m).n);
const thu = (r: string, m: number) => pct(T(r, m).storm, T(r, m).stormN);

check("日本海 1 月晴空 %", clr("日本海", 1), clr("日本海", 1) <= 25, "≤ 25", "W10 目标；冬季风寒潮雪云街 [气象厅解说、教科书]");
check("日本海 1 月积云族 %", cuFam(T("日本海", 1)), cuFam(T("日本海", 1)) >= 40, "≥ 40", "寒潮开放单体 / 云街是积状云 [教科书；比例为估算]");
check("北海道西 1 月晴空 %", clr("北海道西", 1), clr("北海道西", 1) <= 35, "≤ 35", "日本海一侧冬季阴雪 [气象厅解说；估算]");
check("关东 1 月晴空 %", clr("关东", 1), clr("关东", 1) >= 50, "≥ 50", "冬季太平洋一侧晴（焚风）[气象厅解说；估算]");
check("日本海 7 月晴空 %", clr("日本海", 7), clr("日本海", 7) >= 25, "≥ 25（夏季比冬季少云）", "[估算]");
check("长江 1 月层积云 %", sc("长江", 1), sc("长江", 1) >= 40, "≥ 40", "[K&H93]；W10 目标");
check("长江 1 月层积云 %（上限）", sc("长江", 1), sc("长江", 1) <= 75, "≤ 75", "冬季上海 / 武汉日照率约三成，仍有晴天 [估算]，防止校准过头");
check("长江 10 月层积云 %（上限）", sc("长江", 10), sc("长江", 10) <= 70, "≤ 70", "长江下游秋季多晴 [估算]；K&H93 的 10 月峰主要在西段");
check("关东 8 月晴空 %（上限）", clr("关东", 8), clr("关东", 8) <= 80, "≤ 80", "副高下仍有午后积云 / 雷阵雨 [估算]");
check("长江 层积云 2 月 − 7 月（百分点）", sc("长江", 2) - sc("长江", 7), sc("长江", 2) - sc("长江", 7) >= 20, "≥ 20", "[K&H93] 2 月峰、7 月最少；7 月的「层积云」多是梅雨锋云系（层积云族近似雨层云），不是 K&H 的低层云，门限放宽");
check("长江 层积云 10 月 − 7 月（百分点）", sc("长江", 10) - sc("长江", 7), sc("长江", 10) - sc("长江", 7) >= 25, "≥ 25", "[K&H93] 10 月峰");
check("长江 7 月 15 时雷暴 %", thu("长江", 7), thu("长江", 7) >= 20, "≥ 20", "盛夏午后雷暴 [估算]");
check("华北 七下八上 晴空 %", hbRainyClear, hbRainyClear <= 45, "≤ 45", "[CMA七下八上]");
check("华北 1 月晴空 %", clr("华北", 1), clr("华北", 1) >= 55, "≥ 55", "冬季干冷晴 [估算]");
check("华南 7 月 15 时雷暴 %", thu("华南", 7), thu("华南", 7) >= 30, "≥ 30", "华南盛夏午后雷暴 [估算]");
check("冲绳东 1 月 15 时雷暴 %", thu("冲绳东", 1), thu("冲绳东", 1) <= 3, "≤ 3", "W10 目标；冬季副热带洋面几乎无深对流");
check("冲绳东 7 月积云族 %", cuFam(T("冲绳东", 7)), cuFam(T("冲绳东", 7)) >= 50, "≥ 50", "副高 + 信风积云 [教科书]");
const shClearCu = pct(T("副高", 8).reg.clear + T("副高", 8).reg.cumulus, T("副高", 8).n);
check("副高 8 月 晴空 + 淡积云 %", shClearCu, shClearCu >= 70, "≥ 70", "副高下沉、晴空或信风积云 [教科书；估算]");
check("副高 8 月 15 时雷暴 %", thu("副高", 8), thu("副高", 8) <= 10, "≤ 10", "[估算]");
check("锋面 5 月中心 °N", frontM["5月"].center, frontM["5月"].center >= 22 && frontM["5月"].center <= 28, "22–28", "华南前汛期；沖縄梅雨 5/10–6/21 [JMA梅雨]");
check("锋面 6/15–28 中心 °N", frontM["6月15-28日"].center, frontM["6月15-28日"].center >= 29 && frontM["6月15-28日"].center <= 35, "29–35", "[CMA梅雨] 6/14–7/16；[JMA梅雨] 本州 6/7–7/19");
check("锋面 6/15–28 活跃 %", frontM["6月15-28日"].active, frontM["6月15-28日"].active >= 50, "≥ 50", "梅雨盛期 [CMA梅雨][JMA梅雨]；估算");
check("锋面 7/20–31 中心 °N", frontM["7月20-31日"].center, frontM["7月20-31日"].center >= 35, "≥ 35", "北跳：梅雨明け 7/19–7/28 [JMA梅雨]；[CMA七下八上]");
check("锋面 8 月 30–34°N 活跃 %", frontM["8月"].band3034, frontM["8月"].band3034 <= 20, "≤ 20", "W10 目标；梅雨 7 月中下旬结束");
check("锋面 9 月中心 °N", frontM["9月"].center, frontM["9月"].center >= 32 && frontM["9月"].center <= 38, "32–38", "秋雨前線（本州）[估算]");
check("台风 年均个数", ty.mean, ty.mean >= 22 && ty.mean <= 28, "22–28", "[JMA台风] 25.1");
const augMax = ty.perMonth.every((v, i) => i === 7 || v <= ty.perMonth[7]);
check("台风 8 月最多（1 = 是）", augMax ? 1 : 0, augMax, "1", "[JMA台风] 8 月 5.7 最多");
const janApr = ty.perMonth.slice(0, 4).reduce((a, b) => a + b, 0);
check("台风 1–4 月合计（年均）", janApr, janApr <= 3, "≤ 3", "[JMA台风] 1.5");
const julOct = ty.perMonth.slice(6, 10).reduce((a, b) => a + b, 0);
check("台风 7–10 月合计（年均）", julOct, julOct >= 14 && julOct <= 21, "14–21", "[JMA台风] 17.8");

const failed = checks.filter((c) => !c.ok);
console.log("## 断言\n\n| 项 | 值 | 目标 | 结果 | 依据 |\n| --- | --- | --- | --- | --- |");
for (const c of checks) console.log(`| ${c.name} | ${c.value.toFixed(1)} | ${c.target} | ${c.ok ? "通过" : "**失败**"} | ${c.src} |`);
console.log(`\n${checks.length - failed.length} / ${checks.length} 通过（${elapsed.toFixed(1)} s）`);

const jsonOut = opt("--json");
if (jsonOut) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(jsonOut, JSON.stringify({ seed: field.seed, years, table, frontM, ty, checks }, null, 1));
}
process.exit(failed.length ? 1 : 0);
