#!/usr/bin/env node
// STROBE-CLOUD：验证夜间云中自动关频闪的迟滞状态机（main.ts 的 strobeCloud，见 handoff/STROBE-CLOUD.md）。
// 用法：node handoff/STROBE-CLOUD-live.mjs --port 5283 [--out tmp/screenshot/STROBE-CLOUD/live]
//
// 坑：所有循环按「墙钟毫秒数」计时，不按「帧数」——这台机器的 rAF 节奏比想当然的 60 fps 快很多（实测约
// 130 fps，可能是高刷新率显示器 + d3d11 vsync），按帧数臆测时长会把 B2（出云 → 恢复，预期约 4.35 s）
// 这类量级的窗口砍到实际时长的不到一半，量出「没恢复」的假阴性。
//
// 两类测试（都是页内真实运行，不冻结，main.ts 的 renderFrame 按真实 rAF 节奏跑）：
//  A（端到端，场景不打补丁）：
//    A1 night-incloud（夜 + 云）：应在若干秒内关闭，关闭后不再闪；
//    A2 in-cloud（白天 + 云）：sun.altitude 远高于 −6°，网关恒为假，频闪照常按 1.1 s 周期闪；
//    A3 night-city（夜 + 云外，coverage 0.15）：飞机位置多半不在云里，网关恒为假，频闪照常闪。
//  B（确定性迟滞）：在 night-incloud 的太阳位置下，把 clouds.probe 打成空函数（不让异步 GPU 探针的回读
//    覆盖直接设的值），直接摆 clouds.cameraDensity——main.ts 的 clouds.keyVisibility()（0.5 s 平滑）与
//    strobeCloud 状态机（main.ts 频闪逻辑）照常按真实 dt 跑，量「进云到关闭」「出云到恢复」的实际延迟，
//    并用快 / 慢两种穿云节奏验证「贴着云边飞不出现开关闪烁」。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { DEFAULTS, applyScene, pinGeometry, SCENES } from "../scripts/scenarios.mjs";
import { launchBrowser, closeBrowserSafely } from "../scripts/lib/chrome.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) args[a.slice(2)] = process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[++i] : true;
}
const port = args.port || 5283;
const outDir = path.resolve(REPO, args.out || "tmp/screenshot/STROBE-CLOUD/live");
fs.mkdirSync(outDir, { recursive: true });

// 与 handoff/STROBE-FLASH-jobs-accept.json 里的 night-incloud 同一份定义（夜、低空、厚层积云，飞机确定在云里）
const NIGHT_INCLOUD = {
  name: "night-incloud",
  p: { preset: "wpac", date: "2026-01-16", time: 1320, "cloud-preset": "stratocumulus", coverage: 0.95, altitude: 1.35, "wing-pos": "8", "cabin-light": false },
  offset: [-10, -5],
  wait: 6000,
};
const DAY_INCLOUD = SCENES.find((s) => s.name === "in-cloud"); // 同样的低空厚云，但白天（14:00）
const NIGHT_CLEAR = SCENES.find((s) => s.name === "night-city"); // 夜，但 coverage 0.15，飞机多半不在云里
if (!DAY_INCLOUD || !NIGHT_CLEAR) throw new Error("scenarios.mjs 里找不到 in-cloud / night-city，场景表是不是改名了？");

