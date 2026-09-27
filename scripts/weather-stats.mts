// 天气场气候态统计 + 断言（WX10，收编自 research/METEOROLOGY.md 附录 A 的 meteo-stats / meteo-ty）
//
// 不开浏览器、不占 GPU。对 WeatherField 在「月份 × 地区 × 时段」上取样，统计云型频率、15 时雷暴、
// 锋面带位置与活跃度、台风年频数 / 月份分布，并对照目标区间做断言：任何一条不满足，退出码非 0。
//
// 用法（在 apps/voyage 下）：
//   node --experimental-transform-types --no-warnings scripts/weather-stats.mts --multi        ← 门禁（6 个种子全部通过才算过，约 1.5 分钟）
//   node --experimental-transform-types --no-warnings scripts/weather-stats.mts                ← 只跑默认种子，打印完整统计表
//   可选：--seed N | --seeds a,b,c | --multi；--years 2023,2024,2025,2026（区域 / 锋面统计的年份）；
//         --ty-years 100（台风统计的年数，截止 2026 年）；--only region,front,ty；--json 输出.json；--quiet（只打印断言）
//
// 取样口径（与附录 A 相同）：每个地区 3 个点；每月 1–28 日 × UTC 每 3 小时；当地时 ≈ UTC + 经度 / 15。
// 雷暴：当地 15 时，150 km 内 stormsNear 非空的比例。锋面：每天 UTC 0 / 12 时、110–145°E 每 5°，扫 10–50°N 找 front().strength 最大处，
// 最大值 ≥ 0.5 记「活跃」。台风：每 6 小时列一次 activeTyphoons，按 id 在整段时间里去重（跨年的只算在首次出现的那年那月），
// 默认 100 年样本——4 年样本的泊松噪声足以让「8 月最多」随种子翻转（WX10 审查：20 个种子里 7 个失败）。
//
// 为什么要多种子：每条断言都要对种子稳健。只按一个种子调通的门限，换种子就可能贴线翻转（审查实测：长江 10 月、2 月 − 7 月）。
//
// 目标区间的出处写在每条断言的 src 里：
//   [JMA台风] 气象厅台风平年值（1991–2020）https://www.data.jma.go.jp/typhoon/statistics/average/average.html
//   [JMA梅雨] 气象厅梅雨入り・明け平年值（1991–2020）https://www.data.jma.go.jp/cpd/baiu/sokuhou_baiu.html
//   [CMA梅雨] 国家气候中心：长江中下游常年 6 月 14 日入梅、7 月 16 日前后出梅（中国气象局 2024-06-20 新闻稿）
//   [CMA七下八上] 华北雨季集中在 7 月下旬到 8 月上旬（中国气象局科普口径）
//   [K&H93] Klein & Hartmann (1993) J. Climate 6:1587 摘要：中国东部是唯一在陆上的层云区，层云最多的季节 = 低层静力稳定度最大的季节（冷季）。
//           「2 月、10 月双峰」是研究报告对检索摘要的转述，摘要未载、全文未核，本脚本不拿它做断言
//   [上海日照] 上海徐家汇月日照时数 1 月 114.3 h、2 月 119.9 h、8 月 185.7 h、10 月 161.4 h（中国气象局 1981–2010，经维基百科「Shanghai」气候表转引）
//   [估算] 按气候常识定的量级区间，不是测量
import * as W from "../src/weather.ts";
import type { CloudRegime } from "../src/weather.ts";

