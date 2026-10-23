/* 三维灯光演示引擎 · three.js r147（本地 vendor，无 CDN）
 *
 * 数据来源（三种，同一套渲染）：
 *   1) 工作台项目页：window.LIGHTING_PROJECT 由后端注入，或 ?proj=<客户编号> 拉 /lighting3d/<编号>/data.json
 *   2) 单文件版：数据内联在 HTML 里（发微信用，双击即开）
 *   3) 样板演示：projects/demo.js
 *
 * 设计口径（用户 2026-09 明确，别改）：
 *   1. 每盏灯必须有看得见的三维光锥，不能只有地面亮斑
 *   2. 不用 IES 光度学——光斑/光锥用程序化渐变贴图（"有那个样子就行"）
 *   3. 默认墙剖切 1.5m + 鸟瞰，否则实心墙把光锥全遮住
 *   4. 浅色场景下加色光斑看不见 → 默认暗场，留「白天看图」切换
 *   5. 光锥/光斑尺寸 = 吊顶后层高 + 灯具光束角（编号→产品）算出来，不是拍的
 * 所有入口（场景按钮 / 回路行 / 点灯具 / 场景讲解）都走同一个 applyLevels()
 */
(function () {
  let P = null, CEIL = 2.8, CUT = 1.5, NET = 2.8;

  /* ---------------- 程序化贴图 ---------------- */
  function canvasTex(w, h, draw) {
    const cv = document.createElement("canvas");
    cv.width = w; cv.height = h;
    draw(cv.getContext("2d"), w, h);
    const t = new THREE.CanvasTexture(cv);
    t.needsUpdate = true;
    return t;
  }
  const TEX_POOL = canvasTex(128, 128, (g, w, h) => {
    const r = w / 2;
    const gr = g.createRadialGradient(r, r, 0, r, r, r);
    gr.addColorStop(0.00, "rgba(255,255,255,1)");
    gr.addColorStop(0.32, "rgba(255,255,255,0.58)");
    gr.addColorStop(0.66, "rgba(255,255,255,0.14)");
    gr.addColorStop(1.00, "rgba(255,255,255,0)");
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
  });
  const TEX_CONE = canvasTex(4, 64, (g, w, h) => {
    const gr = g.createLinearGradient(0, 0, 0, h);
    gr.addColorStop(0.00, "rgba(255,255,255,1)");
    gr.addColorStop(0.35, "rgba(255,255,255,0.55)");
    gr.addColorStop(0.75, "rgba(255,255,255,0.16)");
    gr.addColorStop(1.00, "rgba(255,255,255,0.02)");
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
  });
  const TEX_LINE = canvasTex(8, 64, (g, w, h) => {
    const gr = g.createLinearGradient(0, 0, 0, h);
    gr.addColorStop(0.00, "rgba(255,255,255,0)");
    gr.addColorStop(0.50, "rgba(255,255,255,1)");
    gr.addColorStop(1.00, "rgba(255,255,255,0)");
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
  });

  /* ---------------- three 骨架 ---------------- */
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(45, 1, 0.1, 400);
  let renderer = null, controls = null;

  // 绑定当前文档里的 #c。工作台内嵌时画布会随项目页重建，所以每次 init 都确认一次。
  function bindCanvas() {
    const el = document.getElementById("c");
    if (!el || (renderer && renderer.domElement === el)) return;
    if (renderer) { try { renderer.dispose(); } catch (e) {} }
    renderer = new THREE.WebGLRenderer({ canvas: el, antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputEncoding = THREE.sRGBEncoding;
    // 对齐优邑珺和的观感（2026-10-19 作者：三维光线表达要和优邑一致）：
    // ACES 压高光、开阴影，光才有「照进去」的感觉，而不是一片平涂。
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    controls = new THREE.OrbitControls(cam, renderer.domElement);
    controls.enableDamping = true; controls.dampingFactor = 0.08;
    controls.maxPolarAngle = Math.PI * 0.49;
    controls.minDistance = 3; controls.maxDistance = 90;
  }
  bindCanvas();

  const G = { shell: new THREE.Group(), beams: new THREE.Group(), pools: new THREE.Group(),
              discs: new THREE.Group(), strips: new THREE.Group(), sensors: new THREE.Group(),
              labels: new THREE.Group() };
  Object.values(G).forEach(g => scene.add(g));

  // 三盏灯的配比照优邑珺和：半球光打底、主光斜射投影、补光提暗部
  const hemi = new THREE.HemisphereLight(0xdfe8ff, 0x1a1c22, 0.12);
  const key = new THREE.DirectionalLight(0xfff2e2, 0.30); key.position.set(6, 12, 10);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.bias = -0.0006;
  key.shadow.normalBias = 0.02;
  const fill = new THREE.DirectionalLight(0xdfe8ff, 0.10); fill.position.set(-8, 8, -6);
  scene.add(hemi, key, fill, key.target);

  const MAT = {
    // PBR：Lambert 没有高光和粗糙度，打光上去是平的（优邑珺和用的是 Standard）
    floor: new THREE.MeshStandardMaterial({ color: 0x1b1d22, roughness: .88, metalness: .02, side: THREE.DoubleSide }),
    wall: new THREE.MeshStandardMaterial({ color: 0x2b2d33, roughness: .70, metalness: .02 }),
    furn: new THREE.MeshStandardMaterial({ color: 0x2a2d35, roughness: .82, metalness: .02 }),
    // 家具固定的三种面：主体 / 软包（床垫·坐垫）/ 硬面（台面·柜门）
    furn2: new THREE.MeshStandardMaterial({ color: 0x363b45, roughness: .95, metalness: 0 }),
    furn3: new THREE.MeshStandardMaterial({ color: 0x23262d, roughness: .55, metalness: .05 }),
    // 四档语义材质（与 frontend/src/furnitureModels.ts 的 m 对齐）：1 木 / 2 布 / 3 白 / 4 金属
    furn4: new THREE.MeshStandardMaterial({ color: 0x4a5257, roughness: .35, metalness: .55 })
  };

  let walls = [], washes = [], luminaires = [], stripObjs = [], sensorObjs = [], rooms = [];
  const manual = {};
  let sceneId = null, mode = "night", beamsOn = true, cutOn = true;
  // 情景切换渐变（现场 2026-10-17「情景模式切换时的渐变时间也失效了」）：
  // 切情景时按**目标情景自己的渐变时间**把亮度/色温缓变过去，不再瞬间跳变。
  let fade = null;                 // { from, to, t0, dur, guard }
  let shownStates = {};            // 逐帧的灯状态（id → {on, brightness, cct}）
  // 进入空间（第一人称）：站在空间里、人眼高度、墙恢复全高
  const EYE = 1.62;
  let insideIdx = null;          // 当前所处的空间下标（null = 全景）
  let cutBeforeEnter = true;     // 进来之前的剖切开关（出去要还原）
  let beamsBeforeEnter = true;   // 进来之前的光锥开关
  let modeBeforeEnter = "night"; // 进来之前看的是灯光演示还是白天看图
  let fly = null;                // 相机过渡动画 {from,to,tFrom,tTo,t,dur,start}

  /* ---------------- 建场景 ---------------- */
  /** 外壳观感对齐优邑珺和：墙开阴影、墙边补亮线、地板收影。 */
  function polishShell() {
    const bb = P.bbox || [0, 0, 10, 10];
    const d = Math.max(bb[2] - bb[0], bb[3] - bb[1], 3);
    const cx = (bb[0] + bb[2]) / 2, cz = (bb[1] + bb[3]) / 2;
    key.shadow.camera.left = -d; key.shadow.camera.right = d;
    key.shadow.camera.top = d; key.shadow.camera.bottom = -d;
    key.shadow.camera.near = 0.5; key.shadow.camera.far = d * 8;
    key.shadow.camera.updateProjectionMatrix();
    key.position.set(cx + d * 0.5, d * 1.6, cz + d * 0.7);
    key.target.position.set(cx, 0, cz);
    key.target.updateMatrixWorld();

    walls.forEach(w => {
      w.castShadow = true; w.receiveShadow = true;
      if (!w.userData.edge) {
        // 优邑珺和的墙有亮边：光是「剖切后的墙体轮廓」，暗场里靠它读结构
        const eg = new THREE.EdgesGeometry(w.geometry, 30);
        const ln = new THREE.LineSegments(eg, new THREE.LineBasicMaterial({
          color: 0x86a7c4, transparent: true, opacity: 0.26, depthWrite: false
        }));
        w.add(ln); w.userData.edge = ln;
      }
    });
    G.shell.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  }

  function buildShell() {
    const bb = P.bbox || [0, 0, 10, 10];
    // 楼板
    const slab = new THREE.Mesh(new THREE.BoxGeometry(bb[2] - bb[0] + 0.3, 0.08, bb[3] - bb[1] + 0.3), MAT.floor);
    slab.position.set((bb[0] + bb[2]) / 2, -0.04, (bb[1] + bb[3]) / 2);
    if (P.geometry_source !== "design-spaces") G.shell.add(slab);

    // 房间地面：多边形或矩形拼（打上空间下标 → 点地面就能进这个空间）
    rooms.forEach((r, ridx) => {
      if (r.poly && r.poly.length >= 3) {
        const sh = new THREE.Shape();
        sh.moveTo(r.poly[0][0], r.poly[0][1]);
        r.poly.slice(1).forEach(p => sh.lineTo(p[0], p[1]));
        sh.closePath();
        const m = new THREE.Mesh(new THREE.ShapeGeometry(sh), MAT.floor.clone());
        m.material.color.offsetHSL(0, 0, r.area > 20 ? 0.012 : 0.024);
        m.rotation.x = Math.PI / 2;
        m.material.side = THREE.DoubleSide;
        m.position.y = 0.008;
        m.userData.room = ridx;
        G.shell.add(m);
      }
      (r.rects || []).forEach(q => {
        const m = new THREE.Mesh(new THREE.PlaneGeometry(q[2] - q[0], q[3] - q[1]), MAT.floor.clone());
        m.rotation.x = -Math.PI / 2;
        m.position.set((q[0] + q[2]) / 2, 0.008, (q[1] + q[3]) / 2);
        m.material.side = THREE.DoubleSide;
        m.userData.room = ridx;
        G.shell.add(m);
      });
    });

    // 墙（房间轮廓反推，或直接用图纸墙段）
    (P.walls || []).forEach(s => {
      const len = Math.hypot(s.x1 - s.x0, s.z1 - s.z0);
      if (len < 0.05) return;
      const h = +s.heightM || CUT, bottom = +s.bottomM || 0;
      const t = s.t || 0.12;
      const m = new THREE.Mesh(new THREE.BoxGeometry(len + t, h, t), MAT.wall);
      m.position.set((s.x0 + s.x1) / 2, bottom + h / 2, (s.z0 + s.z1) / 2);
      m.userData.structure = s.heightM ? { height: h, bottom } : null;
      m.rotation.y = -Math.atan2(s.z1 - s.z0, s.x1 - s.x0);
      G.shell.add(m); walls.push(m);
    });
    (P.openings || []).forEach(o => {
      const len = Math.hypot(o.x1 - o.x0, o.z1 - o.z0), h = +o.heightM, sill = +o.sillHeight || 0;
      const g = new THREE.Group(), mat = new THREE.MeshLambertMaterial({ color: o.type === "窗" ? 0x789da5 : 0xa37e52 });
      g.position.set((o.x0 + o.x1) / 2, sill, (o.z0 + o.z1) / 2);
      g.rotation.y = -Math.atan2(o.z1 - o.z0, o.x1 - o.x0);
      [[.04,h,.12,-len/2,h/2],[.04,h,.12,len/2,h/2],[len,.04,.12,0,h]].forEach(q => {
        const m = new THREE.Mesh(new THREE.BoxGeometry(q[0],q[1],q[2]),mat);m.position.set(q[3],q[4],0);g.add(m);
      });
      if (o.type === "窗") {
        const pane = new THREE.Mesh(new THREE.BoxGeometry(len,h,.02),
          new THREE.MeshBasicMaterial({color:0x9ad3e3,transparent:true,opacity:.22,depthWrite:false}));
        pane.position.y=h/2;g.add(pane);
      }
      G.shell.add(g);
    });

    buildFurniture();

    // 空间名落点：优先面积质心；质心落在轮廓外时退回扫描线内部点（与 Ueyi3D 同一口径）。
    function labelAnchor(poly) {
      if (!Array.isArray(poly) || poly.length < 3) return null;
      let a = 0, cx = 0, cz = 0;
      for (let i = 0; i < poly.length; i++) {
        const p = poly[i], q = poly[(i + 1) % poly.length];
        const cr = p[0] * q[1] - q[0] * p[1];
        a += cr; cx += (p[0] + q[0]) * cr; cz += (p[1] + q[1]) * cr;
      }
      a *= 0.5;
      let x = Math.abs(a) > 1e-9 ? cx / (6 * a) : poly[0][0];
      let z = Math.abs(a) > 1e-9 ? cz / (6 * a) : poly[0][1];
      const inside = (px, pz) => {
        let ins = false;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
          const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
          if (((yi > pz) !== (yj > pz)) && (px < (xj - xi) * (pz - yi) / (yj - yi) + xi)) ins = !ins;
        }
        return ins;
      };
      if (inside(x, z)) return [x, z];
      const zs = poly.map(p => p[1]);
      const zz = Math.min(Math.max(z, Math.min.apply(null, zs) + 0.001), Math.max.apply(null, zs) - 0.001);
      const xs = [];
      for (let i = 0; i < poly.length; i++) {
        const p = poly[i], q = poly[(i + 1) % poly.length];
        if ((p[1] > zz) !== (q[1] > zz)) xs.push(p[0] + (zz - p[1]) * (q[0] - p[0]) / (q[1] - p[1]));
      }
      xs.sort((m, n) => m - n);
      let best = null;
      for (let i = 0; i < xs.length - 1; i += 2) {
        const d = xs[i + 1] - xs[i];
        if (d > 0 && (!best || d > best[1] - best[0])) best = [xs[i], xs[i + 1]];
      }
      if (best) {
        const mx = (best[0] + best[1]) / 2;
        if (inside(mx, zz)) return [mx, zz];
      }
      return [x, z];
    }

    rooms.forEach((r, ridx) => {
      const cv = document.createElement("canvas"); cv.width = 256; cv.height = 64;
      const g = cv.getContext("2d");
      g.font = "600 32px -apple-system,PingFang SC,Microsoft YaHei,sans-serif";
      g.textAlign = "center"; g.textBaseline = "middle";
      g.fillStyle = "#ffffff"; g.fillText(r.name || "", 128, 34);
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv), transparent: true, depthWrite: false }));
      const la = labelAnchor(r.poly) || [r.cx, r.cz];
      sp.position.set(la[0], 1.75, la[1]);
      sp.scale.set(0.72, 0.18, 1);   // 初始值；渲染循环里按距离换算成约 20px
      sp.userData.room = ridx;      // 点空间名标签 = 进这个空间
      G.labels.add(sp);
    });
  }

  /* ---------------- 家具：固定样式，只按图纸尺寸缩放 ----------------
   * 用户口径：家具不考虑风格，同一类永远同一个模型，尺寸对得上图纸就行。
   * 所以这里只用方盒/圆柱拼：床＝床体+床垫+床头+两只枕头，沙发＝座+靠背+扶手……
   * 认不出类型的走「通用」块。类型可逐件改（工作台里的语义调整）。
   */
  function fbox(g, w, h, d, x, y, z, mat, ry) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(Math.max(0.02, w), Math.max(0.02, h), Math.max(0.02, d)), mat);
    m.position.set(x, y, z);
    if (ry) m.rotation.y = ry;
    g.add(m);
    return m;
  }
  function fcyl(g, r, h, x, y, z, mat, seg) {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(Math.max(0.02, r), Math.max(0.02, r), Math.max(0.02, h), seg || 16), mat);
    m.position.set(x, y, z);
    g.add(m);
    return m;
  }
  function legs(g, w, d, h, inset) {
    const t = Math.min(0.06, Math.min(w, d) * 0.12);
    const ix = w / 2 - Math.max(inset, t / 2), iz = d / 2 - Math.max(inset, t / 2);
    [[-ix, -iz], [ix, -iz], [-ix, iz], [ix, iz]].forEach(([x, z]) =>
      fbox(g, t, h, t, x, h / 2, z, MAT.furn3));
  }
  /* 家具：固定样式来自共享模块 frontend/src/furnitureModels.ts（React 侧把它挂在 window.GUANGLV_FURN），
   * 与主画布「3D 模型」共用同一套构件表——不再出现「一边有形状、一边是方盒」。
   * 引擎单独跑 demo（没有 React）时找不到共享模块，才退回下面的 FURN_BUILD 兜底。 */
  function furnMats() { return [null, MAT.furn, MAT.furn2, MAT.furn3, MAT.furn4 || MAT.furn3]; }
  function buildFurnParts(g, kind, w, d, h) {
    const api = window.GUANGLV_FURN;
    if (!api || typeof api.parts !== "function") return false;
    const parts = api.parts(kind, w, d, h) || [];
    const mats = furnMats();
    parts.forEach(p => {
      const m = mats[p.m] || MAT.furn;
      if (p.k === "cyl") fcyl(g, Math.max(0.02, p.r), Math.max(0.02, p.h), p.x, p.y, p.z, m, 20);
      else fbox(g, Math.max(0.02, p.w), Math.max(0.02, p.h), Math.max(0.02, p.d), p.x, p.y, p.z, m);
    });
    return parts.length > 0;
  }

  const FURN_BUILD = {
    "床": (g, w, d) => {
      fbox(g, w, 0.30, d, 0, 0.15, 0, MAT.furn);                       // 床体
      fbox(g, w * 0.94, 0.16, d * 0.86, 0, 0.38, d * 0.04, MAT.furn2); // 床垫
      fbox(g, w, 0.60, 0.10, 0, 0.45, -d / 2 + 0.05, MAT.furn3);       // 床头
      if (w > 1.2) {                                                    // 两只枕头
        fbox(g, w * 0.3, 0.10, d * 0.16, -w * 0.21, 0.51, -d * 0.26, MAT.furn2);
        fbox(g, w * 0.3, 0.10, d * 0.16, w * 0.21, 0.51, -d * 0.26, MAT.furn2);
      }
    },
    "婴儿床": (g, w, d) => {
      fbox(g, w, 0.12, d, 0, 0.30, 0, MAT.furn2);
      fbox(g, w, 0.55, 0.06, 0, 0.28, -d / 2, MAT.furn3);
      fbox(g, w, 0.55, 0.06, 0, 0.28, d / 2, MAT.furn3);
      fbox(g, 0.06, 0.55, d, -w / 2, 0.28, 0, MAT.furn3);
      fbox(g, 0.06, 0.55, d, w / 2, 0.28, 0, MAT.furn3);
    },
    "沙发": (g, w, d) => {
      fbox(g, w, 0.32, d, 0, 0.16, 0, MAT.furn);                        // 座箱
      fbox(g, w - 0.16, 0.14, d - 0.14, 0, 0.39, 0.02, MAT.furn2);      // 坐垫
      fbox(g, w, 0.55, 0.16, 0, 0.45, -d / 2 + 0.08, MAT.furn);         // 靠背
      fbox(g, 0.16, 0.48, d, -w / 2 + 0.08, 0.24, 0, MAT.furn);         // 左扶手
      fbox(g, 0.16, 0.48, d, w / 2 - 0.08, 0.24, 0, MAT.furn);          // 右扶手
    },
    "桌": (g, w, d) => {
      fbox(g, w, 0.05, d, 0, 0.72, 0, MAT.furn2);
      legs(g, w, d, 0.70, 0.10);
    },
    "餐桌": (g, w, d) => {
      fbox(g, w, 0.05, d, 0, 0.74, 0, MAT.furn2);
      legs(g, w, d, 0.72, 0.12);
    },
    "茶几": (g, w, d) => {
      fbox(g, w, 0.05, d, 0, 0.40, 0, MAT.furn2);
      legs(g, w, d, 0.38, 0.08);
    },
    "椅": (g, w, d) => {
      fbox(g, w * 0.92, 0.06, d * 0.92, 0, 0.44, 0, MAT.furn2);
      fbox(g, w * 0.92, 0.46, 0.06, 0, 0.66, -d / 2 + 0.04, MAT.furn);
      legs(g, w * 0.92, d * 0.92, 0.44, 0.04);
    },
    "凳": (g, w, d) => {
      fcyl(g, Math.min(w, d) / 2, 0.06, 0, 0.45, 0, MAT.furn2, 20);
      legs(g, w, d, 0.42, 0.05);
    },
    "柜": (g, w, d, h) => {
      fbox(g, w, h, d, 0, h / 2, 0, MAT.furn);
      fbox(g, w * 0.98, 0.04, d * 0.98, 0, h + 0.01, 0, MAT.furn3);
    },
    "衣柜": (g, w, d, h) => {
      fbox(g, w, h, d, 0, h / 2, 0, MAT.furn);
      fbox(g, 0.02, h * 0.92, 0.02, 0, h / 2, -d / 2 - 0.01, MAT.furn3);   // 门缝
      fbox(g, w * 0.9, 0.04, 0.03, 0, h * 0.55, -d / 2 - 0.02, MAT.furn3);
    },
    "书架": (g, w, d, h) => {
      fbox(g, w, h, d, 0, h / 2, 0, MAT.furn3);
      for (let i = 1; i <= 3; i++) fbox(g, w * 0.94, 0.04, d * 0.9, 0, (h / 4) * i, 0, MAT.furn2);
    },
    "电视": (g, w, d, h) => {
      fbox(g, w, 0.45, Math.min(d, 0.45), 0, 0.225, 0, MAT.furn);           // 电视柜
      fbox(g, Math.min(w * 0.72, 1.7), 0.92, 0.06, 0, 0.96, -Math.min(d, 0.45) / 2 - 0.03, MAT.furn3);
    },
    "冰箱": (g, w, d, h) => {
      fbox(g, w, h, d, 0, h / 2, 0, MAT.furn);
      fbox(g, 0.02, h * 0.9, 0.03, 0, h / 2, -d / 2 - 0.02, MAT.furn3);
    },
    "洗衣机": (g, w, d, h) => {
      fbox(g, w, h, d, 0, h / 2, 0, MAT.furn);
      fcyl(g, Math.min(w, d) * 0.3, 0.03, 0, h + 0.02, 0, MAT.furn3, 20);
    },
    "马桶": (g, w, d, h) => {
      fbox(g, w * 0.9, 0.62, 0.20, 0, 0.31, -d / 2 + 0.10, MAT.furn);     // 水箱
      fcyl(g, Math.min(w, d) * 0.36, 0.40, 0, 0.20, d * 0.06, MAT.furn2, 20);
    },
    "浴缸": (g, w, d, h) => {
      fbox(g, w, h, d, 0, h / 2, 0, MAT.furn);
      fbox(g, w - 0.16, 0.10, d - 0.16, 0, h - 0.04, 0, MAT.furn2);
    },
    "台盆": (g, w, d, h) => {
      fbox(g, w, 0.72, d, 0, 0.36, 0, MAT.furn);                           // 台盆柜
      fbox(g, w * 1.02, 0.05, d * 1.02, 0, 0.75, 0, MAT.furn2);
      fcyl(g, Math.min(w, d) * 0.30, 0.12, 0, 0.83, 0, MAT.furn3, 20);
    },
    "灶台": (g, w, d, h) => {
      fbox(g, w, 0.86, d, 0, 0.43, 0, MAT.furn);
      fbox(g, w * 1.02, 0.05, d * 1.02, 0, 0.89, 0, MAT.furn2);
      fcyl(g, Math.min(w, d) * 0.16, 0.03, -w * 0.18, 0.92, 0, MAT.furn3, 16);
      fcyl(g, Math.min(w, d) * 0.16, 0.03, w * 0.18, 0.92, 0, MAT.furn3, 16);
    },
    "水槽": (g, w, d, h) => {
      fbox(g, w, 0.86, d, 0, 0.43, 0, MAT.furn);
      fbox(g, w * 1.02, 0.05, d * 1.02, 0, 0.89, 0, MAT.furn2);
      fbox(g, w * 0.6, 0.06, d * 0.6, 0, 0.86, 0, MAT.furn3);
    },
    "植物": (g, w, d) => {
      fcyl(g, Math.min(w, d) * 0.3, 0.35, 0, 0.175, 0, MAT.furn3, 18);
      const r = Math.min(w, d) * 0.46;
      fcyl(g, r, 0.55, 0, 0.62, 0, MAT.furn, 18);
      fcyl(g, r * 0.72, 0.35, 0, 1.0, 0, MAT.furn, 16);
    },
    "地毯": (g, w, d) => fbox(g, w, 0.02, d, 0, 0.011, 0, MAT.furn2),
    "钢琴": (g, w, d, h) => {
      fbox(g, w, h, d, 0, h / 2, 0, MAT.furn);
      fbox(g, w * 0.86, 0.05, d * 0.16, 0, h + 0.03, d * 0.24, MAT.furn3);
    },
    "通用": (g, w, d, h) => fbox(g, w, h, d, 0, h / 2, 0, MAT.furn)
  };

  /* 「轮廓本身就是它的形状」的大类（柜/沙发/岛台/地毯……）：只有这些、
   *  且轮廓明显不是矩形时，才按轮廓挤出。马桶/浴缸/床这类器物是「设计过的器物」，
   *  图纸里那圈轮廓只是识别出来的占地，照它挤出就是一块怪疙瘩（现场 2026-10-16 报的马桶）。
   *  与 frontend/src/furniturePolygon.ts 的 outlineDrivesShape 同一口径。 */
  const FOOTPRINT_KIND = /柜|沙发|岛台|吧台|地毯|案台|工作台|岛柜/;
  function outlineNearBox(pts) {
    if (!pts || pts.length < 3) return true;
    let area2 = 0, sign = 0, convex = true;
    let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
    for (let i = 0; i < pts.length; i += 1) {
      const a = pts[i], b = pts[(i + 1) % pts.length], c = pts[(i + 2) % pts.length];
      area2 += a[0] * b[1] - b[0] * a[1];
      minx = Math.min(minx, a[0]); maxx = Math.max(maxx, a[0]);
      miny = Math.min(miny, a[1]); maxy = Math.max(maxy, a[1]);
      const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
      if (Math.abs(cr) > 1e-6) { const sg = cr > 0 ? 1 : -1;
        if (sign === 0) sign = sg; else if (sg !== sign) convex = false; }
    }
    const area = Math.abs(area2) / 2, box = (maxx - minx) * (maxy - miny);
    return convex && box > 0 && area / box >= 0.9;
  }
  function outlineDrivesShape(kind, pts) {
    if (!Array.isArray(pts) || pts.length < 3) return false;
    if (!FOOTPRINT_KIND.test(String(kind || ""))) return false;
    return !outlineNearBox(pts);
  }

  function buildFurniture() {
    const api = window.GUANGLV_FURN, walls = P.walls || [];
    (P.furniture || []).forEach(f => {
      const w = Math.max(0.2, f.w || 0.5), d = Math.max(0.2, f.d || 0.5);
      const h = f.h || 0.5;
      const g = new THREE.Group();
      g.position.set(f.x, 0, f.z);
      // 朝向：工作台里逐件改过的 rot（度）优先；否则按「背面贴最近的墙」自动转正（占地不变）。
      const fit = !f.designFurniture && api && typeof api.yaw === "function"
        ? api.yaw(f.x, f.z, w, d, walls, f.kind) : { yaw: 0, w: w, d: d };
      g.rotation.y = f.rot != null ? (Number(f.rot) || 0) * Math.PI / 180 : fit.yaw;
      // 画过轮廓的家具（现场 2026-10-16「主卧衣帽间的柜子轮廓我改过、没生效」）：
      // f.pts 是轮廓点（三维米坐标），按它挤出真形状——只按外接框画，L 形柜子会变成一个方盒子。
      if (outlineDrivesShape(f.kind, f.pts)) {
        const sh = new THREE.Shape();
        f.pts.forEach((q, i) => {
          const px = q[0] - f.x, py = -(q[1] - f.z);   // Shape 的 y 取 -z：绕 X 转 -90° 后正好落回 +z
          if (!i) sh.moveTo(px, py); else sh.lineTo(px, py);
        });
        sh.closePath();
        const solid = new THREE.Mesh(
          new THREE.ExtrudeGeometry(sh, { depth: Math.max(0.02, h), bevelEnabled: false }), MAT.furn);
        solid.rotation.x = -Math.PI / 2;
        g.add(solid);
      } else if (!buildFurnParts(g, f.kind, fit.w, fit.d, h)) {
        (FURN_BUILD[f.kind] || FURN_BUILD["通用"])(g, w, d, h);
      }
      if (f.designFurniture) {
        const box = new THREE.Box3().setFromObject(g);
        g.scale.y = h / Math.max(.01, box.max.y - box.min.y);
      }
      G.shell.add(g);
    });
  }

  /* 光斑遮挡（现场 2026-10-17「光斑不能穿过墙体、门、家具表面」）：从灯位水平打 96 条射线，
   * 碰到墙段、或 ≥1.8 m 的高家具外框就停，得到看得见的那一圈；地面光斑只铺在圈里。
   * 门洞上方的过梁（bottomM>0）不挡地面光，所以只取落地的墙段；与二维 lightOcclusion.ts 同口径。
   * 2026-10-17 补：灯所在**空间的边界**也算挡光段（闭口多边形，门洞那一段同样挡）——
   * 原来只靠墙段，门一开光斑就从门口漏到走廊/隔壁。 */
  function occluders() {
    const segs = [];
    (P.walls || []).forEach(s => { if (!(+s.bottomM > 0)) segs.push([s.x0, s.z0, s.x1, s.z1]); });
    (P.furniture || []).forEach(f => {
      if (!(+f.h >= 1.8)) return;
      let pts = Array.isArray(f.pts) && f.pts.length >= 3 ? f.pts : null;
      if (!pts) {
        const a = (f.rot != null ? +f.rot || 0 : 0) * Math.PI / 180, c = Math.cos(a), sn = Math.sin(a);
        const w = (f.w || .5) / 2, d = (f.d || .5) / 2;
        pts = [[-w, -d], [w, -d], [w, d], [-w, d]].map(([u, v]) => [f.x + u * c + v * sn, f.z - u * sn + v * c]);
      }
      pts.forEach((p, i) => { const q = pts[(i + 1) % pts.length]; segs.push([p[0], p[1], q[0], q[1], f]); });
    });
    return segs;
  }
  /** 灯位所在空间的边界（闭口）：门洞也挡，光斑不出这个空间。 */
  function roomBoundaryAt(x, z) {
    const list = rooms.filter(r => r.poly && r.poly.length >= 3);
    let own = list.find(r => inPoly(r.poly, x, z));
    if (!own) own = list.find(r => {
      const bb = r.bbox || [];
      return bb.length >= 4 && x >= bb[0] && x <= bb[2] && z >= bb[1] && z <= bb[3];
    });
    return own ? own.poly : null;
  }
  function roomSegsAt(x, z) {
    const poly = roomBoundaryAt(x, z);
    if (!poly) return [];
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      out.push([a[0], a[1], b[0], b[1]]);
    }
    return out;
  }
  function inPoly(pts, x, z) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[i], b = pts[j];
      if ((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
    }
    return inside;
  }
  /** 灯位 (x,z)、半径 r 内看得见的范围 → 以灯位为中心的扇形三角面（局部坐标，XZ 平面）。没有遮挡＝null。 */
  function clippedPoolGeometry(x, z, r, segs) {
    const own = segs.filter(s => !(s[4] && Array.isArray(s[4].pts) && inPoly(s[4].pts, x, z)))
      .concat(roomSegsAt(x, z));      // 空间边界也挡：门洞不放过光斑
    const N = 96, rad = [];
    let clipped = false;
    for (let i = 0; i < N; i++) {
      const a = i / N * Math.PI * 2, dx = Math.cos(a), dz = Math.sin(a);
      let best = r;
      for (const s of own) {
        const sx = s[2] - s[0], sz = s[3] - s[1], den = dx * sz - dz * sx;
        if (Math.abs(den) < 1e-9) continue;
        const ax = s[0] - x, az = s[1] - z;
        const t = (ax * sz - az * sx) / den, u = (ax * dz - az * dx) / den;
        if (t > 1e-3 && t < best && u >= -1e-3 && u <= 1 + 1e-3) best = t;
      }
      if (best < r - 1e-3) clipped = true;
      rad.push([dx * best, dz * best]);
    }
    if (!clipped) return null;
    const pos = [], uv = [];
    for (let i = 0; i < N; i++) {
      const a = rad[i], b = rad[(i + 1) % N];
      for (const q of [[0, 0], a, b]) { pos.push(q[0], 0, q[1]); uv.push(.5 + q[0] / r / 2, .5 - q[1] / r / 2); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    return g;
  }

  /** 光锥也要止于墙：圆锥换成「顶点 → 裁剪边界」的扇面（贴图 v：顶点亮、边缘透明）。 */
  function clippedConeGeometry(x, z, r, mount, segs) {
    const own = segs.filter(s => !(s[4] && Array.isArray(s[4].pts) && inPoly(s[4].pts, x, z)))
      .concat(roomSegsAt(x, z));
    const N = 96, pos = [], uv = [];
    let clipped = false;
    const rim = [];
    for (let i = 0; i < N; i++) {
      const a = i / N * Math.PI * 2, dx = Math.cos(a), dz = Math.sin(a);
      let best = r;
      for (const s of own) {
        const sx = s[2] - s[0], sz = s[3] - s[1], den = dx * sz - dz * sx;
        if (Math.abs(den) < 1e-9) continue;
        const ax = s[0] - x, az = s[1] - z;
        const t = (ax * sz - az * sx) / den, u = (ax * dz - az * dx) / den;
        if (t > 1e-3 && t < best && u >= -1e-3 && u <= 1 + 1e-3) best = t;
      }
      if (best < r - 1e-3) clipped = true;
      rim.push([dx * best, dz * best]);
    }
    if (!clipped) return null;
    for (let i = 0; i < N; i++) {
      const a = rim[i], b = rim[(i + 1) % N];
      pos.push(0, mount / 2, 0); uv.push(.5, 1);
      pos.push(a[0], -mount / 2, a[1]); uv.push(.5, 0);
      pos.push(b[0], -mount / 2, b[1]); uv.push(.5, 0);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    return g;
  }

  /* ---------------- 灯具 ---------------- */
  const CONE_GEO = new THREE.ConeGeometry(1, 1, 28, 1, true);
  const POOL_GEO = new THREE.PlaneGeometry(2, 2);

  /** 灯位动了 / 刚建好：地面光斑与光锥按当前位置重裁一次（裁不出来就回到整圆/整锥）。 */
  function reclipLuminaire(o) {
    if (!o || !o.segs) return;
    const clippedPool = clippedPoolGeometry(o.l.x, o.l.z, o.poolR, o.segs);
    if (clippedPool) {
      o.pool.geometry.dispose(); o.pool.geometry = clippedPool;
      o.pool.rotation.x = 0; o.pool.scale.set(1, 1, 1);
    } else {
      o.pool.geometry.dispose(); o.pool.geometry = POOL_GEO;
      o.pool.rotation.x = -Math.PI / 2; o.pool.scale.set(o.poolR, o.poolR, 1);
    }
    const clippedCone = clippedConeGeometry(o.l.x, o.l.z, o.poolR, o.mount, o.segs);
    if (clippedCone) {
      o.cone.geometry.dispose(); o.cone.geometry = clippedCone;
      o.cone.scale.set(1, 1, 1);
    } else {
      o.cone.geometry.dispose(); o.cone.geometry = CONE_GEO;
      o.cone.scale.set(o.poolR, o.mount, o.poolR);
    }
  }

  function buildLuminaires() {
    const SEGS = occluders();
    const DISC_GEO = new THREE.CylinderGeometry(0.055, 0.055, 0.022, 16);
    const byc = {};
    (P.circuits || []).forEach(c => byc[c.id] = c);

    luminaires = (P.lights || []).map(l => {
      const c = byc[l.c] || { color: 0xffc98a, half: 20, watts: 7 };
      const drop = l.drop != null ? l.drop : 0.06;
      const mount = Math.max(.3, l.mount != null ? +l.mount : NET - drop);
      const halfDeg = l.half || c.half || 20;
      const half = halfDeg * Math.PI / 180;
      const poolR = Math.max(0.25, mount * Math.tan(half));
      const color = new THREE.Color(c.color || 0xffc98a);

      const disc = new THREE.Mesh(DISC_GEO, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.2 }));
      disc.position.set(l.x, mount - 0.02, l.z); G.discs.add(disc);
      // 抓取球：看不见但好点中（0.055 的小圆盘根本点不住），拖灯用它命中。
      const grab = new THREE.Mesh(new THREE.SphereGeometry(0.32, 10, 8),
        new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }));
      grab.position.copy(disc.position);
      G.discs.add(grab);

      const cone = new THREE.Mesh(CONE_GEO, new THREE.MeshBasicMaterial({
        map: TEX_CONE, color, transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
        depthWrite: false, side: THREE.DoubleSide, toneMapped: false
      }));
      cone.scale.set(poolR, mount, poolR);
      cone.position.set(l.x, mount / 2, l.z); G.beams.add(cone);

      const pool = new THREE.Mesh(POOL_GEO, new THREE.MeshBasicMaterial({
        map: TEX_POOL, color, transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
        depthWrite: false, toneMapped: false
      }));
      pool.position.set(l.x, 0.012, l.z); G.pools.add(pool);

      const obj = { l, c, mount, poolR, cone, pool, disc, grab, lv: 0, segs: SEGS };
      reclipLuminaire(obj);               // 光斑 + 光锥一起按本空间边界/墙/高柜裁
      return obj;
    });
  }

  /* ---------------- 灯带 ---------------- */
  function buildStrips() {
    const byc = {};
    (P.circuits || []).forEach(c => byc[c.id] = c);
    stripObjs = [];
    (P.strips || []).forEach(s => {
      const c = byc[s.c] || { color: 0xffd6ac };
      const color = new THREE.Color(c.color || 0xffd6ac);
      const inside = s.inside || [0, -0.5];
      const wdir = new THREE.Vector3(inside[0], 0, inside[1] || -1).normalize();
      const objs = { s, mats: [] };
      for (let i = 0; i < s.path.length - 1; i++) {
        const [x0, z0] = s.path[i], [x1, z1] = s.path[i + 1];
        const len = Math.hypot(x1 - x0, z1 - z0);
        if (len < 0.1) continue;
        const ang = Math.atan2(z1 - z0, x1 - x0) * -1;
        const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
        const line = new THREE.Mesh(new THREE.PlaneGeometry(len, 0.07), new THREE.MeshBasicMaterial({
          map: TEX_LINE, color, transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
          depthWrite: false, toneMapped: false
        }));
        line.rotation.set(-Math.PI / 2, 0, ang);
        line.position.set(mx, s.mount != null ? +s.mount : NET - 0.06, mz); G.strips.add(line);

        const wh = 1.45;
        const wall = new THREE.Mesh(new THREE.PlaneGeometry(len, wh), new THREE.MeshBasicMaterial({
          map: TEX_CONE, color, transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
          depthWrite: false, side: THREE.DoubleSide, toneMapped: false
        }));
        // 洗墙光从灯带所在高度往下挂（灯槽在顶上），不再从地面往上立。
        const topY = Math.max(wh, s.mount != null ? +s.mount : NET - 0.06);
        wall.position.set(mx + wdir.x * 0.05, topY - wh / 2, mz + wdir.z * 0.05);
        wall.lookAt(new THREE.Vector3(wall.position.x + wdir.x * 8, topY - wh / 2, wall.position.z + wdir.z * 8));
        G.strips.add(wall); washes.push(wall);

        const wash = new THREE.Mesh(new THREE.PlaneGeometry(len, 1.2), new THREE.MeshBasicMaterial({
          map: TEX_LINE, color, transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
          depthWrite: false, toneMapped: false
        }));
        wash.rotation.set(-Math.PI / 2, 0, ang);
        // 灯带是吊顶 / 灯槽里的线光源（现场 2026-10-17「平面布置了灯带，3D 视角下在地面上，这是不对的」）：
        // 原来这里在地上铺一条亮带，看上去就像灯带贴在地面。改成贴着顶面的一层漫射，光从上面来。
        const mountY = s.mount != null ? +s.mount : NET - 0.06;
        wash.rotation.set(Math.PI / 2, 0, -ang);
        wash.position.set(mx + inside[0] * 0.5, Math.max(0.3, mountY - 0.02), mz + (inside[1] || 0) * 0.5);
        G.strips.add(wash);
        objs.mats.push({ line: line.material, wash: wash.material, wall: wall.material });
      }
      if (objs.mats.length) stripObjs.push(objs);
    });
  }

  /* ---------------- 开关 / 感应器（可选） ---------------- */
  function buildSensors() {
    sensorObjs = (P.sensors || []).map(s => {
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.11, 0.035), new THREE.MeshBasicMaterial({ color: 0x39485c }));
      box.position.set(s.pos[0], 1.25, s.pos[1]); box.userData.sensor = s.id; G.sensors.add(box);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.14, 0.012, 8, 24),
        new THREE.MeshBasicMaterial({ color: 0x39d0ff, transparent: true, opacity: 0 }));
      ring.position.set(s.pos[0], 1.25, s.pos[1]); G.sensors.add(ring);
      return { s, box, ring, on: false };
    });
  }

  /* ---------------- 唯一入口 ---------------- */
  // 情景兜底（现场 2026-10-16「三维里看不到亮灯效果，两盏灯一盏都不亮」）：
  // 选中的情景名若不在数据里，原来一律 return 0——于是连「全开」也是全灭。
  // 现在按情景名兜底：全关＝0，其余（含全开、以及认不出的名字）＝全亮，别让整屋子黑着。
  const SCENE_OFF = { "全关": 0 };
  function presetOf(cid) {
    const sc = (P.scenes || []).find(x => x.id === sceneId);
    if (sc) {
      const lv = (sc.levels || {})[cid];
      if (lv !== undefined) return lv;
      const star = (sc.levels || {})["*"];
      return star !== undefined ? star : 0;
    }
    if (sceneId == null || sceneId === "") return 1;
    return SCENE_OFF[sceneId] !== undefined ? SCENE_OFF[sceneId] : 1;
  }
  function levelOf(cid) { return manual[cid] !== undefined ? manual[cid] : presetOf(cid); }

  /* ---------------- 情景切换渐变 ---------------- */
  function sceneOf(id) { return (P.scenes || []).find(x => x.id === id) || null; }
  function fadeSecondsOf(id) {
    const sc = sceneOf(id);
    const v = sc ? +sc.fade : NaN;
    return Number.isFinite(v) && v >= 0 ? Math.min(3600, v) : 1;
  }
  function statesOf(id) {
    const sc = sceneOf(id);
    const st = (sc && sc.states) || {};
    return Object.assign({}, st);
  }
  function levelFromState(st) { return st && st.on ? Math.max(0, Math.min(1, (+st.brightness || 0) / 100)) : 0; }
  /** 切情景：从当前显示状态缓变到目标情景（时长＝目标情景的渐变时间）。 */
  function startSceneFade(id) {
    const to = statesOf(id);
    const dur = fadeSecondsOf(id);
    if (fade && fade.guard) clearTimeout(fade.guard);
    if (!Object.keys(shownStates).length || dur <= 0 || !Object.keys(to).length) {
      shownStates = to;                 // 首次进入 / 0 秒渐变 / 空情景：直接到位
      fade = null;
      return;
    }
    fade = { from: Object.assign({}, shownStates), to, t0: performance.now(), dur, guard: 0 };
    // 兜底：渲染循环用的是 requestAnimationFrame，后台标签页会被浏览器暂停——
    // 只靠循环推进的话，切了情景停在旧亮度上（实测就是这样）。定时器到点直接落到目标值。
    fade.guard = setTimeout(() => {
      if (!fade) return;
      shownStates = fade.to;
      fade = null;
      applyLevels();
    }, dur * 1000 + 150);
  }
  /** 推进渐变；返回「这一帧值是否变了」。 */
  function stepSceneFade(now) {
    if (!fade) return false;
    const raw = Math.min(1, (now - fade.t0) / (fade.dur * 1000));
    const e = raw * raw * (3 - 2 * raw);
    const out = {};
    const ids = new Set(Object.keys(fade.from).concat(Object.keys(fade.to)));
    ids.forEach(id => {
      const a = fade.from[id], b = fade.to[id];
      const la = levelFromState(a) * 100, lb = levelFromState(b) * 100;
      const level = la + (lb - la) * e;
      const ca = +(a && a.cct) || +(b && b.cct) || 3000;
      const cb = +(b && b.cct) || +(a && a.cct) || 3000;
      out[id] = Object.assign({}, b || a || {}, {
        on: level > 0.5,
        brightness: Math.round(level * 10) / 10,
        cct: Math.round(ca + (cb - ca) * e),
      });
    });
    shownStates = out;
    if (raw >= 1) {
      if (fade.guard) clearTimeout(fade.guard);
      fade = null;
    }
    return true;
  }

  function applyLevels(withUi) {
    luminaires.forEach(o => {
      const sc = (P.scenes || []).find(s => s.id === sceneId);
      const sceneState = sc && sc.states && sc.states[o.l.id];
      // 渐变进行中（或已经跑完一次）时以逐帧状态为准，其余情况仍用情景/回路预设。
      const state = shownStates[o.l.id] !== undefined ? shownStates[o.l.id] : sceneState;
      const lv = Math.max(0, Math.min(1, manual[o.c.id] !== undefined ? manual[o.c.id] :
        sc && sc.states ? (state && state.on ? (+state.brightness || 0) / 100 : 0) : levelOf(o.c.id)));
      const kelvin = +(state && state.cct) || +o.l.cct;
      if (kelvin) {
        const tint = new THREE.Color().setHSL(.09, Math.max(0, Math.min(.65, (6500-kelvin)/6500)), .72);
        o.cone.material.color.copy(tint); o.pool.material.color.copy(tint);
      }
      o.lv = lv;
      o.cone.material.opacity = lv * 0.34;
      // 现场 2026-10-16「白天晚上可以手动切换」：光锥是**独立开关**，白天勾了也要看得见
      // （原来限定 mode === "night"，白天勾「光锥示意」等于没反应）。
      o.cone.visible = beamsOn && lv > 0.01;
      o.pool.material.opacity = lv * 0.78;
      o.pool.visible = lv > 0.01;
      o.disc.material.opacity = 0.18 + lv * 0.82;
    });
    stripObjs.forEach(o => {
      const sc = (P.scenes || []).find(s => s.id === sceneId);
      const stripState = sc && sc.states && sc.states[o.s.id];
      const state = shownStates[o.s.id] !== undefined ? shownStates[o.s.id] : stripState;
      const lv = Math.max(0, Math.min(1, manual[o.s.c] !== undefined ? manual[o.s.c] :
        sc && sc.states ? (state && state.on ? (+state.brightness || 0) / 100 : 0) : levelOf(o.s.c)));
      const kelvin = +(state && state.cct) || +o.s.cct;
      const tint = kelvin ? new THREE.Color().setHSL(.09, Math.max(0, Math.min(.65, (6500-kelvin)/6500)), .72) : null;
      o.mats.forEach(m => {
        m.line.opacity = lv * 0.85; m.wash.opacity = lv * 0.30; m.wall.opacity = lv * 0.42;
        if (tint) { m.line.color.copy(tint); m.wash.color.copy(tint); m.wall.color.copy(tint); }
      });
    });
    sensorObjs.forEach(o => {
      const ids = Object.keys(o.s.targets || {});
      const any = ids.some(id => id === "*" ? Object.values(o.s.targets).some(v => v > 0) && o.on : levelOf(id) > 0.02);
      o.on = any;
      o.box.material.color.set(any ? 0x39d0ff : 0x39485c);
      o.ring.material.opacity = any ? 0.75 : 0;
    });
    G.beams.visible = beamsOn;
    // 渐变逐帧刷新时不要每帧重建左侧列表（30 秒渐变＝1800 帧）；渐变结束那一帧补一次。
    if (withUi !== false) renderUI();
  }

  function resetManual() { Object.keys(manual).forEach(k => delete manual[k]); applyLevels(); }
  function setScene(id) {
    sceneId = id;
    // 手动覆盖清掉，但**不要**在这里先 applyLevels：那会先把目标情景瞬间点亮一下再渐变。
    Object.keys(manual).forEach(k => delete manual[k]);
    startSceneFade(id);                 // 按目标情景自己的渐变时间缓变过去
    if (!fade) applyLevels();           // 没有渐变（首次/0 秒/空情景）时直接到位
    document.querySelectorAll(".scene").forEach(b => b.classList.toggle("on", b.dataset.sid === id));
    showScript(id);
  }
  function toggleCircuit(cid) {
    const cur = levelOf(cid);
    manual[cid] = cur > 0.02 ? 0 : (presetOf(cid) > 0.02 ? presetOf(cid) : 1.0);
    applyLevels();
  }
  function pokeSensor(sid) {
    const o = sensorObjs.find(x => x.s.id === sid); if (!o) return;
    const wasOn = o.on;
    Object.entries(o.s.targets || {}).forEach(([cid, v]) => {
      if (cid === "*") (P.circuits || []).forEach(c => manual[c.id] = wasOn ? 0 : v);
      else manual[cid] = wasOn ? 0 : v;
    });
    applyLevels();
  }

  /* ---------------- 界面 ---------------- */
  const $ = s => document.querySelector(s);
  function renderUI() {
    const total = luminaires.length;
    const on = luminaires.filter(o => o.lv > 0.02).length;
    let watts = 0;
    (P.circuits || []).forEach(c => {
      const n = (P.lights || []).filter(l => l.c === c.id).length;
      watts += Math.max(0, Math.min(1, levelOf(c.id))) * (c.watts || 7) * (c.type === "灯带" ? 1 : n);
    });
    const st = $("#status");
    if (st) st.innerHTML = `亮灯 <b>${on}/${total}</b> 盏 · 回路 ${(P.circuits || []).filter(c => levelOf(c.id) > 0.02).length}/${(P.circuits || []).length} · 约 <b>${Math.round(watts)}</b> W`;
    const pn = $("#pname");
    if (pn) pn.textContent = [P.name, P.area ? P.area + "㎡" : "", "原始层高 " + CEIL + "m",
      "吊顶后 " + NET + "m"].filter(Boolean).join(" · ");
    const cw = $("#circuits");
    if (!cw) return;
    cw.innerHTML = "";
    (P.circuits || []).forEach(c => {
      const lv = levelOf(c.id), isMan = manual[c.id] !== undefined;
      const n = (P.lights || []).filter(l => l.c === c.id).length;
      const row = document.createElement("div");
      row.className = "crow" + (lv > 0.02 ? " on" : "") + (isMan ? " man" : "");
      row.dataset.cid = c.id;
      row.innerHTML = `<span class="dot"></span><span class="nm">${c.id}</span>` +
        `<span class="lv">${lv > 0.02 ? Math.round(lv * 100) + "%" : "灭"}</span>` +
        `<span class="meta">${n ? n + "盏" : "灯带"}${c.price ? " · ¥" + c.price + "/" + (c.unit || "个") : ""}</span>`;
      row.addEventListener("click", () => toggleCircuit(c.id));
      cw.appendChild(row);
    });
    const sw = $("#sensors");
    if (sw) {
      sw.innerHTML = "";
      sensorObjs.forEach(o => {
        const el = document.createElement("button");
        el.className = "chip" + (o.on ? " on" : "");
        el.textContent = o.s.id;
        el.addEventListener("click", () => pokeSensor(o.s.id));
        sw.appendChild(el);
      });
      const sec = sw.closest("section");
      if (sec && !sensorObjs.length) sec.style.display = "none";
    }
  }

  function buildUI() {
    const sc = $("#scenes");
    if (sc) {
      sc.innerHTML = "";
      (P.scenes || []).forEach((s, i) => {
        const b = document.createElement("button");
        b.className = "scene" + (i === 0 ? " on" : ""); b.textContent = s.name || s.id; b.dataset.sid = s.id;
        b.addEventListener("click", () => setScene(s.id));
        sc.appendChild(b);
      });
    }
    document.querySelectorAll("#modes button").forEach(b => b.addEventListener("click", () => {
      document.querySelectorAll("#modes button").forEach(x => x.classList.remove("on"));
      b.classList.add("on"); setMode(b.dataset.mode);
    }));
    const rw = $("#rooms");
    if (rw) {
      rw.innerHTML = "";
      rooms.forEach((r, i) => {
        const row = document.createElement("div");
        row.className = "rrow";
        row.dataset.idx = i;
        row.innerHTML = `<span class="dot"></span><span class="nm">${r.name || ("空间" + (i + 1))}</span>` +
          `<span class="lv">${r.area ? r.area + "㎡" : ""}</span>`;
        row.title = "点一下：视角进入这个空间";
        row.addEventListener("click", () => enterRoom(i));
        rw.appendChild(row);
      });
      const tools = $("#roomtools") || rw;
      tools.innerHTML = "";
      const hint = document.createElement("p");
      hint.className = "gv3d-mut";
      hint.id = "roomhint";
      hint.style.fontSize = "11px";
      hint.style.lineHeight = "1.5";
      tools.appendChild(hint);
      const back = document.createElement("button");
      back.className = "gv3d-ghost";
      back.id = "roomexit";
      back.textContent = "回到全景";
      back.style.display = "none";
      back.addEventListener("click", exitRoom);
      tools.appendChild(back);
      markLabels();
      markRooms();
    }
    const cap = $("#roomcap"); if (cap) cap.onclick = exitRoom;
    const beams = $("#beams"); if (beams) beams.addEventListener("change", e => { beamsOn = e.target.checked; applyLevels(); });
    const cut = $("#cut"); if (cut) cut.addEventListener("change", e => { cutOn = e.target.checked; applyCut(); });
    const resetBtn = $("#reset"); if (resetBtn) resetBtn.addEventListener("click", resetManual);
    const speak = $("#speak"); if (speak) speak.addEventListener("click", () => speakScript(sceneId));
    sceneId = ((P.scenes || [])[0] || {}).id || null;
    shownStates = statesOf(sceneId);     // 首个情景作为渐变的起点（第一次切情景就有渐变）
    showScript(sceneId);
  }

  /* ---------------- 场景讲解词（页面文字 + 语音念出来） ---------------- */
  let utterance = null;
  function scriptOf(id) {
    const s = (P.scenes || []).find(x => x.id === id);
    return s && s.script ? s.script : "";
  }
  function showScript(id) {
    const box = $("#script");
    if (!box) return;
    const t = scriptOf(id);
    box.innerHTML = t
      ? `<b>${id}</b>　${t}`
      : `<span class="mut">这一档还没有讲解词</span>`;
    box.dataset.text = t;
  }
  function speakScript(id) {
    const t = scriptOf(id);
    if (!t || !window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    utterance = new SpeechSynthesisUtterance(t);
    utterance.lang = "zh-CN"; utterance.rate = 0.98; utterance.pitch = 1.0;
    const v = (window.speechSynthesis.getVoices() || []).find(x => /zh|Chinese/i.test(x.lang));
    if (v) utterance.voice = v;
    window.speechSynthesis.speak(utterance);
  }

  function applyCut() {
    const h = cutOn ? CUT : CEIL + 0.05;
    walls.forEach(w => {
      const s = w.userData.structure;
      if (!s) { w.scale.y = h / CUT; w.position.y = h / 2; return; }
      const top = cutOn ? Math.min(s.bottom + s.height, CUT) : s.bottom + s.height;
      const visibleHeight = Math.max(0, top - s.bottom);
      w.visible = visibleHeight > .001;
      w.scale.y = visibleHeight / s.height; w.position.y = s.bottom + visibleHeight / 2;
    });
    washes.forEach(w => { w.scale.y = h / 1.45; w.position.y = h / 2; });
  }

  /* ---------------- 进入空间（第一人称视角） ----------------
   * 用户口径：「点击对应空间时，视角直接进入该空间」。
   * 站在空间里、人眼高度 1.62m、墙恢复全高（剖切 1.5m 站在里面会看到墙外，不像进屋）；
   * 从空间的长边方向往里看，小空间也能看到整间。
   */
  function flyTo(pos, target, dur) {
    fly = {
      pFrom: cam.position.clone(), pTo: new THREE.Vector3(pos[0], pos[1], pos[2]),
      tFrom: controls.target.clone(), tTo: new THREE.Vector3(target[0], target[1], target[2]),
      t: 0, dur: dur || 0.85, last: performance.now(),
    };
  }

  function inRoom(r, x, z, pad) {
    const e = pad == null ? -0.15 : pad;          // 默认往里收 15cm：别贴着墙站
    for (const q of (r.rects || [])) {
      if (x >= q[0] + e && x <= q[2] - e && z >= q[1] + e && z <= q[3] - e) return true;
    }
    const poly = r.poly || [];
    if (poly.length >= 3) {
      let hit = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i][0], zi = poly[i][1], xj = poly[j][0], zj = poly[j][1];
        if (((zi > z) !== (zj > z)) && (x < (xj - xi) * (z - zi) / (zj - zi) + xi)) hit = !hit;
      }
      return hit;
    }
    return false;
  }

  function roomSpot(r) {
    // ⚠️ 房间的 rects 是「一条条横向细条」（掩膜按行游程合并出来的，客厅 19 条 2.9×0.8），
    // 拿最大那条当站位、朝它另一头看，就等于贴着墙看墙 —— 实测画面就是一面白墙。
    // 办法：站位取面积加权中心（一定在室内），朝向取「离中心最远的那条的中心」= 房间深处。
    const rects = (r.rects || []).filter(q => q && q[2] > q[0] && q[3] > q[1]);
    let A = 0, sx = 0, sz = 0;
    rects.forEach(q => {
      const a2 = (q[2] - q[0]) * (q[3] - q[1]);
      A += a2; sx += a2 * (q[0] + q[2]) / 2; sz += a2 * (q[1] + q[3]) / 2;
    });
    let cen = A > 0 ? [sx / A, sz / A] : [r.cx, r.cz];
    const poly = r.poly || [];
    if (A <= 0 && poly.length >= 3) {              // 纯多边形房间：多边形面积加权中心
      let px = 0, pz = 0, pA = 0;
      for (let i = 0; i < poly.length; i++) {
        const p1 = poly[i], p2 = poly[(i + 1) % poly.length];
        const cr = p1[0] * p2[1] - p2[0] * p1[1];
        pA += cr; px += (p1[0] + p2[0]) * cr; pz += (p1[1] + p2[1]) * cr;
      }
      if (Math.abs(pA) > 1e-6) cen = [px / (3 * pA), pz / (3 * pA)];
    }
    if (!inRoom(r, cen[0], cen[1], -0.05) && rects.length) {   // 中心恰好不在室内：退回最大那条的中心
      let host = rects[0], ha = 0;
      rects.forEach(q => {
        const a2 = (q[2] - q[0]) * (q[3] - q[1]);
        if (a2 > ha) { ha = a2; host = q; }
      });
      cen = [(host[0] + host[2]) / 2, (host[1] + host[3]) / 2];
    }
    // 朝向：室内所有 rect 中心里离站位最远的那个（横向细条也能给出“房间深处”）
    let aim = null, best = -1;
    rects.forEach(q => {
      const c = [(q[0] + q[2]) / 2, (q[1] + q[3]) / 2];
      const dd = Math.hypot(c[0] - cen[0], c[1] - cen[1]);
      if (dd > best) { best = dd; aim = c; }
    });
    if (!aim) {                                    // 没有 rect（纯多边形）：朝多边形最远顶点
      poly.forEach(pp => {
        const dd = Math.hypot(pp[0] - cen[0], pp[1] - cen[1]);
        if (dd > best) { best = dd; aim = [pp[0], pp[1]]; }
      });
    }
    if (!aim) {
      const bb = r.bbox || [cen[0] - 1, cen[1] - 1, cen[0] + 1, cen[1] + 1];
      aim = (bb[2] - bb[0]) >= (bb[3] - bb[1]) ? [bb[2], cen[1]] : [cen[0], bb[3]];
    }
    let dx = aim[0] - cen[0], dz = aim[1] - cen[1];
    const n = Math.hypot(dx, dz);
    if (n < 0.25) {                                // 几乎没纵深（小房间）：朝最长边看
      const bb = r.bbox || [cen[0] - 1, cen[1] - 1, cen[0] + 1, cen[1] + 1];
      if ((bb[2] - bb[0]) >= (bb[3] - bb[1])) { dx = 1; dz = 0; } else { dx = 0; dz = 1; }
    } else { dx /= n; dz /= n; }
    // 往后站一点（最多 1.2m），视野里能多装下半间房；退到墙外就退回中心
    const back = Math.min(1.2, Math.max(0.35, best * 0.35));
    let stand = [cen[0] - dx * back, cen[1] - dz * back];
    if (!inRoom(r, stand[0], stand[1], 0.05)) stand = cen;
    const reach = Math.max(1.4, Math.min(4.5, best + back));
    return { pos: [stand[0], EYE, stand[1]],
             tgt: [stand[0] + dx * reach, EYE - 0.45, stand[1] + dz * reach] };
  }

  function tuneInterior() {
    // 进入空间后的室内调色。踩过两回：白天模式站屋里是「白墙+白地」一片惨白，
    // 夜间模式（环境光 0.09）又几乎全黑 —— 两种预设都不是给人站在屋里看的。
    if (insideIdx === null) return;
    const day = mode === "day";
    MAT.wall.color.set(day ? 0xded8cd : 0x3c414a);
    MAT.floor.color.set(day ? 0xcfc8bc : 0x24272e);
    MAT.furn.color.set(day ? 0xc39a68 : 0x4a3524);      // 木
    MAT.furn2.color.set(day ? 0xbfc7bd : 0x39413d);     // 布
    MAT.furn3.color.set(day ? 0xefeae0 : 0x6f7168);     // 白
    MAT.furn4.color.set(day ? 0xc2cbd0 : 0x4a5257);     // 金属
    renderer.setClearColor(day ? 0xe9e9ee : 0x101216, 1);
    hemi.intensity = day ? 0.70 : 0.40;
    key.intensity = day ? 0.55 : 0.28;
    fill.intensity = day ? 0.30 : 0.14;
    G.shell.children.forEach(m => {
      if (m.material && m.material.color && m.geometry && m.geometry.type === "ShapeGeometry") {
        m.material.color.set(day ? 0xd6cfc3 : 0x262a31);
      }
    });
  }

  function stepRoom(step) {
    const n = rooms.length;
    if (!n) return false;
    const from = insideIdx === null ? -1 : insideIdx;
    const idx = from < 0 ? (step > 0 ? 0 : n - 1) : (((from + step) % n) + n) % n;
    return enterRoom(idx);
  }

  // 键盘：Esc 回全景，←/→ 换空间（← = 上一个，→ = 下一个）
  // 输入框/下拉里不抢键，否则在「语义调整」里打字会被吃掉。
  function onKeyDown(e) {
    if (!document.querySelector(".gv3d")) return;          // 不在三维页就不管
    const el = document.activeElement;
    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA"
               || el.tagName === "SELECT" || el.isContentEditable)) return;
    if (e.key === "Escape") {
      if (insideIdx !== null) { exitRoom(); e.preventDefault(); }
      return;
    }
    if (e.key === "ArrowRight" || e.key === "ArrowDown") { stepRoom(1); e.preventDefault(); }
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") { stepRoom(-1); e.preventDefault(); }
  }
  document.addEventListener("keydown", onKeyDown);
  document.addEventListener("keydown", e => { if (e.key === "Escape" && placing) placeStop(); });

  function markLabels() {
    // 进了哪间就把它自己的名字标签藏掉：否则站在屋里正面顶着一个巨大的空间名。
    // 别的空间名留着（墙是全高、隔得住，点进去换房间还能用）。
    G.labels.children.forEach((sp, i) => { sp.visible = i !== insideIdx; });
  }

  function markRooms() {
    const cap = $("#roomcap");                 // 顶部「当前空间」胶囊
    if (cap) {
      if (insideIdx === null) {
        cap.style.display = "none";
      } else {
        const r = rooms[insideIdx] || {};
        cap.style.display = "";
        cap.innerHTML = "<b>" + (r.name || ("空间" + (insideIdx + 1))) + "</b>" +
          (r.area ? '<span class="ar">' + r.area + "㎡</span>" : "") +
          '<span class="esc">点这里 / Esc 回全景　← → 换空间</span>';
      }
    }
    const box = $("#rooms");
    if (!box) return;
    box.querySelectorAll(".rrow").forEach(el => {
      el.classList.toggle("on", insideIdx !== null && +el.dataset.idx === insideIdx);
    });
    const back = $("#roomexit");
    if (back) back.style.display = insideIdx === null ? "none" : "";
    const hint = $("#roomhint");
    if (hint) {
      hint.textContent = insideIdx === null
        ? "点空间名进来——视角直接进这间（点三维里的空间名或地面也能进；← → 也能换）"
        : "已进入 " + ((rooms[insideIdx] || {}).name || "空间") +
          "：可拖动转视角，Esc 回全景、← → 换空间";
    }
  }

  function enterRoom(idx, silent) {
    const r = rooms[idx | 0];
    if (!r) return false;
    if (insideIdx === null) { cutBeforeEnter = cutOn; beamsBeforeEnter = beamsOn; modeBeforeEnter = mode; }
    insideIdx = idx | 0;
    setMode(mode);                     // 先按当前档位铺色（tuneInterior 会按室内口径再调）
    if (cutOn) {                       // 站进屋里就别再剖切墙了：1.5m 的墙站在屋里等于没墙
      cutOn = false;
      const cb = $("#cut"); if (cb) cb.checked = false;
      applyCut();
    }
    if (beamsOn) {                     // 光锥从天花罩下来，站在屋里会糊满整屏
      beamsOn = false;
      const cb2 = $("#beams"); if (cb2) cb2.checked = false;
      applyLevels();
    }
    const s = roomSpot(r);
    flyTo(s.pos, s.tgt, silent ? 0.01 : 0.85);
    markLabels();
    markRooms();
    return true;
  }

  function exitRoom() {
    if (insideIdx === null) return false;
    insideIdx = null;
    // 先还原档位（setMode 会顺手把光锥按档位改掉），再按进来之前的开关还原一次
    if (mode !== modeBeforeEnter) {
      document.querySelectorAll("#modes button").forEach(b => b.classList.toggle("on", b.dataset.mode === modeBeforeEnter));
    }
    setMode(modeBeforeEnter);
    if (beamsBeforeEnter !== beamsOn) {
      beamsOn = beamsBeforeEnter;
      const cb2 = $("#beams"); if (cb2) cb2.checked = beamsOn;
    }
    if (cutBeforeEnter && !cutOn) {
      cutOn = true;
      const cb = $("#cut"); if (cb) cb.checked = true;
    }
    applyCut();
    applyLevels();
    const bb = P.bbox || [0, 0, 10, 10];
    const CX = (bb[0]+bb[2]) / 2, CZ = (bb[1]+bb[3]) / 2, d = Math.max(bb[2]-bb[0], bb[3]-bb[1], 3);
    flyTo([CX + d * 0.22, d * 1.05, CZ + d * 1.0], [CX, 0, CZ], 0.85);
    markLabels();
    markRooms();
    return true;
  }

  function setMode(m) {
    mode = m;
    const day = m === "day";
    renderer.setClearColor(day ? 0xf2f2f5 : 0x0d0e12, 1);
    MAT.floor.color.set(day ? 0xdcd5c9 : 0x1b1d22);
    MAT.wall.color.set(day ? 0xf6f3ed : 0x2b2d33);
    MAT.furn.color.set(day ? 0xc39a68 : 0x4a3524);      // 木
    MAT.furn2.color.set(day ? 0xbfc7bd : 0x39413d);     // 布
    MAT.furn3.color.set(day ? 0xefeae0 : 0x6f7168);     // 白
    MAT.furn4.color.set(day ? 0xc2cbd0 : 0x4a5257);     // 金属
    G.shell.children.forEach(m2 => { if (m2.material && m2.material.color && m2.geometry &&
      m2.geometry.type === "ShapeGeometry") m2.material.color.set(day ? 0xd8d2c8 : 0x1d2027); });
    hemi.intensity = day ? 0.85 : 0.09;
    key.intensity = day ? 0.70 : 0.13;
    fill.intensity = day ? 0.45 : 0.06;
    G.labels.children.forEach(sp => sp.material.color.set(day ? 0x4a5058 : 0x9aa4b2));
    const cb = $("#beams"); if (cb) cb.checked = beamsOn;
    applyLevels();
    tuneInterior();          // 站在屋里时按室内口径再调一次色
  }

  /* ---------------- 放家具：点哪儿放哪儿（地面拾取 + 半透明预览） ----------------
   * 面板里选好类型 → 调 __api.place(...) 进入放置模式 → 鼠标在三维里移动显示预览，
   * 点一下把落点（米，与图纸同一坐标系）回调给工作台；Esc 或 __api.placeOff() 退出。
   */
  let placing = null;
  const GROUND_PLANE = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  function ghostMesh(kind, w, d, h) {
    const g = new THREE.Group();
    const mat = new THREE.MeshLambertMaterial({ color: 0xf0c477, transparent: true, opacity: .55 });
    const api = window.GUANGLV_FURN;
    const parts = api && typeof api.parts === "function"
      ? api.parts(kind, w, d, h)
      : [{ k: "box", x: 0, y: h / 2, z: 0, w: w, h: h, d: d, r: 0 }];
    parts.forEach(p => {
      if (p.k === "cyl") fcyl(g, Math.max(.02, p.r), Math.max(.02, p.h), p.x, p.y, p.z, mat, 18);
      else fbox(g, Math.max(.02, p.w), Math.max(.02, p.h), Math.max(.02, p.d), p.x, p.y, p.z, mat);
    });
    return g;
  }
  function groundPoint(e) {
    const r = renderer.domElement.getBoundingClientRect();
    pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(pointer, cam);
    const out = new THREE.Vector3();
    return ray.ray.intersectPlane(GROUND_PLANE, out) ? out : null;
  }
  function placeStart(kind, w, d, h, rot, cb, onEnd) {
    placeStop();
    const ghost = ghostMesh(kind, w, d, h);
    ghost.rotation.y = rot || 0;
    ghost.visible = false;
    G.shell.add(ghost);
    placing = { kind, w, d, h, rot: rot || 0, cb, onEnd, ghost };
    if (renderer.domElement.style) renderer.domElement.style.cursor = "crosshair";
  }
  function placeStop() {
    if (!placing) return;
    const end = placing.onEnd;
    G.shell.remove(placing.ghost);
    placing = null;
    if (renderer.domElement.style) renderer.domElement.style.cursor = "";
    if (typeof end === "function") end();
  }

  /* ---------------- 点选 / 拖灯 ---------------- */
  const ray = new THREE.Raycaster(), pointer = new THREE.Vector2();
  let down = null;
  let dragging = null;                   // 正在拖着某盏灯（现场 2026-10-16：三维里灯具要能挪）
  /** 灯位动了：圆盘 / 抓取球 / 光锥 / 光斑一起挪。 */
  function moveLuminaire(o) {
    o.disc.position.set(o.l.x, o.mount - 0.02, o.l.z);
    o.grab.position.copy(o.disc.position);
    o.cone.position.set(o.l.x, o.mount / 2, o.l.z);
    o.pool.position.set(o.l.x, 0.012, o.l.z);
    // 拖到哪、光斑与光锥就按哪重裁：不然拖动过程中会越出墙（现场 2026-10-17）
    reclipLuminaire(o);
  }
  function pickLuminaire(e) {
    const r = renderer.domElement.getBoundingClientRect();
    pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(pointer, cam);
    const hits = ray.intersectObjects(G.discs.children, false);
    if (!hits.length) return null;
    const o = hits[0].object;
    return luminaires.find(x => x.disc === o || x.grab === o) || null;
  }
  renderer.domElement.addEventListener("pointermove", e => {
    if (dragging) {
      const p = groundPoint(e);
      if (p) {
        if (Math.hypot(e.clientX - dragging.cx, e.clientY - dragging.cy) > 4) dragging.moved = true;
        dragging.lum.l.x = +p.x.toFixed(3);
        dragging.lum.l.z = +p.z.toFixed(3);
        moveLuminaire(dragging.lum);
      }
      return;
    }
    if (!placing) return;
    const p = groundPoint(e);
    if (!p) return;
    placing.ghost.visible = true;
    placing.ghost.position.set(p.x, 0, p.z);
  });
  renderer.domElement.addEventListener("pointerdown", e => {
    down = [e.clientX, e.clientY];
    if (placing) return;
    // 三维只用来看（现场 2026-10-17）：外层没挂 onLightMove 就不拖灯，灯位在 2D 平面上改。
    if (!(window.__api && typeof window.__api.onLightMove === "function")) return;
    const o = pickLuminaire(e);
    if (!o) return;
    dragging = { lum: o, cx: e.clientX, cy: e.clientY, moved: false };
    controls.enabled = false;            // 拖灯时不转相机
    if (renderer.domElement.style) renderer.domElement.style.cursor = "move";
  });
  renderer.domElement.addEventListener("pointerup", e => {
    if (dragging) {
      const d = dragging;
      dragging = null;
      controls.enabled = true;
      if (renderer.domElement.style) renderer.domElement.style.cursor = "";
      applyLevels();
      if (d.moved) {
        // 三维只做视图：位置交给外层写回（设计里的灯具），不在这里改数据。
        const api = window.__api;
        if (api && typeof api.onLightMove === "function") api.onLightMove(d.lum.l.id, d.lum.l.x, d.lum.l.z);
        return;                          // 拖过就不再当成「点一下＝开关这条回路」
      }
    }
    if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return;
    if (placing) {                       // 放置家具时不触发「进空间 / 开关灯」
      const p = groundPoint(e);
      if (p && typeof placing.cb === "function") {
        placing.cb({ x: +p.x.toFixed(3), z: +p.z.toFixed(3) });
      }
      return;
    }
    const r = renderer.domElement.getBoundingClientRect();
    pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(pointer, cam);
    const hits = ray.intersectObjects([...G.sensors.children, ...G.discs.children], false);
    if (hits.length) {
      const o = hits[0].object;
      if (o.userData.sensor) { pokeSensor(o.userData.sensor); return; }
      const lum = luminaires.find(x => x.disc === o || x.grab === o);
      if (lum) { toggleCircuit(lum.c.id); return; }
    }
    // 没点到感应器/灯：再试「进空间」——点空间名标签、或点这个空间的地面
    const roomHits = ray.intersectObjects(
      [...G.labels.children, ...G.shell.children.filter(m => m.userData && m.userData.room != null)], false);
    for (const hit of roomHits) {
      const idx = hit.object.userData && hit.object.userData.room;
      if (idx != null) { enterRoom(idx); return; }
    }
  });

  /* ---------------- 验收 API ---------------- */
  function luminanceStats() {
    renderer.render(scene, cam);
    const gl = renderer.getContext();
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const buf = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    let lit = 0, bright = 0, sum = 0;
    for (let i = 0; i < buf.length; i += 4) {
      const l = 0.2126 * buf[i] + 0.7152 * buf[i + 1] + 0.0722 * buf[i + 2];
      sum += l;
      if (l > 60) lit++;
      if (l > 200) bright++;
    }
    return { w, h, lit, bright, mean: +(sum / (w * h)).toFixed(2) };
  }
  function probeUnderlight(idx) {
    const o = luminaires[idx || 0];
    if (!o) return null;
    const p = new THREE.Vector3(o.l.x, o.mount * 0.4, o.l.z).project(cam);
    const gl = renderer.getContext();
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const px = Math.round((p.x * 0.5 + 0.5) * w), py = Math.round((p.y * 0.5 + 0.5) * h);
    renderer.render(scene, cam);
    const buf = new Uint8Array(4);
    gl.readPixels(Math.min(w - 1, Math.max(0, px)), Math.min(h - 1, Math.max(0, py)), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    return { circuit: o.c.id, code: o.c.code || "", mount: +o.mount.toFixed(2), poolR: +o.poolR.toFixed(2),
             half: o.l.half || o.c.half, x: px, y: py,
             lum: +(0.2126 * buf[0] + 0.7152 * buf[1] + 0.0722 * buf[2]).toFixed(1) };
  }

  /* ---------------- 启动 ---------------- */
  function resize() {
    if (!renderer) return;
    const w = renderer.domElement.clientWidth || window.innerWidth;
    const h = renderer.domElement.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    cam.aspect = w / h; cam.updateProjectionMatrix();
  }
  window.addEventListener("resize", resize);

  function init(project) {
    P = project;
    bindCanvas();     // 画布可能已经被 React 换过了
    // 工作台里同一个页面可能换项目/重新生成：先把上一份场景清干净，再建这一份。
    Object.values(G).forEach(g => { while (g.children.length) g.remove(g.children[0]); });
    walls = []; washes = []; luminaires = []; stripObjs = []; sensorObjs = []; rooms = [];
    Object.keys(manual).forEach(k => delete manual[k]);
    CEIL = +P.ceiling || 2.8;
    NET = +P.ceiling_net || CEIL;
    CUT = +P.wall_cut || 1.5;
    // 默认剖切到 1.5m：实心墙会把光锥和地面光斑全遮住（技能里实测：不剖切锥中亮度 16，剖切后 70~160）
    cutOn = true;
    rooms = (P.rooms || []).map(r => {
      let b = r.bbox;
      if (!b) {
        const xs = [], zs = [];
        (r.poly || []).forEach(p => { xs.push(p[0]); zs.push(p[1]); });
        (r.rects || []).forEach(q => { xs.push(q[0], q[2]); zs.push(q[1], q[3]); });
        if (r.x0 != null) { xs.push(r.x0, r.x1); zs.push(r.z0, r.z1); }
        b = xs.length ? [Math.min.apply(null, xs), Math.min.apply(null, zs),
                        Math.max.apply(null, xs), Math.max.apply(null, zs)] : [0, 0, 1, 1];
      }
      if (!r.poly && !r.rects && r.x0 != null) r.rects = [[r.x0, r.z0, r.x1, r.z1]];
      return Object.assign({ cx: (b[0] + b[2]) / 2, cz: (b[1] + b[3]) / 2, bbox: b,
                             poly: r.poly || [], rects: r.rects || [] }, r);
    });
    const bb = P.bbox || [0, 0, 10, 10];
    const CX = (bb[0]+bb[2]) / 2, CZ = (bb[1]+bb[3]) / 2;
    const d = Math.max(bb[2]-bb[0], bb[3]-bb[1], 3);
    cam.far = Math.max(400, d * 8); cam.updateProjectionMatrix();
    cam.position.set(CX + d * 0.22, d * 1.05, CZ + d * 1.0);
    controls.target.set(CX, 0, CZ); controls.update();
    buildShell(); polishShell(); buildLuminaires(); buildStrips(); buildSensors(); buildUI(); applyCut(); resize();
    const cutToggle = $("#cut"); if (cutToggle) cutToggle.checked = cutOn;
    // 默认暗场：光才是主体（优邑珺和的默认档）；白天看图是主动切过去的
    setMode("night");
    window.__api = {
      project: P, setScene, toggleCircuit, pokeSensor, setMode, applyLevels, resetManual,
      /** 外层挂进来：拖完一盏灯就把新位置写回（三维只做视图，见 pointerup）。 */
      onLightMove: null,
      speak: speakScript,
      beams: v => { beamsOn = !!v; applyLevels(); },
      cut: v => { cutOn = !!v; applyCut(); },
      state: () => ({
        name: P.name, scene: sceneId, mode, ceiling: CEIL, ceiling_net: NET,
        placing: placing ? placing.kind : null,
        rooms: rooms.length, walls: walls.length, openings: (P.openings || []).length,
        furniture: (P.furniture || []).length,
        lamps: luminaires.length, circuits: (P.circuits || []).length,
        circuit: (P.circuits || []).map(c => [c.id, +levelOf(c.id).toFixed(2), c.price || null]),
        on: luminaires.filter(o => o.lv > 0.02).length
      }),
      accept: luminanceStats, probe: probeUnderlight,
      enter: enterRoom, exit: exitRoom,
      next: stepRoom,
      place: (kind, w, d, h, rot, cb, onEnd) => { placeStart(kind, w, d, h, rot, cb, onEnd); return true; },
      placeOff: () => { placeStop(); return true; },
      cam: () => ({ p: cam.position.toArray().map(v => +v.toFixed(2)),
                    t: controls.target.toArray().map(v => +v.toFixed(2)) }),
      inside: () => (insideIdx === null ? null : { idx: insideIdx,
        name: (rooms[insideIdx] || {}).name, bbox: (rooms[insideIdx] || {}).bbox }),
      view: (n) => {
        if (n === "top") cam.position.set(CX, d * 1.7, CZ + 0.01);
        else cam.position.set(CX + d * 0.22, d * 1.05, CZ + d * 1.0);
        controls.target.set(CX, 0, CZ); controls.update();
      }
    };
    if (!window.__loopStarted) {          // 渲染循环只起一次（重新 init 不再叠第二个）
      window.__loopStarted = true;
      (function loop(now) {
        requestAnimationFrame(loop);
        if (!renderer || !controls) return;
        if (fade && stepSceneFade(now)) applyLevels(!fade);   // 情景切换渐变：逐帧推到目标值
        if (fly) {                      // 相机过渡（进出空间的“飞过去”）
          const dt = Math.max(0, (now - fly.last) / 1000); fly.last = now;
          fly.t = Math.min(1, fly.t + dt / Math.max(0.01, fly.dur));
          const e = fly.t < 0.5 ? 2 * fly.t * fly.t : 1 - Math.pow(-2 * fly.t + 2, 2) / 2;
          cam.position.lerpVectors(fly.pFrom, fly.pTo, e);
          controls.target.lerpVectors(fly.tFrom, fly.tTo, e);
          if (fly.t >= 1) fly = null;
        }
        controls.update();
        // 空间名：按相机距离换算成约 20px 屏幕高度——拉近不顶满屏，拉远也看得见（2026-10-23）
        var tanHalf = Math.tan((cam.fov || 45) * Math.PI / 360);
        var viewH = renderer.domElement.clientHeight || 600;
        G.labels.children.forEach(function (sp) {
          if (!sp.visible) return;
          var dist = cam.position.distanceTo(sp.position);
          var h = Math.max(0.14, Math.min(0.8, (2 * dist * tanHalf) * 20 / viewH));
          sp.scale.set(h * 4, h, 1);
        });
        renderer.render(scene, cam);
      })(performance.now());
    }
    window.__ready = true;
  }

  window.__initLighting3D = init;
  // 数据就绪即可渲染：内联优先 → ?pid= 拉光律接口 → 没有项目才回落到样板
  (function boot() {
    if (window.LIGHTING_PROJECT) return init(window.LIGHTING_PROJECT);
    // 内嵌在工作台里：数据与初始化都由 React 调 __initLighting3D，自己不要去拉 demo。
    if (window.__LIGHTING3D_EMBED__) return;
    const pid = new URLSearchParams(location.search).get("pid");
    if (pid) {
      fetch("/api/lighting3d/" + encodeURIComponent(pid) + "/data.json", { credentials: "same-origin" })
        .then(r => r.json()).then(d => {
          if (d && d.error) throw new Error(d.error);
          init(d);
        })
        .catch(e => {
          console.error("项目数据加载失败", e);
          const pn = document.getElementById("pname");
          if (pn) pn.textContent = "项目数据加载失败：" + e.message;
        });
      return;
    }
    const s = document.createElement("script");
    s.src = "projects/demo.js";
    s.onload = () => { if (window.LIGHTING_PROJECT) init(window.LIGHTING_PROJECT); };
    s.onerror = () => {
      const pn = document.getElementById("pname");
      if (pn) pn.textContent = "样板数据没加载上";
    };
    document.head.appendChild(s);
  })();
})();
