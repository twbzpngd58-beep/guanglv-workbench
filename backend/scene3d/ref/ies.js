/*!
 * GVIes · 优邑珺和参考场景 · IES 配光解析 + 光锥按真实半峰值角重算
 * ---------------------------------------------------------------------------
 * 纯前端 ES5，无外部依赖，不修改 demo/demo.html 与工作台任何文件。
 * 挂载到父页面 window.GVIes，通过 iframe 的 window.__viewer 操作参考场景。
 *
 * 对外接口（契约）：
 *   init(win, opts)                    绑定 iframe window（win.__viewer）；opts.notify(msg, kind)
 *   parse(text) -> parsed              解析 LM-63（TILT=NONE / TILT=INCLUDE 近似）；失败抛中文 Error
 *   apply(win, parsed, opts) -> result 按 IES 半峰值角重建每盏灯光锥；返回 { applied, angleDeg }
 *   clear(win) -> result               移除自定义光锥、还原场景原状
 *
 * 实现要点：
 *   1) 不新增重复网格：直接替换 __viewer.lumList[i].cone 的几何体（ConeGeometry，开口锥），
 *      保留原 Mesh/Material/所在分组，避免与场景自身的 applyLevels()/setPreset() 抢可见性。
 *   2) 半峰值角 -> 锥底半径 R = H * tan(halfAngle)，H 取原锥几何高度（灯到地面的落差，米）。
 *   3) 用 IES 峰值水平面的坎德拉曲线生成竖向渐变贴图（AdditiveBlending 材质原有 map 替换），
 *      沿锥高按 atan(t·tan(half)) 取对应角度的相对光强，亮暗分布随 IES 变化。
 *   4) 能量归一：宽光束按“原锥侧面积 / 新锥侧面积”的软指数压暗锥体贴图 alpha
 *      与落地光斑颜色（只压不升），并把光斑直径封顶在原直径 2.5 倍，
 *      避免 45 盏加色宽束把整屋洗白；锥角形状严格保持 IES 半峰值角不变。
 *   5) apply 前记录原几何/原贴图/原落地光斑尺寸与颜色；clear 逐项恢复；重复 apply 幂等（先还原再重建）。
 *   6) 不碰 __viewer.setLightingMode / applyLevels 的材质与灯光逻辑（夜间补光模块可并行工作）。
 */
