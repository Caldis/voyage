async (page) => {
  const url = "http://127.0.0.1:5214/";
  const origin = (url.match(/^http:\/\/127\.0\.0\.1:51\d\d/) || ["http://127.0.0.1:5182"])[0];
  const nonce = Date.now() % 100000;
  // 破坏着色器缓存：每个片元着色器里在 main 前插一个依赖 nonce 的无害常量，并在 main 开头用它
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
