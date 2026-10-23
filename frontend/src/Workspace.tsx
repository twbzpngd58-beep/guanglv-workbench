import "./workspaceV2.css";
import { readCapabilities } from "./capabilities";
import { WallEvidenceReview } from "./WallEvidenceReview";
import { RecognitionCompare } from "./RecognitionCompare";
import { Lighting3DView } from "./Lighting3DView";
import { SpacePreviewLayer } from "./SpacePreview";
import { revealFlash } from "./reveal";
import { withSpaceShell, boundary, snapToWall, WALL_SNAP_MAX } from "./spaceGeometry";
import { FurniturePanel, createFurniture, furnitureFromModel, pointInSpace } from "./FurniturePanel";
import { withFurniturePolygon } from "./furniturePolygon";
import { mountHeight } from "./wallMount";
import { isTabletopDevice } from "./deviceMount";
import { Spatial3D } from "./Spatial3D";
import { planArchitecture, isLegacyAuto } from "./systemArchitecture";
import { Ueyi3D } from "./Ueyi3D";
import { useState, useEffect, useRef, useCallback } from "react";
import {
  ArrowLeft,
  ChevronRight,
  Plus,
  Upload,
  Download,
  Save,
  Undo2,
  Redo2,
  MousePointer2,
  Hand,
  ZoomIn,
  ZoomOut,
  Maximize,
  Layers3,
  Lightbulb,
  Sun,
  FileText,
  ShieldCheck,
  SlidersHorizontal,
  CheckCircle2,
  Clock3,
  MoreHorizontal,
  Trash2,
  Copy,
  X,
  Loader2,
  Volume2,
  AlertCircle,
  Eye,
  Grid2X2,
  LayoutGrid,
  PanelRightClose,
  Check,
  ArrowUpRight,
  RotateCw,
  Split,
  Combine,
  DoorOpen,
  Square,
  Minus,
  Power,
  Play,
  Image,
  History,
  Lock,
  Settings2,
  Link,
  Box,
  PencilRuler,
  FileUp,
  ChevronDown,
  Sparkles,
  Smartphone,
  QrCode,
} from "lucide-react";
import { type DrawingStep, type EditingPhase, DrawingProgress } from "./DrawingProgress";
import { CircuitIssueList, CircuitBoard } from "./CircuitCheck";
import { circuitIssues, BLOCKED_EXPORTS } from "./circuitRules";
import {
  api,
  post,
  clone,
  uid,
  roomTypes,
  lightTypes,
  fmtDate,
  spaceFromCode,
  type Project,
  type Design,
  type Obj,
} from "./types";
import { detectFloorFromName, floorSummary } from "./floorDetect";
import {
  areaSummary,
  ghostFixturesOnFloor,
  isVoidRoom,
  voidInstallHeight,
  voidLabel,
  voidLevelsOf,
} from "./voids";
import {
  FOV_OPTIONS,
  coverageGeometry,
  coverageSeed,
  hasManualCoverage,
  insertCoveragePoint,
  manualCoverage,
  metres,
  obstaclesFor,
  sensorCovers,
  sensorCoverageIssues,
  sensorShape,
} from "./sensors";
import {
  aboveFloors,
  floorLabel,
  floorLevels,
  levelSummary,
  safeBasements,
} from "./floors";
import { Plan, stripPoints, type Selection } from "./Plan";
import { GROUPED_SPACES, spaceMapByAlias, spaceMapByCode, type HouseType } from "./spaces";
import {
  DEFAULT_ROLE_BY_POSITION,
  ROLE_CODES,
  SPACE_CODES,
  POSITION_CODES,
  groupedPositionsForSpace,
  positionsForSpace,
  positionNameIn,
  positionCodeInSpace,
  defaultRoleForPosition,
  buildFixtureCode,
  codeWithRole,
  defaultBeamAngle,
  nextSerial,
  parseFixtureCode,
  describeFixtureCode,
  roleOfCode,
  spotDiameterMetres,
  spotMultiple,
  isDecorativeLight,
  defaultFixtureName,
  defaultFixtureModel,
  isAutoFixtureName,
  standardSceneState,
  applyColorMode,
  clampCctForFixture,
  clampSceneStates,
  cctIssuesOf,
  cctNeedsReason,
  cctText,
  isCctPending,
  applyProductCct,
  applyProductToFixture,
  CCT_PENDING_LABEL,
  colorModeOf,
  isColorful,
  isStripType,
  isTunable,
  COLOR_MODES,
  SINGLE_CCT_OPTIONS,
  SINGLE_CCT_DEFAULT,
  DUAL_CCT_MIN_DEFAULT,
  DUAL_CCT_MAX_DEFAULT,
  COLOR_HEX_DEFAULT,
  type ColorMode,
} from "./codes";
import {
  ALL_SCENES,
  PACKAGE_TEMPLATES,
  SCENE_PACKAGE,
  sceneHomeSpaceCode,
  sceneHomeSpaceName,
  availableScenes,
  excludedScenes,
  priorityName,
  roleName,
  sceneDefFor,
} from "./sceneRules";
import { Button, Modal, Badge, Field } from "./ui";
import {
  PANEL_KEY_COUNTS, PANEL_DEFAULT_KEYS, PANEL_BRAND, PANEL_MODELS, ENGRAVE_MODES,
  normalizePanel, fillPanelKeys as fillPanelKeysFor, panelModel, pickableModels, panelTextMax, panelIssues, keyFace,
  roomNeedsNoPanel, roomTemplate, engraveModeLabel, PANEL_RULES, panelImage,
} from "./panelRules";
const PANEL_RULES_ICONS: Record<string, string> = PANEL_RULES.icons;

const DEVICE_TYPE_LETTER: Record<string, string> = {
  "传感器": "S",
  "窗帘": "W",
  "面板": "P",
  "网关": "G",
  "控制器": "C",
  "温控器": "T",
  "电源": "Y",
  "其他": "X",
};
/** 面板按键数档位 / 刻字口径见 ./panelRules（世聪型号目录 + 产品资料刻字口径），默认 4 键。
 *  「4 键」即世聪面板标注的「4键8功能」：4 个物理键 ×（短按 / 长按）= 8 个功能；
 *  一个物理键只刻一次：keyLabels ＝ 刻字（短按），keyLongLabels ＝ 长按功能说明（不刻字）；
 *  例外：官网 TK3 / ST3 为上下双刻，长按文字刻在按键下方（model.engraveLong）。 */
/** 每个物理键的两种操作方式。 */
const PANEL_PRESSES = ["短按", "长按（不刻字）"];
/** 排版图 / 演示用键位列数（与后端一致）。 */
const PANEL_KEY_COLS: Record<number, number> = { 1: 1, 2: 2, 4: 2, 12: 4 };
const panelKeyCols = (n: number) => PANEL_KEY_COLS[n] || 2;
/** 可添加的设备类型（与「设备属性」下拉一致）。 */
const DEVICE_TYPES = ["传感器", "面板", "网关", "控制器", "温控器", "电源", "其他"];
/** 添加设备时的默认名称（跟着类型走，可手动改）。 */
const DEFAULT_DEVICE_NAME: Record<string, string> = {
  "传感器": "人体存在传感器",
  "面板": "智能控制面板",
  "网关": "智能网关",
  "控制器": "灯带控制器",
  "温控器": "温控面板",
  "电源": "开关电源",
  "其他": "智能设备",
};
/** 场景联动的对象只有灯具：窗帘不接入场景（不写入、也不保留 scene.states）。 */
const isSceneLight = (f: Obj) => !!f && f.type !== "窗帘";
/** 回路编号：空＝未分配回路。 */
const circuitOf = (f: Obj) =>
  (f && f.circuit ? String(f.circuit).trim() : "") || "未分配回路";
/** 智能方案取值：无线（飞利浦，2026-10-11 起；原 JOCO 方案停用）/ KNX 总线 / 无（不做智能 · 按回路开闭）。
 *  2026-10-23 老板拍板方案 C：数据不动（smart="无" 保留），界面统一称「不做智能（按回路开闭）」。 */
const SMART_OPTIONS: { value: string; label: string }[] = [
  { value: "无线", label: "做智能 · 无线（飞利浦）" },
  { value: "KNX", label: "做智能 · KNX 总线" },
  { value: "无", label: "无（不做智能 · 按回路开闭）" },
];
/** 顶栏/项目头这类「有就显示」的位置：未设置时返回空串，由调用方省略整段。 */
const smartLabelOf = (v?: string) =>
  v === "无" ? "" : v === "KNX" ? "智能 · KNX 总线" : "智能 · 无线（飞利浦）";
/** 需要成句/必须带方案名的地方（提示语、设备架构说明）：不做智能时给统一口径。 */
const smartLabelOrNone = (v?: string) => smartLabelOf(v) || "不做智能（按回路开闭）";
/**
 * 灯具控制方式：按项目智能方案收敛（实测 2026-10-11 口径）。
 * 总线（KNX/DALI）只给「开闭 / DALI」——JOCO 与 mesh 类无线协议在总线方案里没有意义；
 * 无线只给「开闭 / 蓝牙 Mesh」；不做智能只给「开闭」。
 */
const FIXTURE_CONTROLS: Record<string, { value: string; label: string }[]> = {
  KNX: [{ value: "开关控制", label: "开闭" }, { value: "DALI", label: "DALI" }],
  无线: [{ value: "开关控制", label: "开闭" }, { value: "蓝牙 Mesh", label: "蓝牙 Mesh" }],
  无: [{ value: "开关控制", label: "开闭" }],
};
const fixtureControlOptions = (smart?: string) =>
  FIXTURE_CONTROLS[String(smart || "无")] || FIXTURE_CONTROLS["无"];
const fixtureControlAllowed = (smart: string | undefined, v?: string) =>
  fixtureControlOptions(smart).some((o) => o.value === String(v || "").trim());
/** 曾经的调光/无线协议写法：切方案时按方向归到本方案的调光方式。 */
const DIMMING_CONTROLS = ["DALI", "蓝牙 Mesh", "Zigbee", "Wi-Fi", "PWM", "0–10V", "KNX"];
/** 归一：不属于本方案的控制方式 → 本方案的调光方式（原是调光类）或「开闭」。 */
function normalizeFixtureControl(f: Obj, smart?: string) {
  if (!f) return;
  const cur = String(f.control || "").trim();
  if (!cur) {
    f.control = fixtureControlOptions(smart)[0].value;
    return;
  }
  if (fixtureControlAllowed(smart, cur)) return;
  const dim = fixtureControlOptions(smart).find((o) => o.value !== "开关控制");
  f.control = DIMMING_CONTROLS.includes(cur) && dim ? dim.value : "开关控制";
}
/**
 * 无线智能默认：只把控制方式归到无线一档、给上调光能力。
 * **不再自动盖品牌**——无线品牌 2026-10-11 起改为飞利浦（新的灯具清单 10-16 到位），
 * 早先写死「JOCO」会把停用品牌带进新项目。
 */
function applyWirelessDefaults(f: Obj) {
  if (!f) return;
  normalizeFixtureControl(f, "无线");
  f.dimmable = true;
  if (colorModeOf(f) !== "单色") f.tunable = true;
}
/**
 * 总线智能（KNX/DALI）：无线协议与旧的「KNX 控制」换成 DALI；
 * **开闭的灯保持开闭**（不强行升级成调光——会在 DALI 地址与造价上凭空多算）。
 */
function applyBusDefaults(f: Obj) {
  if (!f) return;
  const cur = String(f.control || "").trim();
  if (!cur || ["蓝牙 Mesh", "Zigbee", "Wi-Fi", "KNX"].includes(cur)) f.control = "DALI";
  else normalizeFixtureControl(f, "KNX");
  if (f.control === "DALI") {
    f.dimmable = true;
    if (colorModeOf(f) !== "单色") f.tunable = true;
  } else {
    f.dimmable = false;
  }
}
/** 不做智能：按空间给每盏灯分配回路（每个空间一条回路 C01/C02…）。 */
function autoCircuitsByRoom(n: Obj) {
  const rooms: Obj[] = n.rooms || [];
  (n.fixtures || []).filter(isSceneLight).forEach((f: Obj) => {
    const idx = rooms.findIndex((r) => r.id === f.roomId);
    const num = idx < 0 ? rooms.length + 1 : idx + 1;
    f.circuit = "C" + String(num).padStart(2, "0");
  });
}
function stripCurtainStates(design: Obj) {
  const curtains = new Set(
    (design.fixtures || []).filter((f: Obj) => f && f.type === "窗帘").map((f: Obj) => f.id),
  );
  if (!curtains.size) return;
  (design.scenes || []).forEach((s: Obj) => {
    if (!s || !s.states) return;
    Object.keys(s.states).forEach((id) => {
      if (curtains.has(id)) delete s.states[id];
    });
  });
  // 传感器关联里也不保留窗帘。
  (design.devices || []).forEach((dev: Obj) => {
    if (!Array.isArray(dev.linkedLights)) return;
    const kept = dev.linkedLights.filter((id: string) => !curtains.has(id));
    if (kept.length !== dev.linkedLights.length) dev.linkedLights = kept;
  });
}
/** 类型 ↔ 名称 / 型号对齐：旧版布灯把除 灯带 / 筒灯 以外的类型都叫「防眩射灯」、型号都写 DL-07，
 *  于是存量数据会出现「类型=吊灯、名称=防眩射灯」。这里只把「本工具生成的默认名 / 默认型号」
 *  按当前类型改回；自己起的名字、自己填的型号一律不动。 */
function alignFixtureNames(design: Obj) {
  (design.fixtures || []).forEach((f: Obj) => {
    if (!f) return;
    const want = defaultFixtureName(f.type);
    if (isAutoFixtureName(f.name) && String(f.name || "").trim() !== want) {
      f.name = want;
    }
    const m = String(f.model || "").trim();
    if (m === "DL-07" || m === "ST-01") {
      const wantModel = defaultFixtureModel(f.type);
      if (m !== wantModel) f.model = wantModel;
    }
  });
}
function pruneDeviceRefs(design: Obj) {
  const fixtures = new Set((design.fixtures || []).map((f: Obj) => f.id));
  const scenes = new Set((design.scenes || []).map((s: Obj) => s.id));
  (design.devices || []).forEach((dev: Obj) => {
    if (Array.isArray(dev.linkedLights)) {
      const kept = dev.linkedLights.filter((id: string) => fixtures.has(id));
      if (kept.length !== dev.linkedLights.length) dev.linkedLights = kept;
    }
    if (Array.isArray(dev.keyScenes)) {
      const next = dev.keyScenes.map((id: string) => (id && scenes.has(id) ? id : ""));
      if (next.some((v: string, i: number) => v !== dev.keyScenes[i]))
        dev.keyScenes = next;
    }
    if (Array.isArray(dev.keyLongScenes)) {
      const next = dev.keyLongScenes.map((id: string) =>
        id && scenes.has(id) ? id : "",
      );
      if (next.some((v: string, i: number) => v !== dev.keyLongScenes[i]))
        dev.keyLongScenes = next;
    }
  });
}
/** 世聪按产品资料目录选型；其他品牌仍按产品库表，但剔除 AP / 温控 / 语音 / 连框 / 空白面板。 */
const isCitron = (brand?: string) => !!brand && (brand === PANEL_BRAND || /世聪|CITRON/i.test(brand));
// 非面板 / 非标件一律不进面板选型：底座这类没有型号的异形件（充电底座等）也在内。
const NOT_A_PANEL = /AP|无线接入|温控|语音|连框|空白|底盒|底座/;
function panelSeries(product: Obj): string {
  return product.series || String(product.notes || "").match(/([\w一-鿿 ]{1,20}系列)/)?.[1]?.trim() || "未标注系列";
}
/** 选型后的整板修正：键数跟型号、屏显型号改 screen、离开屏显型号回到空间模板形式。 */
function applyPanelPick(dev: Obj, values: Obj, room?: Obj) {
  const wasScreen = dev.engraveMode === "screen";
  Object.assign(dev, values);
  const model = panelModel(dev.productId);
  if (wasScreen && model?.engrave !== "screen")
    dev.engraveMode = roomTemplate(room).mode === "icon" ? "icon" : "text";
  normalizePanel(dev);
}
function PanelProductPicker({ dev, products, disabled, onEdit }: {
  dev: Obj; products: Obj[]; disabled?: boolean; onEdit: (patch: Obj) => void;
}) {
  const others = products.filter((v) => v.category === "device" && (
    v.type === "面板" || /面板|开关|触控屏/.test(v.name || "")
  ) && v.model && !isCitron(v.brand) && !NOT_A_PANEL.test(`${v.name || ""} ${v.model || ""}`));
  // 方案决定品牌：总线（KNX）出「世聪 + 非 JOCO 的其它品牌」。无线 2026-10-11 起不再限定 JOCO
  // （改飞利浦；面板型号随新灯具清单入库后会自动出现在这里），否则无线项目根本选不出面板。
  const wireless = /蓝牙|Mesh|Wi[\- ]?Fi/i.test(String(dev.protocol || ""));
  const bus = /KNX/i.test(String(dev.protocol || ""));
  const brandPool = wireless ? others.filter((v) => !/JOCO/i.test(String(v.brand || ""))) : others;
  const brands = wireless
    ? [...new Set(brandPool.map((v) => v.brand).filter(Boolean))]
    : [PANEL_BRAND, ...new Set((bus ? brandPool.filter((v) => !/JOCO/i.test(String(v.brand || ""))) : brandPool).map((v) => v.brand).filter(Boolean))];
  const citron = isCitron(dev.brand);
  const series = citron
    ? [...new Set(pickableModels(dev.productId).map((m) => m.series))]
    : [...new Set(others.filter((v) => v.brand === dev.brand).map(panelSeries))];
  const citronModels = pickableModels(dev.productId).filter((m) => m.series === dev.series);
  const otherModels = others.filter((v) => v.brand === dev.brand && panelSeries(v) === (dev.series || "未标注系列"));
  const model = panelModel(dev.productId);
  const n = Number(dev.keys) || PANEL_DEFAULT_KEYS;
  const legacyCitron = citron && dev.model && !model;
  const projectProtocol = String(dev.protocol || "");
  const protocolClash = model && projectProtocol && !projectProtocol.includes(model.protocol.replace("RS-", ""))
    && !(model.protocol === "RS-485" && /485|DALI/.test(projectProtocol))
    // 蓝牙配件（时光之轮等）本身就是配蓝牙网桥接入总线的，KNX 项目里不算协议冲突。
    && !(model.protocol === "蓝牙" && /KNX/i.test(projectProtocol));
  const material = model ? model.material : String(others.find((v) => v.id === dev.productId)?.notes || "");
  return <div className="panel-product-picker">
    <div className="panel-product-selectors">
      <label>品牌<select disabled={disabled} value={citron ? PANEL_BRAND : dev.brand || ""}
        onChange={(e) => onEdit({ brand: e.target.value, series: "", model: "", productId: "", color: "" })}>
        <option value="">请选择品牌</option>{brands.map((b) => <option key={b}>{b}</option>)}
      </select></label>
      <label>系列<select disabled={disabled || !dev.brand} value={dev.series || ""}
        onChange={(e) => onEdit({ series: e.target.value, model: "", productId: "", color: "" })}>
        <option value="">请选择系列</option>
        {citron && dev.series && !series.includes(dev.series) && <option value={dev.series}>{dev.series}（旧值，请重选）</option>}
        {series.map((s) => <option key={s}>{s}</option>)}
      </select></label>
      <label>型号<select disabled={disabled || !dev.series} value={dev.productId || ""}
        onChange={(e) => {
          if (citron) {
            const m = panelModel(e.target.value);
            onEdit(m ? { productId: m.id, model: m.model, name: m.name, brand: PANEL_BRAND, series: m.series,
              keys: m.keys, color: m.colors.length === 1 ? m.colors[0] : "" } : { productId: "", model: "" });
            return;
          }
          const item = others.find((v) => v.id === e.target.value);
          onEdit(item ? { productId: item.id, model: item.model, name: item.name, brand: item.brand,
            series: panelSeries(item) } : { productId: "", model: "" });
        }}>
        <option value="">请选择型号</option>
        {citron
          ? citronModels.map((m) => <option key={m.id} value={m.id}>{m.model} · {m.name}{m.offline ? "（官网已下架）" : ""}</option>)
          : otherModels.map((v) => <option key={v.id} value={v.id}>{v.model} · {v.name}</option>)}
      </select></label>
      {model && <label>颜色<select disabled={disabled} value={dev.color || ""}
        onChange={(e) => onEdit({ color: e.target.value })}>
        <option value="">请选择颜色</option>
        {model.colors.flatMap((c: string) => (model.shapes || [""]).map((s: string) => s ? `${c}-${s}` : c))
          .map((c: string) => <option key={c}>{c}</option>)}
      </select></label>}
    </div>
    {model && <div className="panel-model-info">
      {panelImage(model) && <img src={panelImage(model)} alt={`${model.model} 官网图`} loading="lazy" />}
      <div>
        <small className="subtle">
          {model.protocol} · {model.material} · {model.keys} 键{model.longPress ? `（${model.keys}键${model.keys * 2}功能：短按 / 长按）` : ""}
          {" · "}{model.engrave === "screen" ? "免雕刻（APP 设定屏显）" : "激光 / 镂空刻字"}
          {model.engrave !== "screen" ? ` · 限 ${panelTextMax(model)} 字` : ""}{model.engraveLong ? " · 上下双刻（长按刻在下方）" : ""}
        </small>
        {model.offline && <small className="subtle warn">{model.offline}：新项目请改选官网在售型号</small>}
        {model.imageNote && <small className="subtle">配图：{model.imageNote}</small>}
        {(model.url || model.manual) && <small className="subtle">
          {model.url && <a href={model.url} target="_blank" rel="noreferrer">官网详情</a>}
          {model.url && model.manual && " · "}
          {model.manual && <a href={model.manual} target="_blank" rel="noreferrer">说明书 PDF</a>}
        </small>}
      </div>
    </div>}
    {model?.verify && <small className="subtle">待核对：{model.verify}</small>}
    {legacyCitron && <small className="error-text">「{dev.model}」不在世聪面板目录（可能是温控器 / 语音 / 连框等），请重新选择系列与型号。</small>}
    {protocolClash && <small className="error-text">型号协议为 {model.protocol}，与本面板协议「{projectProtocol}」不一致，请核对。</small>}
    <div className="panel-product-face" aria-label="面板款式和刻字示意"
      style={{ background: /木质|木纹/.test(material) ? "linear-gradient(135deg,#75533e,#a78660)" :
        /玻璃|触控屏/.test(material) ? "linear-gradient(135deg,#1c252a,#51616d)" :
        /金属/.test(material) ? "linear-gradient(135deg,#626b70,#a2aaa9)" : undefined }}>
      <small>{dev.brand || "待选品牌"} · {dev.series || "待选系列"} · {dev.model || "待选型号"}{dev.color ? ` · ${dev.color}` : ""}</small>
      <div className="panel-product-face-keys" style={{ gridTemplateColumns: `repeat(${n === 4 ? 2 : Math.min(n, 4)}, 1fr)` }}>
        {Array.from({ length: n }, (_, i) => {
          const face = keyFace(dev, i);
          return <span key={i}>
            <b>{face.main || `键位 ${i + 1}`}</b>
            {face.sub && <small>{face.sub}</small>}
          </span>;
        })}
      </div>
      <small>{engraveModeLabel(dev.engraveMode)} · 键位与刻字示意，非厂家实物外观；请以产品样册核对。</small>
    </div>
  </div>;
}
/** 传感器默认联动参数：探测半径缺省补 80，避免「拖了小人却没反应」。 */
function normalizeSensor(dev: Obj) {
  if (dev.type !== "传感器") return;
  if (dev.range == null || !Number.isFinite(Number(dev.range))) dev.range = 80;
  // 视场角 / 朝向：360° + 0° ＝ 整圆，行为与改造前一致；要防穿墙再收紧。
  if (dev.fov == null) dev.fov = 360;
  if (dev.heading == null) dev.heading = 0;
  if (dev.offDelaySeconds == null) dev.offDelaySeconds = 5;
  if (dev.sensorBrightness == null) dev.sensorBrightness = 100;
  // 联动色温默认跟随所联灯具（无联灯回落 3000K）；已存的值不迁移、不改写。
  if (dev.sensorCct == null) {
    dev.sensorCctAuto = true;
    dev.sensorCct = 3000;
  }
  if (!Array.isArray(dev.linkedLights)) dev.linkedLights = [];
}
/** 跟随模式下按首盏联动灯的色温回写 sensorCct（夹到该灯允许区间），无联灯 = 3000K。 */
function syncSensorCct(dev: Obj, fixtures: Obj[]) {
  if (dev.type !== "传感器" || !dev.sensorCctAuto) return;
  const first = fixtures.find((f) => (dev.linkedLights || []).includes(f.id));
  dev.sensorCct = first
    ? clampCctForFixture(first, Number(first.cct) || 3000)
    : 3000;
}
// 设备编号 = 空间码 + 设备类型码 + 序号，与灯具编号同一套识别逻辑。
/** 房间 → 空间类型。先看显式 spaceCode，再按名字精确 / 前缀匹配，最后才落到房间用途。
 *  这样「次卧 2」「玄关 3」这类同类多空间也能正确归到 次卧 / 门厅。 */
// 写系统剪贴板：安全上下文（https / localhost）用 Clipboard API；
// 局域网 http（如 http://192.168.x.x:8000）不是安全上下文，只能走 textarea + execCommand 兜底。
// 两个关键点（业主反馈「复制完浏览器又多开了几个搜索页」之后加的）：
//   1) 兜底复制必须临时聚焦 textarea，复制完要把焦点还给原元素，否则随后的 Ctrl+V
//      容易落到浏览器地址栏 / 搜索框（Edge 会把内容当搜索词，一次开一个 Bing 标签页）。
//   2) 复制失败要如实返回 false，让调用方提示「手动选择复制」，不能假装成功。
// 返回是否真的写进系统剪贴板；写失败不影响工作台内粘贴。
function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard
        .writeText(text)
        .then(() => true)
        .catch(() => false);
    }
    const active = document.activeElement as HTMLElement | null;
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    ta.style.top = "0";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    let ok = false;
    try {
      ta.focus({ preventScroll: true });
      ta.select();
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    document.body.removeChild(ta);
    // 焦点还给原来的元素：避免「复制完焦点飘走、下一次粘贴落到地址栏」
    if (active && active !== document.body && document.contains(active)) {
      try {
        active.focus({ preventScroll: true });
      } catch {
        /* 元素已不可聚焦：忽略 */
      }
    }
    return Promise.resolve(ok);
  } catch {
    return Promise.resolve(false);
  }
}
// 落点命中房间：有边界点的按多边形（射线法）判断，有矩形边界的按矩形判断，
// 无边界空间（按编号建立）不参与命中。
function pointInRoom(r: Obj, p: { x: number; y: number }): boolean {
  const pts: Obj[] = Array.isArray(r.points) ? r.points : [];
  if (pts.length >= 3) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = Number(pts[i].x) || 0;
      const yi = Number(pts[i].y) || 0;
      const xj = Number(pts[j].x) || 0;
      const yj = Number(pts[j].y) || 0;
      if (yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi)
        inside = !inside;
    }
    return inside;
  }
  if (!(Number(r.width) > 1) || !(Number(r.height) > 1)) return false;
  return (
    p.x >= Number(r.x) &&
    p.x <= Number(r.x) + Number(r.width) &&
    p.y >= Number(r.y) &&
    p.y <= Number(r.y) + Number(r.height)
  );
}
function roomSpaceCodeOf(r: Obj | undefined | null): { code: string; name: string } | null {
  if (!r) return null;
  if (r.spaceCode) {
    const byCode = spaceMapByCode.get(r.spaceCode);
    if (byCode) return byCode;
  }
  const nm = (r.name || "").trim();
  if (nm) {
    const exact = SPACE_CODES.find((s) => s.name === nm);
    if (exact) return exact;
    const byPrefix = SPACE_CODES.find((s) => nm.startsWith(s.name));
    if (byPrefix) return byPrefix;
    // 图纸常用别名也算（玄关→门厅、家庭影院→影音室、储物间→收纳间…），与后端读数词表同义。
    const byAlias = spaceMapByAlias.get(nm);
    if (byAlias) return byAlias;
    const aliasName = [...spaceMapByAlias.keys()].find((a) => nm.startsWith(a));
    if (aliasName) return spaceMapByAlias.get(aliasName) || null;
  }
  return SPACE_CODES.find((s) => s.name === r.type) || null;
}

/** 同类空间可以有多个：次卧 → 次卧 2 → 次卧 3；别墅多个入户 → 门厅、门厅 2…。 */
function nextSpaceName(rooms: Obj[], base: string): string {
  const used = new Set((rooms || []).map((r) => (r.name || "").trim()));
  if (!used.has(base)) return base;
  let i = 2;
  while (used.has(`${base} ${i}`)) i += 1;
  return `${base} ${i}`;
}

function buildDeviceCode(room: Obj | undefined, type: string, devices: Obj[]): string {
  const sc = roomSpaceCodeOf(room)?.code || "x";
  const tl = DEVICE_TYPE_LETTER[type] || "X";
  // 序号＝同「空间码 + 类型码」已用过的最大序号 +1。旧实现用数量（length+1），
  // 删掉一台设备后再加就会撞号（例如已有 kP002 又新出一台 kP002）。
  const prefix = `${sc}${tl}`;
  let max = 0;
  devices.forEach((d) => {
    const code = String(d.code || "");
    if (!code.startsWith(prefix)) return;
    const tail = code.slice(prefix.length);
    if (/^\d+$/.test(tail)) max = Math.max(max, Number(tail));
  });
  return `${prefix}${String(max + 1).padStart(3, "0")}`;
}

/** 面板刻字预填（产品资料键位预算）：见 ./panelRules fillPanelKeys。
 *  只改整排空白 / 旧版「情景全名」预填的面板，设计师改过的刻字一律不动。 */
function fillPanelKeys(n: Obj, dev: Obj, r: Obj | undefined | null, force = false) {
  fillPanelKeysFor(n.scenes || [], dev, r, force);
}
/** 自动布置 / 替换情景面板：每个空间一块标准「4键8功能」面板（4 键 × 短按/长按 ＝ 8 格）。
 *  新建时按空间情景预填刻字与绑定；老项目里缺刻字、缺长按键位、键数不对的面板一并补齐替换
 *  —— 只补空白的，设计师改过的一律不动。 */
/** smart＝项目智能方案（在 project 上，不在 design 上）：决定新建面板的协议。 */
function ensurePanels(n: Obj, smart?: string) {
  const rooms = n.rooms || [];
  rooms.forEach((r: Obj) => {
    const existing = n.devices.find((v: Obj) => v.type === "面板" && v.roomId === r.id);
    if (existing) {
      normalizePanel(existing);
      fillPanelKeys(n, existing, r);
      return;
    }
    // 卫浴 · 过道 · 楼梯按口径 0 键（全自动），不新建面板。
    if (roomNeedsNoPanel(r)) return;
    const dev: Obj = {
      id: uid(),
      code: buildDeviceCode(r, "面板", n.devices),
      name: "智能情景面板",
      type: "面板",
      model: "",
      roomId: r.id,
      floor: r.floor || 1,
      // 协议随项目智能方案：KNX 总线 → KNX；无线（飞利浦）→ 蓝牙 Mesh（协议待随新清单确认）。不做智能不出面板（上面已 return）。
      protocol: String(smart || "") === "无线" ? "蓝牙 Mesh" : "KNX",
      address: "待编址",
      notes: "系统自动建立，可手动调整",
      x: (r.x || 0) + (r.width || 0) - 24,
      y: (r.y || 0) + 18,
    };
    n.devices.push(dev);
    normalizePanel(dev);
    fillPanelKeys(n, dev, r, true);
  });
}

function useProject(id: string, notify: (s: string) => void) {
  const [p, setP] = useState<Project | null>(null),
    [d, setD] = useState<Design | null>(null),
    [saving, setSaving] = useState(false),
    [dirty, setDirty] = useState(false),
    [loadError, setLoadError] = useState(""),
    [saveError, setSaveError] = useState("");
  const pRef = useRef<Project | null>(null),
    dRef = useRef<Design | null>(null),
    dirtyRef = useRef(false),
    flight = useRef<Promise<void> | null>(null),
    timer = useRef<any>(null),
    stamp = useRef(0),
    history = useRef<Design[]>([]),
    future = useRef<Design[]>([]);
  const [tick, setTick] = useState(0);
  const accept = useCallback((v: Project) => {
    pRef.current = v;
    const design = clone(v.design);
    (design.devices || []).forEach((dev: Obj) => {
      if (dev.type === "面板") {
        normalizePanel(dev);
        // 打开项目即把空刻字补齐（老项目里未替换过的面板），只补整排空白的，改过的一律不动。
        fillPanelKeys(
          design,
          dev,
          (design.rooms || []).find((r: Obj) => r.id === dev.roomId),
        );
      }
      if (dev.type === "传感器") {
        normalizeSensor(dev);
        syncSensorCct(dev, design.fixtures || []);
      }
    });
    stripCurtainStates(design);
    pruneDeviceRefs(design);
    alignFixtureNames(design);
    dRef.current = design;
    dirtyRef.current = false;
    setP(v);
    setD(clone(design));
    setDirty(false);
    setSaveError("");
    history.current = [];
    future.current = [];
    setTick((t) => t + 1);
  }, []);
  useEffect(() => {
    api<Project>("/projects/" + id)
      .then(accept)
      .catch((e) => setLoadError(e.message));
  }, [id, accept]);
  const flush = useCallback(async (): Promise<void> => {
    clearTimeout(timer.current);
    if (flight.current) return flight.current;
    const job = async () => {
      setSaving(true);
      try {
        while (dirtyRef.current) {
          const current = clone(dRef.current!),
            at = stamp.current;
          const v = await api<Project>(`/projects/${id}/design`, {
            method: "PUT",
            body: JSON.stringify({
              revision: pRef.current!.revision,
              design: current,
            }),
          });
          pRef.current = v;
          setP(v);
          if (at === stamp.current) {
            dirtyRef.current = false;
            setDirty(false);
          }
          setSaveError("");
        }
      } catch (e: any) {
        setSaveError(e.message);
        throw e;
      } finally {
        setSaving(false);
        flight.current = null;
      }
    };
    if (!dirtyRef.current) return;
    flight.current = job();
    return flight.current;
  }, [id]);
  const change = useCallback(
    (v: Design, record = true) => {
      if (pRef.current?.frozen || pRef.current?.status === "已归档") return;
      stripCurtainStates(v);
      // 删灯具 / 删情景后，传感器关联与面板键位绑定不留悬空 id。
      pruneDeviceRefs(v);
      // 类型 / 名称 / 型号对齐（旧数据里「类型=吊灯、名称=防眩射灯」这类）。
      alignFixtureNames(v);
      // 情景状态夹回每盏灯自己的色温 / 亮度范围：全关写死 3000K 撞上 4000K 单色灯会被后端 422 整单拦下。
      clampSceneStates(v);
      if (record && dRef.current) {
        history.current.push(clone(dRef.current));
        if (history.current.length > 70) history.current.shift();
        future.current = [];
      }
      dRef.current = v;
      stamp.current++;
      dirtyRef.current = true;
      setDirty(true);
      setD(v);
      setTick((t) => t + 1);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => flush().catch(() => {}), 800);
    },
    [flush],
  );
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    const unload = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", unload);
    return () => window.removeEventListener("beforeunload", unload);
  }, []);
  const undo = () => {
    const v = history.current.pop();
    if (v) {
      future.current.push(clone(dRef.current!));
      change(v, false);
    }
  };
  const redo = () => {
    const v = future.current.pop();
    if (v) {
      history.current.push(clone(dRef.current!));
      change(v, false);
    }
  };
  async function operation(path: string, body?: Obj, method = "POST") {
    await flush();
    const v = await api<Project>(`/projects/${id}${path}`, {
      method,
      body:
        body === undefined
          ? undefined
          : JSON.stringify({
              ...body,
              ...(path === "/reviews" ||
              path === "/recognition/replace" ||
              path === "/space-definition/confirm" ||
              path === "/requirements-baselines" ||
              path.endsWith("/recognize") || path.startsWith("/cooperation")
                ? { revision: pRef.current!.revision }
                : {}),
            }),
    });
    accept(v);
    return v;
  }
  return {
    p,
    d,
    saving,
    dirty,
    loadError,
    saveError,
    change,
    flush,
    accept,
    operation,
    undo,
    redo,
    canUndo: history.current.length > 0,
    canRedo: future.current.length > 0,
    tick,
    pRef,
  };
}
/** 面板刻字编辑器：4 键＝2 个大按键 × 2 个小按键；每键「短按」刻字（图标 / 2 字）＋「长按」功能（不刻字）。
 *  一块板只用一种形式（全图标 / 全文字 / 屏显免雕刻），口径见 ./panelRules。设备属性、「智能设备」页、智能情景共用。 */
function PanelKeyEditor({
  dev,
  scenes,
  room,
  disabled,
  onEdit,
}: {
  dev: Obj;
  scenes: Obj[];
  room?: Obj;
  disabled?: boolean;
  onEdit: (mutate: (d: Obj) => void) => void;
}) {
  const keys = Number(dev.keys) || PANEL_DEFAULT_KEYS;
  const mode: string = dev.engraveMode || "text";
  const model = panelModel(dev.productId);
  const noLong = !!model && !model.longPress;
  const engraveLong = !!model?.engraveLong;
  const textMax = panelTextMax(model);
  const iconWords = Object.keys(PANEL_RULES_ICONS);
  const issues = panelIssues(dev);
  const groups: number[][] =
    keys === 4 ? [[0, 1], [2, 3]] : Array.from({ length: keys }, (_, i) => [i]);
  const grouped = groups.length > 1 && groups[0].length > 1;
  const cell = (i: number, long: boolean) => {
    const press = PANEL_PRESSES[long ? 1 : 0];
    const labels: string[] = (long ? dev.keyLongLabels : dev.keyLabels) || [];
    const binds: string[] = (long ? dev.keyLongScenes : dev.keyScenes) || [];
    const engraved = !long || engraveLong;
    const what = !engraved ? "功能说明" : mode === "screen" ? "屏显文字" : "刻字";
    const setLabel = (v: string) =>
      onEdit((d) => {
        const arr = long ? d.keyLongLabels : d.keyLabels;
        arr[i] = v;
      });
    const bad = engraved && issues.some(([k, msg]) => k === i && msg.startsWith("长按") === long);
    return (
      <div className={`panel-cell${long ? " long" : ""}${bad ? " invalid" : ""}`} key={`${i}-${press}`}>
        <span className="panel-cell-press">{long && engraveLong ? "长按（下方刻字）" : press}</span>
        {engraved && mode === "icon" ? (
          <select
            disabled={disabled}
            aria-label={`第${i + 1}键${press}${what}`}
            value={labels[i] || ""}
            onChange={(e) => setLabel(e.target.value)}
          >
            <option value="">不刻（空键）</option>
            {labels[i] && !iconWords.includes(labels[i]) && <option value={labels[i]}>{labels[i]}（不在图标库）</option>}
            {iconWords.map((w) => (
              <option key={w} value={w}>{w} · {PANEL_RULES_ICONS[w]}</option>
            ))}
          </select>
        ) : (
          <input
            disabled={disabled || (long && noLong)}
            aria-label={`第${i + 1}键${press}${what}`}
            placeholder={long && noLong ? "此型号无长按" : !engraved ? "长按功能（不刻字）"
              : mode === "screen" ? "屏显文字（APP 设定）" : `${long ? "下方刻字，" : ""}${textMax} 字，如 主灯`}
            maxLength={engraved && mode === "text" ? textMax + 2 : undefined}
            value={labels[i] || ""}
            onChange={(e) => setLabel(e.target.value)}
          />
        )}
        <select
          disabled={disabled || (long && noLong)}
          aria-label={`第${i + 1}键${press}绑定情景`}
          value={binds[i] || ""}
          onChange={(e) =>
            onEdit((d) => {
              const arr = long ? d.keyLongScenes : d.keyScenes;
              arr[i] = e.target.value;
            })
          }
        >
          <option value="">{long ? "不绑定" : "回路键 / 不绑定情景"}</option>
          {scenes.map((sc) => (
            <option key={sc.id} value={sc.id}>
              {sc.name}
            </option>
          ))}
        </select>
      </div>
    );
  };
  const keyBlock = (i: number) => (
    <div className="panel-key-block" key={i}>
      <span className="panel-key-no">第 {i + 1} 键</span>
      {cell(i, false)}
      {cell(i, true)}
    </div>
  );
  return (
    <div className="panel-key-editor">
      <div className="panel-engrave-head">
        <label>刻字形式
          <select
            disabled={disabled || mode === "screen"}
            aria-label="刻字形式"
            value={mode}
            onChange={(e) => onEdit((d) => { d.engraveMode = e.target.value; })}
          >
            {ENGRAVE_MODES.filter((m) => m.value !== "screen" || mode === "screen").map((m) => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="secondary"
          disabled={disabled}
          title="按产品资料键位预算重排本面板刻字（会覆盖本面板现有刻字）"
          onClick={() => onEdit((d) => fillPanelKeysFor(scenes, d, room, true))}
        >
          按口径重排刻字
        </button>
        <small className="subtle">
          {mode === "screen"
            ? "屏显型号免雕刻：按键文字在 APP 设定，屏幕实时显示。"
            : `一块板只用一种形式：全图标（厂家图标库 10×10mm）或全文字（镂空限 ${textMax} 字）；${
              engraveLong ? "本型号上下双刻：长按文字刻在按键下方，同样受字数限制。" : "长按只做功能，不刻字。"}`}
          {roomTemplate(room).note ? ` ${roomTemplate(room).note}` : ""}
        </small>
      </div>
      <div className={`panel-keys${grouped ? " grouped" : ""}`}>
        {groups.map((grp, gi) =>
          grouped ? (
            <div className="panel-bigkey" key={gi}>
              <span className="panel-bigkey-label">大按键 {gi + 1}</span>
              <div className="panel-bigkey-keys">{grp.map((i) => keyBlock(i))}</div>
            </div>
          ) : (
            grp.map((i) => keyBlock(i))
          ),
        )}
      </div>
      {issues.length > 0 && (
        <ul className="panel-issues" aria-label="刻字口径提醒">
          {issues.map(([k, msg], j) => (
            <li key={j} className="error-text">{k >= 0 ? `第 ${k + 1} 键：` : ""}{msg}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Workspace({
  id,
  onClose,
  notify,
  products,
  sceneTemplates,
  health,
  shellV2 = false,
}: {
  id: string;
  onClose: () => void;
  notify: (s: string) => void;
  products: Obj[];
  sceneTemplates: Obj[];
  health: Obj;
  shellV2?: boolean;
}) {
  const w = useProject(id, notify);
  const [view3d, setView3d] = useState(true);
  // 拍板 2026-10-12（§十.8 + §十.11 施工清单第 3 项）：走「图纸」页导入 DXF 也要自动生成三维，
  // 生成完直接出**全屏「空间预览」**层，底部「确认」/「手动修改」两个按钮。
  const [spacePreview, setSpacePreview] = useState<Obj | null>(null);
  const [mergeTargetId, setMergeTargetId] = useState("");
  const [showCadWorkbench, setShowCadWorkbench] = useState(false);
  const [furnitureEditing, setFurnitureEditing] = useState(false);
  // 批 2（B2/B3/B5）：工具行分三层「主操作 / 收拢菜单 / 图标」。
  // 菜单一次只开一个；「添加」记本次会话上次用的类型（跨会话记忆＝新功能，不做）。
  const [toolMenu, setToolMenu] = useState<"" | "add" | "file">("");
  const [lastAddType, setLastAddType] = useState("");
  // 底图「确定」搬出工具行后，画布顶部那条提示关掉即本次会话不再出，重新导入图纸再出。
  const [planMaskBarClosed, setPlanMaskBarClosed] = useState(false);
  const [selectedFurnitureId, setSelectedFurnitureId] = useState("");
  const [placingFurniture, setPlacingFurniture] = useState("");
  const [movingFurniture, setMovingFurniture] = useState(false);
  const [legacyFurniture, setLegacyFurniture] = useState<Obj[]>([]);
  const [furnitureLoading, setFurnitureLoading] = useState(false);
  // 灯带折线（§十.10 口径②）：正在画的那段灯带的 id（第一点新建，之后每点追加拐点）。
  // 状态给界面看，ref 给事件用——连点两下时 React 状态还没落地，只读状态会各建一段。
  const [stripDrawId, setStripDrawId] = useState("");
  const stripDrawRef = useRef("");
  const [panelEditorOpen, setPanelEditorOpen] = useState(false);
  const { p, d, change, flush, operation } = w;
  // 新建项目弹窗跑完三维会带 ?spacePreview=1 进来：进来就直接开这一层（就地确认 / 修改）。
  const previewFlag = useRef((() => {
    if (new URLSearchParams(location.search).get("spacePreview") === "1") return true;
    try {
      if (sessionStorage.getItem("spacePreview") === "1") {
        sessionStorage.removeItem("spacePreview");
        return true;
      }
    } catch {}
    return false;
  })());
  const resumedPreview = useRef(false);
  useEffect(() => {
    if (!p?.id || resumedPreview.current) return;
    resumedPreview.current = true;
    const savedStep = d?.spaceDefinition?.workflowStep;
    // 家具这一步也要能续接：在「修改家具」中途关掉界面再回来，必须还回到家具核对，
    // 不能把人丢在画布里（2026-10-16 反馈「进度条与所在环节不匹配」）。
    const resume = ["spaces", "openings", "furniture"].includes(savedStep);
    if (!previewFlag.current && !resume) return;
    previewFlag.current = false;
    const params = new URLSearchParams(location.search);
    params.delete("spacePreview");
    history.replaceState(null, "", params.toString() ? `?${params.toString()}` : location.pathname);
    if (resume && d?.spaceDefinition?.editingFloor) setFloor(d.spaceDefinition.editingFloor);
    void openSpacePreview(resume ? savedStep : undefined);
  }, [p?.id]);
  const [tab, setTab] = useState("plan"),
    [v2Section, setV2Section] = useState("plan"),
    [v2Tree, setV2Tree] = useState(!!shellV2),
    [v2Insp, setV2Insp] = useState("属性"),
    [v2Delivery, setV2Delivery] = useState<"review"|"export">("review"),
    // D-10 C9：导出对象。默认「给业主」；2026-10-23 老板拍板取消去价红线 → owner 恢复保留零售价；
    // 只有「给施工（不含价）」由后端 audience=site 清 0，内部版保留参考价。
    [exportAudience, setExportAudience] = useState<"owner"|"site"|"internal">("owner"),
    // D-09：价格复核 422 的就地提示（后端 detail 原文）+「去批量核实」入口；D-10 B9 导出抽屉共用。
    [reviewError, setReviewError] = useState(""),
    [reviewErrorKey, setReviewErrorKey] = useState(""),
    [v2Preview, setV2Preview] = useState(""),
    [v2SecOpen, setV2SecOpen] = useState<Obj>(() => { try { return JSON.parse(localStorage.getItem("gv.tree.sections") || "{}") || {}; } catch { return {}; } }),
    [selection, setSelection] = useState<Selection>(null),
    [modal, setModal] = useState(""),
    [lampClipboard, setLampClipboard] = useState<Obj | null>(null),
    // 剪贴板里放的是哪一类对象（fixtures / devices / …）：粘贴时按类型还原，设备不会被粘成灯具。
    [clipKind, setClipKind] = useState("fixtures"),
    [lampType, setLampType] = useState("射灯"),
    [pasteCount, setPasteCount] = useState(0),
    [tool, setTool] = useState("select"),
    [floor, setFloor] = useState(1),
    [zoom, setZoom] = useState(1),
    [furniture, setFurniture] = useState(true),
    [lights, setLights] = useState(true),
    [labels, setLabels] = useState(true),
    [grid, setGrid] = useState(true),
    [source, setSource] = useState(false),
    [background, setBackground] = useState(""),
    [busy, setBusy] = useState(false),
    [activeScene, setActiveScene] = useState(""),
    [fadeTick, setFadeTick] = useState(0),
    // 智能情景草稿：场景里的改动先落在这里，点「保存场景」/「保存」才写回设计。
    [sceneDraft, setSceneDraft] = useState<Obj | null>(null),
    // 智能情景页改版（2026-10-19）：左栏搜索、右栏检查器页签、面板页当前选中的那块面板。
    [sceneQuery, setSceneQuery] = useState(""),
    [sceneInsp, setSceneInsp] = useState<"scene" | "circuit" | "lamp" | "panel">("scene"),
    [inspPanelId, setInspPanelId] = useState(""),
    [setupSel, setSetupSel] = useState<string[]>([]),
    [setupClear, setSetupClear] = useState(true),
    [spaceQuery, setSpaceQuery] = useState(""),
    [spaceTypical, setSpaceTypical] = useState(true),
    // 批 3（C3/C4/F7）：新增空间三步改两步——记住上次的分区，第二次打开直接落房间屏。
    [addSpaceOpen, setAddSpaceOpen] = useState(false),
    [addSpaceGroup, setAddSpaceGroup] = useState(""),
    [reviewer, setReviewer] = useState(""),
    [ack, setAck] = useState(false),
    [baselineNote, setBaselineNote] = useState(""),
    [events, setEvents] = useState<Obj[]>([]),
    [versions, setVersions] = useState<Obj[]>([]),
    [checked, setChecked] = useState<string[]>([]),
    [renderPreview, setRenderPreview] = useState(""),
    [offset, setOffset] = useState(20),
    [canvasReset, setCanvasReset] = useState(0),
    [focus, setFocus] = useState<{ x: number; y: number; token: number } | null>(null),
    [recognitionFile, setRecognitionFile] = useState("");

  // 2026-10-16：画布上选中家具/空间后，检视面板必须「明显可见」——滚到眼前并闪一下。
  const inspectorBody = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    revealFlash(inspectorBody.current);
  // W-4：不再依赖 selection?.id——每切一盏灯就重跑会把右栏滚回顶；保留 kind/家具位/编辑态。
  }, [selection?.kind, selectedFurnitureId, furnitureEditing]);
  const [lampSpace, setLampSpace] = useState("k");
  // 布灯目标房间：同类空间（两个次卧 / 多个门厅）时必须按房间选，不能只按空间码。
  const [lampRoomId, setLampRoomId] = useState("");
  const [lampPosition, setLampPosition] = useState("c");
  // 职能码是场景钩子：默认随位置给一个合理值，可手动改。
  const [lampRole, setLampRole] = useState(DEFAULT_ROLE_BY_POSITION["c"]);
  const [lampCount, setLampCount] = useState(1);
  // 布灯落点（画布上点选的位置）：非空时新灯就放在这里，而不是空间中心。
  const [placePoint, setPlacePoint] = useState<{ x: number; y: number } | null>(null);
  // 光源类型：单色 / 双色 / 彩色（灯带同样适用）；单色默认 3000K。
  // 手动布灯默认单色 3000K；改双色 / 彩色 / 非 3000K 必须写原因（进导出「原因」列）。
  const [lampColorMode, setLampColorMode] = useState<ColorMode>("单色");
  const [lampSingleCct, setLampSingleCct] = useState<number>(SINGLE_CCT_DEFAULT);
  const [lampCctReason, setLampCctReason] = useState("");
  const lampNeedsReason = lampColorMode !== "单色" || lampSingleCct !== SINGLE_CCT_DEFAULT;
  // 添加设备 / 传感器 / 窗帘：先选类型与空间再落到图纸（楼层跟当前页，空间只列本层，与布灯一致）。
  const [addObject, setAddObject] = useState<"" | "device" | "curtain">("");
  const [addType, setAddType] = useState("传感器");
  const [addName, setAddName] = useState("");
  const [addRoomId, setAddRoomId] = useState("");
  const [addMotor, setAddMotor] = useState("单电机");
  // 设备位置（家具/功能位，随空间取表；不填也能用）。
  const [addPositionCode, setAddPositionCode] = useState("");
  // 传感器关联灯具的分步选择：先楼层（多层）/ 先区域（平层），再看灯具。
  const [linkFloor, setLinkFloor] = useState(1);
  // 正在手动调整探测范围的传感器（画布上显示可拖顶点）+ 当前选中的顶点序号（-1 = 未选）
  const [coverageEdit, setCoverageEdit] = useState("");
  const [coverageSel, setCoverageSel] = useState(-1);
  const [linkSpace, setLinkSpace] = useState("");
  // 图层：灯具层 / 设备层两层就够（面板与灯具叠在一起时，关掉设备层即可单独看灯、单独动灯）。
  const [fixtureLayer, setFixtureLayer] = useState(
    () => localStorage.getItem("gv.layer.fixtures") !== "0",
  );
  const [deviceLayer, setDeviceLayer] = useState(
    () => localStorage.getItem("gv.layer.devices") !== "0",
  );
  // 小人漫游（底图与空间）：在画布上拖动小人，走进传感器范围就点亮其关联灯具。
  const [roamOn, setRoamOn] = useState(false);
  const [roamPos, setRoamPos] = useState({ x: 410, y: 345 });
  // 漫游所在楼层：多层项目在「智能情景」里所有楼层同屏，小人跟被拖动的那张画布走，
  // 而不是永远只出现在「底图与空间」的当前楼层上。
  const [roamFloor, setRoamFloor] = useState(1);
  // 灯具分组：清单筛选与批量分组。
  const [groupFilter, setGroupFilter] = useState("");
  const [groupDraft, setGroupDraft] = useState("");
  // 上传图纸的所属楼层（每张图纸＝一层）。
  const [uploadFloor, setUploadFloor] = useState(1);
  // 楼层设置（地上/地下）：地下室不用负数，最下面的几层就是 B1、B2…
  const [levelAbove, setLevelAbove] = useState(1);
  const [levelBasements, setLevelBasements] = useState(0);
  // 已上传图纸各自的楼层（用于逐张按楼层识别）。
  const [fileFloors, setFileFloors] = useState<Record<string, number>>({});
  useEffect(() => {
    if (coverageEdit && selection?.id !== coverageEdit) {
      setCoverageEdit("");
      setCoverageSel(-1);
    }
  }, [selection?.id, coverageEdit]);
  useEffect(() => {
    try { localStorage.setItem("gv.layer.fixtures", fixtureLayer ? "1" : "0"); } catch { /* 隐私模式下忽略 */ }
  }, [fixtureLayer]);
  useEffect(() => {
    try { localStorage.setItem("gv.layer.devices", deviceLayer ? "1" : "0"); } catch { /* 隐私模式下忽略 */ }
  }, [deviceLayer]);

  // 小人漫游只在 2D 平面图上有意义（2026-10-18 定）：一旦回到 3D 视图就自动退出漫游，
  // 免得「3D 里没有小人，灯却还按漫游亮着」（右上角「返回主画布 3D 模型」等入口都走这条兜底）。
  useEffect(() => {
    if (roamOn && p?.mode === "3D" && view3d) {
      setRoamOn(false);
      notify("小人漫游只在 2D 平面图上演示，已退出漫游并回到 3D 模型");
    }
  }, [roamOn, view3d, p?.mode]);
  // batch4 C8：危险操作统一确认弹窗（替代各处 window.confirm；同一套标题/正文/按钮样式）。
  const [dangerAsk, setDangerAsk] = useState<{ title: string; detail?: string; run: () => void } | null>(null);
  const askDanger = (title: string, run: () => void, detail?: string) => setDangerAsk({ title, detail, run });
  // batch4 B7：旧壳 5 个页签在 390 下横向滚动，左右渐隐提示由滚动位置驱动。
  const tabbarScrollRef = useRef<HTMLDivElement>(null);
  const [tabFade, setTabFade] = useState({ l: false, r: false });
  function syncTabFade() {
    const el = tabbarScrollRef.current;
    if (!el) return;
    const l = el.scrollLeft > 4;
    const r = el.scrollLeft + el.clientWidth < el.scrollWidth - 4;
    setTabFade((prev) => (prev.l === l && prev.r === r ? prev : { l, r }));
  }
  useEffect(() => {
    syncTabFade();
    const onResize = () => syncTabFade();
    window.addEventListener("resize", onResize);
    const timer = setTimeout(syncTabFade, 350);
    return () => {
      window.removeEventListener("resize", onResize);
      clearTimeout(timer);
    };
  }, [tab, shellV2]);
  useEffect(() => {
    const el = tabbarScrollRef.current;
    if (!el) return;
    const btn = el.querySelector<HTMLButtonElement>(`[data-tab="${tab}"]`);
    if (btn) btn.scrollIntoView({ block: "nearest", inline: "nearest" });
    syncTabFade();
  }, [tab]);
  // 慢加载兜底：项目数据晚到时页签条才挂载，首次 effect 可能早于它；每次渲染后重算一次渐隐状态
  // （syncTabFade 内部同值不 setState，不会循环）。
  useEffect(() => {
    syncTabFade();
  });
  const uploadRef = useRef<HTMLInputElement>(null);
  const iesRef = useRef<HTMLInputElement>(null);
  const effectUploadRef = useRef<HTMLInputElement>(null);
  const currentRecognition =
    p?.files.find((f) => f.id === recognitionFile)?.recognition ||
    p?.recognition;
  // Imported drawings are converted into the clean colour-plan canvas by default.
  // 切换项目时把底图恢复成「按楼层自动」，由下面的 backgroundUrl 解析。
  useEffect(() => {
    setBackground("");
  }, [id, d?.baseFileId, d?.spaceDefinition?.status]);
  // 切换情景、情景集合变化、或设计里的情景内容被别处改动时，都丢弃未保存的草稿：
  // 这样「灯具配置」里的一键修正色温、按编号同步情景等结果会立刻体现在智能情景，
  // 同时未点「保存场景」的临时调整不会写进任何场景。
  const liveSceneKey = JSON.stringify(
    (d?.scenes || []).find((s) => s.id === activeScene) || (d?.scenes || [])[0] || null,
  );
  useEffect(() => {
    setSceneDraft(null);
  }, [activeScene, liveSceneKey]);
  const locked = !!p && (p.frozen || p.status === "已归档");
  // 智能方案：无线（飞利浦）/ KNX 总线 / 无（灯具按回路开闭）。
  const smart = p?.smart || "无线";
  const noSmart = smart === "无";
  // 不做智能：情景页按回路展示。回路跨楼层聚合（同一层内同回路编号＝一条回路）。
  const circuitGroups: {
    key: string;
    name: string;
    floor: number;
    fixtures: Obj[];
    rooms: string[];
  }[] = (() => {
    const out: {
      key: string;
      name: string;
      floor: number;
      fixtures: Obj[];
      rooms: string[];
    }[] = [];
    if (!d) return out;
    const map = new Map<string, (typeof out)[number]>();
    d.fixtures.filter(isSceneLight).forEach((f) => {
      const name = circuitOf(f);
      const fl = Number.isFinite(f.floor) ? Number(f.floor) : 1;
      const key = fl + "::" + name;
      let g = map.get(key);
      if (!g) {
        g = { key, name, floor: fl, fixtures: [], rooms: [] };
        map.set(key, g);
        out.push(g);
      }
      g.fixtures.push(f);
      const rn = f.space || d.rooms.find((r) => r.id === f.roomId)?.name || "未分配";
      if (!g.rooms.includes(rn)) g.rooms.push(rn);
    });
    return out.sort((a, b) => a.floor - b.floor || a.name.localeCompare(b.name));
  })();
  // 色温异常：逐灯列出，供「灯具配置」显示 + 定位修改。
  const cctIssues = (d?.fixtures || [])
    .map((f) => ({ fixture: f, reasons: cctIssuesOf(f, d?.scenes || []) }))
    .filter((x) => x.reasons.length);
  const cctIssueMap = new Map(cctIssues.map((x) => [x.fixture.id, x.reasons] as const));
  // 色温待核（导入 / 产品资料缺色温）与「偏离 3000K 单色却没写原因」两张清单，导出前列出。
  // 窗帘不是灯，不进两张色温清单。
  const cctPendingList = (d?.fixtures || []).filter((f) => isSceneLight(f) && isCctPending(f));
  const cctReasonMissing = (d?.fixtures || []).filter(
    (f) => isSceneLight(f) && cctNeedsReason(f) && !String(f.cctReason || "").trim(),
  );
  const cctChecklist = (where: string) =>
    (cctPendingList.length > 0 || cctReasonMissing.length > 0) && (
      <div className="notice cct-warn" role="status" aria-label={"色温待核清单 · " + where}>
        <AlertCircle size={17} />
        <div>
          {cctPendingList.length > 0 && (
            <>
              <b>色温{CCT_PENDING_LABEL} {cctPendingList.length} 盏</b>
              <span>导入 / 产品资料没给色温，暂按 3000K 占位，导出清单标「{CCT_PENDING_LABEL}」。</span>
              <ul className="cct-warn-list">
                {cctPendingList.slice(0, 12).map((f) => (
                  <li key={f.id}>
                    <b>{f.code}</b>
                    <em>{f.name}</em>
                    <button className="text-link" onClick={() => locateFixture(f)}>
                      定位 <ChevronRight size={13} />
                    </button>
                  </li>
                ))}
                {cctPendingList.length > 12 && <li>…等共 {cctPendingList.length} 盏</li>}
                </ul>
            </>
          )}
          {cctReasonMissing.length > 0 && (
            <>
              <b>偏离 3000K 单色未写原因 {cctReasonMissing.length} 盏</b>
              <ul className="cct-warn-list">
                {cctReasonMissing.slice(0, 12).map((f) => (
                  <li key={f.id}>
                    <b>{f.code}</b>
                    <em>{cctText(f)}</em>
                    <button className="text-link" onClick={() => locateFixture(f)}>
                      定位 <ChevronRight size={13} />
                    </button>
                  </li>
                ))}
                {cctReasonMissing.length > 12 && <li>…等共 {cctReasonMissing.length} 盏</li>}
                </ul>
            </>
          )}
        </div>
      </div>
    );
  const issuesOf = (fid: string): string[] => cctIssueMap.get(fid) || [];
  const selected =
    d && selection
      ? d[selection.kind].find((x) => x.id === selection.id)
      : null;
  const liveScene = d?.scenes.find((s) => s.id === activeScene) || d?.scenes[0];
  // 智能情景编辑先落在草稿：未点「保存场景」/「保存」前，设计里的场景不做任何改变。
  const scene: Obj | undefined =
    sceneDraft && liveScene && sceneDraft.id === liveScene.id
      ? sceneDraft
      : liveScene;
  // 有未保存的情景改动（草稿）＝只有点「保存场景」/「保存」才会写进设计。
  const sceneDirty = !!sceneDraft && scene === sceneDraft;
  // 画布固定读数：单击灯具时显示 编号 / 灯具类型 / 功率（HTML 层，缩放/平移都不影响）；
  // 定向照射的灯具再补一段 光束角 + 地面光斑直径，装饰型灯具（吊灯/壁灯/台灯…）只显示前三个。
  const spotFixture: Obj | null =
    selection?.kind === "fixtures" &&
    selected &&
    (Number.isFinite(selected.floor)
      ? Number(selected.floor)
      : (d?.rooms.find((r) => r.id === selected.roomId)?.floor ?? 1)) === floor
      ? selected
      : null;
  const hasBeam = (f: Obj | null): f is Obj =>
    !!f && f.type !== "灯带" && f.type !== "窗帘" && !isDecorativeLight(f.type);
  const spaceDraft = d?.spaceDefinition?.status === "draft";
  const spaceConfirmed = d?.spaceDefinition?.status === "confirmed";
  // 本项目有哪些空间：由房间（含编号建立的无边界空间）反推，去重。
  const projectSpaces: { code: string; name: string }[] = (() => {
    const seen: { code: string; name: string }[] = [];
    (d?.rooms || []).forEach((r) => {
      const sc = roomSpaceCodeOf(r);
      if (sc && !seen.some((x) => x.code === sc.code))
        seen.push({ code: sc.code, name: sc.name });
    });
    return seen;
  })();
  // 底图跟随楼层：每张图纸记录自己的楼层（meta.floor），切换楼层就换成那一层的图纸。
  // background 只表示「手动覆盖」："" = 按当前楼层自动，"__none__" = 强制隐藏，其余＝指定图纸 URL。
  const filesWithFloor = (p?.files || []).filter((f) => f.floor);
  const floorFile =
    (p?.files || []).find((f) => Number(f.floor) === floor && f.preview) ||
    // 旧数据没有楼层信息时退回项目底图，避免底图整个消失。
    (filesWithFloor.length === 0
      ? (p?.files || []).find((f) => f.id === d?.baseFileId && f.preview) ||
        (p?.files || []).find((f) => f.preview)
      : undefined);
  const backgroundUrl =
    background === "__none__"
      ? ""
      : background ||
        (floorFile
          ? `/api/projects/${id}/files/${floorFile.id}?preview=true`
          : "");
  // B5 同源化（批 5）：与 <Plan> 的 background 取同一表达式，再叠预览闸门（4202 预览态没画图，不许出假条）。
  const canvasBackgroundUrl = spaceConfirmed && !background ? "" : backgroundUrl;
  const planMaskShown = !spacePreview && !!canvasBackgroundUrl && d?.planMasked !== false;
  // 逐层底图：智能情景页会把每一层同时画出来，每张画布必须用「自己那一层」的图纸。
  // 以前这里统一传当前楼层的底图，多层项目就会所有楼层显示同一张图
  // （反馈的「楼层数量对、六层楼都是同一层的图纸」）。
  const backgroundUrlFor = (floorNo: number) => {
    if (background === "__none__") return "";
    // 手动指定底图只作用于当前楼层，其他楼层仍按各自的图纸走。
    if (background && floorNo === floor) return background;
    const own = (p?.files || []).find(
      (f) => Number(f.floor) === floorNo && f.preview,
    );
    if (own) return `/api/projects/${id}/files/${own.id}?preview=true`;
    // 老数据没有楼层信息时不按层拆：退回项目底图，避免底图整个消失。
    if ((p?.files || []).some((f) => f.floor)) return "";
    const fallback =
      (p?.files || []).find((f) => f.id === d?.baseFileId && f.preview) ||
      (p?.files || []).find((f) => f.preview);
    return fallback ? `/api/projects/${id}/files/${fallback.id}?preview=true` : "";
  };

  // 无边界空间（按编号定位）：画布几何相关的属性对它没有意义。
  const roomNoGeometry =
    selection?.kind === "rooms" &&
    !!selected &&
    (selected.source === "fixture-code" ||
      selected.source === "semantic-labels" ||
      (Number(selected.width) <= 1 && Number(selected.height) <= 1));

  // 灯具分组（用于清单筛选与批量分组）。
  const fixtureGroups: string[] = Array.from(
    new Set(
      (d?.fixtures || [])
        .map((f) => (f.group || "").trim())
        .filter(Boolean),
    ),
  ).sort() as string[];
  // 窗帘不进灯具清单，列在「智能设备」区。
  const lightFixtures = (d?.fixtures || []).filter(isSceneLight);
  const curtainFixtures = (d?.fixtures || []).filter((f) => !isSceneLight(f));
  const fixtureRows = lightFixtures.filter((f) => {
    if (!groupFilter) return true;
    const g = (f.group || "").trim();
    return groupFilter === "__none__" ? !g : g === groupFilter;
  });

  // 空间增减都必须联动智能情景层：这里按当前空间重算可用情景。
  function spaceCodesOf(n: Design): string[] {
    const out: string[] = [];
    (n.rooms || []).forEach((r) => {
      const sc = roomSpaceCodeOf(r);
      if (sc && !out.includes(sc.code)) out.push(sc.code);
    });
    return out;
  }
  // 已有标准情景：模板不再属于本项目空间就移除；新空间带来的标准情景自动补齐；
  // 自定义情景（无 templateCode）不受影响。
  function syncScenesToSpaces(n: Design): { removed: number; added: number } {
    const codes = spaceCodesOf(n);
    const defByCode = new Map(ALL_SCENES.map((x) => [x.code, x]));
    const before = n.scenes.length;
    // 只移除「明确绑定空间、且这些空间已全部不存在」的标准情景：未绑定空间的
    // 情景、其它模板体系（如后端 scene-templates 的 00.x/01.x）、自定义情景一律保留。
    n.scenes = n.scenes.filter((sc) => {
      if (!sc.templateCode) return true;
      const def = defByCode.get(sc.templateCode);
      if (!def) return true; // 非场景包模板（如后端 scene-templates）：不在这里动
      const home = sceneHomeSpaceCode(def);
      if (!home) return true; // 全屋级
      return codes.includes(home);
    });
    const removed = before - n.scenes.length;
    let added = 0;
    // 只有已经在用「场景包（标准情景）」这套模板的项目，才按新空间补齐，
    // 避免把两套模板体系混在一起。
    const pkgCodes = new Set(PACKAGE_TEMPLATES.map((t) => t.code));
    if (n.scenes.some((sc) => sc.templateCode && pkgCodes.has(sc.templateCode))) {
      const keep = new Set(
        availableScenes(p?.type || "平层", codes).map((x) => x.code),
      );
      const have = new Set(n.scenes.map((sc) => sc.templateCode));
      PACKAGE_TEMPLATES.forEach((t) => {
        if (!keep.has(t.code) || have.has(t.code)) return;
        const label = t.code + " " + t.name;
        const states: Obj = {};
        n.fixtures.forEach((f) => {
          const parsed = parseFixtureCode(f.code || "");
          if (!parsed) return;
          const st = standardSceneState(label, { ...parsed, explicitRole: true }, f);
          if (st) states[f.id] = st;
        });
        n.scenes.push({
          id: uid(),
          templateId: t.id,
          templateCode: t.code,
          name: label,
          description: `${SCENE_PACKAGE.name} · ${t.description}`,
          trigger: t.trigger,
          mode: "standard",
          fade: t.fade,
          priority: t.priority,
          level: t.level,
          exit: t.exit,
          exclude: t.exclude,
          automationActions: [],
          states,
          standard: true,
        });
        added += 1;
      });
    }
    return { removed, added };
  }
  // 「底图与空间」页内联新增空间（按空间码建立，布灯编号直接可用）。
  function addSpaceByCode(code: string) {
    const sc = SPACE_CODES.find((x) => x.code === code);
    if (!sc) return;
    const summary = { removed: 0, added: 0 };
    let createdName = sc.name;
    update((n) => {
      createdName = nextSpaceName(n.rooms, sc.name);
      const room = spaceContainer(n, createdName, floor);
      room.spaceCode = sc.code;
      // 空间不需要画边界：名称 + 灯具编号（如 kc001）已经定位，情景按编号生成。
      Object.assign(summary, syncScenesToSpaces(n));
    });
    notify(
      `已新增空间「${createdName}」（无需画边界，位置由灯具编号体现）；智能情景层同步：+${summary.added} 个可用情景` +
        (summary.removed ? `，清理 ${summary.removed} 个不再适用的情景` : ""),
    );
  }
  // 删除一个空间（按房间 id，避免两个「次卧」互相误删）：仍有灯具时先提示；删除后同步情景层。
  function removeSpaceById(roomId: string) {
    if (!d) return;
    const room = d.rooms.find((r) => r.id === roomId);
    if (!room) return;
    const name = room.name || "空间";
    if (d.fixtures.some((f) => f.roomId === roomId)) {
      notify(`「${name}」还有灯具，先移走灯具再删除空间`);
      return;
    }
    askDanger(`删除空间「${name}」？`, () => {
      const summary = { removed: 0, added: 0 };
      update((n) => {
        n.devices.filter((v) => v.roomId === roomId).forEach((v) => (v.roomId = ""));
        n.rooms = n.rooms.filter((r) => r.id !== roomId);
        Object.assign(summary, syncScenesToSpaces(n));
      });
      setSelection(null);
      notify(
        `已删除空间「${name}」；智能情景层同步：清理 ${summary.removed} 个不再适用的情景` +
          (summary.added ? `，+${summary.added} 个可用情景` : ""),
      );
    }, "该空间的设备会一并解除归属。");
  }
  // 同类空间「－」：移除该类型的最后一个（保留前面几个不动）。
  function removeLastSpaceOfCode(code: string) {
    const rooms = (d?.rooms || []).filter(
      (r) => roomSpaceCodeOf(r)?.code === code,
    );
    if (!rooms.length) return;
    removeSpaceById(rooms[rooms.length - 1].id);
  }
  // 布灯目标：同类空间可以有多个，按房间（而不是空间码）选，避免落到别的次卧/门厅。
  const placeRooms = (d?.rooms || []).filter((r) => r.floor === floor);
  const lampRoom = (d?.rooms || []).find((r) => r.id === lampRoomId);
  const lampSpaceCode = (lampRoom ? roomSpaceCodeOf(lampRoom)?.code : lampSpace) || lampSpace;
  const lampSpaceName = SPACE_CODES.find((s) => s.code === lampSpaceCode)?.name || "其他空间";
  // 位置按空间取表：布灯/设备的「位置」下拉只列该空间的家具与功能位。
  const lampPositions = groupedPositionsForSpace(lampSpaceCode);
  const addRoomForPosition = (d?.rooms || []).find((r) => r.id === addRoomId);
  const addSpaceCode = (addRoomForPosition ? roomSpaceCodeOf(addRoomForPosition)?.code : "") || "x";
  const addSpaceName = SPACE_CODES.find((s) => s.code === addSpaceCode)?.name || "其他空间";
  const addPositions = groupedPositionsForSpace(addSpaceCode);
  // 图层开关：底图与布灯、情景演示共用一套状态。
  const layerSwitch = (
    <div className="layer-switch" title="图层开关：灯具与设备（面板）叠在一起时，关掉设备层就能单独看灯、单独拖灯" data-fid="D-63">
      <span>图层</span>
      <button
        className={fixtureLayer ? "active" : ""}
        onClick={() => setFixtureLayer((v) => !v)}
        title="显示/隐藏灯具层" data-fid="D-64"
      >
        <Lightbulb size={13} /> 灯具 {(d?.fixtures || []).filter(isSceneLight).length}
      </button>
      <button
        className={deviceLayer ? "active" : ""}
        onClick={() => setDeviceLayer((v) => !v)}
        title="显示/隐藏设备层（面板、传感器、网关等）" data-fid="D-65"
      >
        <Plus size={13} /> 设备 {d?.devices?.length ?? 0}
      </button>
    </div>
  );
  const openFiles = () => {
    setToolMenu("");
    setPlanMaskBarClosed(false); // 重新导入图纸 → 底图提示重新出现（B5：关掉只管本次会话）
    setUploadFloor(floor);
    setLevelAbove(aboveFloors(p?.floors, p?.basements));
    setLevelBasements(safeBasements(p?.basements, p?.floors));
    setFileFloors(
      Object.fromEntries(
        (p?.files || []).map((f: Obj) => [f.id, Number(f.floor) || floor]),
      ),
    );
    setModal("files");
  };
  // 换空间＝换位置表：把当前位置收敛到该空间的家具/功能位，职能跟着位置的默认值走。
  function selectPlaceSpace(code: string) {
    setLampSpace(code);
    const list = positionsForSpace(code);
    const keep = list.some((p) => p.code === lampPosition) ? lampPosition : list[0]?.code || "q";
    setLampPosition(keep);
    setLampRole(defaultRoleForPosition(code, keep));
  }
  // 灯带折线（§十.10 口径②；实测 2026-10-12 认可）：
  // 「灯带 ＝ 折线工具量长度」——在画布上依次点拐点，每点一下接一段，长度按各段之和自动量；
  // 「直接填米数」的入口保留（灯具属性里的「灯带长度 m」，折线会等比缩放、不被打直）。
  const openStripDraw = () => {
    if (tool === "draw-strip") {
      finishStripDraw();
      return;
    }
    setAddObject("");
    setShowCadWorkbench(false);
    setPlacePoint(null);
    stripDrawRef.current = "";
    setStripDrawId("");
    setTool("draw-strip");
    notify("画灯带：在图纸上依次点拐点，点一下接一段；点「完成灯带」结束（长度按折线自动量）");
  };
  function finishStripDraw() {
    const f = (d?.fixtures || []).find((v) => v.id === (stripDrawRef.current || stripDrawId));
    setTool("select");
    stripDrawRef.current = "";
    setStripDrawId("");
    setPlacePoint(null);
    if (f) {
      notify(
        `灯带画好了：${Math.max(1, (f.stripPath?.length || 2) - 1)} 折 · ${stripLengthMetres(f)} m；` +
          "要改可拖两端手柄，或直接在灯具属性里填「灯带长度 m」",
      );
    } else {
      notify("已退出画灯带（这一段没落笔）");
    }
  }
  // 每点一下：还没起笔就新建一段灯带，起了笔就往那段上接一个拐点。
  function appendStripPoint(x: number, y: number) {
    const cur = stripDrawRef.current || stripDrawId;
    let created = "";
    update((n) => {
      if (cur) {
        const f = n.fixtures.find((v) => v.id === cur);
        if (f) {
          const path = f.stripPath || [];
          // 新建时先写一个 1 单位的占位段（后端要求灯带≥2 点）；第二个点落下就顶掉它。
          const placeholder =
            path.length === 2 &&
            Math.hypot(path[0].x - path[1].x, path[0].y - path[1].y) <= 2;
          f.stripPath = placeholder ? [path[0], { x, y }] : [...path, { x, y }];
          f.length = stripLengthFromPath(f.stripPath);
          return;
        }
      }
      const room =
        n.rooms.find(
          (r) => r.floor === floor && x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height,
        ) || n.rooms.find((r) => r.floor === floor);
      const sc = (room ? roomSpaceCodeOf(room)?.code : "") || "x";
      const id = uid();
      created = id;
      n.fixtures.push({
        id,
        code: buildFixtureCode(sc, "q", nextSerial(n.fixtures, sc, "q", "D"), "D"),
        role: "D",
        position: "q",
        space: sc,
        name: "灯带",
        model: "",
        // 品牌不猜：无线走飞利浦（型号随清单接），总线/无智能留「待选型」。
        brand: "待选型",
        type: "灯带",
        roomId: room?.id || "",
        floor,
        x,
        y,
        installHeight: (room ? voidInstallHeight(room) : undefined) ?? 2.8,
        beamAngle: defaultBeamAngle("灯带"),
        power: 7,
        lumen: 0,
        brightnessMax: 100,
        cct: SINGLE_CCT_DEFAULT,
        cctMin: SINGLE_CCT_DEFAULT,
        cctMax: SINGLE_CCT_DEFAULT,
        colorMode: "单色",
        colorHue: 0,
        colorHex: "",
        group: "",
        control: smart === "无" ? "开关控制" : smart === "无线" ? "蓝牙 Mesh" : "KNX",
        circuit: room ? circuitForRoom(n, room) : "",
        dimmable: true,
        tunable: true,
        quote: true,
        price: 0,
        priceVerified: false,
        source: "manual",
        notes: "",
        stripRotation: 0,
        stripPath: [{ x, y }, { x: x + 1, y }],
        // 灯带每段必须有独立电源与控制关系，否则自检（第⑤步）会挡提交——与布灯同一口径。
        powerSupply: "PS-" + uid(),
        controller: "CTL-" + uid(),
        channel: "",
        address: "",
        length: 0.04,
      });
    });
    if (created) {
      stripDrawRef.current = created;
      setStripDrawId(created);
    }
    setPlacePoint({ x, y });
  }

  /** 布灯 / 放设备一律在二维平面上做（2026-10-17 定）：三维只用来看。
   *  在三维视图里点了放置，先切到平面图。返回 true＝刚切过去。 */
  const toPlanForPlacing = () => {
    // 「灯具配置」等页签上没有画布：先回到「底图与空间」的平面图，否则进了布灯模式也没处点。
    // 平面图现在恒为二维，不用再切 view3d（view3d 只决定「智能情景」页看三维还是看平面）。
    const elsewhere = tab !== "plan";
    if (elsewhere) setTab("plan");
    return elsewhere;
  };
  // 布灯＝「点哪放哪」：先进布灯模式，在画布上点一下确定落点，再弹窗选空间/位置/编号。
  const openPlace = () => {
    // 再点一次＝退出布灯，只在画布页上算数；在别的页签上点＝带回画布继续布灯。
    if (tool === "place-lamp" && tab === "plan") {
      setTool("select");
      setPlacePoint(null);
      notify("已退出布灯模式");
      return;
    }
    setAddObject("");
    // CAD 生成工作台不接收主画布的放置落点；切回可交互的模型再进入放置模式。
    setShowCadWorkbench(false);
    const first = (d?.rooms || []).find((r) => r.floor === floor);
    setLampRoomId(first ? first.id : "");
    if (first) {
      const meta = roomSpaceCodeOf(first);
      if (meta) setLampSpace(meta.code);
    }
    setPlacePoint(null);
    setTool("place-lamp");
    notify((toPlanForPlacing() ? "布灯在平面图上进行，已切到 2D 平面；" : "") + "在图纸上点击要放灯的位置，再在弹出的对话框里选空间与位置");
  };
  // 添加设备 / 传感器 / 窗帘＝与布灯相同的「点哪放哪」：先进入放置模式，
  // 在画布上点一下确定落点（空间自动跟着落点所在空间），再弹窗确认类型 / 名称。
  const openAddDevice = (type: string) => {
    if (tool === "place-device" && addObject === "device" && addType === type) {
      exitAddMode();
      notify("已退出添加模式");
      return;
    }
    const first = (d?.rooms || []).find((r) => r.floor === floor);
    setShowCadWorkbench(false);
    setAddType(type);
    setAddName(DEFAULT_DEVICE_NAME[type] || "");
    setAddRoomId(first ? first.id : "");
    setPlacePoint(null);
    setAddObject("device");
    setTool("place-device");
    const wall = type === "面板" || type === "温控器";
    notify((toPlanForPlacing() ? "放置在平面图上进行，已切到 2D 平面；" : "") +
      `添加${type}：${wall ? "在墙边点击（会贴到最近的墙上）" : "在图纸上点击要放的位置"}，再在对话框里确认类型与名称`);
  };
  const openAddCurtain = () => {
    if (tool === "place-device" && addObject === "curtain") {
      exitAddMode();
      notify("已退出添加模式");
      return;
    }
    const first = (d?.rooms || []).find((r) => r.floor === floor);
    setShowCadWorkbench(false);
    setAddMotor("单电机");
    setAddRoomId(first ? first.id : "");
    setPlacePoint(null);
    setAddObject("curtain");
    setTool("place-device");
    notify((toPlanForPlacing() ? "放置在平面图上进行，已切到 2D 平面；" : "") + "添加窗帘：在图纸上点击窗帘要放的位置，再在对话框里确认电机与空间");
  };
  // 「添加」菜单（B3）：3 项；记住本次会话上次用的类型，再次打开时该项打勾。
  // 首用没有「上次」→ 不打勾（「灯具」是主操作「放置灯具」，不在这 3 项里）。
  const pickAddType = (type: string) => {
    setToolMenu("");
    setLastAddType(type);
    if (type === "窗帘") openAddCurtain();
    else openAddDevice(type);
  };
  // 退出「添加设备 / 窗帘」放置模式（不动已经放好的对象）。
  function exitAddMode() {
    setAddObject("");
    setPlacePoint(null);
    setTool("select");
  }

  // 按「户型（房型）+ 本项目空间」筛出可用场景；用不上的场景单独留着做透明展示。
  // 管理空间：按「分区」分组，可按房型过滤 + 按名称/空间码/别名搜索。
  const spaceQueryText = spaceQuery.trim();
  const spaceGroupsShown = GROUPED_SPACES.map((g) => ({
    group: g.group,
    spaces: g.spaces.filter(
      (s) =>
        (!spaceTypical || s.houses.includes((p?.type || "平层") as HouseType)) &&
        (!spaceQueryText ||
          s.name.includes(spaceQueryText) ||
          s.code.startsWith(spaceQueryText.toLowerCase()) ||
          (s.aliases || []).some((a) => a.includes(spaceQueryText))),
    ),
  })).filter((g) => g.spaces.length > 0);
  // 批 3（C3/C4）：新增空间浮层的分区表——按项目户型过滤；户型为空列全部 14 个并在屏顶注明。
  const addSpaceHouse = (p?.type || "").trim();
  const addSpaceGroups = GROUPED_SPACES.map((g) => ({
    group: g.group,
    spaces: g.spaces.filter((s) => !addSpaceHouse || s.houses.includes(addSpaceHouse as HouseType)),
  })).filter((g) => g.spaces.length > 0);
  const addSpaceActive = addSpaceGroups.find((g) => g.group === addSpaceGroup);
  // 批 3（E3/E4）：「这个项目还差什么」只认两项——无回路、未绑定面板。数字只用来决定显隐，不上界面。
  const gapNoCircuit = lightFixtures.filter((f) => !String(f.circuit || "").trim());
  const gapUnboundPanels = (d?.devices || []).filter((v) => {
    if (v.type !== "面板") return false;
    const short = (Array.isArray(v.keyScenes) ? v.keyScenes : []).filter(Boolean);
    const long = (Array.isArray(v.keyLongScenes) ? v.keyLongScenes : []).filter(Boolean);
    return short.length + long.length === 0;
  });
  // 批 3（D4）：画布右下角本层读数——灯具按 isSceneLight，设备楼层口径与「面板」页签一致。
  const floorLights = (d?.fixtures || []).filter(
    (f) => isSceneLight(f) && (Number.isFinite(f.floor) ? f.floor : d?.rooms.find((r) => r.id === f.roomId)?.floor || 1) === floor,
  ).length;
  const floorDevices = (d?.devices || []).filter(
    (v) => (Number.isFinite(v.floor) ? v.floor : d?.rooms.find((r) => r.id === v.roomId)?.floor || 1) === floor,
  ).length;
  const usableScenes = availableScenes(p?.type || "平层", projectSpaces.map((s) => s.code));
  const unusableScenes = excludedScenes(p?.type || "平层", projectSpaces.map((s) => s.code));
  const toggleSetupScene = (code: string) => {
    const list = [...setupSel];
    const i = list.indexOf(code);
    if (i >= 0) list.splice(i, 1);
    else list.push(code);
    setSetupSel(list);
  };
  const openSceneSetup = () => {
    setSetupSel(usableScenes.map((s) => s.code));
    setSetupClear(true);
    setModal("scene-setup");
  };
  const run = async (fn: () => Promise<any>, message = "已保存") => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
      if (message) notify(message);
    } catch (e: any) {
      notify(e.message);
    } finally {
      setBusy(false);
    }
  };
  // D-09：复核签名把后端 422 的 detail 原文留在弹窗里（不吞错、不换泛泛提示）；
  // 价格门被拦时由弹窗给出「去批量核实」入口。
  const submitReview = async (key: string) => {
    if (busy) return;
    setBusy(true);
    setReviewError("");
    setReviewErrorKey(key);
    try {
      await operation("/reviews", { key, reviewer, acknowledged: ack });
      setModal("");
      setReviewError("");
      notify("复核签名已记录");
    } catch (e: any) {
      const msg = String(e?.message || "复核签名失败");
      setReviewError(msg);
      notify(msg);
    } finally {
      setBusy(false);
    }
  };
  const update = (fn: (d: Design) => void, record = true) => {
    if (!d || locked || busy) return;
    const next = clone(d);
    fn(next);
    change(next, record);
  };
  const patch = (key: string, value: any) => {
    if (!selection || !selected) return;
    update((n) => {
      const o = n[selection.kind].find((v) => v.id === selection.id)!;
      const prev = clone(o);
      o[key] = value;
      if (selection.kind === "rooms") {
        o.source = "manual";
        o.needsReview = false;
        if (key === "floor")
          n.fixtures
            .filter((f) => f.roomId === o.id)
            .forEach((f) => (f.floor = value));
        if (["x", "y", "width", "height"].includes(key) && o.points) {
          o.points = o.points.map((pt: Obj) => ({
            x: o.x + ((pt.x - prev.x) * o.width) / prev.width,
            y: o.y + ((pt.y - prev.y) * o.height) / prev.height,
          }));
        }
        if (key === "x" || key === "y")
          n.fixtures
            .filter((f) => f.roomId === o.id)
            .forEach((f) => (f[key] += value - prev[key]));
        // 空间改名 / 改类型＝换空间：必须重新推导空间类型（否则旧的 spaceCode 会把
        // 改名后的空间钉在原类型上），并同步智能情景层。
        if (key === "name") {
          // 优先级：新名字能认出空间类型 → 用它；否则用明确的空间类型（「其他空间」不算）；
          // 再否则保留原来的空间类型。这样把「次卧」改名成「客房」仍算次卧。
          const byName = roomSpaceCodeOf({ name: value });
          const byType = SPACE_CODES.find(
            (x) => x.name === o.type && x.code !== "x",
          );
          // 老数据没有 spaceCode，就用改名前的名字/类型补一个，避免改名后丢类型。
          const before = roomSpaceCodeOf({ name: prev.name, type: prev.type });
          o.spaceCode =
            byName?.code || byType?.code || o.spaceCode || before?.code || "";
          syncScenesToSpaces(n);
        }
        if (key === "type") {
          o.spaceCode = SPACE_CODES.find((x) => x.name === value)?.code || "";
          syncScenesToSpaces(n);
        }
      }
      if (selection.kind === "fixtures") {
        if (["price", "brand", "model", "type", "length"].includes(key))
          o.priceVerified = false;
        // 换类型时名称 / 型号跟着走，避免「类型=吊灯、名称=防眩射灯」；
        // 只改本工具生成的默认名与默认型号，自己改过的不动。
        if (key === "type") {
          if (!String(o.name || "").trim() || isAutoFixtureName(o.name))
            o.name = defaultFixtureName(String(value));
          const m = String(o.model || "").trim();
          if (m === "DL-07" || m === "ST-01")
            o.model = defaultFixtureModel(String(value));
        }
        if (key === "code") {
          o.role = roleOfCode(o.code || "");
          if (!assignSpaceFromCode(n, o)) o.space = "";
          syncStandardScenes(n, o);
        }
        // 光源类型：单色 / 双色 / 彩色，切换时自动补全色温字段。
        if (key === "colorMode") applyColorMode(o, value as ColorMode);
        // 单色灯具只有唯一色温，写入后同步上下限。
        if (key === "cct") applyColorMode(o, "单色");
        // 人工确认过光源类型 / 色温，即解除「待核」。
        if (["colorMode", "cct", "cctMin", "cctMax"].includes(key)) delete o.cctPending;
        if (key === "type" && value === "灯带" && !o.stripPath?.length) {
          o.stripPath = [{ x: o.x, y: o.y }, { x: o.x + Math.max(30, (o.length || 1) * 26), y: o.y }];
          o.powerSupply = o.powerSupply || "PS-" + o.code;
          o.controller = o.controller || "CTL-" + o.code;
        }
        n.scenes.forEach((s) => {
          const st = s.states[o.id];
          if (st) {
            st.brightness = Math.min(st.brightness, o.brightnessMax);
            st.cct = Math.min(o.cctMax, Math.max(o.cctMin, st.cct));
          }
        });
      }
      // 传感器手填联动色温 = 不再跟随；灯具色温变了，跟随中的传感器同步。
      if (selection.kind === "devices" && key === "sensorCct") o.sensorCctAuto = false;
      if (selection.kind === "fixtures" && ["colorMode", "cct", "cctMin", "cctMax"].includes(key))
        (n.devices || []).forEach((dev) => syncSensorCct(dev, n.fixtures));
      if (selection.kind === "fixtures" && key === "roomId") {
        const r = n.rooms.find((r) => r.id === value);
        if (r) {
          o.floor = r.floor;
          o.x = r.x + r.width / 2;
          o.y = r.y + r.height / 2;
        }
      }
    });
  };
  async function leave() {
    try {
      await flush();
      onClose();
    } catch (e: any) {
      notify("尚有未保存修改：" + e.message);
    }
  }
  const save = () =>
    run(() => {
      commitSceneDraft();
      return flush();
    }, "当前设计已保存到本地");
  // 一键把控制方式归到当前智能方案：三维同步早先写下的 "KNX" 这类旧值会在界面显示「旧值，请重选」，
  // 27 盏逐盏改太费事。归一方向保守——不凭空升级成调光，旧值一律落到本方案的「开闭」，
  // 要调光的那几盏在灯位里单独改 DALI。列在灯具清单工具条上，点了就有回执。
  function normalizeAllControls() {
    const smart = String(p?.smart || "无");
    const fixed: string[] = [];
    update((v) => {
      // 只归灯：窗帘的 control 写的是电机接入方式（KNX），不在灯具控制方式词表里，不能被改成开闭。
      (v.fixtures || []).filter(isSceneLight).forEach((f: Obj) => {
        const was = String(f.control || "").trim();
        if (fixtureControlAllowed(smart, was)) return;
        f.control = fixtureControlOptions(smart)[0].value;
        f.dimmable = false;
        fixed.push(`${f.code || f.id}（${was || "空"}→${f.control}）`);
      });
    });
    notify(
      fixed.length
        ? `已按「${smart}」把 ${fixed.length} 盏灯的控制方式归一到开闭：${fixed.slice(0, 6).join("、")}${fixed.length > 6 ? " 等" : ""}；需要调光的在灯位里改 DALI`
        : "所有灯具的控制方式都符合当前方案，没有要改的",
    );
  }
  // 定位到出问题的灯具：切到画布、按楼层选中并居中，随后直接打开灯具配置修改。
  function locateFixture(f: Obj) {
    if (!d) return;
    const fl = Number.isFinite(f.floor)
      ? Number(f.floor)
      : d.rooms.find((r) => r.id === f.roomId)?.floor || 1;
    setSelection({ kind: "fixtures", id: f.id });
    setFloor(fl);
    setFocus({ x: Number(f.x) || 0, y: Number(f.y) || 0, token: Date.now() });
    setTab("plan");
    setModal("fixture");
  }
  // 一键修正色温：上下限倒置就换回来，单色对齐，情景越界的色温夹回允许区间。
  function fixCct(f: Obj) {
    update((n) => {
      const t = n.fixtures.find((x) => x.id === f.id);
      if (!t) return;
      let lo = Number(t.cctMin);
      let hi = Number(t.cctMax);
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
        lo = 2700;
        hi = 6500;
      }
      if (lo > hi) {
        const tmp = lo;
        lo = hi;
        hi = tmp;
      }
      if (colorModeOf(t) === "单色") {
        const c = Number(t.cct);
        lo = hi = Number.isFinite(c) ? c : lo;
        t.cct = lo;
      }
      t.cctMin = lo;
      t.cctMax = hi;
      n.scenes.forEach((s) => {
        const st = s.states?.[t.id];
        if (st) st.cct = Math.min(hi, Math.max(lo, Number(st.cct) || lo));
      });
    });
    notify(`已修正 ${f.code} 的色温，并把各情景越界的色温夹回允许区间`);
  }
  // 不做智能：一条回路整组开/关（默认缓亮缓灭 1 秒）。
  function circuitState(g: { fixtures: Obj[] }, on: boolean) {
    if (!scene) return;
    editSceneDraft((sc) => {
      sc.customized = true;
      sc.fade = 1;
      const ids = new Set(g.fixtures.map((f) => f.id));
      (d?.fixtures || [])
        .filter((f) => ids.has(f.id))
        .forEach((f) => {
          const st = sc.states[f.id] || {};
          sc.states[f.id] = {
            ...st,
            on,
            brightness: on ? Number(f.brightnessMax) || 100 : 0,
            cct: clampCctForFixture(f, Number(st.cct) || f.cct || f.cctMin),
          };
        });
    });
    setFadeTick((t) => t + 1);
  }
  /** 整组回路调亮度（2026-10-19 改版）：滑块拖到哪儿，这组每盏灯就调到哪儿。 */
  function circuitBrightness(g: { fixtures: Obj[] }, v: number) {
    if (!scene) return;
    editSceneDraft((sc) => {
      sc.customized = true;
      sc.fade = 1;
      const ids = new Set(g.fixtures.map((f) => f.id));
      (d?.fixtures || [])
        .filter((f) => ids.has(f.id))
        .forEach((f) => {
          const st = sc.states[f.id] || {};
          const max = Number(f.brightnessMax) || 100;
          sc.states[f.id] = {
            ...st,
            on: v > 0,
            brightness: Math.min(max, Math.max(0, Math.round(v))),
            cct: clampCctForFixture(f, Number(st.cct) || f.cct || f.cctMin),
          };
        });
    });
    setFadeTick((t) => t + 1);
  }
  // 切换智能方案：无线＝补 JOCO 默认；无＝按空间分回路 + 固定 1 秒缓变 + 开关控制。
  async function changeSmart(v: string) {
    if (v === smart) return;
    await run(async () => {
      update((n) => {
        if (v === "无线")
          n.fixtures.filter(isSceneLight).forEach((f) => applyWirelessDefaults(f));
        if (v === "KNX")
          n.fixtures.filter(isSceneLight).forEach((f) => applyBusDefaults(f));
        if (v === "无") {
          autoCircuitsByRoom(n);
          n.scenes.forEach((s) => {
            s.fade = 1;
          });
          n.fixtures.filter(isSceneLight).forEach((f) => {
            f.control = "开关控制";
          });
        }
      });
      await flush();
      await operation("/smart", { smart: v }, "PATCH");
    }, `智能方案已改为：${smartLabelOrNone(v)}`);
  }
  function addRoom() {
    const rid = uid();
    update((n) =>
      n.rooms.push({
        id: rid,
        name: "新房间",
        type: "其他空间",
        floor,
        x: 110 + (n.rooms.length % 5) * 20,
        y: 100 + (n.rooms.length % 5) * 20,
        width: 200,
        height: 160,
        area: 20,
        heightM: 2.8,
        color: "#e0dcd6",
        source: "manual",
        notes: "",
      }),
    );
    setSelection({ kind: "rooms", id: rid });
    setTab("plan");
  }
  function addBoundaryPoint() {
    if (selection?.kind !== "rooms" || !selected) return;
    update((n) => {
      const r = n.rooms.find((v) => v.id === selected.id)!;
      const pts = r.points || [{ x:r.x,y:r.y },{ x:r.x+r.width,y:r.y },{ x:r.x+r.width,y:r.y+r.height },{ x:r.x,y:r.y+r.height }];
      const a=pts[0], b=pts[1];
      r.points=[...pts.slice(0,1), { x:(a.x+b.x)/2, y:(a.y+b.y)/2 }, ...pts.slice(1)];
      r.source="manual"; r.needsReview=false;
    });
  }
  function removeBoundaryPoint() {
    if (selection?.kind !== "rooms" || !selected) return;
    update((n) => {
      const r = n.rooms.find((v) => v.id === selected.id)!;
      if (!r.points?.length || r.points.length <= 3) {
        notify("空间边界至少需要 3 个点");
        return;
      }
      r.points.pop();
      const xs = r.points.map((v: Obj) => v.x), ys = r.points.map((v: Obj) => v.y);
      r.x = Math.min(...xs); r.y = Math.min(...ys);
      r.width = Math.max(...xs) - r.x; r.height = Math.max(...ys) - r.y;
      r.source = "manual"; r.needsReview = false;
    });
  }
  function addWall() {
    const rid = uid();
    update((n) =>
      n.walls.push({
        id: rid,
        x: 100,
        y: 100,
        x2: 300,
        y2: 100,
        floor,
        source: "manual",
        layer: "手工墙体",
      }),
    );
    setSelection({ kind: "walls", id: rid });
  }
  function addOpening(type: string) {
    const rid = uid();
    update((n) =>
      n.openings.push({
        id: rid,
        type,
        x: 200,
        y: 200,
        width: 50,
        rotation: 0,
        floor,
        source: "manual",
      }),
    );
    setSelection({ kind: "openings", id: rid });
  }
  // 空间由灯具编号决定（如 kc001）：导入彩平图后不用先做空间分割，
  // 直接放灯、给编号，这里按编号前缀自动建立/复用空间并归位。
  function spaceContainer(n: Design, name: string, floorNo = floor, self?: Obj): Obj {
    const key = (name || "").trim();
    const existing = n.rooms.find((r) => (r.name || "").trim() === key);
    if (existing) {
      if (!existing.spaceCode) existing.spaceCode = roomSpaceCodeOf(existing)?.code;
      return existing;
    }
    const meta = roomSpaceCodeOf({ name: key });
    const room: Obj = {
      id: uid(),
      name: key,
      // 空间库认得出来就写真实空间类型（原来一律占位「其他空间」，与名称/空间码不一致）。
      type: meta?.name || "其他空间",
      spaceCode: meta?.code || "x",
      floor: self?.floor ?? floorNo,
      x: 400,
      y: 320,
      width: 1,
      height: 1,
      area: 0,
      heightM: 2.8,
      color: "#e0ddd7",
      source: "fixture-code",
      needsReview: false,
      notes: "按灯具编号建立的空间（无边界）",
    };
    n.rooms.push(room);
    return room;
  }
  function assignSpaceFromCode(n: Design, f: Obj): boolean {
    const parsed = parseFixtureCode(f.code || "");
    // 新编号（kc001）优先；兼容早期的「客厅-01」写法。
    const space = parsed?.space || spaceFromCode(f.code || "");
    if (!space) return false;
    const spaceCode = SPACE_CODES.find((x) => x.name === space)?.code;
    const current = n.rooms.find((r) => r.id === f.roomId);
    // 同类空间可以有多个（次卧 / 次卧 2）：已经待在同类空间里的灯原地不动，
    // 否则「按编号同步」会把第二个次卧的灯全部并进第一个次卧。
    if (current && spaceCode && roomSpaceCodeOf(current)?.code === spaceCode) {
      f.space = space;
      f.floor = current.floor;
      if (parsed) {
        f.position = parsed.position;
        f.role = parsed.role;
      }
      return true;
    }
    const room = spaceContainer(n, space, f.floor || floor, f);
    f.roomId = room.id;
    f.space = space;
    if (parsed) {
      f.position = parsed.position;
      f.role = parsed.role;
    }
    return true;
  }
  // 标准情景的状态永远由灯具编号推导：布灯/改编号即自动同步，不需要逐场景手调。
  function syncStandardScenes(n: Design, f: Obj) {
    const parsed = parseFixtureCode(f.code || "");
    n.scenes.forEach((s) => {
      if (!s.standard || s.customized) return;
      const st = standardSceneState(s.name, parsed, f);
      if (st) s.states[f.id] = st;
    });
  }
  // 复制灯具编号列：勾选了就复制勾选的，没勾选就复制全部。
  // 首行是带项目名与条数的清单表头（前面加 #，并另起一行列名），即使被误粘进浏览器
  // 地址栏 / 搜索框，也一眼能看出是清单而不是搜索词；下面每行是「编号 名称 空间 位置
  // 楼层 灯组」，制表符分列，可直接粘进 Excel。
  function copyFixtureCodes() {
    const all = d?.fixtures || [];
    if (!all.length) {
      notify("还没有灯具可复制");
      return;
    }
    const rows = (checked.length ? all.filter((f) => checked.includes(f.id)) : all.slice())
      .slice()
      .sort(
        (a, b) =>
          (Number(a.floor) || 1) - (Number(b.floor) || 1) ||
          String(a.code || "").localeCompare(String(b.code || "")),
      );
    const levels = floorLevels(p?.floors || 1, p?.basements || 0);
    const floorText = (f: Obj) =>
      levels.find((lv) => Number(lv.value) === (Number(f.floor) || 1))?.label ||
      `${Number(f.floor) || 1}F`;
    const head = `# ${p?.name || "本方案"} · 灯具编号清单（共 ${rows.length} 条）`;
    const cols = ["编号", "名称", "空间", "位置", "楼层", "灯组"].join("\t");
    const body = rows
      .map((f) =>
        [
          f.code || "",
          f.name || "",
          f.space || "",
          f.position || "",
          floorText(f),
          f.group || "",
        ].join("\t"),
      )
      .join("\n");
    writeClipboard([head, cols, body].join("\n")).then((ok) =>
      notify(
        ok
          ? `已复制 ${rows.length} 条灯具编号（编号/名称/空间/位置/楼层/灯组），可直接粘进 Excel`
          : "复制失败：请手动选中清单文本复制",
      ),
    );
  }

  function tidyFixtureSpaces() {
    if (!d?.fixtures.length) return;
    let moved = 0, created = 0;
    update((n) => {
      const before = n.rooms.length;
      n.fixtures.forEach((f) => {
        if (assignSpaceFromCode(n, f)) moved += 1;
        syncStandardScenes(n, f);
      });
      created = n.rooms.length - before;
    });
    notify(
      `已按编号同步：${moved} 盏灯归入空间，新建 ${created} 个空间；标准情景已按编号重算`,
    );
  }
  // 落图后把画布对准新对象：避免「画布放大了 → 找不到刚放的灯 → 手动缩小再放大」。
  // 只把视野居中；放大倍数保持在可读区间（<100% 回到 100%，已放大则保留）。
  function focusPlaced(x: number, y: number) {
    setZoom((z) => Math.min(2, Math.max(1, z)));
    setFocus({ x: Number(x) || 0, y: Number(y) || 0, token: Date.now() });
  }
  // 画布落点：记住坐标、把「空间」默认成落点所在房间，然后打开布灯对话框。
  function beginPlaceAt(p: { x: number; y: number }) {
    if (locked) return;
    if (tool === "place-furniture") {
      const room = (d?.rooms || []).find(r => +(r.floor || 1) === floor && pointInSpace(r, p.x, p.y));
      if (!room) { notify("请在空间内单击家具位置"); return; }
      const base = d!.furniture ?? legacyFurniture;
      if (movingFurniture && selectedFurnitureId) {
        change({ ...d!, furniture: base.map(f => f.id === selectedFurnitureId ? { ...f, ...p, roomId: room.id, floor } : f) });
      } else if (placingFurniture) {
        const item = createFurniture(placingFurniture, room, p.x, p.y);
        change({ ...d!, furniture: [...base, item] });
        setSelectedFurnitureId(item.id);
      }
      setMovingFurniture(false); setPlacingFurniture(""); setTool("select");
      return;
    }
    // 面板 / 温控器是墙装件：二维落点就吸到墙线上，三维按同一个点贴墙，不会悬浮、不会挂错墙。
    if (tool === "place-device" && addObject === "device" && (addType === "面板" || addType === "温控器")
        && !isTabletopDevice({ name: addName })) {
      const walls = (d?.rooms || []).filter((r) => +(r.floor || 1) === floor && boundary(r).length >= 3);
      if (!walls.length) { notify(`本层还没有空间边界（墙），${addType}没有墙可贴：请先确认空间`); return; }
      const snap = snapToWall(walls, p, floor, WALL_SNAP_MAX);
      if (!snap) { notify(`${addType}要放在墙边：请点在离墙 0.6 米以内的位置`); return; }
      p = { x: snap.x, y: snap.y };
    }
    setPlacePoint({
      x: Math.round((Number(p.x) || 0) * 100) / 100,
      y: Math.round((Number(p.y) || 0) * 100) / 100,
    });
    const hit = (d?.rooms || []).find((r) => r.floor === floor && pointInRoom(r, p));
    // 添加设备 / 窗帘：落点所在空间自动选中，确认对话框随即出现（addObject && placePoint）。
    if (tool === "place-device") {
      if (hit) setAddRoomId(hit.id);
      return;
    }
    if (hit) {
      setLampRoomId(hit.id);
      const meta = roomSpaceCodeOf(hit);
      if (meta) setLampSpace(meta.code);
    }
    setModal("place");
  }
  // 关闭布灯对话框：同时退出布灯模式。
  function closePlace() {
    setModal("");
    setPlacePoint(null);
    setTool("select");
  }
  // Esc 退出布灯模式（对话框打开时的 Esc 由 Modal 自己处理）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !modal && !(addObject && placePoint)) {
        if (tool === "place-lamp" || tool === "place-device" || tool === "place-furniture") {
          setTool("select");
          setPlacePoint(null);
          setAddObject("");
          setMovingFurniture(false); setPlacingFurniture("");
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tool, modal, addObject]);
  // 布灯：选好空间、位置与职能，编号（如 kcA001）自动生成并同步标准情景。
  function placeLamps(count = 1) {
    if (!d) return;
    const spaceMeta = lampRoom
      ? roomSpaceCodeOf(lampRoom)
      : SPACE_CODES.find((s) => s.code === lampSpace);
    const spaceCode = spaceMeta?.code || lampSpace;
    const spaceName = spaceMeta?.name || "其他空间";
    const positionName = positionNameIn(spaceCode, lampPosition) || "其他位置";
    const targetRoomId = lampRoom?.id || "";
    let last = "";
    const placedAt: { pos?: { x: number; y: number } } = {};
    update((n) => {
      const room = targetRoomId
        ? n.rooms.find((r) => r.id === targetRoomId) || spaceContainer(n, spaceName, floor, { floor })
        : spaceContainer(n, spaceName, floor, { floor });
      const first = nextSerial(n.fixtures, spaceCode, lampPosition, lampRole);
      for (let i = 0; i < count; i++) {
        const f = makeFixture(
          n,
          room,
          count > 1 ? ((i % 2) - 0.5) * 70 : 0,
          count > 1 ? (Math.floor(i / 2) - 0.5) * 70 : 0,
          buildFixtureCode(spaceCode, lampPosition, first + i, lampRole),
          placePoint || undefined,
        );
        n.fixtures.push(f);
        last = f.id;
        placedAt.pos = { x: f.x, y: f.y };
        // 编号决定空间与位置，写回字段后再同步标准情景。
        assignSpaceFromCode(n, f);
        // 明确选中的房间优先：同类空间有多个时不能被「第一个同名房间」抢走。
        f.roomId = room.id;
        n.scenes.forEach((s) => {
          s.states[f.id] = {
            on: true,
            brightness: noSmart ? f.brightnessMax : 80,
            cct: clampCctForFixture(f, 3000),
          };
        });
        syncStandardScenes(n, f);
      }
    });
    if (last) setSelection({ kind: "fixtures", id: last });
    // 画布点选落点时不再自动居中：落点本来就在视野里，重定心会让画面跳动。
    if (placedAt.pos && !placePoint) focusPlaced(placedAt.pos.x, placedAt.pos.y);
    notify(
      `已布灯 ${count} 盏：${spaceName} · ${positionName} · ${lampRole} ${roleName(lampRole)}；标准情景已按编号（空间×职能×位置）同步。继续点图纸布下一盏，再点「放置灯具」退出`,
    );
  }
  // 不做智能时按空间分回路：同一空间的灯共用一条回路，新空间自动开新回路。
  function circuitForRoom(n: Design, r: Obj): string {
    if (!noSmart) return "C01";
    const existing = n.fixtures.find(
      (f) => isSceneLight(f) && f.roomId === r.id && String(f.circuit || "").trim(),
    );
    if (existing) return existing.circuit;
    const used = new Set(
      n.fixtures.map((f) => String(f.circuit || "").trim()).filter(Boolean),
    );
    let i = 1;
    while (used.has("C" + String(i).padStart(2, "0"))) i += 1;
    return "C" + String(i).padStart(2, "0");
  }
  function makeFixture(
    n: Design,
    r: Obj,
    dx = 0,
    dy = 0,
    code?: string,
    at?: { x: number; y: number },
  ): Obj {
    // 编号 = 空间码 + 位置码 + 职能码 + 序号（kcA001）；不传就按当前选中的空间/位置/职能自动编。
    const nextCode =
      code ||
      buildFixtureCode(
        lampSpaceCode,
        lampPosition,
        nextSerial(n.fixtures, lampSpaceCode, lampPosition, lampRole),
        lampRole,
      );
    // 无边界空间（默认）：灯具按已有数量排成网格，避免全部叠在同一个点上。
    const noGeometry = !(Number(r.width) > 1) || !(Number(r.height) > 1);
    const slot = noGeometry
      ? n.fixtures.filter((f) => f.roomId === r.id).length
      : 0;
    // 画布落点优先：点哪放哪；没给落点才回退到空间中心 / 无边界空间的网格排布。
    const baseX = at
      ? at.x
      : noGeometry
        ? 110 + (slot % 6) * 64
        : r.x + r.width / 2;
    const baseY = at
      ? at.y
      : noGeometry
        ? 100 + Math.floor(slot / 6) * 64
        : r.y + r.height / 2;
    const fx: Obj = {
      id: uid(),
      code: nextCode,
      role: roleOfCode(nextCode),
      position: parseFixtureCode(nextCode)?.position || "",
      space: parseFixtureCode(nextCode)?.space || "",
      // 名称与型号都按类型给，避免「类型=吊灯、名称=防眩射灯 / 型号=DL-07」这种不一致。
      name: defaultFixtureName(lampType),
      model: defaultFixtureModel(lampType),
      // 品牌不猜：无线 2026-10-11 起改飞利浦（型号随新灯具清单接），总线/无智能都留「待选型」。
      brand: "待选型",
      type: lampType,
      roomId: r.id,
      floor: r.floor,
      x: baseX + dx,
      y: baseY + dy,
      // 挑空空间默认按贯通高度安装（层高 − 0.6），否则沿用 2.8m
      installHeight: voidInstallHeight(r) ?? 2.8,
      beamAngle: defaultBeamAngle(lampType),
      // 筒射灯默认 12W（默认口径），其他灯具类型保持 7W 默认。
      // 拍板 2026-10-12：线条灯默认 10W；吊灯**不给默认**——功率与光通量必须手填。
      power:
        lampType === "吊灯" ? 0
          : lampType === "线条灯" ? 10
            : lampType === "射灯" || lampType === "筒灯" ? 12 : 7,
      // 光通量 lm：产品库补全后以产品库为准；在此之前按手填（吊灯必填）。
      lumen: 0,
      brightnessMax: 100,
      cctMin: SINGLE_CCT_DEFAULT,
      cctMax: SINGLE_CCT_DEFAULT,
      // 光源类型在下方按布灯选择统一补全（单色 / 双色 / 彩色）。
      colorMode: "单色",
      colorHue: 0,
      colorHex: "",
      group: "",
      control: smart === "无" ? "开关控制" : smart === "无线" ? "蓝牙 Mesh" : "KNX",
      circuit: circuitForRoom(n, r),
      dimmable: true,
      tunable: true,
      quote: true,
      price: 0,
      priceVerified: false,
      source: "manual",
      notes: "",
      length: lampType === "灯带" ? 2 : 1,
      // 灯带每段必须有独立电源与控制关系，否则后端校验会拒绝保存（布灯就存不进去）。
      powerSupply: lampType === "灯带" ? "PS-" + uid() : "",
      controller: lampType === "灯带" ? "CTL-" + uid() : "",
      channel: "",
      address: "",
      stripPath: [],
    };
    applyColorMode(fx, lampColorMode);
    if (lampColorMode === "单色") {
      fx.cct = lampSingleCct;
      applyColorMode(fx, "单色");
    }
    if (lampNeedsReason) fx.cctReason = lampCctReason.trim();
    return fx;
  }
  // 添加设备：先选类型、名称与空间，再落到本层图纸（楼层跟当前页，空间只列本层）。
  function placeDevice() {
    if (!d) return;
    const picked = (d.rooms || []).find((r) => r.id === addRoomId);
    let last = "";
    const placedAt: { pos?: { x: number; y: number } } = {};
    update((n) => {
      const room = picked ? n.rooms.find((r) => r.id === picked.id) : undefined;
      // 点哪放哪：优先用画布落点，没有落点才退回空间中心。
      const x = placePoint ? placePoint.x : room ? room.x + room.width / 2 : 200;
      const y = placePoint ? placePoint.y : room ? room.y + room.height / 2 : 200;
      const devSpaceCode = (room ? roomSpaceCodeOf(room)?.code : "") || "x";
      const dev: Obj = {
        id: uid(),
        code: buildDeviceCode(room, addType, n.devices),
        name: (addName || DEFAULT_DEVICE_NAME[addType] || "智能设备").trim(),
        type: addType,
        model: "",
        roomId: room?.id || "",
        floor: room ? room.floor || floor : floor,
        protocol: "KNX",
        address: "",
        notes: "",
        // 设备也记家具/功能位（按空间取表），清单与交付页都能看出「这个面板装在哪儿」。
        positionCode: addPositionCode,
        position: addPositionCode ? positionNameIn(devSpaceCode, addPositionCode) : "",
        x,
        y,
      };
      if (dev.type === "面板") normalizePanel(dev);
      if (dev.type === "传感器") normalizeSensor(dev);
      // 对话框里才把类型改成面板 / 温控器的：落库前同样贴到最近的墙线上。
      if ((dev.type === "面板" || dev.type === "温控器") && !isTabletopDevice(dev)) {
        const walls = n.rooms.filter((r) => +(r.floor || 1) === +dev.floor && boundary(r).length >= 3);
        const snap = walls.length ? snapToWall(walls, { x: +dev.x, y: +dev.y }, +dev.floor, Infinity) : null;
        if (snap) { dev.x = Math.round(snap.x * 100) / 100; dev.y = Math.round(snap.y * 100) / 100; }
      }
      // 面板 / 温控器贴墙安装：先给一个可改的默认高度（2026-10-16「添加面板时可以设置其高度」）。
      // 「时光之轮」一类遥控器不走墙装，按家具顶面/地面落位，不用这个高度。
      if (!isTabletopDevice(dev) && (dev.type === "面板" || dev.type === "温控器")) {
        dev.installHeight = Math.round(mountHeight(+(room?.heightM || 3)) * 100) / 100;
      }
      n.devices.push(dev);
      last = dev.id;
      placedAt.pos = { x: dev.x, y: dev.y };
    });
    if (last) setSelection({ kind: "devices", id: last });
    // 点选落点时不再自动居中：落点本来就在视野里，重定心会让画面跳动。
    if (placedAt.pos && !placePoint) focusPlaced(placedAt.pos.x, placedAt.pos.y);
    notify(
      `已添加${addType}${picked ? `：${picked.name}` : "（未分配空间）"}` +
        (addPositionCode ? ` · ${addSpaceName}${positionNameIn(addSpaceCode, addPositionCode)}` : "") +
        "；属性可在右侧「设备属性」微调",
    );
    setAddPositionCode("");
  }
  // 窗帘：先选空间与电机再落到图纸（楼层跟当前页）。沿窗的折线布置，长短/方向可拖手柄或数值调。不计报价。
  function placeCurtain() {
    if (!d) return;
    const picked = (d.rooms || []).find((r) => r.id === addRoomId);
    let last = "";
    const placedAt: { pos?: { x: number; y: number } } = {};
    update((n) => {
      const room =
        (picked ? n.rooms.find((r) => r.id === picked.id) : undefined) ||
        n.rooms.find((r) => r.floor === floor);
      // 点哪放哪：优先用画布落点，没有落点才退回空间上方居中。
      const x = placePoint ? placePoint.x : room ? room.x + room.width * 0.5 : 200;
      const y = placePoint ? placePoint.y : room ? room.y + room.height * 0.15 : 120;
      const sc = roomSpaceCodeOf(room)?.code || "x";
      const serial = n.fixtures.filter((f) => f.type === "窗帘").length + 1;
      const cid = uid();
      last = cid;
      placedAt.pos = { x, y };
      n.fixtures.push({
        id: cid,
        code: `${sc}W${String(serial).padStart(3, "0")}`,
        name: "电动窗帘",
        type: "窗帘",
        model: "",
        brand: "",
        roomId: room?.id || "",
        floor,
        x,
        y,
        installHeight: 2.8,
        length: 2.5,
        stripRotation: 0,
        stripPath: [{ x, y }, { x: x + 65, y }],
        curtainMotor: addMotor,
        power: 0,
        brightnessMax: 100,
        cctMin: 2700,
        cctMax: 6500,
        control: "KNX",
        circuit: "",
        dimmable: false,
        tunable: false,
        quote: false,
        price: 0,
        priceVerified: false,
        source: "manual",
        notes: "",
        powerSupply: "",
        controller: "",
      });
    });
    if (last) setSelection({ kind: "fixtures", id: last });
    if (placedAt.pos && !placePoint) focusPlaced(placedAt.pos.x, placedAt.pos.y);
    notify(`已添加电动窗帘（${addMotor}）${picked ? `：${picked.name}` : "；沿窗折线，可拖手柄调整长短"}`);
  }
  function addFixture(count = 1) {
    if (!d) return;
    let last = "";
    const placedAt: { pos?: { x: number; y: number } } = {};
    let placeholder = false;
    update((n) => {
      const picked =
        selection?.kind === "rooms" && selected
          ? n.rooms.find((v) => v.id === (selected as Obj).id)
          : undefined;
      let room = picked || n.rooms.find((v) => v.floor === floor);
      if (!room) {
        // 导入底图后可以直接放灯：先落在「未分配」，改编号即自动归位。
        room = spaceContainer(n, "未分配", floor);
        placeholder = true;
      }
      const spreadX = room.source === "fixture-code" ? 60 : room.width * 0.5;
      const spreadY = room.source === "fixture-code" ? 60 : room.height * 0.5;
      for (let i = 0; i < count; i++) {
        const f = makeFixture(
          n,
          room,
          count > 1 ? ((i % 2) - 0.5) * spreadX : 0,
          count > 1 ? (Math.floor(i / 2) - 0.5) * spreadY : 0,
        );
        n.fixtures.push(f);
        last = f.id;
        placedAt.pos = { x: f.x, y: f.y };
        for (const s of n.scenes)
          s.states[f.id] = {
            on: true,
            brightness: noSmart ? f.brightnessMax : 80,
            cct: clampCctForFixture(f, 3000),
          };
        syncStandardScenes(n, f);
      }
    });
    if (placeholder)
      notify(
        "当前楼层还没有空间：灯具先放在「未分配」，把编号改成「kc001」这种带空间与位置的编号即自动归位。",
      );
    if (last) setSelection({ kind: "fixtures", id: last });
    if (placedAt.pos) focusPlaced(placedAt.pos.x, placedAt.pos.y);
  }
  function removeSelected() {
    if (!selection || !selected) return;
    const sel = selection;
    askDanger(`删除 ${selected.name || selected.code || "此对象"}？`, () => {
      update((n) => {
        const removed =
          sel.kind === "rooms"
            ? n.fixtures.filter((f) => f.roomId === sel.id).map((f) => f.id)
            : sel.kind === "fixtures"
              ? [sel.id]
              : [];
        n[sel.kind] = n[sel.kind].filter(
          (o) => o.id !== sel.id,
        );
        n.fixtures = n.fixtures.filter((f) => !removed.includes(f.id));
        n.scenes.forEach((s) => removed.forEach((id) => delete s.states[id]));
        if (sel.kind === "rooms")
          n.devices
            .filter((v) => v.roomId === sel.id)
            .forEach((v) => (v.roomId = ""));
      });
      setSelection(null);
    }, "删除房间也将删除其中灯具及场景引用。");
  }
  // 复制：把选中对象放进应用内剪贴板（灯具含光斑/灯带几何，设备含面板刻字/键位情景、传感器参数），
  // 同时把编号写进系统剪贴板。剪贴板记住类型，粘贴时按类型还原，复制面板不会再粘出灯具。
  function copySelected() {
    if (!selection || !selected) return;
    setLampClipboard(clone(selected));
    setClipKind(selection.kind);
    setPasteCount(0);
    const label =
      selection.kind === "fixtures"
        ? selected.code || "灯具"
        : selection.kind === "devices"
          ? [selected.name || "设备", selected.type].filter(Boolean).join(" · ")
          : selected.name || "对象";
    const clipText =
      selection.kind === "fixtures"
        ? [selected.code, selected.name].filter(Boolean).join(" · ")
        : [selected.name || "对象", p?.name].filter(Boolean).join(" · ");
    writeClipboard(clipText).then((ok) => {
      if (!ok)
        notify(
          "已记入工作台内剪贴板，可直接「粘贴」；系统剪贴板写入失败，要粘到别处请手动选择文本复制",
        );
    });
    if (selection.kind === "fixtures")
      notify(`已复制 ${label}；点「粘贴」或按 Ctrl/Cmd+V 再放一盏`);
    else if (selection.kind === "devices")
      notify(`已复制 ${label}；点「粘贴」或按 Ctrl/Cmd+V 再放一个`);
    else notify(`已复制 ${label}；该类型暂不支持粘贴`);
  }
  // 粘贴：按剪贴板里的类型还原——灯具按原空间/位置自动编号并带情景；设备按类型还原
  //（面板刻字与键位情景、传感器参数照旧），不会再出现「复制面板粘出灯具」。
  function pasteFixture() {
    const src = lampClipboard;
    if (!src) {
      notify("剪贴板里还没有对象：先选中灯具或设备点「复制」");
      return;
    }
    if (clipKind === "devices") {
      pasteDevice(src);
      return;
    }
    if (clipKind !== "fixtures") {
      notify("暂不支持粘贴该类型对象：请选中灯具或设备后再复制");
      return;
    }
    const newId = uid();
    const step = (pasteCount + 1) * 24;
    const placedAt: { pos?: { x: number; y: number } } = {};
    update((n) => {
      const obj = clone(src);
      obj.id = newId;
      obj.x = src.x + step;
      obj.y = src.y + step;
      if (obj.points)
        obj.points = obj.points.map((v: Obj) => ({ x: v.x + step, y: v.y + step }));
      if (obj.stripPath)
        obj.stripPath = obj.stripPath.map((v: Obj) => ({ x: v.x + step, y: v.y + step }));
      if (obj.x2 !== undefined) {
        obj.x2 += step;
        obj.y2 += step;
      }
      const r = n.rooms.find((x) => x.id === obj.roomId) || n.rooms[0];
      if (r) {
        obj.roomId = r.id;
        obj.floor = r.floor;
      }
      const sc = SPACE_CODES.find((s) => s.name === obj.space)?.code;
      const pc = sc
        ? positionCodeInSpace(sc, obj.position)
        : POSITION_CODES.find((p) => p.name === obj.position)?.code;
      const rc = roleOfCode(obj.code || "") || obj.role;
      if (obj.type === "窗帘") {
        // 窗帘编号＝「空间码 + W + 序号」，不走灯具那套「空间+位置+职能」编号，
        // 否则粘出来的窗帘会拿一个灯具编号。
        const csc = roomSpaceCodeOf(r)?.code || "x";
        let max = 0;
        n.fixtures
          .filter((x) => x.type === "窗帘")
          .forEach((x) => {
            const m = String(x.code || "").match(/^([a-z]+)W(\d+)$/);
            if (m && m[1] === csc) max = Math.max(max, Number(m[2]));
          });
        obj.code = `${csc}W${String(max + 1).padStart(3, "0")}`;
      } else if (sc && pc) obj.code = buildFixtureCode(sc, pc, nextSerial(n.fixtures, sc, pc, rc), rc);
      else if (r) obj.code = makeFixture(n, r).code;
      if (obj.type === "灯带") {
        obj.powerSupply = "PS-" + newId;
        obj.controller = "CTL-" + newId;
      }
      n.scenes.forEach((s) => {
        s.states[newId] = clone(s.states[src.id] || { on: true, brightness: 80, cct: 3000 });
      });
      n.fixtures.push(obj);
      assignSpaceFromCode(n, obj);
      syncStandardScenes(n, obj);
      placedAt.pos = { x: obj.x, y: obj.y };
    });
    setPasteCount((c) => c + 1);
    setSelection({ kind: "fixtures", id: newId });
    if (placedAt.pos) focusPlaced(placedAt.pos.x, placedAt.pos.y);
  }
  // 粘贴设备：新编号（空间码 + 类型码 + 序号），落在原位置右下 24 单位；
  // 面板的键位与刻字情景、传感器的参数与关联灯具照旧带过来。
  function pasteDevice(src: Obj) {
    const newId = uid();
    const step = (pasteCount + 1) * 24;
    let newCode = "";
    const placedAt: { pos?: { x: number; y: number } } = {};
    update((n) => {
      const obj = clone(src);
      obj.id = newId;
      obj.x = (Number(src.x) || 0) + step;
      obj.y = (Number(src.y) || 0) + step;
      const room =
        n.rooms.find((x) => x.id === obj.roomId) ||
        n.rooms.find((x) => x.floor === floor) ||
        n.rooms[0];
      if (room) {
        obj.roomId = room.id;
        obj.floor = room.floor;
      }
      obj.code = buildDeviceCode(room, obj.type, n.devices);
      if (obj.type === "面板") normalizePanel(obj);
      if (obj.type === "传感器") normalizeSensor(obj);
      n.devices.push(obj);
      newCode = obj.code;
      placedAt.pos = { x: Number(obj.x), y: Number(obj.y) };
    });
    setPasteCount((c) => c + 1);
    setSelection({ kind: "devices", id: newId });
    if (placedAt.pos) focusPlaced(placedAt.pos.x, placedAt.pos.y);
    notify(
      `已粘贴 ${src.type || "设备"}${src.name ? `「${src.name}」` : ""}：编号 ${newCode}；可在右侧「设备属性」微调`,
    );
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && /^(input|textarea|select)$/i.test(t.tagName)) return;
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const k = (e.key || "").toLowerCase();
      if (k === "c") {
        // 正在复制页面上的文字/链接时不要抢：交给浏览器正常复制。
        if ((window.getSelection?.()?.toString?.() || "").trim()) return;
        e.preventDefault();
        copySelected();
      } else if (k === "v") {
        e.preventDefault();
        pasteFixture();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  async function alterRoom(action: "split" | "merge") {
    if (selection?.kind !== "rooms" || !selected || !d) return;
    try {
      const result = await api<Design>(`/projects/${id}/space-definition/geometry`, {
        method: "POST", body: JSON.stringify({ design: d, action, id: selected.id, otherId: mergeTargetId }),
      });
      change(withSpaceShell(result), true); setMergeTargetId("");
      notify(action === "split" ? "已按多边形拆分空间，请核对名称与层高" : "已合并空间，家具、灯具与门窗归属已同步");
    } catch (e: any) { notify(e.message); }
  }
  const splitRoom = () => void alterRoom("split");
  const mergeRoom = () => void alterRoom("merge");
  function addScene(name = "新情景", brightness = 70, cct = 3000) {
    const id = uid();
    update((n) =>
      n.scenes.push({
        id,
        name,
        description: "自定义灯光情景",
        trigger: "手动",
        fade: 1,
        states: Object.fromEntries(
          n.fixtures.map((f) => [
            f.id,
            {
              on: true,
              brightness: Math.min(brightness, f.brightnessMax),
              cct: Math.min(f.cctMax, Math.max(f.cctMin, cct)),
            },
          ]),
        ),
      }),
    );
    setActiveScene(id);
  }
  function presets() {
    const standard = sceneTemplates.map((item) => [item.code + " " + item.name, item.description, item]);
    let created = 0;
    let synced = 0;
    update((n) => {
      // 每个标准情景里每盏灯的状态，全部由编号（空间+位置）推导，不手工维护。
      const statesFor = (label: string, template: any) => {
        const states: Obj = {};
        n.fixtures.forEach((f) => {
          const parsed = parseFixtureCode(f.code || "");
          const st =
            template.mode === "all-on"
              ? { on: true, brightness: f.brightnessMax, cct: clampCctForFixture(f, 4000) }
              : template.mode === "all-off"
                ? { on: false, brightness: 0, cct: clampCctForFixture(f, Number(f.cct) || 3000) }
                : standardSceneState(label, parsed, f);
          if (st) states[f.id] = st;
        });
        return states;
      };
      for (const [name, description, template] of standard as any[]) {
        const states = statesFor(name, template);
        const existing = n.scenes.find((s) => s.name === name);
        if (existing) {
          if (!existing.customized) {
            existing.states = states;
            existing.standard = true;
            existing.automationActions = template.automationActions || [];
          }
          synced += 1;
          continue;
        }
        const fade = Number(template.fade);
        n.scenes.push({ id: uid(), templateId: template.id, templateCode: template.code, name, description: "标准化套餐 · " + description, trigger: template.trigger, mode: template.mode, automationActions: template.automationActions || [], fade: Number.isFinite(fade) && fade >= 0 ? fade : 1, states, standard: true });
        created += 1;
      }
    });
    notify(`已写入 ${created} 个标准情景、按编号同步 ${synced} 个；不覆盖同名情景`);
  }
  // 写入场景包：43 个场景一次落库，每盏灯的状态仍由编号（空间×职能×位置）推导。
  function writeScenePackage() {
    let created = 0;
    let synced = 0;
    update((n) => {
      for (const t of PACKAGE_TEMPLATES) {
        const label = t.code + " " + t.name;
        const states: Obj = {};
        n.fixtures.forEach((f) => {
          const parsed = parseFixtureCode(f.code || "");
          const st = parsed
            ? standardSceneState(label, { ...parsed, explicitRole: true }, f)
            : null;
          if (st) states[f.id] = st;
        });
        const existing = n.scenes.find((s) => s.name === label || s.name === t.name);
        if (existing) {
          existing.states = states;
          existing.standard = true;
          existing.templateCode = t.code;
          existing.priority = t.priority;
          existing.level = t.level;
          existing.automationActions = existing.automationActions || [];
          if (!existing.exit) existing.exit = t.exit;
          synced += 1;
          continue;
        }
        n.scenes.push({
          id: uid(),
          templateId: t.id,
          templateCode: t.code,
          name: label,
          description: `${SCENE_PACKAGE.name} · ${t.description}`,
          trigger: t.trigger,
          mode: "standard",
          fade: t.fade,
          priority: t.priority,
          level: t.level,
          exit: t.exit,
          exclude: t.exclude,
          automationActions: [],
          states,
          standard: true,
        });
        created += 1;
      }
    });
    notify(
      `已写入场景包「${SCENE_PACKAGE.name}」：新建 ${created} 个、按编号同步 ${synced} 个情景；不覆盖同名情景`,
    );
  }
  // 一键设置场景：按「户型 + 本项目空间」筛出可用场景后一次写入（默认先清空原有情景）。
  function applySceneSetup() {
    const codes = new Set(setupSel);
    const clearFirst = setupClear;
    let created = 0;
    let synced = 0;
    update((n) => {
      if (clearFirst) n.scenes = [];
      const statesFor = (label: string, t: Obj) => {
        const states: Obj = {};
        n.fixtures.forEach((f) => {
          const parsed = parseFixtureCode(f.code || "");
          const st =
            t.mode === "all-on"
              ? { on: true, brightness: f.brightnessMax, cct: clampCctForFixture(f, 4000) }
              : t.mode === "all-off"
                ? { on: false, brightness: 0, cct: clampCctForFixture(f, Number(f.cct) || 3000) }
                : parsed
                  ? standardSceneState(label, { ...parsed, explicitRole: true }, f)
                  : null;
          if (st) states[f.id] = st;
        });
        return states;
      };
      const add = (t: any, label: string) => {
        const states = statesFor(label, t);
        const existing = n.scenes.find((s) => s.name === label || s.name === t.name);
        if (existing) {
          existing.states = states;
          existing.standard = true;
          synced += 1;
          return;
        }
        const fade = Number(t.fade);
        n.scenes.push({ id: uid(), templateId: t.id, templateCode: t.code, name: label, description: t.description || "", trigger: t.trigger || "手动", mode: t.mode || "standard", automationActions: t.automationActions || [], fade: Number.isFinite(fade) && fade >= 0 ? fade : 1, priority: t.priority, level: t.level, exit: t.exit, exclude: t.exclude, states, standard: true });
        created += 1;
      };
      for (const t of sceneTemplates as any[])
        if (t.code === "00.1" || t.code === "00.2") add(t, t.code + " " + t.name);
      for (const t of PACKAGE_TEMPLATES)
        if (codes.has(t.code)) add(t, t.code + " " + t.name);
      if (!noSmart) ensurePanels(n, smart);
    });
    setActiveScene("");
    setModal("");
    notify(`已一键设置 ${created} 个可用情景（按「${p?.type || "平层"}」+ 本项目空间筛选${clearFirst ? "，已清空原情景" : ""}）`);
  }

  /**
   * 一键建立系统架构：按项目智能方案（KNX / 无线 / 无）出设备清单，并给「需求 vs 生成」核对表。
   * 规则与型号在 frontend/src/systemArchitecture.ts（唯一口径）：读灯具控制方式、回路、层数、
   * DALI 地址与总线电流算台数，型号从世聪 KNX 体系产品清单取，不再写死 DG-16 这种占位型号。
   * 只重建 source=auto-arch 的自动行，手动加的设备一律保留。
   */
  function buildSystemArchitecture() {
    const planBox: { v: ReturnType<typeof planArchitecture> | null } = { v: null };
    update((n) => {
      if (!noSmart) ensurePanels(n, smart);
      planBox.v = planArchitecture(n, p || {});
      const rows: Obj[] = planBox.v?.devices || [];
      // 老生成器的占位行（DG-16 / CTL-待定）没有 source 标记，也一并换掉，否则会与新规则行重复。
      const manual = (n.devices || []).filter((v) => v.source !== "auto-arch" && !isLegacyAuto(v));
      const auto = rows.flatMap((d) =>
        d.qty <= 1
          ? [{ id: uid(), address: "待编址", source: "auto-arch", ...d, roomId: d.roomId || "" }]
          : Array.from({ length: d.qty }, (_, i) => ({
              id: uid(), address: "待编址", source: "auto-arch",
              ...d, qty: 1, roomId: d.roomId || "", notes: `${d.notes || ""}（第 ${i + 1}/${d.qty} 台）`,
            })));
      n.devices = manual.concat(auto);
      n.architecture = {
        mode: "自动建立后可手动调整",
        topology: planBox.v?.topology || "",
        checks: planBox.v?.checks || [],
        warnings: planBox.v?.warnings || [],
        generatedAt: new Date().toISOString(),
      };
    });
    const plan = planBox.v as ReturnType<typeof planArchitecture> | null;
    const bad = (plan?.checks || []).filter((c) => !c.ok).length;
    const firstWarn = (plan?.warnings || [])[0];
    notify(
      plan
        ? `已按「${smartLabelOrNone(String(p?.smart || ""))}」建立 ${(plan?.devices || []).length} 类设备${bad ? `；${bad} 项要对一下` : "；核对表全部通过"}${firstWarn ? `（${firstWarn}）` : ""}`
        : "已建立基础智能架构",
    );
  }
  // 情景编辑草稿：只改草稿，不碰设计；只有「保存场景」/「保存」才写回。
  function editSceneDraft(fn: (s: Obj) => void) {
    if (!liveScene || locked) return;
    const base = liveScene;
    setSceneDraft((prev) => {
      const cur: Obj = prev && prev.id === base.id ? clone(prev) : clone(base);
      fn(cur);
      return cur;
    });
  }
  // 把情景草稿写回设计（「保存场景」/「保存」时调用）。
  function commitSceneDraft() {
    const dr = sceneDraft;
    setSceneDraft(null);
    if (!dr) return false;
    update((n) => {
      const i = n.scenes.findIndex((s) => s.id === dr.id);
      if (i >= 0) n.scenes[i] = clone(dr);
    });
    return true;
  }
  function scenePatch(k: string, v: any) {
    if (!scene) return;
    editSceneDraft((s) => {
      s[k] = v;
    });
  }
  function lampState(fid: string, k: string, v: any) {
    if (!scene) return;
    editSceneDraft((s) => {
      const f = (d?.fixtures || []).find((x) => x.id === fid);
      if (!f) return;
      s.states[fid] = {
        on: false,
        brightness: Math.min(80, f.brightnessMax),
        cct: f.cctMin,
        ...s.states[fid],
        [k]: v,
      };
      s.customized = true;
    });
  }
  async function filesUpload(
    list: FileList | null,
    recognize = true,
    targetFloor = floor,
  ) {
    if (!list?.length) return;
    const chosen = Array.from(list);
    const count = chosen.length;
    const fd = new FormData();
    chosen.forEach((f) => fd.append("files", f));
    // 只读图纸上的空间名称文字：识别到什么就直接建什么空间，不再手输、不画边界。
    fd.append("recognize", recognize ? "true" : "false");
    fd.append("mode", "labels");
    fd.append("floor", String(targetFloor));
    // 楼层交给后端按文件名判定（地下层图纸还会自动补齐地下层数），
    // 判不出来的才用上面选的兜底楼层；这里不再重复判定，避免两边互相覆盖。
    fd.append("auto_floor", "true");
    await run(async () => {
      await flush();
      let result = await api<Project>(`/projects/${id}/files`, {
        method: "POST",
        body: fd,
      });
      let added = result.files.slice(-count);
      // 每张图纸的识别草稿落到它自己那一层；已有设计的项目后端不自动落库，这里逐张追加。
      let recognized = 0;
      for (const file of added) {
        const draft = file.recognition;
        if (!recognize || !draft?.rooms?.length) continue;
        recognized += draft.rooms.length;
        if (draft.applied) continue;
        try {
          result = await api<Project>(`/projects/${id}/recognition/apply`, {
            method: "POST",
            body: JSON.stringify({ fileId: file.id }),
          });
        } catch (e: any) {
          notify(`「${file.name}」已识别到空间，但自动落库失败：${e.message}`);
        }
      }
      // 导入图纸后重新显示灰色蒙版，确定后消失。
      if (result.design) result.design.planMasked = true;
      w.accept(result);
      update(n => { n.spaceDefinition = { ...n.spaceDefinition, status: "draft", workflowStep: "recognition",
        roomsConfirmedAt: "", openingsConfirmedAt: "" }; });
      if (!noSmart) update((n) => ensurePanels(n, smart));
      added = result.files.slice(-count);
      setFileFloors((v) => {
        const next = { ...v };
        added.forEach((f) => (next[f.id] = Number(f.floor) || 1));
        return next;
      });
      const base =
        added.find((f) => f.id === result.design.baseFileId && f.preview) ||
        added.find((f) => f.preview);
      if (base && !result.design.baseFileId) {
        update((n) => {
          n.baseFileId = base.id;
        });
      }
      // 底图按楼层自动解析；图纸属于哪一层就切到哪一层。
      setBackground("");
      const floors = Array.from(
        new Set(added.map((f) => Number(f.floor) || 1)),
      );
      if (recognize && floors.length) setFloor(floors[0]);
      setSelection(null);
      setTool("select");
      setCanvasReset((v) => v + 1);
      setModal("");
      setTab(recognized ? "plan" : "fixtures");
      // 3D 项目导入 DXF：自动跑一次三维生成，生成完直接进「空间预览」（不用再手动点）。
      const dxfFile = added.find(
        (f: Obj) =>
          String(f.type || "").toUpperCase() === "DXF" ||
          String(f.name || "").toLowerCase().endsWith(".dxf"),
      );
      if (p?.mode === "3D" && dxfFile) void preview3d(dxfFile.id);
      else void openSpacePreview();
      const summary = floorSummary(
        added,
        (p?.floors || 1) > 1,
        p?.basements || 0,
      );
      const grew = added.some(
        (f: Obj) =>
          typeof f.floorNote === "string" && f.floorNote.includes("自动补齐层数"),
      );
      notify(
        [
          recognized
            ? `已在${floors.length > 1 ? "各自楼层" : floorLabel(floors[0] ?? targetFloor, p?.basements || 0)}建立 ${recognized} 个空间（无需画边界）`
            : base
              ? "图纸已作为底图，可直接布灯：选好空间与位置即自动编号（如 kc001）并同步标准情景"
              : "文件已保存；该格式无预览，可手动新建空间",
          recognized ? "编号自动带空间与位置（如 kc001）" : "",
          summary ? `落层：${summary}` : "",
          grew
            ? `已按文件名自动补齐层数，现在是${levelSummary(result.floors, result.basements)}`
            : "",
        ]
          .filter(Boolean)
          .join("；"),
      );
    }, "");
  }
  // 「修改边界」要在 DXF 底图上描多边形（实测 2026-10-14）：这里直接把项目里那张 DXF 的
  // 预览图（服务端按需渲染的 PNG）交给预览层当底图，不依赖文件的 preview 标记是否已回填。
  const dxfPreviewUrl = (() => {
    const f = (p?.files || []).find(
      (x: Obj) => String(x.type || "").toUpperCase() === "DXF" || /\.dxf$/i.test(String(x.name || "")),
    );
    return f ? `/api/projects/${id}/files/${f.id}?preview=true` : "";
  })();

  // 主画布上叠的那张 DXF 底图同样要按设计坐标摆：底图是图纸原始坐标渲的，
  // 空间边界用的是三维那套「米」坐标，不换算就会错开（跟「空间范围」页一个口径）。
  const [planBg, setPlanBg] = useState<Obj | null>(null);
  useEffect(() => {
    if (!p?.id) return;
    let dead = false;
    setFurnitureLoading(!Array.isArray(d?.furniture));
    api<Obj>(`/lighting3d/${id}`)
      .then((s) => {
        if (dead) return;
        if (s?.plan_background) setPlanBg(s.plan_background);
        setLegacyFurniture(furnitureFromModel(s?.furniture || [], d?.rooms || []));
      })
      .catch(() => {})
      .finally(() => { if (!dead) setFurnitureLoading(false); });
    return () => {
      dead = true;
    };
  }, [id, p?.id, dxfPreviewUrl, spacePreview?.state]);
  /** 只有「当前铺的这张底图就是那张 DXF 预览」时才给矩形，别把别的底图也拉变形。 */
  const bgRectFor = (url: string) => {
    return planBg && url && String(planBg.url) === url
      ? { x: Number(planBg.x), y: Number(planBg.y), w: Number(planBg.w), h: Number(planBg.h) }
      : null;
  };

  /** 三维生成 + 空间预览层（2026-10-12 本地口径：预览与修改都在同一个界面里）。 */
  async function preview3d(fileId: string) {
    setSpacePreview({ state: "running", recognizing: true, pct: 0, stage: "准备生成三维…", editorKey: uid(), initialPhase: "review" });
    try {
      await flush();
      const fd = new FormData();
      fd.append("file_id", fileId);
      await api(`/lighting3d/${id}/generate`, { method: "POST", body: fd });
    } catch (e: any) {
      setSpacePreview({ state: "error", error: e.message, stage: "生成失败" });
      return;
    }
    for (let i = 0; i < 900; i += 1) {
      const j = await api<Obj>(`/lighting3d/${id}/job`).catch(() => null);
      if (!j) continue;
      if (j.state !== "running" && j.state !== "idle") {
        setSpacePreview(j);
        if (j.state === "done") await openSpacePreview();
        return;
      }
      setSpacePreview(v => ({ ...v, ...j }));
      await new Promise((r) => setTimeout(r, 800));
    }
    setSpacePreview({ state: "error", error: "生成超时，请到三维页重试", stage: "生成失败" });
  }

  /** 生成完先把「预览里那套空间」落成**可编辑**的设计空间，再开预览层（就地改名 / 拖边界）。 */
  async function openSpacePreview(initialPhase?: EditingPhase) {
    const editorKey = uid();
    // 已确认的项目点进来就是「回来改东西」：落在修改空间，进度条才不会退回三维预览（2026-10-16）。
    const phase = initialPhase
      || (d?.spaceDefinition?.status === "confirmed" ? "spaces" : "review");
    setSpacePreview({ state: "running", recognizing: false, pct: 0, stage: "正在准备空间与底图…", initialPhase: phase, editorKey });
    try {
      await flush();
      if (!initialPhase || initialPhase === "review") await api(`/lighting3d/${id}/preview-to-design`, { method: "POST" });
      w.accept(await api<Project>(`/projects/${id}`));
    } catch (e: any) {
      notify(`空间预览准备失败：${e.message}`);
    }
    setSpacePreview((v) => ({ ...(v || {}), state: "done" }));
  }

  async function confirmRoomsAndOpenings() {
    await operation("/space-definition/confirm", { stage: "rooms", floor, reviewer: p?.designer || "设计师" });
    await openSpacePreview("openings");
  }

  function jumpDrawingStep(step: DrawingStep) {
    if (step === "upload") openFiles();
    else if (step === "canvas") { setTab("plan"); setView3d(true); }
    else if (["review", "spaces", "openings", "furniture"].includes(step)) void openSpacePreview(step as EditingPhase);
  }

  async function enterConfirmedCanvas() {
    const fresh = await api<Project>(`/projects/${id}`);
    if (fresh.design.spaceDefinition?.status !== "confirmed") throw new Error("空间尚未确认，请重试");
    w.accept(fresh);
    setSpacePreview(null);
    setTab("plan"); setModal(""); setSelection(null); setTool("select");
    setShowCadWorkbench(false); setView3d(true);
    setFurnitureEditing(false); setSelectedFurnitureId(""); setMovingFurniture(false); setPlacingFurniture("");
    setBackground(""); setCanvasReset(v => v + 1);
  }

  /** 画布上画完一圈家具轮廓（2026-10-16：家具也要能像空间那样多边形绘制）。 */
  function onFurnPolygonCanvas(pts: { x: number; y: number }[]) {
    if (!d || pts.length < 3) return;
    const rows = (d.furniture || []) as Obj[];
    try {
      if (selectedFurnitureId) {
        const base = rows.find(f => f.id === selectedFurnitureId);
        if (base) {
          const updated = { ...withFurniturePolygon(base, pts), roomId: base.roomId };
          change({ ...d, furniture: rows.map(f => f.id === base.id ? updated : f) });
          notify(`已按画的轮廓改「${base.kind}」的边界，可继续拖顶点微调`);
        }
      } else {
        const kind = placingFurniture || "沙发";
        const room = (d.rooms || []).find(r => +(r.floor || 1) === floor && pointInSpace(r, pts[0].x, pts[0].y));
        const item = withFurniturePolygon(
          createFurniture(kind, room || ({ id: "", heightM: 3 } as Obj), pts[0].x, pts[0].y), pts);
        change({ ...d, furniture: [...rows, item] });
        setSelectedFurnitureId(item.id);
        notify(`已按轮廓新增「${kind}」${room ? `（${room.name}）` : "（未归属空间）"}，可拖顶点继续改`);
      }
    } catch (e: any) { notify(e.message); }
    setPlacingFurniture(""); setMovingFurniture(false); setTool("select");
  }

  // 2026-10-16：画布上家具一律锁定——只有灯具与设备可挪动。原来点一下家具就
  // 自动进「调整家具」并允许拖动，而俯视图里灯具正压在家具上，随手一点一拖就把家具拖跑了。
  // 现在点一下只高亮 + 提示；要改家具就点「调整家具」，或去「导入图纸 → 家具」。
  function selectCanvasFurniture(fid: string) {
    setSelectedFurnitureId(fid);
    setSelection(null); setTool("select"); setMovingFurniture(false); setPlacingFurniture("");
    if (!furnitureEditing) {
      notify("家具在画布上已锁定：要改家具请点「调整家具」，或到「导入图纸 → 家具」里调整");
      return;
    }
    setFurniture(true);
  }

  // 某张图纸的楼层来源说明：按文件名识别的明确标出，判不出来的提示手选。
  function floorTag(f: Obj) {
    const basements = p?.basements || 0;
    if ((p?.floors || 1) <= 1) return null;
    const current = Number(fileFloors[f.id] ?? f.floor ?? 1);
    // 每次都按当前楼层设置重算：改过地上/地下层数后提示不会过期。
    const guess = detectFloorFromName(f.name, p?.floors || 1, basements);
    if (guess.floor)
      return guess.floor === current ? (
        <span className="floor-hint auto">
          按文件名识别：{floorLabel(current, basements)}
        </span>
      ) : (
        <span className="floor-hint warn">
          文件名指向 {floorLabel(guess.floor, basements)}，已手动归到{" "}
          {floorLabel(current, basements)}
        </span>
      );
    if (guess.note) return <span className="floor-hint warn">{guess.note}</span>;
    return <span className="floor-hint">文件名未含楼层，按所选楼层</span>;
  }
  // 单独改某张图纸的楼层：立刻落库，图纸上已建的空间与灯具一起搬到新层，不用重新识别。
  function changeFileFloor(f: Obj, next: number) {
    setFileFloors((v) => ({ ...v, [f.id]: next }));
    if (Number(f.floor) === next) return;
    run(async () => {
      await flush();
      const fresh = await api<Project>(`/projects/${id}/files/${f.id}`, {
        method: "PATCH",
        body: JSON.stringify({ floor: next }),
      });
      w.accept(fresh);
      if ((p?.floors || 1) > 1) setFloor(next);
      notify(
        `「${f.name}」已归到 ${floorLabel(next, p?.basements || 0)}；该图纸上的空间与灯具一并迁移`,
      );
    }, "");
  }
  // 多页 PDF 选页：换页后预览/底图改成该页，后续识别也读该页；已落库空间不动。
  function changePdfPage(f: Obj, page: number) {
    if ((Number(f.page) || 1) === page) return;
    run(async () => {
      await flush();
      w.accept(await api<Project>(`/projects/${id}/files/${f.id}/page`, {
        method: "POST",
        body: JSON.stringify({ page }),
      }));
      notify(`「${f.name}」已改用第 ${page} 页；需要时请在该页上重新分析空间`);
    }, "");
  }
  // 楼层设置：地上/地下层数。加地下层时已有图纸与空间整体上移，标签不变
  // （原来的一层还是 1F），新加的地下室在最底下记作 B1。
  function saveLevels() {
    const above = Math.max(1, Math.floor(levelAbove || 1));
    const below = Math.max(0, Math.floor(levelBasements || 0));
    run(async () => {
      await flush();
      const fresh = await api<Project>(`/projects/${id}/levels`, {
        method: "PATCH",
        body: JSON.stringify({ floors: above + below, basements: below }),
      });
      w.accept(fresh);
      setFileFloors(
        Object.fromEntries(
          (fresh.files || []).map((f: Obj) => [f.id, Number(f.floor) || 1]),
        ),
      );
      const all = floorLevels(fresh.floors, fresh.basements);
      if (!all.some((lv) => lv.value === floor))
        setFloor(all[all.length - 1].value);
      notify(
        `楼层已更新：${levelSummary(fresh.floors, fresh.basements)}；图纸与空间已随之上移/下移`,
      );
    }, "");
  }
  // 预留接口：上传 IES 只存档并标记，光斑仍按半角光束角理论值计算。
  async function uploadIes(file?: File) {
    if (!file || selection?.kind !== "fixtures" || !selected) return;
    const fd = new FormData();
    fd.append("file", file);
    await run(async () => {
      const next = await api(`/projects/${id}/fixtures/${selected.id}/ies`, {
        method: "POST",
        body: fd,
      });
      w.accept(next);
      notify(`IES 已上传：${file.name}（已解析配光参考；光斑仍按光束角理论值，不做正式照度计算）`);
    }, "");
  }
  // 现场照片 / 签字 PDF：只存档，不改画布真源。
  async function uploadSiteEvidence(file?: File) {
    if (!file) return;
    const fd = new FormData();
    fd.append("file", file);
    fd.append("kind", file.type === "application/pdf" ? "signature" : "photo");
    await run(async () => {
      const next = await api(`/projects/${id}/site-evidence`, { method: "POST", body: fd });
      w.accept(next);
      notify(`现场资料已存档：${file.name}`);
    }, "");
  }
  async function deleteSiteEvidence(eid: string) {
    await run(async () => {
      const next = await api(`/projects/${id}/site-evidence/${eid}`, { method: "DELETE" });
      w.accept(next);
      notify("现场资料已删除");
    }, "");
  }
  // D-10 C9：导出对象。owner=给业主（含参考价）、site=给施工（不含价）、internal=内部版（保留参考价）。
  // 金额清零由后端 audience 参数执行；前端负责选对象、不重复传价格。
  async function download(format: string, audience: "owner" | "site" | "internal" = exportAudience) {
    await run(async () => {
      await flush();
      const qs = new URLSearchParams({ floor: String(floor) });
      qs.set("audience", audience);
      const r = await fetch(
        `/api/projects/${id}/export/${format}?${qs.toString()}`,
      );
      if (!r.ok) {
        // R5：被拦时 422 正文就是红色提示原文，原样显示，不换成泛泛的「导出失败」。
        const body = await r.text();
        let msg = body;
        try {
          msg = JSON.parse(body).detail || body;
        } catch {}
        throw Error(msg || "导出失败");
      }
      const warn = r.headers.get("X-Export-Warnings");
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const cd = r.headers.get("Content-Disposition") || "";
      a.download = decodeURIComponent(
        cd.split("UTF-8''")[1] || `${p!.code}_V${p!.version}.${format}`,
      );
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      // 提示档（业主 HTML、图片）照出，带上回路问题原文。
      const pricingMode = r.headers.get("X-Pricing-Mode");
      const audienceNote =
        audience === "site"
          ? "（施工版 · 不含参考价）"
          : audience === "owner"
            ? "（业主版 · 含参考价）"
            : "（内部版 · 含参考价）";
      notify(
        "导出文件已生成" + audienceNote +
        (pricingMode ? `；价格：${pricingMode === "excluded" ? "已去价" : "保留"}` : "") +
        (warn ? "；回路问题：" + decodeURIComponent(warn) : ""),
      );
    }, "");
  }
  const historyOpen = () =>
    run(async () => {
      await flush();
      setVersions(await api(`/projects/${id}/versions`));
      setEvents(await api(`/projects/${id}/events`));
      setModal("history");
    }, "");
  if (w.loadError)
    return (
      <div className="loading">
        <AlertCircle />
        {w.loadError}
        <Button onClick={onClose}>返回工作台</Button>
      </div>
    );
  if (!p || !d)
    return (
      <div className="loading">
        <Loader2 className="spin" />
        正在打开项目…
      </div>
    );
  // 小人漫游：漫游楼层上带探测半径的传感器；小人进入范围 → 其关联灯具亮（用传感器的亮度/色温）。
  const roamSensors = (d.devices || []).filter(
    (v) =>
      v.type === "传感器" &&
      (Number.isFinite(v.floor)
        ? v.floor
        : d.rooms.find((r) => r.id === v.roomId)?.floor ?? 1) === roamFloor,
  );
  // 挑空（贯通）：本层有别的楼层的挑空灯具时，角上说明一句，免得切层后以为灯没了。
  const floorOfObj = (o: Obj) =>
    Number.isFinite(o?.floor)
      ? Number(o.floor)
      : d.rooms.find((r) => r.id === o?.roomId)?.floor ?? 1;
  const voidNoteFor = (floorNo: number) => {
    const ghosts = ghostFixturesOnFloor(d, floorNo, floorOfObj);
    if (!ghosts.length) return "";
    const froms = Array.from(
      new Set(ghosts.map((g) => floorLabel(g.fromFloor, p.basements || 0))),
    );
    return `本层挑空处另有 ${ghosts.length} 盏灯（${froms.join("、")}，随情景同步）`;
  };
  const voidAreas = areaSummary(d.rooms);
  // 探测范围裁剪几何（②空间边界 + ③墙体）：漫游判定与属性面板共用同一份。
  const coverageCtx = {
    rooms: d.rooms,
    walls: d.walls,
    floorOf: (o: Obj) =>
      Number.isFinite(o?.floor)
        ? Number(o.floor)
        : d.rooms.find((r) => r.id === o?.roomId)?.floor ?? 1,
  };
  const roamOverlay: Record<string, Obj> = {};
  if (roamOn) {
    roamSensors.forEach((sc) => {
      // 判定与画布/交付页同一套：整圆或扇形 + 空间边界/墙体裁剪（隔墙不触发）
      if (!sensorCovers(sc, roamPos.x, roamPos.y, obstaclesFor(sc, coverageCtx))) return;
      (sc.linkedLights || []).forEach((fid: string) => {
        roamOverlay[fid] = {
          on: true,
          brightness: sc.sensorBrightness ?? 100,
          cct: sc.sensorCct ?? 3000,
        };
      });
    });
  }
  // 漫游时把传感器触发的灯叠加在当前情景之上（Plan 只有 scene 存在才会画灯辉光）。
  const roamSceneOf = (base?: Obj) =>
    roamOn
      ? {
          ...(base || {}),
          id: `${base?.id || "roam"}__roam`,
          name: base?.name || "小人漫游",
          fade: 0.4,
          states: { ...(base?.states || {}), ...roamOverlay },
        }
      : base;
  const exportItems = [
    {
      fmt: "html",
      title: "业主版灯光演示 HTML",
      desc: "单个文件、离线可用：把文件发给业主即可打开，可点情景触发、切楼层、看灯具分组",
      icon: Sparkles, fid: "E-01",
    },
    {
      fmt: "panels",
      title: "面板刻字排版图",
      desc: "给面板厂家的可打印刻字清单：按真实键位排布，含每键刻字与绑定情景",
      icon: LayoutGrid, fid: "E-02",
    },
    {
      fmt: "zip",
      title: "完整设计资料包",
      desc: "JSON + 灰度平面 PNG/JPG + PDF + Excel + Word + HTML + 布置 DXF",
      icon: Box, fid: "E-03",
    },
    {
      fmt: "png",
      title: "2D 平面布置图 PNG",
      desc: "普通灰度平面图叠加已布置灯具与设备；不生成不可靠彩平，未标定比例仅供设计参考",
      icon: FileText, fid: "E-04",
    },
    {
      fmt: "jpg",
      title: "2D 平面布置图 JPG",
      desc: "按当前楼层导出普通灰度平面图和灯具设备点位",
      icon: FileText, fid: "E-05",
    },
    {
      fmt: "dxf",
      title: "灯具设备布置图 DXF",
      desc: "含当前灯具、面板和传感器；无原始 CAD 时仅为无标定布置图，须补原始 DXF 和房间边界后才能作为完整施工图",
      icon: PencilRuler, fid: "E-06",
    },
    {
      fmt: "pdf",
      title: "平面图及清单 PDF",
      desc: "逐楼层灰度平面布置图与灯具清单，无需彩平图",
      icon: FileText, fid: "E-07",
    },
    {
      fmt: "xlsx",
      title: "灯具 / 回路 / 场景表",
      desc: "Excel 工作簿，含报价基础数据",
      icon: LayoutGrid, fid: "E-08",
    },
    {
      fmt: "docx",
      title: "灯光设计说明",
      desc: "可编辑 Word 文档与交付限制",
      icon: FileText, fid: "E-09",
    },
    {
      fmt: "json",
      title: "结构化项目文件",
      desc: "可重新导入的 JSON 项目备份",
      icon: Layers3, fid: "E-10",
    },
  ];
  // D-09：价格复核门禁就地提示用——纳价灯具与待核实清单（阈值与后端一致：未核实 >30% 或 >10 行会被拦）。
  const pricedFixtures = (d.fixtures || []).filter((f: Obj) => f.quote);
  const unverifiedFixtures = pricedFixtures.filter((f: Obj) => !f.priceVerified);
  const pricingRiskRatio = pricedFixtures.length ? unverifiedFixtures.length / pricedFixtures.length : 0;
  // 导出按所选「交付对象」走；拦截档（施工包/厂家包）仍按 R5 先跳回路问题。
  const exportWithAudience = (aud: "owner" | "site" | "internal", fmt: string) => {
    const blocked = BLOCKED_EXPORTS.includes(fmt) ? circuitIssues(d) : [];
    const f = blocked.length && d.fixtures.find((x: Obj) => x.id === blocked[0].fixtureIds[0]);
    if (f) locateFixture(f);
    else void download(fmt, aud);
  };
  const markAllPricesVerified = async () => {
    update((n) => {
      (n.fixtures || []).filter((f: Obj) => f.quote).forEach((f: Obj) => (f.priceVerified = true));
    });
    await flush();
    notify(`已把 ${pricedFixtures.length} 盏纳入报价的灯具标为「价格已人工核实」；请回到价格复核重新签名`);
  };
  const hasDxfDrawing = (p.files || []).some((f: Obj) =>
    f.type === "DXF" || /\.dxf$/i.test(String(f.name || "")));
  const capsSnapshot = readCapabilities();
  const capsEdition = String(capsSnapshot?.edition || "");
  const enabledSlots = new Set<string>(((capsSnapshot?.modules || []) as Obj[])
    .filter((m: Obj) => m.enabled)
    .flatMap((m: Obj) => (m.slots || []) as string[]));
  const hasSlot = (slot: string) => enabledSlots.has(slot);
  const demoEdition = (() => { try { return localStorage.getItem("gv.demo.edition") || ""; } catch { return ""; } })();
  const editionMode = capsEdition || demoEdition;
  const knxMode = p.smart === "KNX" || (capsSnapshot ? hasSlot("panel:knx-mapping") : (editionMode === "knx" || editionMode === "enterprise"));
  const entMode = capsSnapshot ? hasSlot("deliver:quote") : editionMode === "enterprise";
  const iesMode = capsSnapshot ? hasSlot("panel:ies") : true;
  const capModules = ((capsSnapshot?.modules || []) as Obj[]).filter((m: Obj) => m.enabled && m.pack !== "kernel");
  const capModuleRows = capModules.slice().sort((a: Obj, b: Obj) =>
    (b.pack === "pack.enterprise" ? 1 : 0) - (a.pack === "pack.enterprise" ? 1 : 0)).slice(0, 6);
  const planMode = capsSnapshot ? hasSlot("dock:plan") : true;
  const spaceMode = planMode;
  const siteCount = (p.siteEvidence || []).length;
  const siteMB = ((p.siteEvidence || []).reduce((n: number, e: Obj) => n + Number(e.bytes || 0), 0) / 1048576).toFixed(1);
  const v2SelFix = selection?.kind === "fixtures" ? (d.fixtures || []).find((f: Obj) => f.id === selection.id) : null;
  const v2SelRoom = v2SelFix ? (d.rooms || []).find((r: Obj) => r.id === v2SelFix.roomId) : (selection?.kind === "rooms" ? (d.rooms || []).find((r: Obj) => r.id === selection.id) : null);
  const v2Site = ((d as Obj).siteCheck || {}) as Obj;
  const v2QuoteCount = (d.fixtures || []).filter((f: Obj) => f.quote).length;
  const v2InspTabs = ["属性", ...(knxMode ? ["组地址", "现场核对"] : []), ...(iesMode ? ["IES"] : []), ...(entMode ? ["报价"] : [])];
  const treeSec = (key: string) => ({ open: v2SecOpen[key] !== false });
  const treeToggle = (key: string) => (e: any) => {
    e.preventDefault();
    setV2SecOpen(prev => {
      const open = prev[key] !== false;
      const next = { ...prev, [key]: !open };
      try { localStorage.setItem("gv.tree.sections", JSON.stringify(next)); } catch {}
      return next;
    });
  };
  const railMain = [
    { id: "plan", label: "图纸", icon: Layers3, tab: "plan", fid: "P-05" },
    { id: "fixtures", label: "布灯", icon: Lightbulb, tab: "fixtures", fid: "P-06" },
    { id: "review", label: "复核", icon: ShieldCheck, tab: "deliver", fid: "P-07" },
    { id: "export", label: "交付", icon: Download, tab: "deliver", fid: "P-08" },
  ];
  const railPlugins = [
    ...((!capsSnapshot || hasSlot("dock:scenes")) ? [{ id: "scenes", label: "情景", icon: Sun, tab: "scenes", fid: "P-09" }] : []),
    ...((!capsSnapshot || hasSlot("canvas:render")) ? [{ id: "renders", label: "示意", icon: Image, tab: "renders", fid: "P-10" }] : []),
  ];
  const dockKnx = capsSnapshot ? hasSlot("dock:knx") : knxMode;
  const goV2 = (section: string, t: string) => {
    setV2Section(section);
    setV2Tree(true);
    if (section === "review") setV2Delivery("review");
    if (section === "export") setV2Delivery("export");
    setTab(t);
  };
  return (
    <div className={"studio-shell" + (shellV2 ? " wsv2" : "") + (shellV2 && tab === "plan" ? " wsv2-plan" : "") + (v2Tree ? " wsv2-treeopen" : "") + (shellV2 && tab === "deliver" ? (" wsv2-d" + v2Delivery) : "") + (shellV2 && tab === "scenes" && p.mode === "3D" && view3d ? " scene3d-full" : "")}>
      {shellV2 ? (
        <>
          <header className="wsv2-top">
            <button className="wsv2-back" onClick={leave} aria-label="返回工作台" data-fid="P-01"><ArrowLeft size={18} /></button>
            <div className="wsv2-brand"><span className="wsv2-mark" /><span><b>光律</b><small>GUANGLV</small></span></div>
            <span className="wsv2-div" />
            <div className="wsv2-pname" data-fid="X-13">
              <b>{p.name}</b>
              <span className="wsv2-status">{p.status}</span>
              <small>{p.code} · {p.city || "城市未填"} · {p.area} ㎡ · V{String(p.version).padStart(2, "0")}{smartLabelOf(p.smart) ? ` · ${smartLabelOf(p.smart)}` : ""}</small>
            </div>
            <span className="wsv2-sp" />
            <span className="wsv2-save" data-fid="X-14">
              {w.saving ? <Loader2 className="spin" size={13} /> : w.saveError ? <AlertCircle size={13} /> : w.dirty ? <Clock3 size={13} /> : <CheckCircle2 size={13} />}
              {w.saving ? "保存中" : w.saveError ? "保存失败" : w.dirty ? "等待保存" : "已保存至本地"}
            </span>
            <button className="wsv2-btn" onClick={historyOpen} data-fid="P-02"><History size={14} /> 版本</button>
            <button className="wsv2-btn" disabled={busy || locked} onClick={save} title="编辑会自动保存；这里立即保存一次" data-fid="P-03"><Save size={14} /> 立即保存</button>
            <button className="wsv2-btn gold" onClick={() => goV2("export", "deliver")} title="打开「复核与交付」页" data-fid="P-04"><Download size={14} /> 复核与交付</button>
          </header>
          <nav className="wsv2-rail">
            <span className="wsv2-rgroup">主流程</span>
            {railMain.map((t) => (
              <button key={t.id} className={"wsv2-railbtn" + (v2Section === t.id ? " on" : "")} title={t.label} onClick={() => goV2(t.id, t.tab)} data-fid={t.fid}>
                <t.icon size={17} /><span>{t.label}</span>
              </button>
            ))}
            <span className="wsv2-rgroup">插件</span>
            {railPlugins.map((t) => (
              <button key={t.id} className={"wsv2-railbtn" + (v2Section === t.id ? " on" : "")} title={t.label} onClick={() => goV2(t.id, t.tab)} data-fid={t.fid}>
                <t.icon size={17} /><span>{t.label}</span>
              </button>
            ))}
            {dockKnx && <button className="wsv2-railbtn" title="KNX 工程" onClick={() => notify("KNX 工程：S0 接入；当前先走旧版交付页")} data-fid="P-11"><Grid2X2 size={17} /><span>KNX</span></button>}
            <span className="wsv2-sp" />
            <button className={"wsv2-railbtn" + (v2Tree ? " on" : "")} title="项目结构" onClick={() => setV2Tree(v => !v)} data-fid="P-12"><Grid2X2 size={17} /><span>结构</span></button>
            <button className="wsv2-railbtn" title="能力与插件" onClick={() => notify("能力与插件：首页能力抽屉已可用，项目内接口下一批接入")} data-fid="P-13"><PanelRightClose size={17} /><span>能力</span></button>
            <button className="wsv2-railbtn" title="返回工作台" onClick={leave} data-fid="P-14"><ArrowLeft size={17} /><span>返回</span></button>
          </nav>
          <aside className={"wsv2-tree" + (v2Tree ? " on" : "")} data-fid="P-16">
            <div className="wsv2-treeh"><b>项目结构</b><span>对象层</span><span className="wsv2-sp" /><button title="管理空间" onClick={() => setModal("spaces")} data-fid="P-17"><Plus size={14} /></button><button onClick={() => setV2Tree(false)} data-fid="P-18"><X size={14} /></button></div>
            <div className="wsv2-treeb">
              {spaceMode && <details className="wsv2-dsec" {...treeSec("空间")} data-fid="P-19">
                <summary onClick={treeToggle("空间")}>空间</summary>
                {(d.rooms || []).filter((r: Obj) => Number(r.floor || 1) === floor).map((r: Obj) => (
                  <button key={r.id} className={"wsv2-trow" + (selection?.kind === "rooms" && selection.id === r.id ? " on" : "")}
                    onClick={() => { setSelection({ kind: "rooms", id: r.id }); goV2("plan", "plan"); }}>
                    <span className="wsv2-tdot" />{r.name}<span className="wsv2-tcnt">{(d.fixtures || []).filter((f: Obj) => f.roomId === r.id).length}</span>
                  </button>
                ))}
                {!(d.rooms || []).filter((r: Obj) => Number(r.floor || 1) === floor).length && <div className="wsv2-tempty">本层暂无空间</div>}
              </details>}
              <details className="wsv2-dsec" {...treeSec("对象")} data-fid="P-20">
                <summary onClick={treeToggle("对象")}>对象</summary>
                {[
                  ["回路", Array.from(new Set((d.fixtures || []).map((f: Obj) => f.circuit).filter(Boolean))).length],
                  ["灯位", (d.fixtures || []).length],
                  ["设备", (d.devices || []).length],
                  ...((!capsSnapshot || hasSlot("dock:scenes")) ? [["情景", (d.scenes || []).length]] : []),
                  ...(knxMode ? [["KNX 组地址", (d.fixtures || []).filter((f: Obj) => f.address).length]] : []),
                  ...(iesMode ? [["IES 绑定", (d.fixtures || []).filter((f: Obj) => f.ies).length]] : []),
                ].map(([k, n]) => (
                  <div className="wsv2-trow" key={String(k)}><span className="wsv2-tdot" />{k}<span className="wsv2-tcnt">{n}</span></div>
                ))}
              </details>
              <details className="wsv2-dsec" {...treeSec("交付")} data-fid="P-21">
                <summary onClick={treeToggle("交付")}>交付</summary>
                <div className="wsv2-trow"><span className="wsv2-tdot red" />缺件单<span className="wsv2-tcnt">{circuitIssues(d).length}</span></div>
                <div className="wsv2-trow"><span className="wsv2-tdot" />导出格式<span className="wsv2-tcnt">10</span></div>
                {entMode && <div className="wsv2-trow"><span className="wsv2-tdot" />报价<span className="wsv2-tcnt">{v2QuoteCount} / {(d.fixtures || []).length}</span></div>}
                {knxMode && <div className="wsv2-trow"><span className="wsv2-tdot" />KNX 刻字/调试<span className="wsv2-tcnt">本机</span></div>}
                {iesMode && <div className="wsv2-trow"><span className="wsv2-tdot" />IES 绑定<span className="wsv2-tcnt">{(d.fixtures || []).filter((f: Obj) => f.ies).length}</span></div>}
              </details>
              {planMode && <details className="wsv2-dsec" {...treeSec("图层")} data-fid="P-22">
                <summary onClick={treeToggle("图层")}>图层</summary>
                {([
                  ["家具占位", furniture, setFurniture],
                  ["灯具位置", lights, setLights],
                  ["灯具编号", labels, setLabels],
                  ["网格参考", grid, setGrid],
                ] as any[]).map(([k, v, set]: any) => (
                  <label className="wsv2-tcheck" key={k}><span className="wsv2-tbox" style={{ background: v ? "#c79a4f" : "transparent" }} />{k}
                    <input type="checkbox" checked={!!v} onChange={(e) => set(e.target.checked)} style={{ display: "none" }} /></label>
                ))}
              </details>}
              <details className="wsv2-dsec" {...treeSec("能力")} data-fid="P-23">
                <summary onClick={treeToggle("能力")}>能力</summary>
                {capModuleRows.map((m: Obj) => (
                  <div className="wsv2-trow" key={m.id}><span className="wsv2-tdot" />{m.id}<span className="wsv2-tcnt">{String(m.pack || "").replace("pack.", "")}</span></div>
                ))}
                {capModules.length === 0 && <div className="wsv2-tempty">个人版 · 仅内核</div>}
                {capModules.length > 0 && <div className="wsv2-trow"><span className="wsv2-tdot" />启用模块<span className="wsv2-tcnt">{capModules.length}</span></div>}
              </details>
              {(knxMode || entMode) && <details className="wsv2-dsec" {...treeSec("现场基准 L1")} data-fid="P-24">
                <summary onClick={treeToggle("现场基准 L1")}>现场基准 L1</summary>
                <div className="wsv2-trow wsv2-tmuted">客厅 · 4 角照 + 三尺寸</div>
                <div className="wsv2-trow wsv2-tmuted">主卧 · 4 角照 + 三尺寸</div>
                <div className="wsv2-trow wsv2-tmuted">待补：次卧 3 尺寸</div>
              </details>}
            </div>
          </aside>
          {v2Preview && (
            <div className="wsv2-lightbox" onClick={() => setV2Preview("")} data-fid="X-15">
              <img src={v2Preview} alt="现场资料预览" />
              <button title="关闭" onClick={() => setV2Preview("")}><X size={18} /></button>
            </div>
          )}
          <div className="wsv2-statusbar" data-fid="X-12">
            <span>本地 · SQLite</span><span>数据版本 V{String(p.version).padStart(2, "0")}</span>
            <span className="wsv2-sp" />
            <span>空间 {(d.rooms || []).length} · 灯位 {(d.fixtures || []).length} · 设备 {(d.devices || []).length}</span>
            <span>1F</span><span className="wsv2-gold">外壳 v2</span>
          </div>
        </>
      ) : (
      <header className="studio-header" data-fid="P-29">
        <button className="studio-back" onClick={leave} aria-label="返回工作台">
          <ArrowLeft size={20} />
        </button>
        <div className="brand compact">
          <span className="brand-mark">
            <i />
            <b />
          </span>
        </div>
        <span className="header-divider" />
        <div className="studio-project-name">
          <h2>
            {p.name}
            <Badge status={p.status} />
          </h2>
          <small>
            {p.code} <i /> {p.city || "城市未填写"} · {p.area} m² · V
            {String(p.version).padStart(2, "0")}
            {smartLabelOf(p.smart) ? <><i /> {smartLabelOf(p.smart)}</> : null}
          </small>
        </div>
        <div className="studio-header-actions">
          {/* 三维只在「智能情景」页：绘图页（底图与空间）不放三维，切换按钮也只在这里出现 */}
          {p.mode === "3D" && tab === "scenes" && <>
            <Button onClick={() => setView3d((v) => !v)} fid="V-01">{view3d ? "看平面图" : "看三维演示"}</Button>
            {hasDxfDrawing && <Button onClick={() => setShowCadWorkbench(true)} fid="V-02">三维模型 / 同步灯位</Button>}
          </>}
          <span className={"save-state " + (w.saveError ? "error-text" : "")}>
            {w.saving ? (
              <Loader2 className="spin" size={14} />
            ) : w.saveError ? (
              <AlertCircle size={14} />
            ) : w.dirty ? (
              <Clock3 size={14} />
            ) : (
              <CheckCircle2 size={14} />
            )}{" "}
            {w.saving
              ? "保存中"
              : w.saveError
                ? "保存失败"
                : w.dirty
                  ? "等待保存"
                  : "已保存至本地"}
          </span>
          <Button onClick={historyOpen} fid="P-02">
            <History size={16} />
            <span>版本记录</span>
          </Button>
          <Button disabled={busy || locked} onClick={save} title="编辑会自动保存；这里立即保存一次" fid="P-03">
            <Save size={16} />
            <span>立即保存</span>
          </Button>
          <Button variant="primary" onClick={() => setTab("deliver")} fid="P-04">
            <Download size={16} />
            复核与交付
          </Button>
        </div>
      </header>
      )}
      {!shellV2 && (
      <div className={"studio-tabbar" + (tabFade.l ? " tabbar-fade-l" : "") + (tabFade.r ? " tabbar-fade-r" : "")} data-fid="P-30">
        <div ref={tabbarScrollRef} onScroll={syncTabFade}>
          {[
            { id: "plan", label: "底图与空间", icon: Layers3, fid: "P-05" },
            { id: "fixtures", label: "灯具配置", icon: Lightbulb, fid: "P-06" },
            { id: "scenes", label: "智能情景", icon: Sun, fid: "P-09" },
            { id: "renders", label: "效果与示意", icon: Image, fid: "P-10" },
            { id: "deliver", label: "复核与交付", icon: ShieldCheck, fid: "P-08" },
          ].map((t) => (
            <button
              key={t.id}
              data-tab={t.id}
              className={tab === t.id ? "active" : ""}
              onClick={() => setTab(t.id)} data-fid={t.fid}
            >
              <t.icon size={16} />
              {t.label}
            </button>
          ))}
        </div>
        <span className="draft-note">
          <span className="live-dot" />
          {p.isDemo
            ? "示例项目 · 所有输出均为草稿"
            : p.approved
              ? "已人工复核 · 非施工图"
              : "设计草稿 · 人工复核后交付"}
        </span>
      </div>
      )}
      {/* 三维模型工作台（换图纸 / 语义调整 / 同步灯位）从绘图页搬出来，做成顶层浮层：
          它本身是三维，不该出现在「底图与空间」的画布位置。入口在「智能情景」页头。 */}
      {showCadWorkbench && p.mode === "3D" && hasDxfDrawing && !spacePreview && (
        // .gv3d 自己是 position:fixed inset:0，不用再包一层；embedded 是给"塞进画布框"用的
        <Lighting3DView id={id} project={p} notify={notify}
          onClose={() => setShowCadWorkbench(false)}
          onSynced={async () => { w.accept(await api<Project>(`/projects/${id}`)); }}
          // 实测 2026-10-14：工作台里「换一张 DXF / 用项目里的图纸生成」跑完，
          // 也要进「空间预览 → 确认 / 修改」，不能生成完还停在三维工作台。
          onGenerated={() => { setShowCadWorkbench(false); void openSpacePreview(); }} />
      )}
      {spacePreview && (
        <SpacePreviewLayer
          key={`${spacePreview.editorKey || "generation"}-${spacePreview.initialPhase || "review"}`}
          id={id}
          project={p}
          design={d}
          floor={floor}
          background={dxfPreviewUrl || backgroundUrl}
          onChange={(v: Obj, h?: boolean) => change(v as any, h)}
          beforeReview={flush}
          initialPhase={spacePreview.initialPhase}
          confirmRooms={() => operation("/space-definition/confirm", { stage: "rooms", floor, reviewer: p.designer || "设计师" })}
          confirmSpaces={async () => {
            if (!spaceConfirmed) await operation("/space-definition/confirm", { reviewer: p.designer || "设计师" });
          }}
          onConfirmed={enterConfirmedCanvas}
          notify={notify}
          // 关掉这一层之前，先把没落盘的改动写完（await）：不然「改到一半点关闭」再刷新，
          // 服务端还停在上一步（2026-10-16 反馈「进度条与所在环节不匹配」的另一半原因）。
          onClose={async () => { await flush().catch(() => {}); setSpacePreview(null); }}
          job={spacePreview}
        />
      )}
      {w.saveError && (
        <div className="error-banner" data-fid="X-07">
          <AlertCircle size={16} />
          自动保存失败：{w.saveError}
          <Button onClick={save} fid="X-08">重试</Button>
          <Button
            onClick={() => {
              askDanger("放弃未保存更改，重新载入本地版本？", () => {
                run(
                  async () => w.accept(await api("/projects/" + id)),
                  "已重新载入",
                );
              }, "未保存的改动会丢失，本地版本保留上次保存的内容。");
            }} fid="X-09"
          >
            重新载入
          </Button>
        </div>
      )}
      {locked && (
        <div className="notice lock-notice" data-fid="X-10">
          <Lock size={16} />
          此版本已冻结或归档，不能编辑。
          <Button
            onClick={() =>
              run(() => operation("/versions"), "新版本已建立，复核状态已重置")
            } fid="X-11"
          >
            新建可编辑版本
          </Button>
        </div>
      )}
      {tab === "plan" && d.rooms.some((r) => r.source === "semantic-vision") && !spaceConfirmed && (
        <div className="notice amber">
          <AlertCircle size={17} />
          当前存在 AI 空间草稿。若边界出现重叠、错位或碎片，请先清除这一轮 AI 草稿；人工绘制空间和灯具不会被删除，再重新识别或手画空间。
          <Button disabled={busy || locked} onClick={() => askDanger("清除错误 AI 草稿？", () => run(() => operation("/space-definition/discard-ai-draft"), "已清除错误 AI 空间草稿；人工对象已保留"), "只清除 AI 生成的空间草稿；人工绘制的空间和灯具不会被删除。")} fid="D-67">清除错误 AI 草稿</Button>
        </div>
      )}
      {tab === "plan" && d.rooms.some((r) => r.semanticSource === "local-geometry-suggestion") && (
        <div className="notice amber">
          <AlertCircle size={17} />
          当前彩平含旧版“轮廓猜测”结果，可能把家具、图例或尺寸碎片当作房间，不能用于设计。
          <Button disabled={busy || locked} onClick={() => askDanger("清除旧版错误彩平？", () => run(() => operation("/recognition/reset-auto-plan"), "已清除错误的旧版自动彩平；请重新导入或接入语义户型接口"), "只清除旧版轮廓猜测生成的彩平；人工绘制的空间和灯具不会被删除。")} fid="D-68">清除旧版错误彩平</Button>
        </div>
      )}
      {tab === "plan" && p.recognition && (
        <div className="notice auto-recognition-notice">
          <Layers3 size={17} />
          <div>
            <b>
              {p.recognition.simulated
                ? "当前为显式模拟草稿"
                : p.recognition.applied
                  ? spaceDraft
                    ? `AI 已生成 ${p.recognition.rooms.length} 个空间草稿`
                    : `已载入 ${p.recognition.rooms.length} 个空间`
                  : p.recognition.rooms.length
                    ? `已提取 ${p.recognition.rooms.length} 个边界候选（尚非彩平图）`
                    : "自动分析完成，暂未识别出空间"}
            </b>
            <span>
              {p.recognition.replacements?.length
                ? `已确认替换 ${p.recognition.replacements.length} 个空间边界；其他房间保持不变。`
                : p.recognition.applied
                  ? spaceDraft
                    ? "空间草稿已进入画布；空间名称、边界、面积与门洞关系均需人工确认。"
                    : "识别结果已进入画布；请继续校核空间名称、边界和面积。"
                  : health.planVisionConfigured
                    ? "正在使用已配置的语义户型接口；结果只会在返回有效房间边界时生成彩平。"
                    : "当前仅提取几何边界，不会把它误当作彩平图；配置语义户型接口后可自动生成。"}
            </span>
          </div>
          <Button
            onClick={() => {
              setRecognitionFile(p.recognition!.fileId);
              openFiles();
            }} fid="D-69"
          >
            查看识别结果 <ChevronRight size={14} />
          </Button>
          <Button
            disabled={busy || locked}
            onClick={() =>
              askDanger("清除识别草稿？", () => {
                run(
                  () => operation("/recognition/clear", {}),
                  "已清除识别草稿；人工绘制的空间与灯具未改动",
                );
              }, "只清除这一轮自动识别结果；人工绘制的空间、灯具与情景不受影响。")
            } fid="D-70"
          >
            清除识别草稿
          </Button>
        </div>
      )}
      {tab === "plan" && (
        <>
          <div className="notice">
            <Layers3 size={17} />
            <div>
              <b>底图与布灯</b>
              <span>
                布灯时选好空间与位置，编号自动生成（如 kc001 ＝ 客厅·茶几的 1 号灯）；标准情景会按编号自动同步，不用逐个场景手调。
              </span>
            </div>
          </div>
          {/* 七步条挂页头：功能句行 → 七步条 → 工具行。review 步会写库（preview-to-design），批 1 不接，灰掉。 */}
          <DrawingProgress project={p} design={d} job={spacePreview}
            confirmed={spaceConfirmed} onStep={jumpDrawingStep} blockedSteps={["review"]} />
          <div className="editor-toolbar">
            <div>
              {/* 主操作 3（B7）：放置灯具 / 画灯带 / 调整家具。确认空间单列，不计这一段。 */}
              <Button
                onClick={openPlace}
                disabled={locked}
                variant={spaceConfirmed && tool !== "draw-strip" ? "primary" : ""}
                title="点一下进入布灯模式，再在图纸上点要放灯的位置（再点一次退出）" fid="L-01"
              >
                <Lightbulb size={15} />
                放置灯具
              </Button>
              <Button
                onClick={openStripDraw}
                disabled={locked}
                variant={spaceConfirmed && tool === "draw-strip" ? "primary" : ""}
                title="灯带画法（§十.10）：点一下进入折线模式，在图纸上依次点拐点，点一下接一段；长度按折线自动量（也可在灯具属性里直接填米数）" fid="L-02"
              >
                <PencilRuler size={15} />
                {tool === "draw-strip" ? "完成灯带" : "画灯带折线"}
              </Button>
              {!furnitureEditing && (
                <Button disabled={locked || furnitureLoading}
                  onClick={() => { setFurnitureEditing(v => !v); setFurniture(true); setTool("select"); setPlacingFurniture(""); setMovingFurniture(false); }} fid="L-03">
                  <Box size={15} /> 调整家具
                </Button>
              )}
              {furnitureEditing && <>
                {/* B7：两个边界点键只在选中家具后出现（常驻 disabled 仍计可见键，5>3 判不过）。 */}
                {selectedFurnitureId && (<>
                <Button disabled={locked} variant={tool === "add-furn-point" ? "primary" : ""}
                  onClick={() => setTool(tool === "add-furn-point" ? "select" : "add-furn-point")} fid="L-04">
                  <Plus size={15} /> 增加边界点
                </Button>
                <Button disabled={locked} variant={tool === "delete-furn-point" ? "primary" : ""}
                  onClick={() => setTool(tool === "delete-furn-point" ? "select" : "delete-furn-point")} fid="L-05">
                  <Minus size={15} /> 删除边界点
                </Button>
                </>)}
                <Button disabled={locked} variant={tool === "draw-furn-poly" ? "primary" : ""}
                  onClick={() => { setTool(tool === "draw-furn-poly" ? "select" : "draw-furn-poly"); setPlacingFurniture(""); setMovingFurniture(false); setSelectedFurnitureId(""); }} fid="L-06">
                  <MousePointer2 size={15} /> {tool === "draw-furn-poly" ? "取消绘制轮廓" : "画家具轮廓（多边形）"}
                </Button>
              </>}
              {furnitureEditing && (
                <Button variant="primary" onClick={() => setFurnitureEditing(false)} fid="L-07">
                  <CheckCircle2 size={15} /> ✓ 完成家具编辑
                </Button>
              )}
              {/* 确认空间单列（B2）：未确认态＝本页唯一写入口；已确认态只留文字、不出可点按钮。 */}
              {!spaceConfirmed ? (
                <Button
                  variant="primary"
                  disabled={busy || locked || !d.rooms.length}
                  title={d.rooms.length ? "核对所有楼层的空间名称、边界和面积后确认" : "请先添加或导入空间"}
                  onClick={() => void run(confirmRoomsAndOpenings, "")} fid="D-54"
                >
                  <CheckCircle2 size={15} /> 确认空间
                </Button>
              ) : (
                <span className="subtle" role="status">✓ 空间已确认</span>
              )}
              <span className="toolbar-divider" />
              {/* 收拢菜单 2：添加（B3 会话内记忆）/ 图纸 */}
              <div className="menu-holder">
                <button
                  className="btn"
                  disabled={locked}
                  aria-haspopup="menu"
                  aria-expanded={toolMenu === "add"}
                  title="添加传感器 / 智能设备 / 窗帘；记住上次用的类型"
                  onClick={() => setToolMenu(toolMenu === "add" ? "" : "add")} data-fid="D-43"
                >
                  <Plus size={15} /> 添加 <ChevronDown size={11} />
                </button>
                {toolMenu === "add" && (
                  <>
                    <div className="menu-away" onClick={() => setToolMenu("")} />
                    <div className="dropdown-menu toolbar-menu" role="menu" data-fid="L-08">
                      {[
                        ["传感器", "传感器"],
                        ["面板", "智能设备"],
                        ["窗帘", "窗帘"],
                      ].map(([value, label]) => (
                        <button
                          key={value}
                          role="menuitem"
                          className={lastAddType === value ? "on" : ""}
                          onClick={() => pickAddType(value)}
                        >
                          <Plus size={14} /> {label}
                          {lastAddType === value && <CheckCircle2 size={13} className="menu-tick" />}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
              <div className="menu-holder">
                <button
                  className="btn"
                  aria-haspopup="menu"
                  aria-expanded={toolMenu === "file"}
                  title="图纸：导入图纸 / 空间预览"
                  onClick={() => setToolMenu(toolMenu === "file" ? "" : "file")} data-fid="D-44"
                >
                  <Upload size={15} /> 图纸 <ChevronDown size={11} />
                </button>
                {toolMenu === "file" && (
                  <>
                    <div className="menu-away" onClick={() => setToolMenu("")} />
                    <div className="dropdown-menu toolbar-menu" role="menu">
                      <button role="menuitem" onClick={() => { setToolMenu(""); openFiles(); }} data-fid="D-41">
                        <Upload size={14} /> 导入图纸 <span className="count-bubble">{p.files.length}</span>
                      </button>
                      <button role="menuitem" disabled={locked} onClick={() => { setToolMenu(""); void openSpacePreview(); }} data-fid="D-42">
                        <PencilRuler size={14} /> 空间预览 / 修改空间与门窗
                      </button>
                    </div>
                  </>
                )}
              </div>
              <span className="toolbar-divider" />
              {layerSwitch}
            </div>
            <div>
              <button
                className="icon-btn"
                onClick={w.undo}
                disabled={!w.canUndo || locked}
                title="撤销" data-fid="X-01"
              >
                <Undo2 size={17} />
              </button>
              <button
                className="icon-btn"
                onClick={w.redo}
                disabled={!w.canRedo || locked}
                title="重做" data-fid="X-02"
              >
                <Redo2 size={17} />
              </button>
              {p.floors > 1 && (
                <>
                  <span className="toolbar-divider" />
                  <select
                    value={floor}
                    onChange={(e) => {
                      setFloor(+e.target.value);
                      // 换楼层＝换图纸：底图回到「按楼层自动」。
                      setBackground("");
                      setSelection(null);
                    }}
                    aria-label="当前楼层"
                  >
                    {floorLevels(p.floors, p.basements).map((lv) => (
                      <option key={lv.value} value={lv.value}>
                        {lv.choice}
                      </option>
                    ))}
                  </select>
                </>
              )}
            </div>
          </div>
          <div className="editor-layout">
            <aside className="object-panel" data-fid="D-52">
              <div className="panel-title">
                <h3>空间图层</h3>
                <button
                  className="mini-btn"
                  disabled={locked}
                  onClick={() => setModal("spaces")} data-fid="D-46"
                >
                  管理空间
                </button>
              </div>
              <p className="subtle" style={{ margin: "0 0 8px" }}>
                本项目：{projectSpaces.length ? projectSpaces.map((s) => s.name).join("、") : "尚未选空间"}
              </p>
              <p className="subtle" style={{ margin: "0 0 8px" }} data-area-summary="1">
                使用面积 {voidAreas.used} m²
                {voidAreas.voidArea
                  ? ` · 挑空 ${voidAreas.voidArea} m²（不计使用面积）`
                  : ""}
              </p>
              <div className="space-add-bar">
                <button
                  className="btn"
                  disabled={locked}
                  aria-label="新增空间"
                  title="先选分区，再选房间；记住上次的分区"
                  onClick={() => setAddSpaceOpen(true)} data-fid="D-45"
                >
                  <Plus size={15} /> 新增空间
                </button>
              </div>
              <p className="subtle" style={{ margin: "0 0 8px" }}>
                空间不需要画边界：名称 + 灯具编号（kc001 ＝ 客厅·茶几的 1 号灯）已经定位，智能情景按编号生成。
              </p>
              <div className="layer-toggle">
                <button
                  className={!source ? "active" : ""}
                  onClick={() => setSource(false)} data-fid="D-48"
                >
                  设计图层
                </button>
                <button
                  className={source ? "active" : ""}
                  onClick={() => setSource(true)} data-fid="D-49"
                >
                  来源图层
                </button>
              </div>
              <div className="object-list" data-fid="D-47">
                {d.rooms
                  .filter((r) => r.floor === floor)
                  .map((r) => (
                    <div key={r.id}>
                      <button
                        className={
                          "room-list-item " +
                          (selection?.id === r.id ? "active" : "")
                        }
                        onClick={() =>
                          setSelection({ kind: "rooms", id: r.id })
                        }
                      >
                        <span
                          className="room-color"
                          style={{ background: r.color }}
                        />
                        <span>
                          <b>{r.name}</b>
                          <small>
                            {isVoidRoom(r) && "挑空 · "}
                            {r.source === "fixture-code" ||
                            (r.width <= 1 && r.height <= 1)
                              ? "无边界空间 · 按编号定位"
                              : r.area > 0
                                ? `${r.area} m²`
                                : "面积待校核"}{" "}
                            · {r.semanticConfidence === "low" ? "用途待确认" : "已命名"} ·{" "}
                            {d.fixtures.filter((f) => f.roomId === r.id && isSceneLight(f)).length} 盏灯
                          </small>
                        </span>
                        <span
                          className="room-del"
                          role="button"
                          tabIndex={-1}
                          title="删除该空间"
                          onClick={(e) => {
                            e.stopPropagation();
                            removeSpaceById(r.id);
                          }}
                        >
                          <Trash2 size={12} />
                        </span>
                        <ChevronRight size={13} />
                      </button>
                      {selection?.id === r.id &&
                        d.fixtures
                          .filter((f) => f.roomId === r.id)
                          .map((f) => (
                            <button
                              key={f.id}
                              className="nested-light"
                              onClick={() =>
                                setSelection({ kind: "fixtures", id: f.id })
                              }
                            >
                              <Lightbulb size={12} />
                              {f.code} · {f.name}
                            </button>
                          ))}
                    </div>
                  ))}
                {!d.rooms.filter((r) => r.floor === floor).length && (
                  <p className="panel-empty">添加房间，构建你的空间。</p>
                )}
              </div>
              <div className="layer-settings" data-fid="D-50">
                <h4>画布显示</h4>
                {[
                  ["家具占位", furniture, setFurniture],
                  ["灯具位置", lights, setLights],
                  ["灯具编号", labels, setLabels],
                  ["网格参考", grid, setGrid],
                ].map(([label, value, set]: any) => (
                  <label key={label}>
                    <span>{label}</span>
                    <input
                      type="checkbox"
                      checked={value}
                      onChange={(e) => set(e.target.checked)}
                    />
                  </label>
                ))}
                <label>
                  <span>底图 / 图纸叠加</span>
                  <select
                    value={background}
                    onChange={(e) => setBackground(e.target.value)} data-fid="D-51"
                  >
                    <option value="">
                      按当前楼层自动{floorFile ? `（${floorFile.name}）` : "（本层暂无图纸）"}
                    </option>
                    <option value="__none__">隐藏</option>
                    {p.files
                      .filter((f) => f.preview)
                      .map((f) => (
                        <option
                          key={f.id}
                          value={`/api/projects/${id}/files/${f.id}?preview=true`}
                        >
                          {p.floors > 1 && f.floor
                            ? `${floorLabel(f.floor, p.basements)} · `
                            : ""}
                          {f.name}
                        </option>
                      ))}
                  </select>
                </label>
                <p>
                  <i className="legend-dot" />
                  人工对象 <i className="legend-dot amber" />
                  自动识别 / 示例
                  <br />
                  默认显示上传的彩平底图；需要核对时可叠加原始图纸
                </p>
              </div>
            </aside>
            <div className="canvas-wrap">
              <div className="canvas-tag">
                <span className="live-dot" /> {d.palette} <span>/</span>{" "}
                {floorLabel(floor, p.basements)}
                {spaceDraft
                  ? <small> · 空间草稿编辑中</small>
                  : spaceConfirmed
                    ? <small> · 空间彩平底稿</small>
                    : d.rooms.some((r) => r.source === "image-analysis") && <small> · 自动生成彩平</small>}
              </div>
              {/* 批 2 · B5：底图「确定」搬出工具行 → 画布上一条可关提示。
                  固定画布顶部居中、不随缩放；关掉只本次会话，重新导入图纸再出。 */}
              {planMaskShown && !planMaskBarClosed && (
                <div className="canvas-prompt" role="status">
                  <span>底图就绪：确定后去掉灰蒙版，开始布灯</span>
                  <Button
                    onClick={() => {
                      update((n) => { n.planMasked = false; if (!noSmart) ensurePanels(n, smart); });
                      setPlanMaskBarClosed(true);
                    }} fid="D-66"
                  >
                    确定
                  </Button>
                  <button
                    className="icon-btn canvas-prompt-x"
                    title="这次不用（本次会话不再提示，重新导入图纸再出）"
                    onClick={() => setPlanMaskBarClosed(true)} data-fid="X-16"
                  >
                    <X size={13} />
                  </button>
                </div>
              )}
              {spotFixture && (
                <div className="canvas-lamp-badge" aria-live="polite">
                  <span className="canvas-lamp-code">{spotFixture.code}</span>
                  <span className="canvas-lamp-type">{spotFixture.type}</span>
                  <b className="canvas-lamp-power">{spotFixture.power} W</b>
                  {/* 2026-10-16：编号与灯具基本信息放在这里（点灯即见），画布上不再挂成一堆标签。 */}
                  <small>
                    {d.rooms.find((r) => r.id === spotFixture.roomId)?.name || "未归属"} · 安装{" "}
                    {spotFixture.installHeight ?? 2.8} m · 色温 {spotFixture.cct ?? 3000} K
                    {spotFixture.circuit ? ` · 回路 ${spotFixture.circuit}` : ""}
                    {spotFixture.dimmable ? " · 可调光" : ""}
                  </small>
                  {hasBeam(spotFixture) && (
                    <small>
                      光束角{" "}
                      {spotFixture.beamAngle ??
                        defaultBeamAngle(spotFixture.type)}
                      ° · 地面光斑 Ø
                      {(
                        spotDiameterMetres(
                          spotFixture.installHeight,
                          spotFixture.beamAngle ??
                            defaultBeamAngle(spotFixture.type),
                        ) *
                        (Number(spotFixture.spotScale) > 0
                          ? Number(spotFixture.spotScale)
                          : 1)
                      ).toFixed(2)}{" "}
                      m
                      {(Number(spotFixture.spotScale) > 0
                        ? Number(spotFixture.spotScale)
                        : 1) !== 1 &&
                        `（理论值 ×${Number(spotFixture.spotScale)}）`}
                    </small>
                  )}
                </div>
              )}
              {/* 底图与空间＝纯绘图面（2026-10-19 定）：这一页只有平面图，不放任何三维。
                  三维是「演示」，只出现在「智能情景」页；交付文件同理。 */}
              {spacePreview ? <div className="subtle">正在预览空间，确认后进入画布</div> : <Plan
                key={"plan" + floor + "-" + canvasReset}
                // 家具调整模式下，画布要用与右侧面板同一批家具行——图纸刚导入、还没写进设计时
                // 设计里没有 furniture，否则画布上只有装饰性占位、抓不到边界把手（2026-10-16）。
                design={furnitureEditing && !Array.isArray(d.furniture) ? { ...d, furniture: legacyFurniture } : d}
                floor={floor}
                selection={selection}
                onSelect={setSelection}
                selectedFurnitureId={selectedFurnitureId}
                onFurnitureSelect={selectCanvasFurniture}
                onChange={(v, h) => {
                  if (selection?.kind === "rooms") {
                    const r = v.rooms.find((r) => r.id === selection.id);
                    if (r) r.source = "manual";
                  }
                  // 拖面板 / 温控器：沿最近的墙线滑动，不离开墙（2026-10-17：三维里不能悬浮）。
                  if (selection?.kind === "devices") {
                    const dev = v.devices.find((x) => x.id === selection.id);
                    if (dev && (dev.type === "面板" || dev.type === "温控器") && !isTabletopDevice(dev)) {
                      const walls = v.rooms.filter((r) => +(r.floor || 1) === floor && boundary(r).length >= 3);
                      const snap = walls.length ? snapToWall(walls, { x: +dev.x, y: +dev.y }, floor, Infinity) : null;
                      if (snap) { dev.x = Math.round(snap.x * 100) / 100; dev.y = Math.round(snap.y * 100) / 100; }
                    }
                  }
                  change(v, h);
                }}
                tool={tool}
                onPlacePoint={beginPlaceAt}
                zoom={zoom}
                // 布灯主画布同样滚轮缩放、空白处按住拖动平移（2026-10-17）；「适应画布」一并还原。
                wheelZoom
                viewReset={canvasReset}
                showFurniture={furniture}
                showCanonicalFurniture={furniture}
                editableFurniture={furnitureEditing}
                onFurnPolygon={furnitureEditing ? onFurnPolygonCanvas : undefined}
                editableRooms={!spaceConfirmed && !furnitureEditing}
                stage={furnitureEditing ? "furniture" : undefined}
                voidNote={voidNoteFor(floor)}
                coverageEdit={coverageEdit}
                coveragePointSel={coverageSel}
                onCoveragePointSelect={setCoverageSel}
                showFixtureLayer={fixtureLayer}
                showDeviceLayer={deviceLayer}
                showLights={lights}
                showLabels={labels}
                showGrid={grid}
                onStripPoint={tool === "draw-strip" ? appendStripPoint : undefined}
                showSource={source}
                // 口径①（§十.10，实测 2026-10-12 认可）：空间确认后，布灯画布背景＝**已确认的
                // 空间轮廓 ＋ 墙线**，不再铺 CAD 底图光栅（图纸阶段仍需底图来手绘空间，所以只在
                // 已确认后生效）；要看某张图纸时在「底图」里显式选一张，仍会显示。
                background={canvasBackgroundUrl}
                backgroundRect={spaceConfirmed && !background ? null : bgRectFor(backgroundUrl)}
                readonly={locked || busy}
                planMasked={d.planMasked !== false}
                focus={focus}
              />}
              <div className="canvas-controls" data-fid="V-12">
                <button
                  className={tool === "select" ? "active" : ""}
                  title="选择与拖动"
                  onClick={() => setTool("select")} data-fid="V-13"
                >
                  <MousePointer2 size={16} />
                </button>
                <button
                  className={tool === "pan" ? "active" : ""}
                  title="平移画布"
                  onClick={() => setTool("pan")} data-fid="V-14"
                >
                  <Hand size={16} />
                </button>
                <i />
                <button
                  title="缩小"
                  onClick={() => setZoom(Math.max(0.4, zoom - 0.1))} data-fid="V-15"
                >
                  <Minus size={16} />
                </button>
                <span>{Math.round(zoom * 100)}%</span>
                <button
                  title="放大"
                  onClick={() => setZoom(Math.min(2, zoom + 0.1))} data-fid="V-16"
                >
                  <Plus size={16} />
                </button>
                <i />
                <button
                  title="适应画布"
                  onClick={() => {
                    setZoom(1);
                    setTool("select");
                    setCanvasReset((v) => v + 1);
                  }} data-fid="V-17"
                >
                  <Maximize size={16} />
                </button>
              </div>
              <div className="canvas-hint">
                {tool === "place-furniture" ? movingFurniture ? "移动家具：在空间内单击新位置 · Esc 取消" : "放置家具：在空间内单击落位 · Esc 取消"
                  : tool === "place-lamp"
                  ? "布灯模式：在图纸上点击要放灯的位置，随后选择空间、位置与编号"
                  : tool === "place-device"
                    ? addObject === "curtain"
                      ? "添加窗帘：在图纸上点击窗帘要放的位置，随后确认电机与空间"
                      : `添加${addType}：在图纸上点击要放的位置，随后确认类型、名称与空间`
                    : tool === "draw-strip"
                        ? "灯带折线：在图纸上依次点拐点，点一下接一段；点「完成灯带」结束（长度按折线自动量）"
                        : "拖动灯具调整位置 · 空间与情景按编号生成 · 改动自动保存"}
              </div>
              {/* 批 3（D4）：画布右下角本层读数——右上角标、底部缩放条都不动。 */}
              <div className="canvas-status" role="status">
                本层 {floorLights} 盏灯 · {floorDevices} 个设备
              </div>
            </div>
            <aside className={"inspector" + (shellV2 ? " wsv2-inspector" : "") + (shellV2 && v2Insp !== "属性" ? " wsv2-insp-other" : "")} data-fid="D-53">
              {shellV2 && (
                <div className="wsv2-itabs" data-fid="V-18">
                  {v2InspTabs.map(t => <button key={t} className={v2Insp === t ? "on" : ""} onClick={() => setV2Insp(t)}>{t}</button>)}
                </div>
              )}
              {shellV2 && v2Insp !== "属性" && (
                <div className="wsv2-ipanel" data-fid="V-19">
                  {v2Insp === "组地址" ? (
                    v2SelFix ? <>
                      <div className="wsv2-ih">KNX 映射<span>本机 · local-only</span></div>
                      <div className="wsv2-ikv"><span>灯具</span><b>{v2SelFix.code} · {v2SelFix.name}</b></div>
                      <div className="wsv2-ikv"><span>回路</span><b>{v2SelFix.circuit || "未分回路"}</b></div>
                      <div className="wsv2-ikv"><span>模块/网关</span><input className="wsv2-iinput" value={v2SelFix.controller || ""} onChange={(e) => patch("controller", e.target.value)} placeholder="KNX 网关 / 模块" /></div>
                      <div className="wsv2-ikv"><span>通道</span><input className="wsv2-iinput" value={v2SelFix.channel || ""} onChange={(e) => patch("channel", e.target.value)} placeholder="通道号" /></div>
                      <div className="wsv2-ikv"><span>地址</span><input className="wsv2-iinput" value={v2SelFix.address || ""} onChange={(e) => patch("address", e.target.value)} placeholder="GA / 物理地址" /></div>
                      <div className="wsv2-ikv"><span>控制</span><input className="wsv2-iinput" value={v2SelFix.control || ""} onChange={(e) => patch("control", e.target.value)} placeholder="开关 / 调光 / DALI" /></div>
                      <div className="wsv2-inote">改动自动保存。GA 明细/刻字/调试只留本机；不进业主包/协同包。1 个灯体可绑 N 个 IES，型号必须匹配。</div>
                    </> : <div className="wsv2-ipanel-empty">在画布上选中一盏灯，查看 KNX 映射。</div>
                  ) : v2Insp === "IES" ? (
                    <>
                      <div className="wsv2-ih">IES 配光<span>{entMode ? "企业版 · 可上传" : "只读 · 合作品牌"}</span></div>
                      {!v2SelFix ? <div className="wsv2-ipanel-empty">在画布上选中一盏灯，查看/绑定 IES。</div> : <>
                        <div className="wsv2-ikv"><span>灯具</span><b>{v2SelFix.code} · {v2SelFix.name}</b></div>
                        <div className="wsv2-ikv"><span>型号</span><b>{v2SelFix.model || "待补"}</b></div>
                        <div className="wsv2-ikv"><span>已绑 IES</span><b>{v2SelFix.ies?.name || "未绑定"}</b></div>
                        {v2SelFix.ies && <div className="wsv2-ikv"><span>状态</span><b>{v2SelFix.ies.status === "parsed" ? "已解析 · 配光参考" : v2SelFix.ies.status === "parse-failed" ? "解析失败 · 已留存" : "已留存"}</b></div>}
                        {v2SelFix.ies?.parsed && <>
                          <div className="wsv2-ikv"><span>总光通量</span><b>{v2SelFix.ies.parsed.totalLumens ? `${v2SelFix.ies.parsed.totalLumens} lm` : "—"}</b></div>
                          <div className="wsv2-ikv"><span>峰值光强</span><b>{v2SelFix.ies.parsed.maxCandela ? `${v2SelFix.ies.parsed.maxCandela} cd` : "—"}</b></div>
                          <div className="wsv2-ikv"><span>近似光束角</span><b>{v2SelFix.ies.parsed.beamAngleApprox ? `${v2SelFix.ies.parsed.beamAngleApprox}°` : "—"}</b></div>
                          {v2SelFix.ies.parsed.beamAngleMin !== v2SelFix.ies.parsed.beamAngleMax && (
                            <div className="wsv2-ikv"><span>光束角范围</span><b>{v2SelFix.ies.parsed.beamAngleMin}° – {v2SelFix.ies.parsed.beamAngleMax}°</b></div>
                          )}
                          {!!v2SelFix.ies.parsed.beamAngleApprox && (
                            <button className="wsv2-iupload" onClick={() => { patch("beamAngle", v2SelFix.ies.parsed.beamAngleApprox); notify(`已把光斑参考角切到 ${v2SelFix.ies.parsed.beamAngleApprox}°（仍为理论参考，不做正式照度）`); }}>应用解析配光（仅改光斑参考角）</button>
                          )}
                        </>}
                        {v2SelFix.ies?.parseError && <div className="wsv2-inote">{v2SelFix.ies.parseError}</div>}
                        {(v2SelFix.ies?.parsed?.warnings || []).map((w: string) => <div className="wsv2-inote" key={w}>{w}</div>)}
                        {entMode ? (
                          <label className="wsv2-iupload" data-fid="V-20">
                            <Upload size={13} /> {v2SelFix.ies ? "替换 IES" : "上传 IES"}
                            <input type="file" accept=".ies" hidden onChange={(e) => { uploadIes(e.target.files?.[0]); e.target.value = ""; }} />
                          </label>
                        ) : (
                          <div className="wsv2-inote">个人版/KNX 版只读合作品牌 IES；要上传自有 IES 请用企业版。</div>
                        )}
                      </>}
                      <div className="wsv2-inote">1 个灯体可绑 N 个 IES，但必须与产品型号匹配；IES 不给业主；不做正式照度计算，最多给布灯后参考估算。</div>
                    </>
                  ) : v2Insp === "报价" ? (
                    <>
                      <div className="wsv2-ih">报价<span>企业包 · 草稿</span></div>
                      <div className="wsv2-ikv"><span>项目</span><b>{p.name}</b></div>
                      <div className="wsv2-ikv"><span>客户</span><b>{p.client || "未填客户"}</b></div>
                      <div className="wsv2-ikv"><span>纳价</span><b>{v2QuoteCount} / {(d.fixtures || []).length} 盏</b></div>
                      <div className="wsv2-ikv"><span>已选灯具</span><b>{v2SelFix ? `${v2SelFix.code} · ${v2SelFix.name}` : "未选灯具"}</b></div>
                      {v2SelFix && <>
                        <div className="wsv2-ikv"><span>纳入报价</span><label className="wsv2-icheck"><input type="checkbox" checked={!!v2SelFix.quote} onChange={(e) => patch("quote", e.target.checked)} />{v2SelFix.quote ? "已纳入" : "不纳入"}</label></div>
                        <div className="wsv2-ikv"><span>零售价 ¥</span><input className="wsv2-iinput" type="number" step="0.01" min="0" value={v2SelFix.price ?? ""} onChange={(e) => patch("price", e.target.value === "" ? undefined : Number(e.target.value))} placeholder="待补价" /></div>
                      </>}
                      <div className="wsv2-inote">正式报价单需 biz.quote 加购/企业版；只显示市场零售价，成本价/渠道价永不进工作台。</div>
                    </>
                  ) : (
                    <>
                      <div className="wsv2-ih">现场核对<span>{v2SelRoom?.name || "未选空间"}</span></div>
                      <div className="wsv2-ikv"><span>空间</span><b>{v2SelRoom?.name || "—"}</b></div>
                      <div className="wsv2-ikv"><span>灯位</span><b>{(d.fixtures || []).filter((f: Obj) => f.roomId === v2SelRoom?.id).length} 盏</b></div>
                      {["通电前", "编址", "通道", "情景"].map((k) => (
                        <div className="wsv2-ikv" key={k}><span>{k}</span>
                          <label className="wsv2-icheck"><input type="checkbox" checked={!!v2Site[k]}
                            onChange={() => update((n) => { (n as Obj).siteCheck = { ...((n as Obj).siteCheck || {}), [k]: !v2Site[k] }; })} />
                            {v2Site[k] ? "已核" : "待核"}</label>
                        </div>
                      ))}
                      <div className="wsv2-ih" style={{ marginTop: 12 }}>现场资料<span>{siteCount} 份 · {siteMB} MB</span></div>
                      {(p.siteEvidence || []).slice(-4).map((e: Obj) => (
                        <div className="wsv2-ev" key={e.id}>
                          <a className="wsv2-eva" href={`/api/projects/${id}/site-evidence/${e.id}`} target="_blank" rel="noreferrer" title="打开原文件"
                            onClick={(ev) => { if (!String(e.file || "").toLowerCase().endsWith(".pdf")) { ev.preventDefault(); setV2Preview(`/api/projects/${id}/site-evidence/${e.id}`); } }}>
                            {String(e.file || "").toLowerCase().endsWith(".pdf")
                              ? <span className="wsv2-evpdf">PDF</span>
                              : <img src={`/api/projects/${id}/site-evidence/${e.id}`} alt="" />}
                          </a>
                          <div><b title={e.name}>{String(e.name).slice(0, 22)}</b><small>{e.kind === "signature" ? "签字" : "照片"} · {Math.max(1, Math.round(Number(e.bytes || 0) / 1024))} KB</small></div>
                          <button title="删除" onClick={() => deleteSiteEvidence(e.id)}><X size={12} /></button>
                        </div>
                      ))}
                      <label className="wsv2-iupload">
                        <Upload size={13} /> 上传现场照片 / 签字 PDF
                        <input type="file" accept=".jpg,.jpeg,.png,.webp,.pdf" hidden onChange={(e) => { uploadSiteEvidence(e.target.files?.[0]); e.target.value = ""; }} />
                      </label>
                      {(p.siteEvidence || []).length > 0 && (
                        <a className="wsv2-iupload" href={`/api/projects/${id}/site-evidence.zip`} download>打包下载现场资料（{siteMB} MB）</a>
                      )}
                      <div className="wsv2-inote">手机只写调试进度，不改画布真源；照片/签字 PDF 本地存档，不进业主包。{Number(siteMB) > 50 ? " 资料较多，打包可能需要稍等。" : ""}</div>
                    </>
                  )}
                </div>
              )}
              <div className="panel-title">
                <h3>
                  {furnitureEditing ? "画布家具调整" : selected
                    ? selection?.kind === "rooms"
                      ? "空间属性"
                      : selection?.kind === "fixtures"
                        ? "灯具属性"
                        : selection?.kind === "devices"
                          ? "设备属性"
                          : selection?.kind === "walls"
                            ? "墙体属性"
                            : "门窗属性"
                    : "设计属性"}
                </h3>
                <SlidersHorizontal size={16} />
              </div>
              <div className="inspector-body" ref={inspectorBody}>
                {furnitureEditing ? <FurniturePanel design={{ ...d, furniture: d.furniture ?? legacyFurniture }} floor={floor}
                  selected={selectedFurnitureId} onSelect={selectCanvasFurniture} readonly={locked}
                  onChange={v => change(v as Design)} placing={placingFurniture} moving={movingFurniture}
                  onMove={() => { setMovingFurniture(v => !v); setPlacingFurniture(""); setTool(movingFurniture ? "select" : "place-furniture"); }}
                  onPlace={kind => { setPlacingFurniture(kind); setMovingFurniture(false); setTool(kind ? "place-furniture" : "select"); }} /> : selected ? (
                  <>
                    <div className="object-source">
                      <span
                        className={
                          "badge " +
                          (selection?.kind === "devices"
                            ? "blue"
                            : selected.source === "manual"
                              ? "green"
                              : "amber")
                        }
                      >
                        {selected.source === "manual"
                          ? "人工编辑对象"
                          : selected.source === "cad"
                            ? "CAD 基础解析"
                            : selected.source === "image-analysis" || selected.source === "semantic-vision"
                              ? "AI 空间草稿 · 待人工确认"
                              : selected.source === "semantic-labels"
                                ? "按图纸文字识别 · 名称可改"
                                : "示例 / 模拟对象"}
                      </span>
                    </div>
                    <fieldset disabled={locked || busy} data-fid="D-62">
                      {selection?.kind === "rooms" && (
                        <>
                          {(selected.source === "image-analysis" || selected.source === "semantic-vision") && (
                            <div className="detected-room-note">
                              <p>
                                这是 AI 空间草稿，不是固定示例。面积为待测值，房间名称与边界均可人工校正。
                              </p>
                              <Button
                                onClick={() => patch("needsReview", false)} fid="D-55"
                              >
                                <CheckCircle2 size={14} />
                                人工确认此空间
                              </Button>
                            </div>
                          )}
                          <Field label="房间名称">
                            <input
                              value={selected.name}
                              onChange={(e) => patch("name", e.target.value)}
                            />
                          </Field>
                          <p className="field-hint">
                            改名会自动保存（也可点下方「保存」立即写入）。改名或改类型后，
                            空间归属与智能情景层会同步更新；「次卧 2」这类同类空间按名称前缀识别。
                          </p>
                          <Field label="空间类型">
                            <select
                              value={selected.type}
                              onChange={(e) => patch("type", e.target.value)}
                            >
                              {GROUPED_SPACES.map((g) => (
                                <optgroup key={g.group} label={g.group}>
                                  {g.spaces.map((s) => (
                                    <option key={s.code}>{s.name}</option>
                                  ))}
                                </optgroup>
                              ))}
                            </select>
                          </Field>
                          <div className="two-fields">
                            <Num
                              label="面积 m²"
                              value={selected.area}
                              onChange={(v) => patch("area", v)}
                              min={0}
                            />
                            <Num
                              label="层高 m"
                              value={selected.heightM}
                              onChange={(v) => patch("heightM", v)}
                              min={0.1}
                            />
                          </div>
                          <Field label="挑空 / 贯通（别墅中庭）">
                            <label
                              style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}
                            >
                              <input
                                type="checkbox"
                                aria-label="标记为挑空区"
                                checked={!!selected.isVoid}
                                onChange={(e) => patch("isVoid", e.target.checked)}
                              />
                              <span>这是挑空区（楼板贯通、不计使用面积）</span>
                            </label>
                          </Field>
                          {isVoidRoom(selected) && (
                            <>
                              <Num
                                label="贯通层数"
                                value={voidLevelsOf(selected)}
                                min={1}
                                onChange={(v) => {
                                  patch("voidLevels", Math.max(1, Math.round(v)));
                                }}
                              />
                              <p className="field-hint">
                                {voidLabel(selected)}：层高按贯通总高填（现在 {selected.heightM} m），
                                本空间布灯默认按 {voidInstallHeight(selected)} m 安装；
                                挑空面积不计使用面积；这里的灯在贯通到的其它楼层会淡显，业主切层不会以为灯不见了。
                              </p>
                            </>
                          )}
                          {p.floors > 1 && (
                            <Field label="所属楼层">
                              <select
                                value={selected.floor}
                                onChange={(e) => patch("floor", +e.target.value)}
                              >
                                {floorLevels(p.floors, p.basements).map((lv) => (
                                  <option key={lv.value} value={lv.value}>
                                    {lv.label}
                                  </option>
                                ))}
                              </select>
                            </Field>
                          )}
                          {roomNoGeometry && (
                            <p className="field-hint">
                              无边界空间：位置由灯具编号（如 kc001）体现，不需要画边界；直接改名或删除即可。
                            </p>
                          )}
                          {!roomNoGeometry && (
                            <>
                          <div className="two-fields">
                            <Num
                              label="X 坐标"
                              value={selected.x}
                              onChange={(v) => patch("x", v)}
                            />
                            <Num
                              label="Y 坐标"
                              value={selected.y}
                              onChange={(v) => patch("y", v)}
                            />
                            <Num
                              label="宽度 / 画布单位"
                              value={selected.width}
                              min={1}
                              onChange={(v) => patch("width", v)}
                            />
                            <Num
                              label="高度 / 画布单位"
                              value={selected.height}
                              min={1}
                              onChange={(v) => patch("height", v)}
                            />
                          </div>
                            </>
                          )}
                          {!roomNoGeometry && (
                            <>
                          <Field label="区域颜色">
                            <div className="color-field">
                              <input
                                type="color"
                                value={selected.color}
                                onChange={(e) => patch("color", e.target.value)}
                              />
                              {selected.color}
                            </div>
                          </Field>
                            </>
                          )}
                          <Field label="房间备注">
                            <textarea
                              value={selected.notes}
                              onChange={(e) => patch("notes", e.target.value)}
                            />
                          </Field>
                          {!roomNoGeometry && (
                            <>
                          <Button
                            onClick={() =>
                              patch(
                                "points",
                                selected.points || [
                                  { x: selected.x, y: selected.y },
                                  {
                                    x: selected.x + selected.width,
                                    y: selected.y,
                                  },
                                  {
                                    x: selected.x + selected.width,
                                    y: selected.y + selected.height,
                                  },
                                  {
                                    x: selected.x,
                                    y: selected.y + selected.height,
                                  },
                                ],
                              )
                            } fid="D-56"
                          >
                            <MousePointer2 size={14} />
                            编辑边界点
                          </Button>
                          <Button onClick={addBoundaryPoint} fid="D-57">
                            <Plus size={14} />
                            增加边界点
                          </Button>
                          <Button onClick={removeBoundaryPoint} fid="D-58">
                            <Minus size={14} />
                            删除最后边界点
                          </Button>
                            </>
                          )}
                          {!roomNoGeometry && (
                            <>
                          <label>合并目标空间<select aria-label="空间属性合并目标" value={mergeTargetId} onChange={e => setMergeTargetId(e.target.value)}>
                            <option value="">选择同层相邻空间</option>{d.rooms.filter(r => r.id !== selected.id && r.floor === selected.floor).map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                          </select></label>
                          <div className="two-fields">
                            <Button onClick={splitRoom} fid="D-59">
                              <Split size={14} />
                              拆分
                            </Button>
                            <Button disabled={!mergeTargetId} onClick={mergeRoom} fid="D-60">
                              <Combine size={14} />
                              合并
                            </Button>
                          </div>
                            </>
                          )}
                          <Button onClick={() => addFixture(4)} fid="D-61">
                            <Lightbulb size={14} />
                            在房间内布置 4 盏灯
                          </Button>
                        </>
                      )}
                      {selection?.kind === "devices" && (
                        <>
                          <Field label="设备编号">
                            <input
                              value={selected.code || ""}
                              onChange={(e) => patch("code", e.target.value)}
                            />
                          </Field>
                          <Field label="设备名称">
                            <input
                              value={selected.name}
                              onChange={(e) => patch("name", e.target.value)}
                            />
                          </Field>
                          <Field label="设备类型">
                            <select
                              value={selected.type}
                              onChange={(e) =>
                                update((n) => {
                                  const dev = n.devices.find((v) => v.id === selected.id)!;
                                  dev.type = e.target.value;
                                  // 换类型要补齐该类型需要的字段：否则切到传感器会缺
                                  // range / offDelaySeconds / linkedLights 这些默认值。
                                  if (dev.type === "面板") normalizePanel(dev);
                                  if (dev.type === "传感器") normalizeSensor(dev);
                                })
                              }
                            >
                              {DEVICE_TYPES.map((t) => (
                                <option key={t}>{t}</option>
                              ))}
                            </select>
                          </Field>
                          <Field label="所在空间">
                            <select
                              value={selected.roomId}
                              onChange={(e) =>
                                update((n) => {
                                  const dev = n.devices.find((v) => v.id === selected.id)!;
                                  dev.roomId = e.target.value;
                                  const rm = n.rooms.find((r) => r.id === e.target.value);
                                  if (rm) dev.floor = rm.floor || 1;
                                })
                              }
                            >
                              <option value="">未分配空间</option>
                              {d.rooms.map((r) => (
                                <option key={r.id} value={r.id}>
                                  {r.name}
                                </option>
                              ))}
                            </select>
                          </Field>
                          <Field label="位置（家具/功能位）">
                            {(() => {
                              const rm = d.rooms.find((r) => r.id === selected.roomId);
                              const sc = roomSpaceCodeOf(rm)?.code || "x";
                              return (
                                <select
                                  value={selected.positionCode || ""}
                                  aria-label="设备位置"
                                  onChange={(e) => {
                                    const code = e.target.value;
                                    update((n) => {
                                      const dev = n.devices.find((v) => v.id === selected.id)!;
                                      dev.positionCode = code;
                                      dev.position = code ? positionNameIn(sc, code) : "";
                                    });
                                  }}
                                >
                                  <option value="">不指定位置</option>
                                  {groupedPositionsForSpace(sc).map((g) => (
                                    <optgroup key={g.group} label={g.group}>
                                      {g.positions.map((item) => (
                                        <option key={item.code} value={item.code}>
                                          {item.code} · {item.name}
                                        </option>
                                      ))}
                                    </optgroup>
                                  ))}
                                </select>
                              );
                            })()}
                          </Field>
                          <div className="two-fields">
                            <Num label="X 坐标" value={selected.x} onChange={(v) => patch("x", v)} />
                            <Num label="Y 坐标" value={selected.y} onChange={(v) => patch("y", v)} />
                          </div>
                          <Field label="协议">
                            <input
                              value={selected.protocol}
                              onChange={(e) => patch("protocol", e.target.value)}
                            />
                          </Field>
                          <Field label="设备地址">
                            <input
                              value={selected.address}
                              onChange={(e) => patch("address", e.target.value)}
                            />
                          </Field>
                          {(selected.type === "面板" || selected.type === "温控器") &&
                            !isTabletopDevice(selected) && (
                            <Field label="安装高度 m（贴墙）">
                              <input
                                type="number"
                                step="0.01"
                                min={0.2}
                                max={2.6}
                                placeholder="默认：墙面中上部"
                                value={selected.installHeight ?? ""}
                                onChange={(e) =>
                                  patch("installHeight",
                                    e.target.value === "" ? undefined : Number(e.target.value))
                                }
                              />
                            </Field>
                          )}
                          {isTabletopDevice(selected) && (
                            <p className="subtle">
                              时光之轮一类遥控器不走墙装：直接可见——放在家具上（比如茶几）就出现在家具顶面，
                              放在空间里就落在地面。
                            </p>
                          )}
                          {selected.type === "面板" && (
                            <>
                              <PanelProductPicker dev={selected} products={products} disabled={locked}
                                onEdit={(values) => update((n) => {
                  const dv = n.devices.find((v) => v.id === selected.id)!;
                  applyPanelPick(dv, values, n.rooms.find((r) => r.id === dv.roomId));
                })} />
                              <Field label="物理按键数（4 键＝世聪「4键8功能」：每键短按 + 长按）">
                                <select
                                  disabled={locked || !!panelModel(selected.productId)}
                                  title={panelModel(selected.productId) ? "键数跟随所选型号" : undefined}
                                  value={selected.keys || PANEL_DEFAULT_KEYS}
                                  onChange={(e) =>
                                    update((n) => {
                                      const dev = n.devices.find((v) => v.id === selected.id)!;
                                      dev.keys = Number(e.target.value);
                                      normalizePanel(dev);
                                    })
                                  }
                                >
                                  {PANEL_KEY_COUNTS.map((k) => (
                                    <option key={k} value={k}>
                                      {k === 4 ? "4 键（4键8功能）" : k === 12 ? "12 键（屏显）" : `${k} 键`}
                                    </option>
                                  ))}
                                </select>
                              </Field>
                              <Field
                                label={`按键刻字（刻 ${
                                  selected.keys || PANEL_DEFAULT_KEYS
                                } 键 · ${engraveModeLabel(selected.engraveMode)} · ${
                                  panelModel(selected.productId)?.engraveLong ? "长按刻在键下方" : "长按仅功能不刻字"}）`}
                              >
                                <PanelKeyEditor
                                  dev={selected}
                                  scenes={d.scenes}
                                  room={d.rooms.find((r) => r.id === selected.roomId)}
                                  disabled={locked}
                                  onEdit={(mutate) =>
                                    update((n) => {
                                      const dev = n.devices.find((v) => v.id === selected.id)!;
                                      normalizePanel(dev);
                                      mutate(dev);
                                    })
                                  }
                                />
                              </Field>
                            </>
                          )}
                          {selected.type === "传感器" && (
                            <>
                              <div className="two-fields">
                                <Num
                                  label="探测半径（图纸单位）"
                                  value={selected.range ?? 80}
                                  min={0}
                                  onChange={(v) => patch("range", v)}
                                />
                                <Num
                                  label="离开后关闭延时 秒"
                                  value={selected.offDelaySeconds ?? 5}
                                  min={0}
                                  onChange={(v) => patch("offDelaySeconds", v)}
                                />
                              </div>
                              <div className="two-fields">
                                <Num
                                  label="联动亮度 %"
                                  value={selected.sensorBrightness ?? 100}
                                  min={0}
                                  onChange={(v) => patch("sensorBrightness", v)}
                                />
                                <Num
                                  label={selected.sensorCctAuto ? "联动色温 K（跟随联动灯）" : "联动色温 K"}
                                  value={selected.sensorCct ?? 3000}
                                  min={0}
                                  onChange={(v) => patch("sensorCct", v)}
                                />
                              </div>
                              <Field label="视场角（防穿墙：贴墙装、只朝一侧）">
                                <select
                                  value={String(sensorShape(selected).fov)}
                                  onChange={(e) => patch("fov", Number(e.target.value))} data-fid="L-13"
                                >
                                  {FOV_OPTIONS.map((v) => (
                                    <option key={v} value={v}>
                                      {v === 360 ? "360° · 整圆（默认）" : `${v}° · 扇形`}
                                    </option>
                                  ))}
                                </select>
                              </Field>
                              <Num
                                label="朝向 °（0＝图纸右方，顺时针）"
                                value={sensorShape(selected).heading}
                                min={0}
                                onChange={(v) =>
                                  patch("heading", ((Math.round(v) % 360) + 360) % 360)
                                }
                              />
                              <p className="field-hint">
                                {(() => {
                                  const geom = coverageGeometry(
                                    selected,
                                    obstaclesFor(selected, coverageCtx),
                                  );
                                  return geom
                                    ? `探测范围已按 ${geom} 裁剪：不会越出本空间、也不穿墙。`
                                    : "图上还没有该空间的边界、也没有墙体：范围按整圆/扇形示意。可以设视场角 + 朝向粗调，或直接手动拖顶点；画出空间边界/墙体后会自动按几何裁剪。";
                                })()}
                              </p>
                              <div className="two-fields">
                                <Button
                                  variant={coverageEdit === selected.id ? "primary" : ""}
                                  onClick={() => {
                                    if (coverageEdit === selected.id) {
                                      setCoverageEdit("");
                                      notify("已结束手动调整");
                                      return;
                                    }
                                    if (!hasManualCoverage(selected)) {
                                      const seed = coverageSeed(
                                        selected,
                                        obstaclesFor(selected, coverageCtx),
                                      );
                                      update((n) => {
                                        const dev = n.devices.find(
                                          (v) => v.id === selected.id,
                                        )!;
                                        dev.coveragePoints = seed;
                                      });
                                      notify(
                                        `已按当前范围生成 ${seed.length} 个顶点：在图上拖动绿点微调探测范围`,
                                      );
                                    }
                                    setCoverageEdit(selected.id);
                                  }} fid="L-43"
                                >
                                  <MousePointer2 size={14} />
                                  {coverageEdit === selected.id ? "结束调整" : "手动调整范围"}
                                </Button>
                                {coverageEdit === selected.id && (
                                  <>
                                    <Button
                                      onClick={() =>
                                        update((n) => {
                                          const dev = n.devices.find(
                                            (v) => v.id === selected.id,
                                          )!;
                                          dev.coveragePoints = insertCoveragePoint(
                                            manualCoverage(dev) || [],
                                          );
                                        })
                                      }
                                    >
                                      <Plus size={14} />
                                      加点
                                    </Button>
                                    <Button
                                      onClick={() => {
                                        const pts = manualCoverage(selected) || [];
                                        if (pts.length <= 3) {
                                          notify("探测范围至少需要 3 个点");
                                          return;
                                        }
                                        const idx =
                                          coverageSel >= 0 && coverageSel < pts.length
                                            ? coverageSel
                                            : pts.length - 1;
                                        update((n) => {
                                          const dev = n.devices.find(
                                            (v) => v.id === selected.id,
                                          )!;
                                          const list = manualCoverage(dev) || [];
                                          dev.coveragePoints = list.filter(
                                            (_p, i) => i !== idx,
                                          );
                                        });
                                        setCoverageSel(-1);
                                        notify(
                                          `已删除第 ${idx + 1} 个顶点${
                                            coverageSel >= 0
                                              ? ""
                                              : "（未选中顶点时默认删最后一个）"
                                          }`,
                                        );
                                      }}
                                      title="在图上点一个绿点即可选它，然后删这个点；没选就删最后一个"
                                    >
                                      <Minus size={14} />
                                      删点
                                      {coverageSel >= 0 ? `（第 ${coverageSel + 1} 点）` : ""}
                                    </Button>
                                    <Button
                                      onClick={() => {
                                        update((n) => {
                                          const dev = n.devices.find(
                                            (v) => v.id === selected.id,
                                          )!;
                                          delete dev.coveragePoints;
                                        });
                                        notify("已恢复按视场角/半径的范围");
                                      }}
                                    >
                                      <RotateCw size={14} />
                                      恢复按视场角
                                    </Button>
                                  </>
                                )}
                              </div>
                              {coverageEdit === selected.id && (
                                <p className="field-hint">
                                  在图上拖动绿点改探测范围（相对传感器，移动传感器时范围跟着走）；
                                  <b>点一下绿点＝选中它</b>，再点「删点」就删这一个
                                  {coverageSel >= 0 ? `（已选第 ${coverageSel + 1} 点）` : ""}。
                                  手动调整后半径与视场角不再决定范围，点「恢复按视场角」可回到参数化。
                                </p>
                              )}
                              {(() => {
                                // 穿墙提醒：范围够到别的空间的设备/灯具（跨空间联动是允许的，所以只提示）。
                                const issues = sensorCoverageIssues(
                                  selected,
                                  d.fixtures,
                                  d.devices,
                                  (o: Obj) =>
                                    Number.isFinite(o.floor)
                                      ? Number(o.floor)
                                      : d.rooms.find((r) => r.id === o.roomId)?.floor ?? 1,
                                  (o: Obj) =>
                                    parseFixtureCode(o.code || "")?.space ||
                                    o.space ||
                                    d.rooms.find((r) => r.id === o.roomId)?.name ||
                                    "",
                                );
                                if (!issues.spaces.length) return null;
                                return (
                                  <div className="notice amber">
                                    <AlertCircle size={16} />
                                    <div>
                                      <b>探测范围可能穿墙</b>
                                      <span>
                                        已够到{" "}
                                        {issues.spaces
                                          .slice(0, 3)
                                          .map((sp) => `「${sp.name}」`)
                                          .join("、")}
                                        {issues.spaces.length > 3
                                          ? ` 等 ${issues.spaces.length} 个空间`
                                          : ""}
                                        （最近 {Math.round(issues.nearest)} 单位 ≈{" "}
                                        {metres(issues.nearest)}）。若是隔壁房间的设备/灯具，建议收窄半径，
                                        或设视场角 + 朝向（贴墙装、只朝走道一侧）；跨空间联动是有意为之的话忽略即可。
                                      </span>
                                      <Button
                                        onClick={() =>
                                          patch("range", issues.suggestRange)
                                        }
                                      >
                                        收窄到 {issues.suggestRange}（≈{" "}
                                        {metres(issues.suggestRange)}）
                                      </Button>
                                    </div>
                                  </div>
                                );
                              })()}
                              {(() => {
                                // 关联灯具分两步：多层先选楼层；平层（或单层有灯）先选区域；再看灯具。
                                const lights = d.fixtures.filter(isSceneLight);
                                const multi = (p.floors || 1) > 1;
                                const lampFloors = Array.from(
                                  new Set(lights.map((f) => Number(f.floor) || 1)),
                                ).sort((a, b) => a - b);
                                const useFloor = multi && lampFloors.length > 1;
                                const devFloor = Number.isFinite(selected.floor)
                                  ? selected.floor
                                  : 1;
                                const activeFloor = useFloor
                                  ? lampFloors.includes(linkFloor)
                                    ? linkFloor
                                    : lampFloors.includes(devFloor)
                                      ? devFloor
                                      : lampFloors[0]
                                  : null;
                                const inFloor = activeFloor
                                  ? lights.filter((f) => (Number(f.floor) || 1) === activeFloor)
                                  : lights;
                                const spaceOf = (f: Obj) =>
                                  parseFixtureCode(f.code || "")?.space || f.space || "未分配空间";
                                const lampSpaces = Array.from(
                                  new Set(inFloor.map(spaceOf)),
                                ).sort();
                                const activeSpace = lampSpaces.includes(linkSpace)
                                  ? linkSpace
                                  : "";
                                const shown = activeSpace
                                  ? inFloor.filter((f) => spaceOf(f) === activeSpace)
                                  : inFloor;
                                const linkedIds = selected.linkedLights || [];
                                const toggleLink = (fid: string, on: boolean) =>
                                  update((n) => {
                                    const dev = n.devices.find((v) => v.id === selected.id)!;
                                    const cur = new Set<string>(dev.linkedLights || []);
                                    if (on) cur.add(fid);
                                    else cur.delete(fid);
                                    dev.linkedLights = Array.from(cur);
                                    syncSensorCct(dev, n.fixtures);
                                  });
                                return (
                                  <>
                                    {useFloor && (
                                      <Field label="① 先选楼层">
                                        <select
                                          value={String(activeFloor)}
                                          aria-label="关联楼层"
                                          onChange={(e) => {
                                            setLinkFloor(Number(e.target.value));
                                            setLinkSpace("");
                                          }}
                                        >
                                          {lampFloors.map((lv) => (
                                            <option key={lv} value={lv}>
                                              {floorLabel(lv, p.basements || 0)}（
                                              {
                                                lights.filter(
                                                  (f) => (Number(f.floor) || 1) === lv,
                                                ).length
                                              }{" "}
                                              盏）
                                            </option>
                                          ))}
                                        </select>
                                      </Field>
                                    )}
                                    <Field
                                      label={
                                        (useFloor ? "② " : "") +
                                        `选区域（${useFloor ? "可再筛选" : "平层先选区域"}）`
                                      }
                                    >
                                      <select
                                        value={activeSpace}
                                        aria-label="关联区域"
                                        onChange={(e) => setLinkSpace(e.target.value)} data-fid="L-17"
                                      >
                                        <option value="">
                                          本层全部区域（{inFloor.length} 盏）
                                        </option>
                                        {lampSpaces.map((sp) => (
                                          <option key={sp} value={sp}>
                                            {sp}（
                                            {inFloor.filter((f) => spaceOf(f) === sp).length} 盏）
                                          </option>
                                        ))}
                                      </select>
                                    </Field>
                                    <Field
                                      label={
                                        (useFloor ? "③ " : "② ") +
                                        "选择灯具（走近→亮，离开→关）"
                                      }
                                    >
                                      <div className="sensor-lights">
                                        {lights.length === 0 && (
                                          <span className="subtle">
                                            本项目还没有灯具：先「放置灯具」再回来勾选。
                                          </span>
                                        )}
                                        {lights.length > 0 && shown.length === 0 && (
                                          <span className="subtle">
                                            该区域还没有灯具，换个区域或先布灯。
                                          </span>
                                        )}
                                        {shown.map((f) => {
                                          const on = linkedIds.includes(f.id);
                                          return (
                                            <label
                                              key={f.id}
                                              className={`sensor-light${on ? " on" : ""}`}
                                            >
                                              <input
                                                type="checkbox"
                                                checked={on}
                                                onChange={(e) => toggleLink(f.id, e.target.checked)}
                                              />
                                              <span>
                                                {f.code} · {f.name}
                                              </span>
                                              <small>
                                                {useFloor
                                                  ? `${floorLabel(f.floor || 1, p.basements || 0)} · ${spaceOf(f)}`
                                                  : spaceOf(f)}
                                              </small>
                                            </label>
                                          );
                                        })}
                                      </div>
                                    </Field>
                                    <p className="field-hint">
                                      已关联 {linkedIds.length} 盏
                                      {linkedIds.length
                                        ? "：" +
                                          lights
                                            .filter((f) => linkedIds.includes(f.id))
                                            .map((f) => f.code)
                                            .slice(0, 8)
                                            .join("、") +
                                          (linkedIds.length > 8 ? " 等" : "")
                                        : "；多层先选楼层、平层先选区域，再勾选这一层的灯。"}
                                    </p>
                                  </>
                                );
                              })()}
                            </>
                          )}
                                                    <Button
                            variant="danger"
                            onClick={() => {
                              const devId = selected.id;
                              askDanger("删除该设备？", () => {
                                update((n) => {
                                  n.devices = n.devices.filter(
                                    (v) => v.id !== devId,
                                  );
                                  setSelection(null);
                                });
                              }, "该设备从本项目中移除；已关联的灯具与空间不受影响。");
                            }}
                          >
                            <Trash2 size={14} />
                            删除设备
                          </Button>
                        </>
                      )}
                      {selection?.kind === "fixtures" && (
                        <FixtureFields
                          fixture={selected}
                          rooms={d.rooms}
                          products={products}
                          multiFloor={p.floors > 1}
                          basements={p.basements || 0}
                          smart={p.smart}
                          patch={patch}
                          applyProduct={(prod) =>
                            update((n) => {
                              const f = n.fixtures.find(
                                (f) => f.id === selected.id,
                              )!;
                              applyProductToFixture(f, prod);
                              if (f.type === "灯带") {
                                f.powerSupply = f.powerSupply || "PS-" + f.code;
                                f.controller = f.controller || "CTL-" + f.code;
                                f.stripPath = f.stripPath?.length > 1 ? f.stripPath : [{ x: f.x, y: f.y }, { x: f.x + Math.max(30, (f.length || 1) * 26), y: f.y }];
                              }
                              n.scenes.forEach((s) => {
                                if (s.states[f.id])
                                  s.states[f.id].cct = Math.min(
                                    f.cctMax,
                                    Math.max(f.cctMin, s.states[f.id].cct),
                                  );
                              });
                            })
                          }
                        />
                      )}
                      {selection?.kind === "walls" && (
                        <>
                          <div className="two-fields">
                            {["x", "y", "x2", "y2"].map((k) => (
                              <Num
                                key={k}
                                label={k.toUpperCase()}
                                value={selected[k]}
                                onChange={(v) => patch(k, v)}
                              />
                            ))}
                          </div>
                          <Num
                            label="长度（画布单位）"
                            value={Math.hypot(
                              selected.x2 - selected.x,
                              selected.y2 - selected.y,
                            )}
                            min={1}
                            onChange={(v) =>
                              update((n) => {
                                const o = n.walls.find(
                                  (o) => o.id === selected.id,
                                )!;
                                const a = Math.atan2(o.y2 - o.y, o.x2 - o.x);
                                o.x2 = o.x + Math.cos(a) * v;
                                o.y2 = o.y + Math.sin(a) * v;
                                o.source = "manual";
                                o.needsReview = false;
                              })
                            }
                          />
                          <Field label="图层名称">
                            <input
                              value={selected.layer || ""}
                              onChange={(e) => patch("layer", e.target.value)}
                            />
                          </Field>
                        </>
                      )}
                      {selection?.kind === "openings" && (
                        <>
                          <Field label="对象类型">
                            <select
                              value={selected.type}
                              onChange={(e) => patch("type", e.target.value)}
                            >
                              <option>门</option>
                              <option>窗</option>
                            </select>
                          </Field>
                          <div className="two-fields">
                            {["x", "y", "width", "rotation"].map((k) => (
                              <Num
                                key={k}
                                label={
                                  {
                                    x: "X",
                                    y: "Y",
                                    width: "宽度",
                                    rotation: "旋转角度",
                                  }[k]!
                                }
                                value={selected[k]}
                                onChange={(v) => patch(k, v)}
                              />
                            ))}
                          </div>
                          <Button
                            onClick={() =>
                              patch("rotation", (selected.rotation + 90) % 360)
                            }
                          >
                            <RotateCw size={14} />
                            旋转 90°
                          </Button>
                        </>
                      )}
                      <div className="inspector-actions">
                        <Button
                          variant="primary"
                          disabled={busy || locked}
                          onClick={save}
                          title="立即保存当前修改（平时修改也会自动保存）"
                        >
                          <Save size={14} />
                          立即保存
                        </Button>
                        <Button onClick={copySelected}>
                          <Copy size={14} />
                          复制
                        </Button>
                        <Button
                          disabled={
                            !lampClipboard ||
                            (clipKind !== "fixtures" && clipKind !== "devices")
                          }
                          onClick={pasteFixture}
                        >
                          <Copy size={14} />
                          {clipKind === "devices" ? "粘贴设备" : "粘贴灯具"}
                        </Button>
                        <Button variant="danger" onClick={removeSelected}>
                          <Trash2 size={14} />
                          删除
                        </Button>
                      </div>
                    </fieldset>
                  </>
                ) : (
                  <>
                    <div className="inspector-empty">
                      <MousePointer2 size={30} strokeWidth={1} />
                      <h4>每个细节，都可以调整</h4>
                      <p>
                        选择画布中的房间、墙体、门窗或灯具，在这里编辑属性。
                      </p>
                    </div>
                    {(gapNoCircuit.length > 0 ||
                      (d.scenes.length > 0 && gapUnboundPanels.length > 0)) && (
                      <div className="gap-card">
                        <div className="gap-t">这个项目还差什么</div>
                        {gapNoCircuit.length > 0 && (
                          <button className="gap-row" onClick={() => setTab("fixtures")}>
                            <span>无回路</span>
                            <ChevronRight size={13} />
                          </button>
                        )}
                        {d.scenes.length > 0 && gapUnboundPanels.length > 0 && (
                          <button
                            className="gap-row"
                            onClick={() => {
                              setTab("scenes");
                              setSceneInsp("panel");
                            }}
                          >
                            <span>未绑定面板</span>
                            <ChevronRight size={13} />
                          </button>
                        )}
                      </div>
                    )}
                    <div className="design-metrics">
                      <div>
                        <span>空间数量</span>
                        <b>{d.rooms.length}</b>
                      </div>
                      <div>
                        <span>灯具数量</span>
                        <b>{lightFixtures.length}</b>
                      </div>
                      <div>
                        <span>总功率</span>
                        <b>{lightFixtures.reduce((a, f) => a + f.power, 0)} W</b>
                      </div>
                    </div>
                    <p className="inspector-disclaimer">
                      点击「调整家具」，在当前画布中选择、移动家具，修改类型、尺寸与朝向；改动自动保存并同步三维模型。
                    </p>
                  </>
                )}
              </div>
            </aside>
          </div>
        </>
      )}
      {tab === "fixtures" && (
        <main className="studio-content">
          <div className="page-heading">
            <div className="eyebrow">FIXTURE & DEVICE SCHEDULE</div>
            <div className="heading-line">
              <div>
                <h1>把每一盏灯，安排妥当。</h1>
                <p>
                  {lightFixtures.length} 盏灯具 ·{" "}
                  {
                    new Set(lightFixtures.map((f) => f.circuit).filter(Boolean))
                      .size
                  }{" "}
                  个回路 · 总功率 {lightFixtures.reduce((a, f) => a + f.power, 0)}{" "}
                  W
                </p>
              </div>
              <Button
                variant="primary"
                disabled={locked}
                onClick={openPlace}
                title="点一下进入布灯模式，再在图纸上点要放灯的位置；编号自动生成（如 kc001）并同步标准情景" fid="L-09"
              >
                <Plus size={16} />
                布灯
              </Button>
            </div>
          </div>
          <div className="notice">
            <AlertCircle size={16} />
            示例产品与单价仅供参考；勾选「价格已核实」代表人工核验。每段灯带独立编号、长度、电源与控制关系。
          </div>
          {cctIssues.length > 0 && (
            <div className="notice error-banner cct-warn" data-fid="L-21">
              <AlertCircle size={17} />
              <div>
                <b>灯具色温异常 {cctIssues.length} 盏</b>
                <span>
                  下列灯具的最低/最高色温或情景里的色温不一致，会导致保存失败。点「定位」直接跳到那盏灯修改，或「一键修正」。
                </span>
                <ul className="cct-warn-list">
                  {cctIssues.map(({ fixture: f, reasons }) => (
                    <li key={f.id}>
                      <b>{f.code}</b>
                      <em>{reasons.join("；")}</em>
                      <button className="text-link" onClick={() => locateFixture(f)} data-fid="L-23">
                        定位 <ChevronRight size={13} />
                      </button>
                      <button className="text-link" onClick={() => fixCct(f)} data-fid="L-22">
                        一键修正
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
          {cctChecklist("灯具清单")}
          <CircuitIssueList design={d} where="灯具清单" onLocate={locateFixture} />
          <CircuitBoard design={d} />
          <div className="table-toolbar">
            <span>
              灯具清单 <b>{lightFixtures.length}</b>
            </span>
            <div>
              <Button
                disabled={locked || !d.fixtures.length}
                onClick={tidyFixtureSpaces}
                title="按灯具编号（如 kc001）把每盏灯归入空间，并同步标准情景" fid="L-10"
              >
                <Layers3 size={14} />
                按编号同步空间与情景
              </Button>
              {(() => {
                const legacy = d.fixtures.filter(
                  (f) => isSceneLight(f) && !fixtureControlAllowed(String(p.smart || "无"), f.control),
                ).length;
                return (
                  <Button
                    disabled={locked || !legacy}
                    variant={legacy ? "primary" : ""}
                    onClick={normalizeAllControls}
                    title={
                      legacy
                        ? `有 ${legacy} 盏灯的控制方式不是本方案的合法值（界面显示「旧值，请重选」），一键按方案归一到开闭；要调光的再单独改 DALI`
                        : "所有灯具的控制方式都符合当前方案"
                    } fid="L-11"
                  >
                    <SlidersHorizontal size={14} />
                    归一控制方式{legacy ? `（${legacy} 盏旧值）` : ""}
                  </Button>
                );
              })()}
              <Button
                disabled={!d.fixtures.length}
                onClick={copyFixtureCodes}
                title="把勾选的灯具编号复制成多行文本（首行是清单表头，第二行是列名，之后每行：编号-名称-空间-位置-楼层-灯组，制表符分列），可直接粘进 Excel 或发给同事；没勾选就复制全部" fid="L-12"
              >
                <Copy size={14} />
                复制编号{checked.length ? `（${checked.length} 盏）` : "（全部）"}
              </Button>
              <label className="inline-field">
                灯组
                <input
                  value={groupDraft}
                  list="group-options"
                  placeholder="灯组名称"
                  onChange={(e) => setGroupDraft(e.target.value)}
                />
                <datalist id="group-options">
                  {fixtureGroups.map((g) => (
                    <option key={g} value={g} />
                  ))}
                </datalist>
              </label>
              <Button
                disabled={!checked.length || !groupDraft.trim() || locked}
                onClick={() => {
                  const g = groupDraft.trim();
                  update((n) =>
                    n.fixtures
                      .filter((f) => checked.includes(f.id))
                      .forEach((f) => (f.group = g)),
                  );
                  notify(`已将 ${checked.length} 盏灯设为灯组「${g}」`);
                }} fid="L-14"
              >
                设为该灯组
              </Button>
              <Button
                disabled={!checked.length || locked}
                onClick={() =>
                  update((n) =>
                    n.fixtures
                      .filter((f) => checked.includes(f.id))
                      .forEach((f) => (f.group = "")),
                  )
                } fid="L-15"
              >
                取消分组
              </Button>
              <select
                value={groupFilter}
                aria-label="按灯组筛选"
                onChange={(e) => setGroupFilter(e.target.value)} data-fid="L-16"
              >
                <option value="">全部灯组</option>
                {fixtureGroups.map((g) => (
                  <option key={g} value={g}>
                    {g}
                  </option>
                ))}
                <option value="__none__">未分组</option>
              </select>
              <label className="inline-field">
                批量位移
                <input
                  type="number"
                  value={offset}
                  onChange={(e) => setOffset(+e.target.value)}
                />{" "}
                px
              </label>
              <Button
                disabled={!checked.length || locked}
                onClick={() =>
                  update((n) =>
                    n.fixtures
                      .filter((f) => checked.includes(f.id))
                      .forEach((f) => (f.x += offset)),
                  )
                } fid="L-18"
              >
                向右移动
              </Button>
              <Button
                disabled={!checked.length || locked}
                variant="danger"
                onClick={() => {
                  const ids = checked.slice();
                  askDanger(`删除选中的 ${ids.length} 盏灯具？`, () => {
                    update((n) => {
                      n.fixtures = n.fixtures.filter(
                        (f) => !ids.includes(f.id),
                      );
                      n.scenes.forEach((s) =>
                        ids.forEach((fid) => delete s.states[fid]),
                      );
                    });
                    setChecked([]);
                  }, "灯具及其情景中的开关状态会一并移除。");
                }} fid="L-19"
              >
                <Trash2 size={14} />
                批量删除
              </Button>
            </div>
          </div>
          <div className="data-table-wrap" data-fid="L-20">
            <table className="data-table">
              <thead>
                <tr>
                  <th>
                    <input
                      type="checkbox"
                      aria-label="全选灯具"
                      checked={
                        fixtureRows.length > 0 &&
                        fixtureRows.every((f) => checked.includes(f.id))
                      }
                      onChange={(e) =>
                        setChecked(
                          e.target.checked ? fixtureRows.map((f) => f.id) : [],
                        )
                      }
                    />
                  </th>
                  <th>编号 / 灯具</th>
                  <th>产品型号</th>
                  <th>空间</th>
                  <th>灯组</th>
                  <th>功率</th>
                  <th>回路 / 控制</th>
                  <th>参考单价</th>
                  <th>价格状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {fixtureRows.map((f) => (
                  <tr key={f.id}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`选择 ${f.code}`}
                        checked={checked.includes(f.id)}
                        onChange={(e) =>
                          setChecked(
                            e.target.checked
                              ? [...checked, f.id]
                              : checked.filter((id) => id !== f.id),
                          )
                        }
                      />
                    </td>
                    <td>
                      <div className="table-light">
                        <span>
                          <Lightbulb size={17} />
                        </span>
                        <div>
                          <b>{f.code}</b>
                          <small>
                            {f.name} · {f.type} · {colorModeOf(f)}
                          </small>
                        </div>
                      </div>
                      {issuesOf(f.id).length > 0 && (
                        <span
                          className="badge red cct-badge"
                          title={issuesOf(f.id).join("；")}
                        >
                          色温异常
                        </span>
                      )}
                    </td>
                    <td>
                      {f.model}
                      <small>{f.brand}</small>
                    </td>
                    <td>
                      {f.space ||
                        d.rooms.find((r) => r.id === f.roomId)?.name ||
                        "未分配"}
                      <small>
                        {p.floors > 1
                          ? `${floorLabel(f.floor, p.basements)} · `
                          : ""}
                        {isDecorativeLight(f.type)
                          ? "装饰型灯具 · 免安装高度"
                          : `${f.installHeight}m 安装`}
                      </small>
                    </td>
                    <td>
                      {(f.group || "").trim() || "未分组"}
                      <small>{colorModeOf(f)}</small>
                    </td>
                    <td>{f.power} W</td>
                    <td>
                      {f.circuit || "未分配"}
                      <small>{f.control}</small>
                    </td>
                    <td className="amount">
                      {f.priceMissing && !(Number(f.price) > 0)
                        ? "—待补价"
                        : "¥ " + Number(f.price || 0).toFixed(2)}
                    </td>
                    <td>
                      <span
                        className={
                          "badge " + (f.priceVerified ? "green" : "amber")
                        }
                      >
                        {f.priceVerified ? "人工核实" : "待核实"}
                      </span>
                    </td>
                    <td>
                      {issuesOf(f.id).length > 0 && (
                        <button
                          className="text-link warn-text"
                          title="定位到该灯并打开配置"
                          onClick={() => locateFixture(f)}
                        >
                          定位 <ChevronRight size={13} />
                        </button>
                      )}
                      <button
                        className="text-link"
                        onClick={() => {
                          setSelection({ kind: "fixtures", id: f.id });
                          setModal("fixture");
                        }} data-fid="L-24"
                      >
                        编辑 <ChevronRight size={13} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!d.fixtures.length && (
              <div className="empty-state">
                <Lightbulb size={32} />
                <h3>还没有灯具</h3>
                <p>先在空间编辑器建立房间，再添加灯具。</p>
                <Button onClick={() => setTab("plan")} fid="L-25">前往底图与空间</Button>
              </div>
            )}
          </div>
          <div className="quote-summary">
            <span>
              纳入报价 {d.fixtures.filter((f) => f.quote).length} 项{" "}
              <small>· 不含人工、安装、税费、运费与智能设备</small>
            </span>
            <div>
              <span>参考合计（非正式报价）</span>
              <strong>
                ¥{" "}
                {d.fixtures
                  .filter((f) => f.quote)
                  .reduce(
                    (a, f) => a + f.price * (f.type === "灯带" ? f.length : 1),
                    0,
                  )
                  .toLocaleString("zh-CN", { minimumFractionDigits: 2 })}
              </strong>
            </div>
          </div>
          <section className="white-panel device-section" data-fid="L-26">
            <div className="section-heading">
              <h2>智能设备</h2>
              <span className="subtle">设备在「底图与空间」页添加；此处仅查看与配置。</span>
            </div>
            <p className="subtle">
              设备可从本地产品资料调取并加入项目；当前不连接物理网关。
              {d.architecture?.topology && <><br />基础架构：{d.architecture.topology}</>}
              {Array.isArray(d.architecture?.checks) && (d.architecture?.checks as Obj[]).length > 0 && (
                <ul className="arch-checks">
                  {(d.architecture?.checks as Obj[]).map((c: Obj, i: number) => (
                    <li key={i} className={c.ok ? "" : "warn-text"}>
                      {c.ok ? "✓" : "!"} {c.item}：需要 {c.need} — 生成 {c.made}{c.note ? `（${c.note}）` : ""}
                    </li>
                  ))}
                </ul>
              )}
              {Array.isArray(d.architecture?.warnings) && (d.architecture?.warnings as Obj[]).length > 0 && (
                <div className="warn-text">{(d.architecture?.warnings as string[]).join("；")}</div>
              )}
            </p>
            {d.devices.map((dev) => (
              <div className="device-block" key={dev.id}>
              <div className="device-row">
                <input
                  disabled={locked}
                  aria-label="设备编号"
                  className="device-code-input"
                  title="设备编号（可修改）：空间码 + 类型码 + 3 位序号"
                  value={dev.code || ""}
                  onChange={(e) =>
                    update((n) => {
                      n.devices.find((v) => v.id === dev.id)!.code =
                        e.target.value;
                    })
                  } data-fid="L-27"
                />
                <select
                  disabled={locked}
                  aria-label="从产品资料选择设备"
                  value={dev.productId || ""}
                  onChange={(e) => {
                    const product = products.find((v) => v.id === e.target.value);
                    if (product)
                      update((n) => {
                        const target = n.devices.find((v) => v.id === dev.id)!;
                        Object.assign(target, {
                          productId: product.id,
                          name: product.name,
                          type: product.type,
                          model: product.model,
                          protocol: product.protocol || target.protocol,
                          notes: product.notes || target.notes,
                        });
                        if (target.type === "面板") normalizePanel(target);
                        if (target.type === "传感器") normalizeSensor(target);
                      });
                  }} data-fid="L-28"
                >
                  <option value="">产品资料选型</option>
                  {products.filter((v) => v.category === "device" && v.type !== "窗帘" && !/(电机|轨道)/.test(v.name || "")).map((v) => <option key={v.id} value={v.id}>{v.name} · {v.model}</option>)}
                </select>
                <input
                  disabled={locked}
                  aria-label="设备名称"
                  value={dev.name}
                  onChange={(e) =>
                    update((n) => {
                      n.devices.find((v) => v.id === dev.id)!.name =
                        e.target.value;
                    })
                  }
                />
                <input
                  disabled={locked}
                  aria-label="设备型号"
                  placeholder="型号"
                  value={dev.model}
                  onChange={(e) =>
                    update((n) => {
                      n.devices.find((v) => v.id === dev.id)!.model =
                        e.target.value;
                    })
                  }
                />
                <select
                  disabled={locked}
                  value={dev.roomId}
                  onChange={(e) =>
                    update((n) => {
                      n.devices.find((v) => v.id === dev.id)!.roomId =
                        e.target.value;
                    })
                  }
                >
                  <option value="">未分配空间</option>
                  {d.rooms.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
                <input
                  disabled={locked}
                  aria-label="设备协议"
                  value={dev.protocol}
                  onChange={(e) =>
                    update((n) => {
                      n.devices.find((v) => v.id === dev.id)!.protocol =
                        e.target.value;
                    })
                  }
                />
                <input
                  disabled={locked}
                  aria-label="设备地址"
                  placeholder="设备地址"
                  value={dev.address}
                  onChange={(e) =>
                    update((n) => {
                      n.devices.find((v) => v.id === dev.id)!.address =
                        e.target.value;
                    })
                  }
                />
                <button
                  className="icon-btn danger-text"
                  disabled={locked}
                  title="删除设备"
                  onClick={() => {
                    const devId = dev.id;
                    askDanger("删除该设备？", () => {
                      update((n) => {
                        n.devices = n.devices.filter((v) => v.id !== devId);
                      });
                    }, "该设备从本项目中移除；已关联的灯具与空间不受影响。");
                  }} data-fid="L-29"
                >
                  <Trash2 size={16} />
                </button>
                              </div>
                {dev.type === "面板" && (
                  <div className="device-keys" data-fid="L-31">
                    <PanelProductPicker dev={dev} products={products} disabled={locked}
                      onEdit={(values) => update((n) => {
                  const dv = n.devices.find((v) => v.id === dev.id)!;
                  applyPanelPick(dv, values, n.rooms.find((r) => r.id === dv.roomId));
                })} />
                    <span className="device-keys-head">按键数</span>
                    <select
                      disabled={locked || !!panelModel(dev.productId)}
                      title={panelModel(dev.productId) ? "键数跟随所选型号" : undefined}
                      aria-label="面板按键数"
                      value={dev.keys || PANEL_DEFAULT_KEYS}
                      onChange={(e) =>
                        update((n) => {
                          const dv = n.devices.find((v) => v.id === dev.id)!;
                          dv.keys = Number(e.target.value);
                          normalizePanel(dv);
                        })
                      } data-fid="L-30"
                    >
                      {PANEL_KEY_COUNTS.map((k) => (
                        <option key={k} value={k}>
                          {k === 4 ? "4 键（4键8功能）" : k === 12 ? "12 键（屏显）" : `${k} 键`}
                        </option>
                      ))}
                    </select>
                    <PanelKeyEditor
                      dev={dev}
                      scenes={d.scenes}
                      room={d.rooms.find((r) => r.id === dev.roomId)}
                      disabled={locked}
                      onEdit={(mutate) =>
                        update((n) => {
                          const dv = n.devices.find((v) => v.id === dev.id)!;
                          normalizePanel(dv);
                          mutate(dv);
                        })
                      }
                    />
                  </div>
                )}
              </div>
            ))}
            {curtainFixtures.length > 0 && (
              <div className="device-block" aria-label="外挂设备 · 窗帘">
                <p className="subtle">外挂设备 · 窗帘（不进灯具清单，不带色温、不计功率；开合由场景联动）</p>
                {curtainFixtures.map((f) => (
                  <div className="device-row" key={f.id}>
                    <span>{f.code || "—"}</span>
                    <span>{f.name || "窗帘"}</span>
                    <span>{d.rooms.find((r) => r.id === f.roomId)?.name || "未分配空间"}</span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </main>
      )}
      {tab === "scenes" && (
        <main className={"studio-content" + (noSmart ? "" : " scene-page")}>
          {panelEditorOpen && selection?.kind === "devices" && selected?.type === "面板" && (
            <Modal title={`面板选型与刻字 · ${selected.code}`} subtitle="按世聪官网选型；每键只刻一次（短按），长按仅做功能不刻字（TK3 / ST3 上下双刻除外）；刻字实时显示在面板预览上"
              onClose={() => setPanelEditorOpen(false)} wide fid="L-41">
            <section className="panel-scene-direct">
              <strong>{selected.name} · {floorLabel(selected.floor || floor, p.basements)}</strong>
              <PanelProductPicker dev={selected} products={products} disabled={locked}
                onEdit={(values) => update((n) => {
                  const dv = n.devices.find((v) => v.id === selected.id)!;
                  applyPanelPick(dv, values, n.rooms.find((r) => r.id === dv.roomId));
                })} />
              <label>物理按键数 <select value={selected.keys || PANEL_DEFAULT_KEYS} disabled={locked || !!panelModel(selected.productId)}
                onChange={(e) => update((n) => {
                  const dv = n.devices.find((v) => v.id === selected.id)!;
                  dv.keys = Number(e.target.value); normalizePanel(dv);
                })}>{PANEL_KEY_COUNTS.map((k) => <option key={k} value={k}>{k} 键</option>)}</select></label>
              <PanelKeyEditor dev={selected} scenes={d.scenes} disabled={locked}
                room={d.rooms.find((r) => r.id === selected.roomId)}
                onEdit={(mutate) => update((n) => {
                  const dv = n.devices.find((v) => v.id === selected.id)!;
                  normalizePanel(dv); mutate(dv);
                })} />
            </section>
            </Modal>
          )}
          <div className="page-heading">
            <div className="eyebrow">SCENES THAT FEEL LIKE HOME</div>
            <div className="heading-line">
              <div>
                <h1>让光，跟随生活的节奏。</h1>
                <p>
                  按空间编情景、调亮度与色温；所有控制只作用于设计数据，不连接真实设备。
                </p>
              </div>
              <div className="flex">
                <label className="inline-field smart-picker">
                  智能方案
                  <select
                    value={smart}
                    disabled={locked || busy}
                    onChange={(e) => changeSmart(e.target.value)}
                    title="无线＝飞利浦；KNX＝总线；未设置＝灯具按回路开闭" data-fid="L-42"
                  >
                    {SMART_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
                <Button
                  disabled={!d.rooms.length}
                  onClick={() => {
                    setBackground("");
                    setTab("plan");
                  }} fid="C-01"
                >
                  <Layers3 size={15} /> 在底图上编辑
                </Button>
                {!noSmart && (
                  <Button
                    disabled={locked}
                    title={`按房型「${p.type}」+ 本项目空间筛出可用场景后一键套用`}
                    onClick={openSceneSetup} fid="C-02"
                  >
                    <Sun size={15} />
                    一键设置场景
                  </Button>
                )}
                {!noSmart && (
                  <Button disabled={locked} onClick={buildSystemArchitecture} fid="C-03">
                    <Box size={15} /> 自动建立系统架构
                  </Button>
                )}
                {!noSmart && (
                  <Button
                    variant="primary"
                    disabled={locked}
                    onClick={() => addScene()} fid="C-04"
                  >
                    <Plus size={16} />
                    新增情景
                  </Button>
                )}
                <Button
                  disabled={busy}
                  onClick={() => download("html")}
                  title="导出业主版灯光演示 HTML：单个文件、离线可用，可直接发给业主" fid="C-05"
                >
                  <Download size={16} />
                  导出演示页 HTML
                </Button>
                {!noSmart && (
                  <Button
                    variant={roamOn ? "primary" : undefined}
                    disabled={locked || !d.rooms.length}
                    title="小人漫游（只在 2D 平面图上演示）：点一下切到 2D 平面图并放下小人，按住小人走进传感器范围，关联灯具亮、离开则按延时关闭；再点一下退出并回到 3D"
                    onClick={() => {
                      // 2026-10-18：小人漫游只在 2D 平面图上有效——
                      // 点一下：切到 2D 平面图并放下小人；再点一下：退出漫游、回到 3D 界面。
                      if (roamOn) {
                        setRoamOn(false);
                        if (p?.mode === "3D") setView3d(true);
                        notify("已退出小人漫游" + (p?.mode === "3D" ? "，回到 3D 模型" : ""));
                        return;
                      }
                      if (!d.scenes.length) {
                        notify("先在「智能情景」里建立情景（一键设置场景），小人漫游在情景画布上演示");
                        return;
                      }
                      setRoamFloor(floor);
                      // 小人从本层（优先有传感器的）空间中心出发：默认的 (410,345) 常常落在户型外面，看不见。
                      const sensorRoom = roamSensors.map((v) => v.roomId).find(Boolean);
                      const start =
                        d.rooms.find((r) => r.id === sensorRoom) ||
                        d.rooms.find((r) => (r.floor || 1) === floor);
                      if (start) {
                        const pts = boundary(start);
                        if (pts.length)
                          setRoamPos({
                            x: pts.reduce((a, q) => a + q.x, 0) / pts.length,
                            y: pts.reduce((a, q) => a + q.y, 0) / pts.length,
                          });
                      }
                      setRoamOn(true);
                      // 漫游在 2D 平面图上演示：三维项目先切到 2D（2026-10-18 定）。
                      const toPlan = p?.mode === "3D";
                      if (toPlan) setView3d(false);
                      notify(
                        (roamSensors.length
                          ? ""
                          : "本层还没有传感器：先在「底图与空间 / 智能设备」里添加传感器，并设置探测半径与关联灯具；") +
                          (toPlan ? "已切到 2D 平面图开始小人漫游" : "小人漫游已开启") +
                          "：按住小人拖动（走进传感器范围，关联灯具亮）；再点一次「小人漫游」退出" +
                          (toPlan ? "并回到 3D 模型。" : "。"),
                      );
                    }} fid="C-06"
                  >
                    <Play size={16} /> 小人漫游
                  </Button>
                )}
              </div>
            </div>
          </div>
          {roamOn && (
            <div className="notice">
              <Play size={17} />
              <div>
                <b>小人漫游</b>
                <span>
                  在画布上按住拖动小人（多层项目可拖任意楼层的画布，小人跟随该层）：
                  走进传感器范围（虚线区域；设了视场角就是扇形）→ 关联灯具亮；离开 → 按传感器的「离开后关闭延时」关闭。
                  当前漫游：{floorLabel(roamFloor, p.basements || 0)}。
                  {p.mode === "3D"
                    ? "漫游只用 2D 平面图演示；再点一次「小人漫游」退出并回到 3D。"
                    : "再点一次「小人漫游」退出漫游。"}
                  {roamSensors.some((v) => Number(v.range) > 0)
                    ? ""
                    : ` ${floorLabel(roamFloor, p.basements || 0)}还没有设置「探测半径」的传感器：先在「智能设备」里给传感器设半径并勾选关联灯具。`}
                </span>
              </div>
            </div>
          )}
          {noSmart ? (
            <>
              <div className="notice">
                <Layers3 size={17} />
                <div>
                  <b>不做智能（按回路开闭）</b>
                  <span>
                    无需情景，灯具按回路开闭；回路编号可在「灯具配置」里维护。
                  </span>
                </div>
              </div>
              <div className="scene-workspace">
                <div className="scene-canvas">
                  <div className="scene-canvas-title">
                    <span>
                      <i />
                      {p.mode === "3D" && view3d ? "3D 空间" : "平面图"} <small>灯具分布 / 非实景</small>
                    </span>
                    {layerSwitch}
                    <select
                      aria-label="彩平图楼层"
                      value={floor}
                      onChange={(e) => setFloor(+e.target.value)}
                    >
                      {floorLevels(p.floors, p.basements).map((lv) => (
                        <option key={lv.value} value={lv.value}>
                          {lv.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  {p.floors > 1 && !(p.mode === "3D" && view3d) ? (
                    <div
                      className="scene-floors"
                      style={{
                        gridTemplateColumns:
                          p.floors === 2 ? "1fr 1fr" : "1fr",
                      }}
                    >
                      {floorLevels(p.floors, p.basements).map((lv) => (
                        <figure className="scene-floor" key={lv.value}>
                          <figcaption>
                            {lv.label}
                            <small>
                              {
                                d.fixtures.filter(
                                  (f) => (f.floor || 1) === lv.value,
                                ).length
                              }{" "}
                              盏
                            </small>
                          </figcaption>
                          {p.mode === "3D" && view3d ? <Spatial3D design={d} floor={lv.value} background={backgroundUrlFor(lv.value)} scene={scene} selection={selection} onSelect={setSelection} /> : <Plan
                            design={d}
                            projectArea={p.area}
                            showFixtureLayer={fixtureLayer}
                            showDeviceLayer={deviceLayer}
                            floor={lv.value}
                            mini={false}
                            showGrid={false}
                            background={backgroundUrlFor(lv.value)}
                            backgroundRect={bgRectFor(backgroundUrlFor(lv.value))}
                            voidNote={voidNoteFor(lv.value)}
                            readonly
                            selection={selection}
                            onSelect={setSelection}
                          />}
                        </figure>
                      ))}
                    </div>
                  ) : (
                    p.mode === "3D" && view3d ? <Ueyi3D projectId={id} floor={floor} states={scene?.states} back onBack2D={() => setView3d(false)} /> : <Plan
                      design={d}
                      projectArea={p.area}
                      showFixtureLayer={fixtureLayer}
                      showDeviceLayer={deviceLayer}
                      floor={floor}
                      mini={false}
                      showGrid={false}
                      background={backgroundUrl}
                      backgroundRect={bgRectFor(backgroundUrl)}
                      voidNote={voidNoteFor(floor)}
                      readonly
                      selection={selection}
                      onSelect={setSelection}
                    />
                  )}
                </div>
              </div>
            </>
          ) : scene ? (
            <>
              {/* 2026-10-19 改版（定稿）：整页不滚。
                  左栏＝情景竖排（14 个一屏排完，可搜、可 ↑↓ 切）；中间＝画布；右栏＝检查器
                  （情景 / 回路 / 灯具 / 面板 四页，点谁就是谁）。
                  改之前情景是 175px 横向滚动窗，回路和单灯在画布下方铺 5 行，整页 2000px，
                  调一盏灯的亮度画布已经滚出屏幕了。 */}
              <div className="scene-stage">
                <aside className="scene-rail">
                  <div className="scene-rail-head">
                    <h2>情景<span>{d.scenes.length}</span></h2>
                    <input
                      className="scene-rail-search"
                      placeholder="搜索情景…"
                      value={sceneQuery}
                      onChange={(e) => setSceneQuery(e.target.value)} data-fid="C-11"
                    />
                  </div>
                  <div className="scene-rail-list" data-fid="C-07">
                    {(() => {
                      const q = sceneQuery.trim().toLowerCase();
                      const rows = d.scenes.filter(
                        (s) => !q || String(s.name || "").toLowerCase().includes(q),
                      );
                      if (!rows.length) return <p className="scene-rail-empty">没有匹配的情景</p>;
                      const groups = new Map<string, Obj[]>();
                      rows.forEach((s) => {
                        const code = String(s.templateCode || s.name || "").trim();
                        const g = code.split(".")[0] || "·";
                        if (!groups.has(g)) groups.set(g, []);
                        groups.get(g)!.push(s);
                      });
                      const gname: Obj = { "00": "基础", "9": "睡眠 / 起居", "13": "场景" };
                      return Array.from(groups.entries()).map(([g, list]) => (
                        <div key={g}>
                          <div className="scene-rail-group">
                            {gname[g] ? g + " · " + gname[g] : g}
                          </div>
                          {list.map((s) => {
                            const onCount = Object.values(s.states || {}).filter((st: any) => st.on).length;
                            const total = Math.max(1, d.fixtures.filter(isSceneLight).length);
                            return (
                              <button
                                key={s.id}
                                className={"scene-rail-item" + (scene?.id === s.id ? " active" : "")}
                                onClick={() => setActiveScene(s.id)}
                                title={`${s.name} · ${onCount} 盏点亮`} data-fid="C-08"
                              >
                                <span className="nm">{s.name}</span>
                                <span className="n">{onCount}</span>
                                <span className="sub">{s.trigger || "手动"} · {Number(s.fade) || 0}s</span>
                                <i className="bar" style={{ width: Math.round((onCount / total) * 100) + "%" }} />
                              </button>
                            );
                          })}
                        </div>
                      ));
                    })()}
                  </div>
                  <div className="scene-rail-foot">
                    <Button disabled={locked} onClick={() => addScene()} fid="C-09">
                      <Plus size={14} /> 新增情景
                    </Button>
                  </div>
                </aside>

                <div className="scene-center">
                  <div className="scene-canvas">
                      <div className="scene-canvas-title">
                        <span>
                          <i />
                          {scene.name} <small>{p.mode === "3D" && view3d ? "3D 模型 / 非实景渲染" : "灯光分布示意 / 非实景"}</small>
                        </span>
                        {layerSwitch}
                        {p.floors > 1 ? (
                          <span className="floor-link-badge">
                            <Link size={12} /> {levelSummary(p.floors, p.basements)}同步 · 全屋联动
                          </span>
                        ) : null}
                        {(p.floors <= 1 || (p.mode === "3D" && view3d)) && (
                          <select aria-label="场景预览楼层" value={floor} onChange={(e) => setFloor(+e.target.value)}>
                            {floorLevels(p.floors, p.basements).map((lv) => (
                              <option key={lv.value} value={lv.value}>{lv.label}</option>
                            ))}
                          </select>
                        )}
                      </div>
                      {p.floors > 1 && !(p.mode === "3D" && view3d) ? (
                        <div
                          className="scene-floors"
                          style={{
                            gridTemplateColumns:
                              p.floors === 2 ? "1fr 1fr" : "1fr",
                          }}
                        >
                          {floorLevels(p.floors, p.basements).map((lv) => (
                            <figure className="scene-floor" key={lv.value}>
                              <figcaption>
                                {lv.label}
                                <small>
                                  {
                                    d.fixtures.filter(
                                      (f) => (f.floor || 1) === lv.value,
                                    ).length
                                  }{" "}
                                  盏
                                </small>
                              </figcaption>
                              {p.mode === "3D" && view3d ? <Spatial3D design={d} floor={lv.value} background={backgroundUrlFor(lv.value)} scene={scene} selection={selection} onSelect={setSelection} /> : <Plan
                                design={d}
                                scene={roamSceneOf(scene)}
                                projectArea={p.area}
                                showFixtureLayer={fixtureLayer}
                                showDeviceLayer={deviceLayer}
                                floor={lv.value}
                                mini={false}
                                showGrid={false}
                                fadeTick={fadeTick}
                                background={backgroundUrlFor(lv.value)}
                                backgroundRect={bgRectFor(backgroundUrlFor(lv.value))}
                                voidNote={voidNoteFor(lv.value)}
                                readonly
                                selection={selection}
                                onSelect={setSelection}
                                roam={roamOn && lv.value === roamFloor ? roamPos : null}
                                roamArmed={roamOn}
                                onRoamMove={(x, y) => {
                                  setRoamFloor(lv.value);
                                  setRoamPos({ x, y });
                                }}
                              />}
                            </figure>
                          ))}
                        </div>
                      ) : (
                        p.mode === "3D" && view3d ? <Ueyi3D projectId={id} floor={floor} states={scene?.states} back onBack2D={() => setView3d(false)} /> : <Plan
                          design={d}
                          scene={roamSceneOf(scene)}
                          projectArea={p.area}
                          showFixtureLayer={fixtureLayer}
                          showDeviceLayer={deviceLayer}
                          floor={floor}
                          mini={false}
                          showGrid={false}
                          fadeTick={fadeTick}
                          background={backgroundUrlFor(floor)}
                          backgroundRect={bgRectFor(backgroundUrlFor(floor))}
                          voidNote={voidNoteFor(floor)}
                          readonly
                          selection={selection}
                          onSelect={(s) => {
                            setSelection(s);
                            if (s?.kind === "devices" && d.devices.find((dev) => dev.id === s.id)?.type === "面板") setPanelEditorOpen(true);
                          }}
                          roam={roamOn && roamFloor === floor ? roamPos : null}
                          roamArmed={roamOn}
                          onRoamMove={(x, y) => {
                            setRoamFloor(floor);
                            setRoamPos({ x, y });
                          }}
                        />
                      )}
                    </div>
                </div>

                <aside className="scene-insp">
                  <div className="scene-insp-tabs" data-fid="C-10">
                    {([
                      ["scene", "情景"],
                      ["circuit", "回路"],
                      ["lamp", "灯具"],
                      ["panel", "面板"],
                    ] as const).map(([k, label]) => (
                      <button
                        key={k}
                        className={sceneInsp === k ? "active" : ""}
                        onClick={() => setSceneInsp(k)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <div className="scene-insp-body" key={sceneInsp}>
                    {sceneInsp === "scene" && (
                      <div className="scene-insp-pane">
                          <fieldset disabled={locked || busy} data-fid="C-12">
                            <Field label="情景名称">
                              <input
                                value={scene.name}
                                onChange={(e) => scenePatch("name", e.target.value)}
                              />
                            </Field>
                            <Field label="情景描述">
                              <textarea
                                value={scene.description}
                                onChange={(e) =>
                                  scenePatch("description", e.target.value)
                                }
                              />
                            </Field>
                            <Field label="触发方式（设计配置）">
                              <select
                                value={scene.trigger}
                                onChange={(e) => scenePatch("trigger", e.target.value)}
                              >
                                {["手动", "面板按键", "定时", "传感器"].map((t) => (
                                  <option key={t}>{t}</option>
                                ))}
                              </select>
                            </Field>
                            {noSmart ? (
                              <Field label="缓亮缓灭（回路开关）">
                                <input readOnly value="固定 1 秒" title="回路开闭默认缓亮缓灭 1 秒" />
                              </Field>
                            ) : (
                              <Num
                                label="渐变时间 / 秒"
                                value={scene.fade}
                                min={0}
                                onChange={(v) => scenePatch("fade", v)}
                              />
                            )}
                            {(scene.automationActions || []).length > 0 && (
                              <Field label="设备联动动作（传感器 / 窗帘等）">
                                <div className="automation-actions">
                                  {(scene.automationActions || []).map((a: any, i: number) => (
                                    <span key={i} className="automation-chip">
                                      {a.deviceType || "设备"} · {a.action || ""}
                                      {a.delayMinutes ? ` · +${a.delayMinutes}min` : ""}
                                    </span>
                                  ))}
                                </div>
                              </Field>
                            )}
                            {(() => {
                              const def = sceneDefFor(scene.name);
                              if (!def) return null;
                              return (
                                <>
                                  <Field label={`场景优先级 · ${priorityName(def.priority || "")}`}>
                                    <input readOnly value={def.priority || ""} />
                                  </Field>
                                  <Field label="触发条件（场景包）">
                                    <textarea readOnly value={def.trigger || ""} />
                                  </Field>
                                  <Field label="退出机制（场景包）">
                                    <textarea readOnly value={def.exit || ""} />
                                  </Field>
                                </>
                              );
                            })()}
                            <div className="two-fields">
                              <Button
                                onClick={() => {
                                  editSceneDraft((s) => {
                                    s.customized = true;
                                    (d?.fixtures || []).forEach((f) => {
                                      s.states[f.id] = noSmart
                                        ? {
                                            on: true,
                                            brightness: Number(f.brightnessMax) || 100,
                                            cct: clampCctForFixture(f, f.cct ?? f.cctMin),
                                          }
                                        : {
                                            on: true,
                                            brightness: Math.min(80, f.brightnessMax),
                                            cct: f.cctMin,
                                            ...s.states[f.id],
                                          };
                                      s.states[f.id].on = true;
                                    });
                                  });
                                  setFadeTick((t) => t + 1);
                                }} fid="C-13"
                              >
                                <Power size={14} />
                                全部开启
                              </Button>
                              <Button
                                onClick={() => {
                                  editSceneDraft((s) => {
                                    s.customized = true;
                                    Object.values(s.states).forEach((v: any) => {
                                      v.on = false;
                                      if (noSmart) v.brightness = 0;
                                    });
                                  });
                                  setFadeTick((t) => t + 1);
                                }} fid="C-14"
                              >
                                全部关闭
                              </Button>
                            </div>
                            <div className="two-fields">
                              <Button
                                onClick={() => {
                                  setSceneDraft(null);
                                  w.undo();
                                }}
                                disabled={!w.canUndo || locked}
                                title="撤回上一步" fid="C-15"
                              >
                                <Undo2 size={14} />
                                撤回
                              </Button>
                              <Button
                                onClick={() => {
                                  setSceneDraft(null);
                                  w.redo();
                                }}
                                disabled={!w.canRedo || locked}
                                title="恢复" fid="C-16"
                              >
                                <Redo2 size={14} />
                                恢复
                              </Button>
                            </div>
                            <Button
                              variant="primary"
                              disabled={busy}
                              onClick={() =>
                                run(() => {
                                  commitSceneDraft();
                                  return flush();
                                }, "场景已保存")
                              } fid="C-17"
                            >
                              <Save size={14} />
                              保存场景
                            </Button>
                            <Button
                              variant="danger"
                              onClick={() => {
                                const sceneId = scene.id;
                                askDanger("删除此情景？", () => {
                                  update((n) => {
                                    n.scenes = n.scenes.filter(
                                      (s) => s.id !== sceneId,
                                    );
                                  });
                                }, "该情景的灯光状态会被移除，其他情景不受影响。");
                              }} fid="C-18"
                            >
                              <Trash2 size={14} />
                              删除情景
                            </Button>
                          </fieldset>
                          <hr />
                          <Button
                            variant="primary"
                            disabled={busy}
                            onClick={() =>
                              run(
                                () =>
                                  operation("/renders", { sceneId: scene.id, floor }),
                                "情景示意图已生成，可在「效果与示意」查看",
                              )
                            } fid="C-19"
                          >
                            <Image size={16} />
                            生成此情景示意图
                          </Button>
                          <p className="inspector-disclaimer">
                            切换情景时按该情景的「渐变时间」缓变过渡（亮度与色温逐步变化，不是瞬间跳变）。预览仅展示亮度与色温的视觉差异，不进行物理光照或照度计算。
                          </p>

                      </div>
                    )}

                    {sceneInsp === "circuit" && (
                      <div className="scene-insp-pane">
                        <div className="scene-insp-head">
                          <span>回路</span>
                          <span>{circuitGroups.length} 组</span>
                        </div>
                        {circuitGroups.map((g) => {
                          const lit = g.fixtures.filter((f) => (scene.states[f.id] || {}).on);
                          const lv = lit.length
                            ? Math.round(lit.reduce((a, f) => a + (Number(scene.states[f.id]?.brightness) || 0), 0) / lit.length)
                            : 0;
                          return (
                            <div key={g.key} className={"circ-row" + (lit.length ? " is-on" : "")}>
                              <button
                                type="button"
                                role="switch"
                                aria-checked={!!lit.length}
                                aria-label={`回路 ${g.name} 开关`}
                                disabled={locked}
                                className={"switch " + (lit.length ? "on" : "")}
                                onClick={() => circuitState(g, !lit.length)} data-fid="L-44"
                              >
                                <i />
                              </button>
                              <span className="circ-row-name">
                                {g.name}
                                <small>{g.fixtures.length} 盏 · {g.rooms.filter(Boolean).join("、") || "未分区"}</small>
                              </span>
                              <span className="circ-row-pct">{lit.length ? lv + "%" : "—"}</span>
                              <input
                                className="circ-row-slider"
                                type="range"
                                min={0}
                                max={100}
                                value={lv}
                                disabled={locked}
                                aria-label={`回路 ${g.name} 亮度`}
                                onChange={(e) => circuitBrightness(g, Number(e.target.value))} data-fid="L-45"
                              />
                            </div>
                          );
                        })}
                        {!circuitGroups.length && (
                          <p className="scene-insp-empty">还没有灯具：先在「底图与空间」布灯。</p>
                        )}
                      </div>
                    )}

                    {sceneInsp === "lamp" && (() => {
                      const lamps = d.fixtures.filter(isSceneLight);
                      const focus = selection?.kind === "fixtures"
                        ? lamps.find((f) => f.id === selection.id)
                        : null;
                      const card = (f: Obj) => {
                        const st = scene.states[f.id] || { on: false, brightness: 0, cct: f.cctMin };
                        return (
                          <div className="lamp-card" key={f.id}>
                            <div className="lamp-card-top">
                              <span className="badge">{String(f.code || "").slice(-3)}</span>
                              <span className="tt">
                                {f.code} · {f.name}
                                <small>
                                  {d.rooms.find((r) => r.id === f.roomId)?.name || "未分配空间"}
                                  {" · "}{circuitOf(f)}
                                </small>
                              </span>
                              <button
                                type="button"
                                role="switch"
                                aria-checked={!!st.on}
                                aria-label={`${f.code} 开关`}
                                disabled={locked}
                                className={"switch " + (st.on ? "on" : "")}
                                onClick={() => lampState(f.id, "on", !st.on)}
                              >
                                <i />
                              </button>
                            </div>
                            <label className="lamp-line">
                              <span>亮度 <b>{st.brightness}%</b></span>
                              <input
                                type="range"
                                min={0}
                                max={f.brightnessMax}
                                disabled={locked || !f.dimmable}
                                value={st.brightness}
                                aria-label={`${f.code} 亮度`}
                                onChange={(e) => lampState(f.id, "brightness", +e.target.value)}
                              />
                            </label>
                            <label className="lamp-line">
                              <span>色温 <b>{st.cct} K</b></span>
                              <input
                                className="cct-slider"
                                type="range"
                                min={f.cctMin}
                                max={f.cctMax}
                                step={100}
                                disabled={locked || !f.tunable}
                                value={st.cct}
                                aria-label={`${f.code} 色温`}
                                onChange={(e) => lampState(f.id, "cct", +e.target.value)}
                              />
                            </label>
                          </div>
                        );
                      };
                      return (
                        <div className="scene-insp-pane">
                          {focus ? card(focus) : (
                            <p className="scene-insp-empty">
                              点画布上的一盏灯，这里显示它的亮度与色温；下面也能直接调每一盏。
                            </p>
                          )}
                          <div className="scene-insp-head">
                            <span>{focus ? "其他灯具" : "全部灯具"}</span>
                            <span>{lamps.length} 盏</span>
                          </div>
                          {lamps.filter((f) => !focus || f.id !== focus.id).map((f) => {
                            const st = scene.states[f.id] || { on: false, brightness: 0 };
                            return (
                              <button
                                key={f.id}
                                type="button"
                                className={"lamp-row" + (st.on ? " is-on" : "")}
                                onClick={() => setSelection({ kind: "fixtures", id: f.id })}
                              >
                                <span className="nm">{f.code}</span>
                                <span className="sub">
                                  {d.rooms.find((r) => r.id === f.roomId)?.name || "未分配"} · {f.name}
                                </span>
                                <span className={"dot" + (st.on ? " on" : "")} />
                                <span className="pct">{st.on ? st.brightness + "%" : "关"}</span>
                              </button>
                            );
                          })}
                        </div>
                      );
                    })()}

                    {sceneInsp === "panel" && (() => {
                      const panels = d.devices.filter(
                        (v) =>
                          v.type === "面板" &&
                          (Number.isFinite(v.floor)
                            ? v.floor
                            : d.rooms.find((r) => r.id === v.roomId)?.floor || 1) === floor,
                      );
                      if (!panels.length) {
                        return (
                          <div className="scene-insp-pane">
                            <p className="scene-insp-empty">
                              本层还没有面板：在「智能设备」里添加，或在 3D 画布上点一块面板。
                            </p>
                          </div>
                        );
                      }
                      const dev = panels.find((v) => v.id === inspPanelId) || panels[0];
                      return (
                        <div className="scene-insp-pane">
                          <select
                            className="scene-insp-select"
                            value={dev.id}
                            onChange={(e) => setInspPanelId(e.target.value)}
                            aria-label="选择面板"
                          >
                            {panels.map((v) => (
                              <option key={v.id} value={v.id}>
                                {v.code || "未编号"} · {d.rooms.find((r) => r.id === v.roomId)?.name || "未分配"} · {Number(v.keys) || PANEL_DEFAULT_KEYS} 键
                              </option>
                            ))}
                          </select>
                          <Button
                            disabled={locked}
                            onClick={() => {
                              setSelection({ kind: "devices", id: dev.id });
                              setPanelEditorOpen(true);
                            }}
                          >
                            <PencilRuler size={14} /> 选型与刻字
                          </Button>
                          <PanelKeyEditor
                            dev={dev}
                            scenes={d.scenes}
                            disabled={locked}
                            room={d.rooms.find((r) => r.id === dev.roomId)}
                            onEdit={(mutate) =>
                              update((n) => {
                                const dv = n.devices.find((v) => v.id === dev.id)!;
                                normalizePanel(dv);
                                mutate(dv);
                              })
                            }
                          />
                        </div>
                      );
                    })()}
                  </div>
                </aside>
              </div>
            </>
          ) : (
            <>
              {p.mode === "3D" && view3d && (
                <div className="scene-canvas">
                  <div className="scene-canvas-title">
                    <span>3D 空间 <small>尚未设置情景 · 显示模型本身</small></span>
                    <select aria-label="场景预览楼层" value={floor} onChange={(e) => setFloor(+e.target.value)}>
                      {floorLevels(p.floors, p.basements).map((lv) => (
                        <option key={lv.value} value={lv.value}>{lv.label}</option>
                      ))}
                    </select>
                  </div>
                  {/* 这个分支里还没有任何情景：三维按内核自己的预置亮，不传 states */}
                  <Ueyi3D projectId={id} floor={floor} back={false} />
                </div>
              )}
              <div className="empty-state">
                <Sun size={36} />
                <h3>创建第一个生活情景</h3>
                <p>你可以从日常、会客、观影和晚安预设开始。</p>
                <Button variant="primary" disabled={locked} onClick={presets}>
                  写入标准化场景
                </Button>
              </div>
            </>
          )}
        </main>
      )}
      {tab === "renders" && (
        <main className="studio-content">
          <div className="page-heading">
            <div className="eyebrow">VISUALIZE YOUR LIGHT</div>
            <div className="heading-line">
              <div>
                <h1>看见光的层次。</h1>
                <p>
                  本地 Provider
                  生成二维灯光分布示意。真实空间效果图需要后续接入图像模型。
                </p>
              </div>
              <div className="flex">
                <Button
                  disabled={busy || !health.effectRenderConfigured}
                  title={health.effectRenderConfigured ? "提交至已配置的外部效果图接口" : "请先在服务端配置 EFFECT_RENDER_PROVIDER 与 EFFECT_RENDER_URL"}
                  onClick={() => run(() => operation("/effect-renders", { floor, sceneId: activeScene || scene?.id, sourceFileId: d.baseFileId }), "效果图任务已完成")} fid="V-03"
                ><Sparkles size={16} /> 生成效果图</Button>
              </div>
            </div>
          </div>
          <div className={"notice " + (health.effectRenderConfigured ? "" : "amber")}>
            <AlertCircle size={17} />
            {health.effectRenderConfigured
              ? `效果图接口已配置（${health.effectRenderProvider}）：会提交项目、场景、镜头及选定参考图，并保存接口返回的图片。`
              : "效果图接口未配置：当前只能生成二维灯光示意，不会把示意图伪装成效果图。服务端配置 EFFECT_RENDER_PROVIDER 与 EFFECT_RENDER_URL 后可直接生成。"}
          </div>
          <div className="white-panel camera-panel" data-fid="V-05">
            <h3>效果图 / 彩平参考底稿</h3>
            <p className="subtle">上传效果图或参考彩平后，可作为智能情景画布底图；在场景页直接调整每盏灯状态。当前本地模式叠加的是二维灯光示意，不伪装为实景渲染。</p>
            <div className="flex">
              <Button disabled={locked || busy} onClick={() => effectUploadRef.current?.click()} fid="V-04"><Upload size={14} /> 上传效果图 / 彩平</Button>
              <select aria-label="选择效果图底稿" value={d.baseFileId || ""} onChange={(e) => { const fid=e.target.value; update((n) => n.baseFileId=fid || undefined); setBackground(fid ? `/api/projects/${id}/files/${fid}?preview=true` : ""); }}>
                <option value="">不使用底稿</option>
                {p.files.filter((f) => f.preview).map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
              <Button disabled={!d.baseFileId} onClick={() => { setBackground(`/api/projects/${id}/files/${d.baseFileId}?preview=true`); setTab("scenes"); }} fid="V-06">在效果图上编辑场景</Button>
            </div>
            <input ref={effectUploadRef} hidden type="file" accept="image/*" onChange={(e) => { filesUpload(e.target.files, false).then(() => notify("效果图已上传，请在下拉列表选择为编辑底稿")); e.target.value=""; }} />
          </div>
          <div className="white-panel camera-panel">
            <h3>
              镜头配置 <span className="badge gray">接口预留 · 参数可保存</span>
            </h3>
            <fieldset disabled={locked || busy}>
              <div className="camera-fields" data-fid="V-07">
                {[
                  ["x", "位置 X"],
                  ["y", "位置 Y"],
                  ["height", "高度 m"],
                  ["yaw", "水平角度"],
                  ["pitch", "俯仰角"],
                  ["focal", "焦距 mm"],
                ].map(([k, l]) => (
                  <Num
                    key={k}
                    label={l}
                    value={d.camera[k]}
                    onChange={(v) => update((n) => (n.camera[k] = v))}
                  />
                ))}
                <Field label="画面比例">
                  <select
                    value={d.camera.ratio}
                    onChange={(e) =>
                      update((n) => (n.camera.ratio = e.target.value))
                    }
                  >
                    <option>16:9</option>
                    <option>4:3</option>
                    <option>1:1</option>
                  </select>
                </Field>
                <Field label="目标分辨率">
                  <select
                    value={d.camera.resolution}
                    onChange={(e) =>
                      update((n) => (n.camera.resolution = e.target.value))
                    }
                  >
                    <option>1920x1080</option>
                    <option>2560x1440</option>
                  </select>
                </Field>
              </div>
            </fieldset>
          </div>
          <div className="render-grid" data-fid="V-08">
            {p.renders
              .slice()
              .reverse()
              .map((r) => (
                <article key={r.id}>
                  <button
                    onClick={() =>
                      setRenderPreview(`/api/projects/${id}/renders/${r.id}`)
                    }
                  >
                    <img
                      src={`/api/projects/${id}/renders/${r.id}`}
                      alt={r.name + " 本地示意图"}
                    />
                    <span>本地示意 · 草稿</span>
                    <Maximize size={20} />
                  </button>
                  <div>
                    <h3>{r.name}</h3>
                    <p>
                      V{r.version} / R{r.revision} · {fmtDate(r.createdAt)}
                    </p>
                    <a
                      className="text-link"
                      href={`/api/projects/${id}/renders/${r.id}`}
                      download={`${p.code}_V${r.version}_R${r.revision}_F${r.floor || 1}_${r.id}.png`} data-fid="V-09"
                    >
                      下载示意图 <Download size={14} />
                    </a>
                  </div>
                </article>
              ))}
          </div>
          {!p.renders.length && (
            <div className="empty-state">
              <Image size={36} />
              <h3>还没有生成的示意图</h3>
              <p>前往智能情景生成不同灯光状态的示意。</p>
              <Button onClick={() => setTab("scenes")} fid="V-10">
                前往智能情景 <ChevronRight size={14} />
              </Button>
            </div>
          )}
        </main>
      )}
      {tab === "deliver" && (
        <main className="studio-content">
          {shellV2 && (
            <div className="wsv2-dmode" data-fid="R-01">
              <button className={v2Delivery === "review" ? "on" : ""} onClick={() => { setV2Delivery("review"); setV2Section("review"); }} data-fid="R-02">复核</button>
              <button className={v2Delivery === "export" ? "on" : ""} onClick={() => { setV2Delivery("export"); setV2Section("export"); }} data-fid="R-03">交付</button>
              <span>{v2Delivery === "review" ? "五道人工复核；签名后进入交付" : "导出交付文件；复核状态另见复核页"}</span>
            </div>
          )}
          <div className="page-heading">
            <div className="eyebrow">复核与交付 · 人工签名绑定版本</div>
            <div className="heading-line">
              <div>
                <h1>交付之前，再认真一点。</h1>
                <p>
                  五道人工复核与版本绑定：先满足各卡片上写的前置条件再签名，否则会被拦下；全部五道签完才能冻结。任何设计修改重置复核。业务状态：未发布（交付前）。
                </p>
              </div>
              <div className="deliver-head-actions">
                <Button
                  variant="primary"
                  onClick={() => setModal("export")}
                  title="先选交付对象（给业主 / 给施工 / 内部版）和格式，一次点击打开导出抽屉" fid="E-11"
                >
                  <Download size={16} />
                  导出交付文件
                </Button>
                <Button
                  disabled={!p.approved || locked || busy}
                  title={
                    locked
                      ? "版本已冻结或归档，不能再冻结"
                      : busy
                        ? "正在保存或导出，稍后再试"
                        : "五道人工复核全部签完后才能冻结"
                  }
                  onClick={() =>
                    run(
                      () => operation("/freeze"),
                      "版本已冻结，后续编辑须建立新版本",
                    )
                  } fid="R-04"
                >
                  <Lock size={16} />
                  冻结当前版本
                </Button>
              </div>
            </div>
            {!p.approved && (
              <p className="deliver-freeze-reason">
                冻结条件：五道人工复核全部签完（当前 {Object.keys(p.reviews).length} / 5）。
                0 / 5 也能导出草稿：10 种格式都能下载，文件都带「草稿」标识；签完并冻结后才转为「已复核设计数据」。
              </p>
            )}
          </div>
          <div className="notice wsv2-baseline-notice" data-fid="R-05">
            <FileText size={17} />
            <div><b>需求复核基线</b><span>冻结客户/渠道关系、图纸版本、空间确认、场景、产品与未决项，供项目负责人或复核人脱离群聊复核。</span><small>当前：{p.requirementsBaseline?.versions?.length || 0} 个版本 · {p.channelNameSnapshot ? `渠道：${p.channelNameSnapshot}` : "2C 直客"} · {p.firstOrder?.show ? "需首单资料" : "无需重复首单资料"}</small></div>
            <Button disabled={locked || busy} onClick={() => setModal("baseline")} fid="R-06"><FileText size={14}/>提交需求基线</Button>
          </div>
          <div id="wsv2-review" className={"review-summary " + (p.approved ? "approved" : "")} data-fid="R-07">
            <span className="review-icon">
              <ShieldCheck size={34} />
            </span>
            <div>
              <h3>
                {p.approved ? "设计数据已通过人工复核" : "当前版本为草稿"}
              </h3>
              <p>
                {p.isDemo
                  ? "此项目为内置示例，即使完成复核也不能转为正式数据。请新建真实项目。"
                  : "所有输出仅为设计交付文件，不能自动成为正式施工图或正式报价。"}
              </p>
              {!p.approved && (
                <p className="draft-export-note">
                  当前 {Object.keys(p.reviews).length} / 5 也可导出草稿：10 种格式都能下载，文件带「草稿」标识；
                  五道复核签完并冻结后才算「已复核设计数据」。
                </p>
              )}
            </div>
            <strong>
              {Object.keys(p.reviews).length}
              <span> / 5</span>
              <small>复核完成</small>
            </strong>
          </div>
          <div className="review-cards" data-fid="R-08">
            {/* 第 4 列＝前置条件：与后端复核门禁同口径。闸门不改（业务纪律），
                只把「先做什么」写在卡片上，免得签名被 422 拦下却不知道出路。 */}
            {[
              ["requirements", "需求复核", "资料完整、客户保护、范围与责任确认",
                "前置：补齐十项责任人与需求资料，并在上方「需求复核基线」提交一次基线"],
              ["layout", "布置复核", "墙体、门窗、房间名称、尺寸和楼层", ""],
              ["lighting", "灯光复核", "独立灯具、电源回路、智能场景与安装参数", ""],
              ["pricing", "价格复核", "实际采购、工程费用、准备金及增项取证",
                "前置：勾选纳入报价的灯具并逐项核实价格（待核实 ≤30% 且 ≤10 行，否则签名会被拦下）"],
              ["delivery", "交付复核", "交付文件、碰撞检查、安装调试与变更闭环",
                "前置：确认本次交付文件（图纸、清单、场景演示）齐全，且没有待确认的变更"],
            ].map(([key, title, desc, pre]) => (
              <div key={key} className={p.reviews[key] ? "done" : ""}>
                <div>
                  <span>
                    {p.reviews[key] ? (
                      <CheckCircle2 size={20} />
                    ) : (
                      <ShieldCheck size={20} />
                    )}
                  </span>
                  <h3>{title}</h3>
                </div>
                <p>{desc}</p>
                {!p.reviews[key] && pre && <small className="review-prereq">{pre}</small>}
                {!p.reviews[key] && p.invalidatedReviews?.[key] && (
                  <small className="review-invalidated" role="note">
                    原签名（{p.invalidatedReviews[key].reviewer || "复核人"}）已失效：
                    {p.invalidatedReviews[key].reason}
                  </small>
                )}
                {p.reviews[key] ? (
                  <small>
                    {p.reviews[key].reviewer} · {fmtDate(p.reviews[key].at)}
                  </small>
                ) : (
                  <Button
                    disabled={locked || busy}
                    title={
                      locked
                        ? "版本已冻结或归档，先新建可编辑版本再复核"
                        : busy
                          ? "正在保存或导出，稍后即可复核"
                          : ""
                    }
                    onClick={() => {
                      setModal("review:" + key);
                      setAck(false);
                      setReviewError("");
                    }} fid="R-09"
                  >
                    人工复核 <ArrowUpRight size={14} />
                  </Button>
                )}
              </div>
            ))}
          </div>
          {reviewError && reviewErrorKey === "pricing" && (
            <div className="notice error-banner pricing-gate" role="alert" data-fid="R-10">
              <AlertCircle size={17} />
              <div>
                <b>价格复核被拦下</b>
                <span>{reviewError}</span>
              </div>
              <Button onClick={() => setModal("price-batch")} fid="R-11">
                去批量核实 <ChevronRight size={14} />
              </Button>
            </div>
          )}
          <div id="wsv2-export" className="section-heading export-heading" data-fid="E-25">
            <h2>交付文件（10 种格式）</h2>
            {p.floors > 1 && (
              <select
                aria-label="导出图片楼层"
                value={floor}
                onChange={(e) => setFloor(+e.target.value)} data-fid="E-15"
              >
                {floorLevels(p.floors, p.basements).map((lv) => (
                  <option key={lv.value} value={lv.value}>
                    {lv.label} · 图片楼层
                  </option>
                ))}
              </select>
            )}
            <span className="subtle">
              {p.code} · V{String(p.version).padStart(2, "0")} ·{" "}
              {p.approved ? "已复核设计数据" : "所有文件含草稿标识"}
            </span>
            <button
              className="export-audience-chip"
              onClick={() => setModal("export")}
              title="在「导出交付文件」抽屉里切换交付对象" data-fid="E-16"
            >
              交付对象：
              {exportAudience === "owner"
                ? "给业主（含参考价）"
                : exportAudience === "site"
                  ? "给施工（不含价）"
                  : "内部版（含参考价）"}
              <ChevronRight size={13} />
            </button>
            <Button onClick={() => setModal("scene")} fid="E-17">
              <QrCode size={16} />
              手机打开场景
            </Button>
          </div>
          {cctChecklist("导出前")}
          <CircuitIssueList design={d} where="导出前" onLocate={locateFixture} blockedNote />
          <div className="export-grid" data-fid="E-13">
            {exportItems.map((e) => (
              <button
                key={e.fmt}
                disabled={busy}
                onClick={() => {
                  // R5：拦截档有回路问题时不下载，直接跳到第一条（后端同样会拦）。
                  const blocked = BLOCKED_EXPORTS.includes(e.fmt) ? circuitIssues(d) : [];
                  const f = blocked.length && d.fixtures.find((x) => x.id === blocked[0].fixtureIds[0]);
                  if (f) locateFixture(f);
                  else void download(e.fmt, exportAudience);
                }} data-fid={e.fid}
              >
                <span className={"export-icon " + e.fmt}>
                  <e.icon size={24} />
                </span>
                <div>
                  <h3>{e.title}</h3>
                  <p>{e.desc}</p>
                  <small>.{e.fmt.toUpperCase()}</small>
                  <small className="export-audience-note">
                    {exportAudience === "internal"
                      ? "内部版 · 含参考价"
                      : exportAudience === "owner"
                        ? "业主版 · 含参考价"
                        : "施工版 · 不含参考价"}
                  </small>
                  {BLOCKED_EXPORTS.includes(e.fmt) && circuitIssues(d).length > 0 && (
                    <small className="export-blocked">被 {circuitIssues(d).length} 条拦住</small>
                  )}
                </div>
                {busy ? (
                  <Loader2 className="spin" size={18} />
                ) : (
                  <Download size={18} />
                )}
              </button>
            ))}
          </div>
          <div className="notice">
            <AlertCircle size={17} />
            完整资料包包含结构化设计及生成文件，不含原始上传附件。完整迁移或灾备请复制本地
            data 目录。灯带按长度计算参考小计，所有数值仍需人工核验。
            给施工导出时金额字段一律为 0（价格状态「不含价（交付版）」）；给业主与内部版保留参考价（2026-10-23 老板拍板取消去价红线）。
          </div>
        </main>
      )}
      <footer className={shellV2 ? "studio-footer wsv2-hide" : "studio-footer"} data-fid="X-17">
        <span>
          <span className="live-dot" />
          本地工作空间 <i /> {d.rooms.length} 个空间 · {d.fixtures.filter(isSceneLight).length}{" "}
          盏灯具 · {d.scenes.length} 个情景
        </span>
        <span>
          V{p.version} / R{p.revision} <i />{" "}
          {p.approved ? "已复核设计数据" : "草稿 · 非施工图"} <i /> 工作台 v
          {health.version || __APP_VERSION__}
        </span>
      </footer>
      {modal === "files" && (
        <Modal
          title="图纸与底图"
          subtitle="导入图片 / PDF 后自动识别空间，DXF 只解析几何、房间名需人工；识别结果先核对空间、门窗与家具，确认后才进入画布。"
          onClose={() => setModal("")}
          wide fid="D-31"
        >
          <div className="level-settings">
            <label className="inline-field">
              地上层数
              <input
                type="number"
                min={1}
                max={200}
                value={levelAbove}
                aria-label="地上层数"
                onChange={(e) => setLevelAbove(+e.target.value)}
              />
            </label>
            <label className="inline-field">
              地下层数
              <input
                type="number"
                min={0}
                max={9}
                value={levelBasements}
                aria-label="地下层数"
                onChange={(e) => setLevelBasements(+e.target.value)}
              />
            </label>
            <Button
              disabled={busy || locked}
              onClick={saveLevels}
              title="加地下层时已有图纸与空间整体上移：原来的一层仍然是 1F；地下室不用负数，按 B1、B2 显示" fid="D-32"
            >
              <Layers3 size={14} />
              保存层数
            </Button>
            <span className="subtle">
              {levelSummary(levelAbove + levelBasements, levelBasements)}
              · 地下室记作 B1/B2，不用负数
            </span>
          </div>
          <div className="file-modal-actions">
            {p.floors > 1 && (
              <label
                className="inline-field"
                title="文件名写明了楼层的图纸会自动归层（如 1F 平面图.png、二层照明.dxf、地下一层.pdf），这里只作为兜底"
              >
                文件名未含楼层时按此落层
                <select
                  value={uploadFloor}
                  aria-label="图纸所属楼层"
                  onChange={(e) => setUploadFloor(+e.target.value)}
                >
                  {floorLevels(p.floors, p.basements).map((lv) => (
                    <option key={lv.value} value={lv.value}>
                      {lv.choice}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <Button
              variant="primary"
              disabled={busy || locked}
              onClick={() => uploadRef.current?.click()} fid="D-33"
            >
              <Upload size={16} />
              上传图纸
            </Button>
            <input
              ref={uploadRef}
              hidden
              multiple
              type="file"
              accept=".png,.jpg,.jpeg,.webp,.bmp,.tif,.tiff,.pdf,.dxf,.svg"
              onChange={(e) => {
                filesUpload(e.target.files, true, uploadFloor);
                e.target.value = "";
              }}
            />
            <span className="subtle">
              PNG / JPG / WebP / BMP / TIFF / PDF / DXF / SVG · 单文件 30 MB
            </span>
          </div>
          <div className="notice">
            <AlertCircle size={17} />
            上传后图纸作为画布底图，并只读取图上的空间名称文字：识别到什么空间就直接建立这些空间（别墅/复式/带地下室按文件名或所选楼层落层，地下室记作 B1/B2），不必再手输、也不需要框选边界。编号自带空间与位置（如 kc001 ＝ 客厅·茶几的 1 号灯），并据此自动同步标准情景。按文件名识别楼层：文件名里已写明楼层的图纸（1F 平面图.png、二层照明.dxf、地下一层.pdf、-2F.jpg）自动落层：写了地下层而项目还没设地下层时，会自动补齐地下层数（已有内容整体上移、标签不变，可在「楼层设置」核对）；判不出来时才用每张图纸旁的下拉框手选。PDF
            取第一页作底图，DXF 可解析基础几何。
          </div>
          <div className="file-list" data-fid="D-34">
            {p.files.map((f) => (
              <article key={f.id}>
                <button
                  className="file-thumb"
                  onClick={() => {
                    if (f.preview)
                      setRenderPreview(
                        `/api/projects/${id}/files/${f.id}?preview=true`,
                      );
                    else notify("DXF 可解析为结构化几何，暂无原图预览");
                  }}
                >
                  {f.preview ? (
                    <img
                      src={`/api/projects/${id}/files/${f.id}?preview=true${f.page > 1 ? `&page=${f.page}` : ""}`}
                      alt={f.name}
                    />
                  ) : (
                    <FileText size={30} />
                  )}
                </button>
                <div className="file-details">
                  <h3>{f.name}</h3>
                  <p>
                    {f.type} · {(f.size / 1024).toFixed(1)} KB ·{" "}
                    {f.pages
                      ? `${f.pages} 页（使用第 ${Number(f.page) || 1} 页）`
                      : f.dimensions?.join(" × ") || "矢量文件"}
                  </p>
                  {f.type === "PDF" && f.pages > 1 && (
                    <label className="inline-field">
                      使用页码
                      <select
                        value={Number(f.page) || 1}
                        aria-label="选择 PDF 页码"
                        disabled={busy || locked}
                        onChange={(e) => changePdfPage(f, +e.target.value)}
                      >
                        {Array.from({ length: f.pages }, (_, i) => (
                          <option key={i + 1} value={i + 1}>
                            第 {i + 1} 页
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <small>
                    {fmtDate(f.uploadedAt)}
                    {p.floors > 1
                      ? ` · ${floorLabel(fileFloors[f.id] ?? f.floor ?? 1, p.basements)}`
                      : ""}{" "}
                    · {f.status} · 置信度：不适用 · 需人工校正
                  </small>
                  <div className="file-recognize-row">
                    {p.floors > 1 && (
                      <label className="inline-field">
                        所属楼层
                        <select
                          value={fileFloors[f.id] ?? (Number(f.floor) || 1)}
                          aria-label="图纸所属楼层"
                          onChange={(e) => changeFileFloor(f, +e.target.value)}
                        >
                          {floorLevels(p.floors, p.basements).map((lv) => (
                            <option key={lv.value} value={lv.value}>
                              {lv.label}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    {floorTag(f)}
                    <Button
                      disabled={busy || locked || !f.preview}
                      title="只读这张图纸上的空间名称文字，并把识别到的空间建到该楼层"
                      onClick={() =>
                        run(async () => {
                          await flush();
                          let next = await api<Project>(
                            `/projects/${id}/files/${f.id}/recognize`,
                            {
                              method: "POST",
                              body: JSON.stringify({
                                floor: fileFloors[f.id] ?? f.floor ?? floor,
                                mode: "labels",
                              }),
                            },
                          );
                          const rec = next.recognition;
                          if (rec?.rooms?.length && !rec.applied) {
                            next = await api<Project>(
                              `/projects/${id}/recognition/apply`,
                              {
                                method: "POST",
                                body: JSON.stringify({ fileId: f.id }),
                              },
                            );
                          }
                          w.accept(next);
                          if (!noSmart) update((n) => ensurePanels(n, smart));
                          setModal("");
                          setTab("plan");
                        }, "已按图纸文字识别空间名称，并建到对应楼层")
                      } fid="D-35"
                    >
                      <Sparkles size={13} />
                      识别空间名称
                    </Button>
                  </div>
                  <div>
                    <Button
                      disabled={locked || !f.preview}
                      onClick={() => {
                        setModal("");
                        setBackground("");
                        update((n) => {
                          n.baseFileId = f.id;
                        });
                        if (f.floor) setFloor(Number(f.floor));
                        setTool("select");
                        setTab("plan");
                        notify(
                          `已设为底图${f.floor && p.floors > 1 ? `（${floorLabel(f.floor, p.basements)}）` : ""}；可直接布灯，编号自动带空间与位置（如 kc001），不需要框选空间`,
                        );
                      }} fid="D-36"
                    >
                      <Layers3 size={13} />
                      设为底图（可直接放灯）
                    </Button>
                    <a
                      href={`/api/projects/${id}/files/${f.id}`}
                      className="icon-btn"
                      title="下载原始文件" data-fid="D-37"
                    >
                      <Download size={15} />
                    </a>
                    <button
                      disabled={busy || locked}
                      className="icon-btn danger-text"
                      title="删除文件"
                      onClick={() => {
                        const fileId = f.id;
                        askDanger("删除此原始文件？", () => {
                          run(
                            () =>
                              operation(`/files/${fileId}`, undefined, "DELETE"),
                            "原图已删除",
                          );
                        }, "原图与本项目中的引用会被删除，已生成的设计对象保留。");
                      }} data-fid="D-38"
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                </div>
              </article>
            ))}
            {!p.files.length && (
              <div className="empty-state">
                <FileUp size={30} />
                <h3>导入你的第一张图纸</h3>
                <p>也可以关闭窗口，直接在画布中人工创建区域。</p>
              </div>
            )}
          </div>
          {currentRecognition && (
            <div
              className={
                "recognition-result " +
                (!currentRecognition.simulated &&
                currentRecognition.rooms.length
                  ? "detected"
                  : "")
              } data-fid="D-39"
            >
              <h3>
                <Layers3 size={17} />
                {currentRecognition.simulated
                  ? "模拟草稿 · 不代表原图识别"
                  : currentRecognition.provider === "ezdxf-basic"
                    ? "DXF 自动空间解析"
                    : currentRecognition.semantic?.provider === "external-vision"
                      ? "语义户型彩平识别"
                      : "原图空间边界草稿（非彩平图）"}
              </h3>
              <p className="recognition-filename">
                {p.files.find((f) => f.id === currentRecognition.fileId)?.name}
              </p>
              <p>
                {/* 后端原文写的是内部楼层序号「第 N 层」，显示时换成与顶部标签同源的 1F/B1 */}
                {(currentRecognition.message || "").replace(
                  /第\s*(\d+)\s*层/g,
                  (_m: string, n: string) => floorLabel(Number(n), p.basements || 0),
                )}
              </p>
              {currentRecognition.wallEvidence &&
                p.files.find((f) => f.id === currentRecognition.fileId)
                  ?.preview && (
                  <WallEvidenceReview
                    key={"wall-"+currentRecognition.recognitionId}
                    result={currentRecognition}
                    busy={busy || locked}
                    background={`/api/projects/${id}/files/${currentRecognition.fileId}?preview=true`}
                    onAnalyze={(exclusions) =>
                      run(async () => {
                        await operation(
                          `/files/${currentRecognition.fileId}/recognize`,
                          { exclusions },
                        );
                      }, "家具排除设置已保存，新草稿已生成；原有设计未覆盖")
                    }
                  />
                )}

              <div className="recognition-counts">
                <span>{currentRecognition.semantic?.provider === "external-vision" ? "语义空间待人工确认" : "仅几何边界，不含家具/用途语义"}</span>
                <span>{currentRecognition.rooms.length} 个候选空间</span>
                <span>
                  {currentRecognition.walls.length} 条 CAD / 墙体参考线
                </span>
                <span>置信度：未校准，不编造概率</span>
              </div>
              {!!currentRecognition.rooms.length && (
                <div className="recognition-preview">
                  <Plan
                    design={{
                      ...d,
                      rooms: currentRecognition.rooms,
                      walls: currentRecognition.walls,
                      openings: currentRecognition.openings,
                      texts: currentRecognition.texts,
                      fixtures: [],
                    }}
                    showFurniture={false}
                    showGrid={false}
                    showLights={false}
                    showSource
                    readonly
                    background={
                      p.files.find((f) => f.id === currentRecognition.fileId)
                        ?.preview
                        ? `/api/projects/${id}/files/${currentRecognition.fileId}?preview=true`
                        : undefined
                    }
                  />
                </div>
              )}
              {!!currentRecognition.rooms.length &&
                !currentRecognition.simulated && (
                  <RecognitionCompare
                    key={"compare-"+currentRecognition.recognitionId}
                    result={currentRecognition}
                    design={d}
                    basements={p.basements || 0}
                    busy={busy || locked}
                    background={
                      p.files.find((f) => f.id === currentRecognition.fileId)
                        ?.preview
                        ? `/api/projects/${id}/files/${currentRecognition.fileId}?preview=true`
                        : undefined
                    }
                    onReplace={(candidateId, roomId) =>
                      run(async () => {
                        await operation("/recognition/replace", {
                          fileId: currentRecognition.fileId,
                          recognitionId: currentRecognition.recognitionId,
                          candidateId,
                          roomId,
                          acknowledged: true,
                        });
                      }, "已替换所选房间边界并保存，灯具关联已保留；请重新复核")
                    }
                  />
                )}
              <p>待人工确认：{currentRecognition.unrecognized.join("、")}</p>
              {currentRecognition.semantic?.provider !== "external-vision" && (
                <p className="detected-room-note">这份结果只能帮助校核墙体和边界，不能用于自动彩平：它不理解床、沙发、餐桌、厨卫设备和图例。请配置语义户型接口后重新识别，或人工绘制/命名空间。</p>
              )}
              <Button
                disabled={
                  busy ||
                  locked ||
                  currentRecognition.applied ||
                  !!currentRecognition.replacements?.length ||
                  currentRecognition.semantic?.provider !== "external-vision" ||
                  !(currentRecognition.rooms.length || currentRecognition.walls.length)
                }
                onClick={() =>
                  run(async () => {
                    await operation("/recognition/apply", {
                      fileId: currentRecognition.fileId,
                    });
                    setModal("");
                    setTab("plan");
                  }, "识别草稿已追加，原设计已保留")
                } fid="D-40"
              >
                {currentRecognition.replacements?.length
                  ? "已部分替换，请继续逐空间替换"
                  : currentRecognition.applied
                    ? "语义彩平已显示在设计画布，可直接编辑"
                    : currentRecognition.semantic?.provider === "external-vision"
                      ? "应用语义彩平到编辑器"
                      : "需要语义户型接口后才能生成彩平"}
                <ChevronRight size={14} />
              </Button>
            </div>
          )}
        </Modal>
      )}
      {modal === "fixture" && selected && selection?.kind === "fixtures" && (
        <Modal
          title={`${selected.code} · 灯具配置`}
          subtitle="参数独立保存，关联产品不会合并不同位置的灯具。"
          onClose={() => setModal("")} fid="L-32"
        >
          <fieldset disabled={locked || busy}>
            {!isDecorativeLight(selected.type) && (
            <div className="ies-row">
              <b>IES 光度文件</b>
              <span>
                {selected.ies?.name
                  ? `已上传：${selected.ies.name}（预留：解析后自动按实测配光计算）`
                  : "未上传 · 当前按半角光束角理论值估算光斑"}
              </span>
              <Button disabled={locked || busy} onClick={() => iesRef.current?.click()} fid="L-33">
                <Upload size={14} /> 上传 IES
              </Button>
              <input
                ref={iesRef}
                type="file"
                accept=".ies"
                hidden
                onChange={(e) => {
                  uploadIes(e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
            </div>
            )}
            <FixtureFields
              fixture={selected}
              rooms={d.rooms}
              products={products}
              smart={p.smart}
              patch={patch}
              applyProduct={(prod) =>
                update((n) => {
                  const f = n.fixtures.find((f) => f.id === selected.id)!;
                  applyProductToFixture(f, prod);
                  if (f.type === "灯带") {
                    f.powerSupply = "PS-" + f.code;
                    f.controller = "CTL-" + f.code;
                  }
                  n.scenes.forEach((s) => {
                    if (s.states[f.id])
                      s.states[f.id].cct = Math.min(
                        f.cctMax,
                        Math.max(f.cctMin, s.states[f.id].cct),
                      );
                  });
                })
              }
            />
          </fieldset>
          <div className="modal-foot">
            <Button disabled={locked} onClick={copySelected} fid="L-34">
              <Copy size={14} />
              复制灯具
            </Button>
            <Button
              disabled={
                locked ||
                !lampClipboard ||
                (clipKind !== "fixtures" && clipKind !== "devices")
              }
              onClick={pasteFixture} fid="L-35"
            >
              <Copy size={14} />
              {clipKind === "devices" ? "粘贴设备" : "粘贴灯具"}
            </Button>
            <Button
              variant="primary"
              onClick={() =>
                run(async () => {
                  await flush();
                  setModal("");
                }, "灯具参数已保存")
              }
              disabled={busy} fid="L-36"
            >
              保存并关闭
            </Button>
          </div>
        </Modal>
      )}
      {modal === "place" && (
        <Modal
          title="布灯 · 选择编号"
          subtitle="编号 = 空间码 + 位置码 + 职能码 + 序号，例如 kcA001 ＝ 客厅·茶几·氛围灯 1 号；确认后自动编号并按「空间×职能×位置」同步标准情景。"
          onClose={closePlace} fid="L-37"
        >
          <p className="field-hint">
            {placePoint
              ? `落点已选：X ${placePoint.x} · Y ${placePoint.y}；灯就放在图纸上点选的位置（数量 > 1 时围绕落点排布）。`
              : "还没选落点：关闭后重新点「放置灯具」，在图纸上点一下要放灯的位置。"}
            位置按空间取表：{lampSpaceName}＝
            {lampPositions.flatMap((g) => g.positions).slice(0, 10).map((p) => p.name).join("、")}
            {lampPositions.flatMap((g) => g.positions).length > 10 ? " 等" : ""}；
            换空间时位置自动换成该空间的家具与功能位。
          </p>
          <div className="form-grid">
            <Field label="空间">
              {placeRooms.length ? (
                <select
                  value={lampRoomId}
                  aria-label="布灯空间"
                  onChange={(e) => {
                    setLampRoomId(e.target.value);
                    const meta = roomSpaceCodeOf(
                      d?.rooms.find((r) => r.id === e.target.value),
                    );
                    if (meta) selectPlaceSpace(meta.code);
                  }}
                >
                  {placeRooms.map((r) => {
                    const meta = roomSpaceCodeOf(r);
                    return (
                      <option key={r.id} value={r.id}>
                        {r.name}
                        {meta ? ` · ${meta.code}` : ""}
                      </option>
                    );
                  })}
                </select>
              ) : (
                <select
                  value={lampSpace}
                  aria-label="布灯空间"
                  onChange={(e) => {
                    setLampRoomId("");
                    selectPlaceSpace(e.target.value);
                  }}
                >
                  {GROUPED_SPACES.map((g) => (
                    <optgroup key={g.group} label={g.group}>
                      {g.spaces.map((item) => (
                        <option key={item.code} value={item.code}>
                          {item.code} · {item.name}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              )}
            </Field>
            <Field label="位置">
              <select
                value={lampPosition}
                aria-label="布灯位置"
                onChange={(e) => {
                  setLampPosition(e.target.value);
                  // 职能随位置给默认值：位置变了就把职能带回该位置的常规用法（按该空间的位置表）。
                  setLampRole(defaultRoleForPosition(lampSpaceCode, e.target.value) || lampRole);
                }}
              >
                {lampPositions.map((g) => (
                  <optgroup key={g.group} label={`${lampSpaceName} · ${g.group}`}>
                    {g.positions.map((item) => (
                      <option key={item.code} value={item.code}>
                        {item.code} · {item.name}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </Field>
            <Field label="职能（场景钩子）">
              <select
                value={lampRole}
                aria-label="布灯职能"
                onChange={(e) => setLampRole(e.target.value)}
              >
                {ROLE_CODES.map((item) => (
                  <option key={item.code} value={item.code}>
                    {item.code} · {item.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="类型">
              <select
                value={lampType}
                aria-label="灯具类型"
                onChange={(e) => setLampType(e.target.value)}
              >
                {lightTypes.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="光源类型">
              <select
                value={lampColorMode}
                aria-label="光源类型"
                onChange={(e) => setLampColorMode(e.target.value as ColorMode)}
              >
                {COLOR_MODES.map((m) => (
                  <option key={m} value={m}>
                    {m}
                    {m === "单色" ? "（固定色温）" : m === "双色" ? "（可调色温）" : "（RGB 彩色）"}
                  </option>
                ))}
              </select>
            </Field>
            {lampColorMode === "单色" && (
              <Field label="色温 K">
                <select
                  value={lampSingleCct}
                  aria-label="单色色温"
                  onChange={(e) => setLampSingleCct(+e.target.value)}
                >
                  {SINGLE_CCT_OPTIONS.map((k) => (
                    <option key={k} value={k}>
                      {k} K{k === SINGLE_CCT_DEFAULT ? "（默认）" : ""}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {lampNeedsReason && (
              <Field label="偏离 3000K 单色的原因（必填）">
                <input
                  value={lampCctReason}
                  aria-label="色温原因"
                  aria-required="true"
                  placeholder="如：业主要求可调色温 / 卫生间镜前需 4000K"
                  onChange={(e) => setLampCctReason(e.target.value)}
                />
              </Field>
            )}
            <Field label="数量">
              <input
                type="number"
                min={1}
                max={40}
                value={lampCount}
                aria-label="布灯数量"
                onChange={(e) => setLampCount(Math.max(1, +e.target.value))}
              />
            </Field>
            <Field label="编号预览">
              <input
                readOnly
                value={buildFixtureCode(
                  lampSpaceCode,
                  lampPosition,
                  nextSerial(d?.fixtures || [], lampSpaceCode, lampPosition, lampRole),
                  lampRole,
                )}
              />
            </Field>
            <p className="field-hint">
              {describeFixtureCode(
                buildFixtureCode(
                  lampSpaceCode,
                  lampPosition,
                  nextSerial(d?.fixtures || [], lampSpaceCode, lampPosition, lampRole),
                  lampRole,
                ),
              )}
            </p>
          </div>
          <p className="subtle">
            编号 = 空间 + 位置 + 职能 + 序号（{ROLE_CODES.map((r) => r.code).join("/")} 为职能位）；
            场景按「空间 × 职能 × 位置」自动推导，不用逐个情景手调。放置后可在画布上拖动定位，
            光束角、安装高度与编号可在「灯具配置」里微调。
            默认单色 3000K，改双色 / 彩色 / 其他色温需写原因（导出清单「原因」列）；彩色律动只在游戏室（电竞房）情景里生效。
            {lampColorMode === "单色"
              ? `单色光源固定 ${lampSingleCct}K，不参与调色温；`
              : lampColorMode === "双色"
                ? `双色光源默认 ${DUAL_CCT_MIN_DEFAULT}K–${DUAL_CCT_MAX_DEFAULT}K，可在灯具配置里手动改；`
                : "彩色光源为 RGB / RGBW，可另配白光通道色温与色相；"}
            灯带同样可选单色 / 双色 / 彩色。
          </p>
          <div className="modal-foot">
            <Button onClick={closePlace}>取消</Button>
            <Button
              variant="primary"
              disabled={locked || (lampNeedsReason && !lampCctReason.trim())}
              title={lampNeedsReason && !lampCctReason.trim() ? "请先填写偏离 3000K 单色的原因" : undefined}
              onClick={() => {
                placeLamps(lampCount);
                // W-1：不走 closePlace()（它会把 tool 打回 select）。只关弹窗、清落点，保持布灯模式好连点。
                setModal("");
                setPlacePoint(null);
              }} fid="L-38"
            >
              <Plus size={15} /> 确认布灯
            </Button>
          </div>
        </Modal>
      )}
      {addObject && placePoint && (
        <Modal
          title={addObject === "curtain" ? "添加窗帘 · 确认布置" : "添加设备 · 确认类型与空间"}
          subtitle={`楼层跟随当前页（${floorLabel(floor, p.basements || 0)}）；空间已按落点自动选中，仍可手动改。`}
          onClose={exitAddMode} fid="L-39"
        >
          <div className="form-grid">
            {addObject === "device" ? (
              <>
                <Field label="设备类型">
                  <select
                    value={addType}
                    aria-label="设备类型"
                    onChange={(e) => {
                      setAddType(e.target.value);
                      setAddName(DEFAULT_DEVICE_NAME[e.target.value] || "");
                    }}
                  >
                    {DEVICE_TYPES.map((t) => (
                      <option key={t}>{t}</option>
                    ))}
                  </select>
                </Field>
                <Field label="设备名称">
                  <input
                    aria-label="设备名称"
                    value={addName}
                    placeholder={DEFAULT_DEVICE_NAME[addType] || "设备名称"}
                    onChange={(e) => setAddName(e.target.value)}
                  />
                </Field>
              </>
            ) : (
              <Field label="电机">
                <select
                  value={addMotor}
                  aria-label="窗帘电机"
                  onChange={(e) => setAddMotor(e.target.value)}
                >
                  <option>单电机</option>
                  <option>双电机</option>
                </select>
              </Field>
            )}
            <Field label="空间">
              {placeRooms.length ? (
                <select
                  value={addRoomId}
                  aria-label="添加对象空间"
                  onChange={(e) => {
                    setAddRoomId(e.target.value);
                    const rm = (d?.rooms || []).find((r) => r.id === e.target.value);
                    const code = (rm ? roomSpaceCodeOf(rm)?.code : "") || "x";
                    if (!positionsForSpace(code).some((p) => p.code === addPositionCode)) {
                      setAddPositionCode("");
                    }
                  }}
                >
                  {placeRooms.map((r) => {
                    const meta = roomSpaceCodeOf(r);
                    return (
                      <option key={r.id} value={r.id}>
                        {r.name}
                        {meta ? ` · ${meta.code}` : ""}
                      </option>
                    );
                  })}
                </select>
              ) : (
                <input
                  readOnly
                  value={`本层还没有空间：请先添加 / 导入空间（${floorLabel(floor, p.basements || 0)}）`}
                />
              )}
            </Field>
          </div>
          {addObject === "device" && (
            <Field label={`位置（${addSpaceName}的家具/功能位）`}>
              <select
                value={addPositionCode}
                aria-label="设备位置"
                onChange={(e) => setAddPositionCode(e.target.value)}
              >
                <option value="">不指定位置</option>
                {addPositions.map((g) => (
                  <optgroup key={g.group} label={g.group}>
                    {g.positions.map((item) => (
                      <option key={item.code} value={item.code}>
                        {item.code} · {item.name}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </Field>
          )}
          <p className="subtle">
            落点已选：X {placePoint.x} · Y {placePoint.y}；新{addObject === "curtain" ? "窗帘" : "设备"}就放在图纸上点选的位置
            （{floorLabel(floor, p.basements || 0)}），空间已按落点自动选中。放置后仍可在画布上拖动定位，
            属性在「灯具配置 / 智能设备」里微调。
          </p>
          <div className="modal-foot">
            <Button onClick={exitAddMode}>取消</Button>
            <Button
              variant="primary"
              disabled={locked}
              onClick={() => {
                if (addObject === "curtain") {
                  placeCurtain();
                  exitAddMode();
                  return;
                }
                // F6（批 5）：加设备确认后只关对话框、清落点、保模式好连加（同 7728 布灯 W-1）；窗帘照旧退出。
                placeDevice();
                setPlacePoint(null);
              }} fid="L-40"
            >
              <Plus size={15} /> {addObject === "curtain" ? "确认添加窗帘" : "确认添加设备"}
            </Button>
          </div>
        </Modal>
      )}
      {modal === "baseline" && (
        <Modal title="提交需求复核基线" subtitle="生成一个可审计版本；不替代后续人工复核。" onClose={() => setModal("")} fid="R-19">
          <div className="notice amber"><FileText size={17}/>将记录当前客户/渠道关系、原始图纸、空间确认状态、灯具数量和场景清单。</div>
          <Field label="提交人 *"><input value={reviewer} onChange={(e) => setReviewer(e.target.value)} placeholder="请输入提交人姓名" /></Field>
          <Field label="沟通纪要 / 未决项"><textarea value={baselineNote} onChange={(e) => setBaselineNote(e.target.value)} placeholder="例如：客户确认的重点、预算约束、待确认事项及附件来源" /></Field>
          <div className="modal-foot"><Button onClick={() => setModal("")}>取消</Button><Button variant="primary" disabled={!reviewer.trim() || busy} onClick={() => run(async () => { await operation("/requirements-baselines", {submitter: reviewer, evidence: {notes: baselineNote}}); setBaselineNote(""); setModal(""); }, "需求复核基线已冻结为新版本")} fid="R-14"><FileText size={15}/>提交基线</Button></div>
        </Modal>
      )}
      {modal === "export" && (
        <Modal
          title="导出交付文件"
          subtitle="先选交付对象，再点格式下载。草稿也能导出（文件带「草稿」标识）；给施工的金额字段一律为 0，给业主与内部版保留参考价。"
          onClose={() => setModal("")}
          wide fid="E-18"
        >
          <div className="export-audience-pick" role="radiogroup" aria-label="交付对象" data-fid="E-12">
            {([
              ["owner", "给业主", "外发业主：含零售价（2026-10-23 老板拍板取消去价红线）"],
              ["site", "给施工（不含价）", "给施工 / 电工：点位、回路、数量，金额全部去价"],
              ["internal", "内部版（含参考价）", "仅内部核对：Excel 等保留参考价，不要外发"],
            ] as const).map(([value, label, desc]) => (
              <button
                key={value}
                role="radio"
                aria-checked={exportAudience === value}
                className={"export-audience-option" + (exportAudience === value ? " on" : "")}
                onClick={() => setExportAudience(value)}
              >
                <b>{label}</b>
                <small>{desc}</small>
              </button>
            ))}
          </div>
          <div className="notice">
            <AlertCircle size={17} />
            <div>
              <b>价格口径</b>
              <span>
                选「给施工（不含价）」时，导出的单价 / 小计 / 合计等金额字段 = 0，价格状态标「不含价（交付版）」；
                「给业主」与「内部版」保留参考价（2026-10-23 老板拍板取消零售价去价红线）。完整资料包（ZIP）里的文件跟随同一交付对象。
              </span>
            </div>
          </div>
          <div className="export-grid export-grid-drawer" data-fid="E-14">
            {exportItems.map((e) => (
              <button
                key={e.fmt}
                disabled={busy}
                title={
                  busy
                    ? "正在导出上一个文件，完成后即可继续"
                    : `按「${
                        exportAudience === "owner"
                          ? "给业主（含参考价）"
                          : exportAudience === "site"
                            ? "给施工（不含价）"
                            : "内部版（含参考价）"
                      }」导出 ${e.title}`
                }
                onClick={() => exportWithAudience(exportAudience, e.fmt)} data-fid={e.fid}
              >
                <span className={"export-icon " + e.fmt}>
                  <e.icon size={24} />
                </span>
                <div>
                  <h3>{e.title}</h3>
                  <p>{e.desc}</p>
                  <small>.{e.fmt.toUpperCase()}</small>
                  {exportAudience === "site" && (
                    <small className="export-audience-note">施工版 · 金额列=0</small>
                  )}
                </div>
                {busy ? <Loader2 className="spin" size={18} /> : <Download size={18} />}
              </button>
            ))}
          </div>
          {exportAudience === "internal" && (
            <p className="export-internal-warn" data-fid="E-19">
              内部版含零售参考价：只在本机核对用，不要直接转发业主或施工方。
            </p>
          )}
          <div className="modal-foot">
            <Button onClick={() => setModal("")}>关闭</Button>
          </div>
        </Modal>
      )}
      {modal === "price-batch" && (
        <Modal
          title="批量核实价格"
          subtitle="标记「价格已人工核实」只记录核实状态，不修改单价；核实后回到价格复核重新签名。"
          onClose={() => setModal("")}
          wide fid="R-15"
        >
          <div className="notice amber">
            <ShieldCheck size={17} />
            <div>
              <b>
                已纳入报价 {pricedFixtures.length} 项，待核实 {unverifiedFixtures.length} 项
                （{Math.round(pricingRiskRatio * 100)}%）。
              </b>
              <span>
                后端规则：待核实 &gt;30% 或 &gt;10 行会被拦下；阈值内的签名会记录实名、时间、设计 hash
                与未核实行清单，事后可核。
              </span>
            </div>
          </div>
          <div className="price-batch-actions">
            <span>请对照实物 / 供货价 / 产品资料逐项确认后再勾选，批量标记也一样要真核过。</span>
            <Button
              disabled={locked || busy || !unverifiedFixtures.length}
              title={
                locked
                  ? "版本已冻结或归档，先新建可编辑版本"
                  : !unverifiedFixtures.length
                    ? "纳价灯具都已标记为已核实"
                    : "把全部纳入报价的灯具标为「价格已人工核实」"
              }
              onClick={markAllPricesVerified} fid="R-16"
            >
              <CheckCircle2 size={15} />
              全部标记为已核实
            </Button>
          </div>
          <div className="price-batch-list">
            {pricedFixtures.length ? (
              pricedFixtures.map((f: Obj) => (
                <label key={f.id} className={"price-batch-row" + (f.priceVerified ? " ok" : "")}>
                  <input
                    type="checkbox"
                    checked={!!f.priceVerified}
                    disabled={locked || busy}
                    onChange={(e) =>
                      update((n) => {
                        const t = (n.fixtures || []).find((x: Obj) => x.id === f.id);
                        if (t) t.priceVerified = e.target.checked;
                      })
                    }
                  />
                  <span className="price-batch-code">{f.code || "未编号"}</span>
                  <span className="price-batch-name">
                    {f.name || f.model || "灯具"}
                    <small>
                      {(d.rooms || []).find((r: Obj) => r.id === f.roomId)?.name || "未分配空间"} ·{" "}
                      {f.circuit || "未分配回路"}
                    </small>
                  </span>
                  <span className="price-batch-price">
                    ¥ {Number(f.price || 0).toFixed(2)}
                    {f.type === "灯带" ? " /m" : ""}
                  </span>
                  <span className={"badge " + (f.priceVerified ? "green" : "amber")}>
                    {f.priceVerified ? "已核实" : "待核实"}
                  </span>
                </label>
              ))
            ) : (
              <p className="subtle">还没有纳入报价的灯具：先到灯具清单里勾选「纳入报价」。</p>
            )}
          </div>
          <div className="modal-foot">
            <Button onClick={() => { setReviewError(""); setModal("review:pricing"); }} fid="R-17">返回价格复核</Button>
            <Button
              variant="primary"
              disabled={busy}
              onClick={async () => {
                await flush();
                setReviewError("");
                setModal("review:pricing");
                notify("价格核实状态已保存，可以重新签名价格复核");
              }} fid="R-18"
            >
              保存并返回价格复核
            </Button>
          </div>
        </Modal>
      )}
      {modal.startsWith("review:") && (
        <Modal
          title="人工复核确认"
          subtitle="复核责任将与当前设计修订一同记录。"
          onClose={() => setModal("")} fid="R-12"
        >
          <div className="notice amber">
            <ShieldCheck size={18} />
            请实际检查对应项目内容。点击确认不是自动核验，也不替代专业电气与施工复核。
          </div>
          {reviewError && reviewErrorKey === modal.split(":")[1] && (
            <div className="notice error-banner review-gate-error" role="alert">
              <AlertCircle size={17} />
              <div>
                <b>复核被拦下</b>
                <span>{reviewError}</span>
              </div>
              {/核实|报价|价格/.test(reviewError) && (
                <Button onClick={() => setModal("price-batch")}>
                  去批量核实 <ChevronRight size={14} />
                </Button>
              )}
            </div>
          )}
          <Field label="复核人姓名 *">
            <input
              value={reviewer}
              onChange={(e) => setReviewer(e.target.value)}
              placeholder="请输入实际复核人姓名" data-fid="R-20"
            />
          </Field>
          <label className="check-label">
            <input
              type="checkbox"
              checked={ack}
              onChange={(e) => setAck(e.target.checked)}
            />
            我已人工核对本项内容，理解草稿、示例与正式交付数据的区别。
          </label>
          <div className="modal-foot">
            <Button onClick={() => setModal("")}>取消</Button>
            <Button
              variant="primary"
              disabled={!ack || !reviewer.trim() || busy}
              title={
                !ack
                  ? "请先勾选「我已人工核对本项内容」"
                  : !reviewer.trim()
                    ? "请填写复核人姓名"
                    : busy
                      ? "正在保存，稍后即可提交"
                      : ""
              }
              onClick={() => submitReview(modal.split(":")[1])} fid="R-13"
            >
              <ShieldCheck size={15} />
              确认复核
            </Button>
          </div>
        </Modal>
      )}
      {modal === "scene" && (
        <Modal
          title="把灯光演示交付给业主"
          subtitle="推荐发「业主版 HTML」文件：单个文件、离线可用，业主在手机或电脑上打开就能点情景触发、切楼层、看灯具分组；同 WiFi 下也可扫码直接看"
          onClose={() => setModal("")} fid="E-20"
        >
          <div className="scene-share">
            <img
              className="scene-qr"
              src={`/api/qrcode?text=${encodeURIComponent(
                `${window.location.origin}/api/projects/${id}/scene`
              )}`}
              alt="智能场景二维码" data-fid="E-21"
            />
            <div className="scene-share-meta">
              <p>
                <b>推荐：</b>把「业主版灯光演示 HTML」文件（复核与交付 / 一键导出）直接发给业主，
                不需要服务器、不需要同一网络，微信/邮件发过去点开就能看。
                页面上点情景按钮即触发（传感器 / 定时情景也保留手动触发），
                电梯/楼上楼下可切换楼层，点右上角「灯具分组」能看到每盏灯属于哪一组。
              </p>
              <p>
                <b>同 WiFi 现场演示：</b>也可以让业主在店里扫下面二维码直接看（此时用的是局域网地址，离开这个网络就打不开了）。
              </p>
              <code className="scene-url" data-fid="E-24">{`${window.location.origin}/api/projects/${id}/scene`}</code>
              <div className="scene-share-actions">
                <Button
                  onClick={() => {
                    const t = `${window.location.origin}/api/projects/${id}/scene`;
                    // 统一走 writeClipboard：复制完把焦点还给原按钮，复制失败如实提示。
                    writeClipboard(t).then((ok) =>
                      notify(ok ? "链接已复制" : "复制失败：请手动选中链接复制"),
                    );
                  }} fid="E-22"
                >
                  <Copy size={15} />
                  复制链接
                </Button>
                <a href={`/api/projects/${id}/scene`} target="_blank" rel="noreferrer" data-fid="E-23">
                  <Button>
                    <ArrowUpRight size={15} />
                    直接打开
                  </Button>
                </a>
              </div>
            </div>
          </div>
        </Modal>
      )}
      {modal === "spaces" && (
        <Modal
          title="管理空间"
          subtitle="选择本项目有哪些空间；新增空间后，布灯编号直接按空间码生成。"
          onClose={() => setModal("")}
          wide fid="P-15"
        >
          <div className="space-groups">
            <div className="space-filter">
              <input
                value={spaceQuery}
                placeholder="搜索空间名 / 空间码 / 图纸别名"
                aria-label="搜索空间"
                onChange={(e) => setSpaceQuery(e.target.value)}
              />
              <label className="space-typical-toggle">
                <input
                  type="checkbox"
                  checked={spaceTypical}
                  onChange={(e) => setSpaceTypical(e.target.checked)}
                />
                只看「{p?.type || "平层"}」常规空间
              </label>
            </div>
            {spaceGroupsShown.map((g) => {
              const picked = g.spaces.filter((s) =>
                (d?.rooms || []).some((r) => roomSpaceCodeOf(r)?.code === s.code),
              ).length;
              return (
                <div className="space-group" key={g.group}>
                  <h4>
                    {g.group}
                    <span className="space-group-meta">
                      {picked}/{g.spaces.length} 已选
                    </span>
                  </h4>
                  <div className="space-manager">
                    {g.spaces.map((s) => {
                      const count = (d?.rooms || []).filter(
                        (r) => roomSpaceCodeOf(r)?.code === s.code,
                      ).length;
                      return (
                        <div
                          key={s.code}
                          className={"space-chip " + (count ? "on" : "")}
                          title={`${s.code} · ${s.name}${s.note ? "｜" + s.note : ""}`}
                        >
                          <b>{s.code}</b> · {s.name}
                          <span className="space-count">
                            {count ? `已有 ${count}` : "未选"}
                          </span>
                          <button
                            className="mini-btn"
                            disabled={locked}
                            title={`再新增一个「${s.name}」`}
                            onClick={() => addSpaceByCode(s.code)}
                          >
                            ＋
                          </button>
                          <button
                            className="mini-btn"
                            disabled={locked || !count}
                            title={`移除最后一个「${s.name}」`}
                            onClick={() => removeLastSpaceOfCode(s.code)}
                          >
                            －
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
            {!spaceGroupsShown.length && (
              <p className="subtle">
                没有匹配的空间：换个关键词，或取消「只看常规空间」。
              </p>
            )}
            <p className="subtle">
              同类空间可以有多个：三室的第二个次卧、别墅的多个入户都会自动编号（次卧 2、门厅 2…），
              各自的灯具与情景分别统计。
            </p>
          </div>
        </Modal>
      )}
      {addSpaceOpen && (
        <Modal
          title="新增空间"
          subtitle="先选分区，再选房间；同一分区连续新增时直接落到房间屏。空间不需要画边界，编号与情景按空间码生成。"
          onClose={() => setAddSpaceOpen(false)} fid="P-28"
        >
          {addSpaceActive ? (
            <>
              <div className="add-space-head">
                <button
                  className="mini-btn"
                  title="返回分区列表"
                  onClick={() => setAddSpaceGroup("")}
                >
                  ←
                </button>
                <b>{addSpaceActive.group}</b>
                <span className="subtle">本分区 {addSpaceActive.spaces.length} 间</span>
              </div>
              <div className="add-space-rows">
                {addSpaceActive.spaces.map((sc) => {
                  const count = (d?.rooms || []).filter(
                    (r) => roomSpaceCodeOf(r)?.code === sc.code,
                  ).length;
                  return (
                    <button
                      key={sc.code}
                      className="add-space-row"
                      disabled={locked}
                      onClick={() => {
                        addSpaceByCode(sc.code);
                        setAddSpaceOpen(false);
                      }}
                    >
                      <span className="nm">{sc.name}</span>
                      <span className="ct">{count ? `已有 ${count} · 再加一间` : "未选"}</span>
                    </button>
                  );
                })}
              </div>
            </>
          ) : (
            <>
              {!addSpaceHouse && (
                <p className="subtle" style={{ margin: "0 0 8px" }}>
                  未填户型，显示全部分区
                </p>
              )}
              <div className="add-space-rows">
                {addSpaceGroups.map((g) => (
                  <button
                    key={g.group}
                    className="add-space-row"
                    onClick={() => setAddSpaceGroup(g.group)}
                  >
                    <span className="nm">{g.group}</span>
                    <span className="ct">{g.spaces.length} 间</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </Modal>
      )}
      {modal === "scene-setup" && (
        <Modal
          title="一键设置场景"
          subtitle="按房型与空间筛出本项目用得上的情景，一次套用；用不上的场景不会铺进项目。"
          onClose={() => setModal("")}
          wide fid="C-20"
        >
          <div className="setup-summary">
            <span className="setup-pill">房型 · {p.type}</span>
            <span className="setup-pill">
              本项目空间 ·{' '}
              {projectSpaces.length
                ? projectSpaces.map((s) => s.name).join("、")
                : "未选（按房型默认）"}
            </span>
            <span className="setup-pill ok">可用 · {usableScenes.length} 个</span>
            <span className="setup-pill muted">已筛掉 · {unusableScenes.length} 个</span>
          </div>

          <div className="setup-group">
            <h4>基础情景（固定写入）</h4>
            <div className="setup-items">
              <span className="setup-item fixed">
                <b>00.1</b> 全开
              </span>
              <span className="setup-item fixed">
                <b>00.2</b> 全关
              </span>
            </div>
          </div>

          {Array.from(new Set(usableScenes.map((s) => sceneHomeSpaceName(s)))).map(
            (space) => (
              <div className="setup-group" key={space}>
                <h4>{space}</h4>
                <div className="setup-items">
                  {usableScenes
                    .filter((s) => sceneHomeSpaceName(s) === space)
                    .map((s) => (
                      <button
                        key={s.code}
                        className={
                          "setup-item " +
                          (setupSel.includes(s.code) ? "on" : "")
                        }
                        disabled={locked}
                        onClick={() => toggleSetupScene(s.code)}
                      >
                        <b>{s.code}</b> {s.name}
                      </button>
                    ))}
                </div>
              </div>
            ),
          )}

          {unusableScenes.length > 0 && (
            <details className="setup-excluded">
              <summary>
                已按房型 / 空间筛掉 {unusableScenes.length}{' '}
                个用不上的场景（点开查看）
              </summary>
              <div className="setup-items">
                {unusableScenes.map((s) => (
                  <span className="setup-item muted" key={s.code}>
                    <b>{s.code}</b> {s.name}
                    <small>· {sceneHomeSpaceName(s)}</small>
                  </span>
                ))}
              </div>
            </details>
          )}

          <div className="setup-actions">
            <label className="setup-check">
              <input
                type="checkbox"
                checked={setupClear}
                onChange={(e) => setSetupClear(e.target.checked)}
              />
              套用前清空现有情景
            </label>
            <div className="flex">
              <button
                className="mini-btn"
                disabled={locked}
                onClick={() => setSetupSel(usableScenes.map((s) => s.code))} data-fid="C-24"
              >
                全选
              </button>
              <button
                className="mini-btn"
                disabled={locked}
                onClick={() => setSetupSel([])} data-fid="C-25"
              >
                清空
              </button>
            </div>
          </div>

          <div className="file-modal-actions">
            <Button
              disabled={locked}
              onClick={() => {
                setModal("");
                writeScenePackage();
              }} fid="C-22"
            >
              写入全部 43 场景
            </Button>
            <Button
              disabled={locked}
              onClick={() => {
                setModal("");
                presets();
              }} fid="C-23"
            >
              写入标准化场景
            </Button>
            <Button
              variant="primary"
              disabled={locked}
              onClick={applySceneSetup} fid="C-21"
            >
              <Sun size={15} />
              套用 {setupSel.length} 个可用场景
            </Button>
          </div>
        </Modal>
      )}
      {modal === "history" && (
        <Modal
          title="版本与操作记录"
          subtitle="每次保存保留快照；恢复历史将创建新版本，不会覆盖历史。"
          onClose={() => setModal("")}
          wide fid="P-25"
        >
          <div className="file-modal-actions">
            <Button
              variant="primary"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await operation("/versions");
                  setModal("");
                }, "新版本已建立，项目编号保持不变")
              } fid="P-26"
            >
              <Plus size={15} />
              新建版本
            </Button>
            <span className="subtle">
              当前 V{p.version} / R{p.revision}
            </span>
          </div>
          <div className="history-grid">
            <section>
              <h3>设计快照</h3>
              {versions.map((v) => (
                <div className="version-row" key={v.id}>
                  <span>
                    <b>
                      V{v.version} / R{v.revision}
                    </b>
                    <small>
                      {v.note} · {fmtDate(v.created_at)}
                    </small>
                  </span>
                  <Button
                    disabled={busy}
                    onClick={() => {
                      const versionId = v.id;
                      askDanger("以此历史设计创建新版本？", () => {
                        run(async () => {
                          await operation(`/versions/${versionId}/restore`);
                          setModal("");
                        }, "历史设计已恢复为新版本");
                      }, "当前设计会保留在历史快照中，不会被覆盖。");
                    }} fid="P-27"
                  >
                    恢复
                  </Button>
                </div>
              ))}
            </section>
            <section>
              <h3>最近操作</h3>
              {events.map((e) => (
                <div className="event-row" key={e.id}>
                  <Clock3 size={14} />
                  <span>
                    <b>{e.action}</b>
                    <small>
                      {e.detail || "项目操作"}
                      <br />
                      {fmtDate(e.at)}
                    </small>
                  </span>
                </div>
              ))}
            </section>
          </div>
        </Modal>
      )}
      {busy && (
        <div className="busy-shield" role="status" data-fid="X-06">
          <span>
            <Loader2 className="spin" size={20} />
            正在上传 / 分析或保存，请稍候…
          </span>
        </div>
      )}
      {renderPreview && (
        <Modal
          title="图像预览"
          subtitle="示意图及识别输入均不能直接作为施工依据。"
          onClose={() => setRenderPreview("")}
          wide fid="V-11"
        >
          <img className="full-preview" src={renderPreview} alt="图像预览" />
        </Modal>
      )}
      {dangerAsk && (
        <div className="confirm-modal-mask" role="dialog" aria-modal="true" aria-labelledby="confirm-modal-title" data-fid="X-03">
          <div className="confirm-modal" role="document">
            <div className="confirm-modal-head">
              <span className="confirm-modal-icon"><AlertCircle size={18} /></span>
              <h3 id="confirm-modal-title">{dangerAsk.title}</h3>
            </div>
            {dangerAsk.detail && <p className="confirm-modal-detail">{dangerAsk.detail}</p>}
            <div className="confirm-modal-actions">
              <button className="btn" onClick={() => setDangerAsk(null)} data-fid="X-04">取消</button>
              <button
                className="btn danger"
                onClick={() => {
                  const runIt = dangerAsk.run;
                  setDangerAsk(null);
                  runIt();
                }} data-fid="X-05"
              >
                <Trash2 size={14} />
                确认执行
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
function Num({
  label,
  value,
  onChange,
  min,
  max,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
}) {
  return (
    <Field label={label}>
      <input
        type="number"
        step="any"
        min={min}
        max={max}
        value={Number.isFinite(value) ? Math.round(value * 100) / 100 : 0}
        onChange={(e) => onChange(+e.target.value)}
      />
    </Field>
  );
}
/** 光束角 → 地面光斑的即时示意：调角度时肉眼可见地涨缩。 */
function BeamPreview({
  installHeight,
  beamAngle,
}: {
  installHeight: number;
  beamAngle: number;
}) {
  const W = 268;
  const H = 118;
  const floorY = H - 20;
  const lampY = 14;
  const diameter = spotDiameterMetres(installHeight, beamAngle);
  const widest = Math.max(spotDiameterMetres(installHeight, 179), 0.001);
  const scale = (W - 28) / widest;
  const half = Math.max(2, (diameter / 2) * scale);
  const cx = W / 2;
  return (
    <svg
      className="beam-preview"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label="光束角与地面光斑示意"
    >
      <line x1="10" y1={floorY} x2={W - 10} y2={floorY} stroke="#d3d0cb" strokeWidth="1.5" />
      <path
        d={`M ${cx} ${lampY} L ${cx - half} ${floorY} L ${cx + half} ${floorY} Z`}
        fill="#f6c171"
        opacity="0.22"
      />
      <ellipse
        cx={cx}
        cy={floorY}
        rx={half}
        ry={Math.max(3, half * 0.22)}
        fill="#f6c171"
        opacity="0.5"
      />
      <line x1={cx} y1={lampY} x2={cx} y2={floorY} stroke="#a4824b" strokeWidth="1" strokeDasharray="3 3" />
      <circle cx={cx} cy={lampY} r="4.5" fill="#a4824b" />
      <text x={cx} y={floorY + 15} textAnchor="middle" fontSize="10" fill="#847d74">
        {Math.round(Number(beamAngle) || 0)}° · ×{spotMultiple(beamAngle).toFixed(2)} · 地面光斑 Ø{diameter.toFixed(2)} m
      </text>
    </svg>
  );
}

/** 折线长度（米）：各段之和 ÷ 26（画布 26 单位 = 1 米）。只量首尾弦长会把折线算短。 */
function stripLengthFromPath(path: Obj[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i += 1) {
    total += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
  }
  return Math.round((total / 26) * 100) / 100;
}
/** 按米重算灯带；画布 26 单位 = 1 米。
 *  直线（两点）＝保持方向改长度；折线（≥三点）＝按当前总长等比缩放、保留折线形状。 */
function stripPathForLength(f: Obj, metres: number): Obj[] {
  const p = stripPoints(f);
  const a = p[0];
  const b = p[p.length - 1];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const L = Math.max(0.2, Number(metres) || 0) * 26;
  if (p.length <= 2) {
    return [
      { x: a.x, y: a.y },
      { x: a.x + (dx / len) * L, y: a.y + (dy / len) * L },
    ];
  }
  const total = p.reduce(
    (acc: number, v: Obj, i: number) =>
      i ? acc + Math.hypot(v.x - p[i - 1].x, v.y - p[i - 1].y) : acc,
    0,
  ) || 1;
  const k = L / total;
  return p.map((v: Obj) => ({ x: a.x + (v.x - a.x) * k, y: a.y + (v.y - a.y) * k }));
}
function stripLengthMetres(f: Obj): number {
  return stripLengthFromPath(stripPoints(f));
}
function stripPathForRotation(f: Obj, deg: number): Obj[] {
  const p = stripPoints(f);
  const a = p[0];
  const len = Math.hypot(p[p.length - 1].x - a.x, p[p.length - 1].y - a.y) || 1;
  const rad = ((Number(deg) || 0) * Math.PI) / 180;
  return [
    { x: a.x, y: a.y },
    { x: a.x + len * Math.cos(rad), y: a.y + len * Math.sin(rad) },
  ];
}
function stripRotationOf(f: Obj): number {
  const p = stripPoints(f);
  const a = p[0];
  const b = p[p.length - 1];
  return Math.round((Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI);
}

function FixtureFields({
  fixture: f,
  rooms,
  products,
  multiFloor,
  basements = 0,
  smart = "",
  patch,
  applyProduct,
}: {
  fixture: Obj;
  rooms: Obj[];
  products: Obj[];
  multiFloor?: boolean;
  basements?: number;
  /** 项目智能方案：决定「控制方式」一栏允许的选项（总线只给开闭 / DALI）。 */
  smart?: string;
  patch: (k: string, v: any) => void;
  applyProduct: (p: Obj) => void;
}) {
  return (
    <div className="fixture-fields">
      <Field label="关联产品库产品">
        <select
          value={f.productId || ""}
          onChange={(e) => {
            const p = products.find((p) => p.id === e.target.value);
            if (p) applyProduct(p);
          }}
        >
          <option value="">手动配置 / 从产品资料选择</option>
          {products.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} · {p.model}
            </option>
          ))}
        </select>
      </Field>
      <div className="two-fields">
        <Field label="灯具编号">
          <input
            value={f.code}
            onChange={(e) => patch("code", e.target.value)}
          />
        </Field>
        <p className="field-hint">
          {describeFixtureCode(f.code)
            ? `${describeFixtureCode(f.code)}　（编号 = 空间码 + 位置码 + 职能码 + 序号）`
            : "编号认不出来：标准格式如 kc001 / kcA001 / xiqM001（空间码 + 位置码 + 职能码 + 序号），请核对空间库与位置库。"}
        </p>
        <Field label="职能（编号第 3 位·场景钩子）">
          <select
            value={roleOfCode(f.code) || "M"}
            onChange={(e) => patch("code", codeWithRole(f.code, e.target.value))}
          >
            {ROLE_CODES.map((r) => (
              <option key={r.code} value={r.code}>
                {r.code} · {r.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="灯具名称">
          <input
            value={f.name}
            onChange={(e) => patch("name", e.target.value)}
          />
        </Field>
        <Field label="产品型号">
          <input
            value={f.model}
            onChange={(e) => patch("model", e.target.value)}
          />
        </Field>
        <Field label="品牌">
          <input
            value={f.brand}
            onChange={(e) => patch("brand", e.target.value)}
          />
        </Field>
      </div>
      <Field label="灯具类型">
        <select value={f.type} onChange={(e) => patch("type", e.target.value)}>
          {lightTypes.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
      </Field>
      {isCctPending(f) && (
        <p className="field-hint cct-pending" role="note">
          色温{CCT_PENDING_LABEL}：导入 / 产品资料没给色温，暂按 3000K 占位，请按实物确认后选择光源类型或色温。
        </p>
      )}
      <div className="two-fields">
        <Field label="光源类型">
          <select
            value={colorModeOf(f)}
            onChange={(e) => patch("colorMode", e.target.value)}
          >
            {COLOR_MODES.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </Field>
        {colorModeOf(f) === "单色" && (
          <Field label="色温 K（单色固定）">
            <select
              value={
                SINGLE_CCT_OPTIONS.includes(Number(f.cct))
                  ? Number(f.cct)
                  : SINGLE_CCT_DEFAULT
              }
              onChange={(e) => patch("cct", +e.target.value)}
            >
              {SINGLE_CCT_OPTIONS.map((k) => (
                <option key={k} value={k}>
                  {k} K{k === SINGLE_CCT_DEFAULT ? "（默认）" : ""}
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>
      {colorModeOf(f) === "双色" && (
        <div className="two-fields">
          <Num label="最低色温 K" value={f.cctMin} min={1000} onChange={(v) => patch("cctMin", v)} />
          <Num label="最高色温 K" value={f.cctMax} min={1000} onChange={(v) => patch("cctMax", v)} />
          <p className="field-hint">双色光源默认 2700K–6500K，可手动改上下限。</p>
        </div>
      )}
      {cctNeedsReason(f) && (
        <Field label="偏离 3000K 单色的原因（必填，进导出「原因」列）">
          <input
            value={f.cctReason || ""}
            aria-label="色温原因"
            aria-required="true"
            aria-invalid={!String(f.cctReason || "").trim()}
            placeholder="如：业主要求可调色温 / 镜前需 4000K"
            onChange={(e) => patch("cctReason", e.target.value)}
          />
        </Field>
      )}
      {colorModeOf(f) === "彩色" && (
        <>
          <div className="two-fields">
            <Num label="最低色温 K（白光通道）" value={f.cctMin} min={1000} onChange={(v) => patch("cctMin", v)} />
            <Num label="最高色温 K（白光通道）" value={f.cctMax} min={1000} onChange={(v) => patch("cctMax", v)} />
          </div>
          <Field label="彩色颜色">
            <div className="color-field">
              <input
                type="color"
                value={f.colorHex || COLOR_HEX_DEFAULT}
                onChange={(e) => patch("colorHex", e.target.value)}
              />
              {f.colorHex || COLOR_HEX_DEFAULT}
            </div>
          </Field>
          <Num label="色相 H（0–360）" value={f.colorHue ?? 320} min={0} onChange={(v) => patch("colorHue", v)} />
        </>
      )}
      <Field label="灯组">
        <input
          value={f.group || ""}
          placeholder="如：客厅主灯组"
          onChange={(e) => patch("group", e.target.value)}
        />
      </Field>
      <Field label="所属空间">
        <select
          value={f.roomId}
          onChange={(e) => patch("roomId", e.target.value)}
        >
          <option value="">未分配空间</option>
          {rooms.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
              {multiFloor ? ` · ${floorLabel(r.floor, basements)}` : ""}
            </option>
          ))}
        </select>
      </Field>
      <div className="two-fields">
        <Num label="X 坐标" value={f.x} onChange={(v) => patch("x", v)} />
        <Num label="Y 坐标" value={f.y} onChange={(v) => patch("y", v)} />
        {!isDecorativeLight(f.type) && (
        <Num
          label="安装高度 m"
          value={f.installHeight}
          min={0}
          onChange={(v) => patch("installHeight", v)}
        />
        )}
        {isDecorativeLight(f.type) && (
          <>
            <Num
              label="光斑大小 ×"
              value={f.spotScale ?? 1}
              min={0.2}
              max={4}
              onChange={(v) => patch("spotScale", v)}
            />
            <p className="field-hint">
              装饰型灯具（吊灯 / 吸顶灯 / 壁灯 / 落地灯 / 台灯 / 镜前灯）只按「色温 + 功率」选型：
              不出安装高度、光束角与照射直径 / 面积数字；图上的光晕大小改用「光斑大小 ×」（0.2–4），
              也可以直接在画布上拖光斑边缘的橙色圆点。
            </p>
          </>
        )}
        <Num
          label="功率 W"
          value={f.power}
          min={0}
          onChange={(v) => patch("power", v)}
        />
        <Num
          label="光通量 lm"
          value={f.lumen ?? 0}
          min={0}
          onChange={(v) => patch("lumen", v)}
        />
        {String(f.type || "").includes("吊灯") && !(Number(f.power) > 0) && (
          <p className="field-hint">
            吊灯需手填功率与光通量（产品库补全后以产品库为准）。
          </p>
        )}
        {f.type !== "灯带" && !isDecorativeLight(f.type) && (
          <>
        <Num
          label="光束角 °"
          value={f.beamAngle ?? defaultBeamAngle(f.type)}
          min={5}
          max={180}
          onChange={(v) => patch("beamAngle", v)}
        />
        <p className="field-hint">
          地面光斑直径约{" "}
          {spotDiameterMetres(
            f.installHeight,
            f.beamAngle ?? defaultBeamAngle(f.type),
          ).toFixed(2)}{" "}
          m（＝15° 基准的 ×
          {spotMultiple(f.beamAngle ?? defaultBeamAngle(f.type)).toFixed(2)} 倍；半角光束角理论值，暂未使用 IES 光度文件）
        </p>
        <BeamPreview
          installHeight={f.installHeight}
          beamAngle={f.beamAngle ?? defaultBeamAngle(f.type)}
        />
        {f.type === "灯带" && (
          <>
            <Num
              label="灯带长度 m"
              value={stripLengthMetres(f)}
              min={0.2}
              onChange={(v) => patch("stripPath", stripPathForLength(f, v))}
            />
            <Num
              label="光斑大小 ×"
              value={f.spotScale ?? 1}
              min={0.2}
              onChange={(v) => patch("spotScale", v)}
            />
            <Field label="照射方向（反光侧）">
              <select
                value={f.stripCast === "left" ? "left" : "right"}
                onChange={(e) => patch("stripCast", e.target.value)}
              >
                <option value="right">沿绘制方向·右手侧</option>
                <option value="left">沿绘制方向·左手侧</option>
              </select>
            </Field>
            <p className="field-hint">
              灯带仅限水平；光斑大小（反光宽度）、反光方向（上/下）可调。图上拖两端只改长度。
            </p>
          </>
        )}
        {f.type === "窗帘" && (
          <>
            <Num
              label="窗帘长度 m"
              value={stripLengthMetres(f)}
              min={0.2}
              onChange={(v) => patch("stripPath", stripPathForLength(f, v))}
            />
            <Num
              label="窗帘方向 °"
              value={stripRotationOf(f)}
              onChange={(v) => patch("stripPath", stripPathForRotation(f, v))}
            />
            <Field label="窗帘电机">
              <select
                value={f.curtainMotor || "单电机"}
                onChange={(e) => patch("curtainMotor", e.target.value)}
              >
                <option value="单电机">单电机 · 单向收拢</option>
                <option value="双电机">双电机 · 中间向两边分开</option>
              </select>
            </Field>
            <p className="field-hint">
              图上选中窗帘后：拖条块本身移动位置，拖两端圆点改长短与方向；也可在此输数值。
              单电机＝内部色块单向进度条，双电机＝由中间向两边分开/聚拢。窗帘不计入报价。
            </p>
          </>
        )}
        <Num
          label="光斑大小 ×"
          value={f.spotScale ?? 1}
          min={0.2}
          max={4}
          onChange={(v) => patch("spotScale", v)}
        />
        <Num
          label="光斑长宽比"
          value={f.spotRatio ?? 1}
          min={0.2}
          onChange={(v) => patch("spotRatio", v)}
        />

        <p className="field-hint">
          图上显示的光斑外径 = 理论外径（2 × 安装高度 × tan(光束角 ÷ 2)）× 光斑大小倍数。
          「光斑大小 ×」默认 1，可在 0.2–4 之间按需要放大 / 缩小，也可在画布上直接拖光斑边缘的橙色圆点；
          长宽比只改形状（拉伸），不改外径。
        </p>
          </>
        )}
        {!isDecorativeLight(f.type) && (
        <Num
          label="亮度上限 %"
          value={f.brightnessMax}
          min={0}
          max={100}
          onChange={(v) => patch("brightnessMax", v)}
        />
        )}
        <Field label="回路编号">
          <input
            value={f.circuit}
            onChange={(e) => patch("circuit", e.target.value)}
          />
        </Field>
      </div>
      <Field label="控制方式">
        {/* 只列本方案允许的控制方式：总线＝开闭 / DALI；无线＝开闭 / 蓝牙 Mesh；不做智能＝开闭。
            旧数据里不合规的值（如 KNX / Zigbee）仍显示出来并标注「旧值」，避免静默改动存量设计。 */}
        <select
          value={f.control}
          onChange={(e) => patch("control", e.target.value)}
        >
          {!fixtureControlAllowed(String(smart || ""), f.control) && (
            <option value={f.control}>{f.control}（旧值，请重选）</option>
          )}
          {fixtureControlOptions(String(smart || "")).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <p className="field-hint">
          {String(smart || "") === "KNX"
            ? "KNX 总线方案：只有「开闭」（经开关执行器）与「DALI」（经 DALI 网关调光）两种。"
            : String(smart || "") === "无线"
              ? "无线方案（飞利浦）：只有「开闭」与无线调光两种（协议随飞利浦清单确认）。"
              : "不做智能（按回路开闭）：不生成智能设备与情景，灯具按回路开闭。"}
        </p>
      </Field>
      {/* 回路表按这三项定位到模块的第几路 / 总线地址；灯带的「模块/网关」后端必填。 */}
      <Field label={f.type === "灯带" ? "模块/网关 *" : "模块/网关"}>
        <input
          required={f.type === "灯带"}
          value={f.controller || ""}
          onChange={(e) => patch("controller", e.target.value)}
        />
      </Field>
      <div className="two-fields">
        <Field label="通道">
          <input
            value={f.channel || ""}
            onChange={(e) => patch("channel", e.target.value)}
          />
        </Field>
        <Field label="地址">
          <input
            value={f.address || ""}
            placeholder={f.control === "DALI" ? "DALI 0–63" : ["蓝牙 Mesh", "Zigbee", "Wi-Fi"].includes(String(f.control || "")) ? "调试时分配" : "—（开闭靠执行器＋通道）"}
            onChange={(e) => patch("address", e.target.value)}
          />
        </Field>
      </div>
      {f.type === "灯带" && (
        <div className="strip-fields">
          <p>每一段灯带独立建档</p>
          <Num
            label="本段长度 m"
            value={f.length}
            min={0.01}
            onChange={(v) => patch("length", v)}
          />
          <div className="two-fields">
            <Num label="灯带终点 X" value={f.stripPath?.[1]?.x ?? f.x + Math.max(30, (f.length || 1) * 26)} onChange={(v) => patch("stripPath", [{ x:f.x, y:f.y }, { x:v, y:f.stripPath?.[1]?.y ?? f.y }])} />
            <Num label="灯带终点 Y" value={f.stripPath?.[1]?.y ?? f.y} onChange={(v) => patch("stripPath", [{ x:f.x, y:f.y }, { x:f.stripPath?.[1]?.x ?? f.x + Math.max(30, (f.length || 1) * 26), y:v }])} />
          </div>
          <Field label="独立电源编号 *">
            <input
              required
              value={f.powerSupply}
              onChange={(e) => patch("powerSupply", e.target.value)}
            />
          </Field>
        </div>
      )}
      <div className="two-fields">
        <Num
          label={f.type === "灯带" ? "参考单价 元/m" : "参考单价 元/盏"}
          value={f.price}
          min={0}
          onChange={(v) => {
            patch("price", v);
          }}
        />
        <div className="check-stack">
          <label>
            <input
              type="checkbox"
              checked={!!f.dimmable}
              onChange={(e) => patch("dimmable", e.target.checked)}
            />
            支持调光
          </label>
          <label>
            <input
              type="checkbox"
              checked={isTunable(f)}
              disabled={colorModeOf(f) === "单色"}
              onChange={(e) => patch("tunable", e.target.checked)}
            />
            支持调色温
          </label>
          <label>
            <input type="checkbox" checked={!!f.colored} disabled />
            支持彩色
          </label>
          <label>
            <input
              type="checkbox"
              checked={!!f.quote}
              onChange={(e) => patch("quote", e.target.checked)}
            />
            纳入报价
          </label>
        </div>
      </div>
      <label className="check-label price-check">
        <input
          type="checkbox"
          checked={f.priceVerified}
          onChange={(e) => patch("priceVerified", e.target.checked)}
        />
        价格已人工核实（非模拟价格）
      </label>
      <Field label="备注">
        <textarea
          value={f.notes}
          onChange={(e) => patch("notes", e.target.value)}
        />
      </Field>
    </div>
  );
}
