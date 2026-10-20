import type { Obj } from './types';

/** Translate the anchor and every strip vertex by the same delta. */
export function moveFixturePosition(f: Obj, x: number, y: number) {
  const dx = x - Number(f.x), dy = y - Number(f.y);
  const round = (n: number) => Math.round(n * 100) / 100;
  if (Array.isArray(f.stripPath)) f.stripPath = f.stripPath.map((p: Obj) => ({...p, x: round(+p.x + dx), y: round(+p.y + dy)}));
  f.x = round(x); f.y = round(y);
}

/** Small reusable preview primitive; geometry depends on optics, not brightness. */
export function createFixtureBeam(T: any, mount: number, angle: number) {
  const radius = mount * Math.tan(Math.max(5, Math.min(140, angle)) * Math.PI / 360);
  const geometry = new T.ConeGeometry(radius, mount, 32, 12, true);
  const colors: number[] = [], positions = geometry.attributes.position;
  for (let i = 0; i < positions.count; i++) {
    const t = Math.max(0, Math.min(1, positions.getY(i) / mount + .5));
    colors.push(.12 + .88*t, .12 + .88*t, .12 + .88*t);
  }
  geometry.setAttribute('color', new T.Float32BufferAttribute(colors, 3));
  const cone = new T.Mesh(geometry, new T.MeshBasicMaterial({color:0xffcc88, vertexColors:true, transparent:true, opacity:.18, blending:T.AdditiveBlending, depthWrite:false, side:T.DoubleSide}));
  cone.renderOrder = 2;
  return {cone, radius};
}
