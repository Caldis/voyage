#!/bin/bash
# NIGHT-AP-1 审查：check:glsl 新检查的回归拦截测试（在 tmp/NAP1rev-merge 里逐个改一处、跑 lint、恢复）
V=${1:-/d/Code/opus-test/tmp/NAP1rev-merge/apps/voyage}  # 参数：一个可随便改的 voyage 目录（不要用实现者的 worktree）
run() {
  name="$1"; file="$2"; from="$3"; to="$4"
  sed -i "s|$from|$to|" "$V/$file"
  if git -C "$V" diff --quiet -- "$file"; then echo "[$name] 补丁没打上"; return; fi
  (cd "$V" && node scripts/lint-shaders.mjs > /tmp/nap-mut.log 2>&1); code=$?
  hits=$(grep -c "用太阳查空气透视 LUT" /tmp/nap-mut.log)
  echo "[$name] exit=$code 命中=$hits"
  git -C "$V" checkout -- "$file"
}
run far-towers-uvw   src/clouds/far-towers.ts   "aerialPerspectiveUvw(rd, uApDir, min(t" "aerialPerspectiveUvw(rd, uSunDir, min(t"
run far-towers-illum src/clouds/far-towers.ts   "apL = I \* uApIlluminance" "apL = I * uSunIlluminance"
run clouds-illum     src/clouds/clouds.ts       "apL \*= uApIlluminance;" "apL *= uSunIlluminance;"
run clouds-hur-uvw   src/clouds/clouds.ts       "aerialPerspectiveUvw(rd, uApDir, depth \* fk" "aerialPerspectiveUvw(rd, uSunDir, depth * fk"
run terrain-illum    src/render/terrain-shading.glsl.ts "wRow) \* uApIlluminance" "wRow) * uSunIlluminance"
run ring-uvw         src/wonders/ring.glsl.ts   "aerialPerspectiveUvw(rd, uApDir, min(tP" "aerialPerspectiveUvw(rd, uSunDir, min(tP"
run traffic-illum    src/render/traffic.glsl.ts "uvw).rgb \* uApIlluminance \* (1.0" "uvw).rgb * uSunIlluminance * (1.0"
git -C "$V" status -s
