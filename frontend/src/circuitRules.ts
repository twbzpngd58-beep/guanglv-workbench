/**
 * R5 回路检查（统筹批准方案）：混用调光方式、超 D3 默认上限、有灯没分回路、无线回路跨空间。
 * 后端 backend/circuit_rules.py 是同一套规则的另一份实现；提示原文只有一份，在
 * ./data/circuit-rules-text.json，两边都从那里读。tests/fixtures/circuit_rules_cases.json 只核条数和原文一致。
 * 放不放行以后端 export_gate 为准，这里只负责显示。
 *
 * D3 默认上限：继电器（开关控制）≤12 驱动、≤300W；DALI ≤55 地址。每盏灯算 1 个驱动，灯带按独立电源个数算。
 * 可控硅和 DALI 组数这一单不判。开闭、总线（DALI、KNX）跨空间不拦不提示，只有无线跨空间算问题。
 */
import TEXT from "./data/circuit-rules-text.json" with { type: "json" };

type Obj = Record<string, any>;

/** 取共享原文并按名替换占位。 */
function t(key: keyof typeof TEXT, vars: Record<string, string | number> = {}): string {
  let s = TEXT[key];
  for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

export const WIRELESS = ["Zigbee", "Wi-Fi", "蓝牙 Mesh"];
export const RELAY_MAX_DRIVERS = 12;
export const RELAY_MAX_WATTS = 300;
export const DALI_MAX_ADDRESSES = 55;
export const UNASSIGNED = TEXT.unassigned;
/** 拦截档：施工包（zip、dxf、pdf、xlsx、docx）+ 厂家包（panels）+ 订货单（order，S9a 再接入口）。 */
export const BLOCKED_EXPORTS = ["zip", "dxf", "pdf", "xlsx", "docx", "panels", "order"];

/** 数字统一写法：最多 1 位小数，去掉多余的 0（后端 num 同口径）。 */
export function num(v: unknown): string {
  const r = Math.round((Number(v) || 0) * 10 + 1e-7) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

const str = (v: unknown) => String(v ?? "").trim();

function circuitKey(f: Obj): string {
  const c = str(f.circuit);
  // 同步图纸时没归属的灯写成「未归属」/「未归属·D50」，导出侧老写法是「未分配」。
  return !c || c.startsWith("未归属") || c.startsWith("未分配") ? UNASSIGNED : c;
}

function roomOf(f: Obj, rooms: Map<string, string>): string {
  return f.space || rooms.get(f.roomId) || TEXT.unassignedRoom;
}

/** 按回路编号分组（只算灯，窗帘不算），保留出现顺序。 */
export function groups(design: Obj): Map<string, Obj[]> {
  const out = new Map<string, Obj[]>();
  for (const f of design.fixtures || []) {
    if (f.type === "窗帘") continue;
    const k = circuitKey(f);
    if (!out.has(k)) out.set(k, []);
    out.get(k)!.push(f);
  }
  return out;
}

/** 驱动个数：普通灯 1 盏 = 1 个；灯带按独立电源编号去重（没填电源的每段各算 1 个）。 */
export function drivers(members: Obj[]): number {
  const supplies = new Set<string>();
  let n = 0;
  for (const f of members) {
    const ps = str(f.powerSupply);
    if (f.type === "灯带" && ps) supplies.add(ps);
    else n += 1;
  }
  return n + supplies.size;
}

export const watts = (members: Obj[]) =>
  members.reduce((a, f) => a + (Number(f.power) || 0), 0);

export function controls(members: Obj[]): string[] {
  return [...new Set(members.map((f) => str(f.control)).filter(Boolean))];
}

/** 「按回路看」读数，例如「驱动 9/12、功率 260/300W（按 D3 默认上限）」。 */
export function reading(members: Obj[]): string {
  const ctrls = controls(members);
  const n = drivers(members);
  const w = watts(members);
  if (ctrls.length === 1 && ctrls[0] === "开关控制")
    return t("readingRelay", {
      n,
      maxDrivers: RELAY_MAX_DRIVERS,
      w: num(w),
      maxWatts: RELAY_MAX_WATTS,
      d3Note: TEXT.d3Note,
    });
  if (ctrls.length === 1 && ctrls[0] === "DALI")
    return t("readingDali", {
      n,
      maxAddresses: DALI_MAX_ADDRESSES,
      w: num(w),
      d3Note: TEXT.d3Note,
      daliNote: TEXT.daliNote,
    });
  return t("readingOther", { n, w: num(w) });
}

function overD3(members: Obj[]): boolean {
  const ctrls = controls(members);
  if (ctrls.length !== 1) return false;
  const n = drivers(members);
  if (ctrls[0] === "开关控制") return n > RELAY_MAX_DRIVERS || watts(members) > RELAY_MAX_WATTS;
  if (ctrls[0] === "DALI") return n > DALI_MAX_ADDRESSES;
  return false;
}

function roomCounts(members: Obj[], rooms: Map<string, string>): Map<string, number> {
  const out = new Map<string, number>();
  for (const f of members) {
    const r = roomOf(f, rooms);
    out.set(r, (out.get(r) || 0) + 1);
  }
  return out;
}

export type CircuitIssue = { circuit: string; text: string; fixtureIds: string[] };

/** 红色问题，逐条一句话（红色提示、导出拦截说明都用这句原文）。 */
export function circuitIssues(design: Obj): CircuitIssue[] {
  const rooms = new Map<string, string>((design.rooms || []).map((r: Obj) => [r.id, r.name]));
  const out: CircuitIssue[] = [];
  const all = groups(design);
  all.forEach((members, key) => {
    if (key === UNASSIGNED) return;
    const ids = members.map((f) => f.id);
    const ctrls = controls(members);
    if (ctrls.length > 1)
      out.push({ circuit: key, fixtureIds: ids, text: t("mixed", { circuit: key, controls: ctrls.join(TEXT.listSep) }) });
    if (overD3(members))
      out.push({ circuit: key, fixtureIds: ids, text: t("overD3", { circuit: key, reading: reading(members) }) });
    const counts = roomCounts(members, rooms);
    const wl = ctrls.filter((c) => WIRELESS.includes(c));
    if (wl.length && counts.size > 1) {
      const detail = [...counts].map(([room, n]) => t("wirelessCrossItem", { room, n })).join(TEXT.listSep);
      out.push({
        circuit: key,
        fixtureIds: ids,
        text: t("wirelessCross", { circuit: key, controls: wl.join(TEXT.listSep), n: counts.size, detail }),
      });
    }
  });
  const loose = all.get(UNASSIGNED) || [];
  roomCounts(loose, rooms).forEach((n, r) => {
    out.push({
      circuit: UNASSIGNED,
      fixtureIds: loose.filter((f) => roomOf(f, rooms) === r).map((f) => f.id),
      text: t("unassignedLamps", { room: r, n }),
    });
  });
  return out;
}

export const blockMessage = (items: string[]) =>
  t("block", { n: items.length, items: items.join(TEXT.issueSep) });

export type GatewayDup = { gateway: string; kind: "通道" | "地址"; value: string; codes: string[] };

/**
 * 按网关看：同一模块/网关下重复的通道或地址，逐组列出（造 2 条正好标 2 条）。
 * 总线（DALI、KNX）一条通道挂多盏是正常的，按「通道 + 地址」查地址重复；
 * 开关、0–10V、PWM 一路一个，查通道重复；无线地址调试时分配，不查。
 */
export function gatewayDuplicates(design: Obj): GatewayDup[] {
  const seen = new Map<string, { gateway: string; kind: "通道" | "地址"; value: string; fs: Obj[] }>();
  for (const f of design.fixtures || []) {
    if (f.type === "窗帘") continue;
    const gw = str(f.controller);
    const ctrl = str(f.control);
    const ch = str(f.channel);
    const addr = str(f.address);
    let kind: "通道" | "地址";
    let value: string;
    if (!gw) continue;
    if (ctrl === "DALI" || ctrl === "KNX") {
      if (!addr || addr === "—") continue;
      kind = "地址";
      value = ch ? `${ch}/${addr}` : addr;
    } else if (["开关控制", "0–10V", "0-10V", "PWM"].includes(ctrl)) {
      if (!ch) continue;
      kind = "通道";
      value = ch;
    } else continue;
    const k = [gw, kind, value].join("\u0000");
    if (!seen.has(k)) seen.set(k, { gateway: gw, kind, value, fs: [] });
    seen.get(k)!.fs.push(f);
  }
  return [...seen.values()]
    .filter((x) => x.fs.length > 1)
    .map((x) => ({ gateway: x.gateway, kind: x.kind, value: x.value, codes: x.fs.map((f) => f.code || f.id) }));
}
