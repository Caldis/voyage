// DX-26：云缓冲读回（ab 的 job.cloudDump）的固定指标，收编 handoff/C10b-an.py（口径同 C10-edge.py）：
//   - 按距离分带的云边宽度：在 α（不透明度 1 − T）0.4–0.6、梯度 > 0.02 的像素上沿梯度方向取剖面（±16 px、步长 0.25），
//     边宽 = 从 α ≤ 0.1 到 α ≥ 0.9 的距离（px，云缓冲像素）；距离来自 cloud-dist 变体（Y/α = 深度 km），分 0–10 / 10–20 / 20–40 / 40–80 / 80+ km；
//   - 对细步真值（cloud-ref 变体）的 α 分档比值：真值 α 落在 0.01–0.1 / 0.1–0.3 / 0.3–0.6 / 0.6–0.9 的像素上，变体 α 均值 ÷ 真值 α 均值
//     （< 1 = 薄处偏透，C10 的「近处空白步走 2dt 漏掉薄边」就是这一档掉下去）；
//   - 云区 |Δα|、亮度总量比 Y 比、云区 |ΔY|/Y。
// 文件格式（ab 写的）：<目录>/<变体>.cloud.f32（float32，H×W×ch，GL 左下原点、逐行自下而上）+ <变体>.cloud.json { W, H, ch, kind }；
// kind = "history"（ch 2：α、Y）或 "steps"（ch 1：步数）。
// compare.mjs --cloud-dir 与 ab 跑完 job 后都调这里的 cloudMetrics / printCloudMetrics。
import fs from "node:fs";
import path from "node:path";

export const DIST_BANDS = [
  [0, 10],
  [10, 20],
  [20, 40],
  [40, 80],
  [80, Infinity],
];
export const ALPHA_BINS = [
  [0.01, 0.1],
  [0.1, 0.3],
  [0.3, 0.6],
  [0.6, 0.9],
];

/** 读一个变体的云缓冲读回；翻成自上而下；返回 { W, H, ch, kind, data } 或 null */
export function loadCloudDump(dir, name) {
  const f = path.join(dir, `${name}.cloud.f32`);
  const j = path.join(dir, `${name}.cloud.json`);
  if (!fs.existsSync(f) || !fs.existsSync(j)) return null;
  const meta = JSON.parse(fs.readFileSync(j, "utf8"));
  const b = fs.readFileSync(f);
  const src = new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
  const { W, H, ch } = meta;
  const data = new Float32Array(W * H * ch);
  for (let y = 0; y < H; y++) data.set(src.subarray((H - 1 - y) * W * ch, (H - y) * W * ch), y * W * ch);
  return { ...meta, data };
}

function channel(d, c) {
  const out = new Float32Array(d.W * d.H);
  for (let k = 0; k < out.length; k++) out[k] = d.data[k * d.ch + c];
  return out;
}

function bil(img, W, H, x, y) {
  x = Math.min(Math.max(x, 0), W - 1.001);
  y = Math.min(Math.max(y, 0), H - 1.001);
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const i = y0 * W + x0;
  return img[i] * (1 - fx) * (1 - fy) + img[i + 1] * fx * (1 - fy) + img[i + W] * (1 - fx) * fy + img[i + W + 1] * fx * fy;
}

/** 云边宽度（C10-edge 口径）：返回 [{ x, y, w }]，w = NaN 表示剖面里找不到 0.1 / 0.9 两端 */
export function edgeWidths(a, W, H, maxN = 30000) {
  const pts = [];
  for (let y = 1; y < H - 1; y++)
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      const v = a[i];
      if (v < 0.4 || v > 0.6) continue;
      const gx = (a[i + 1] - a[i - 1]) * 2 + (a[i - W + 1] - a[i - W - 1]) + (a[i + W + 1] - a[i + W - 1]);
      const gy = (a[i + W] - a[i - W]) * 2 + (a[i + W - 1] - a[i - W - 1]) + (a[i + W + 1] - a[i - W + 1]);
      const g = Math.hypot(gx, gy) / 8;
      if (g > 0.02) pts.push([x, y, gx / (g * 8), gy / (g * 8)]);
    }
  // 太多就等间隔抽样（确定性，C10b-an.py 用固定种子随机抽样，统计上等价）
  const step = pts.length > maxN ? pts.length / maxN : 1;
  const S = [];
  for (let s = -16; s <= 16.001; s += 0.25) S.push(s);
  const c = Math.floor(S.length / 2);
  const out = [];
  for (let q = 0; q < pts.length; q += step) {
    const [x, y, nx, ny] = pts[Math.floor(q)];
    const P = S.map((s) => bil(a, W, H, x + s * nx, y + s * ny));
    let lo = -1, hi = -1;
    for (let k = 0; k < c; k++) if (P[k] <= 0.1) lo = k;
    for (let k = c; k < S.length; k++) if (P[k] >= 0.9) { hi = k; break; }
    out.push({ x, y, w: lo >= 0 && hi >= 0 ? S[hi] - S[lo] : NaN });
  }
  return out;
}

const median = (xs) => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((p, q) => p - q);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};
const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN;
};

