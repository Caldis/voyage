// DX-26：`dev-browser.mjs ab` 的三块扩展（从 ab.mjs 拆出来）：
//   1. ground 简写：job / 变体里写 "ground": { "demNightEdgeShared": false }，自动设开关 + rebuildAll + 等瓦片全部到位
//      （收编 handoff/G08c-seam.mjs 的 settled() 判据：pending 0、各级 valid 且不在建 / 不过期、上传队列空）；
//   2. cloudDump：每个变体读回云缓冲（history 左半 α / Y 的 N 帧平均，或 cloud-steps 变体的 raw 步数），给 cloud-metrics 算
//      按距离分带的边宽 / 对真值 α 分档（收编 handoff/C10-ab.mjs --bin 与 C10b-an.py）；
//   3. live：解冻、飞机照常飞，页内每个 rAF 读显示画布裁剪区（全部帧），逐帧记指定 uniform（如 uStrobe）与时间戳，
//      按「连续三帧都不被 skip 排除」的帧算时间二阶差分 |L_t − (L_{t−1}+L_{t+1})/2|，按区域出闪烁像素 / 每帧超阈值像素
//      （收编 handoff/W-LAMP-ab.mjs 的 live.all 与 W-LAMP-live.py --all）。
import fs from "node:fs";
import path from "node:path";
import { stepsStats } from "./cloud-metrics.mjs";

// ---------- 1. ground 简写 ----------
/** 等地面完全到位（G08c-seam 的 settled 判据）；返回 { ok, pending, ms } */
export async function groundSettle(page, timeoutMs = 120000) {
  return page.evaluate(async (tmo) => {
    const g = window.__voyage.ground;
    const t0 = performance.now();
    if (!g) return { ok: true, pending: null, ms: 0 };
    const settled = () => g.pending === 0 && (!g.levels || g.levels.every((l) => l.valid && !l.building && !l.stale)) && (!g.uploadQueue || g.uploadQueue.length === 0);
    while (!settled()) {
      if (performance.now() - t0 > tmo) return { ok: false, pending: g.pending, ms: performance.now() - t0 };
      await new Promise((r) => setTimeout(r, 250));
    }
    await new Promise((r) => setTimeout(r, 500));
    return { ok: true, pending: g.pending, ms: performance.now() - t0 };
  }, timeoutMs);
}

/** 读当前 ground 上这些开关的值 */
export async function readGround(page, keys) {
  return page.evaluate((keys) => {
    const g = window.__voyage.ground;
    if (!g) throw new Error("ground 简写：页面上没有 __voyage.ground");
    const out = {};
    for (const k of keys) {
      if (!(k in g)) throw new Error(`ground 简写：__voyage.ground 上没有开关 "${k}"`);
      out[k] = g[k];
    }
    return out;
  }, keys);
}

/** 把 ground 开关设成 want（与当前不同才动），变了就 rebuildAll 并等到位；返回 { changed, settle } */
export async function setGround(page, want, log, label = "") {
  if (!want || Object.keys(want).length === 0) return { changed: false };
  const changed = await page.evaluate((want) => {
    const g = window.__voyage.ground;
    if (!g) throw new Error("ground 简写：页面上没有 __voyage.ground");
    let ch = false;
    for (const [k, val] of Object.entries(want)) {
      if (!(k in g)) throw new Error(`ground 简写：__voyage.ground 上没有开关 "${k}"`);
      if (g[k] !== val) { g[k] = val; ch = true; }
    }
    if (ch) {
      if (typeof g.rebuildAll !== "function") throw new Error("ground 简写：__voyage.ground.rebuildAll 不存在");
      g.rebuildAll();
    }
    return ch;
  }, want);
  if (!changed) return { changed: false };
  await page.waitForTimeout(500);
  const st = await groundSettle(page);
  log(`  ground ${JSON.stringify(want)}${label ? `（${label}）` : ""}：rebuildAll 后等瓦片 ${(st.ms / 1000).toFixed(1)} s${st.ok ? "" : `，超时（pending=${st.pending}）`}`);
  return { changed: true, settle: st };
}