(function (global) {
  'use strict';

  var VERSION = '1.0.0';
  var RAD = Math.PI / 180;
  var MIN_HALF_ANGLE = 0.5;   // 极小配光兜底
  var MAX_HALF_ANGLE = 89;    // tan(90°) 无界，>90° 的异常数据统一封顶
  var MAX_V_ANGLES = 4096;
  var MAX_H_ANGLES = 4096;
  var MAX_CANDELA_CELLS = 2000000;
  var MIN_ENERGY_FACTOR = 0.04;      // 能量归一下限：宽光束也不能完全看不见
  var DEFAULT_ENERGY_EXPONENT = 0.80; // 侧面积反比归一的软指数；0.8 时接近「按 tan(half) 反比」的压暗量
  var POOL_MAX_GROWTH = 2.5;         // 落地光斑相对原直径的最大放大倍数（宽光束不再无限铺满）

  var _win = null;
  var _opts = {};
  var _state = null;

  /* ======================================================================
   * 基础工具
   * ==================================================================== */

  function isNum(v) {
    return typeof v === 'number' && isFinite(v);
  }

  function isInt(v) {
    return isNum(v) && Math.floor(v) === v;
  }

  function trimStr(s) {
    return String(s == null ? '' : s).replace(/^\s+|\s+$/g, '');
  }

  function fail(msg) {
    throw new Error(msg);
  }

  function round3(v) {
    return Math.round(v * 1000) / 1000;
  }

  function disposeSafe(obj) {
    if (obj && typeof obj.dispose === 'function') {
      try { obj.dispose(); } catch (e) { /* 释放失败不影响还原 */ }
    }
  }

  function notify(msg, kind) {
    try {
      var fn = _opts && _opts.notify;
      if (typeof fn === 'function') fn(msg, kind || '');
    } catch (e) { /* 通知失败不影响主流程 */ }
  }

  /* ======================================================================
   * 一、LM-63（IESNA）解析
   * ==================================================================== */

  /**
   * 解析 IES 文本。
   * @param {string} text
   * @returns {object} { halfAngleDeg, peak, verticalAngles, horizontalAngles, candela, ... }
   */
  function parse(text) {
    if (typeof text !== 'string') {
      fail('IES 内容无效：请提供文本内容（readAsText / File.text() 的字符串）');
    }
    var src = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    if (!trimStr(src)) fail('IES 文件为空');

    var lines = src.split('\n');
    var total = lines.length;

    /* ---- 1. 版本行（容错：前 10 个非空行内找 IES 开头） ---- */
    var version = null;
    var versionLine = -1;
    var seen = 0;
    for (var i = 0; i < total && seen < 10; i++) {
      var t = trimStr(lines[i]);
      if (!t) continue;
      seen++;
      if (/^IES/i.test(t)) {
        version = t;
        versionLine = i;
        break;
      }
    }
    if (versionLine < 0) {
      fail('不是有效的 IES（LM-63）文件：缺少 IESNA 版本行');
    }

    /* ---- 2. 找 TILT 行（版本行之后、允许 [KEYWORD] 行） ---- */
    var tilt = null;
    var tiltLine = -1;
    var m;
    for (var k = versionLine + 1; k < total; k++) {
      var line = trimStr(lines[k]);
      if (!line) continue;
      if (line.charAt(0) === '[') continue; // 关键字行（[TEST] [MANUFAC] 等）
      m = /^TILT\s*=\s*(.+)$/i.exec(line);
      if (m) {
        tilt = trimStr(m[1]);
        tiltLine = k;
        break;
      }
    }
    if (tiltLine < 0) {
      fail('不是有效的 IES 文件：未找到 TILT= 行');
    }
    var tiltUp = tilt.toUpperCase();
    var tiltData = null;
    var paramStart = tiltLine + 1;
    if (tiltUp === 'INLINE') {
      fail('该 IES 使用 TILT=INLINE 倾斜数据，暂不支持；请在灯具软件中另存为 TILT=NONE 后再上传');
    }
    if (tiltUp === 'INCLUDE') {
      // LM-63 TILT=INCLUDE：几何类型 / 角度对数 / 倾斜角列表 / 乘法因子列表。
      // 与工作台 backend/ies.py 一致：读取但不对 candela 做倾斜修正（近似，仅作配光预览）。
      var tIndex = tiltLine + 1;
      var tTokens = [];
      var tNeed = -1;
      while (tIndex < total) {
        var tLine = trimStr(lines[tIndex]);
        if (!tLine) { tIndex++; continue; }
        if (tLine.charAt(0) === '[') { tIndex++; continue; }
        var tNums = splitNumbers(tLine, tIndex + 1);
        for (var tn = 0; tn < tNums.length; tn++) tTokens.push(tNums[tn]);
        if (tNeed < 0 && tTokens.length >= 3) {
          var tPairs = tTokens[1];
          if (!isInt(tPairs) || tPairs < 0 || tPairs > 1000) {
            fail('TILT=INCLUDE 倾斜数据异常：角度对数无效（' + tPairs + '）');
          }
          tNeed = 3 + 2 * tPairs;
        }
        if (tNeed >= 0 && tTokens.length >= tNeed) break;
        tIndex++;
      }
      if (tNeed < 0 || tTokens.length < tNeed) {
        fail('TILT=INCLUDE 倾斜数据不完整（需要 ' + (tNeed < 0 ? '至少 3' : tNeed) + ' 个数值）');
      }
      if (tTokens.length > tNeed) {
        fail('TILT=INCLUDE 倾斜数据与参数行未分行，暂不支持；请另存为 TILT=NONE 后再上传');
      }
      var tPairs2 = tTokens[1];
      var tAngles = [];
      var tFactors = [];
      for (var ta = 0; ta < tPairs2; ta++) tAngles.push(tTokens[3 + ta]);
      for (var tf = 0; tf < tPairs2; tf++) tFactors.push(tTokens[3 + tPairs2 + tf]);
      tiltData = {
        geometry: tTokens[0],
        pairs: tPairs2,
        angles: tAngles,
        factors: tFactors
      };
      paramStart = tIndex + 1;
    } else if (tiltUp !== 'NONE') {
      fail('该 IES 引用外置倾斜文件（TILT=' + tilt + '），暂不支持；请另存为 TILT=NONE 后再上传');
    }

    /* ---- 3. 参数行（10 / 12 / 13 个字段，取第 11 位起为镇流器/功率） ---- */
    var paramLine = -1;
    for (var p = paramStart; p < total; p++) {
      var pl = trimStr(lines[p]);
      if (!pl) continue;
      if (pl.charAt(0) === '[') continue;
      paramLine = p;
      break;
    }
    if (paramLine < 0) fail('IES 参数行缺失：TILT= 之后没有灯数/角度数等参数');
    var header = splitNumbers(trimStr(lines[paramLine]), paramLine + 1);
    if (header.length < 10) {
      fail('IES 参数行不完整：至少需要 10 个数值（灯数/流明/乘法因子/垂直角数/水平角数/光度类型/单位/宽/长/高），实际 ' + header.length + ' 个');
    }

    var lampCount = header[0];
    var lumens = header[1];
    var multiplier = header[2];
    var nV = header[3];
    var nH = header[4];
    var photometricType = header[5];
    var unitsType = header[6];
    var dimWidth = header[7];
    var dimLength = header[8];
    var dimHeight = header[9];
    var ballastFactor = header.length >= 11 ? header[10] : null;
    var watts = header.length >= 13 ? header[12] : null;

    if (!isInt(lampCount) || lampCount < 1 || lampCount > 1000) {
      fail('IES 参数异常：灯数应为 1~1000 的整数，实际为「' + lampCount + '」');
    }
    if (!isNum(lumens) || lumens < 0) lumens = 0;
    if (!isNum(multiplier) || multiplier <= 0) multiplier = 1;
    if (!isInt(nV) || nV < 1 || nV > MAX_V_ANGLES) {
      fail('IES 参数异常：垂直角数量应为 1~' + MAX_V_ANGLES + ' 的整数，实际为「' + nV + '」');
    }
    if (!isInt(nH) || nH < 1 || nH > MAX_H_ANGLES) {
      fail('IES 参数异常：水平角数量应为 1~' + MAX_H_ANGLES + ' 的整数，实际为「' + nH + '」');
    }
    if (!isInt(photometricType) || photometricType < 1 || photometricType > 3) {
      fail('IES 参数异常：光度类型应为 1(C) / 2(B) / 3(A)，实际为「' + photometricType + '」');
    }
    if (!isInt(unitsType) || (unitsType !== 1 && unitsType !== 2)) {
      fail('IES 参数异常：单位类型应为 1(英尺) / 2(米)，实际为「' + unitsType + '」');
    }
    if (!isNum(dimWidth)) dimWidth = null;
    if (!isNum(dimLength)) dimLength = null;
    if (!isNum(dimHeight)) dimHeight = null;
    if (watts != null && (!isNum(watts) || watts <= 0)) watts = null;
    if (ballastFactor != null && !isNum(ballastFactor)) ballastFactor = null;
    if (nV * nH > MAX_CANDELA_CELLS) {
      fail('IES 数据规模异常：坎德拉矩阵 ' + nH + '×' + nV + ' 超过上限 ' + MAX_CANDELA_CELLS);
    }

    /* ---- 4. 逐行收集数值流（角度/坎德拉可跨行；忽略 [KEYWORD] 行） ---- */
    var tokens = [];
    for (var r = paramLine + 1; r < total; r++) {
      var rl = trimStr(lines[r]);
      if (!rl) continue;
      if (rl.charAt(0) === '[') continue;
      var parts = rl.split(/[\s,]+/);
      for (var c = 0; c < parts.length; c++) {
        var tok = parts[c];
        if (!tok) continue;
        var num = Number(tok);
        if (!isFinite(num)) {
          fail('IES 数据行含无法识别的数值「' + tok.slice(0, 24) + '」（第 ' + (r + 1) + ' 行）');
        }
        tokens.push(num);
      }
    }

    var need = nV + nH + nV * nH;
    if (tokens.length < need) {
      fail('IES 坎德拉数据不完整：需要 ' + need + ' 个数值（垂直角 ' + nV + ' 个 + 水平角 ' + nH + ' 个 + 坎德拉 ' + (nV * nH) + ' 个），实际只有 ' + tokens.length + ' 个');
    }

    /* ---- 5. 读角度与坎德拉矩阵（LM-63 顺序：水平面外层，垂直角内层） ---- */
    var pos = 0;
    var vAnglesRaw = [];
    var hAnglesRaw = [];
    for (var vi = 0; vi < nV; vi++) vAnglesRaw.push(tokens[pos++]);
    for (var hi = 0; hi < nH; hi++) hAnglesRaw.push(tokens[pos++]);

    var planesRaw = []; // planesRaw[h][v]，未乘乘法因子、按文件原顺序
    for (var hh = 0; hh < nH; hh++) {
      var planeRaw = [];
      for (var vv = 0; vv < nV; vv++) {
        var cdRaw = tokens[pos++];
        if (!isNum(cdRaw) || cdRaw < 0) cdRaw = 0; // 负值/异常值按 0 处理，避免污染峰值
        planeRaw.push(cdRaw * multiplier);
      }
      planesRaw.push(planeRaw);
    }

    /* ---- 6. 角度排序（升序），坎德拉随之重排，保证插值与贴图采样正确 ---- */
    var vOrder = sortIndexes(vAnglesRaw);
    var hOrder = sortIndexes(hAnglesRaw);
    var verticalAngles = [];
    for (var a = 0; a < vOrder.length; a++) verticalAngles.push(vAnglesRaw[vOrder[a]]);
    var horizontalAngles = [];
    for (var b = 0; b < hOrder.length; b++) horizontalAngles.push(hAnglesRaw[hOrder[b]]);

    var candela = [];
    var peak = -Infinity;
    var peakPlaneIndex = 0;
    var planePeaks = [];
    for (var h2 = 0; h2 < hOrder.length; h2++) {
      var srcPlane = planesRaw[hOrder[h2]];
      var plane = [];
      var planePeak = 0;
      for (var v2 = 0; v2 < vOrder.length; v2++) {
        var cd = srcPlane[vOrder[v2]];
        plane.push(cd);
        if (cd > planePeak) planePeak = cd;
      }
      candela.push(plane);
      planePeaks.push(planePeak);
      if (planePeak > peak) {
        peak = planePeak;
        peakPlaneIndex = h2;
      }
    }

    if (!isNum(peak) || peak <= 0) {
      fail('IES 坎德拉数据全为 0（或全部无效），无法计算配光');
    }

    /* ---- 7. 半峰值角：取峰值水平面，沿垂直角线性插值找 50% 处 ---- */
    var peakPlane = candela[peakPlaneIndex];
    var halfInfo = computeHalfPeak(verticalAngles, peakPlane, peak);
    var halfAngleDeg = halfInfo.half;
    var notes = [];
    if (halfInfo.fallback) {
      notes.push('半峰值角按兜底规则处理（' + halfInfo.fallback + '）');
    }
    if (photometricType !== 1) {
      notes.push('该文件光度类型为 ' + photometricType + '（非 C 型），垂直角基准与下照锥不同，半峰值角按同一算法近似');
    }
    if (tiltData) {
      notes.push('已读取 TILT=INCLUDE 倾斜数据，但未按倾斜角修正 candela（配光预览近似）');
    }

    /* ---- 8. 峰值平面曲线（供 apply 生成亮度渐变贴图） ---- */
    var profile = [];
    for (var pi = 0; pi < verticalAngles.length; pi++) {
      profile.push({ angle: verticalAngles[pi], cd: peakPlane[pi] });
    }

    return {
      // —— 契约字段 ——
      halfAngleDeg: halfAngleDeg,
      peak: peak,
      verticalAngles: verticalAngles,
      horizontalAngles: horizontalAngles,
      candela: candela,               // [水平面][垂直角]，已乘乘法因子
      lampCount: lampCount,
      watts: watts,                   // 文件未提供时为 null
      photometricType: photometricType,
      unitsType: unitsType,           // 1=英尺 2=米（LM-63 原值）
      // —— 附加字段（UI / 调试用） ——
      version: version,
      tilt: tiltUp,
      tiltData: tiltData,
      lumens: lumens,
      multiplier: multiplier,
      ballastFactor: ballastFactor,
      dimensions: { width: dimWidth, length: dimLength, height: dimHeight },
      unitsTypeLabel: unitsType === 1 ? '英尺' : '米',
      peakPlaneIndex: peakPlaneIndex,
      peakAngleDeg: verticalAngles[halfInfo.peakIndex],
      halfAngleRawDeg: halfInfo.raw,
      halfAngleFallback: halfInfo.fallback,
      beamAngleDeg: round3(halfAngleDeg * 2),
      profile: profile,
      notes: notes
    };
  }

  /** 按空白/逗号拆分数值，任何一个非数值直接抛错（带行号） */
  function splitNumbers(line, lineNo) {
    var out = [];
    var parts = trimStr(line).split(/[\s,]+/);
    for (var i = 0; i < parts.length; i++) {
      var s = parts[i];
      if (!s) continue;
      var n = Number(s);
      if (!isFinite(n)) {
        fail('IES 参数行（第 ' + lineNo + ' 行）含无法识别的数值「' + s.slice(0, 24) + '」');
      }
      out.push(n);
    }
    return out;
  }

  /** 稳定排序索引：返回按 values 升序排列的下标数组 */
  function sortIndexes(values) {
    var idx = [];
    for (var i = 0; i < values.length; i++) {
      idx.push({ i: i, v: values[i], seq: i });
    }
    idx.sort(function (a, b) {
      if (a.v === b.v) return a.seq - b.seq;
      return a.v - b.v;
    });
    var out = [];
    for (var j = 0; j < idx.length; j++) out.push(idx[j].i);
    return out;
  }

  /**
   * 计算 50% 半峰值角。
   * - 从峰值角向外找第一个 ≤ 50% 峰值的采样点，线性插值；
   * - 若峰值之后不下降，尝试峰值之前的上升沿；
   * - 仍找不到则取最大角度；最后 clamp 到 [0.5, 89]°。
   * @returns {{half:number, raw:number, peakIndex:number, fallback:string|null}}
   */
  function computeHalfPeak(angles, values, peak) {
    var n = values.length;
    var peakIndex = 0;
    for (var i = 1; i < n; i++) {
      if (values[i] > values[peakIndex]) peakIndex = i;
    }
    var target = peak * 0.5;
    var half = null;
    var fallback = null;

    // 峰值之后的下坡段
    for (var j = peakIndex + 1; j < n; j++) {
      if (values[j] <= target) {
        var a0 = angles[j - 1], a1 = angles[j];
        var y0 = values[j - 1], y1 = values[j];
        if (y0 > target && y1 <= target && a1 > a0) {
          half = a0 + (y0 - target) / (y0 - y1) * (a1 - a0);
        } else {
          half = a1;
        }
        break;
      }
    }

    // 峰值之前的上坡段（例如峰值在 60° 的洗墙配光）
    if (half == null && peakIndex > 0) {
      for (var k = 0; k < peakIndex; k++) {
        if (values[k] < target && values[k + 1] >= target) {
          var b0 = angles[k], b1 = angles[k + 1];
          var z0 = values[k], z1 = values[k + 1];
          if (z1 > z0 && b1 > b0) {
            half = b0 + (target - z0) / (z1 - z0) * (b1 - b0);
          } else {
            half = b1;
          }
          break;
        }
      }
    }

    if (half == null) {
      half = n > 0 ? angles[n - 1] : 90;
      fallback = 'no-crossing';
    }

    var raw = half;
    if (!isNum(half) || half < 0) {
      half = 90;
      fallback = 'invalid';
    }
    if (half > 90) {
      half = 90;
      fallback = 'angle>90';
    }
    if (half > MAX_HALF_ANGLE) {
      half = MAX_HALF_ANGLE;
      fallback = fallback || 'angle>89';
    }
    if (half < MIN_HALF_ANGLE) {
      half = MIN_HALF_ANGLE;
      fallback = fallback || 'angle<0.5';
    }

    return {
      half: half,
      raw: round3(raw),
      peakIndex: peakIndex,
      fallback: fallback
    };
  }

  /* ======================================================================
   * 二、按 IES 曲线生成光锥亮度渐变贴图
   * ==================================================================== */

  /** 在峰值平面曲线上线性插值取坎德拉（角度为垂直角，度） */
  function sampleCandela(profile, angle) {
    var n = profile.length;
    if (!n) return 0;
    if (angle <= profile[0].angle) return profile[0].cd;
    if (angle >= profile[n - 1].angle) return profile[n - 1].cd;
    var lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      var mid = (lo + hi) >> 1;
      if (profile[mid].angle <= angle) lo = mid;
      else hi = mid;
    }
    var a0 = profile[lo].angle, a1 = profile[hi].angle;
    var c0 = profile[lo].cd, c1 = profile[hi].cd;
    if (a1 - a0 < 1e-9) return c1;
    return c0 + (c1 - c0) * ((angle - a0) / (a1 - a0));
  }

  /**
   * 生成 8×256 的竖向光强渐变贴图（白色 RGB + IES 相对光强映射的 alpha）。
   * 贴图 v=1（画布首行）对应锥顶（0°），v=0（末行）对应锥底（halfAngle）。
   * 同一 energyFactor 的灯共享一张贴图。
   *
   * @param {number} [energyFactor] 能量归一系数（≤1）：宽光束整体压暗，
   *        避免 45 盏加色叠加把场景洗白；锥角形状不受影响。
   */
  function makeConeGradient(THREE, parsed, halfDeg, energyFactor) {
    var profile = parsed.profile || [];
    var peak = isNum(parsed.peak) && parsed.peak > 0 ? parsed.peak : 1;
    var energy = isNum(energyFactor) ? Math.max(MIN_ENERGY_FACTOR, Math.min(1, energyFactor)) : 1;
    var halfRad = halfDeg * RAD;
    var tanHalf = Math.tan(halfRad);
    var W = 8, H = 256;
    var canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    var ctx = canvas.getContext('2d');
    var img = ctx.createImageData(W, H);
    var data = img.data;

    for (var y = 0; y < H; y++) {
      var t = H > 1 ? y / (H - 1) : 0;                 // 0=锥顶（灯口） 1=锥底（半峰值角）
      var angleDeg = Math.atan(t * tanHalf) / RAD;     // 锥体沿高度的真实张角
      var rel = sampleCandela(profile, angleDeg) / peak;
      if (!isNum(rel) || rel < 0) rel = 0;
      if (rel > 1) rel = 1;
      // 亮度 ∝ 相对光强；锥顶做一点收边，避免所有三角面在灯口叠加成亮点
      var apexFade = 0.22 + 0.78 * Math.min(1, t / 0.10);
      var alpha01 = (0.06 + 0.58 * Math.pow(rel, 0.9)) * apexFade * energy;
      if (alpha01 < 0) alpha01 = 0;
      if (alpha01 > 1) alpha01 = 1;
      var alpha = Math.round(alpha01 * 255);
      for (var x = 0; x < W; x++) {
        var o = (y * W + x) * 4;
        data[o] = 255;
        data[o + 1] = 255;
        data[o + 2] = 255;
        data[o + 3] = alpha;
      }
    }
    ctx.putImageData(img, 0, 0);

    var tex = new THREE.CanvasTexture(canvas);
    if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    return tex;
  }

  /* ======================================================================
   * 三、场景应用 / 还原
   * ==================================================================== */

  /**
   * 兜底发现预览页里已就绪的 iframe（父页面 window.GVIes 场景）。
   * 背景：index.html 在 iframe load 之后才调用 init；
   * 若 iframe 在监听器注册前就 load 完（极快缓存命中），init 不会被调用、
   * 页面自身的 win 变量也会保持 null。此时本模块自动发现同页 iframe，
   * 让「应用 IES」依旧可用，不依赖调用方是否传 win。
   */
  function discoverViewerWin() {
    try {
      if (typeof document === 'undefined' || !document.getElementsByTagName) return null;
      var frames = document.getElementsByTagName('iframe');
      for (var i = 0; i < frames.length; i++) {
        var w = null;
        try { w = frames[i].contentWindow; } catch (e) { w = null; }
        if (!w) continue;
        try {
          if (w.__ready && w.__viewer && w.__viewer.lumList) return w;
        } catch (e2) { /* 跨域/未就绪，继续找 */ }
      }
    } catch (e3) { /* 非浏览器环境 */ }
    return null;
  }

  /** 找到某盏灯对应的光锥 Mesh（优先 lumList[i].cone，缺失时按灯位就近在 groups.cone 里找） */
  function resolveCone(viewer, lum) {
    if (lum && lum.cone && lum.cone.isMesh) return lum.cone;
    var group = viewer.groups && viewer.groups.cone;
    if (!group || !group.children) return null;
    var bx = null, bz = null;
    if (lum && lum.body && lum.body.position) {
      bx = lum.body.position.x;
      bz = lum.body.position.z;
    } else if (lum && lum.meta) {
      bx = lum.meta.x;
      bz = -lum.meta.y;
    }
    if (bx == null || bz == null) return null;
    var best = null;
    var bestD2 = 0.25 * 0.25; // 0.25m 内视为同一盏灯
    for (var i = 0; i < group.children.length; i++) {
      var m = group.children[i];
      var dx = m.position.x - bx;
      var dz = m.position.z - bz;
      var d2 = dx * dx + dz * dz;
      if (d2 <= bestD2) {
        bestD2 = d2;
        best = m;
      }
    }
    return best;
  }

  /**
   * 灯到地面的落差 H / 锥几何高度 / 锥的 y 位置。
   * 优先用原锥几何参数（demo 里是 ConeGeometry radius=H·tan(half), height=H，锥尖在天花）。
   */
  function coneMetrics(viewer, cone, lum) {
    var params = cone && cone.geometry && cone.geometry.parameters;
    if (params && isNum(params.height) && params.height > 0.1) {
      return {
        H: params.height,
        geomH: params.height,
        posY: cone.position.y,
        adjustPos: false
      };
    }
    var bodyY = (lum && lum.body && lum.body.position && isNum(lum.body.position.y))
      ? Math.abs(lum.body.position.y) : 0;
    var sceneH = (viewer.S && isNum(viewer.S.height_m)) ? viewer.S.height_m : 2.8;
    var H = bodyY > 0.2 ? (bodyY - 0.02) : (sceneH - 0.06);
    if (!isNum(H) || H <= 0.1) H = 1;
    return {
      H: H,
      geomH: H,
      posY: H / 2 + 0.02,
      adjustPos: true
    };
  }

  function findEntry(entries, cone) {
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].cone === cone) return entries[i];
    }
    return null;
  }

  /** 逐项恢复某次 apply 记录下来的场景原状 */
  function restoreEntries(entries) {
    var count = 0;
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      var cone = e.cone;
      if (cone) {
        if (e.origGeom) cone.geometry = e.origGeom;
        if (isNum(e.origPosY)) cone.position.y = e.origPosY;
        if (cone.material) {
          cone.material.map = e.origMap || null;
          cone.material.needsUpdate = true;
        }
      }
      if (e.pool) {
        if (isNum(e.origPoolX)) e.pool.scale.x = e.origPoolX;
        if (isNum(e.origPoolY)) e.pool.scale.y = e.origPoolY;
        // 能量归一可能压暗过地面光斑颜色，这里精确恢复
        if (e.origPoolColor && e.pool.material && e.pool.material.color) {
          e.pool.material.color.setRGB(
            e.origPoolColor.r, e.origPoolColor.g, e.origPoolColor.b
          );
        }
      }
      count++;
    }
    return count;
  }

  function disposeList(list) {
    if (!list) return;
    for (var i = 0; i < list.length; i++) disposeSafe(list[i]);
  }

  /** 还原并释放一次 apply 的全部资源；保留 entries 内的原始引用 */
  function releaseState(st) {
    if (!st) return 0;
    var n = restoreEntries(st.entries || []);
    disposeList(st.geoms);
    disposeList(st.textures);
    if (st.tex) disposeSafe(st.tex); // 兼容旧状态字段
    return n;
  }

  /**
   * 应用 IES 配光。
   * @param {Window} win iframe window（可省略，用 init 时绑定的）
   * @param {object} parsed parse() 的结果
   * @param {object} [opts] {
   *   pool:boolean 是否同步缩放落地光斑与光斑亮度（默认 true）;
   *   energyNorm:boolean 宽光束能量归一（默认 true）;
   *   energyExponent:number 归一软指数（默认 0.8，0=不压暗，1=严格面积守恒）;
   *   energyFactor:number 强制统一能量系数（调试/UI 用，0.04~1）;
   *   poolMaxGrowth:number 落地光斑相对原直径的最大放大倍数（默认 2.5）;
   *   radialSegments:number; filter:function(lum,i)
   * }
   * @returns {{applied:number, angleDeg:number, radius:number, skipped:number, energyNorm:boolean, factors:number[]}}
   */
  function apply(winArg, parsed, opts) {
    var win = winArg || _win;
    if (!win) win = discoverViewerWin(); // 调用方没传 win 且 init 未跑时的兜底
    if (!win) fail('场景未就绪：请先调用 init(win) 绑定 iframe 窗口');
    if (!_win) _win = win;
    var viewer = null;
    try { viewer = win.__viewer; } catch (e) { viewer = null; }
    if (!viewer) fail('场景未就绪：未找到 window.__viewer（demo.html 是否加载完成？）');
    if (!parsed || typeof parsed !== 'object') fail('IES 解析结果无效：请先调用 parse(text)');

    var half = Number(parsed.halfAngleDeg);
    if (!isNum(half) || half <= 0) fail('IES 解析结果缺少有效的半峰值角');
    if (half > MAX_HALF_ANGLE) half = MAX_HALF_ANGLE;
    if (half < MIN_HALF_ANGLE) half = MIN_HALF_ANGLE;

    var THREE = viewer.THREE;
    if (!THREE || typeof THREE.ConeGeometry !== 'function') {
      fail('场景缺少 THREE.ConeGeometry，无法重建光锥');
    }
    var lumList = viewer.lumList;
    if (!lumList || !lumList.length) {
      fail('场景中没有灯具（lumList 为空），无法应用 IES 配光');
    }

    opts = opts || {};
    var poolOn = opts.pool !== false;
    var segOverride = isInt(opts.radialSegments) ? opts.radialSegments : 0;
    var filter = typeof opts.filter === 'function' ? opts.filter : null;
    var energyNorm = opts.energyNorm !== false;
    var energyExp = isNum(opts.energyExponent)
      ? Math.max(0, Math.min(2, opts.energyExponent))
      : DEFAULT_ENERGY_EXPONENT;
    var energyOverride = isNum(opts.energyFactor)
      ? Math.max(MIN_ENERGY_FACTOR, Math.min(1, opts.energyFactor))
      : null;
    var poolMaxGrowth = (isNum(opts.poolMaxGrowth) && opts.poolMaxGrowth >= 1)
      ? opts.poolMaxGrowth
      : POOL_MAX_GROWTH;

    // 重复 apply / 切换窗口：先把上一次的自定义状态完全还原，保证幂等、不叠加
    var entries = [];
    if (_state) {
      var sameWin = _state.win === win;
      var oldEntries = _state.entries;
      releaseState(_state);
      if (sameWin) entries = oldEntries || [];
      _state = null;
    }

    var geomCache = {};
    var newGeoms = [];
    var texCache = {};
    var texList = [];
    var energySet = {};
    var energyFactors = [];
    var applied = 0;
    var skipped = 0;
    var radiusSum = 0;

    var tanHalf = Math.tan(half * RAD);

    /** 按能量系数取（或生成）共享渐变贴图 */
    var texFor = function (factor) {
      var tkey = factor.toFixed(3);
      var t = texCache[tkey];
      if (!t) {
        t = makeConeGradient(THREE, parsed, half, factor);
        texCache[tkey] = t;
        texList.push(t);
        if (!energySet[tkey]) {
          energySet[tkey] = true;
          energyFactors.push(round3(factor));
        }
      }
      return t;
    };

    try {
      for (var i = 0; i < lumList.length; i++) {
        var lum = lumList[i];
        if (filter && !filter(lum, i)) continue;
        var cone = resolveCone(viewer, lum);
        if (!cone) { skipped++; continue; }

        var metrics = coneMetrics(viewer, cone, lum);
        var R = metrics.H * tanHalf;
        if (!isNum(R) || R <= 0.01) R = 0.01;
        if (R > 500) R = 500; // 异常数据防护（正常住宅场景不会触发）

        var segs = segOverride;
        if (!segs) {
          var gp = cone.geometry && cone.geometry.parameters;
          segs = (gp && isInt(gp.radialSegments)) ? gp.radialSegments : 28;
        }
        if (segs < 8) segs = 8;

        var key = round3(R) + '|' + round3(metrics.geomH) + '|' + segs;
        var geom = geomCache[key];
        if (!geom) {
          geom = new THREE.ConeGeometry(R, metrics.geomH, segs, 1, true); // 开口锥
          geomCache[key] = geom;
          newGeoms.push(geom);
        }

        // —— 能量归一 ——
        // 光锥是加色透明面，视觉能量 ≈ 侧面积 ∝ sinθ / cos²θ。
        // 以每盏灯“原锥”的侧面积为基准，宽光束按面积比压暗（只压不升），
        // 锥角形状完全不变，避免 45 盏宽束叠加把整屋洗白。
        var gpOrig = cone.geometry && cone.geometry.parameters;
        var origHalfRad = (gpOrig && isNum(gpOrig.radius) && isNum(gpOrig.height) && gpOrig.height > 0.05)
          ? Math.atan(gpOrig.radius / gpOrig.height)
          : (12 * RAD);
        var energyFactor = 1;
        if (energyOverride != null) {
          energyFactor = energyOverride;
        } else if (energyNorm) {
          var cosO = Math.cos(origHalfRad);
          var cosN = Math.cos(half * RAD);
          var areaO = Math.sin(origHalfRad) / (cosO * cosO);
          var areaN = Math.sin(half * RAD) / (cosN * cosN);
          if (areaN > 1e-6) {
            var er = areaO / areaN;
            if (er < 1) energyFactor = Math.pow(er, energyExp);
          }
          if (!isNum(energyFactor) || energyFactor < MIN_ENERGY_FACTOR) energyFactor = MIN_ENERGY_FACTOR;
          if (energyFactor > 1) energyFactor = 1;
        }
        var tex = texFor(energyFactor);

        // 第一次碰到这盏灯时记录原状（几何体对象、贴图、光斑尺寸/颜色、y 位置）
        var entry = findEntry(entries, cone);
        if (!entry) {
          entry = {
            cone: cone,
            lum: lum,
            origGeom: cone.geometry,
            origPosY: cone.position.y,
            origMap: cone.material ? cone.material.map : null,
            pool: (lum && lum.pool) ? lum.pool : null,
            origPoolX: (lum && lum.pool) ? lum.pool.scale.x : null,
            origPoolY: (lum && lum.pool) ? lum.pool.scale.y : null,
            origPoolColor: (lum && lum.pool && lum.pool.material && lum.pool.material.color)
              ? {
                r: lum.pool.material.color.r,
                g: lum.pool.material.color.g,
                b: lum.pool.material.color.b
              }
              : null
          };
          entries.push(entry);
        }

        cone.geometry = geom;
        if (metrics.adjustPos && isNum(metrics.posY)) cone.position.y = metrics.posY;

        if (cone.material) {
          cone.material.map = tex;          // 保留原材质（AdditiveBlending / transparent / 颜色）
          cone.material.needsUpdate = true;
        }

        if (poolOn && lum && lum.pool) {
          // 落地光斑是 PlaneGeometry(1,1)，scale 即直径 → 物理直径 = 2R。
          // 宽光束时直径会远超房间尺度（wide 57° 达 8.4m，45 个加色叠加必白），
          // 因此按“原光斑直径 × POOL_MAX_GROWTH”封顶，再按能量系数压暗颜色。
          var poolD = R * 2;
          if (isNum(entry.origPoolX) && poolD > entry.origPoolX * poolMaxGrowth) {
            poolD = entry.origPoolX * poolMaxGrowth;
          }
          lum.pool.scale.x = poolD;
          lum.pool.scale.y = poolD;
          // 光斑同样是加色面，按同一能量系数压暗（恢复时用 entry.origPoolColor 精确还原）
          if (energyFactor < 0.999 && entry.origPoolColor && lum.pool.material && lum.pool.material.color) {
            var pc = lum.pool.material.color;
            pc.setRGB(
              entry.origPoolColor.r * energyFactor,
              entry.origPoolColor.g * energyFactor,
              entry.origPoolColor.b * energyFactor
            );
          }
        }

        applied++;
        radiusSum += R;
      }
    } catch (e) {
      // 中途异常：把已改动的灯全部还原，避免场景停在半应用状态
      restoreEntries(entries);
      disposeList(newGeoms);
      disposeList(texList);
      _state = null;
      throw new Error('应用 IES 配光失败：' + (e && e.message ? e.message : e));
    }

    if (applied === 0) {
      disposeList(texList);
      disposeList(newGeoms);
      fail('场景中没有可应用的灯具：lumList 里的灯找不到对应光锥');
    }

    _state = {
      win: win,
      entries: entries,
      geoms: newGeoms,
      textures: texList,
      angleDeg: half,
      radius: round3(radiusSum / applied),
      applied: applied,
      skipped: skipped,
      energyNorm: energyNorm,
      energyExponent: energyExp,
      energyFactors: energyFactors,
      appliedAt: Date.now(),
      version: VERSION
    };

    if (skipped > 0) {
      notify('IES 已应用 ' + applied + ' 盏灯，' + skipped + ' 盏未找到光锥', 'warn');
    } else {
      notify('IES 已应用：半峰值 ' + half.toFixed(1) + '° · ' + applied + ' 盏灯', 'ok');
    }

    return {
      applied: applied,
      angleDeg: half,
      radius: _state.radius,
      skipped: skipped,
      energyNorm: energyNorm,
      factors: energyFactors
    };
  }

  /**
   * 还原默认光锥（移除自定义锥/贴图/光斑尺寸）。
   * @param {Window} [winArg]
   * @returns {{restored:number}}
   */
  function clear(winArg) {
    if (!_state) return { restored: 0 };
    var st = _state;
    _state = null;
    var n = releaseState(st);
    notify('已还原默认光锥', '');
    return { restored: n };
  }

  /** 绑定 iframe window（必须在场景 __ready 后调用） */
  function init(win, opts) {
    if (!win) {
      _win = null;
      return api;
    }
    if (_state && _state.win && _state.win !== win) {
      // 换窗口：还原旧场景，避免旧 iframe 残留自定义锥
      try { releaseState(_state); } catch (e) { /* 忽略 */ }
      _state = null;
    }
    _win = win;
    _opts = opts || {};
    return api;
  }

  /** 当前应用状态快照（调试/测试用） */
  function getState() {
    if (!_state) return null;
    return {
      angleDeg: _state.angleDeg,
      applied: _state.applied,
      skipped: _state.skipped,
      radius: _state.radius,
      lights: _state.entries.length,
      energyNorm: _state.energyNorm,
      energyFactors: _state.energyFactors,
      appliedAt: _state.appliedAt,
      version: _state.version
    };
  }

  var api = {
    version: VERSION,
    init: init,
    parse: parse,
    apply: apply,
    clear: clear,
    getState: getState,
    // 只读常量，便于测试/UI 展示
    MAX_HALF_ANGLE: MAX_HALF_ANGLE,
    MIN_HALF_ANGLE: MIN_HALF_ANGLE
  };

  global.GVIes = api;
})(typeof window !== 'undefined' ? window : this);
