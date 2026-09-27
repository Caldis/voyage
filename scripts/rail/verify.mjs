// 读烘焙产物（public/data/rail/<线路>.json + .bin），按前端的方式切出 TypedArray，打印统计并做基本自检。
// 用法：node apps/voyage/scripts/rail/verify.mjs [线路 id]
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, '..', '..', 'public', 'data', 'rail');
const id = process.argv[2] ?? 'oito-matsumoto-shinanoomachi';
const meta = JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8'));
const file = readFileSync(join(dir, meta.format.bin));
const buf = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);

const CTOR = { f32: Float32Array, u32: Uint32Array, i32: Int32Array, u16: Uint16Array, i16: Int16Array, u8: Uint8Array, i8: Int8Array };
const A = {};
let fail = 0;
const check = (ok, msg) => { if (!ok) { fail++; console.error('✗', msg); } };
for (const [name, a] of Object.entries(meta.arrays)) {
  const C = CTOR[a.type];
  check(a.offset % C.BYTES_PER_ELEMENT === 0, `${name} 未对齐`);
  check(a.offset + a.length * C.BYTES_PER_ELEMENT <= buf.byteLength, `${name} 越界`);
  A[name] = new C(buf, a.offset, a.length);
}

const n = A['center.s'].length;
for (const k of ['center.x', 'center.y', 'center.zRail', 'center.grade', 'center.curvature', 'center.flags', 'center.tracks'])
  check(A[k].length === n, `${k} 长度 ${A[k].length} ≠ ${n}`);
let mono = true, nan = 0;
for (let i = 1; i < n; i++) if (!(A['center.s'][i] > A['center.s'][i - 1])) mono = false;
for (const v of A['center.zRail']) if (!Number.isFinite(v)) nan++;
check(mono, 'center.s 不单调');
check(nan === 0, `zRail 有 ${nan} 个非有限值`);

const range = (arr) => { let lo = Infinity, hi = -Infinity; for (const v of arr) { if (v < lo) lo = v; if (v > hi) hi = v; } return [lo, hi]; };
const [s0, s1] = range(A['center.s']);
const [z0, z1] = range(A['center.zRail']);
let gmax = 0; for (const g of A['center.grade']) gmax = Math.max(gmax, Math.abs(g));
let kmax = 0; for (const k of A['center.curvature']) kmax = Math.max(kmax, Math.abs(k));
const F = meta.format.flags;
const flagCount = Object.fromEntries(Object.entries(F).map(([k, bit]) => [k, A['center.flags'].reduce((c, f) => c + ((f & bit) ? 1 : 0), 0)]));

console.log(`${meta.name}（${id}）  bin ${(buf.byteLength / 1e6).toFixed(2)} MB，数组 ${Object.keys(A).length} 个`);
console.log(`中心线 ${n} 点，s ${s0.toFixed(0)}..${s1.toFixed(0)} m，轨面 ${z0.toFixed(1)}..${z1.toFixed(1)} m，最大坡度 ${gmax.toFixed(1)}‰，最小半径约 ${(1 / kmax).toFixed(0)} m`);
console.log('标志（点数 × 2 m）：', flagCount);

// 多边形 / 线层：自检下标链
function polyLayer(p) {
  const fr = A[`${p}.featRing`], rs = A[`${p}.ringStart`], v = A[`${p}.verts`];
  check(fr[fr.length - 1] === rs.length - 1, `${p} featRing 末尾 ≠ 环数`);
  check(rs[rs.length - 1] * 2 === v.length, `${p} ringStart 末尾 ≠ 顶点数`);
  return { features: fr.length - 1, rings: rs.length - 1, verts: v.length / 2 };
}
function lineLayer(p) {
  const fs = A[`${p}.featStart`], v = A[`${p}.verts`];
  check(fs[fs.length - 1] * 2 === v.length, `${p} featStart 末尾 ≠ 顶点数`);
  return { features: fs.length - 1, verts: v.length / 2 };
}
const b = polyLayer('buildings');
let lv = 0; for (const x of A['buildings.levels']) if (x) lv++;
console.log(`建筑 ${b.features} 栋（环 ${b.rings}，顶点 ${b.verts}），标了层数的 ${lv} 栋；类别前 5：`, meta.layers.buildings.classes.slice(0, 5).join(' / '));
const lu = polyLayer('landuse');
console.log(`土地利用 ${lu.features} 块（顶点 ${lu.verts}）；类别：`, meta.layers.landuse.classes.join(' / '));
for (const k of ['road', 'water', 'power', 'barrier']) {
  if (!A[`${k}.verts`]) { console.log(`${k}：无`); continue; }
  const r = lineLayer(k);
  console.log(`${k} ${r.features} 条（顶点 ${r.verts}）：`, meta.layers[k].classes.slice(0, 8).join(' / '));
}
const ms = A['masts.source'];
let gen = 0; for (const x of ms) if (x === 0) gen++;
console.log(`接触网支柱 ${ms.length} 根（程序生成 ${gen}，OSM ${ms.length - gen}）；电力点 ${A['powerPts.s'].length} 个`);
console.log(`车站 ${meta.stations.length}，道口 ${meta.levelCrossings.length}，桥 ${meta.bridges.length}，隧道 ${meta.tunnels.length}，跨线桥 ${meta.overpasses.length}`);
const g = meta.format.grid;
check(A['grid.z'].length === g.rows * g.cols, 'grid 尺寸不符');
let nod = 0; for (const x of A['grid.z']) if (x === g.nodata) nod++;
console.log(`高程网格 ${g.rows}×${g.cols}，无数据 ${nod} 格`);
console.log('车站 s 与营业キロ对照（km）：');
for (const st of meta.stations) console.log(`  ${st.name.padEnd(5, '　')} 营业 ${st.km.toFixed(1)}  OSM ${(st.s / 1000).toFixed(2)}  差 ${(st.s / 1000 - st.km).toFixed(2)}`);
if (fail) { console.error(`✗ ${fail} 项自检失败`); process.exit(1); }
console.log('✓ 自检通过');
