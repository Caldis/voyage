// T49 离线单测：航向控制 / 接力转弯。不开浏览器，几十秒跑完。
// 用法：node --import ./handoff/T49-resolve.mjs --experimental-transform-types --no-warnings handoff/T49-test.mts
import { runSim, turnEvents, maxBankRate } from "./T49-sim.mts";
import { AIRPORTS, ROUTES, neighbors, pickNextLeg, turnFrom } from "../src/routes.ts";
import { greatCircleBearing, haversineKm, leadTurnKm, MAX_YAW_REAL_DEG_S, ROLL_RATE_DEG_S, speedAt } from "../src/flight.ts";

let fails = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "通过" : "失败"}  ${name}${detail ? "：" + detail : ""}`);
  if (!ok) fails++;
}
const wrap = (d: number) => ((d + 540) % 360) - 180;
const peak = (rows: { bank: number }[]) => Math.max(...rows.map((r) => Math.abs(r.bank)));
function maxYawReal(rows: { t: number; heading: number }[]) {
  let m = 0;
  for (let i = 1; i < rows.length; i++) m = Math.max(m, Math.abs(wrap(rows[i].heading - rows[i - 1].heading)) / (rows[i].t - rows[i - 1].t));
  return m;
}

// ---------- 1. 接力选段：到达航向 → 下一段要转的角度分布（全航线网，每个「从 A 飞到 B」各挑 200 次） ----------
{
  let seed = 7;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0), seed / 4294967296);
  const hist = (withCourse: boolean) => {
    const bins = [0, 0, 0, 0]; // ≤45 / ≤90 / ≤135 / >135
    for (const [a, b] of ROUTES)
      for (const [from, to] of [[a, b], [b, a]]) {
        const A = AIRPORTS[from], B = AIRPORTS[to];
        const inbound = (greatCircleBearing(B.lat, B.lon, A.lat, A.lon) + 180) % 360; // 到达 B 时的航向
        for (let i = 0; i < 200; i++) {
          const leg = pickNextLeg(B, A, new Map(), rnd, withCourse ? inbound : undefined);
          const t = turnFrom(inbound, B, leg.to);
          bins[t <= 45 ? 0 : t <= 90 ? 1 : t <= 135 ? 2 : 3]++;
        }
      }
    const n = bins.reduce((x, y) => x + y);
    return bins.map((v) => Math.round((v / n) * 100));
  };
  const before = hist(false), after = hist(true);
  console.log(`接力转角分布（≤45° / 45–90° / 90–135° / >135°，%）：改前 ${before.join(" / ")}，改后 ${after.join(" / ")}`);
  // 死胡同（所有航线都在身后）的到达组合占比：这些只能掉头，交给遮挡排队
  let dead = 0, total = 0;
  for (const [a, b] of ROUTES)
    for (const [from, to] of [[a, b], [b, a]]) {
      const A = AIRPORTS[from], B = AIRPORTS[to];
      const inbound = (greatCircleBearing(B.lat, B.lon, A.lat, A.lon) + 180) % 360;
      total++;
      if (!neighbors(to).some((c) => c.code !== from && turnFrom(inbound, B, c) <= 90)) dead++;
    }
  console.log(`没有「向前」下一段的到达组合：${dead} / ${total}`);
  check("改后 ≤90° 的接力占比明显上升", after[0] + after[1] > before[0] + before[1] + 15, `${before[0] + before[1]}% → ${after[0] + after[1]}%`);
  check("有向前选项时一定选向前", after[0] + after[1] >= Math.round((1 - dead / total) * 100) - 1);
}

// ---------- 2. 各流速下的滚转速率、坡度、真实时间航向变化率（航线接力，20 真实分钟） ----------
for (const rate of [1, 10, 60]) {
  const minutes = rate === 1 ? 60 : 20;
  const { rows, director } = runSim({ rate, realMin: minutes, presetId: "hnd-cts", fps: 30 });
  const br = maxBankRate(rows);
  const ev = turnEvents(rows, 60, rate);
  check(`${rate}× 滚转速率 ≤ ${ROLL_RATE_DEG_S}°/真实秒`, br <= ROLL_RATE_DEG_S + 1e-6, `${br.toFixed(2)}°/s，最大坡度 ${peak(rows).toFixed(1)}°，接力 ${director.telemetry.legs.length} 次，>60° 转向 ${ev.length} 次`);
  check(`${rate}× 真实时间航向变化率 ≤ ${MAX_YAW_REAL_DEG_S}°/s`, maxYawReal(rows) <= MAX_YAW_REAL_DEG_S + 0.05, `${maxYawReal(rows).toFixed(2)}°/s`);
  check(`${rate}× 坡度 ≤ 25°`, peak(rows) <= 25.001);
  // 真实时间里「打满坡度」至少要几秒：60× 改前一帧就到 25°
  for (const e of ev) if (e.t1 - e.t0 < 5) check(`${rate}× 大转向不能在 5 真实秒内完成`, false, `${e.leg} ${e.deg.toFixed(0)}° 用了 ${(e.t1 - e.t0).toFixed(1)} s`);
}

// ---------- 3. 航线接力的提前转弯：能向前接（≤ 90°）的，在到终点之前按转弯半径开始转，不飞过头再掉头 ----------
for (const rate of [1, 10, 60]) {
  const rec: { turn: number; distKm: number; expectKm: number; name: string }[] = [];
  runSim({
    rate, realMin: rate === 1 ? 60 : 30, presetId: "hnd-cts", fps: 30,
    setup: (d, s) => {
      const orig = d.relay.bind(d);
      const host = (d as unknown as { host: { geo(): [number, number] } }).host;
      d.relay = () => {
        const to = d.leg!.to;
        const next = d.nextLeg;
        const [lat, lon] = host.geo();
        if (next) {
          const turn = turnFrom(s.heading, to, next.to);
          rec.push({ turn, distKm: haversineKm(lat, lon, to.lat, to.lon), expectKm: Math.max(40, leadTurnKm(turn, speedAt(s.altitudeKm), rate)), name: `${to.code}-${next.to.code}` });
        }
        orig();
      };
    },
  });
  const fwd = rec.filter((r) => r.turn <= 90);
  const detail = rec.map((r) => `${r.name} 转 ${r.turn.toFixed(0)}° 离终点 ${r.distKm.toFixed(0)} km（应 ≥ ${r.expectKm.toFixed(0)}）`).join("；");
  if (rate === 1) check("1× hnd-cts 飞到新千岁并接下一段", rec.length >= 1, detail);
  else check(`${rate}× 向前接力按转弯半径提前开始转`, fwd.length > 0 && fwd.every((r) => r.distKm >= r.expectKm * 0.95) && (rate < 60 || fwd.some((r) => r.expectKm > 41)), detail);
}

// ---------- 4. 手动航向：连按左转 14 次（累计 210°）应一直向左转，停在目标航向，不冲过头 ----------
{
  let h0 = 0, target = 0;
  const { rows, state } = runSim({
    rate: 1, realMin: 6, presetId: "wpac", fps: 30,
    setup: (d, s) => {
      h0 = s.heading;
      for (let i = 0; i < 14; i++) d.turnBy(-15);
      target = (h0 - 210 + 360) % 360;
    },
  });
  let sumLeft = 0, overshoot = 0;
  for (let i = 1; i < rows.length; i++) {
    const dh = wrap(rows[i].heading - rows[i - 1].heading);
    if (dh < 0) sumLeft += -dh;
    // 冲过头：转过 200° 之后，航向继续向左越过目标的最大量
    if (sumLeft > 200) overshoot = Math.max(overshoot, -Math.min(0, wrap(rows[i].heading - target)));
  }
  check("连按左转 210°：一直向左转", sumLeft > 205 && sumLeft < 216, `向左累计 ${sumLeft.toFixed(1)}°`);
  check("停在目标航向", Math.abs(wrap(state.heading - target)) < 1, `终航向 ${state.heading.toFixed(1)}°，目标 ${target.toFixed(1)}°`);
  check("不冲过头（< 2°）", overshoot < 2, `${overshoot.toFixed(2)}°`);
  check("滚转速率 ≤ 3°/s", maxBankRate(rows) <= ROLL_RATE_DEG_S + 1e-6, `${maxBankRate(rows).toFixed(2)}°/s，峰值坡度 ${peak(rows).toFixed(1)}°`);
  // 25° 坡度建立时间：从 0 到 > 24° 至少 8 秒
  const t24 = rows.find((r) => Math.abs(r.bank) > 24)?.t ?? Infinity;
  check("25° 坡度不少于 8 真实秒才打满", t24 >= 8, `${t24.toFixed(1)} s`);
}

// ---------- 5. 盘旋：1× 与 60× 都停留在等待点附近，不漂走 ----------
for (const rate of [1, 60]) {
  let c: [number, number] = [0, 0];
  const { rows, director } = runSim({
    rate, realMin: rate === 1 ? 40 : 10, presetId: "wpac", fps: 30,
    setup: (d, s) => {
      c = [s.preset.lat, s.preset.lon];
      d.hold();
    },
  });
  const dist = rows.map((r) => haversineKm(r.lat, r.lon, c[0], c[1]));
  const half = Math.floor(dist.length / 2);
  const max1 = Math.max(...dist.slice(0, half)), max2 = Math.max(...dist.slice(half));
  const bound = rate === 1 ? 60 : 500;
  check(`${rate}× 盘旋不漂走`, max2 < bound && max2 < max1 * 1.15 + 5, `前半程最远 ${max1.toFixed(1)} km，后半程 ${max2.toFixed(1)} km；${director.describeNav()}`);
  check(`${rate}× 盘旋滚转速率 ≤ 3°/s`, maxBankRate(rows) <= ROLL_RATE_DEG_S + 1e-6, `${maxBankRate(rows).toFixed(2)}°/s，峰值坡度 ${peak(rows).toFixed(1)}°`);
}

// ---------- 6. 直飞机场：到达后转入盘旋，停在机场上空 ----------
for (const rate of [10, 60]) {
  const itm = AIRPORTS.ITM;
  const { rows, director } = runSim({ rate, realMin: rate === 10 ? 25 : 8, presetId: "hnd-cts", fps: 30, setup: (d) => d.directTo("ITM") });
  const last = rows.slice(-Math.floor(rows.length / 4)).map((r) => haversineKm(r.lat, r.lon, itm.lat, itm.lon));
  check(`${rate}× 直飞伊丹后盘旋`, director.ap.mode === "hold" && Math.max(...last) < (rate === 10 ? 120 : 500), `模式 ${director.ap.mode}，最后 1/4 时间离伊丹最远 ${Math.max(...last).toFixed(0)} km`);
}

// ---------- 7. 大角度掉头借遮挡：穿云时在云里直接换向 ----------
{
  const { director, rows } = runSim({
    rate: 10, realMin: 20, presetId: "hnd-cts", fps: 30,
    cloudCover: (t) => (t > 330 && t < 400 ? 0.6 : 0), // 大约在接下一段（CTS 掉头）之后进云
  });
  const sw = director.telemetry.switches.filter((w) => w.id === "leg-turn");
  check("掉头排队后借穿云执行", sw.some((w) => w.how === "cloud"), sw.map((w) => w.how).join(",") || "没有排队");
  check("进云之前（掉头排队期间）没有 >60° 的转向", turnEvents(rows.filter((r) => r.t < 330), 60, 10).length === 0);
}

// ---------- 8. 手动控制不借遮挡延迟：盘旋 / 手动航向时不接力 ----------
{
  const { director } = runSim({ rate: 60, realMin: 3, presetId: "hnd-cts", fps: 30, setup: (d) => d.setHeading(90) });
  check("手动航向时不接力、不排队掉头", director.telemetry.legs.length === 0 && !director.pendingIds.includes("leg-turn"), `接力 ${director.telemetry.legs.length} 次，排队 ${director.pendingIds.join(",") || "无"}`);
}

console.log(fails ? `\n${fails} 项失败` : "\n全部通过");
process.exitCode = fails ? 1 : 0;
