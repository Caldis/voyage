// FOCUS-ZOOM：交互验收（真实鼠标 / 键盘 / 触摸事件，Playwright）。
//   node apps/voyage/handoff/FOCUS-ZOOM-input.mjs [--port 5264] [--out tmp/screenshot/focus-zoom/input]
// 逐项打印「期望 / 实测 / 对错」，逐帧曲线写到 <out>/curves.json：
//   1 按住不动 → 平滑放大、松开平滑还原（逐 rAF 记录放大倍数）；2 按下即拖 → 仍是转头、不聚焦；
//   3 聚焦中拖动 → 灵敏度按倍率降低；4 按住 Z 聚焦，焦点在日期框里按 Z 不触发；5 触屏长按；
//   6 设置：?zoom= 生效且不写记忆、真实按键调滑条写记忆、脚本派发不写、刷新后恢复；?dev=1 显示开发者区、?dev=<时间戳> 不显示；
//   7 头部限位：滚轮前伸到底后往两侧拖到头，实际头部 x 不超过限位、视锥判据成立（截图另存）。
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser, closeBrowserSafely } from "../scripts/lib/chrome.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((a, s, i, all) => (s.startsWith("--") ? [...a, [s.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true]] : a), []),
);
const port = args.port || 5264;
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const outDir = path.resolve(REPO, args.out || "tmp/screenshot/focus-zoom/input");
fs.mkdirSync(outDir, { recursive: true });
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "对" : "错"}  ${name}：${detail}`);
};
const curves = {};

const browser = await launchBrowser(chromium, { angle: "d3d11" });
try {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1, hasTouch: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && !/eox\.at|net::ERR_|CORS/.test(m.text()) && errors.push(m.text()));
  const open = async (q = "") => {
    await page.goto(`http://127.0.0.1:${port}/?t=${Date.now()}&voyage=0${q}`, { waitUntil: "commit", timeout: 180000 });
    await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 180000, polling: 500 });
    await page.evaluate(() => {
      document.getElementById("panel").classList.add("hidden");
      Object.assign(window.__voyage.head, { x: 0, y: 0.02, z: -0.3, tx: 0, ty: 0.02, tz: -0.3 });
    });
    await page.waitForTimeout(300);
  };
  // 页内逐 rAF 记录（t、放大倍数、头部 x），record(ms) 开始、返回 Promise
  const startRec = (ms) =>
    page.evaluate((ms) => {
      window.__fzRec = new Promise((res) => {
        const v = window.__voyage, out = [], t0 = performance.now();
        const f = (t) => {
          out.push([Math.round(t - t0), +v.focus.factor.toFixed(4), +v.head.x.toFixed(5), +v.sceneMat.uniforms.uTanHalfFov.value.toFixed(6)]);
          if (t - t0 < ms) requestAnimationFrame(f);
          else res(out);
        };
        requestAnimationFrame(f);
      });
    }, ms);
  const endRec = () => page.evaluate(() => window.__fzRec);
  const cx = 800, cy = 600;

  await open();
  await page.mouse.move(cx, cy);

  // 1. 按住不动 → 放大；松开 → 还原
  {
    const mag = await page.evaluate(() => window.__voyage.focus.mag);
    await startRec(1400);
    await page.waitForTimeout(100);
    await page.mouse.down();
    await page.waitForTimeout(700);
    await page.mouse.up();
    const rec = await endRec();
    curves.hold = rec;
    const peak = Math.max(...rec.map((r) => r[1]));
    const last = rec[rec.length - 1][1];
    // 单调：放大段不减、还原段不增（平滑、不抖）
    const iPeak = rec.findIndex((r) => r[1] === peak);
    let mono = true;
    for (let i = 1; i < rec.length; i++) if (i <= iPeak ? rec[i][1] < rec[i - 1][1] - 1e-9 : rec[i][1] > rec[i - 1][1] + 1e-9) mono = false;
    const tStart = rec.find((r) => r[1] > 1.0001)?.[0];
    const tFull = rec.find((r) => r[1] >= peak - 1e-4)?.[0];
    const maxStep = Math.max(...rec.slice(1).map((r, i) => Math.abs(Math.log(r[1]) - Math.log(rec[i][1]))));
    check("按住不动 → 平滑放大到倍率、松开还原", Math.abs(peak - mag) < 1e-3 && last === 1 && mono,
      `倍率 ${mag}，峰值 ${peak}，结束 ${last}；单调 ${mono}；开始放大 ${tStart} ms（按下约 100 ms + 判定 180 ms）→ 到顶 ${tFull} ms；相邻两帧最大对数步 ${maxStep.toFixed(3)}（${rec.length} 帧）`);
  }

  // 2. 按下即拖 → 转头、不聚焦
  {
    const x0 = await page.evaluate(() => window.__voyage.head.tx);
    await startRec(600);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) {
      await page.mouse.move(cx + i * 20, cy);
      await page.waitForTimeout(8);
    }
    await page.mouse.up();
    const rec = await endRec();
    curves.quickDrag = rec;
    const x1 = await page.evaluate(() => window.__voyage.head.tx);
    const peak = Math.max(...rec.map((r) => r[1]));
    const want = -(160 / 1600) * 0.28;
    check("按下即拖 → 仍是转头、不触发聚焦", peak === 1 && Math.abs(x1 - x0 - want) < 0.002, `放大倍数峰值 ${peak}；头部目标 x 变化 ${(x1 - x0).toFixed(4)} m（期望 ${want.toFixed(4)}）`);
    await page.mouse.move(cx, cy);
  }

  // 3. 聚焦中拖动 → 灵敏度 ÷ 倍率
  {
    await page.evaluate(() => Object.assign(window.__voyage.head, { tx: 0, x: 0 }));
    await page.waitForTimeout(200);
    const mag = await page.evaluate(() => window.__voyage.focus.mag);
    await page.mouse.down();
    await page.waitForTimeout(600);
    const f = await page.evaluate(() => window.__voyage.focus.factor);
    const x0 = await page.evaluate(() => window.__voyage.head.tx);
    for (let i = 1; i <= 8; i++) {
      await page.mouse.move(cx + i * 20, cy);
      await page.waitForTimeout(16);
    }
    const x1 = await page.evaluate(() => window.__voyage.head.tx);
    const fAfter = await page.evaluate(() => window.__voyage.focus.factor);
    await page.mouse.up();
    const want = -(160 / 1600) * 0.28 / mag;
    check("聚焦中拖动 → 转头灵敏度按倍率降低、聚焦不中断", Math.abs(f - mag) < 1e-3 && Math.abs(fAfter - mag) < 1e-3 && Math.abs(x1 - x0 - want) < 0.001,
      `拖动前后倍数 ${f.toFixed(3)} / ${fAfter.toFixed(3)}；头部目标 x 变化 ${(x1 - x0).toFixed(4)} m（不聚焦时 ${(want * mag).toFixed(4)}，÷ ${mag} = ${want.toFixed(4)}）`);
    await page.mouse.move(cx, cy);
    await page.waitForTimeout(400);
  }

  // 4. 按住 Z；焦点在日期框里时按 Z 不触发
  {
    await page.keyboard.down("z");
    await page.waitForTimeout(500);
    const f1 = await page.evaluate(() => window.__voyage.focus.factor);
    await page.keyboard.up("z");
    await page.waitForTimeout(400);
    const f2 = await page.evaluate(() => window.__voyage.focus.factor);
    await page.evaluate(() => document.getElementById("panel").classList.remove("hidden"));
    await page.focus("#date");
    await page.keyboard.down("z");
    await page.waitForTimeout(400);
    const f3 = await page.evaluate(() => window.__voyage.focus.factor);
    await page.keyboard.up("z");
    await page.evaluate(() => { document.activeElement.blur(); document.getElementById("panel").classList.add("hidden"); });
    const mag = await page.evaluate(() => window.__voyage.focus.mag);
    check("按住 Z 聚焦、松开还原；日期框聚焦时按 Z 不触发", Math.abs(f1 - mag) < 1e-3 && f2 === 1 && f3 === 1, `按住 ${f1.toFixed(3)}，松开后 ${f2}，日期框里按住 ${f3}`);
  }

  // 5. 触屏长按
  {
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: cx, y: cy }] });
    await page.waitForTimeout(600);
    const f1 = await page.evaluate(() => window.__voyage.focus.factor);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(400);
    const f2 = await page.evaluate(() => window.__voyage.focus.factor);
    const mag = await page.evaluate(() => window.__voyage.focus.mag);
    check("触屏长按聚焦、抬起还原", Math.abs(f1 - mag) < 1e-3 && f2 === 1, `长按 ${f1.toFixed(3)}，抬起后 ${f2}`);
  }

  // 6. 设置：URL、记忆（只记 isTrusted）、开发者区显示
  {
    await page.evaluate(() => localStorage.removeItem("voyage.focus"));
    await open("&zoom=4&dev=1");
    const a = await page.evaluate(() => ({ mag: window.__voyage.focus.mag, url: window.__voyage.focus.fromUrl.mag, devShown: !document.getElementById("dev-section").hidden, hint: document.getElementById("focus-hint").textContent, stored: localStorage.getItem("voyage.focus") }));
    check("?zoom=4 生效、hint 注明、不写记忆；?dev=1 显示开发者区", a.mag === 4 && a.url && a.devShown && /URL 参数 zoom/.test(a.hint) && a.stored === null, JSON.stringify(a));
    // 脚本派发（isTrusted = false）不写记忆
    await page.evaluate(() => {
      const el = document.getElementById("focus-mag");
      el.value = "6";
      el.dispatchEvent(new Event("input"));
    });
    const s1 = await page.evaluate(() => ({ mag: window.__voyage.focus.mag, stored: localStorage.getItem("voyage.focus") }));
    // 真实按键（isTrusted = true）写记忆
    await page.evaluate(() => document.getElementById("panel").classList.remove("hidden"));
    await page.focus("#focus-mag");
    await page.keyboard.press("ArrowRight");
    const s2 = await page.evaluate(() => ({ mag: window.__voyage.focus.mag, out: document.getElementById("focus-mag-out").textContent, stored: localStorage.getItem("voyage.focus") }));
    check("脚本派发不写记忆、真实按键写记忆", s1.mag === 6 && s1.stored === null && Math.abs(s2.mag - 6.1) < 1e-9 && /"mag":6\.1/.test(s2.stored ?? ""), `脚本 ${JSON.stringify(s1)}；按键 ${JSON.stringify(s2)}`);
    // 刷新（不带 zoom）后恢复记住的值；?dev=<时间戳>（测量工具的防缓存参数）不显示开发者区
    await open(`&dev=${Date.now()}`);
    const s3 = await page.evaluate(() => ({ mag: window.__voyage.focus.mag, url: window.__voyage.focus.fromUrl.mag, devShown: !document.getElementById("dev-section").hidden, out: document.getElementById("focus-mag-out").textContent }));
    check("刷新后恢复记住的倍率；?dev=<时间戳> 不显示开发者区", Math.abs(s3.mag - 6.1) < 1e-9 && !s3.url && !s3.devShown && s3.out === "6.1×", JSON.stringify(s3));
    // 双击标签复位（真实双击 → 写记忆 2.5）
    await page.evaluate(() => { document.getElementById("panel").classList.remove("hidden"); document.getElementById("dev-section").hidden = false; });
    await page.dblclick("#focus-mag-out");
    const s4 = await page.evaluate(() => ({ mag: window.__voyage.focus.mag, stored: localStorage.getItem("voyage.focus") }));
    check("双击复位到默认 2.5×", s4.mag === 2.5 && /"mag":2\.5/.test(s4.stored ?? ""), JSON.stringify(s4));
    // Shift + D 切换开发者区并记住
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.keyboard.press("Shift+D");
    const d1 = await page.evaluate(() => ({ shown: !document.getElementById("dev-section").hidden, stored: localStorage.getItem("voyage.pref.panel") }));
    await page.keyboard.press("Shift+D");
    const d2 = await page.evaluate(() => ({ shown: !document.getElementById("dev-section").hidden, stored: localStorage.getItem("voyage.pref.panel") }));
    check("Shift + D 切换开发者区并记住", d1.shown !== d2.shown && /"dev":/.test(d2.stored ?? ""), `${JSON.stringify(d1)} → ${JSON.stringify(d2)}`);
    await page.evaluate(() => { localStorage.removeItem("voyage.focus"); localStorage.removeItem("voyage.pref.panel"); });
    await open();
    await page.mouse.move(cx, cy);
  }

  // 7. 头部限位：滚轮前伸到底，再往两侧拖到头（机头侧、机尾侧），聚焦前后各一次
  for (const [label, q] of [["商务舱右座", {}], ["经济舱左座", { seat: "left", "cabin-class": "economy" }]]) {
    await page.evaluate(async (q) => {
      for (const [id, val] of Object.entries(q)) {
        const el = document.getElementById(id);
        el.value = val;
        el.dispatchEvent(new Event("change"));
      }
      const v = window.__voyage;
      for (let i = 0; i < 480 && v.cabinClass.shown !== (q["cabin-class"] ?? "business"); i++) await new Promise((r) => setTimeout(r, 250));
      Object.assign(v.head, { x: 0, y: 0.02, z: -0.3, tx: 0, ty: 0.02, tz: -0.3 });
    }, q);
    await page.waitForTimeout(500);
    for (let i = 0; i < 40; i++) await page.mouse.wheel(0, 120);
    await page.waitForTimeout(1500);
    // 一次「推」：多笔拖动（每笔 700 px），最后一笔不松开；zoom 时每笔先按住不动进入聚焦
    const push = async (dir, zoom, strokes) => {
      for (let s = 0; s < strokes; s++) {
        await page.mouse.move(cx - dir * 350, cy);
        await page.mouse.down();
        if (zoom) await page.waitForTimeout(450);
        for (let i = 1; i <= 28; i++) await page.mouse.move(cx - dir * 350 + dir * i * 25, cy);
        if (s < strokes - 1) {
          await page.mouse.up();
          await page.waitForTimeout(zoom ? 50 : 20);
        }
      }
    };
    for (const dir of [1, -1]) {
      for (const zoom of [false, true]) {
        await push(dir, zoom, zoom ? 14 : 6);
        await page.waitForTimeout(1200);
        const st = await page.evaluate(() => {
          const v = window.__voyage;
          return { x: v.head.x, tx: v.head.tx, z: v.head.z, pos: v.headLimits.pos, neg: v.headLimits.neg, factor: v.focus.factor };
        });
        const name = `limit-${label}-${dir > 0 ? "right" : "left"}${zoom ? "-zoom" : ""}`;
        await page.screenshot({ path: path.join(outDir, `${name}.png`) });
        await page.mouse.up();
        await page.waitForTimeout(zoom ? 600 : 100);
        const inside = st.x <= st.pos + 1e-9 && st.x >= -st.neg - 1e-9;
        const atLimit = Math.abs(st.x) > 0.9 * (st.x >= 0 ? st.pos : st.neg);
        check(`限位 ${label} 往屏幕${dir > 0 ? "右" : "左"}拖到头${zoom ? "（聚焦中）" : ""}`, inside && atLimit,
          `头 z ${st.z.toFixed(3)}、x ${st.x.toFixed(4)}（目标 ${st.tx.toFixed(4)}），限位 +${st.pos.toFixed(4)} / −${st.neg.toFixed(4)}，倍数 ${st.factor.toFixed(2)}；截图 ${name}.png`);
        await page.evaluate(() => Object.assign(window.__voyage.head, { tx: 0 }));
        await page.waitForTimeout(800);
      }
    }
    // 松开聚焦后视场变宽、限位收紧：实际 x 被平滑拉回（逐帧记录）
    await push(1, true, 14);
    await page.waitForTimeout(800);
    await startRec(900);
    await page.mouse.up();
    const rec = await endRec();
    curves[`release-${label}`] = rec;
    const maxJump = Math.max(...rec.slice(1).map((r, i) => Math.abs(r[2] - rec[i][2])));
    check(`${label} 聚焦中推到限位后松开 → 头被平滑拉回`, maxJump < 0.01, `相邻帧头部 x 最大变化 ${(maxJump * 1000).toFixed(2)} mm（x ${rec[0][2]} → ${rec[rec.length - 1][2]}）`);
  }
  fs.writeFileSync(path.join(outDir, "curves.json"), JSON.stringify(curves));
  check("控制台没有 error", errors.length === 0, errors.length ? errors.slice(0, 3).join(" | ") : "0 条");
  const bad = results.filter((r) => !r.ok).length;
  console.log(`\n合计 ${results.length} 项，${bad} 项不对`);
  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 1));
} finally {
  await closeBrowserSafely(browser);
}
