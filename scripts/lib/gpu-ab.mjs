// DX-26：`dev-browser.mjs gpu-ab`——同页、GPU 计时查询（EXT_disjoint_timer_query_webgl2）、多轮配对的变体计时。
// 收编 handoff/C10b-time.mjs（C10b：同页交替换云步进片段、计时查询包住 N 次 clouds.render、多轮取中位 / 配对比），
// 替代 passes.mjs 在负载下的不可靠比较（passes 每个变体各跑一遍场景、不配对，负载漂移直接进差值；程序切换只看字面材质，
// C10 就因为改的材质不是这一帧实际画的那个，量到「GPU 持平」的假结论）。
//
// 变体格式与 ab 相同（materials / patch / defines / uniforms / js / builtin / ground），job 格式也同 ab（name、scene、offset、head、pre、ground、variants）。
// 每个 job：摆场景 → 冻结 → 每轮按 A,B,C… / …,C,B,A 交替（ABBA，抵消单向漂移）套用变体 → 预热 → 计时查询包住 N 次「被计时的动作」：
//   --time clouds  N 次 clouds.render（云步进 + resolve；全冻结，rAF 不画云，查询里只有这 N 次）
//   --time frame   benchFrame(N)（整帧，含云：cloudLive 冻结）
//   --time wing | scene   benchWing(N) / benchScene(N)
//   默认：变体碰了 clouds.* 就是 clouds，否则 frame。
// 程序切换核对（切换失败直接报错，不出数字）：
//   ① 两个变体在同一材质上着色器文本（含 defines）不同，但绑定的 WebGLProgram 编号相同 → 报错「程序没切换」；
//   ② 计时区间里，变体改过的材质一次都没画到（改错了材质 / 这一帧实际画的是另一个步进变体）→ 报错，并列出区间里实际画了哪些材质；
//   ③ 所有变体文本都相同（只改 uniform / js）→ 提示一句，不报错。
// 统计：每个变体每轮一个样本（ms / 次）；报中位、最小、四分位距 / 中位（离散度）；对第一个变体逐轮配对比的中位与四分位，
// 四分位区间不跨 1、且中位偏离超过 max(3%, 基准自身离散 / 2) 才标「显著」，否则「在离散度内」；
// 想要直接的噪声底就加一个与基准相同的变体（如 { "name": "cur2" }），它的配对比就是 A/A。持测量锁（外层已持锁时不再等，见 lib/measure-lock.mjs）。
import fs from "node:fs";
import path from "node:path";
import { DEFAULTS, applyScene, pinGeometry } from "../scenarios.mjs";
import { resolveRepoPath } from "./chrome.mjs";
import { acquireOrWait } from "./measure-lock.mjs";
import { sampleAndWarn } from "./cpu-load.mjs";
import { readJson, sceneOf, installVariantLib, resolveSources, collectPaths, validateVariants, raf } from "./ab.mjs";
import { setGround, groundSettle, readGround } from "./ab-live.mjs";