async function openScene(browser, sc) {
  const ctx = await browser.newContext({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !/eox\.at|tiles|CORS|net::ERR/i.test(m.text())) errors.push(m.text());
  });
  await page.goto(`http://127.0.0.1:${port}/?dev=${Date.now()}&voyage=0`, { waitUntil: "commit", timeout: 180000 });
  await page.bringToFront();
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 180000, polling: 500 });
  const renderer = await page.evaluate(() => {
    const gl = document.createElement("canvas").getContext("webgl2");
    const e = gl.getExtension("WEBGL_debug_renderer_info");
    return gl.getParameter(e.UNMASKED_RENDERER_WEBGL);
  });
  if (/swiftshader|warp/i.test(renderer)) throw new Error(`软渲染：${renderer}`);
  await page.evaluate(() => {
    const el = document.getElementById("quality");
    if (el) {
      el.value = "high";
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
    const w = window.__voyage.weather;
    w.hold = true;
    w.heldIntensity = 0; // 不让闪电频闪混进来，只看翼尖频闪
  });
  await page.evaluate(applyScene, { sc, defaults: DEFAULTS, settle: true });
  await page.evaluate(pinGeometry, sc);
  // warmup 按时长（约 1 s）而不是帧数：这台机器 rAF 明显快于 60 fps，按帧数会缩短实际热身时间
  await page.evaluate(
    () =>
      new Promise((r) => {
        const t0 = performance.now();
        const raf = () => new Promise((rr) => requestAnimationFrame(rr));
        (async () => {
          while (performance.now() - t0 < 1000) await raf();
          r();
        })();
      }),
  );
  return { ctx, page, errors, renderer };
}

/** 逐帧录 durationMs 毫秒：翼尖频闪亮度、EXPOSURE_WHITEOUT（经 exposure.model.uWhiteout 读到）、strobeCloud 状态、太阳高度角 */
async function recordFrames(page, durationMs) {
  return page.evaluate(async (n) => {
    const v = window.__voyage;
    const out = [];
    const raf = () => new Promise((r) => requestAnimationFrame(r));
    const t0 = performance.now();
    while (performance.now() - t0 < n) {
      const t = await raf();
      out.push({
        t,
        strobe: v.sceneMat.uniforms.uStrobe.value,
        whiteout: v.exposure.model.uWhiteout.value,
        off: v.strobeCloud.off,
        offDwell: +v.strobeCloud.offDwell.toFixed(3),
        onDwell: +v.strobeCloud.onDwell.toFixed(3),
        sunAlt: v.sunAltDeg(),
      });
    }
    return out;
  }, durationMs);
}

function countFlips(rec, key) {
  let flips = 0;
  for (let i = 1; i < rec.length; i++) if (rec[i][key] !== rec[i - 1][key]) flips++;
  return flips;
}

/** B 用：在同一次 page.evaluate 里把 cameraDensity 摆到指定值后立刻开始录 durationMs 毫秒，
 * 避免「摆值」和「开始录」分成两次 page.evaluate 之间的真实墙钟间隙污染计时（B1/B2 量的是秒级延迟，
 * 两次 evaluate 之间哪怕只多等 100–200 ms 的 IPC 往返，也会让「进云 → 关闭」的读数偏差可观） */
async function setDensityAndRecord(page, density, durationMs) {
  return page.evaluate(
    async ({ density, n }) => {
      const v = window.__voyage;
      if (density !== null) v.clouds.cameraDensity = density;
      const out = [];
      const raf = () => new Promise((r) => requestAnimationFrame(r));
      const t0 = performance.now();
      while (performance.now() - t0 < n) {
        const t = await raf();
        out.push({ t, strobe: v.sceneMat.uniforms.uStrobe.value, whiteout: v.exposure.model.uWhiteout.value, off: v.strobeCloud.off, sunAlt: v.sunAltDeg() });
      }
      return out;
    },
    { density, n: durationMs },
  );
}

