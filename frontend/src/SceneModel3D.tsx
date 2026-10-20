import { useEffect, useRef, useState } from "react";
import { api, type Design, type Obj } from "./types";
import type { Selection } from "./Plan";
import { wallMount, type WallSeg } from "./wallMount";
import { furnitureParts, furnitureYaw, FURN_HEIGHT } from "./furnitureModels";
import { furniturePoints, hasFurniturePolygon, normalizeFurniture, outlineDrivesShape } from "./furniturePolygon";
import { furnitureTopAt, isTabletopDevice } from "./deviceMount";
import { boundary, spaceShell } from "./spaceGeometry";
import { createFixtureBeam } from './lightingPreview';
import { lightPoolPolygon } from './lightOcclusion';
import { useSceneFade } from './sceneFade';
import { coverageAbsolute } from './sensors';

declare global {
  interface Window { THREE?: any }
}

let threeReady: Promise<any> | undefined;

/** 地面光斑几何：以灯位为原点，把裁剪多边形（设计单位）扇形三角化，首尾相接。 */
function poolClipGeometry(T: any, poly: Obj[], radius: number, units = 26) {
  const pos: number[] = [], uv: number[] = [];
  for (let i = 1; i < poly.length; i += 1) {
    const a = poly[i], b = i + 1 < poly.length ? poly[i + 1] : poly[1];
    for (const q of [{ x: 0, y: 0 }, a, b]) {
      const lx = q.x / units, lz = q.y / units;
      pos.push(lx, 0, lz);
      uv.push(.5 + lx / radius / 2, .5 - lz / radius / 2);
    }
  }
  const geo = new T.BufferGeometry();
  geo.setAttribute("position", new T.Float32BufferAttribute(pos, 3));
  geo.setAttribute("uv", new T.Float32BufferAttribute(uv, 2));
  return geo;
}

/** 光锥（光束）同样止于墙：圆锥换成「顶点 → 裁剪边界」的扇面（顶点亮、边缘暗，与原锥一致）。 */
function coneClipGeometry(T: any, poly: Obj[], mount: number, units = 26) {
  const rim = poly.slice(1).map((p) => ({ x: p.x / units, z: p.y / units }));
  const pos: number[] = [], colors: number[] = [];
  const push = (x: number, y: number, z: number, shade: number) => {
    pos.push(x, y, z);
    colors.push(shade, shade, shade);
  };
  for (let i = 0; i < rim.length; i += 1) {
    const a = rim[i], b = rim[(i + 1) % rim.length];
    push(0, mount / 2, 0, 1);
    push(a.x, -mount / 2, a.z, .12);
    push(b.x, -mount / 2, b.z, .12);
  }
  const geo = new T.BufferGeometry();
  geo.setAttribute("position", new T.Float32BufferAttribute(pos, 3));
  geo.setAttribute("color", new T.Float32BufferAttribute(colors, 3));
  return geo;
}

/** 光斑（地面）+ 光锥一起按裁剪范围重做几何；裁不出来（灯不在任何空间里）就回到整圆/整锥。 */
function applyFixtureClip(
  T: any, design: Obj, fixture: Obj, glow: any, cone: any, radius: number, mount: number,
) {
  const poly = lightPoolPolygon(design, fixture, radius * 26);
  if (poly && poly.length >= 4) {
    glow.geometry.dispose();
    glow.geometry = poolClipGeometry(T, poly, radius);
    glow.rotation.x = 0;
    glow.scale.setScalar(1);
    glow.userData.clipped = true;
    if (cone) {
      cone.geometry.dispose();
      cone.geometry = coneClipGeometry(T, poly, mount);
      cone.userData.clipped = true;
    }
  } else {
    glow.geometry.dispose();
    glow.geometry = new T.CircleGeometry(.66, 32);
    glow.rotation.x = -Math.PI / 2;
    glow.scale.setScalar(radius / .66);
    glow.userData.clipped = false;
    if (cone) {
      cone.geometry.dispose();
      cone.geometry = new T.ConeGeometry(radius, mount, 32, 12, true);
      const colors: number[] = [], positions = cone.geometry.attributes.position;
      for (let i = 0; i < positions.count; i++) {
        const t = Math.max(0, Math.min(1, positions.getY(i) / mount + .5));
        colors.push(.12 + .88 * t, .12 + .88 * t, .12 + .88 * t);
      }
      cone.geometry.setAttribute("color", new T.Float32BufferAttribute(colors, 3));
      cone.userData.clipped = false;
    }
  }
}

function loadThree(): Promise<any> {
  if (window.THREE?.OrbitControls) return Promise.resolve(window.THREE);
  if (!threeReady) {
    threeReady = (async () => {
      for (const [test, url] of [
        [() => !!window.THREE, "/lighting3d-engine/vendor/three.min.js"],
        [() => !!window.THREE?.OrbitControls, "/lighting3d-engine/vendor/OrbitControls.js"],
      ] as const) {
        if (test()) continue;
        await new Promise<void>((resolve, reject) => {
          const script = document.createElement("script");
          script.src = url;
          script.onload = () => resolve();
          script.onerror = () => { script.remove(); reject(new Error(`三维资源加载失败：${url}`)); };
          document.head.appendChild(script);
        });
      }
      return window.THREE;
    })().catch((error) => { threeReady = undefined; throw error; });
  }
  return threeReady;
}

/** 光斑贴图：径向渐变的暖光圈。
 *  2026-10-16 报「三维里看不到灯具亮灯效果」——原来是「纯色圆盘平铺」，在浅色地面上几乎看不见；
 *  换成径向渐变 + 加色混合，才像一摊真的灯光。贴图只做一次，所有灯具共用。 */
let _poolTex: any = null;
function poolTexture(): any {
  const T = (window as any).THREE;
  if (_poolTex) return _poolTex;
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d");
  if (g) {
    const grd = g.createRadialGradient(64, 64, 2, 64, 64, 62);
    grd.addColorStop(0, "rgba(255,244,218,0.98)");
    grd.addColorStop(0.30, "rgba(255,214,150,0.62)");
    grd.addColorStop(0.62, "rgba(255,196,120,0.22)");
    grd.addColorStop(1, "rgba(255,190,110,0)");
    g.fillStyle = grd;
    g.fillRect(0, 0, 128, 128);
  }
  _poolTex = new T.CanvasTexture(c);
  return _poolTex;
}

