// T44：近处塔底的深色「拱洞」来自哪一项
export const VARIANTS = [
  { name: "base" },
  { name: "oldAlb", js: `window.__t45.replaceMarch([["if (nearHur) albB = mix(", "if (false) albB = mix("]])` },
  { name: "oldSkirtAO", js: `window.__t45.replaceMarch([["bool isSkirt = !isAnvil && skirt > towerD;", "bool isSkirt = false;"]])` },
  { name: "oldRb", js: `window.__t45.replaceMarch([["float rb = Rt * mix(0.88 + 0.15 * h3.x, 1.0, smoothstep(0.05, 0.7, hh));", "float rb = Rt * mix(0.7 + 0.25 * h3.x, 1.0, smoothstep(0.05, 0.7, hh));"]])` },
];