const args = process.argv.slice(2);
const opt = (k: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
const MULTI_SEEDS = [20260927, 1, 5, 6, 777, 12345];
const seeds = args.includes("--multi") ? MULTI_SEEDS : opt("--seeds") ? opt("--seeds")!.split(",").map(Number) : [opt("--seed") ? Number(opt("--seed")) : 20260927];
const years = (opt("--years") ?? "2023,2024,2025,2026").split(",").map(Number);
const tyYears = Number(opt("--ty-years") ?? 100);
const only = new Set((opt("--only") ?? "region,front,ty").split(","));
const quiet = args.includes("--quiet") || seeds.length > 1;
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
const MONTHS = [1, 2, 4, 5, 6, 7, 8, 10];

type Tally = { n: number; reg: Record<CloudRegime, number>; storm: number; stormN: number };
const empty = (): Tally => ({ n: 0, reg: { clear: 0, cumulus: 0, towering: 0, stratocumulus: 0, altocumulus: 0, cirrus: 0 }, storm: 0, stormN: 0 });
const pct = (a: number, n: number) => (n ? (100 * a) / n : 0);
const cuFam = (t: Tally) => pct(t.reg.cumulus + t.reg.towering, t.n);
function gc(a1: number, o1: number, a2: number, o2: number) {
  const r = Math.PI / 180;
  const a = Math.sin(((a2 - a1) * r) / 2) ** 2 + Math.cos(a1 * r) * Math.cos(a2 * r) * Math.sin(((o2 - o1) * r) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
}

type Check = { name: string; value: number; ok: boolean; target: string; src: string };

function runSeed(seed: number) {
  const field = new W.WeatherField(seed);

  /** 一个地区在某月 [d0, d1] 日的云型频率与 15 时雷暴 */
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
          const t15 = day0 + (15 - lon / 15) * H;
          tl.stormN++;
          if (field.stormsNear(lat, lon, t15, 150).length) tl.storm++;
        }
      }
    return tl;
  }

  /** 锋面：某月 [d0, d1] 日的活跃比例、活跃时的平均中心纬度、指定纬带（默认 30–34°N）的活跃比例；lon 范围可选 */
  function frontStats(month: number, d0 = 1, d1 = 28, band: [number, number] = [30, 34], lons: [number, number] = [110, 145]) {
    let n = 0, act = 0, latSum = 0, inBand = 0;
    for (const y of years)
      for (let d = d0; d <= d1; d++)
        for (const h of [0, 12]) {
          const t = Date.UTC(y, month - 1, d) + h * H;
          for (let lon = lons[0]; lon <= lons[1]; lon += 5) {
            let m = 0, mLat = 0, mBand = 0;
            for (let lat = 10; lat <= 50; lat += 0.25) {
              const s = field.front(lat, lon, t).strength;
              if (s > m) (m = s), (mLat = lat);
              if (lat >= band[0] && lat <= band[1]) mBand = Math.max(mBand, s);
            }
            n++;
            if (m >= 0.5) act++, (latSum += mLat);
            if (mBand >= 0.5) inBand++;
          }
        }
    return { active: pct(act, n), center: act ? latSum / act : NaN, band: pct(inBand, n) };
  }

  /** 台风：tyYears 年样本，按 id 在整段时间里去重，月份按首次出现 */
  function typhoonStats() {
    const lastYear = 2026, firstYear = lastYear - tyYears + 1;
    const perMonth = new Array(12).fill(0);
    const perYear = new Map<number, number>();
    const cities: Record<string, [number, number]> = { 台北: [25.03, 121.5], 冲绳: [26.2, 127.7], 香港: [22.3, 114.2], 浦东: [31.15, 121.8], 羽田: [35.55, 139.78], 马尼拉: [14.6, 121] };
    const near: Record<string, number> = Object.fromEntries(Object.keys(cities).map((c) => [c, 0]));
    let nearN = 0;
    const seen = new Set<string>();
    const t0 = Date.UTC(firstYear, 0, 1), t1 = Date.UTC(lastYear + 1, 0, 1);
    // 从前一年 11 月开始扫，先把跨进第一年的台风登记为「已见」，不计数
    for (let t = Date.UTC(firstYear - 1, 10, 1); t < t1; t += 6 * H) {
      const list = field.activeTyphoons(t);
      const d = new Date(t);
      for (const ty of list) {
        if (seen.has(ty.id)) continue;
        seen.add(ty.id);
        if (t < t0) continue;
        perMonth[d.getUTCMonth()]++;
        perYear.set(d.getUTCFullYear(), (perYear.get(d.getUTCFullYear()) ?? 0) + 1);
      }
      const mon = d.getUTCMonth();
      if (t >= t0 && mon >= 6 && mon <= 8) {
        nearN++;
        for (const [c, [la, lo]] of Object.entries(cities)) if (list.some((ty) => gc(la, lo, ty.lat, ty.lon) < 600)) near[c]++;
      }
    }
    const counts = Array.from({ length: tyYears }, (_, i) => perYear.get(firstYear + i) ?? 0);
    return {
      years: tyYears,
      mean: counts.reduce((a, b) => a + b, 0) / tyYears,
      min: Math.min(...counts),
      max: Math.max(...counts),
      perMonth: perMonth.map((v) => v / tyYears),
      near: Object.fromEntries(Object.entries(near).map(([c, v]) => [c, pct(v, nearN)])),
    };
  }

  // ---------- 统计 ----------
  const t0 = performance.now();
  const table: Record<string, Record<number, Tally>> = {};
  let hbRainyClear = NaN;
  if (only.has("region")) {
    for (const r of Object.keys(REGIONS)) {
      table[r] = {};
      for (const m of MONTHS) table[r][m] = regionStats(r, m);
    }
    const a = regionStats("华北", 7, 16, 31), b = regionStats("华北", 8, 1, 10);
    hbRainyClear = pct(a.reg.clear + b.reg.clear, a.n + b.n);
  }
  const frontM: Record<string, ReturnType<typeof frontStats>> = {};
  let hbFront = NaN;
  if (only.has("front")) {
    for (const m of [1, 3, 4, 5, 6, 7, 8, 9, 10, 11]) frontM[`${m}月`] = frontStats(m);
    frontM["6月15-28日"] = frontStats(6, 15, 28);
    frontM["7月1-14日"] = frontStats(7, 1, 14);
    frontM["7月20-31日"] = frontStats(7, 20, 31);
    frontM["8月1-10日"] = frontStats(8, 1, 10);
    // 华北雨季：7/20–8/10、110–125°E，锋面落在 36–41°N 的比例
    const a = frontStats(7, 20, 31, [36, 41], [110, 125]), b = frontStats(8, 1, 10, [36, 41], [110, 125]);
    hbFront = (a.band * 12 + b.band * 10) / 22;
  }
  const ty = only.has("ty") ? typhoonStats() : null;
  const elapsed = (performance.now() - t0) / 1000;

  // ---------- 输出 ----------
  const f0 = (v: number) => v.toFixed(0);
  if (!quiet) {
    console.log(`# 天气场气候态统计（seed ${seed}，区域 / 锋面年份 ${years.join("/")}，台风 ${tyYears} 年，${elapsed.toFixed(1)} s）\n`);
    if (only.has("region")) {
      console.log("## 云型频率 %（晴 / 积云族 / 层积 / 高积 / 卷云 · 15 时雷暴）\n");
      console.log(`| 地区 | ${MONTHS.map((m) => `${m} 月`).join(" | ")} |`);
      console.log(`| --- | ${MONTHS.map(() => "---").join(" | ")} |`);
      for (const r of Object.keys(REGIONS)) {
        const cells = MONTHS.map((m) => {
          const t = table[r][m];
          return `${f0(pct(t.reg.clear, t.n))}/${f0(cuFam(t))}/${f0(pct(t.reg.stratocumulus, t.n))}/${f0(pct(t.reg.altocumulus, t.n))}/${f0(pct(t.reg.cirrus, t.n))}·${f0(pct(t.storm, t.stormN))}`;
        });
        console.log(`| ${r} | ${cells.join(" | ")} |`);
      }
      console.log(`\n华北 7/16–8/10（七下八上）晴空 ${hbRainyClear.toFixed(0)}%\n`);
    }
    if (only.has("front")) {
      console.log("## 锋面带（活跃 % / 活跃时中心纬度 / 30–34°N 活跃 %）\n");
      console.log("| 时段 | 活跃 | 中心 | 30–34°N |\n| --- | --- | --- | --- |");
      for (const [k, v] of Object.entries(frontM)) console.log(`| ${k} | ${v.active.toFixed(0)} | ${isNaN(v.center) ? "—" : v.center.toFixed(1)} | ${v.band.toFixed(0)} |`);
      console.log(`\n华北雨季（7/20–8/10、110–125°E）锋面在 36–41°N 的比例：${hbFront.toFixed(0)}%\n`);
    }
    if (ty) {
      console.log(`## 台风（${ty.years} 年）\n\n年均 ${ty.mean.toFixed(1)}（最少 ${ty.min}、最多 ${ty.max}；气象厅平年值 25.1）`);
      console.log(`按月（首次出现，年均）：${ty.perMonth.map((v, i) => `${i + 1}月 ${v.toFixed(2)}`).join("，")}`);
      console.log(`平年值：1–12 月 0.3 0.3 0.3 0.6 1.0 1.7 3.7 5.7 5.0 3.4 2.2 1.0`);
      console.log(`7–9 月 600 km 内有台风的时间比例：${Object.entries(ty.near).map(([c, v]) => `${c} ${v.toFixed(1)}%`).join("，")}\n`);
    }
  }

  // ---------- 断言 ----------
  const checks: Check[] = [];
  const check = (name: string, value: number, ok: boolean, target: string, src: string) => checks.push({ name, value, ok, target, src });
  if (only.has("region")) {
    const T = (r: string, m: number) => table[r][m];
    const clr = (r: string, m: number) => pct(T(r, m).reg.clear, T(r, m).n);
    const sc = (r: string, m: number) => pct(T(r, m).reg.stratocumulus, T(r, m).n);
    const thu = (r: string, m: number) => pct(T(r, m).storm, T(r, m).stormN);
    check("日本海 1 月晴空 %", clr("日本海", 1), clr("日本海", 1) <= 25, "≤ 25", "W10 目标；冬季风寒潮雪云街 [气象厅解说、教科书]");
    check("日本海 1 月积云族 %", cuFam(T("日本海", 1)), cuFam(T("日本海", 1)) >= 40, "≥ 40", "寒潮开放单体 / 云街是积状云 [教科书；比例为估算]");
    check("北海道西 1 月晴空 %", clr("北海道西", 1), clr("北海道西", 1) <= 35, "≤ 35", "日本海一侧冬季阴雪 [气象厅解说；估算]");
    check("关东 1 月晴空 %", clr("关东", 1), clr("关东", 1) >= 50, "≥ 50", "冬季太平洋一侧晴（焚风）[气象厅解说；估算]");
    check("日本海 7 月晴空 %", clr("日本海", 7), clr("日本海", 7) >= 25, "≥ 25", "夏季比冬季少云 [估算]");
    check("长江 1 月层积云 %", sc("长江", 1), sc("长江", 1) >= 40 && sc("长江", 1) <= 75, "40–75", "[K&H93] 冷季层云；上限：[上海日照] 1 月日照率约三成半，仍有晴天 [估算]");
    // 审查 R2：原「10 月 ≤ 70」「2 月 − 7 月 ≥ 20」是按默认种子贴线定的，没有依据，改成下面两条相对量
    const oct = sc("长江", 10), jan = sc("长江", 1);
    check("长江 10 月层积云 − 1 月（百分点）", oct - jan, oct - jan <= 5, "≤ 5", "[上海日照] 10 月 161 h 比 1 月 114 h 多四成，长江下游 10 月不应比 1 月更阴（留 5 个百分点给抽样噪声）");
    check("长江 层积云 2 月 − 8 月（百分点）", sc("长江", 2) - sc("长江", 8), sc("长江", 2) - sc("长江", 8) >= 30, "≥ 30", "[K&H93] 层云最多在冷季；8 月副高控制、伏旱晴热，[上海日照] 8 月 186 h 比 2 月 120 h 多五成 [门限为估算]");
    check("长江 7 月 15 时雷暴 %", thu("长江", 7), thu("长江", 7) >= 20, "≥ 20", "盛夏午后雷暴 [估算]");
    // 审查 R2：原「七下八上晴空 ≤ 45」改前 41.5 已能过，分不出改前改后；改成锋面带位置 + 相对量（改前两条都失败）
    const hbJun = clr("华北", 6);
    check("华北 6 月晴空 − 七下八上晴空（百分点）", hbJun - hbRainyClear, hbJun - hbRainyClear >= 10, "≥ 10", "[CMA七下八上] 雨季比入汛前明显多云 [门限为估算]");
    check("华北 1 月晴空 %", clr("华北", 1), clr("华北", 1) >= 55, "≥ 55", "冬季干冷晴 [估算]");
    check("华南 7 月 15 时雷暴 %", thu("华南", 7), thu("华南", 7) >= 30, "≥ 30", "华南盛夏午后雷暴 [估算]");
    check("冲绳东 1 月 15 时雷暴 %", thu("冲绳东", 1), thu("冲绳东", 1) <= 3, "≤ 3", "W10 目标；冬季副热带洋面几乎无深对流");
    check("冲绳东 7 月积云族 %", cuFam(T("冲绳东", 7)), cuFam(T("冲绳东", 7)) >= 50, "≥ 50", "副高 + 信风积云 [教科书]");
    const shClearCu = pct(T("副高", 8).reg.clear + T("副高", 8).reg.cumulus, T("副高", 8).n);
    check("副高 8 月 晴空 + 淡积云 %", shClearCu, shClearCu >= 70 && shClearCu <= 95, "70–95", "副高下沉、晴空或信风积云 [教科书]；上限：随机性铁律，一整月不该几乎只有一种天气 [估算]");
    check("副高 8 月 15 时雷暴 %", thu("副高", 8), thu("副高", 8) >= 1 && thu("副高", 8) <= 10, "1–10", "副高下偶有孤立阵雨 / 雷阵雨 [估算]");
  }
  if (only.has("front")) {
    const c = (k: string) => frontM[k].center;
    check("锋面 5 月中心 °N", c("5月"), c("5月") >= 22 && c("5月") <= 28, "22–28", "华南前汛期；沖縄梅雨 5/10–6/21 [JMA梅雨]");
    check("锋面 6/15–28 中心 °N", c("6月15-28日"), c("6月15-28日") >= 29 && c("6月15-28日") <= 35, "29–35", "[CMA梅雨] 6/14–7/16；[JMA梅雨] 本州 6/7–7/19");
    check("锋面 6/15–28 活跃 %", frontM["6月15-28日"].active, frontM["6月15-28日"].active >= 50, "≥ 50", "梅雨盛期 [CMA梅雨][JMA梅雨]；门限为估算");
    check("锋面 7/20–31 中心 °N", c("7月20-31日"), c("7月20-31日") >= 35, "≥ 35", "北跳：梅雨明け 7/19–7/28 [JMA梅雨]；[CMA七下八上]");
    // 审查 R2：原「七下八上晴空 ≤ 45」改前 41.5 已能过；这条和上面的「华北 6 月晴空 − 七下八上晴空」改前都失败
    check("华北雨季 锋面在 36–41°N 的比例 %", hbFront, hbFront >= 40, "≥ 40", "[CMA七下八上] 7 月下旬到 8 月上旬雨带在华北（110–125°E、7/20–8/10）；门限为估算");
    check("锋面 8 月 30–34°N 活跃 %", frontM["8月"].band, frontM["8月"].band <= 20, "≤ 20", "W10 目标；梅雨 7 月中下旬结束");
    check("锋面 9 月中心 °N", c("9月"), c("9月") >= 32 && c("9月") <= 38, "32–38", "秋雨前線（本州）[估算]");
  }
  if (ty) {
    const pm = ty.perMonth;
    check(`台风 年均个数（${ty.years} 年）`, ty.mean, ty.mean >= 22 && ty.mean <= 28, "22–28", "[JMA台风] 25.1");
    const sorted = [...pm].sort((a, b) => b - a);
    const augSepTop = pm[7] >= pm[8] && pm[8] >= sorted[1] - 1e-9;
    check(`台风 8 月最多、9 月第二（${ty.years} 年，1 = 是）`, augSepTop ? 1 : 0, augSepTop, "1", "[JMA台风] 8 月 5.7、9 月 5.0");
    const janApr = pm.slice(0, 4).reduce((a, b) => a + b, 0);
    check("台风 1–4 月合计（年均）", janApr, janApr <= 3, "≤ 3", "[JMA台风] 1.5");
    const julOct = pm.slice(6, 10).reduce((a, b) => a + b, 0);
    check("台风 7–10 月合计（年均）", julOct, julOct >= 14 && julOct <= 21, "14–21", "[JMA台风] 17.8");
  }
  return { seed, checks, elapsed, table, frontM, ty };
}

