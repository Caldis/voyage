# T17 自测场景（PowerShell）：宝光 / 本机影子 / 绿闪 / 幻日，各带「关」的对照。用法（仓库根或 apps/voyage 下均可）：
#   pwsh apps/voyage/handoff/T17-shots.ps1 -Port 5217 [-Out tmp/screenshot/T17/final] [-Angle d3d11]
# 场景的 js 字段见 scripts/scenarios.mjs：force 强制出现、disabled 全关、pinGreenFlash 把时间钉在绿闪那一刻。
param([int]$Port = 5217, [string]$Out = "tmp/screenshot/T17/final", [string]$Angle = "d3d11")
Set-Location (Join-Path $PSScriptRoot "..")
$probe = '; await new Promise(r=>setTimeout(r,600)); const u=v.sceneMat.uniforms; return JSON.stringify({status:v.optics.status, anti:v.optics.pixelOf(u), sun:v.optics.pixelOf(u,u.uSunDir.value.clone())})'
function Scene($name, $p, $js) {
  $base = @{ preset = "wpac"; date = "2026-09-27"; "wing-pos" = "-4" }
  foreach ($k in $p.Keys) { $base[$k] = $p[$k] }
  return (@{ name = $name; p = $base; js = ($js + $probe) } | ConvertTo-Json -Compress -Depth 5)
}
$on = 'v.optics.disabled=false; v.optics.pinGreenFlash(null); v.optics.force='
$off = 'v.optics.disabled=true; v.optics.pinGreenFlash(null); v.optics.force={}'
$glory = @{ seat = "left"; time = 990; "cloud-preset" = "stratocumulus"; coverage = 0.85 }
$low = @{ seat = "left"; time = 990; "cloud-preset" = "stratocumulus"; coverage = 0.9; altitude = 2.6 }
$halo = @{ seat = "right"; time = 990; "cloud-preset" = "cirrus"; coverage = 0.5 }
$sea = @{ seat = "right"; time = 1050; "cloud-preset" = "clear"; coverage = 0 }
$seaLow = @{ seat = "right"; time = 1050; "cloud-preset" = "clear"; coverage = 0; altitude = 1.0 }
$scenes = @(
  (Scene "glory-cruise" $glory ($on + '{glory:true}')),
  (Scene "glory-cruise-off" $glory $off),
  (Scene "glory-low-shadow" $low ($on + '{glory:true}')),
  (Scene "glory-low-shadow-off" $low $off),
  (Scene "halo-cirrus" $halo ($on + '{halo:true}')),
  (Scene "halo-cirrus-off" $halo $off),
  (Scene "flash-cruise-green" $sea ($on + '{flash:true}; v.optics.pinGreenFlash(0.5)')),
  (Scene "flash-low-pre" $seaLow ($on + '{flash:true}; v.optics.pinGreenFlash(-3)')),
  (Scene "flash-low-green" $seaLow ($on + '{flash:true}; v.optics.pinGreenFlash(0.5)')),
  (Scene "flash-low-off" $seaLow ($off + '; v.optics.pinGreenFlash(0.5)'))
)
$args2 = @("scripts/dev-browser.mjs", "shots", "--port", $Port, "--out", $Out, "--angle", $Angle)
foreach ($s in $scenes) { $args2 += @("--scene", $s) }
node @args2