function installGpuTimer() {
  const v = window.__voyage;
  window.__gab = {
    async time({ kind, n, warm, watch }) {
      const pass = v.clouds.pass;
      const r = pass.renderer;
      const gl = r.getContext();
      if (gl.isContextLost()) return { err: "渲染器的 WebGL 上下文已丢失（CONTEXT_LOST_WEBGL），重开浏览器再测" };
      const ext = gl.getExtension("EXT_disjoint_timer_query_webgl2");
      if (!ext) return { err: "没有 EXT_disjoint_timer_query_webgl2（软渲染？）" };
      const u = v.sceneMat.uniforms;
      const zero = v.clouds.resolveMat.uniforms.uMotion.value.clone().set(0, 0, 0);
      const step =
        kind === "clouds" ? (k) => { for (let i = 0; i < k; i++) v.clouds.render(zero, u.uCamBasis.value, u.uCabinToWorld.value); }
        : kind === "frame" ? (k) => v.benchFrame(k)
        : kind === "wing" ? (k) => v.benchWing(k)
        : kind === "scene" ? (k) => v.benchScene(k)
        : null;
      if (!step) return { err: `--time 不认识 "${kind}"` };
      for (let i = 0; i < warm; i++) {
        step(1);
        await new Promise((res) => requestAnimationFrame(res));
      }
      // 计时区间里每个材质画了几次（核对 ②）
      const counts = new Map();
      const orig = pass.render;
      pass.render = function (m, t, l) {
        counts.set(m, (counts.get(m) || 0) + 1);
        return orig.call(this, m, t, l);
      };
      const px = new Uint8Array(4);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); // 先把队列里的活排空，查询里只有下面这 n 次
      const q = gl.createQuery();
      gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
      try {
        step(n);
      } finally {
        gl.endQuery(ext.TIME_ELAPSED_EXT);
        pass.render = orig;
      }
      const t0 = performance.now();
      while (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) {
        if (performance.now() - t0 > 5000) { gl.deleteQuery(q); return { err: "查询 5 s 未返回结果" }; }
        await new Promise((res) => requestAnimationFrame(res));
      }
      const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
      const ns = gl.getQueryParameter(q, gl.QUERY_RESULT);
      gl.deleteQuery(q);
      if (u.uClouds) u.uClouds.value = v.clouds.texture;
      const drawn = {};
      for (const p of watch) {
        const m = window.__dx.mat(p);
        drawn[p] = { n: counts.get(m) || 0, prog: r.properties.get(m)?.currentProgram?.id ?? null };
      }
      const known = [["sceneMat", v.sceneMat], ["outsideMat", v.outsideMat], ["wingMat", v.wingMat], ["wingMat.wet", v.wingVariant && v.wingVariant.wet], ["seatMat", v.seatMat], ["clouds.resolveMat", v.clouds.resolveMat], ["clouds.marchMat(默认变体)", v.clouds.marchMat], ["exposure.finalMat", v.exposure && v.exposure.finalMat], ["exposure.meterMat", v.exposure && v.exposure.meterMat], ["exposure.adaptMat", v.exposure && v.exposure.adaptMat]];
      const nameOf = (m) => (known.find(([, x]) => x === m) || [m.name || m.type])[0];
      const seen = [...counts.entries()].map(([m, c]) => `${nameOf(m)}×${c}`);
      return { ms: disjoint ? null : ns / 1e6 / n, disjoint: Boolean(disjoint), drawn, seen, marchKey: v.clouds.marchShown };
    },
  };
}

