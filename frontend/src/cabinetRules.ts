/**
 * 电箱占位与接线规则（纯函数，无 JSX）。
 *
 * 为什么要单独一层：画布上的「电箱」原本只是一个把自动生成设备收在一起画的符号，
 * 点它只能选中箱里第一台设备——看不出这些设备在配电箱里到底占多少位、怎么接线。
 * 现场选型与箱体报价要的正是这两件事：导轨占位（会不会排不下）与总线接线（谁给谁供电、谁控谁）。
 *
 * 口径（2026-11-05 拍板）：
 * - 导轨基准＝单条 22.5P（405mm），用满换第二条；1P＝18mm（一个标准模数极）。
 * - 位数只认知识库产品库的「规格尺寸 / 安装方式」，逐型号抽取在 data/cabinet-modules.json
 *   （由 scripts/cabinet_modules_from_vault.mjs 生成，改产品库后重跑）。表里没有的型号一律标
 *   「位数待填」，不计入占位——猜位数会让现场排不下，宁可少算并显式提醒。
 * - 装位分三类：rail＝强电箱导轨；weak＝弱电箱（网桥、云主机等网络侧）；out/wall＝不在箱内
 *   （感应器在天花、驱动器在吊顶、面板在 86 底盒），物理上就不该画进配电箱。
 */
import TABLE from "./data/cabinet-modules.json";
import { BRIDGE_CAP, isBridgeLamp } from "./busBridge";
import { containsPoint, interiorPoint } from "./spaceGeometry";

type Obj = Record<string, any>;

export type Mount = "rail" | "weak" | "out" | "wall" | "unknown";

export const MM_PER_P: number = Number(TABLE.mmPerP) || 18;
export const RAIL_P: number = Number(TABLE.railP) || 22.5;
export const RAIL_MM = RAIL_P * MM_PER_P;

const MODELS: Record<string, any> = { ...(TABLE.models as any), ...(TABLE.manual as any) };

/** 型号查不到时的归类兜底：按设备类型判，宁可标「判」也不留空。 */
const TYPE_MOUNT: Record<string, Mount> = {
  电源: "rail",
  执行器: "rail",
  调光执行器: "rail",
  耦合器: "rail",
  网关: "weak",
  主机: "weak",
  网桥: "weak",
  控制器: "out",
  传感器: "out",
  面板: "wall",
  温控器: "wall",
  遥控器: "wall",
};

export type ModInfo = {
  model: string;
  name: string;
  p: number | null;
  mm: number | null;
  mount: Mount;
  mountInferred: boolean;
  pInferred: boolean;
  basis: string;
  known: boolean;
  /** 外观图文件名（data/cabinet-img/ 下，知识库配图索引来的）；没有就画通用模块样子 */
  img?: string;
};

export function lookupModel(model?: string, devType?: string): ModInfo {
  const key = String(model || "").trim();
  const hit = key ? MODELS[key] : null;
  if (hit) {
    return {
      model: key || hit.name,
      name: hit.name || key,
      p: Number.isFinite(hit.p) ? Number(hit.p) : null,
      mm: Number.isFinite(hit.mm) ? Number(hit.mm) : null,
      mount: (hit.mount || "unknown") as Mount,
      mountInferred: !!hit.mountInferred,
      pInferred: !!(hit.mount === "rail" && hit.mountInferred),
      basis: hit.basis || "",
      known: true,
      img: hit.img || undefined,
    };
  }
  const mount = TYPE_MOUNT[String(devType || "").trim()] || "unknown";
  return {
    model: key || "（无型号）",
    name: key ? key : String(devType || "设备"),
    p: null,
    mm: null,
    mount,
    mountInferred: true,
    pInferred: false,
    basis: key
      ? `型号 ${key} 不在知识库位数表内`
      : `未填型号，按设备类型「${devType || "—"}」判装位`,
    known: false,
  };
}

export type BoxItem = { dev: Obj; info: ModInfo };

/** 电箱里到底放谁：自动生成系统架构那批行（没房间也没坐标）就是箱内候选。 */
export function isCabinetDevice(dev: Obj): boolean {
  return !!dev && (dev.source === "auto-arch" || (dev.x == null && dev.y == null && !dev.roomId));
}