// ---------- 与种子无关的确定性断言 ----------
const detChecks: Check[] = [];
{
  const g: number[] = (W as { TY_GENESIS_PER_MONTH?: number[] }).TY_GENESIS_PER_MONTH ?? []; // 老版本 weather.ts 没有导出这张表（对照改前时）
  const sum = g.reduce((a: number, b: number) => a + b, 0);
  detChecks.push({ name: "生成率表合计（个 / 年）", value: sum, ok: Math.abs(sum - 25.1) <= 0.15, target: "25.1 ± 0.15", src: "[JMA台风] 年 25.1（逐月值是四舍五入到 0.1 的，合计 25.2）" });
  const argmax = g.indexOf(Math.max(...g));
  detChecks.push({ name: "生成率表最大月", value: argmax + 1, ok: argmax === 7, target: "8", src: "[JMA台风] 8 月 5.7 最多" });
}

// ---------- 跑 ----------
const results = seeds.map((s) => {
  const r = runSeed(s);
  if (seeds.length > 1) console.error(`[weather-stats] seed ${s}：${r.checks.filter((c) => c.ok).length} / ${r.checks.length}（${r.elapsed.toFixed(1)} s）`);
  return r;
});

console.log("## 断言\n");
if (seeds.length === 1) {
  console.log("| 项 | 值 | 目标 | 结果 | 依据 |\n| --- | --- | --- | --- | --- |");
  for (const c of [...detChecks, ...results[0].checks]) console.log(`| ${c.name} | ${c.value.toFixed(1)} | ${c.target} | ${c.ok ? "通过" : "**失败**"} | ${c.src} |`);
} else {
  console.log(`| 项 | ${seeds.map((s) => `seed ${s}`).join(" | ")} | 目标 | 依据 |`);
  console.log(`| --- | ${seeds.map(() => "---").join(" | ")} | --- | --- |`);
  for (const c of detChecks) console.log(`| ${c.name} | ${seeds.map(() => (c.ok ? "" : "**") + c.value.toFixed(1) + (c.ok ? "" : "**")).join(" | ")} | ${c.target} | ${c.src} |`);
  results[0].checks.forEach((c0, i) => {
    const vals = results.map((r) => {
      const c = r.checks[i];
      return c.ok ? c.value.toFixed(1) : `**${c.value.toFixed(1)} 失败**`;
    });
    console.log(`| ${c0.name} | ${vals.join(" | ")} | ${c0.target} | ${c0.src} |`);
  });
}
const all = [...detChecks, ...results.flatMap((r) => r.checks)];
const failed = all.filter((c) => !c.ok);
console.log(`\n${all.length - failed.length} / ${all.length} 通过（${seeds.length} 个种子${seeds.length > 1 ? "，门禁要求全部通过" : ""}）`);

const jsonOut = opt("--json");
if (jsonOut) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(jsonOut, JSON.stringify({ seeds, years, tyYears, detChecks, results }, null, 1));
}
process.exit(failed.length ? 1 : 0);