const q = (xs, p) => {
  const s = xs.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const i = (s.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
};
const f3 = (x) => (x == null ? "—" : x.toFixed(3));

export async function cmdGpuAb(args, h) {
  const { REPO_ROOT, openPage, launchBrowser, setFlashDisabled, setWingStrobe, resolveBaseShaderSource, parseViewport, parseDpr, parseExtraQuery, setQualityTier, log } = h;
  const port = args.port;
  if (!port) throw new Error("gpu-ab 需要 --port <端口>");
  const angle = String(args.angle || "d3d11");
  const viewport = parseViewport(args);
  const dpr = parseDpr(args);
  const jobs = readJson(REPO_ROOT, args.jobs, "--jobs");
  if (!Array.isArray(jobs) || jobs.length === 0) throw new Error("--jobs 应该是非空数组");
  const variantsRaw = args.variants ? readJson(REPO_ROOT, args.variants, "--variants") : null;
  for (const j of jobs) {
    if (!j.name) throw new Error("--jobs：每个 job 都要有 name");
    sceneOf(j);
    if (j.variants) validateVariants(j.variants, `job "${j.name}" 的 variants`);
  }
  if (variantsRaw) validateVariants(variantsRaw, "--variants");
  if (!variantsRaw && jobs.some((j) => !j.variants)) throw new Error("没给 --variants 时，每个 job 都要自带 variants");
  const rounds = Number(args.rounds || 8);
  const n = Number(args.n || 20);
  const warm = Number(args.warm || 6);
  const outDir = resolveRepoPath(REPO_ROOT, args.out || `tmp/screenshot/gpu-ab-${port}`);
  fs.mkdirSync(outDir, { recursive: true });

  const release = await acquireOrWait(REPO_ROOT, `dev-browser.mjs gpu-ab（端口 ${port}, pid ${process.pid}）`, log);
  const browser = await launchBrowser(angle);
  const summary = [];
  try {
    const baseSource = async (matPath) => {
      if (!args.base) throw new Error(`变体里有来源 "base"，需要 --base <对照端口>`);
      return resolveBaseShaderSource(String(args.base), matPath, { browser, angle });
    };
    const { page, renderer, errors } = await openPage(browser, port, angle, viewport, dpr, { collectErrors: true, extraQuery: parseExtraQuery(args) });
    log(`gpu-ab --angle=${angle}  viewport=${viewport.width}x${viewport.height}  GL_RENDERER = ${renderer}  每样本 ${n} 次、${rounds} 轮 ABBA 交替`);
    await setQualityTier(page, args.quality);
    await setFlashDisabled(page, true);
    await page.evaluate(installVariantLib);
    await page.evaluate(installGpuTimer);
    for (const job of jobs) {
      const variants = job.variants || variantsRaw;
      const sc = sceneOf(job);
      const resolved = await resolveSources(variants, { baseSource, repoRoot: REPO_ROOT });
      const { mats, unis } = collectPaths(variants);
      const kind = String(job.time || args.time || (mats.some((p) => p.startsWith("clouds.")) ? "clouds" : "frame"));
      await page.evaluate(applyScene, { sc, defaults: DEFAULTS, settle: Boolean(sc.ground) });
      await page.evaluate(pinGeometry, sc);
      if (job.pre) await page.evaluate((code) => new (async () => {}).constructor("v", code)(window.__voyage), job.pre);
      await raf(page, 90); // 后台变体（天气步进 / 湿窗）先编好
      // clouds：全冻结（rAF 不画云，查询里只有手动的 N 次）；frame：cloudLive（benchFrame 才会画云）
      await page.evaluate((cl) => window.__voyage.freeze(true, { cloudLive: cl }), kind === "frame");
      await setWingStrobe(page, 0);
      if (job.ground) await setGround(page, job.ground, log, "job");
      if (sc.ground || job.ground) await groundSettle(page, 120000);
      await page.evaluate(({ mats, unis }) => window.__dx.prepare(mats, unis), { mats, unis });
      const groundKeys = [...new Set(resolved.flatMap((va) => Object.keys(va.ground || {})))];
      const groundOrig = groundKeys.length ? await readGround(page, groundKeys) : null;
      if (mats.length === 0) log(`  [提示] ${job.name}：变体没有碰任何材质（只改 uniform / js），跳过程序切换核对`);

      const samples = Object.fromEntries(resolved.map((va) => [va.name, []]));
      const progs = {}; // 变体名 -> { 路径: { id, hash } }
      let lastSeen = null;
      const load0 = sampleAndWarn(`gpu-ab ${job.name} 开始`);
      const t0 = Date.now();
      for (let r = 0; r < rounds; r++) {
        const order = r % 2 === 0 ? resolved : [...resolved].reverse();
        for (const va of order) {
          if (groundOrig) await setGround(page, { ...groundOrig, ...(va.ground || {}) }, log, va.name);
          const res = await page.evaluate((va) => window.__dx.apply(va), va);
          // ① 同一变体各轮绑定的程序应一致；不同文本的变体程序必须不同（最后统一核对）
          if (!progs[va.name]) progs[va.name] = res.programs;
          const t = await page.evaluate((o) => window.__gab.time(o), { kind, n, warm, watch: mats });
          if (t.err) throw new Error(`gpu-ab ${job.name}/${va.name}：${t.err}`);
          // ② 计时区间里必须真的画到了被改的材质
          for (const p of mats) {
            if (t.drawn[p].n === 0)
              throw new Error(
                `gpu-ab ${job.name}/${va.name}：计时区间（--time ${kind}）里一次都没画到被改的材质 "${p}"——量到的不是这个变体。` +
                  `区间里实际画了：${t.seen.join("、") || "（无）"}；云步进当前变体键 "${t.marchKey}"。改错材质了？（云步进请用 clouds.marchMat，它指当前实际画的变体）`,
              );
            if (t.drawn[p].prog !== res.programs[p].id) throw new Error(`gpu-ab ${job.name}/${va.name}：材质 "${p}" 计时时绑定的程序 #${t.drawn[p].prog} 不是套用变体后编好的 #${res.programs[p].id}（计时中途被换了程序？）`);
          }
          samples[va.name].push(t.ms);
          lastSeen = t;
        }
      }
      // ① 程序切换核对
      const names = resolved.map((va) => va.name);
      for (const p of mats) {
        for (let i = 0; i < names.length; i++)
          for (let k = i + 1; k < names.length; k++) {
            const a = progs[names[i]][p], b = progs[names[k]][p];
            if (a.hash !== b.hash && a.id === b.id)
              throw new Error(`gpu-ab ${job.name}：材质 "${p}" 上变体 "${names[i]}" 与 "${names[k]}" 着色器文本不同，却绑定同一个程序 #${a.id}——程序没切换，计时不可信`);
          }
        if (names.every((nm) => progs[nm][p].hash === progs[names[0]][p].hash) && names.length > 1)
          log(`  [提示] ${job.name}：材质 "${p}" 在所有变体里着色器文本都相同（只差 uniform / js / 来源相同），程序 #${progs[names[0]][p].id}`);
      }
      await page.evaluate(() => { window.__dx.restore(); window.__voyage.freeze(false); });
      await setWingStrobe(page, null);
      if (groundOrig) await setGround(page, groundOrig, log, "复原");
      const load1 = sampleAndWarn(`gpu-ab ${job.name} 结束`);

      const base = names[0];
      const rows = {};
      // 判定门槛：配对比的四分位区间不跨 1，且中位偏离 1 超过 max(3%, 基准变体自身离散的一半)——
      // 负载下 4 轮时实测出过 ×1.20 的假「显著」（noon-cumulus 上 cap384 本应无变化），所以同时要求幅度过门槛
      const baseIqr = (q(samples[base], 0.75) - q(samples[base], 0.25)) / (q(samples[base], 0.5) || 1);
      const gate = Math.max(0.03, 0.5 * (Number.isFinite(baseIqr) ? baseIqr : 0));
      if (rounds < 6) log(`  [提示] ${job.name}：只有 ${rounds} 轮，配对比的四分位不稳，结论请用 --rounds ≥ 8 复测`);
      for (const nm of names) {
        const xs = samples[nm];
        const med = q(xs, 0.5);
        const ratios = xs.map((x, i) => (x != null && samples[base][i] != null ? x / samples[base][i] : null)).filter((x) => x != null);
        const rq = [q(ratios, 0.25), q(ratios, 0.5), q(ratios, 0.75)];
        rows[nm] = {
          n: xs.filter((x) => x != null).length,
          disjoint: xs.filter((x) => x == null).length,
          median: med,
          min: q(xs, 0),
          iqrRel: med ? (q(xs, 0.75) - q(xs, 0.25)) / med : null,
          ratio:
            nm === base
              ? null
              : { p25: rq[0], median: rq[1], p75: rq[2], gate, verdict: rq[0] == null ? "—" : rq[0] > 1 && rq[1] > 1 + gate ? "显著变慢" : rq[2] < 1 && rq[1] < 1 - gate ? "显著变快" : "在离散度内" },
          programs: progs[nm],
          samples: xs,
        };
      }
      console.log(`\n== ${job.name}（--time ${kind}，每样本 ${n} 次取平均、${rounds} 轮 ABBA；云步进变体键 "${lastSeen?.marchKey ?? ""}"；${((Date.now() - t0) / 1000).toFixed(0)} s；CPU ${load0 == null ? "?" : load0.toFixed(0)}% → ${load1 == null ? "?" : load1.toFixed(0)}%）`);
      console.log(`| 变体 | 中位 ms | 最小 ms | 离散（IQR/中位） | 对 ${base} 配对比 中位 [p25, p75] | 判定（门槛 ±${(100 * gate).toFixed(1)}%） | 程序 # | disjoint |`);
      console.log("|---|---:|---:|---:|---|---|---|---:|");
      for (const nm of names) {
        const r = rows[nm];
        const pr = Object.entries(r.programs || {}).map(([p, x]) => `${p}#${x.id}`).join(" ");
        console.log(`| ${nm} | ${f3(r.median)} | ${f3(r.min)} | ${r.iqrRel == null ? "—" : (100 * r.iqrRel).toFixed(1) + "%"} | ${r.ratio ? `×${f3(r.ratio.median)} [${f3(r.ratio.p25)}, ${f3(r.ratio.p75)}]` : "（基准）"} | ${r.ratio ? r.ratio.verdict : ""} | ${pr || "—"} | ${r.disjoint} |`);
      }
      summary.push({ job: job.name, scene: sc.name, time: kind, n, rounds, marchKey: lastSeen?.marchKey ?? null, cpu: [load0, load1], rows });
      fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
    }
    log(`完成，输出 ${path.relative(REPO_ROOT, outDir).replace(/\\/g, "/")}/summary.json；console error ${errors.length} 条`);
    for (const e of errors.slice(0, 5)) console.error(`  [${e.type}] ${e.text.slice(0, 300)}`);
    return summary;
  } finally {
    await h.closeBrowserSafely(browser);
    release();
  }
}