export function cabinetDevices(design: Obj): Obj[] {
  return (design?.devices || []).filter(isCabinetDevice);
}

export type Rail = { index: number; slots: { item: BoxItem; atP: number }[]; usedP: number; over: boolean };

export type CabinetView = {
  /** 强电箱：导轨排版结果 */
  strong: {
    rails: Rail[];
    /** 导轨设备但位数待填：不进轨、单独列，避免占位数骗人 */
    pending: BoxItem[];
    railCount: number;
    usedP: number;
    capacityP: number;
    /** 最后一条轨还剩几位（换算 mm 用 mmFree） */
    freeP: number;
    mmUsed: number;
    mmFree: number;
    total: number;
  };
  /** 弱电箱：网桥 / 云主机等网络侧 */
  weak: BoxItem[];
  /** 不在箱内：感应器在天花、驱动器在吊顶、面板在底盒 */
  outside: BoxItem[];
  items: BoxItem[];
};

export function cabinetView(design: Obj): CabinetView {
  const items: BoxItem[] = cabinetDevices(design).map((dev) => ({ dev, info: lookupModel(dev.model, dev.type) }));

  const railItems: BoxItem[] = [];
  const weak: BoxItem[] = [];
  const outside: BoxItem[] = [];
  const pending: BoxItem[] = [];
  for (const it of items) {
    if (it.info.mount === "rail") {
      if (it.info.p == null) pending.push(it);
      else railItems.push(it);
    } else if (it.info.mount === "weak") weak.push(it);
    else if (it.info.mount === "unknown") pending.push(it);
    else outside.push(it);
  }

  // 单条 22.5P 用满换第二条；单台比一条轨还宽 → 独占一轨并标超限（不把它裁掉）。
  const rails: Rail[] = [{ index: 0, slots: [], usedP: 0, over: false }];
  for (const it of railItems) {
    const p = it.info.p as number;
    let cur = rails[rails.length - 1];
    if (cur.slots.length && cur.usedP + p > RAIL_P + 1e-6) {
      cur = { index: rails.length, slots: [], usedP: 0, over: false };
      rails.push(cur);
    }
    cur.slots.push({ item: it, atP: cur.usedP });
    cur.usedP = Math.round((cur.usedP + p) * 100) / 100;
    if (p > RAIL_P + 1e-6) cur.over = true;
  }

  const usedP = rails.reduce((a, r) => a + r.usedP, 0);
  const capacityP = rails.length * RAIL_P;
  const freeP = Math.round((capacityP - usedP) * 100) / 100;
  return {
    strong: {
      rails,
      pending,
      railCount: rails.length,
      usedP,
      capacityP,
      freeP: Math.round((RAIL_P - rails[rails.length - 1].usedP) * 100) / 100,
      mmUsed: Math.round(usedP * MM_PER_P),
      mmFree: Math.round(freeP * MM_PER_P),
      total: railItems.length + pending.length,
    },
    weak,
    outside,
    items,
  };
}

/** 箱体常落位（与画布上电箱锚点同一判据，右边栏只取名字显示，不再各写一份正则）。 */
export function cabinetRoom(design: Obj, floor: number): Obj | null {
  const roomsOnFloor = (design?.rooms || []).filter(
    (r: Obj) => (Number.isFinite(r.floor) ? Number(r.floor) : 1) === floor,
  );
  return (
    roomsOnFloor.find((r: Obj) =>
      /玄关|门厅|入户|储藏|设备间|配电|过道|走廊|楼梯/.test(String(r.name || "")),
    ) || null
  );
}

/** 电箱落位。配电箱台账（D8-2）要的是「房间＋坐标」：符号飘在所有空间之外等于没位置，
 *  清单与交底都读不出来，所以一间都没命中时不许落在空间外——取离本层左上角最近的
 *  真实空间内部点并标 tentative，与「位数待填」「（判）」同一口径：宁可推断并写明待确认。 */
