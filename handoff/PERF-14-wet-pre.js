v.benchFrame = () => 0;
v.wingDebug.strobe = 1;
v.state.wetness = 0.9;
v.wingVariant.state = "failed"; // 让 pick 一直返回 wingMat，再把 wingMat 本身改成湿窗变体，换基线原文才对得上
const P = v.clouds.pass, r = P.renderer, m = v.wingMat;
if (!m.defines || !m.defines.WING_WET) {
  m.defines = { ...(m.defines || {}), WING_WET: 1 };
  m.needsUpdate = true;
  const pm = P.mesh.material;
  P.mesh.material = m;
  r.setRenderTarget(v.wingVariant.target);
  await r.compileAsync(P.scene, P.camera);
  P.render(m, v.wingVariant.target);
  P.mesh.material = pm;
  r.setRenderTarget(null);
}
for (let i = 0; i < 3; i++) await new Promise((res) => requestAnimationFrame(res));
return "wet " + v.sceneMat.uniforms.uWetness.value;