// ---------- 2. cloudDump ----------
/** 读回云缓冲。steps = true 读 raw 单帧 R 通道（cloud-steps 变体）；否则零运动预热 warm 帧后 history 左半 frames 帧平均 (α, Y) */
export async function dumpClouds(page, { steps, warm = 96, frames = 16 }) {
  return page.evaluate(({ steps, warm, frames }) => {
    const v = window.__voyage;
    const u = v.sceneMat.uniforms;
    const r = v.clouds.pass.renderer;
    const zero = v.clouds.resolveMat.uniforms.uMotion.value.clone().set(0, 0, 0);
    const R = () => v.clouds.render(zero, u.uCamBasis.value, u.uCabinToWorld.value);
    const b64 = (f32) => {
      const u8 = new Uint8Array(f32.buffer);
      let s = "";
      for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
      return btoa(s);
    };
    let out;
    if (steps) {
      v.clouds.snap();
      R();
      const t = v.clouds.raw;
      const W = t.width, H = t.height;
      const buf = new Float32Array(W * H * 4);
      r.readRenderTargetPixels(t, 0, 0, W, H, buf);
      const o = new Float32Array(W * H);
      for (let k = 0; k < o.length; k++) o[k] = buf[4 * k];
      const src = window.__dx.resolveLiveMaterial("clouds.marchMat").fragmentShader;
      const caps = [...src.matchAll(/i >= (\d{3,})\)+ break;/g)].map((m) => Number(m[1]));
      out = { W, H, ch: 1, kind: "steps", cap: caps.length ? Math.min(...caps) : null, marchKey: v.clouds.marchShown, data: b64(o) };
    } else {
      v.clouds.snap();
      for (let i = 0; i < warm; i++) R();
      const t0 = v.clouds.history[0];
      const CW = t0.width / 2, CH = t0.height;
      const full = new Float32Array(CW * CH * 4);
      const acc = new Float32Array(CW * CH * 2);
      for (let f = 0; f < frames; f++) {
        R();
        r.readRenderTargetPixels(v.clouds.history[0], 0, 0, CW, CH, full);
        for (let k = 0; k < CW * CH; k++) {
          acc[2 * k] += (1 - full[4 * k + 3]) / frames;
          acc[2 * k + 1] += (0.2126 * full[4 * k] + 0.7152 * full[4 * k + 1] + 0.0722 * full[4 * k + 2]) / frames;
        }
      }
      out = { W: CW, H: CH, ch: 2, kind: "history", warm, frames, marchKey: v.clouds.marchShown, data: b64(acc) };
    }
    u.uClouds.value = v.clouds.texture;
    return out;
  }, { steps, warm, frames });
}

/** 写 <name>.cloud.f32 / .cloud.json；steps 另出热图 PNG（借 anaPage 的 Canvas2D）与统计 */
export async function saveCloudDump(dir, name, d, anaPage, heatTop = null) {
  const data = Buffer.from(d.data, "base64");
  const meta = { ...d };
  delete meta.data;
  fs.writeFileSync(path.join(dir, `${name}.cloud.f32`), data);
  fs.writeFileSync(path.join(dir, `${name}.cloud.json`), JSON.stringify(meta));
  if (d.kind !== "steps") return { meta };
  const f32 = new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4);
  const st = stepsStats({ ...meta, data: f32 });
  if (anaPage) {
    const png = await anaPage.evaluate(({ b64, W, H, cap, top }) => {
      const bin = atob(b64);
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      const s = new Float32Array(u8.buffer);
      const c = document.createElement("canvas");
      c.width = W;
      c.height = H;
      const ctx = c.getContext("2d");
      const im = ctx.createImageData(W, H);
      // 色标上端 = 各变体共用的固定值（job.cloudDump.heatTop，默认步数上限的 1/3，便于同一 job 里几张热图直接对比），用满上限单独标品红
      // 0 步黑，往上 蓝 → 青 → 绿 → 黄 → 红，用满上限品红
      const ramp = [[0, 0, 0], [30, 60, 200], [0, 190, 220], [40, 200, 60], [240, 220, 30], [230, 40, 30]];
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          const v = s[(H - 1 - y) * W + x];
          const o = (y * W + x) * 4;
          let col;
          if (cap && v >= cap - 0.5) col = [255, 0, 255];
          else {
            const t = Math.min(1, v / top) * (ramp.length - 1);
            const i = Math.min(ramp.length - 2, Math.floor(t));
            const f = t - i;
            col = ramp[i].map((a, k) => a + (ramp[i + 1][k] - a) * f);
          }
          im.data[o] = col[0];
          im.data[o + 1] = col[1];
          im.data[o + 2] = col[2];
          im.data[o + 3] = 255;
        }
      ctx.putImageData(im, 0, 0);
      return c.toDataURL("image/png").split(",")[1];
    }, { b64: d.data, W: d.W, H: d.H, cap: d.cap, top: heatTop || (d.cap ? d.cap / 3 : Math.max(st.max, 1)) });
    fs.writeFileSync(path.join(dir, `${name}.steps.png`), Buffer.from(png, "base64"));
  }
  return { meta, steps: st };
}

