// T43：查 OpenFreeMap 各缩放级的 transportation 图层里有没有匝道（ramp = 1），以及各等级的数量（选互通判据用）
// 用法：node handoff/T43-ramps.mjs [lat] [lon]
import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";

const lat = Number(process.argv[2] ?? 35.9), lon = Number(process.argv[3] ?? 139.9);
const tj = await (await fetch("https://tiles.openfreemap.org/planet")).json();
for (const z of [8, 9, 10, 11, 12, 13, 14]) {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const r = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
  const buf = await (await fetch(tj.tiles[0].replace("{z}", z).replace("{x}", x).replace("{y}", y))).arrayBuffer();
  const t = new VectorTile(new PbfReader(buf)).layers.transportation;
  const cnt = {};
  for (let i = 0; t && i < t.length; i++) {
    const p = t.feature(i).properties;
    const k = `${p.class}${Number(p.ramp) === 1 ? "+ramp" : ""}`;
    cnt[k] = (cnt[k] || 0) + 1;
  }
  console.log(z, JSON.stringify(cnt));
}
