/*!
 * GVHudNight —— 优邑珺和参考场景「观感修复」外挂（ES5）
 * ------------------------------------------------------------------
 * 只挂 window.GVHudNight，不改 demo.html 一行。
 *
 *   init(win, doc, opts)       win=iframe.contentWindow, doc=iframe.contentDocument
 *                              opts.notify(msg, kind) 可选；opts.furn=家具构件表（可选）
 *   setNight(on)               true=夜晚补光（家具可见、灯锥仍最亮）；false=日景原状
 *   setTextMode('min'|'full')  min=收敛说明文字；full=原样
 *   setFurnitureMode('blocks'|'solid')  零渲染=体块 / 带渲染=实体家具（重刷家具层）
 *   isNight() / getTextMode() / getState()   调试用
 *
 * 夜间做法（不改光锥网格、不接管 applyLevels）：
 *   1) 调用内核 __viewer.setLightingMode(true) 保留原有夜景（背景、雾、材质夜色）；
 *   2) 把内核自带的半球光 / 两盏平行光抬到「看得见家具」的强度，
 *      再常驻一盏 AmbientLight（白天强度 0）兜住背光面；
 *   3) 切回日景时先把补光归零，再 setLightingMode(false) 让内核恢复白天原值。
 *   光锥 / 光斑 / 灯带（Zt.cone / pool / strip / beams / lum 材质）完全不碰，
 *   所以 IES 模块重算的锥体、缩放、材质不会被覆盖。
 *
 * 家具：__SCENE__.furniture 是整条家具行（kind/x/z/w/d/h/rot），已是内核帧（图纸 y 取负，
 *   内核再取负后落在 world +图纸 y —— 与二维平面图同向，2026-11-03 修镜像时的口径）。
 *   · blocks（零渲染）：按真实占地画一只简实体块，只当空间占位（1.10.0 口径「夜景＝家具体块」）。
 *   · solid（带渲染）：用 React 侧挂在 window.GUANGLV_FURN 的构件表出实体家具（沙发有靠背扶手、
 *     床有床头枕头、桌有腿），与主画布「3D 模型」、三维页引擎同一张表。拿不到表时退回体块并提示。
 *   挂到 __viewer.groups.furniture 并接上「图层 → 家具」按钮。
 */
