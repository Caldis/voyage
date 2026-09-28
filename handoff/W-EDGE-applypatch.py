"""wedge3：把变体 json 里的 find/replace 应用到源文件（每条必须恰好匹配一次）。
python applypatch.py <变体.json> <变体名> <源文件>..."""
import json
import sys

sys.stdout.reconfigure(encoding="utf-8")
vs = json.load(open(sys.argv[1], encoding="utf-8"))
v = [x for x in vs if x["name"] == sys.argv[2]][0]
pairs = list(v["patch"].values())[0]
files = sys.argv[3:]
src = {f: open(f, encoding="utf-8").read() for f in files}
for a, b in pairs:
    hits = [f for f in files if src[f].count(a) == 1]
    if len(hits) != 1:
        raise SystemExit("找不到或不唯一：" + a[:80])
    src[hits[0]] = src[hits[0]].replace(a, b)
for f in files:
    open(f, "w", encoding="utf-8", newline="\n").write(src[f])
print("ok", len(pairs))
