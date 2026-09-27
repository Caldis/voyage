// G06：闪烁测量。用法：node g06-flicker.mjs <voyage 根> <端口> <场景> <输出目录> [额外参数…]
// 场景与 g06-shots.mjs 相同（钉住位置 / 姿态），crop 取地面区域
import { spawnSync } from "node:child_process";
import path from "node:path";

const [root, port, name, out, ...extra] = process.argv.slice(2);
const att = `v.state.heading = v.state.preset.heading; v.state.bankDeg = 0; v.state.rollDeg = 0; v.state.pitchDeg = 2.5; v.state.turbulence = 0;`;
const pin = (ox, oz) =>
  `v.wingDebug && (v.wingDebug.strobe = 0); v.freeze(true); v.cloudUniforms.uCloudOffset.value.set(${ox}, ${oz}); ${att}` +
  `let calm = 0; for (let i = 0; i < 240 && calm < 6; i++) { await new Promise((r) => setTimeout(r, 500)); calm = v.ground.pending === 0 ? calm + 1 : 0; }` +
  `v.cloudUniforms.uCloudOffset.value.set(${ox}, ${oz}); ${att} return 'ok';`;
const S = {
  // 斜看平原（长江中下游，农田 / 村镇 / 湖岸）
  yangtze: [{ p: { preset: "yangtze", time: 630, coverage: 0, "wing-pos": "-4" } }, "560,620,600,480"],
  // 城区 + 海岸线（富士市 / 骏河湾）
  "fuji-day": [{ p: { preset: "fuji", time: 930, altitude: 6, coverage: 0, "wing-pos": "-4" }, offset: [-20, 0.2] }, "420,860,760,260"],
  // 海面岛屿
  "wpac-isl": [{ p: { preset: "wpac", time: 720, coverage: 0, seat: "left", "wing-pos": "8" }, offset: [-60, -344] }, "560,680,340,160"],
  // 夜间城市（道路 / 灯点）
  "night-city": [{ p: { preset: "fuji", date: "2026-01-16", time: 1260, altitude: 4, coverage: 0, "cabin-light": false }, offset: [0, -25], head: -0.25 }, "420,760,760,360"],
};
const [sc, crop] = S[name];
// G06_MOVE=米/帧：把 flicker 工具每帧的 head.x 步进改成「飞机沿航向前进」（相机不动），量飞行时地面本身的闪烁（带视差），
// 而不是转头的平移。工具每帧 head.x += 0.06 mm，这里换算成飞机位移
const move = Number(process.env.G06_MOVE || 0);
const hook = move
  ? `const h0 = v.head.x, o = v.cloudUniforms.uCloudOffset.value, ox = o.x, oz = o.y, hr = v.state.heading * Math.PI / 180, k = ${move} / 0.06; let acc = 0;` +
    `Object.defineProperty(v.head, 'x', { configurable: true, get() { return h0; }, set(val) { acc += val - h0; const d = acc * k; o.set(ox + Math.sin(hr) * d, oz - Math.cos(hr) * d); } }); return 'move';`
  : "";
const scene = { name, ...sc, ground: true, wait: 1500, js: pin(...(sc.offset ?? [0, 0])).replace("return 'ok';", hook || "return 'ok';") };
const args = [path.join(root, "scripts/dev-browser.mjs"), "flicker", "--port", port, "--scene", JSON.stringify(scene), "--crop", crop, "--out", out, "--settle", ...extra];
const r = spawnSync(process.execPath, args, { stdio: "inherit", cwd: root });
process.exit(r.status ?? 1);
