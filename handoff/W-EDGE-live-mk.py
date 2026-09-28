"""wedge3：从 W-EDGE-jobs-live.json 挑 job，变体换成 old/new/ref/额外变体/old2/new2。
python mklive.py <输出.json> <job 名,...> [额外变体.json] [--noref] [--frames N]"""
import json
import sys

sys.stdout.reconfigure(encoding="utf-8")
import os as _os
ROOT = _os.path.abspath(_os.path.join(_os.path.dirname(__file__), "../../..")).replace("\\", "/") + "/"
live = json.load(open(ROOT + "apps/voyage/handoff/W-EDGE-jobs-live.json", encoding="utf-8"))
allj = json.load(open(_os.environ.get("WEDGE_JOBS", ROOT + "tmp/wedge3/jobs-all.json"), encoding="utf-8"))
ref = [v for v in allj[0]["variants"] if v["name"] == "ref"][0]
ref = {k: v for k, v in ref.items() if k != "js"}
args = sys.argv[1:]
out, names = args[0], args[1].split(",")
extra = []
noref = "--noref" in args
frames = None
if "--frames" in args:
    frames = int(args[args.index("--frames") + 1])
for a in args[2:]:
    if a.endswith(".json"):
        extra = json.load(open(a, encoding="utf-8"))
BASE = {"wingMat": "base", "wingMat.wet": "base:wingMat"}
jobs = []
for j in live:
    if j["name"] not in names:
        continue
    vs = [{"name": "old", "materials": BASE}, {"name": "new"}]
    if not noref:
        vs.append(dict(ref))
    vs += extra
    vs += [{"name": "old2", "materials": BASE}, {"name": "new2"}]
    j = dict(j, variants=vs)
    if frames:
        j["live"] = dict(j["live"], frames=frames)
    jobs.append(j)
json.dump(jobs, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(out, len(jobs), [v["name"] for v in jobs[0]["variants"]])
