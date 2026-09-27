// G07：把 G07-stream.mjs 的输出（JSON）压成一行关键指标。用法：node handoff/G07-brief.cjs <输出.json>
const j = JSON.parse(require("fs").readFileSync(process.argv[2], "utf8"));
const { frames, over16, over33, over50, worst, longtasks, upload, worker, heapMB, requestsPerMin, errors, settleS, warmup } = j;
console.log(JSON.stringify({ settleS, warmup, frames, over16, over33, over50, worst, longtasks, upload, wk: { n: worker.count, avg: +(worker.totalMs / worker.count).toFixed(0), max: worker.maxMs }, heapMB, requestsPerMin, errors }));