(function (global) {
  'use strict';

  var VERSION = '1.1.0';
  var STYLE_ID = 'gv-hud-night-style';
  var TEXT_MIN_CLASS = 'gv-text-min';

  /* 夜间补光参数：内核夜里是 0.1 / 0.18 / 0.08，整屋黑到看不清。
   * 抬到下面这组：木/布家具轮廓和颜色看得出来，加色加法混合的光锥仍是最亮主体。 */
  var NIGHT = {
    hemi: 1.35,
    dirs: [1.45, 0.52],
    ambient: 2.4
  };

  /* 零渲染体块：按坐标做确定性变化，避免一排同样大小的盒子 */
  var FURN = {
    minW: 0.35, maxW: 0.60,
    minH: 0.35, maxH: 0.80,
    baseSize: 0.16,
    palette: [
      { color: 0xa9825a, roughness: 0.80, metalness: 0.02, name: 'wood' },
      { color: 0x9a9284, roughness: 0.95, metalness: 0.00, name: 'fabric' },
      { color: 0xb89772, roughness: 0.78, metalness: 0.02, name: 'wood-light' },
      { color: 0x8d9198, roughness: 0.92, metalness: 0.01, name: 'fabric-cool' }
    ]
  };

  /* 实体家具材质档（构件表 furnitureModels.ts 的 m）：1 木 / 2 布 / 3 白 / 4 金属 */
  var FURN_MATS = [
    null,
    { color: 0xa9825a, roughness: 0.80, metalness: 0.02 },
    { color: 0x9a9284, roughness: 0.95, metalness: 0.00 },
    { color: 0xdad3c8, roughness: 0.62, metalness: 0.02 },
    { color: 0xb4b8bd, roughness: 0.38, metalness: 0.72 }
  ];

  var state = {
    win: null,
    doc: null,
    viewer: null,
    notify: null,
    styleEl: null,
    textMode: 'full',
    night: false,
    inited: false,
    hemi: null,
    dirs: null,
    ambient: null,
    furniture: null,
    furnitureCount: 0,
    furnApi: null,
    furnMode: 'blocks',
    furnMats: null,
    furnVisible: true,
    furnWarned: false,
    buttonFurn: null,
    buttonLight: null
  };

  var CSS = [
    'html.' + TEXT_MIN_CLASS + ' #hud,',
    'html.' + TEXT_MIN_CLASS + ' #panel,',
    'html.' + TEXT_MIN_CLASS + ' #legend,',
    'html.' + TEXT_MIN_CLASS + ' #tip,',
    'html.' + TEXT_MIN_CLASS + ' #fixtures,',
    'html.' + TEXT_MIN_CLASS + ' .hint { display:none !important; }',
    'html.' + TEXT_MIN_CLASS + ' #labels .room {',
    '  background: rgba(255,255,255,.46);',
    '  border-color: rgba(0,0,0,.06);',
    '  box-shadow: none;',
    '  border-radius: 7px;',
    '  padding: 2px 6px;',
    '  -webkit-backdrop-filter: none; backdrop-filter: none;',
    '}',
    'html.' + TEXT_MIN_CLASS + ' #labels .room b {',
    '  font-size: 11px; font-weight: 500; letter-spacing: .1px;',
    '  color: rgba(28,28,32,.78); line-height: 1.25;',
    '}',
    'html.' + TEXT_MIN_CLASS + ' #labels .room span,',
    'html.' + TEXT_MIN_CLASS + ' #labels .room em { display:none !important; }'
  ].join('\n');

  function notify(msg, kind) {
    if (typeof state.notify !== 'function') return;
    try { state.notify(msg, kind); } catch (e) { /* 通知失败不影响功能 */ }
  }

  function getViewer() {
    var v = state.win && state.win.__viewer;
    if (!v || !v.scene || !v.THREE) return null;
    return v;
  }

  function injectStyle() {
    var doc = state.doc;
    if (!doc) return;
    var existing = doc.getElementById(STYLE_ID);
    if (existing) { state.styleEl = existing; return; }
    var el = doc.createElement('style');
    el.id = STYLE_ID;
    el.type = 'text/css';
    if (el.styleSheet) { el.styleSheet.cssText = CSS; } else { el.appendChild(doc.createTextNode(CSS)); }
    (doc.head || doc.documentElement).appendChild(el);
    state.styleEl = el;
  }

  /* 记录内核自带的半球光 / 平行光引用（init 时收集一次）；白天参数仍由内核 setLightingMode(false) 恢复 */
  function collectCoreLights(v) {
    state.hemi = null;
    state.dirs = [];
    if (!v || !v.scene) return;
    v.scene.traverse(function (o) {
      if (!o || !o.isLight) return;
      if (o.isHemisphereLight) { state.hemi = o; return; }
      if (o.isDirectionalLight) state.dirs.push(o);
    });
  }

  function ensureAmbient(v) {
    if (state.ambient && state.ambient.parent === v.scene) return state.ambient;
    var amb = new v.THREE.AmbientLight(0xffffff, 0);
    amb.name = 'gvHudNightAmbient';
    v.scene.add(amb);
    state.ambient = amb;
    return amb;
  }

  function renderOnce(v) {
    if (!v || !v.renderer || !v.scene || !v.camera) return;
    try { v.renderer.render(v.scene, v.camera); } catch (e) { /* 渲染循环会补上 */ }
  }

  function applyNightLighting(v) {
    /* 只在 init 时收集一次内核自带灯，避免把别的模块（如 IES）后加的灯一起改掉 */
    if (!state.hemi || !state.dirs || !state.dirs.length) collectCoreLights(v);
    if (state.hemi) state.hemi.intensity = NIGHT.hemi;
    if (state.dirs) {
      for (var i = 0; i < state.dirs.length; i++) {
        state.dirs[i].intensity = NIGHT.dirs[i] === undefined ? 0 : NIGHT.dirs[i];
      }
    }
    ensureAmbient(v).intensity = NIGHT.ambient;
    renderOnce(v);
  }

  function clearNightLighting(v) {
    if (state.ambient) state.ambient.intensity = 0;
    /* 内核光由 setLightingMode(false) 恢复日景原值；这里不硬写，避免盖掉内核口径 */
    renderOnce(v);
  }

  function hashStr(s) {
    var h = 2166136261, i;
    for (i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h * 16777619) >>> 0;
    }
    return h;
  }

  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

  /** 构件表在顶层 React 窗口上（furnitureModels.ts 模块加载时挂的），本内核是它的孙级 iframe。 */
  function resolveFurnApi() {
    if (state.furnApi) return state.furnApi;
    var w = null, i;
    try { w = state.win; } catch (e) { return null; }
    for (i = 0; i < 5 && w; i++) {
      var api = w.GUANGLV_FURN;
      if (api && typeof api.parts === 'function') { state.furnApi = api; return api; }
      var p = null;
      try { p = w.parent; } catch (e2) { p = null; }
      if (!p || p === w) break;
      w = p;
    }
    return null;
  }

  /** 内核的墙是外轮廓四边形（{outer:[[x,z]×4]}）；构件表要的是线段，拆边即可（差半墙厚不影响判哪侧贴墙）。 */
  function wallSegs(S) {
    var out = [], ws = (S && S.walls) || [], i, j;
    for (i = 0; i < ws.length; i++) {
      var q = ws[i] && ws[i].outer;
      if (!q || q.length < 3) continue;
      for (j = 0; j < q.length; j++) {
        var a = q[j], b = q[(j + 1) % q.length];
        if (!a || !b) continue;
        out.push({ x0: a[0], z0: a[1], x1: b[0], z1: b[1] });
      }
    }
    return out;
  }

  function furnMat(T, m) {
    if (!state.furnMats) state.furnMats = [];
    if (state.furnMats[m]) return state.furnMats[m];
    var p = FURN_MATS[m] || FURN_MATS[1];
    var v = state.viewer;
    var mat = new T.MeshStandardMaterial({
      color: p.color, roughness: p.roughness, metalness: p.metalness,
      clippingPlanes: v && v.clipPlane ? [v.clipPlane] : null,
      clipShadows: true
    });
    state.furnMats[m] = mat;
    return mat;
  }

  /** 带渲染：按构件表出实体家具。占地＝图纸 w×d，朝向＝工作台里改过的 rot；
   *  没改过（rot=0）时按「背面贴最近的墙」转正（与主画布、三维页引擎同一个 furnitureYaw）。 */
  function buildSolid(v, rows, api) {
    var T = v.THREE;
    var S = v.S || (state.win && state.win.__SCENE__) || {};
    var segs = wallSegs(S);
    var group = new T.Group();
    group.name = 'furniture';
    var seen = {}, count = 0;

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (!row || typeof row !== 'object' || row.length) continue;
      var x = Number(row.x), z = Number(row.z);
      if (!isFinite(x) || !isFinite(z)) continue;
      var key = Math.round(x * 100) + ',' + Math.round(z * 100);
      if (seen[key]) continue;
      seen[key] = 1;

      var w = Math.max(0.2, Number(row.w) || 0.6);
      var d = Math.max(0.2, Number(row.d) || 0.6);
      var h = Math.max(0.05, Number(row.h) || 0.75);
      var rot = Number(row.rot) || 0;
      var polySolid = furnPoly(row);
      if (polySolid) {
        var pmat2 = furnMat(T, 3);
        var pmesh2 = new T.Mesh(extrudePoly(T, polySolid, h), pmat2);
        pmesh2.position.set(0, 0.008, 0);
        pmesh2.castShadow = true;
        pmesh2.receiveShadow = true;
        pmesh2.userData = { kind: 'furniture', furn: String(row.kind || '') };
        group.add(pmesh2);
        count++;
        continue;
      }
      var fit = { yaw: 0, w: w, d: d };
      if (!rot && typeof api.yaw === 'function' && segs.length) {
        fit = api.yaw(x, z, w, d, segs, row.kind) || fit;
      }
      var parts = api.parts(row.kind, fit.w, fit.d, h) || [];
      if (!parts.length) continue;

      var item = new T.Group();
      /* 两种角的「帧」不同，换算也不同（2026-11-03 修「三维与平面图镜像」时与主画布/三维页对齐）：
       *  · row.rot 来自工作台，送进来前已经是「图纸转角取负」，而内核帧现在是图纸 y 取负、
       *    内核再取负回到 +图纸 y ⇒ 这个负号正好就是 world 转角本身，直接用；
       *  · fit.yaw 是 furnitureYaw 在**内核帧**里算的，内核把点对画成 world (a,·,−b)，
       *    相对内核帧是一次镜像，镜像帧的转角要 π − θ 才回得到 world，否则沙发正面撞墙。 */
      var theta = rot ? rot * Math.PI / 180 : Math.PI - fit.yaw;
      item.position.set(x, 0.012, -z);
      item.rotation.y = theta;

      for (var j = 0; j < parts.length; j++) {
        var p = parts[j];
        var geo = p.k === 'cyl'
          ? new T.CylinderGeometry(Math.max(0.02, p.r), Math.max(0.02, p.r), Math.max(0.02, p.h), 18)
          : new T.BoxGeometry(Math.max(0.02, p.w), Math.max(0.02, p.h), Math.max(0.02, p.d));
        var mesh = new T.Mesh(geo, furnMat(T, p.m || 1));
        mesh.position.set(Number(p.x) || 0, Number(p.y) || 0, Number(p.z) || 0);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.userData = { kind: 'furniture', furn: String(row.kind || '') };
        item.add(mesh);
      }
      group.add(item);
      count++;
    }
    return count ? group : null;
  }

  /** 画过轮廓的家具（到顶柜/书架/异形台面）：按 pts 挤出，不能退成外接框大块。
   *  pts 与 row.x/row.z 同一帧（内核帧），内核把 (x, y) 画成 world (x, ·, −y)。 */
  function furnPoly(row) {
    var pts = row && row.pts;
    if (!Array.isArray(pts) || pts.length < 3) return null;
    var out = [];
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i];
      if (!Array.isArray(p) || p.length < 2) return null;
      var px = Number(p[0]), py = Number(p[1]);
      if (!isFinite(px) || !isFinite(py)) return null;
      out.push([px, py]);
    }
    return out;
  }

  function extrudePoly(T, pts, h) {
    var shape = new T.Shape();
    shape.moveTo(pts[0][0], pts[0][1]);
    for (var i = 1; i < pts.length; i++) shape.lineTo(pts[i][0], pts[i][1]);
    shape.closePath();
    var geo = new T.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false });
    geo.rotateX(-Math.PI / 2);
    return geo;
  }

  /** 零渲染：真实占地的简实体块，只当空间占位。 */
  function buildSolidless(v, rows) {
    var T = v.THREE;
    var group = new T.Group();
    group.name = 'furniture';
    var seen = {}, count = 0;

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (!row) continue;
      var x, z, w, d, hgt;
      if (Array.isArray(row)) {
        x = Number(row[0]); z = Number(row[1]);
      } else {
        x = Number(row.x); z = Number(row.z);
      }
      if (!isFinite(x) || !isFinite(z)) continue;
      var key = Math.round(x * 100) + ',' + Math.round(z * 100);
      if (seen[key]) continue;
      seen[key] = 1;

      if (Array.isArray(row)) {
        /* 旧的 [x, z, 半径] 行（内核单独跑 demo）：按坐标做确定性变化 */
        var radius = Number(row[2]);
        if (!isFinite(radius) || radius <= 0) radius = FURN.baseSize;
        var base = clamp(radius * 2, FURN.minW, FURN.maxW);
        var hs = hashStr(key);
        w = clamp(base + (hs % 5) * 0.045, FURN.minW, FURN.maxW);
        d = clamp(base + ((hs >>> 3) % 5) * 0.045, FURN.minW, FURN.maxW);
        hgt = clamp(0.40 + ((hs >>> 6) % 5) * 0.090, FURN.minH, FURN.maxH);
      } else {
        w = Math.max(0.2, Number(row.w) || 0.6);
        d = Math.max(0.2, Number(row.d) || 0.6);
        hgt = Math.max(0.05, Number(row.h) || 0.75);
      }
      /* 偶数位置走木色系（0/2），奇数位置走布色系（1/3），保证木/布两种材质都出现 */
      var pal = FURN.palette[(count % 2) + ((hashStr(key) >>> 9) % 2) * 2];
      if (!Array.isArray(row)) {
        var poly = furnPoly(row);
        if (poly) {
          // 画过轮廓的家具（到顶柜/书架/异形台面）：按轮廓挤出，按外接框会变成一堵墙
          var pmat = new T.MeshStandardMaterial({
            color: pal.color, roughness: pal.roughness, metalness: pal.metalness,
            clippingPlanes: v.clipPlane ? [v.clipPlane] : null,
            clipShadows: true
          });
          var pmesh = new T.Mesh(extrudePoly(T, poly, hgt), pmat);
          pmesh.position.set(0, 0.004, 0);
          pmesh.castShadow = true;
          pmesh.receiveShadow = true;
          pmesh.userData = { kind: 'furniture', palette: pal.name };
          group.add(pmesh);
          count++;
          continue;
        }
      }
      var mesh = new T.Mesh(new T.BoxGeometry(w, hgt, d), new T.MeshStandardMaterial({
        color: pal.color, roughness: pal.roughness, metalness: pal.metalness,
        clippingPlanes: v.clipPlane ? [v.clipPlane] : null,
        clipShadows: true
      }));
      mesh.position.set(x, hgt / 2 + 0.004, -z);
      if (!Array.isArray(row) && Number(row.rot)) mesh.rotation.y = Number(row.rot) * Math.PI / 180;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData = { kind: 'furniture', palette: pal.name };
      group.add(mesh);
      count++;
    }
    return count ? group : null;
  }

  function disposeFurniture() {
    var g = state.furniture;
    if (g) {
      if (g.parent) g.parent.remove(g);
      if (state.viewer && state.viewer.groups && state.viewer.groups.furniture === g) {
        delete state.viewer.groups.furniture;
      }
      g.traverse(function (o) {
        if (o && o.isMesh && o.geometry && o.geometry.dispose) o.geometry.dispose();
      });
    }
    state.furniture = null;
    state.furnitureCount = 0;
  }

  function currentRows(v) {
    var S = v.S || (state.win && state.win.__SCENE__) || null;
    return (S && S.furniture) || [];
  }

  /** 出实体家具；构件表不在（内核单独跑 demo）或一条都没建成时回 null，由调用方退回体块。 */
  function trySolid(v, rows) {
    var api = resolveFurnApi();
    if (!api) {
      if (!state.furnWarned) {
        state.furnWarned = true;
        notify('家具实体化不可用：构件表未挂载（GUANGLV_FURN），已退回体块', 'err');
      }
      return null;
    }
    return buildSolid(v, rows, api);
  }

  function mountFurniture(v, group) {
    group.visible = state.furnVisible;
    v.scene.add(group);
    v.groups.furniture = group;
    state.furniture = group;
    state.furnitureCount = group.children.length;
    if (state.buttonFurn && state.buttonFurn.classList) {
      state.buttonFurn.classList.toggle('on', state.furnVisible);
    }
    renderOnce(v);
    return group;
  }

  /** 按当前模式重建家具层（切换零渲染/带渲染、或新 iframe 首次挂载）。 */
  function rebuildFurniture(v) {
    if (!v || !v.groups) return null;
    var rows = currentRows(v);
    if (!rows.length) return null;
    var group = state.furnMode === 'solid' ? trySolid(v, rows) : null;
    if (!group) group = buildSolidless(v, rows);
    disposeFurniture();
    return group ? mountFurniture(v, group) : null;
  }

  function buildFurniture(v) {
    /* 内核自带的家具层（demo 场景真有网格）不接管，只报数 */
    var own = v.groups && v.groups.furniture;
    if (own && own.isGroup && own.children.length && !state.furniture) {
      state.furniture = own;
      state.furnitureCount = own.children.length;
      return own;
    }
    return rebuildFurniture(v);
  }

  function wireFurnitureButton() {
    var doc = state.doc;
    if (!doc) return;
    var btn = doc.querySelector ? doc.querySelector('[data-toggle="furniture"]') : null;
    if (!btn) return;
    state.buttonFurn = btn;
    btn.classList.toggle('on', !!(state.furniture && state.furniture.visible));
    btn.onclick = function () {
      var g = state.furniture;
      if (!g) return;
      g.visible = !g.visible;
      state.furnVisible = g.visible;
      btn.classList.toggle('on', g.visible);
      notify(g.visible ? '家具层：显示' : '家具层：隐藏', '');
    };
  }

  /* 面板里的「灯光演示」按钮如果被点，走预览页自己的 applyLight，避免预览页开关和 iframe 内灯光状态脱节 */
  function wireLightButton() {
    var doc = state.doc;
    if (!doc) return;
    var btn = doc.getElementById ? doc.getElementById('btnLight') : null;
    if (!btn) return;
    state.buttonLight = btn;
    btn.onclick = function () {
      var target = !state.night;
      if (typeof global.applyLight === 'function' && global.GVHudNight === api) {
        try { global.applyLight(target ? 'night' : 'day'); return; } catch (e) { /* fallback */ }
      }
      api.setNight(target);
    };
  }

  var api = {
    version: VERSION,

    init: function (win, doc, opts) {
      if (!win || !doc) return false;
      if (opts && typeof opts.notify === 'function') state.notify = opts.notify;
      if (opts && opts.furn && typeof opts.furn.parts === 'function') state.furnApi = opts.furn;

      var same = state.inited && state.win === win && state.doc === doc && state.viewer === win.__viewer;
      if (same) {
        injectStyle();
        applyTextClass();
        return true;
      }

      /* 新 iframe（首次或刷新）：重置引用，旧窗口的灯光/家具随旧 document 丢弃 */
      state.win = win;
      state.doc = doc;
      state.viewer = null;
      state.styleEl = null;
      state.night = false;
      state.hemi = null;
      state.dirs = null;
      state.ambient = null;
      state.furniture = null;
      state.furnitureCount = 0;
      state.furnMats = null;
      state.furnWarned = false;
      state.buttonFurn = null;
      state.buttonLight = null;
      state.inited = false;

      injectStyle();

      var v = getViewer();
      if (!v) {
        notify('场景 3D 内核未就绪：文字精简可用，夜间补光稍后再试', 'err');
        applyTextClass();
        return false;
      }

      state.viewer = v;
      state.inited = true;
      collectCoreLights(v);
      ensureAmbient(v);
      try {
        buildFurniture(v);
      } catch (e) {
        notify('家具体块生成失败：' + (e && e.message ? e.message : e), 'err');
      }
      try {
        wireFurnitureButton();
        wireLightButton();
      } catch (e2) {
        notify('面板按钮接管失败：' + (e2 && e2.message ? e2.message : e2), 'err');
      }
      applyTextClass();
      return true;
    },

    setNight: function (on) {
      on = !!on;
      var v = getViewer();
      if (!v) {
        notify('夜间补光不可用：场景 3D 内核未就绪', 'err');
        return false;
      }
      try {
        if (on) {
          v.setLightingMode(true);
          applyNightLighting(v);
        } else {
          clearNightLighting(v);
          v.setLightingMode(false);
        }
      } catch (e) {
        notify('切换灯光模式失败：' + (e && e.message ? e.message : e), 'err');
        return false;
      }
      state.night = on;
      if (state.buttonLight && state.buttonLight.classList) {
        state.buttonLight.classList.toggle('on', on);
      }
      renderOnce(v);
      notify(on ? '夜晚：已补光（家具可见，灯光仍是画面主体）' : '日景：已恢复原状', 'ok');
      return true;
    },

    setTextMode: function (mode) {
      var m = (mode === 'min') ? 'min' : 'full';
      var changed = (m !== state.textMode);
      state.textMode = m;
      applyTextClass();
      if (changed) notify(m === 'min' ? '精简文字：已收起说明面板' : '完整文字：已恢复说明面板', 'ok');
      return true;
    },

    /** 家具呈现：blocks＝零渲染的占地体块，solid＝带渲染的实体家具（同一张构件表）。 */
    setFurnitureMode: function (mode) {
      var m = (mode === 'solid') ? 'solid' : 'blocks';
      var v = getViewer();
      if (!v) {
        state.furnMode = m;
        notify('家具呈现稍后再试：场景 3D 内核未就绪', 'err');
        return false;
      }
      if (state.furnMode === m && state.furniture) return true;
      state.furnMode = m;
      var group = rebuildFurniture(v);
      if (!group) { notify('家具层没建起来：场景里没有家具行', 'err'); return false; }
      renderOnce(v);
      notify(m === 'solid'
        ? '带渲染：实体家具（' + state.furnitureCount + ' 件，与主画布同一张构件表）'
        : '零渲染：家具体块（' + state.furnitureCount + ' 件占地）', '');
      return true;
    },

    isNight: function () { return !!state.night; },
    getTextMode: function () { return state.textMode; },

    /* 自测/排查用：不参与页面逻辑 */
    getState: function () {
      return {
        version: VERSION,
        inited: !!state.inited,
        night: !!state.night,
        textMode: state.textMode,
        furniture: state.furnitureCount,
        furnitureVisible: !!(state.furniture && state.furniture.visible),
        furnitureMode: state.furnMode,
        furnitureParts: !!resolveFurnApi(),
        lights: {
          hemi: state.hemi ? state.hemi.intensity : null,
          dirs: state.dirs ? state.dirs.map(function (d) { return d.intensity; }) : [],
          ambient: state.ambient ? state.ambient.intensity : null
        }
      };
    }
  };

  function applyTextClass() {
    var doc = state.doc;
    if (!doc || !doc.documentElement) return;
    var root = doc.documentElement;
    if (state.textMode === 'min') root.classList.add(TEXT_MIN_CLASS);
    else root.classList.remove(TEXT_MIN_CLASS);
  }

  /* 暴露 API 对象；页面上只有 window.GVHudNight 这一个入口 */
  global.GVHudNight = api;
})(window);