const browser = await launchBrowser(chromium, { angle: "d3d11" });
const report = {};
let ok = true;
try {
  // ---- A1：night-incloud（夜 + 云，端到端，不打补丁）----
  {
    const { ctx, page, errors, renderer } = await openScene(browser, NIGHT_INCLOUD);
    console.log(`\n== A1 night-incloud（${renderer.slice(0, 50)}…）`);
    const rec = await recordFrames(page, 10000); // 10 s，够跨过预期约 2.85 s 的关闭延迟
    const sunAlt = rec[0].sunAlt;
    const firstOffIdx = rec.findIndex((r) => r.off);
    const strobeAfterOff = firstOffIdx >= 0 ? rec.slice(firstOffIdx).filter((r) => r.strobe > 0).length : null;
    const a1 = {
      sunAlt,
      toOffS: firstOffIdx >= 0 ? +((rec[firstOffIdx].t - rec[0].t) / 1000).toFixed(2) : null,
      strobeAfterOffFrames: strobeAfterOff,
      whiteoutEnd: +rec.at(-1).whiteout.toFixed(3),
      frames: rec.length,
      errors: errors.length,
    };
    report.A1_night_incloud = a1;
    console.log(`  太阳高度角 ${sunAlt.toFixed(1)}°；关闭于 t=${a1.toOffS}s（${a1.frames} 帧 / 10 s，实测约 ${(a1.frames / 10).toFixed(0)} fps）；关闭后仍有 uStrobe>0 的帧数 ${strobeAfterOff}；结束 whiteout=${a1.whiteoutEnd}；console error ${errors.length}`);
    if (a1.toOffS === null) { console.log("  [FAIL] 10 s 内没有关闭"); ok = false; }
    if (strobeAfterOff) { console.log("  [FAIL] 关闭后仍有帧在闪"); ok = false; }
    if (errors.length) { console.log("  [FAIL] console error"); ok = false; }
    fs.writeFileSync(path.join(outDir, "A1_night_incloud.json"), JSON.stringify(rec));
    await ctx.close();
  }

  // ---- A2：in-cloud（白天 + 云，网关恒假，逐帧频闪节律应与改前一致）----
  {
    const { ctx, page, errors, renderer } = await openScene(browser, DAY_INCLOUD);
    console.log(`\n== A2 in-cloud（白天，${renderer.slice(0, 50)}…）`);
    const rec = await recordFrames(page, 5000); // 5 s，够看到至少 4 个频闪周期（1.1 s 一个）
    const sunAlt = rec[0].sunAlt;
    const anyOff = rec.some((r) => r.off);
    const segs = (() => {
      const st = rec.map((r) => r.strobe >= 0.5);
      let n = 0;
      for (let i = 1; i < st.length; i++) if (st[i] && !st[i - 1]) n++;
      return n;
    })();
    // 与 main.ts 的公式核对：ph = (t/1000) % 1.1，ph<0.05 || (0.14<ph<0.19) 时该闪
    const mism = rec.filter((r) => {
      const ph = (r.t / 1000) % 1.1;
      const want = ph < 0.05 || (ph > 0.14 && ph < 0.19) ? 1 : 0;
      return want === 1 !== r.strobe > 0;
    }).length;
    const a2 = { sunAlt, anyOff, strobeSegs: segs, formulaMismatch: mism, errors: errors.length };
    report.A2_in_cloud_day = a2;
    console.log(`  太阳高度角 ${sunAlt.toFixed(1)}°；strobeCloud.off 是否出现过 true：${anyOff}；频闪段数 ${segs}；与公式不符的帧 ${mism}；console error ${errors.length}`);
    if (anyOff) { console.log("  [FAIL] 白天不该被云网关关闭"); ok = false; }
    if (segs < 3) { console.log("  [FAIL] 频闪段数偏少，节律像是被打断了"); ok = false; }
    if (mism) { console.log("  [FAIL] uStrobe 与 main.ts 的时序公式不一致（白天该逐帧不变）"); ok = false; }
    if (errors.length) { console.log("  [FAIL] console error"); ok = false; }
    fs.writeFileSync(path.join(outDir, "A2_in_cloud_day.json"), JSON.stringify(rec));
    await ctx.close();
  }

  // ---- A3：night-city（夜 + 云外，coverage 0.15，网关恒假）----
  {
    const { ctx, page, errors, renderer } = await openScene(browser, NIGHT_CLEAR);
    console.log(`\n== A3 night-city（夜、云外，${renderer.slice(0, 50)}…）`);
    const rec = await recordFrames(page, 5000);
    const sunAlt = rec[0].sunAlt;
    const anyOff = rec.some((r) => r.off);
    const whiteoutMax = Math.max(...rec.map((r) => r.whiteout));
    const segs = (() => {
      const st = rec.map((r) => r.strobe >= 0.5);
      let n = 0;
      for (let i = 1; i < st.length; i++) if (st[i] && !st[i - 1]) n++;
      return n;
    })();
    const a3 = { sunAlt, anyOff, whiteoutMax: +whiteoutMax.toFixed(3), strobeSegs: segs, errors: errors.length };
    report.A3_night_city_clear = a3;
    console.log(`  太阳高度角 ${sunAlt.toFixed(1)}°；strobeCloud.off 是否出现过 true：${anyOff}；whiteout 峰值 ${a3.whiteoutMax}；频闪段数 ${segs}；console error ${errors.length}`);
    if (anyOff) { console.log("  [FAIL] 云外不该被关闭"); ok = false; }
    if (segs < 3) { console.log("  [FAIL] 频闪段数偏少"); ok = false; }
    if (errors.length) { console.log("  [FAIL] console error"); ok = false; }
    fs.writeFileSync(path.join(outDir, "A3_night_city_clear.json"), JSON.stringify(rec));
    await ctx.close();
  }

  // ---- B：确定性迟滞（打补丁 clouds.probe，直接摆 clouds.cameraDensity）----
  {
    const { ctx, page, errors, renderer } = await openScene(browser, NIGHT_INCLOUD);
    console.log(`\n== B 确定性迟滞（${renderer.slice(0, 50)}…）`);
    // 场景刚加载时飞机本来就在云里（night-incloud），strobeCloud.off 在录制开始前多半已经是 true
    // （见 A1：t=0 就已关闭）；必须先等它真的按迟滞退回 false，不能只跑固定时长臆测「应该够了」，
    // 否则 B1 量到的是旧状态的残留，不是这次「进云」触发的新转换。
    // 打补丁（停掉异步 GPU 探针、摆 cameraDensity=0）与开始轮询放在同一次 page.evaluate 里，不隔一次
    // IPC 往返——分成两次调用时曾经量到一次 10 s 超时未归零（怀疑是两次调用之间那点空档，被一个
    // 补丁生效前已经发起、GPU 队列繁忙时较晚才 resolve 的旧探针在空档期把 cameraDensity 又冲了回去）。
    const resetRes = await page.evaluate(async (maxMs) => {
      const v = window.__voyage;
      v.clouds.probe = () => {}; // 停掉异步 GPU 探针，不让它把接下来摆的 cameraDensity 冲掉
      v.clouds.cameraDensity = 0;
      v.wingDebug.strobe = null;
      const raf = () => new Promise((r) => requestAnimationFrame(r));
      const t0 = performance.now();
      while (performance.now() - t0 < maxMs) {
        if (v.strobeCloud.off === false) return { ok: true, ms: performance.now() - t0 };
        await raf();
      }
      return { ok: v.strobeCloud.off === false, ms: performance.now() - t0 };
    }, 15000); // 最多 15 s（whiteout 衰减 ~0.35 s + onDwell 4 s，留数倍余量）
    console.log(`  重置到 off=false：${resetRes.ok ? "成功" : "失败"}（${(resetRes.ms / 1000).toFixed(2)} s）`);
    if (!resetRes.ok) { console.log("  [FAIL] 迟滞状态没能重置，后面的 B1/B2 量出来的时间不可信"); ok = false; }

    // B1：进云 → 关闭的延迟（预期 ≈ whiteout 从 0 爬过 0.5 的时间 + 2.5 s 迟滞 ≈ 2.85 s）。
    // 摆值与开始录在同一次 page.evaluate 里（setDensityAndRecord），不留 IPC 往返的空档
    let rec = await setDensityAndRecord(page, 1.0, 7000); // 7 s，留够余量
    let idx = rec.findIndex((r) => r.off);
    const b1 = { toOffS: idx >= 0 ? +((rec[idx].t - rec[0].t) / 1000).toFixed(2) : null, whiteoutAtOff: idx >= 0 ? +rec[idx].whiteout.toFixed(3) : null };
    report.B1_enter_cloud_delay = b1;
    console.log(`  B1 进云 → 关闭：${b1.toOffS} s（whiteout=${b1.whiteoutAtOff}）`);
    if (b1.toOffS === null || b1.toOffS < 2 || b1.toOffS > 4) { console.log("  [FAIL] 不在验收要求的 2–3 s 量级附近（含信号爬升时间，容许到约 4 s）"); ok = false; }

    // B2：出云 → 恢复的延迟（预期 ≈ whiteout 从「B1 结束时已接近饱和」decay 过 0.5 的时间 + 4 s 迟滞）
    rec = await setDensityAndRecord(page, 0.0, 9000); // 9 s
    idx = rec.findIndex((r) => !r.off);
    const b2 = { toOnS: idx >= 0 ? +((rec[idx].t - rec[0].t) / 1000).toFixed(2) : null, whiteoutAtOn: idx >= 0 ? +rec[idx].whiteout.toFixed(3) : null };
    report.B2_exit_cloud_delay = b2;
    console.log(`  B2 出云 → 恢复：${b2.toOnS} s（whiteout=${b2.whiteoutAtOn}）`);
    if (b2.toOnS === null || b2.toOnS < 3 || b2.toOnS > 7) { console.log("  [FAIL] 不在验收要求的 3–5 s 量级附近（含信号衰减时间，容许到约 7 s）"); ok = false; }

    // B3：快速穿云（0.5 s 半周期，远小于两条迟滞窗口）：off 不应翻转——贴着云边飞的最坏情形。
    // B2 结束时 off 应已回到 false（若没有，下面的翻转计数本身仍然有效，只是起点不同，不影响「翻转次数」这个判据）
    const fastRec = [];
    for (let cyc = 0; cyc < 20; cyc++) fastRec.push(...(await setDensityAndRecord(page, cyc % 2 === 0 ? 1.0 : 0.0, 500))); // 每段 0.5 s，共 10 s
    const b3 = {
      offFlips: countFlips(fastRec, "off"),
      whiteoutRange: [+Math.min(...fastRec.map((r) => r.whiteout)).toFixed(3), +Math.max(...fastRec.map((r) => r.whiteout)).toFixed(3)],
      frames: fastRec.length,
    };
    report.B3_fast_edge_crossing = b3;
    console.log(`  B3 快速穿云（0.5 s 半周期，${b3.frames} 帧）：off 翻转 ${b3.offFlips} 次；whiteout 摆动 ${b3.whiteoutRange[0]}–${b3.whiteoutRange[1]}`);
    if (b3.offFlips > 0) { console.log("  [FAIL] 贴着云边快速穿行时出现了开关闪烁"); ok = false; }
    fs.writeFileSync(path.join(outDir, "B3_fast_edge.json"), JSON.stringify(fastRec));

    // B4：慢速穿云（3 s / 3 s，量级接近迟滞窗口）：允许出现一次关闭，但不应该在每个周期里反复开关
    //     （短于 4 s 的出云间隔按设计不足以恢复——这正是迟滞要的效果，不是 bug，写进交接文档）
    const slowRec = [];
    for (let cyc = 0; cyc < 6; cyc++) slowRec.push(...(await setDensityAndRecord(page, cyc % 2 === 0 ? 1.0 : 0.0, 3000))); // 每段 3 s，共 18 s
    const b4 = { offFlips: countFlips(slowRec, "off"), frames: slowRec.length, offTrace: slowRec.filter((_, i) => i % Math.max(1, Math.round(slowRec.length / 40)) === 0).map((r) => r.off) };
    report.B4_slow_edge_crossing = b4;
    console.log(`  B4 慢速穿云（3 s / 3 s，${b4.frames} 帧）：off 翻转 ${b4.offFlips} 次；采样轨迹 ${JSON.stringify(b4.offTrace)}`);
    if (b4.offFlips > 3) { console.log("  [FAIL] 3 s/3 s 节奏下开关次数偏多，像是在闪烁而不是稳定关闭"); ok = false; }
    fs.writeFileSync(path.join(outDir, "B4_slow_edge.json"), JSON.stringify(slowRec));

    if (errors.length) { console.log("  [FAIL] console error"); ok = false; }
    report.B_errors = errors.length;
    await ctx.close();
  }
} finally {
  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(report, null, 1));
  await closeBrowserSafely(browser);
}
console.log(`\n${ok ? "全部通过" : "有 [FAIL]，见上面"}。详情：${path.join(outDir, "summary.json")}`);
process.exit(ok ? 0 : 1);