// ---------- 3. live ----------
/** 页内逐帧录一个变体：返回 { w, h, frames: Buffer[]（RGBA 自上而下）, rec: { 名: 值[] }, t: 时间戳[] } */
export async function recordLive(page, { crop, frames, record }) {
  const info = await page.evaluate(async ({ crop, frames, record }) => {
    const v = window.__voyage;
    const gl = v.clouds.pass.renderer.getContext();
    const cv = gl.canvas;
    const sx = gl.drawingBufferWidth / cv.clientWidth, sy = gl.drawingBufferHeight / cv.clientHeight;
    const w = Math.round(crop[2] * sx), h = Math.round(crop[3] * sy);
    const x = Math.round(crop[0] * sx), y = gl.drawingBufferHeight - Math.round((crop[1] + crop[3]) * sy);
    const getters = Object.entries(record || {}).map(([k, p]) => [k, () => p.split(".").reduce((o, kk) => (o == null ? o : o[kk]), v)]);
    for (const [k, g] of getters) if (typeof g() !== "number") throw new Error(`live.record "${k}"：路径解析不到数字（${record[k]}）`);
    const store = { w, h, frames: [], rec: Object.fromEntries(getters.map(([k]) => [k, []])), t: [] };
    const buf = new Uint8Array(w * h * 4);
    for (let f = 0; f < frames; f++) {
      const now = await new Promise((r) => requestAnimationFrame(r)); // 主循环的回调先注册，这里读到的是本帧刚画完的画面
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      const flip = new Uint8Array(w * h * 4);
      for (let r = 0; r < h; r++) flip.set(buf.subarray((h - 1 - r) * w * 4, (h - r) * w * 4), r * w * 4);
      store.frames.push(flip);
      for (const [k, g] of getters) store.rec[k].push(g());
      store.t.push(now);
    }
    window.__dxLive = store;
    return { w, h, n: store.frames.length, rec: store.rec, t: store.t };
  }, { crop, frames, record });
  const out = [];
  for (let i = 0; i < info.n; i += 40) {
    const b64 = await page.evaluate(({ i }) => {
      const L = window.__dxLive;
      const part = L.frames.slice(i, i + 40);
      const all = new Uint8Array(part.reduce((a, b) => a + b.length, 0));
      let o = 0;
      for (const p of part) { all.set(p, o); o += p.length; }
      let s = "";
      for (let k = 0; k < all.length; k += 0x8000) s += String.fromCharCode.apply(null, all.subarray(k, k + 0x8000));
      return btoa(s);
    }, { i });
    const b = Buffer.from(b64, "base64");
    const fsz = info.w * info.h * 4;
    for (let k = 0; k < b.length; k += fsz) out.push(b.subarray(k, k + fsz));
  }
  await page.evaluate(() => { window.__dxLive = null; });
  return { w: info.w, h: info.h, frames: out, rec: info.rec, t: info.t };
}

/** 时间二阶差分区统计。regions: { 名: [x, y, w, h] }（相对裁剪区，显示像素 × DPR 后的缓冲像素）；
 * skip：表达式字符串（变量 = record 的键），为真的帧不参与；只用「前一帧、本帧、后一帧都不 skip」的帧。
 * 闪烁像素 = 二阶差 > thr 的帧占比 > frac 的像素（W-LAMP 审查口径 thr 16、frac 5%） */
export function liveStats(L, { regions, skip, thr = 16, frac = 0.05, scale = 1 }) {
  const { w, h, frames, rec, t } = L;
  const n = frames.length;
  const lum = frames.map((f) => {
    const o = new Float32Array(w * h);
    for (let k = 0; k < o.length; k++) o[k] = 0.2126 * f[4 * k] + 0.7152 * f[4 * k + 1] + 0.0722 * f[4 * k + 2];
    return o;
  });
  const keys = Object.keys(rec);
  const skipFn = skip ? new Function(...keys, `return (${skip});`) : null;
  const skipped = Array.from({ length: n }, (_, i) => (skipFn ? Boolean(skipFn(...keys.map((k) => rec[k][i]))) : false));
  const idx = [];
  for (let i = 1; i < n - 1; i++) if (!skipped[i - 1] && !skipped[i] && !skipped[i + 1]) idx.push(i);
  const over = new Uint16Array(w * h);
  const overPerFrame = [];
  let sumD2 = 0;
  for (const i of idx) {
    const a = lum[i - 1], b = lum[i], c = lum[i + 1];
    let cnt = 0;
    for (let k = 0; k < w * h; k++) {
      const d2 = Math.abs(b[k] - 0.5 * (a[k] + c[k]));
      sumD2 += d2;
      if (d2 > thr) { over[k]++; cnt++; }
    }
    overPerFrame.push(cnt);
  }
  const regs = regions && Object.keys(regions).length ? regions : { 全部: [0, 0, w / scale, h / scale] };
  const out = {};
  for (const [name, r] of Object.entries(regs)) {
    const x0 = Math.max(0, Math.round(r[0] * scale)), y0 = Math.max(0, Math.round(r[1] * scale));
    const x1 = Math.min(w, Math.round((r[0] + r[2]) * scale)), y1 = Math.min(h, Math.round((r[1] + r[3]) * scale));
    let flickPx = 0, px = 0, sOver = 0;
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const k = y * w + x;
        px++;
        sOver += over[k];
        if (idx.length && over[k] / idx.length > frac) flickPx++;
      }
    out[name] = { px, flickerPx: flickPx, overPerFrame: idx.length ? +(sOver / idx.length).toFixed(2) : null };
  }
  const dts = t.slice(1).map((x, i) => x - t[i]).sort((a, b) => a - b);
  let meanL = 0;
  for (const f of lum) for (let k = 0; k < f.length; k++) meanL += f[k];
  meanL /= Math.max(1, n * w * h);
  return {
    frames: n,
    used: idx.length,
    skipped: skipped.filter(Boolean).length,
    meanD2: idx.length ? +(sumD2 / (idx.length * w * h)).toFixed(3) : null,
    meanLuma: +meanL.toFixed(2),
    dtMedian: dts.length ? +dts[Math.floor(dts.length / 2)].toFixed(2) : null,
    dtMax: dts.length ? +dts[dts.length - 1].toFixed(2) : null,
    regions: out,
  };
}