/** The scene editor has ONE independent WebGL canvas, not the global #c used by the plan editor. */
export function SceneModel3D({
  projectId, hasDxf, design, floor, background, scene: activeScene,
  selection, onSelect, onPlacePoint, showFixtures = true, showDevices = true,
  selectedRoomId = "",
  selectedFurnitureId = "", onFurnitureSelect, onFixtureMove, showFurniture = true, placingLamps = false, editFixtures = false,
  roam = null, onRoamMove,
}: {
  projectId: string;
  hasDxf: boolean;
  design: Design;
  floor: number;
  background?: string;
  scene?: Obj;
  selection?: Selection;
  onSelect?: (s: Selection) => void;
  onPlacePoint?: (point: { x: number; y: number }) => void;
  showFixtures?: boolean;
  showDevices?: boolean;
  selectedRoomId?: string;
  selectedFurnitureId?: string;
  onFurnitureSelect?: (id: string) => void;
  /** 拖完一盏灯就把新位置报给外层（2026-10-16：三维里灯具要能挪）。 */
  onFixtureMove?: (id: string, x: number, y: number) => void;
  showFurniture?: boolean;
  /** 正在「放置灯具」：不铺光斑（一团光晕挡着看不清灯在哪），只留灯具图标（2026-10-16）。 */
  placingLamps?: boolean;
  editFixtures?: boolean;
  /** 小人漫游（2026-10-17「3d 界面中小人漫游无法使用」）：非空＝在这个设计坐标画小人，
   *  按住地面拖动就走；传感器范围同时铺在地上，走进范围关联灯亮（外层已叠进 scene）。 */
  roam?: { x: number; y: number } | null;
  onRoamMove?: (x: number, y: number) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const onPlacePointRef = useRef(onPlacePoint);
  onPlacePointRef.current = onPlacePoint;
  const onFurnitureSelectRef = useRef(onFurnitureSelect);
  onFurnitureSelectRef.current = onFurnitureSelect;
  const onFixtureMoveRef = useRef(onFixtureMove);
  onFixtureMoveRef.current = onFixtureMove;
  const onRoamMoveRef = useRef(onRoamMove);
  onRoamMoveRef.current = onRoamMove;
  const topViewRef = useRef<(() => void) | null>(null);
  const [topView, setTopView] = useState(false);
  const [night, setNight] = useState(false), [beams, setBeams] = useState(true);
  const appearance = useRef({night, beams, editFixtures});
  appearance.current = {night, beams, editFixtures};
  // 俯视图是锁定状态：画布重建（改灯位、换情景）不能把它悄悄弹回立体角度
  const topOn = useRef(false);
  const [model, setModel] = useState<Obj | null>(null);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const lightMeshes = useRef<Map<string, any>>(new Map());
  const selectedMeshes = useRef<Map<string, any>>(new Map());
  // 情景切换渐变（2026-10-17「渐变时间失效」）：三维里也要按情景的渐变时间缓变，
  // 不能瞬间跳变。shownStates 逐帧变化，下面的渲染循环据此重画。
  const shownStates = useSceneFade(activeScene);
  const live = useRef({ activeScene, activeStates: shownStates, selection, showFixtures, showDevices, selectedRoomId, selectedFurnitureId, showFurniture, placingLamps, roam });
  live.current = { activeScene, activeStates: shownStates, selection, showFixtures, showDevices, selectedRoomId, selectedFurnitureId, showFurniture, placingLamps, roam };

  useEffect(() => {
    let cancelled = false;
    setModel(null);
    setError("");
    if (!hasDxf) return;
    api<Obj>(`/lighting3d/${projectId}/data.json`).then((result) => {
      if (!cancelled) {
        if (result.error) setError(result.error);
        else { setModel(result); setError(""); }
      }
    }).catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [projectId, hasDxf]);

  useEffect(() => {
    let disposed = false;
    let cleanup = () => {};
    setReady(false);
    loadThree().then((THREE) => {
      const el = host.current;
      if (disposed || !el) return;
      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
      renderer.setClearColor(0x1c2927);
      renderer.outputEncoding = THREE.sRGBEncoding;
      el.appendChild(renderer.domElement);
      const world = new THREE.Scene();
      world.background = new THREE.Color(0x1c2927);
      const camera = new THREE.PerspectiveCamera(48, 1, .05, 250);
      const controls = new THREE.OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.maxPolarAngle = Math.PI / 2.08;
      const hemi = new THREE.HemisphereLight(0xe4f3ff, 0x484d40, .9);
      world.add(hemi);
      const sun = new THREE.DirectionalLight(0xffe9c8, .65);
      sun.position.set(-8, 16, 9);
      world.add(sun);

      // DXF geometry is only assigned to floor 1: the parser does not carry a floor
      // identifier. Never present the same CAD walls as verified geometry on every level.
      const floorRooms = design.rooms.filter(r => +(r.floor || 1) === floor && boundary(r).length >= 3);
      const designPoints = floorRooms.flatMap(r => boundary(r));
      const useDesign = designPoints.length > 0 || ["confirmed", "previewing"].includes(design.spaceDefinition?.status);
      const cad = !useDesign && floor === 1 && Array.isArray(model?.walls) && model.walls.length > 0;
      const rawBox = designPoints.length ? [
        Math.min(...designPoints.map(p => p.x)) / 26, Math.min(...designPoints.map(p => p.y)) / 26,
        Math.max(...designPoints.map(p => p.x)) / 26, Math.max(...designPoints.map(p => p.y)) / 26,
      ] : cad ? model!.bbox : null;
      const box = Array.isArray(rawBox) && rawBox.length === 4
        ? rawBox.map(Number) : [0, 0, 20, 16];
      const [x0, z0, x1, z1] = box;
      const width = Math.max(1, x1 - x0), depth = Math.max(1, z1 - z0);
      const centerX = (x0 + x1) / 2, centerZ = (z0 + z1) / 2;
      const toWorld = (x: number, z: number) => [x - centerX, z - centerZ];
      // CAD 项目：设计坐标 = 米 × 26（与导出 DXF、二维画布、图纸灯位同步同一口径）；
      // 无 CAD 的项目沿用 820×690 画布铺满模型范围。
      const fromPlan = (x: number, y: number) => cad || useDesign
        ? toWorld(x / 26, y / 26)
        : toWorld(x0 + x / 820 * width, z0 + y / 690 * depth);
      const floorMesh = new THREE.Mesh(
        new THREE.PlaneGeometry(width, depth),
        new THREE.MeshStandardMaterial({ color: 0xb0bdb0, side: THREE.DoubleSide, roughness: .98,
          transparent: useDesign && !background, opacity: useDesign && !background ? 0 : 1,
          depthWrite: !(useDesign && !background) }),
      );
      floorMesh.rotation.x = -Math.PI / 2;
      floorMesh.position.y = -.025;
      world.add(floorMesh);
      if (background) {
        const texture = new THREE.TextureLoader().load(background, () => { if (!disposed) render(); },
          undefined, () => { if (!disposed) setError("底图贴图无法加载，已显示模型与设备"); });
        texture.encoding = THREE.sRGBEncoding;
        floorMesh.material.map = texture;
        floorMesh.material.needsUpdate = true;
      }
      const wallMat = new THREE.MeshStandardMaterial({ color: 0x9dafa6, roughness: .86, side: THREE.DoubleSide });
      // 墙段同时按世界坐标存一份：面板这类墙装设备要吸到墙上（不能悬浮在半空）。
      const wallSegs: WallSeg[] = [];
      const roomPatches: { id: string; color: any; mesh: any }[] = [];
      const furnitureGroups: { id: string; group: any; outline: any }[] = [];
      const furnitureHits: any[] = [];
      function segment(ax: number, az: number, bx: number, bz: number, height: number, thickness: number, bottom = 0) {
        if (![ax, az, bx, bz].every(Number.isFinite)) return;
        const length = Math.hypot(bx - ax, bz - az);
        if (length < .02) return;
        const thick = Math.max(.06, thickness);
        const wall = new THREE.Mesh(
          new THREE.BoxGeometry(length, height, thick), wallMat);
        const [cx, cz] = toWorld((ax + bx) / 2, (az + bz) / 2);
        wall.position.set(cx, bottom + height / 2, cz);
        wall.rotation.y = -Math.atan2(bz - az, bx - ax);
        world.add(wall);
        const [wax, waz] = toWorld(ax, az);
        const [wbx, wbz] = toWorld(bx, bz);
        wallSegs.push({ ax: wax, az: waz, bx: wbx, bz: wbz, t: thick, h: height });
      }
      if (cad) {
        for (const w of model!.walls) {
          segment(+w.x0, +w.z0, +w.x1, +w.z1, Math.min(2.1, Number(model!.wall_cut) || 1.5), +w.t || .12);
        }
      }
      if (cad || useDesign) {
        // 家具走共享的固定样式（frontend/src/furnitureModels.ts），与三维页引擎同一套构件表：
        // 以前这里每件只是一个大方盒——2026-10-14「家具基本上都是矩形框」说的就是它。
        // 材质四档（木/布/白/金属），朝向按「背面贴最近的墙」自动转正。
        const furnMats: any[] = [
          null,
          new THREE.MeshStandardMaterial({ color: 0xa9834f, roughness: .90 }),   // 木
          new THREE.MeshStandardMaterial({ color: 0x93a094, roughness: .95 }),   // 布
          new THREE.MeshStandardMaterial({ color: 0xe4e0d6, roughness: .85 }),   // 白
          new THREE.MeshStandardMaterial({ color: 0xa9b1b6, roughness: .50 }),   // 金属
        ];
        const furniture = Array.isArray(design.furniture) ? design.furniture
          .filter(f => +(f.floor || 1) === floor)
          // 画之前先规范：有轮廓的件 x/y 一律取轮廓外接框中心（2026-10-16「形状全错、穿墙」
          // 就是 x/y 被别的写入方覆盖成了老位置、轮廓却在新位置——三维盒子于是画到墙外）。
          .map(f => {
            const nf = normalizeFurniture(f);
            return { id: nf.id, kind: nf.kind, x: +nf.x / 26, z: +nf.y / 26,
              w: +nf.widthM, d: +nf.depthM, h: +nf.heightM,
              rot: -(+nf.rotation || 0), designFurniture: true,
              // 只有「占地即形状」的大类（柜/沙发/岛台/地毯）且轮廓明显不是矩形时才挤出；
              // 马桶、浴缸、床这些器物一律用标准造型（2026-10-16）。
              pts: outlineDrivesShape(nf) ? furniturePoints(nf) : null };
          })
          : (model?.furniture || []).map((f: Obj, i: number) => ({ ...f, id: `cad-furniture-${f.id || f.i || i}` }));
        el.dataset.modelFurniture = String(furniture.length);
        for (const item of furniture) {
          if (![item.x, item.z, item.w, item.d, item.h].every((v: any) => Number.isFinite(+v))) continue;
          if (useDesign && !(+item.x >= x0 && +item.x <= x1 && +item.z >= z0 && +item.z <= z1)) continue;
          const [fx, fz] = toWorld(+item.x, +item.z);
          const fit = item.designFurniture ? { yaw: 0, w: +item.w, d: +item.d }
            : furnitureYaw(fx, fz, +item.w, +item.d, wallSegs, String(item.kind || ""));
          const group = new THREE.Group();
          group.position.set(fx, 0, fz);
          // 逐件改过的朝向（rot 度）优先，其次是贴墙推断出来的
          group.rotation.y = item.rot != null ? (Number(item.rot) || 0) * Math.PI / 180 : fit.yaw;
          if (Array.isArray(item.pts) && item.pts.length >= 3) {
            // 画过轮廓的家具（2026-10-16「主卧衣帽间的柜子轮廓我改过、没生效」）：
            // 按轮廓挤出真形状；只按外接框画，L 形柜子会变成一个方盒子。
            const shape = new THREE.Shape();
            item.pts.forEach((q: Obj, i: number) => {
              const [px, pz] = fromPlan(+q.x, +q.y);
              const lx = px - fx, lz = pz - fz;
              if (!i) shape.moveTo(lx, -lz); else shape.lineTo(lx, -lz);
            });
            shape.closePath();
            const solid = new THREE.Mesh(
              new THREE.ExtrudeGeometry(shape, { depth: Math.max(.02, +item.h), bevelEnabled: false }),
              furnMats[1]);
            solid.rotation.x = -Math.PI / 2;
            solid.userData = { kind: "furniture", id: item.id };
            furnitureHits.push(solid);
            group.add(solid);
          } else {
            const parts = furnitureParts(String(item.kind || ""), fit.w, fit.d, +item.h);
            const maxY = Math.max(.01, ...parts.map(p => p.y + p.h / 2));
            if (item.designFurniture) group.scale.y = +item.h / maxY;
            for (const part of parts) {
              const mat = furnMats[part.m] || furnMats[1];
              const mesh = part.k === "cyl"
                ? new THREE.Mesh(new THREE.CylinderGeometry(Math.max(.02, part.r), Math.max(.02, part.r), Math.max(.02, part.h), 20), mat)
                : new THREE.Mesh(new THREE.BoxGeometry(Math.max(.02, part.w), Math.max(.02, part.h), Math.max(.02, part.d)), mat);
              mesh.position.set(part.x, part.y, part.z);
              mesh.userData = { kind: "furniture", id: item.id };
              furnitureHits.push(mesh);
              group.add(mesh);
            }
          }
          world.add(group);
          const outline = new THREE.BoxHelper(group, 0xf4ba64);
          outline.visible = false; world.add(outline);
          furnitureGroups.push({ id: item.id, group, outline });
        }
      }
      if (!cad) {
        const shell = spaceShell(design, floor);
        for (const w of shell.walls) segment(w.x / 26, w.y / 26, w.x2 / 26, w.y2 / 26, w.heightM, w.thicknessM, w.bottomM);
        for (const room of floorRooms) {
          const pts = boundary(room), shape = new THREE.Shape();
          pts.forEach((p, i) => {
            const [x, z] = fromPlan(p.x, p.y);
            if (!i) shape.moveTo(x, -z); else shape.lineTo(x, -z);
          });
          shape.closePath();
          const floorPatch = new THREE.Mesh(new THREE.ShapeGeometry(shape),
            new THREE.MeshStandardMaterial({ color: room.color || "#d8d9cf", roughness: .95, side: THREE.DoubleSide }));
          floorPatch.rotation.x = -Math.PI / 2; floorPatch.position.y = .005; world.add(floorPatch);
          roomPatches.push({id:room.id,color:floorPatch.material.color.clone(),mesh:floorPatch});
        }
        for (const opening of shell.openings) {
          const [x, z] = fromPlan((opening.x + opening.x2) / 2, (opening.y + opening.y2) / 2);
          const widthM = opening.width / 26, h = opening.heightM, sill = opening.sillHeight;
          const g = new THREE.Group(); g.position.set(x, sill, z);
          g.rotation.y = -Math.atan2(opening.y2 - opening.y, opening.x2 - opening.x);
          const frameMat = new THREE.MeshStandardMaterial({ color: opening.type === "窗" ? 0x628f9e : 0x997448 });
          for (const part of [[.04,h,.14,-widthM/2,h/2],[.04,h,.14,widthM/2,h/2],[widthM,.04,.14,0,h]]) {
            const mesh = new THREE.Mesh(new THREE.BoxGeometry(part[0],part[1],part[2]),frameMat);
            mesh.position.set(part[3],part[4],0);g.add(mesh);
          }
          if (opening.type === "窗") {
            const pane = new THREE.Mesh(new THREE.BoxGeometry(widthM,h,.02),
              new THREE.MeshStandardMaterial({color:0x98d4e5,transparent:true,opacity:.26,depthWrite:false}));
            pane.position.y=h/2;g.add(pane);
          }
          world.add(g);
        }
        el.dataset.modelWalls = String(shell.walls.length);
        el.dataset.modelOpenings = String(shell.openings.length);
        el.dataset.modelRooms = String(floorRooms.length);
      }
      const hits: any[] = [];
      const cadDots: any[] = [];
      const fixtureLabels: any[] = [];
      const deviceLabels: any[] = [];
      const roomLabels: any[] = [];
      function label(text: string, x: number, z: number, color: string, bucket: any[], y = .67) {
        if (!text) return;
        const sheet = document.createElement("canvas");
        sheet.width = 256;
        sheet.height = 64;
        const ctx = sheet.getContext("2d");
        if (!ctx) return;
        ctx.fillStyle = "#12211eee";
        ctx.fillRect(0, 0, 256, 64);
        ctx.strokeStyle = color;
        ctx.strokeRect(1, 1, 254, 62);
        ctx.fillStyle = "#f7f7ee";
        ctx.font = "bold 32px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(text, 128, 33, 244);
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
          map: new THREE.CanvasTexture(sheet), depthTest: false, transparent: true,
        }));
        sprite.position.set(x, y, z);
        sprite.scale.set(1.18, .29, 1);
        world.add(sprite);
        bucket.push(sprite);
      }
      for (const room of design.rooms.filter((r) => (r.floor || 1) === floor)) {
        const members = [
          ...design.fixtures.filter((f) => f.roomId === room.id && (f.floor || 1) === floor),
          ...design.devices.filter((d) => d.roomId === room.id && (d.floor || 1) === floor),
        ].filter((item) => Number.isFinite(+item.x) && Number.isFinite(+item.y));
        if (!members.length && !(+room.width > 2 && +room.height > 2)) continue;
        const center = members.length
          ? { x: members.reduce((sum, m) => sum + +m.x, 0) / members.length,
              y: members.reduce((sum, m) => sum + +m.y, 0) / members.length }
          : { x: +room.x + +room.width / 2, y: +room.y + +room.height / 2 };
        const [rx, rz] = fromPlan(center.x, center.y);
        label(String(room.name || room.type || "空间"), rx, rz, "#9fb6a6", roomLabels);
        const last = roomLabels[roomLabels.length - 1];
        if (last) last.position.y = 1.25;
      }
      lightMeshes.current = new Map();
      selectedMeshes.current = new Map();
      for (const fixture of design.fixtures.filter((f) => (f.floor || 1) === floor)) {
        if (!Number.isFinite(+fixture.x) || !Number.isFinite(+fixture.y)) continue;
        const [x, z] = fromPlan(+fixture.x, +fixture.y);
        const marker = new THREE.Mesh(new THREE.SphereGeometry(.12, 12, 10),
          new THREE.MeshStandardMaterial({ color: 0xe8cca1, emissive: 0xffb955, emissiveIntensity: .6, depthTest: false }));
        marker.renderOrder = 20;
        marker.position.set(x, .23, z);
        marker.userData = { kind: "fixtures", id: fixture.id, roomId: fixture.roomId };
        const glow = new THREE.Mesh(new THREE.CircleGeometry(.66, 32),
          new THREE.MeshBasicMaterial({ map: poolTexture(), color: 0xffc98a, transparent: true,
            opacity: .42, blending: THREE.AdditiveBlending,
            depthWrite: false, side: THREE.DoubleSide }));
        glow.rotation.x = -Math.PI / 2;
        glow.position.set(x, .015, z);
        // 灯具图标（2026-10-16「需要有灯具图标，方便移动」）：地上一枚**灯符号**——
        // 深色外圈＋暖色灯面＋中心亮点（跟二维画布那个灯点一个意思），放在光斑之上。
        // 关键在于：不管光斑在不在、灯亮不亮，这个符号始终看得见，俯视图才认得出「哪是一盏灯」。
        const icon = new THREE.Group();
        const flat = (geo: any, color: number, y: number, opacity = 1) => {
          const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
            color, transparent: true, opacity, depthTest: false, depthWrite: false, side: THREE.DoubleSide }));
          mesh.renderOrder = 21;
          mesh.rotation.x = -Math.PI / 2;
          mesh.position.y = y;
          icon.add(mesh);
          return mesh;
        };
        flat(new THREE.RingGeometry(.24, .305, 32), 0x6f4f1c, .030);   // 深色外圈：白地面/暖光斑上都压得住
        flat(new THREE.CircleGeometry(.225, 32), 0xffc978, .032);      // 灯面
        flat(new THREE.CircleGeometry(.075, 16), 0xfff6de, .034);      // 中心亮点
        icon.position.set(x, 0, z);
        // 抓取球（2026-10-16「能选中灯具但不能拖动」）：0.42m 的隐形球，
        // 点/拖灯靠它命中——原来只有 0.12m 的小球，鼠标根本点不中，更别说拖。
        const grab = new THREE.Mesh(new THREE.SphereGeometry(.42, 10, 8),
          new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }));
        grab.position.set(x, .24, z);
        grab.userData = { kind: "fixtures", id: fixture.id, roomId: fixture.roomId };
        world.add(marker, glow, icon, grab);
        let strip;
        const stripY = Math.max(.3, (+fixture.installHeight || +floorRooms.find(r => r.id === fixture.roomId)?.heightM || 2.8) - .05);
        if (fixture.stripPath?.length > 1) {
          const path = fixture.stripPath.map((p: Obj) => {
            const [px, pz] = fromPlan(+p.x, +p.y);
            // 灯带装在吊顶 / 灯槽里（2026-10-17「3D 视角下在地面上，这是不对的」）：按安装高度画，不贴地。
            return new THREE.Vector3(px, stripY, pz);
          });
          strip = new THREE.Line(new THREE.BufferGeometry().setFromPoints(path),
            new THREE.LineBasicMaterial({ color: 0xffd07f, depthTest: false, depthWrite: false, transparent: true }));
          strip.renderOrder = 22;
          world.add(strip);
        }
        hits.push(marker, grab);
        const mount = Math.max(.3, +fixture.installHeight || +floorRooms.find(r => r.id === fixture.roomId)?.heightM || 2.8);
        const { cone, radius } = createFixtureBeam(THREE, mount, +fixture.beamAngle || 36);
        cone.position.set(x, mount / 2 + .03, z); cone.renderOrder = 2;
        world.add(cone); glow.scale.setScalar(radius / .66);
        // 光斑与光锥都不穿墙、门、高柜（2026-10-17）：与二维同一套射线裁剪。
        // 拖灯时（dragMove）会带着新位置再裁一次，见下面的 applyFixtureClip。
        if (cad || useDesign) applyFixtureClip(THREE, design, fixture, glow, cone, radius, mount);
        lightMeshes.current.set(fixture.id, { marker, glow, strip, icon, grab, cone, fixture, radius, mount });
        selectedMeshes.current.set(fixture.id, marker);
        // 灯具编号不再挂在画布上（2026-10-16：编号标签压在灯图标上，图标都看不见了）：
        // 编号与灯具基本信息改成单击灯具后在页面读数（.canvas-lamp-badge / 右侧属性）里看。
      }
      // Imported CAD lights may exist before the user syncs them into the editable
      // design. Show their real CAD positions without pretending they are selectable design lamps.
      if (cad && !design.fixtures.some((f) => (f.floor || 1) === floor)) {
        for (const lamp of model!.lights || []) {
          if (!Number.isFinite(+lamp.x) || !Number.isFinite(+lamp.z)) continue;
          const [x, z] = toWorld(+lamp.x, +lamp.z);
          const dot = new THREE.Mesh(new THREE.SphereGeometry(.09, 10, 8),
            new THREE.MeshStandardMaterial({ color: 0xffd89c, emissive: 0xffbb67, emissiveIntensity: 1.2 }));
          dot.position.set(x, .16, z);
          world.add(dot);
          cadDots.push(dot);
        }
      }
      for (const device of design.devices.filter((d) => (d.floor || 1) === floor)) {
        if (!Number.isFinite(+device.x) || !Number.isFinite(+device.y)) continue;
        const [x, z] = fromPlan(+device.x, +device.y);
        const panel = device.type === "面板";
        // 面板 / 温控器是墙面设备：吸到最近一段墙上并转正（背面贴墙、正面朝室内）。
        // 2026-10-14：面板加进设计后不能悬浮在空间里，必须是装在墙上的。
        // 2026-10-16：① 安装高度可自己设（device.installHeight，没设＝墙高中上部的默认值）；
        // ②「时光之轮」遥控器除外——它不是墙装件，直接在家具/空间里可见，
        //    点在家具（比如茶几）上就出现在家具顶面，点在空间里就落在地面。
        const tabletop = isTabletopDevice(device);
        const wallPlate = !tabletop && (panel || device.type === "温控器");
        const keys = Math.max(1, Math.min(12, Number(device.keys) || 4));
        const plateW = panel ? (keys > 8 ? .34 : .22) : .16;
        const plateH = panel ? .22 : .16;
        const plateD = .028;
        // 墙面件＝薄板；桌面遥控器（时光之轮）＝小圆盘——它本来就是旋钮盘 + 磁吸无线充电。
        const marker = new THREE.Mesh(
          tabletop
            ? new THREE.CylinderGeometry(.05, .05, .032, 20)
            : new THREE.BoxGeometry(wallPlate ? plateW : .32, wallPlate ? plateH : .38, wallPlate ? plateD : .12),
          new THREE.MeshStandardMaterial({ color: panel ? 0x4dbdcc : 0x90c992 }));
        let labelY = .67;
        const setHeight = Number(device.installHeight);
        const mount = wallPlate
          ? wallMount(x, z, plateD, wallSegs,
              Number.isFinite(setHeight) && setHeight > 0 ? { height: setHeight } : {})
          : null;
        const onFurniture = tabletop && Array.isArray(design.furniture)
          ? furnitureTopAt(design.furniture as Obj[], +device.x, +device.y, +(device.floor || 1))
          : null;
        if (mount) {
          marker.position.set(mount.x, mount.y, mount.z);
          marker.rotation.y = mount.rotY;
          labelY = Math.min(1.6, mount.y + plateH / 2 + .16);
        } else if (tabletop) {
          // 遥控器坐在家具顶面上（家具外面就落在地面）：圆盘平放，标签抬高一点别压住它。
          marker.position.set(x, (onFurniture ?? 0) + .016, z);
          labelY = (onFurniture ?? 0) + .34;
        } else {
          // 没有可用墙面（空间还没确认 / 图纸里没有墙）：保留原来的立式标记，不假装贴在墙上
          marker.position.set(x, wallPlate ? .34 : .23, z);
        }
        if (panel && !tabletop) {
          const face = document.createElement("canvas");
          face.width = 256;
          face.height = 256;
          const ctx = face.getContext("2d");
          if (ctx) {
            ctx.fillStyle = "#34454b";
            ctx.fillRect(0, 0, 256, 256);
            ctx.fillStyle = "#e8f3eb";
            ctx.textAlign = "center";
            ctx.font = "20px sans-serif";
            ctx.fillText([device.brand, device.series, device.model].filter(Boolean).join(" · ") || "面板", 128, 27, 240);
            const cols = keys > 8 ? 3 : keys > 1 ? 2 : 1;
            const rows = Math.ceil(keys / cols);
            const cellWidth = 236 / cols, cellHeight = 214 / rows;
            for (let i = 0; i < keys; i += 1) {
              const col = i % cols, row = Math.floor(i / cols);
              const px = 10 + col * cellWidth, py = 38 + row * cellHeight;
              ctx.strokeStyle = "#a4b7af";
              ctx.strokeRect(px, py, cellWidth - 5, cellHeight - 5);
              ctx.fillStyle = "#ffffff";
              ctx.font = `${rows > 3 ? 11 : rows > 2 ? 13 : 16}px sans-serif`;
              ctx.fillText(String(device.keyLabels?.[i] || `键 ${i + 1}`),
                px + (cellWidth - 5) / 2, py + cellHeight * .42, cellWidth - 10);
              ctx.font = `${rows > 3 ? 9 : 12}px sans-serif`;
              ctx.fillText(String(device.keyLongLabels?.[i] || ""),
                px + (cellWidth - 5) / 2, py + cellHeight * .72, cellWidth - 10);
            }
            marker.material = [
              marker.material, marker.material, marker.material, marker.material,
              new THREE.MeshStandardMaterial({ map: new THREE.CanvasTexture(face) }), marker.material,
            ];
          }
        }
        marker.userData = { kind: "devices", id: device.id };
        world.add(marker);
        hits.push(marker);
        selectedMeshes.current.set(device.id, marker);
        label(String(device.code || device.name || device.type), x, z,
          panel ? "#64c4df" : "#a8d6ac", deviceLabels, labelY);
      }
      // 小人漫游：小人（身子＋头，始终在最上层）＋各传感器裁剪后的探测范围（与二维 / 判定同一套几何）。
      const walker = new THREE.Group();
      // 不做深度测试：墙高 2.8 m、小人 1.4 m，从斜上方看会被前面的墙挡住——小人要像灯具图标一样始终看得见。
      const walkerMat = new THREE.MeshBasicMaterial({ color: 0x3fa7cf, depthTest: false, transparent: true, opacity: .95 });
      const body = new THREE.Mesh(new THREE.CylinderGeometry(.16, .2, 1.1, 16), walkerMat);
      body.position.y = .55;
      const head = new THREE.Mesh(new THREE.SphereGeometry(.16, 16, 12), walkerMat);
      head.position.y = 1.32;
      const halo = new THREE.Mesh(new THREE.RingGeometry(.32, .42, 32),
        new THREE.MeshBasicMaterial({ color: 0x5fc3e4, transparent: true, opacity: .85, side: THREE.DoubleSide, depthTest: false }));
      halo.rotation.x = -Math.PI / 2; halo.position.y = .03; halo.renderOrder = 23;
      body.renderOrder = head.renderOrder = 24;
      walker.add(body, head, halo);
      walker.visible = false;
      world.add(walker);
      const sensorZones: any[] = [];
      for (const dev of design.devices.filter((v) => v.type === "传感器" && (v.floor || 1) === floor && Number(v.range) > 0)) {
        const poly = coverageAbsolute(dev, design);
        if (!poly || poly.length < 3) continue;
        const shape = new THREE.Shape();
        poly.forEach((q, i) => { const [px, pz] = fromPlan(q.x, q.y); if (!i) shape.moveTo(px, -pz); else shape.lineTo(px, -pz); });
        shape.closePath();
        const zone = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshBasicMaterial({
          color: 0xa68047, transparent: true, opacity: .16, depthWrite: false, side: THREE.DoubleSide }));
        zone.rotation.x = -Math.PI / 2; zone.position.y = .02; zone.visible = false;
        world.add(zone); sensorZones.push(zone);
      }
      const span = Math.max(width, depth, 6);
      // 俯视图：锁死视角方向（极角 / 方位角都钉住），左键改为平移，只允许平移和缩放；
      // 只有点「返回立体角度」才解锁旋转。
      const applyView = (top: boolean) => {
        controls.enableRotate = !top;
        controls.minPolarAngle = 0;
        controls.maxPolarAngle = top ? 0 : Math.PI / 2.08;
        controls.minAzimuthAngle = top ? 0 : -Infinity;
        controls.maxAzimuthAngle = top ? 0 : Infinity;
        controls.mouseButtons.LEFT = top ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE;
        controls.touches.ONE = top ? THREE.TOUCH.PAN : THREE.TOUCH.ROTATE;
        const fit = Math.max(1, el.clientHeight / Math.max(1, el.clientWidth));
        camera.position.set(top ? 0 : width * .6 * fit, top ? span * 1.55 * fit : span * 1.2 * fit,
          top ? .001 : span * 1.2 * fit);
        controls.target.set(0, 0, 0);
        controls.update();
      };
      applyView(topOn.current);
      topViewRef.current = () => {
        topOn.current = !topOn.current;
        applyView(topOn.current);
        setTopView(topOn.current);
        render();
      };
      const raycaster = new THREE.Raycaster();
      const pointer = new THREE.Vector2();
      let pressed: { x: number; y: number } | null = null;
      /** 屏幕点 → 设计坐标（与放置灯同一套换算）。 */
      function planAt(ev: PointerEvent): { x: number; y: number } | null {
        const rect = renderer.domElement.getBoundingClientRect();
        pointer.set((ev.clientX - rect.left) / rect.width * 2 - 1,
          -(ev.clientY - rect.top) / rect.height * 2 + 1);
        raycaster.setFromCamera(pointer, camera);
        const g = raycaster.intersectObject(floorMesh)[0];
        if (!g) return null;
        return cad || useDesign
          ? { x: Math.round((g.point.x + centerX) * 26 * 100) / 100,
              y: Math.round((g.point.z + centerZ) * 26 * 100) / 100 }
          : { x: Math.max(0, Math.min(820, (g.point.x + centerX - x0) / width * 820)),
              y: Math.max(0, Math.min(690, (g.point.z + centerZ - z0) / depth * 690)) };
      }
      // 三维里拖灯具（2026-10-16「俯视图里能选中灯具但不能拖动」）：按住灯沿地面挪。
      let fixtureDrag: { id: string; cx: number; cy: number; moved: boolean } | null = null;
      let roamDrag = false;
      function down(ev: PointerEvent) {
        pressed = { x: ev.clientX, y: ev.clientY };
        // 漫游时：左键按住地面＝把小人放到那里并跟着走（不转相机）；右键 / 滚轮照旧看视角。
        if (live.current.roam && onRoamMoveRef.current && ev.button === 0) {
          const at = planAt(ev);
          if (!at) return;
          roamDrag = true;
          onRoamMoveRef.current(at.x, at.y);
          controls.enabled = false;
          ev.stopImmediatePropagation();
          renderer.domElement.setPointerCapture(ev.pointerId);
          return;
        }
        if (!appearance.current.editFixtures || !live.current.showFixtures || ev.button !== 0) return;
        if (onPlacePointRef.current && !live.current.placingLamps) return;
        const rect = renderer.domElement.getBoundingClientRect();
        pointer.set((ev.clientX - rect.left) / rect.width * 2 - 1,
          -(ev.clientY - rect.top) / rect.height * 2 + 1);
        raycaster.setFromCamera(pointer, camera);
        const hit = raycaster.intersectObjects(hits)[0];
        if (!hit || hit.object.userData.kind !== "fixtures") return;
        fixtureDrag = { id: String(hit.object.userData.id), cx: ev.clientX, cy: ev.clientY, moved: false };
        controls.enabled = false;
        ev.stopImmediatePropagation();
        renderer.domElement.setPointerCapture(ev.pointerId);
        if (renderer.domElement.style) renderer.domElement.style.cursor = "move";
      }
      function dragMove(ev: PointerEvent) {
        if (roamDrag) { const at = planAt(ev); if (at) onRoamMoveRef.current?.(at.x, at.y); return; }
        if (!fixtureDrag) return;
        if (Math.hypot(ev.clientX - fixtureDrag.cx, ev.clientY - fixtureDrag.cy) > 4) fixtureDrag.moved = true;
        if (!fixtureDrag.moved) return;
        const at = planAt(ev);
        if (!at) return;
        const [wx, wz] = fromPlan(at.x, at.y);
        const L: any = lightMeshes.current.get(fixtureDrag.id);
        if (L) {
          L.marker.position.set(wx, .23, wz);
          L.glow.position.set(wx, .015, wz);
          if (L.icon) L.icon.position.set(wx, 0, wz);
          if (L.grab) L.grab.position.set(wx, .24, wz);
          if (L.cone) { L.cone.position.x=wx; L.cone.position.z=wz; }
          if (L.strip) { const [x,z]=fromPlan(+L.fixture.x,+L.fixture.y); L.strip.position.set(wx-x,0,wz-z); }
          // 拖到哪、光斑就按哪重裁一次：不然拖动过程中光斑会越出墙（2026-10-17）。
          if (L.radius) applyFixtureClip(THREE, design, { ...L.fixture, x: at.x, y: at.y }, L.glow, L.cone, L.radius, L.mount);
        }
        render();
      }
      function up(ev: PointerEvent) {
        if (roamDrag) { roamDrag = false; controls.enabled = true; pressed = null; return; }
        if (fixtureDrag) {
          const d = fixtureDrag;
          fixtureDrag = null;
          controls.enabled = true;
          if (renderer.domElement.style) renderer.domElement.style.cursor = "";
          if (d.moved) {
            const at = planAt(ev);
            if (at) onFixtureMoveRef.current?.(d.id, at.x, at.y);   // 位置交给外层写回设计
            pressed = null;
            return;                                                 // 拖过就不算「点选」
          }
          onSelectRef.current?.({kind: 'fixtures', id: d.id} as Selection);
          pressed = null;
          return;
        }
        if (!pressed || Math.hypot(ev.clientX - pressed.x, ev.clientY - pressed.y) > 5) return;
        const rect = renderer.domElement.getBoundingClientRect();
        pointer.set((ev.clientX - rect.left) / rect.width * 2 - 1,
          -(ev.clientY - rect.top) / rect.height * 2 + 1);
        raycaster.setFromCamera(pointer, camera);
        if (onPlacePointRef.current) {
          const ground = raycaster.intersectObject(floorMesh)[0];
          if (ground) {
            onPlacePointRef.current({
              x: cad || useDesign ? Math.round((ground.point.x + centerX) * 26 * 100) / 100
                : Math.max(0, Math.min(820, (ground.point.x + centerX - x0) / width * 820)),
              y: cad || useDesign ? Math.round((ground.point.z + centerZ) * 26 * 100) / 100
                : Math.max(0, Math.min(690, (ground.point.z + centerZ - z0) / depth * 690)),
            });
          }
          return;
        }
        const found = raycaster.intersectObjects(hits.filter((mesh: any) =>
          mesh.userData.kind === "devices" ? live.current.showDevices : live.current.showFixtures))[0];
        const furnitureHit = live.current.showFurniture && onFurnitureSelectRef.current
          ? raycaster.intersectObjects(furnitureHits)[0] : null;
        if (furnitureHit && (!found || furnitureHit.distance < found.distance)) {
          onFurnitureSelectRef.current?.(furnitureHit.object.userData.id);
        } else if (found) onSelectRef.current?.(found.object.userData as Selection);
      }
      function cancel() {
        if (fixtureDrag) {
          const L = lightMeshes.current.get(fixtureDrag.id);
          if (L) {
            const [x,z] = fromPlan(+L.fixture.x,+L.fixture.y);
            L.marker.position.set(x,.23,z); L.grab.position.set(x,.24,z);
            L.icon.position.set(x,0,z); L.glow.position.set(x,.015,z);
            if (L.strip) L.strip.position.set(0,0,0);
            if (L.cone) {L.cone.position.x=x;L.cone.position.z=z;}
            // 取消拖动：光斑按原位置重新裁回来
            if (L.radius) applyFixtureClip(THREE, design, L.fixture, L.glow, L.cone, L.radius, L.mount);
          }
        }
        fixtureDrag=null; pressed=null; roamDrag=false; controls.enabled=true;
        renderer.domElement.style.cursor=''; render();
      }
      renderer.domElement.addEventListener("pointerdown", down, true);
      renderer.domElement.addEventListener("pointercancel", cancel);
      renderer.domElement.addEventListener("pointermove", dragMove);
      renderer.domElement.addEventListener("pointerup", up);
      const observer = new ResizeObserver(() => {
        if (!el.clientWidth || !el.clientHeight) return;
        camera.aspect = el.clientWidth / el.clientHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(el.clientWidth, el.clientHeight);
        render();
      });
      observer.observe(el);
      let frame = 0, needsRender = true;
      let renderedState: typeof live.current | null = null;
      let renderedAppearance: typeof appearance.current | null = null;
      function render() {
        needsRender = true;
      }
      // ★ 俯视图缩放失灵的根因（2026-10-16 报）：OrbitControls 的滚轮/平移处理里
      //   **自己就会调一次 update()**，而这张画布是按需渲染（`const moved = controls.update()`），
      //   等我们下一帧再调 update() 时「位移已经被内部消费掉了」→ 返回 false → 不重画。
      //   相机其实已经缩放/平移了，只是画面没跟着刷新（旋转带阻尼时不调 update()，所以只有
      //   俯视图这种「只平移＋缩放」的模式看起来像坏了）。挂 change 事件立刻重画即可。
      controls.addEventListener("change", render);
      function animate() {
        if (disposed) return;
        const moved = controls.update();
        if (needsRender || moved || renderedState !== live.current || renderedAppearance !== appearance.current) {
        renderedAppearance = appearance.current;
        hemi.intensity = appearance.current.night ? .12 : .9;
        sun.intensity = appearance.current.night ? .08 : .65;
        needsRender = false; renderedState = live.current;
        const { activeScene: scene, activeStates, selection: selected, showFixtures: fixturesOn, showDevices: devicesOn } = live.current;
        const sceneStates: Obj = activeStates || scene?.states || {};
        for (const room of roomPatches) {
          if (!live.current.selectedRoomId) room.mesh.material.color.copy(room.color);
          else room.mesh.material.color.setHex(room.id===live.current.selectedRoomId?0xb5d6bd:0x969e98);
        }
        for (const furniture of furnitureGroups) {
          furniture.group.visible = live.current.showFurniture;
          furniture.outline.visible = live.current.showFurniture && live.current.selectedFurnitureId === furniture.id;
        }
        let litCount = 0;
        for (const [id, { marker, glow, strip, icon, grab, cone, fixture }] of lightMeshes.current) {
          const state = sceneStates[id];
          const dimmed = !!live.current.selectedRoomId && marker.userData.roomId !== live.current.selectedRoomId;
          const power = (scene ? (state?.on ? Math.max(0, Math.min(100, +state.brightness || 0)) / 100 : 0) : 1)*(dimmed ? .2 : 1);
          marker.visible = fixturesOn;
          if (grab) grab.visible = fixturesOn;
          // 放置灯具时把光斑关掉（2026-10-16）：留灯具图标，才看得清一盏一盏落在哪、好不好挪。
          // 灯带不在锚点铺一团圆光斑（它是一条线光源，光在灯带那条线上）
          glow.visible = fixturesOn && power > .01 && !live.current.placingLamps && !strip;
          if (icon) icon.visible = fixturesOn;
          if (strip) strip.visible = fixturesOn;
          if (cone) { cone.visible = fixturesOn && power > .01 && appearance.current.beams && !live.current.placingLamps && !strip; cone.material.opacity = power * .22; }
          const kelvin = +state?.cct || +fixture?.cct || 3000;
          const tint = new THREE.Color().setHSL(.09, Math.max(0, Math.min(.65, (6500-kelvin)/6500)), .72);
          glow.material.color.copy(tint);
          if (cone) cone.material.color.copy(tint);
          glow.material.opacity = .08 + power * .48;

          marker.material.emissiveIntensity = power * 2.2;
          if (power > .01) litCount += 1;
          marker.material.color.setHex(power ? 0xffd69c : 0x68726e);
        }
        const roamAt = live.current.roam;
        walker.visible = !!roamAt;
        if (roamAt) { const [rx, rz] = fromPlan(+roamAt.x, +roamAt.y); walker.position.set(rx, 0, rz); }
        el!.dataset.roam = roamAt ? `${Math.round(+roamAt.x)},${Math.round(+roamAt.y)}` : "";
        for (const zone of sensorZones) zone.visible = !!roamAt;
        el!.dataset.lit = String(litCount);
        for (const dot of cadDots) dot.visible = fixturesOn;
        for (const label of fixtureLabels) label.visible = fixturesOn;
        for (const label of deviceLabels) label.visible = devicesOn;
        for (const [id, marker] of selectedMeshes.current) {
          if (marker.userData.kind === "devices") marker.visible = devicesOn;
          marker.scale.setScalar(selected?.id === id ? 1.65 : 1);
        }
        renderer.render(world, camera);
        }
        frame = requestAnimationFrame(animate);
      }
      animate();
      setReady(true);
      cleanup = () => {
        cancelAnimationFrame(frame);
        controls.removeEventListener("change", render);
        observer.disconnect();
        renderer.domElement.removeEventListener("pointerdown", down, true);
        renderer.domElement.removeEventListener("pointercancel", cancel);
        renderer.domElement.removeEventListener("pointermove", dragMove);
        renderer.domElement.removeEventListener("pointerup", up);
        controls.dispose();
        world.traverse((object: any) => {
          object.geometry?.dispose();
          if (object.material) {
            for (const material of [object.material].flat()) {
              material.map?.dispose();
              material.dispose();
            }
          }
        });
        renderer.dispose();
        renderer.forceContextLoss();
        renderer.domElement.remove();
        lightMeshes.current.clear();
        selectedMeshes.current.clear();
        topViewRef.current = null;
      };
    }).catch((e) => { if (!disposed) setError(e.message); });
    return () => { disposed = true; cleanup(); };
  }, [projectId, model, floor, design, background]);

  // 换项目才回到立体角度
  useEffect(() => { topOn.current = false; setTopView(false); }, [projectId]);

  const cad = floor === 1 && !!model?.walls?.length && model?.geometry_source !== "design-spaces" && !design.rooms.some(r => boundary(r).length >= 3);
  const hasRooms = design.rooms.some((r) => (r.floor || 1) === floor &&
    ((r.points?.length || 0) >= 3 || (+r.width > 2 && +r.height > 2)));
  const layoutCount = `本层 ${design.fixtures.filter((f) => (f.floor || 1) === floor).length} 盏灯 · ${design.devices.filter((d) => (d.floor || 1) === floor).length} 台设备`;
  return <div className="scene-model-3d" aria-label="智能情景三维模型">
    <div ref={host} className="scene-model-viewport" data-testid="scene-webgl-viewport"
      data-fixtures={design.fixtures.filter((f) => (f.floor || 1) === floor).length}
      data-devices={design.devices.filter((d) => (d.floor || 1) === floor).length} />
    <button type="button" className="scene-model-top" onClick={() => topViewRef.current?.()}
      disabled={!ready} aria-label={topView ? "返回立体角度" : "一键进入俯视图"}>
      {topView ? "返回立体角度" : "一键俯视图"}
    </button>
    <div className="scene-model-light-tools">
      <button type="button" aria-label={night ? '切换白天' : '切换夜间'} onClick={()=>setNight(!night)}>{night ? '夜间 · 切换白天' : '白天 · 切换夜间'}</button>
      <label><input type="checkbox" checked={beams} onChange={e=>setBeams(e.target.checked)}/>光锥示意</label>
    </div>
    <div className="scene-model-caption">
      {`${layoutCount} · `}{error ? `模型提示：${error} · 仍显示已确认的空间与设备` :
        !ready ? "正在加载三维场景…" : topView ? "俯视图已锁定方向 · 拖动平移 / 滚轮缩放 · 点「返回立体角度」恢复旋转" : cad ? "真实 DXF 墙体 · 拖动旋转 / 点击设备编辑（平面点位需核对）" :
          hasRooms ? `${design.spaceDefinition?.status === "confirmed" ? "已确认的房间边界" : "当前空间边界"} · 拖动旋转 / 点击家具或设备编辑` :
            "未确认墙体轮廓；原图、空间名和布置好的灯具设备照常显示"}
    </div>
  </div>;
}
