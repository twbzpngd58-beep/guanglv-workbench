/**
 * 系统架构自动生成：按项目智能方案（KNX / 无线 / 无）出设备清单，并给「需求 vs 生成」核对表。
 *
 * 为什么单独一个文件：原来在 Workspace.tsx 里写死的三行（DALI 智能网关 DG-16 / 每空间一台空型号面板 /
 * 灯带控制器去重）不看项目数据、不从产品库选型、无智能也照生成，交付导出直接读这份 devices，
 * 于是「设备清单不准确、缺东西」。口径与型号一律从这里出，UI 只负责展示与调用。
 *
 * 型号来源：世聪 KNX 体系产品清单（知识库 15-产品库/CITRON世聪智能）+ 光律 products 表。
 * 规则来源：knx-quotation-audit / smart-lighting-architecture-audit（KNX 必检项）。
 */

type Obj = Record<string, any>;

export type ArchDevice = {
  name: string;
  type: string;
  model: string;
  roomId: string;
  protocol: string;
  notes: string;
  qty: number;
};

export type ArchCheck = {
  item: string;      // 品类
  need: string;      // 需求（按项目数据算出来的）
  made: string;      // 生成
  ok: boolean;
  note?: string;
};

export type ArchPlan = {
  topology: string;
  devices: ArchDevice[];
  checks: ArchCheck[];
  warnings: string[];
};

// ---- 常量：型号与容量（不写价格；价格在报价环节按产品库取）----
const DALI_PER_GATEWAY = 64;          // SC-DK2-1C 单通道 64 个 DALI 设备
const KNX_PS_MA = 640;                // SC-PK1-640 容量
const BUS_MA_PER_PANEL = 10;          // 面板总线取电
const BUS_MA_PER_SENSOR = 10;         // 传感器
const BUS_MA_IP_INTERFACE = 10;       // SC-IP1-01
const BUS_MA_DALI_GATEWAY = 12;       // 每台 KNX-DALI 网关
const ACTUATOR_CHANNELS = 20;         // SC-SK2-20R16A
const MODEL = {
  daliGateway: "SC-DK2-1C",           // KNX-DALI 网关（单通道 / 64 设备）
  ipInterface: "SC-IP1-01",           // KNX IP 接口（ETS 走局域网）
  powerSupply: "SC-PK1-640",          // KNX 电源 640mA
  actuator: "SC-SK2-20R16A",          // KNX 导轨式 20 路 16A 开关执行器
  busBridge: "SC-BR-01",              // 蓝牙网桥（蓝牙设备配套，不穿楼板）
  sensor: "SC-CK2-01",                // KNX 嵌入式人体感应器（PIR）
  daliHost: "SC-DS-64",               // DALI 云主机（平层档）
  cloudHost: "SC-MC-150",             // 智能云主机（别墅档）
};
const LIGHT_CONTROLS_DALI = "DALI";
const LIGHT_CONTROLS_SWITCH = "开关控制";

const isLight = (f: Obj) => !!f && f.type !== "窗帘";
const isStrip = (f: Obj) => !!f && f.type === "灯带";
const isDali = (f: Obj) => String(f?.control || "").trim() === LIGHT_CONTROLS_DALI;
const hasBluetooth = (v: Obj) =>
  /蓝牙|BLE|Mesh/i.test(`${v?.protocol || ""} ${v?.model || ""} ${v?.name || ""}`);

/** 老生成器写死的占位行：DALI 网关 DG-16、灯带控制器 CTL-待定。重建架构时由新规则取代。 */
export const isLegacyAuto = (v: Obj) =>
  !!v && v.source !== "auto-arch" && (v.model === "DG-16" || (v.type === "控制器" && v.model === "CTL-待定"));

/** 建筑/户型是否大宅档：别墅、复式、叠拼按别墅档主机。 */
const isVilla = (type?: string) => /别墅|复式|叠拼|联排|大宅|楼中楼|跃层/.test(String(type || ""));

