// FOCUS-ZOOM：聚焦（视场逐帧变）时云的时间累积有没有拖影 / 鬼影——确定性重放 + 对真值误差。
//
//   node apps/voyage/handoff/FOCUS-ZOOM-cloud.mjs --port 5264 [--scene sea-sc] [--mag 4] [--frames 12] [--speed 0] [--out tmp/screenshot/focus-zoom/cloud]
//
// 做法同 dev-browser.mjs flight（DX-23）：页面全冻结，脚本手动调用 clouds.render 推进云，每个变体走同一条轨迹、逐位可复现；
// 真值 = 同姿态、同视场静止时逐帧 raw（resolve 之前的本帧步进结果）等权平均 128 帧。轨迹：
//   静止预热 96 帧（默认视场）→ 放大过渡 --frames 帧（与 focus-zoom.ts 同一条 smootherstep + 对数插值）→ 保持 48 帧
//   → 还原过渡 --frames 帧 → 保持 48 帧；--speed > 0 时整段匀速巡航（km / 帧）。
// 变体：cur（本分支：历史按上一帧视场投影 uPrevTanHalfFov + 视场变化的帧把 reset 后帧数压到 ≤ 8）、nocap（只有正确投影）、
//       naive（改前：历史按本帧视场投影）、softN（不同的压帧上限）、
//       reset（视场一变就清空累积）。每个检查点输出云缓冲裁剪区对真值的 err（rms / 均值）与云边梯度能量比 edge（1 = 与真值一样锐）。
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser, closeBrowserSafely } from "../scripts/lib/chrome.mjs";
import { DEFAULTS, SCENES, applyScene, pinGeometry } from "../scripts/scenarios.mjs";
import { acquireMeasureLock } from "../scripts/lib/ab.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((a, s, i, all) => (s.startsWith("--") ? [...a, [s.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true]] : a), []),
);
const port = args.port || 5264;
const sceneName = args.scene || "sea-sc";
const mag = Number(args.mag || 4);
const nTrans = Number(args.frames || 12);
const speed = Number(args.speed || 0);
const VARIANTS = String(args.variants || "cur,naive,reset").split(",");
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const outDir = path.resolve(REPO, args.out || `tmp/screenshot/focus-zoom/cloud-${sceneName}-${mag}x-${speed}`);
fs.mkdirSync(outDir, { recursive: true });