/** 一个目录下多个变体对真值（ref）的指标；dist 可省（省了就没有按距离分带） */
export function cloudMetrics(dir, { ref, dist = null, variants }) {
  const R = loadCloudDump(dir, ref);
  if (!R) throw new Error(`云读回：${dir} 里没有真值变体 "${ref}" 的 .cloud.f32（job 要带 cloudDump，变体要跑过）`);
  if (R.kind !== "history") throw new Error(`云读回：真值 "${ref}" 的 kind 是 ${R.kind}，应为 history`);
  const { W, H } = R;
  const ar = channel(R, 0), yr = channel(R, 1);
  let D = null;
  if (dist) {
    const Dd = loadCloudDump(dir, dist);
    if (Dd && Dd.W === W && Dd.H === H) {
      const da = channel(Dd, 0), dy = channel(Dd, 1);
      D = new Float32Array(W * H);
      for (let k = 0; k < D.length; k++) D[k] = dy[k] / Math.max(da[k], 1e-4);
    }
  }
  const res = { ref, dist: D ? dist : null, W, H, edgeDistPct: null, rows: {} };
  if (D) {
    const ds = [];
    for (let k = 0; k < ar.length; k++) if (ar[k] > 0.05 && ar[k] < 0.95) ds.push(D[k]);
    res.edgeDistPct = [0.1, 0.25, 0.5, 0.75, 0.9].map((p) => +pct(ds, p).toFixed(1));
  }
  for (const name of [...variants.filter((n) => n !== ref), ref]) {
    const X = loadCloudDump(dir, name);
    if (!X || X.kind !== "history" || X.W !== W || X.H !== H) continue;
    const a = channel(X, 0), y = channel(X, 1);
    const E = edgeWidths(a, W, H);
    const bands = D
      ? DIST_BANDS.map(([lo, hi]) => {
          const ws = E.filter((e) => Number.isFinite(e.w) && D[e.y * W + e.x] >= lo && D[e.y * W + e.x] < hi).map((e) => e.w);
          return { lo, hi, n: ws.length, median: ws.length > 30 ? +median(ws).toFixed(2) : null };
        })
      : null;
    const alphaBins = ALPHA_BINS.map(([lo, hi]) => {
      let sa = 0, sr = 0, n = 0;
      for (let k = 0; k < ar.length; k++) if (ar[k] >= lo && ar[k] < hi) { sa += a[k]; sr += ar[k]; n++; }
      return { lo, hi, n, ratio: n ? +(sa / Math.max(sr, 1e-9)).toFixed(3) : null };
    });
    let dA = 0, dY = 0, sYr = 0, nC = 0, sY = 0, sYall = 0;
    for (let k = 0; k < ar.length; k++) {
      sY += y[k];
      sYall += yr[k];
      if (ar[k] > 0.01 || a[k] > 0.01) { dA += Math.abs(a[k] - ar[k]); dY += Math.abs(y[k] - yr[k]); sYr += yr[k]; nC++; }
    }
    res.rows[name] = {
      edgeMedian: +median(E.map((e) => e.w)).toFixed(2),
      edgeN: E.filter((e) => Number.isFinite(e.w)).length,
      bands,
      alphaBins,
      dAlpha: nC ? +(dA / nC).toFixed(4) : null,
      yRatio: +(sY / Math.max(sYall, 1e-12)).toFixed(3),
      dYrel: nC ? +(dY / Math.max(sYr, 1e-12)).toFixed(3) : null,
    };
  }
  return res;
}

export function printCloudMetrics(res, title = "") {
  const lines = [];
  lines.push(`== 云读回指标${title ? `：${title}` : ""}（真值 ${res.ref}${res.dist ? `，距离来自 ${res.dist}` : "，没有 cloud-dist 变体、不分带"}；边宽单位 = 云缓冲像素）`);
  if (res.edgeDistPct) lines.push(`  云边像素（真值 α 0.05–0.95）距离 km 分位 p10/25/50/75/90：${res.edgeDistPct.join(" / ")}`);
  const bandHdr = res.dist ? DIST_BANDS.map(([lo, hi]) => `边宽 ${lo}–${hi === Infinity ? "∞" : hi} km`).join(" | ") + " | " : "";
  lines.push(`| 变体 | 边宽中位（n） | ${bandHdr}${ALPHA_BINS.map(([lo, hi]) => `α/真值 ${lo}–${hi}`).join(" | ")} | 云区 |Δα| | Y 比 | 云区 |ΔY|/Y |`);
  const nCols = 1 + (res.dist ? DIST_BANDS.length : 0) + ALPHA_BINS.length + 3;
  lines.push(`|---|${"---:|".repeat(nCols)}`);
  for (const [name, r] of Object.entries(res.rows)) {
    const bands = r.bands ? r.bands.map((b) => (b.median == null ? `—（${b.n}）` : `${b.median}（${b.n}）`)).join(" | ") + " | " : "";
    lines.push(`| ${name}${name === res.ref ? "（真值）" : ""} | ${r.edgeMedian}（${r.edgeN}） | ${bands}${r.alphaBins.map((b) => (b.ratio == null ? "—" : b.ratio)).join(" | ")} | ${r.dAlpha} | ${r.yRatio} | ${r.dYrel} |`);
  }
  console.log(lines.join("\n"));
  return lines.join("\n");
}

/** 步数用量读回（kind = steps）的统计：均值 / 分位 / 用满上限的像素占比 */
export function stepsStats(d) {
  const s = channel(d, 0);
  const xs = [];
  for (let k = 0; k < s.length; k++) if (s[k] > 0) xs.push(s[k]);
  xs.sort((a, b) => a - b);
  const q = (p) => (xs.length ? xs[Math.min(xs.length - 1, Math.floor(p * xs.length))] : 0);
  const cap = d.cap || null;
  const atCap = cap ? xs.filter((x) => x >= cap - 0.5).length : null;
  return {
    px: xs.length,
    mean: xs.length ? +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1) : 0,
    p50: q(0.5),
    p90: q(0.9),
    p99: q(0.99),
    max: xs.length ? xs[xs.length - 1] : 0,
    cap,
    atCapPct: cap && xs.length ? +((100 * atCap) / xs.length).toFixed(2) : null,
  };
}