export function cabinetAnchor(design: Obj, floor: number): { x: number; y: number; room: Obj; tentative: boolean } | null {
  const rooms = ((design?.rooms || []) as Obj[]).filter(
    (r: Obj) => (Number.isFinite(r.floor) ? Number(r.floor) : 1) === floor && (r.points || []).length >= 3,
  );
  if (!rooms.length) return null;
  const pref = cabinetRoom(design, floor);
  const hit = pref && (pref.points || []).length >= 3 ? pref : null;
  if (hit) return { ...interiorPoint(hit), room: hit, tentative: false };
  const corner = {
    x: Math.min(...rooms.map((r: Obj) => Number(r.x) || 0)) + 46,
    y: Math.min(...rooms.map((r: Obj) => Number(r.y) || 0)) + 34,
  };
  let best = rooms[0];
  let bestD = Infinity;
  for (const r of rooms) {
    const p = interiorPoint(r);
    const dd = (p.x - corner.x) ** 2 + (p.y - corner.y) ** 2;
    if (dd < bestD) {
      bestD = dd;
      best = r;
    }
  }
  return { ...interiorPoint(best), room: best, tentative: true };
}

/** 箱体落位的一句话说明：画布符号的 tooltip 与右边栏「所在空间」共用，两边不许各写一份。 */
export function cabinetAnchorLabel(design: Obj, floor: number): string {
  const a = cabinetAnchor(design, floor);
  if (!a) return "";
  return `${a.room.name || "未命名空间"}${a.tentative ? "·所在空间待确认" : ""}`;
}

export type CabSpot = "strong" | "weak" | "outside";

// 符号半宽（画布单位）：弱电箱以前固定往右挪 56，0图层2 实测整号飘到储藏间外面——
// 箱体是设备的「位置」本身，落隔壁房间等于又造出一批界外对象，所以按真实边界逐个试位。
const CAB_HW: Record<CabSpot, number> = { strong: 23, weak: 23, outside: 30 };
const CAB_TRIES: [number, number][] = [
  [0, 0], [56, 0], [-62, 0], [0, 30], [0, -30], [112, 0], [-124, 0], [56, 30], [-62, -30],
];

/** 三个箱体符号在锚点空间内的落位：先要整号放得下，再要不叠在一起；都放不下才退回锚点。 */
export function cabinetSpots(
  design: Obj,
  floor: number,
): Record<CabSpot, { x: number; y: number }> | null {
  const a = cabinetAnchor(design, floor);
  if (!a) return null;
  const room = a.room;
  const spots = {} as Record<CabSpot, { x: number; y: number }>;
  const used: { x: number; y: number }[] = [];
  for (const spot of ["strong", "weak", "outside"] as CabSpot[]) {
    const hw = CAB_HW[spot];
    const at = (dx: number, dy: number) => ({ x: a.x + dx, y: a.y + dy });
    const free = (p: { x: number; y: number }) =>
      used.every((u) => Math.abs(u.x - p.x) > hw * 2 || Math.abs(u.y - p.y) > 24);
    const whole = (p: { x: number; y: number }) =>
      containsPoint(room, p.x, p.y) && containsPoint(room, p.x - hw, p.y) && containsPoint(room, p.x + hw, p.y);
    const pick =
      CAB_TRIES.map(([dx, dy]) => at(dx, dy)).find((p) => whole(p) && free(p)) ||
      CAB_TRIES.map(([dx, dy]) => at(dx, dy)).find((p) => containsPoint(room, p.x, p.y) && free(p)) ||
      { x: a.x, y: a.y };
    spots[spot] = pick;
    used.push(pick);
  }
  return spots;
}

/** 箱内设备在清单/界面上的「所属」：箱名＋箱所在空间。导轨件在强电箱，网桥与云主机在弱电箱；
 *  驱动器在吊顶、面板在 86 底盒，这两类本来就不靠箱，也不该写箱名。 */
export function boxLabel(design: Obj, dev: Obj): string {
  const mount = lookupModel(dev?.model, dev?.type).mount;
  if (mount === "out") return "吊顶内（不在配电箱）";
  if (mount === "wall") return "86 底盒（墙面）";
  const box = mount === "weak" ? "弱电箱" : "强电箱";
  const room = cabinetRoom(design, Number.isFinite(dev?.floor) ? dev.floor : 1);
  return room ? `${box}（${room.name || "未命名空间"}）` : `${box}（所在空间待确认）`;
}

// ---- 总线接线模型：全部由设计里现有数据算，不另存一份接线表 ----
export type Via = "mains" | "knx" | "wireless" | "dali" | "lan" | "load";
export type WireRow = {
  id: string;
  from: string;
  to: string;
  via: Via;
  /** 线上标注（电流、台数、通道等） */
  note: string;
  /** 关联到箱内哪台设备（点设备行时高亮用） */
  devId?: string;
};

