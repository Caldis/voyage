// 真冷启动（破缓存）：往每个片元着色器注入随机常量。改自 tmp/review-t06/cold5181.js。测完要 browser_close
async (page) => {
  const origin = "http://127.0.0.1:5221";
  const nonce = Date.now() % 100000;
  await page.addInitScript((nonce) => {
    const P = WebGL2RenderingContext.prototype;
    const orig = P.shaderSource;
    P.shaderSource = function (sh, src) {
      if (src.includes("void main")) {
        src = src.replace(/void\s+main\s*\(\s*\)\s*\{/, (m) => `float nonceF_${nonce}(){ return ${nonce}.0; }\n` + m + `\n if (nonceF_${nonce}() < -1.0) return;\n`);
      }
      return orig.call(this, sh, src);
    };
  }, nonce);
  const t0 = Date.now();
  await page.goto(`${origin}/?cold=${t0}`, { waitUntil: "commit", timeout: 180000 });
  await page.bringToFront();
  await page.waitForFunction(() => window.__voyageStartup, null, { timeout: 300000, polling: 250 });
  const s = await page.evaluate(() => JSON.stringify(window.__voyageStartup));
  return { origin, nonce, ms: Date.now() - t0, s };
}
