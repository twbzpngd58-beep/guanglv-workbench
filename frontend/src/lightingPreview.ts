import type { Obj } from './types';

/** Translate the anchor and every strip vertex by the same delta. */
export function moveFixturePosition(f: Obj, x: number, y: number) {
  const dx = x - Number(f.x), dy = y - Number(f.y);
  const round = (n: number) => Math.round(n * 100) / 100;
  if (Array.isArray(f.stripPath)) f.stripPath = f.stripPath.map((p: Obj) => ({...p, x: round(+p.x + dx), y: round(+p.y + dy)}));
  f.x = round(x); f.y = round(y);
}

/** 光锥贴图：纵向渐变（顶端亮、末端几乎透明）。优邑珺和就是用这个做「暖雾」，不是白三角。 */
let _beamTex: any = null;
function beamTexture(T: any): any {
  if (_beamTex) return _beamTex;
  const c = document.createElement("canvas");
  c.width = 8; c.height = 128;
  const g = c.getContext("2d");
  if (g) {
    const grd = g.createLinearGradient(0, 0, 0, 128);
    grd.addColorStop(0.00, "rgba(255,255,255,0.62)");
    grd.addColorStop(0.30, "rgba(255,255,255,0.34)");
    grd.addColorStop(0.70, "rgba(255,255,255,0.12)");
    grd.addColorStop(1.00, "rgba(255,255,255,0.02)");
    g.fillStyle = grd; g.fillRect(0, 0, 8, 128);
  }
  _beamTex = new T.CanvasTexture(c);
  _beamTex.needsUpdate = true;
  return _beamTex;
}

/** Small reusable preview primitive; geometry depends on optics, not brightness. */
export function createFixtureBeam(T: any, mount: number, angle: number) {
  const radius = mount * Math.tan(Math.max(5, Math.min(140, angle)) * Math.PI / 360);
  const geometry = new T.ConeGeometry(radius, mount, 28, 1, true);
  const cone = new T.Mesh(geometry, new T.MeshBasicMaterial({
    map: beamTexture(T), color: 0xffc188, transparent: true, opacity: 0.12,
    blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide, toneMapped: false,
  }));
  cone.renderOrder = 2;
  return { cone, radius };
}