/** 一个 job 的 live 段：对每个变体套用、解冻、录帧、存文件、算统计。返回 { 变体名: stats } */
export async function runLive(page, job, resolved, { setWingStrobe, log, jdir, dpr }) {
  const L = job.live;
  if (!L.crop) throw new Error(`job "${job.name}" 的 live 需要 crop [x,y,w,h]（显示像素）`);
  const names = L.variants || resolved.map((va) => va.name);
  const out = {};
  await page.evaluate(() => window.__voyage.freeze(false));
  for (const name of names) {
    const va = resolved.find((x) => x.name === name);
    if (!va) throw new Error(`job "${job.name}" 的 live.variants 里有不存在的变体 "${name}"`);
    await page.evaluate((va) => window.__dx.apply(va), va);
    await setWingStrobe(page, L.strobe === undefined ? null : L.strobe);
    await page.evaluate((n) => new Promise((r) => { let k = 0; const f = () => (++k >= n ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }), L.settle ?? 30);
    const t0 = Date.now();
    const rec = await recordLive(page, { crop: L.crop, frames: L.frames ?? 240, record: L.record || {} });
    fs.writeFileSync(path.join(jdir, `live_${name}_${rec.w}x${rec.h}.u8`), Buffer.concat(rec.frames));
    fs.writeFileSync(path.join(jdir, `live_${name}_flags.json`), JSON.stringify({ ...rec.rec, t: rec.t }));
    const st = liveStats(rec, { regions: L.regions, skip: L.skip, thr: L.thr ?? 16, frac: L.frac ?? 0.05, scale: dpr || 1 });
    out[name] = st;
    log(`  live ${name}：${st.frames} 帧（${((Date.now() - t0) / 1000).toFixed(1)} s，参与二阶差分 ${st.used}、skip ${st.skipped}，帧间隔中位 ${st.dtMedian} ms）`);
  }
  await setWingStrobe(page, 0);
  await page.evaluate(() => window.__voyage.freeze(true));
  return out;
}

export function printLive(jobName, live, L) {
  const regNames = Object.keys(Object.values(live)[0]?.regions || {});
  console.log(`\n== ${jobName} live（裁剪 ${L.crop.join(",")}，二阶差分阈值 ${L.thr ?? 16} 级，闪烁像素 = 超阈值帧占比 > ${((L.frac ?? 0.05) * 100).toFixed(0)}%${L.skip ? `，排除 ${L.skip} 的帧及其前后帧` : ""}）`);
  console.log(`| 变体 | 帧 / 参与 | 平均二阶差 | 亮度 | 帧间隔中位 / 最大 ms | ${regNames.map((r) => `${r} 闪烁像素 / 每帧超阈值`).join(" | ")} |`);
  console.log(`|---|---|---:|---:|---|${regNames.map(() => "---|").join("")}`);
  for (const [name, s] of Object.entries(live)) {
    console.log(`| ${name} | ${s.frames} / ${s.used} | ${s.meanD2} | ${s.meanLuma} | ${s.dtMedian} / ${s.dtMax} | ${regNames.map((r) => `${s.regions[r].flickerPx} / ${s.regions[r].overPerFrame}`).join(" | ")} |`);
  }
}
