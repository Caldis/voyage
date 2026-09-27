# T47：离线 FXC 变体对照（按文本替换换掉单个改动，与 master 交替计时）。用法：python T47-fxc-bisect.py 轮数 程序名；路径按本 worktree 写死，改 V / M 后复用
import subprocess, sys, re, os
V = r'D:\Code\opus-test\.claude\worktrees\agent-a74de99ea11f7180e\apps\voyage'
M = r'D:\Code\opus-test\tmp\t47-master\apps\voyage'
SC = os.path.join(V, r'src\render\scene.ts')
SE = os.path.join(V, r'src\render\seats.glsl.ts')
PROG = sys.argv[2] if len(sys.argv) > 2 else 'scene-economy'

def rd(p): return open(p, encoding='utf-8', newline='').read()
def wr(p, s): open(p, 'w', encoding='utf-8', newline='').write(s)

VARIANTS = {
  'base': [],
  'noBend': [(SE, '  if (ndv < 0.3) nn = normalize(nn + v * (0.3 - ndv));\n', '')],
  'no1c': [(os.path.join(V, r'src\render\cabin-shading.glsl.ts'), '    slope += mat2(0.8, -0.6, 0.6, 0.8) * u1.yz * 6.7 * 0.0022;\n    albedo *= 1.0 + 0.02 * (u1.x - 0.5);\n', '')],
  'noRemap': [(SC, '  if (outsideMask > 0.0 && outsideMask < 1.0) {\n', '  if (false) {\n')],
  'master': 'MASTER',
}

def run(cwd=V):
    out = subprocess.run(['node', 'scripts/shader-budget.mjs', '--only', PROG, '--jobs', '1'], cwd=cwd, capture_output=True, text=True, encoding='utf-8').stdout
    m = re.search(r'^' + PROG + r'\s+\S+\s+(\d+)', out, re.M)
    return int(m.group(1)) if m else -1

res = {k: [] for k in VARIANTS}
for r in range(int(sys.argv[1]) if len(sys.argv) > 1 else 3):
    for name, edits in VARIANTS.items():
        if edits == 'MASTER':
            t = run(M)
        else:
            orig = {}
            for p, a, b in edits:
                cur = rd(p)
                orig.setdefault(p, cur)
                assert cur.count(a) == 1, (name, a)
                wr(p, cur.replace(a, b))
            try:
                t = run()
            finally:
                for p, s in orig.items(): wr(p, s)
        res[name].append(t)
        print(r, name, t, flush=True)
for k, v in res.items():
    v2 = sorted(v)
    print(k, v, 'median', v2[len(v2) // 2], 'min', v2[0])