export function planArchitecture(design: Obj, project: Obj): ArchPlan {
  const smart = String(project?.smart || "").trim();
  const floors = Math.max(1, Number(project?.floors) || 1);
  const warnings: string[] = [];
  const checks: ArchCheck[] = [];
  const devices: ArchDevice[] = [];

  const fixtures: Obj[] = (design?.fixtures || []).filter(isLight);
  // 只拿「人放的 / 面板逐空间建的」设备当输入：上一次生成的 auto-arch 行不算（否则每点一次，
  // 面板 / 传感器 / 蓝牙设备就按上次的结果再翻一倍），老生成器留下的占位行（DG-16、CTL-待定）也不算。
  const devicesIn: Obj[] = (design?.devices || []).filter((v: Obj) => v.source !== "auto-arch" && !isLegacyAuto(v));
  const panelsIn = devicesIn.filter((v) => v.type === "面板");
  const sensorsIn = devicesIn.filter((v) => v.type === "传感器");

  if (!smart) warnings.push("项目还没设智能方案：请在项目信息里选「KNX 总线 / 无线 / 不做智能」，再生成架构。");

  if (smart !== "KNX" && smart !== "无线") {
    // 不做智能（或未设置）：不生成任何智能设备。
    checks.push({
      item: "智能设备", need: smart ? "不做智能" : "智能方案未设置",
      made: "0 台", ok: true,
      note: smart ? "灯具按回路开闭，不需要网关 / 面板 / 执行器" : "先设智能方案再生成",
    });
    return {
      topology: smart ? "不做智能：灯具按回路开闭，情景按回路控灯" : "（智能方案未设置，未生成设备）",
      devices: [], checks, warnings,
    };
  }

  if (smart === "无线") {
    // 无线（JOCO / 米家蓝牙 Mesh）：中枢 + 每空间面板 + 蓝牙设备，不出现总线设备。
    // 面板就是设计里逐空间建的那几台（ensurePanels），这里只核对数量，不再另起一行重复出数。
    const meshPanels = panelsIn.length;
    devices.push({
      name: "无线网关 / 中枢", type: "网关", model: "", roomId: "",
      protocol: "无线", notes: "无线方案入口；型号随飞利浦清单（2026-10-16 到位）确认", qty: 1,
    });
    checks.push({ item: "面板", need: `${meshPanels} 台（每空间一台）`, made: `${meshPanels} 台`, ok: meshPanels > 0, note: meshPanels ? "" : "先在空间里生成面板" });
    checks.push({ item: "网关", need: "1 台（无线中枢）", made: "1 台", ok: true, note: "型号随飞利浦清单确认" });
    checks.push({ item: "总线设备", need: "0（无线方案）", made: "0 台", ok: true, note: "不出现 KNX / DALI 设备" });
    checks.push({ item: "灯具控制", need: "开闭 / 蓝牙 Mesh", made: `${fixtures.length} 盏已归入方案`, ok: fixtures.every((f) => [LIGHT_CONTROLS_SWITCH, "蓝牙 Mesh"].includes(String(f.control || "").trim())), note: "无线方案只允许「开闭 / 蓝牙 Mesh」两种控制方式" });
    if (fixtures.some(isStrip)) {
      devices.push({
        name: "灯带控制器", type: "控制器", model: "", roomId: "",
        protocol: "无线", notes: "每条灯带一台（调光驱动随飞利浦清单逐条选型）",
        qty: fixtures.filter(isStrip).length,
      });
      checks.push({ item: "灯带控制器", need: `${fixtures.filter(isStrip).length} 条灯带`, made: `${fixtures.filter(isStrip).length} 台`, ok: true });
    }
    return { topology: "无线中枢 → 无线面板 / 传感器 → 灯具（飞利浦，逐灯可调）", devices, checks, warnings };
  }

  // ---------- KNX 总线 ----------
  const lamps = fixtures.filter((f) => !isStrip(f));
  const strips = fixtures.filter(isStrip);
  const daliLamps = lamps.filter(isDali).length;
  const switchLamps = lamps.length - daliLamps;
  const daliStrips = strips.filter(isDali).length;
  // DALI 地址 = 调光灯具数 + DALI 电源数（同一电源带多段只算 1 个地址）
  const supplies = new Set<string>();
  let stripNoSupply = 0;
  for (const f of strips) {
    const ps = String(f.powerSupply || "").trim();
    if (ps) supplies.add(ps); else stripNoSupply += 1;
  }
  const daliAddresses = daliLamps + daliStrips + supplies.size + stripNoSupply;
  const daliGateways = daliAddresses > 0 ? Math.ceil(daliAddresses / DALI_PER_GATEWAY) : 0;
  const actuatorChannels = switchLamps;
  const actuators = actuatorChannels > 0 ? Math.ceil(actuatorChannels / ACTUATOR_CHANNELS) : 0;
  // devicesIn 已经包含面板与传感器，不能再拼一遍（原来同一台蓝牙面板会被算 2～3 次）。
  const busBridgeDevices = devicesIn.filter(hasBluetooth);
  const busBridges = busBridgeDevices.length ? floors : 0;
  const busMa = panelsIn.length * BUS_MA_PER_PANEL + sensorsIn.length * BUS_MA_PER_SENSOR
    + BUS_MA_IP_INTERFACE + daliGateways * BUS_MA_DALI_GATEWAY;
  const powerSupplies = busMa > 0 ? Math.ceil(busMa / KNX_PS_MA) : 0;
  const couplers = floors > 1 ? floors - 1 : 0;

  // 网关：KNX-DALI（按 DALI 地址算台数）
  if (daliGateways) {
    devices.push({
      name: "KNX-DALI 网关", type: "网关", model: MODEL.daliGateway, roomId: "",
      protocol: "KNX", qty: daliGateways,
      notes: `DALI 地址 ${daliAddresses} 个（调光灯 ${daliLamps} + 灯带 ${daliStrips} + 电源 ${supplies.size + stripNoSupply}），每台 ${DALI_PER_GATEWAY} 个地址`,
    });
  }
  // KNX IP 接口：ETS 走局域网读写总线
  devices.push({
    name: "KNX IP 接口", type: "网关", model: MODEL.ipInterface, roomId: "",
    protocol: "KNX", qty: 1, notes: "电脑上的 ETS 经局域网读写总线，现场调试必需",
  });
  // KNX 电源：按总线电流
  if (powerSupplies) {
    devices.push({
      name: "KNX 电源", type: "电源", model: MODEL.powerSupply, roomId: "",
      protocol: "KNX", qty: powerSupplies,
      notes: `总线电流约 ${busMa}mA（面板 ${panelsIn.length}×${BUS_MA_PER_PANEL} + 传感器 ${sensorsIn.length}×${BUS_MA_PER_SENSOR} + IP 接口 ${BUS_MA_IP_INTERFACE} + DALI 网关 ${daliGateways}×${BUS_MA_DALI_GATEWAY}），每台 ${KNX_PS_MA}mA`,
    });
  }
  // 开关执行器：开闭灯具按路数
  if (actuators) {
    devices.push({
      name: "KNX 开关执行器", type: "执行器", model: MODEL.actuator, roomId: "",
      protocol: "KNX", qty: actuators,
      notes: `开闭灯具 ${actuatorChannels} 路，按每台 ${ACTUATOR_CHANNELS} 路算`,
    });
  }
  // 线路耦合器：多层才需要（蓝牙不穿楼板 / 总线分区）
  if (couplers) {
    devices.push({
      name: "线路耦合器", type: "耦合器", model: "LC00B01KNX", roomId: "",
      protocol: "KNX", qty: couplers,
      notes: `${floors} 层按每层一段总线估（${floors - 1} 台），请按现场总线拓扑复核`,
    });
  }
  // 蓝牙网桥：有蓝牙设备才配，每层 1 台（蓝牙不穿楼板）
  if (busBridges) {
    const withSk = busBridgeDevices.some((v) => /时光之轮|SC-BLE/.test(`${v.name || ""}${v.model || ""}`));
    devices.push({
      name: "蓝牙网桥", type: "网桥", model: withSk ? "SC-BLE-BG/485" : MODEL.busBridge, roomId: "",
      protocol: "KNX", qty: busBridges,
      notes: `${busBridgeDevices.length} 台蓝牙设备，蓝牙不穿楼板按 ${floors} 层各 1 台${withSk ? "；时光之轮配套" : ""}`,
    });
  }
  // 传感器 / 面板：就是设计里已有的那几台（逐空间、逐台），只进核对表，不另起重复行——
  // 否则设备清单与导出里每台面板、传感器都会出现两次。
  // 灯带控制器：每条灯带一台（不再按房间去重）
  if (strips.length) {
    devices.push({
      name: "灯带控制器 / 电源", type: "控制器", model: "", roomId: "",
      protocol: "KNX", qty: strips.length, notes: `每条灯带一台（共 ${strips.length} 条）；型号按灯带功率选`,
    });
  }
  // 主机：平层 / 别墅两档
  devices.push({
    name: isVilla(project?.type) ? "智能云主机" : "DALI 云主机",
    type: "主机", model: isVilla(project?.type) ? MODEL.cloudHost : MODEL.daliHost, roomId: "",
    protocol: "KNX", qty: 1,
    notes: `主机只为 App / 云端入口；${isVilla(project?.type) ? "别墅档" : "平层档"}按户型「${project?.type || "未填"}」推定，请确认`,
  });

  // ---- 核对表：需求 vs 生成 ----
  checks.push({ item: "KNX-DALI 网关", need: `DALI 地址 ${daliAddresses}`, made: `${daliGateways} 台 × ${DALI_PER_GATEWAY} 地址`, ok: daliGateways * DALI_PER_GATEWAY >= daliAddresses, note: daliAddresses ? "调光灯具必须过 DALI 网关，没有它调不了" : "没有 DALI 设备，不需要网关（全屋开闭）" });
  checks.push({ item: "KNX 电源", need: `总线电流 ${busMa}mA`, made: `${powerSupplies} 台 × ${KNX_PS_MA}mA`, ok: powerSupplies * KNX_PS_MA >= busMa, note: powerSupplies > 1 ? "一台不够，已按多台算；多台并联请确认总线分段" : "" });
  checks.push({ item: "KNX IP 接口", need: "1 台（ETS 现场调试）", made: "1 台", ok: true });
  checks.push({ item: "开关执行器", need: `开闭灯具 ${actuatorChannels} 路`, made: `${actuators} 台 × ${ACTUATOR_CHANNELS} 路`, ok: true, note: switchLamps ? "" : "没有开闭灯具（全屋 DALI 调光）" });
  checks.push({ item: "面板", need: `${panelsIn.length} 台（每空间一台）`, made: `${panelsIn.length} 台`, ok: panelsIn.length > 0, note: "型号 / 刻字在面板选型里逐台定" });
  checks.push({ item: "传感器", need: `${sensorsIn.length} 台`, made: `${sensorsIn.length} 台（设计里逐台）`, ok: true, note: sensorsIn.length ? `型号建议 ${MODEL.sensor}（按现场选 PIR / 24G 雷达）` : "" });
  checks.push({ item: "灯带控制器", need: `${strips.length} 条灯带`, made: `${strips.length} 台`, ok: true, note: "每条灯带一台" });
  checks.push({ item: "线路耦合器", need: floors > 1 ? `${floors} 层（按层分段）` : "平层不需要", made: `${couplers} 台`, ok: true });
  checks.push({ item: "蓝牙网桥", need: busBridgeDevices.length ? `有 ${busBridgeDevices.length} 台蓝牙设备，按 ${floors} 层各 1 台` : "无蓝牙设备", made: `${busBridges} 台`, ok: true });
  checks.push({ item: "主机", need: "1 台（App / 云端入口）", made: `1 台 ${isVilla(project?.type) ? MODEL.cloudHost : MODEL.daliHost}`, ok: true, note: "档位按户型推定，请确认" });
  const badControls = fixtures
    .map((f) => String(f.control || "").trim())
    .filter((c) => c && ![LIGHT_CONTROLS_DALI, LIGHT_CONTROLS_SWITCH].includes(c));
  checks.push({
    item: "灯具控制", need: "只允许「开闭 / DALI」", made: badControls.length ? `${badControls.length} 盏不合规` : "全部合规",
    ok: badControls.length === 0,
    note: badControls.length ? `不合规值：${[...new Set(badControls)].join("、")}` : "KNX 方案不出现无线协议",
  });
  if (fixtures.length === 0) warnings.push("这个项目还没有灯具：架构是按灯具/空间算出来的，先布灯再生成。");

  return {
    topology: "KNX 总线：主机 → KNX 电源 + IP 接口 → KNX-DALI 网关（→ DALI 调光灯具）/ 开关执行器（→ 开闭灯具）；面板与传感器挂总线，灯带经控制器",
    devices, checks, warnings,
  };
}
