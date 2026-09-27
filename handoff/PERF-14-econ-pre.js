v.benchFrame = () => 0;
const P = v.clouds.pass, r = P.renderer;
if (!v.sceneMat.defines || !v.sceneMat.defines.CABIN_CLASS_ECONOMY) {
  for (const [m, t] of [[v.sceneMat, v.cabinClass.target], [v.seatMat, v.hdrSeat]]) {
    m.defines = { ...(m.defines || {}), CABIN_CLASS_ECONOMY: 1 };
    m.needsUpdate = true;
    const pm = P.mesh.material;
    P.mesh.material = m;
    r.setRenderTarget(t);
    await r.compileAsync(P.scene, P.camera);
    P.render(m, t);
    P.mesh.material = pm;
  }
  r.setRenderTarget(null);
}
return "econ";