const release = await acquireMeasureLock(REPO, `FOCUS-ZOOM-cloud.mjs（端口 ${port}, pid ${process.pid}）`, (s) => console.log(s));
const browser = await launchBrowser(chromium, { angle: "d3d11" });
try {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${port}/?t=${Date.now()}&voyage=0`, { waitUntil: "commit", timeout: 180000 });
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 180000, polling: 500 });
  const renderer = await page.evaluate(() => {
    const gl = window.__voyage.clouds.pass.renderer.getContext();
    const e = gl.getExtension("WEBGL_debug_renderer_info");
    return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : "?";
  });
  console.log(`GL_RENDERER = ${renderer}`);
  const sc = SCENES.find((s) => s.name === sceneName);
  if (!sc) throw new Error(`没有场景 ${sceneName}`);
  await page.evaluate(() => {
    const q = document.getElementById("quality");
    q.value = "high";
    q.dispatchEvent(new Event("change"));
    window.__voyage.weather.hold = true;
    window.__voyage.weather.heldIntensity = 0;
  });
  await page.evaluate(applyScene, { sc, defaults: DEFAULTS, settle: false });
  await page.evaluate(pinGeometry, sc);
  await page.evaluate(() => new Promise((r) => { let k = 0; const f = () => (++k >= 30 ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }));
  await page.evaluate(() => window.__voyage.freeze(true));
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

  const res = await page.evaluate(({ mag, nTrans, speed, VARIANTS }) => {
    const v = window.__voyage;
    const u = v.sceneMat.uniforms;
    const c = v.clouds;
    const r = c.resolveMat.uniforms;
    const tan0 = Math.tan((25 * Math.PI) / 180);
    const t = c.history[0];
    const CW = t.width / 2, CH = t.height;
    // 裁剪区：云缓冲中间 60%（窗板开口里；四周窗框外的像素恒为 (0,0,0,1)）
    const rc = { x: Math.round(CW * 0.3), y: Math.round(CH * 0.25), w: Math.round(CW * 0.4), h: Math.round(CH * 0.5) };
    const buf = new Float32Array(rc.w * rc.h * 4);
    const lum = (tex) => {
      c.pass.renderer.readRenderTargetPixels(tex, rc.x, rc.y, rc.w, rc.h, buf);
      const o = new Float32Array(rc.w * rc.h);
      for (let k = 0; k < o.length; k++) o[k] = 0.2126 * buf[4 * k] + 0.7152 * buf[4 * k + 1] + 0.0722 * buf[4 * k + 2];
      return o;
    };
    const off0 = v.cloudUniforms.uCloudOffset.value.clone();
    const h = (v.state.heading * Math.PI) / 180;
    const motion = r.uMotion.value.clone().set(0, 0, 0);
    const setFrame = (k) => {
      // 第 k 帧的飞机位置（匀速巡航）
      v.cloudUniforms.uCloudOffset.value.set(off0.x + Math.sin(h) * speed * k, off0.y - Math.cos(h) * speed * k);
    };
    const render = (tan, variant) => {
      u.uTanHalfFov.value = tan;
      if (variant === "naive") r.uPrevTanHalfFov.value = tan; // 改前：历史按本帧视场投影
      // naive / nocap / reset / softN 都不用 clouds.ts 里的「视场变化压 reset 后帧数」（改前没有；softN 自己压）；cur 是本分支实际代码
      c.zoomSinceResetCap = variant === "cur" ? 8 : Infinity;
      c.render(motion.set(Math.sin(h) * speed, 0, -Math.cos(h) * speed), u.uCamBasis.value, u.uCabinToWorld.value);
    };
    const ease = (p) => p * p * p * (p * (p * 6 - 15) + 10);
    // 轨迹：每帧的视场
    const W = 96, H = 48;
    const tans = [];
    for (let i = 0; i < W; i++) tans.push(tan0);
    for (let i = 1; i <= nTrans; i++) tans.push(tan0 / Math.pow(mag, ease(i / nTrans)));
    for (let i = 0; i < H; i++) tans.push(tan0 / mag);
    for (let i = 1; i <= nTrans; i++) tans.push(tan0 / Math.pow(mag, ease(1 - i / nTrans)));
    for (let i = 0; i < H; i++) tans.push(tan0);
    const inEnd = W + nTrans - 1, outEnd = W + nTrans + H + nTrans - 1;
    const checks = [W - 1, W + Math.floor(nTrans / 2), inEnd, inEnd + 4, inEnd + 8, inEnd + 16, inEnd + 32, inEnd + H,
                    outEnd - Math.ceil(nTrans / 2), outEnd, outEnd + 4, outEnd + 8, outEnd + 16, outEnd + 32, outEnd + H];
    const truthAt = (k) => {
      setFrame(k);
      u.uTanHalfFov.value = tans[k];
      const acc = new Float64Array(rc.w * rc.h);
      c.frame = 0;
      c.snap();
      const z = motion.clone().set(0, 0, 0);
      for (let i = 0; i < 128; i++) {
        c.render(z, u.uCamBasis.value, u.uCabinToWorld.value);
        const f = lum(c.raw);
        for (let q = 0; q < acc.length; q++) acc[q] += f[q];
      }
      return Float32Array.from(acc, (a) => a / 128);
    };
    // 指标在页内算（整张裁剪区的浮点数组传回 Node 会撑爆内存）：口径同 scripts/lib/ab.mjs 的 hdrMetrics（err、edge）
    const W2 = rc.w, H2 = rc.h;
    const box3 = (A) => {
      const o = new Float32Array(A.length);
      for (let y = 0; y < H2; y++)
        for (let x = 0; x < W2; x++) {
          let s = 0;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += A[Math.min(H2 - 1, Math.max(0, y + dy)) * W2 + Math.min(W2 - 1, Math.max(0, x + dx))];
          o[y * W2 + x] = s / 9;
        }
      return o;
    };
    const grad2 = (A) => {
      const g = new Float32Array(A.length);
      for (let y = 1; y < H2 - 1; y++)
        for (let x = 1; x < W2 - 1; x++) {
          const gx = (A[y * W2 + x + 1] - A[y * W2 + x - 1]) / 2, gy = (A[(y + 1) * W2 + x] - A[(y - 1) * W2 + x]) / 2;
          g[y * W2 + x] = gx * gx + gy * gy;
        }
      return g;
    };
    const truthInfo = {};
    const metrics = (V, k) => {
      const T = truthInfo[k].T;
      let mu = 0, e = 0;
      for (let i = 0; i < T.length; i++) mu += T[i];
      mu = Math.max(mu / T.length, 1e-9);
      for (let i = 0; i < T.length; i++) e += (V[i] - T[i]) ** 2;
      const gV = grad2(box3(V));
      const { gT, thr } = truthInfo[k];
      let sT = 0, sV = 0;
      for (let i = 0; i < gT.length; i++) if (gT[i] > thr) { sT += gT[i]; sV += gV[i]; }
      return { err: Math.sqrt(e / T.length) / mu, edge: sV / Math.max(sT, 1e-30) };
    };
    for (const k of checks) {
      const T = truthAt(k);
      const gT = grad2(box3(T));
      const sorted = Float32Array.from(gT).sort();
      truthInfo[k] = { T, gT, thr: sorted[Math.floor(0.9 * sorted.length)] };
    }
    const out = { rc, checks, tans: checks.map((k) => tans[k]), variants: {} };
    for (const variant of VARIANTS) {
      const shots = {};
      c.frame = 0;
      c.snap();
      let prevTan = tans[0];
      for (let k = 0; k < tans.length; k++) {
        setFrame(k);
        if (variant === "reset" && tans[k] !== prevTan) c.snap();
        // softN：视场变的帧把「自上次 reset 起的帧数」压到 ≤ N（resolve 的等权兜底 blend ≥ 1/(n+1)），历史保留、只是权重降低
        const soft = /^soft(\d+)$/.exec(variant);
        if (soft && tans[k] !== prevTan) r.uSinceReset.value = Math.min(r.uSinceReset.value, Number(soft[1]) - 1);
        prevTan = tans[k];
        render(tans[k], variant);
        if (checks.includes(k)) shots[k] = metrics(lum(c.history[0]), k);
      }
      out.variants[variant] = shots;
    }
    // 复原
    u.uTanHalfFov.value = tan0;
    r.uPrevTanHalfFov.value = tan0;
    c.zoomSinceResetCap = 8;
    v.cloudUniforms.uCloudOffset.value.copy(off0);
    c.snap();
    u.uClouds.value = c.texture;
    return out;
  }, { mag, nTrans, speed, VARIANTS });

  const lines = [];
  const head = `帧      视场倍率   ` + VARIANTS.map((n) => `${n}: err / edge`.padEnd(22)).join("");
  lines.push(`场景 ${sceneName}，倍率 ${mag}×，过渡 ${nTrans} 帧，巡航 ${speed} km/帧；裁剪 ${JSON.stringify(res.rc)}（云缓冲像素）`);
  lines.push(head);
  const summary = {};
  res.checks.forEach((k, i) => {
    const cells = VARIANTS.map((n) => {
      const m = res.variants[n][k];
      (summary[n] ??= []).push({ frame: k, ...m });
      return `${m.err.toFixed(4)} / ${m.edge.toFixed(3)}`.padEnd(22);
    });
    lines.push(`${String(k).padEnd(7)} ${(Math.tan((25 * Math.PI) / 180) / res.tans[i]).toFixed(2).padEnd(10)} ${cells.join("")}`);
  });
  const txt = lines.join("\n");
  console.log(txt);
  fs.writeFileSync(path.join(outDir, "summary.txt"), txt + "\n");
  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify({ scene: sceneName, mag, nTrans, speed, renderer, summary }, null, 1));
  if (errors.length) console.log(`pageerror ${errors.length} 条：${errors[0]}`);
} finally {
  await closeBrowserSafely(browser);
  release();
}