export type Wiring = { rows: WireRow[]; summary: { busMa: number; capMa: number; lamps: number } };

const MA = { panel: 10, sensor: 10, ip: 10, daliGateway: 12, ps: 640 };
const DALI_CTRL = "DALI";
const isDali = (f: Obj) => String(f?.control || "").trim() === DALI_CTRL;
const isOnOff = (f: Obj) => !isBridgeLamp(f) && !isDali(f);

/** 接线图：市电→电源→KNX 主干→各设备→下游负载；网络侧走局域网；无线灯走网桥。 */
export function busWiring(design: Obj, project: Obj, view: CabinetView): Wiring {
  const rows: WireRow[] = [];
  const fixtures: Obj[] = (design?.fixtures || []).filter((f: Obj) => f.type !== "窗帘");
  const devices: Obj[] = design?.devices || [];
  const smart = String(project?.smart || "").trim();
  const find = (type: string, kw?: RegExp) =>
    view.items.map((v) => v.dev).find((d) => d.type === type && (!kw || kw.test(`${d.name || ""}${d.model || ""}`)));

  const psUnits = view.items.filter((v) => v.dev.type === "电源").length;
  const capMa = psUnits * MA.ps;
  // 总线电流按挂总线的台数算（与「自动建立系统架构」同一组常数），面板/传感器都在墙上不在箱里，
  // 但取电走同一条总线，占位与供电都得一起核。
  const busMa =
    devices.filter((d) => d.type === "面板").length * MA.panel +
    devices.filter((d) => d.type === "传感器").length * MA.sensor +
    (find("网关", /IP|接口/i) ? MA.ip : 0) +
    view.items.filter((v) => /DALI/i.test(`${v.dev.name || ""}${v.dev.model || ""}`) && v.dev.type === "网关").length * MA.daliGateway;

  rows.push({ id: "mains", from: "220V 市电", to: "强电箱（配电箱进线）", via: "mains", note: `导轨设备 ${view.strong.rails.reduce((a, r) => a + r.slots.length, 0)} 台` });

  if (smart === "KNX") {
    rows.push({
      id: "bus", from: "KNX 电源", to: "KNX 总线（红/黑 · 30V DC）", via: "knx",
      note: `实测 ${busMa}mA / 供电 ${capMa || "未配"}mA`, devId: find("电源")?.id,
    });
    for (const r of view.strong.rails) {
      for (const s of r.slots) {
        if (s.item.dev.type === "电源") continue;
        rows.push({
          id: "tap" + s.item.dev.id, from: "KNX 总线", to: `${s.item.dev.name || s.item.dev.type} · 第 ${r.index + 1} 轨`,
          via: "knx", note: `${s.item.info.p ?? "待填"}P`, devId: s.item.dev.id,
        });
      }
    }
    const panels = devices.filter((d) => d.type === "面板").length;
    if (panels)
      rows.push({ id: "panel", from: "KNX 总线", to: `总线面板 × ${panels}`, via: "knx", note: `墙上 86 底盒 · 每台取电 ${MA.panel}mA` });
    const sensors = devices.filter((d) => d.type === "传感器").length;
    if (sensors)
      rows.push({ id: "sensor", from: "KNX 总线", to: `传感器 × ${sensors}`, via: "knx", note: `吸顶/吊顶 · 每台 ${MA.sensor}mA（不在配电箱内）` });
  }

  // 执行器 → 回路（按灯具的 circuit 归集，几盏灯、多少瓦直接读灯具）
  for (const d of view.items.filter((v) => /执行器/.test(String(v.dev.type || "")))) {
    const circuits = new Map<string, { n: number; w: number }>();
    for (const f of fixtures.filter(isOnOff)) {
      const c = String(f.circuit || "").trim() || "未分回路";
      const e = circuits.get(c) || { n: 0, w: 0 };
      e.n += 1;
      e.w += Number(f.power || f.watt || 0);
      circuits.set(c, e);
    }
    const list = [...circuits.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const ch = channels(d.dev);
    rows.push({
      id: "act" + d.dev.id,
      from: d.dev.name || "执行器",
      to: list.length ? `回路 ${list.map(([c]) => c).join(" / ")}` : "无开闭回路",
      via: "load",
      note: list.length
        ? `${list.length} 路 · ${list.map(([c, v]) => `${c} ${v.n}盏${v.w ? " " + Math.round(v.w) + "W" : ""}`).join("、")}` +
          (ch ? ` · 通道用 ${list.length}/${ch}` : "")
        : "开闭灯具都在网桥或 DALI 上，这台执行器空出通道",
      devId: d.dev.id,
    });
  }

  // DALI：网关 → DALI 线路（按通道）
  const daliLamps = fixtures.filter(isDali);
  const daliGw = view.items.filter((v) => /DK2|DALI/i.test(`${v.dev.model || ""}${v.dev.name || ""}`) && v.dev.type === "网关");
  rows.push({
    id: "dali", from: daliGw.length ? "KNX-DALI 网关" : "DALI 网关（未配）", to: `DALI 灯具 × ${daliLamps.length}`,
    via: "dali",
    note: daliLamps.length
      ? `两芯极性不限 · 每通道 64 地址（通道 ${[...new Set(daliLamps.map((f) => String(f.channel || "")).filter(Boolean))].join("、") || "未填"}`
      : "本项目没有 DALI 灯具，不需要 DALI 网关",
    devId: daliGw[0]?.dev.id,
  });

  // 无线侧：Hue 网桥 / 蓝牙网桥 / 无线中枢
  const bridgeLamps = fixtures.filter(isBridgeLamp);
  for (const b of view.items.filter((v) => v.dev.type === "网桥" || v.dev.type === "网关")) {
    if (!/Hue|蓝牙|BLE|Mesh|无线|中枢/i.test(`${b.dev.name || ""}${b.dev.model || ""}${b.dev.protocol || ""}`)) continue;
    rows.push({
      id: "wl" + b.dev.id, from: b.dev.name || "网桥", to: `WiZ/Hue 灯 × ${bridgeLamps.length}`, via: "wireless",
      note: bridgeLamps.length ? `单灯单控 · 不分回路 · 每台上限 ${BRIDGE_CAP}` : "无无线灯具",
      devId: b.dev.id,
    });
  }
  if (smart === "无线") {
    const wireless = fixtures.filter((f) => !isOnOff(f));
    rows.push({ id: "mesh", from: "无线中枢 / 网关", to: `无线灯具 × ${wireless.length}`, via: "wireless", note: "蓝牙 Mesh / Zigbee，中枢放弱电箱" });
  }

  // 网络侧：IP 接口 ⇄ 局域网 ⇄ 云主机 / App
  const ip = find("网关", /IP|接口/i);
  const hosts = view.weak.filter((v) => v.dev.type === "主机" || v.dev.type === "网桥");
  if (ip)
    rows.push({ id: "lan1", from: "KNX IP 接口", to: "局域网 / 路由器", via: "lan", note: "ETS 现场调试走这条", devId: ip.id });
  for (const h of hosts)
    rows.push({
      id: "lan2" + h.dev.id, from: "局域网 / 路由器", to: h.dev.name || "主机", via: "lan",
      note: "弱电箱内 · App / 云端入口", devId: h.dev.id,
    });

  return { rows, summary: { busMa, capMa, lamps: fixtures.length } };
}

/** 执行器通道数从型号/名称里取（SC-SK2-20R16A＝20 路、导轨式 28 路＝28），查不到就不报「用 x/y」。 */
function channels(dev: Obj): number | null {
  const m = `${dev.model || ""} ${dev.name || ""}`.match(/(\d+)\s*(?:路|R(?=\d*A)|-R)/i);
  return m ? Number(m[1]) : null;
}
export type Occupancy = {
  usedP: number;
  capacityP: number;
  railCount: number;
  freeP: number;
  percent: number;
  pendingCount: number;
};

export function occupancy(view: CabinetView): Occupancy {
  const s = view.strong;
  return {
    usedP: s.usedP,
    capacityP: s.capacityP,
    railCount: s.railCount,
    freeP: s.freeP,
    percent: s.capacityP ? Math.round((s.usedP / s.capacityP) * 100) : 0,
    pendingCount: s.pending.length,
  };
}
