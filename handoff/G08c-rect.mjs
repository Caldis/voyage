// G08c（源自 G08 审查 g08rev-rect.mjs）：离线复核 tileRect 新旧算法东西相邻瓦片的缝宽（像素）与角点误差，影像 / 夜光 / 地形三种画布都比新旧。用法：node handoff/G08c-rect.mjs
const D2R = Math.PI / 180, KLAT = 110.574, KLON = 111.32, CIRC = 40075.016;
const lonToTileX = (lon, z) => ((lon + 180) / 360) * 2 ** z;
const latToTileY = (lat, z) => { const r = lat * D2R; return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z; };
const tileXToLon = (x, z) => (x / 2 ** z) * 360 - 180;
const tileYToLat = (y, z) => (Math.atan(Math.sinh(Math.PI - (2 * Math.PI * y) / 2 ** z)) * 180) / Math.PI;
const zfr = (t, lat, mz) => Math.max(1, Math.min(mz, Math.round(Math.log2((CIRC * Math.cos(lat * D2R)) / (256 * t)))));
function frame(lat0, lon0) {
  return {
    toLocal: (lat, lon) => [(lon - lon0) * KLON * Math.cos(lat * D2R), -(lat - lat0) * KLAT],
    toGeo: (x, z) => { const lat = lat0 - z / KLAT; return [lat, lon0 + x / (KLON * Math.cos(lat * D2R))]; },
  };
}
function cover(F, size, cx, cz, zoom, px) {
  const x0 = cx - size / 2, z0 = cz - size / 2;
  const [latN] = F.toGeo(cx, z0), [latS] = F.toGeo(cx, z0 + size);
  const lons = [F.toGeo(x0, z0)[1], F.toGeo(x0 + size, z0)[1], F.toGeo(x0, z0 + size)[1], F.toGeo(x0 + size, z0 + size)[1]];
  const tx0 = Math.floor(lonToTileX(Math.min(...lons), zoom)), tx1 = Math.floor(lonToTileX(Math.max(...lons), zoom));
  const ty0 = Math.floor(latToTileY(latN, zoom)), ty1 = Math.floor(latToTileY(latS, zoom));
  const toPx = (lat, lon) => { const [x, z] = F.toLocal(lat, lon); return [((x - x0) / size) * px, ((z - z0) / size) * px]; };
  const tiles = [];
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) tiles.push({ x: tx, y: ty });
  return { tiles, toPx };
}
function rect(toPx, z, t, shared) {
  const latT = tileYToLat(t.y, z), latB = tileYToLat(t.y + 1, z), lonL = tileXToLon(t.x, z), lonR = tileXToLon(t.x + 1, z);
  if (!shared) { const [ax, ay] = toPx(latT, lonL), [bx, by] = toPx(latB, lonR); return { x: ax, y: ay, w: bx - ax, h: by - ay }; }
  const latM = tileYToLat(t.y + 0.5, z);
  return { x: toPx(latM, lonL)[0], y: toPx(latT, lonL)[1], w: toPx(latM, lonR)[0] - toPx(latM, lonL)[0], h: toPx(latB, lonL)[1] - toPx(latT, lonL)[1] };
}
// 统计：东西相邻缝（正 = 缝，负 = 重叠）落在画布内的最大值；缝里包含多少个像素中心（整列 0 m / 透明的风险）；角点误差（相对真实位置）
function stats(F, size, cx, cz, zoom, px, shared) {
  const c = cover(F, size, cx, cz, zoom, px);
  let gap = 0, over = 0, gapCols = 0, cornerErr = 0;
  const m = new Map(c.tiles.map((t) => [`${t.x},${t.y}`, rect(c.toPx, zoom, t, shared)]));
  for (const t of c.tiles) {
    const a = m.get(`${t.x},${t.y}`), b = m.get(`${t.x + 1},${t.y}`);
    // 真实角点
    for (const [la, lo, X, Y] of [[tileYToLat(t.y, zoom), tileXToLon(t.x, zoom), a.x, a.y], [tileYToLat(t.y + 1, zoom), tileXToLon(t.x + 1, zoom), a.x + a.w, a.y + a.h], [tileYToLat(t.y, zoom), tileXToLon(t.x + 1, zoom), a.x + a.w, a.y], [tileYToLat(t.y + 1, zoom), tileXToLon(t.x, zoom), a.x, a.y + a.h]]) {
      const [tx, ty] = c.toPx(la, lo);
      if (tx >= 0 && tx <= px && ty >= 0 && ty <= px) cornerErr = Math.max(cornerErr, Math.hypot(tx - X, ty - Y));
    }
    if (!b) continue;
    const e = a.x + a.w, s = b.x;
    const inside = e > 0 && e < px && a.y + a.h > 0 && a.y < px;
    if (!inside) continue;
    if (s > e) { gap = Math.max(gap, s - e); const n = Math.ceil(s - 0.5) - Math.ceil(e - 0.5); gapCols = Math.max(gapCols, n); }
    else over = Math.max(over, e - s);
  }
  return { gap, over, gapCols, cornerErr };
}
const presets = { fuji: [35.0, 138.95], "hnd-cts": [36.2, 140.3], "hnd-itm": [35.35, 139.35] };
// 取样位置：原点、以及原点以西 / 以东若干公里（航线离原点远的情形）
const positions = [[0, 0], [-100, 0], [-300, 0], [100, 0], [-300, -300]];
const RES = 2048, HRES = 256, NRES = 1024;
let maxNew = 0, maxNewCols = 0;
for (const [name, [la, lo]] of Object.entries(presets)) {
  const F = frame(la, lo);
  for (const [cx, cz] of positions) {
    const lines = [];
    for (let i = 0; i < 7; i++) {
      const size = 8 * 2 ** i;
      const [latC] = F.toGeo(cx, cz);
      const row = [];
      // 影像（fine）
      let z = zfr(size / RES, latC, 14); let c = cover(F, size, cx, cz, z, RES); while (c.tiles.length > 169 && z > 1) c = cover(F, size, cx, cz, --z, RES);
      const o = stats(F, size, cx, cz, z, RES, false), n = stats(F, size, cx, cz, z, RES, true);
      row.push(`img z${z} 旧缝${o.gap.toFixed(2)}px/${o.gapCols}列 重叠${o.over.toFixed(2)} 角${o.cornerErr.toFixed(2)} → 新缝${n.gap.toFixed(3)} 角${n.cornerErr.toFixed(2)}`);
      // 地形
      z = zfr(size / HRES, latC, 12); c = cover(F, size, cx, cz, z, HRES); while (c.tiles.length > 25 && z > 1) c = cover(F, size, cx, cz, --z, HRES);
      const h = stats(F, size, cx, cz, z, HRES, false), hn = stats(F, size, cx, cz, z, HRES, true);
      row.push(`dem z${z} 旧缝${h.gap.toFixed(2)}px/${h.gapCols}列(${(h.gap * size / HRES * 1000).toFixed(0)} m) → 新缝${hn.gap.toFixed(3)}/${hn.gapCols}列`);
      z = zfr(size / NRES, latC, 8); c = cover(F, size, cx, cz, z, NRES); while (c.tiles.length > 25 && z > 1) c = cover(F, size, cx, cz, --z, NRES);
      const nn = stats(F, size, cx, cz, z, NRES, false), nw = stats(F, size, cx, cz, z, NRES, true);
      row.push(`night z${z} 旧缝${nn.gap.toFixed(2)}px/${nn.gapCols}列 → 新缝${nw.gap.toFixed(3)}/${nw.gapCols}列`);
      maxNew = Math.max(maxNew, n.gap, hn.gap, nw.gap);
      maxNewCols = Math.max(maxNewCols, n.gapCols, hn.gapCols, nw.gapCols);
      lines.push(`  L${i}(${size}km): ${row.join(" | ")}`);
    }
    console.log(`${name} 中心(${cx},${cz})km`);
    console.log(lines.join("\n"));
  }
}
console.log(`新算法全部画布最大缝 ${maxNew.toFixed(4)} px、最多漏 ${maxNewCols} 列`);
