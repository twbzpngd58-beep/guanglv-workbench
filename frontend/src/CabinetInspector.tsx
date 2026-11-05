/**
 * 电箱面板：右边栏里把配电箱画成实拍里的样子——黑框箱体、导轨、模块正面、位数标记条、空位白板，
 * 同屏出一张按线色走的总线接线图。
 *
 * 只读展示层——所有判定（谁进箱、占几位、怎么接）都在 cabinetRules.ts 里，
 * 位数与外观图来自 data/cabinet-modules.json（知识库产品库 + 配图索引抽取）。
 * 画布上的箱体与这里的分组是同一套判据，所以不会出现「画布三位、右边两位」的打架。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  MM_PER_P,
  RAIL_P,
  busWiring,
  cabinetView,
  occupancy,
  type BoxItem,
  type CabinetView,
  type Rail,
  type Via,
} from "./cabinetRules";

type Obj = Record<string, any>;

// 外观图：知识库配图索引里挑出来的箱内设备正面照（scripts/cabinet_modules_from_vault.mjs 收进来的）。
const IMGS = import.meta.glob("./data/cabinet-img/*.{png,jpg}", { eager: true, import: "default" }) as Record<
  string,
  string
>;
const imgOf = (name?: string) => (name ? IMGS[`./data/cabinet-img/${name}`] : undefined);

// 实拍图量的比例：1P＝18mm，箱体留黑框；下面所有几何都按这个 mm 比例推，不给方块另加外接框。
const MM = 0.74;
const CELL = MM_PER_P * MM; // 1P 的像素宽 ≈ 13.3
const RAIL_W = RAIL_P * CELL; // 22.5P ≈ 299.7
const BEZEL = 9; // 黑色边框
const INNER = 5; // 边框到导轨区的白底
const X0 = BEZEL + INNER;
const MOD_H = 58; // 模块正面区高
const NAME_H = 21; // 模块下方的标签位（名称一行、位数一行）
const STRIP_H = 11; // 蓝色位数标记条
const TAG_H = 12; // 标记条下面的「第 N 轨 · 轨长」一行
const GAP = 7; // 轨与轨之间的隔板
const BAND = MOD_H + NAME_H + STRIP_H + TAG_H + GAP;

const VIA_LABEL: Record<Via, { name: string; color: string; dash?: string }> = {
  mains: { name: "220V 市电（棕 L / 蓝 N / 黄绿 PE）", color: "#7a4a22" },
  knx: { name: "KNX 总线（红/黑 · 30V DC）", color: "#c23b3b" },
  load: { name: "负载出线（回路端子排）", color: "#8a8272" },
  dali: { name: "DALI 两芯（极性不限）", color: "#6f9b6a", dash: "2 3" },
  wireless: { name: "无线（Zigbee / 蓝牙 Mesh）", color: "#a67fc9", dash: "5 3" },
  lan: { name: "网线 / 局域网", color: "#5f8fa0", dash: "1 3" },
};

/** 这台设备归哪一段：返回电箱要落回它自己在的那一段，而不是当初点开的箱体符号。 */
const boxOf = (it: BoxItem) =>
  it.info.mount === "weak" ? "weak" : it.info.mount === "out" || it.info.mount === "wall" ? "outside" : "strong";

const fmtP = (n: number) => String(Math.round(n * 100) / 100);

/**
 * SVG 里的 text 不会自己换行也不会缩字——写多少就溢出多少，超出 viewBox 直接被裁掉。
 * 所以按字号估一次字宽再截：CJK 和全角标点算整宽，半角算 0.56 宽，空格 0.3，截不到就补省略号。
 * 1.15 是实测余量：等比缩放后真实字宽比估算大 10% 出头，不留这层就会顶出格子。
 */
const txtW = (s: string, fs: number) =>
  [...s].reduce((a, c) => {
    const cp = c.codePointAt(0) || 0;
    return a + (cp > 0x2e80 ? fs : c === " " ? fs * 0.3 : fs * 0.56);
  }, 0) * 1.15;
const fit = (s: string, maxW: number, fs: number) => {
  if (!s || txtW(s, fs) <= maxW) return s;
  let out = "";
  for (const c of s) {
    if (txtW(out + c + "…", fs) > maxW) break;
    out += c;
  }
  return out + "…";
};

export function CabinetInspector({
  design,
  project,
  floor,
  anchorRoom,
  focus,
  focusDevice,
  onSelectDevice,
}: {
  design: Obj;
  project: Obj;
  floor: number;
  anchorRoom?: string;
  // 画布点的是哪一只箱（strong / weak / outside）：三段都留着，但标出并滚到点中的那段，
  // 否则点弱电箱和点强电箱看着是同一页。
  focus?: string;
  // 从属性页「返回电箱」回来时的那台设备：把它的选中态和外观卡一起接上，回来接着看而不是从头点。
  focusDevice?: string;
  onSelectDevice?: (id: string, box: string) => void;
}) {
  const [sel, setSel] = useState("");
  const [wireMode, setWireMode] = useState<"diagram" | "list">("diagram");
  const railSec = useRef<HTMLDivElement>(null);
  const weakSec = useRef<HTMLDivElement>(null);
  const outSec = useRef<HTMLDivElement>(null);
  const view = useMemo(() => cabinetView(design), [design]);
  const occ = useMemo(() => occupancy(view), [view]);
  const wiring = useMemo(() => busWiring(design, project, view), [design, project, view]);
  const railDevices = view.strong.rails.reduce((a, r) => a + r.slots.length, 0);
  const picked = useMemo(() => (sel ? view.items.find((v) => v.dev.id === sel) || null : null), [view, sel]);

  const hi = (id?: string) => (sel && id === sel ? " gv-cab-on" : "");
  const pick = (id?: string) => () => setSel((v) => (id && v === id ? "" : id || ""));

  // 扩容建议：按实占留 20%，只报导轨位数——箱体的「路」各家标法不一，不做换算。
  const suggestP = Math.ceil((occ.capacityP ? occ.usedP * 1.2 : RAIL_P) / 5) * 5;

  useEffect(() => {
    const el = focus === "weak" ? weakSec.current : focus === "outside" ? outSec.current : railSec.current;
    el?.scrollIntoView({ block: "nearest" });
  }, [focus]);

  // 从属性页返回时把选中态接回来，外观卡跟着复现。只在落点变化时覆盖，
  // 用户再点一次模块取消选中不会被这里按回去。
  useEffect(() => {
    if (focusDevice) setSel(focusDevice);
  }, [focusDevice]);

  return (
    <div className="gv-cab">
      <div className="gv-cab-sum">
        <div className="gv-cab-kv">
          <span>设备归位</span>
          <b>
            导轨 {railDevices} · 弱电 {view.weak.length}
            {view.outside.length ? ` · 箱外 ${view.outside.length}` : ""}
          </b>
        </div>
        <div className="gv-cab-kv">
          <span>导轨基准</span>
          <b>
            {occ.railCount} 条 × {RAIL_P}P（每条 {Math.round(RAIL_P * MM_PER_P)}mm）
          </b>
        </div>
        <div className="gv-cab-kv">
          <span>已用位数</span>
          <b>
            {occ.usedP}P / {occ.capacityP}P（{occ.percent}%）· 余 {occ.freeP}P ≈ {Math.round(occ.freeP * MM_PER_P)}mm
          </b>
        </div>
        <div className="gv-cab-kv">
          <span>所在空间</span>
          <b>{anchorRoom ? `${anchorRoom} · ${floor}F` : `不在具体空间（贴 ${floor}F 平面左上角）`}</b>
        </div>
      </div>

      {occ.percent >= 100 || occ.railCount > 1 ? (
        <div className="gv-cab-warn">
          单条 {RAIL_P}P 已排满，超出部分换第 {occ.railCount} 条轨——配电箱按 {occ.railCount} 条轨（
          {Math.round(occ.railCount * RAIL_P * MM_PER_P)}mm 导轨总长）选；建议按 ≥{suggestP}P 留扩容位。
        </div>
      ) : (
        <div className="gv-cab-hint">
          余量 {occ.freeP}P ≈ {Math.round(occ.freeP * MM_PER_P)}mm：再加设备先看这条轨能不能放下，
          放不下就换第二条轨或加大箱体（建议 ≥{suggestP}P）。
        </div>
      )}

      <div className={"gv-cab-sec" + (focus === "strong" ? " gv-cab-focus" : "")} ref={railSec}>
        强电箱 · 正视<i>按 1P＝{MM_PER_P}mm 等比 · 点模块看外观</i>
      </div>
      <BoxFront view={view} sel={sel} pick={pick} />

      {view.strong.pending.length > 0 && (
        <>
          <div className="gv-cab-sec">
            位数待填<i>没上轨 · 不计入占位</i>
          </div>
          {view.strong.pending.map((it) => (
            <div className={"gv-cab-row gv-cab-todo" + hi(it.dev.id)} key={it.dev.id} onClick={pick(it.dev.id)}>
              <div>
                <div className="gv-cab-nm">
                  {it.dev.name || it.dev.type}
                  <em>位数待填</em>
                </div>
                <div className="gv-cab-bs">{it.info.basis}</div>
              </div>
              <div className="gv-cab-p">—</div>
            </div>
          ))}
        </>
      )}

      {picked && <AppearanceCard it={picked} onJump={onSelectDevice} />}

      <div className={"gv-cab-sec" + (focus === "weak" ? " gv-cab-focus" : "")} ref={weakSec}>
        弱电箱 · 网络侧<i>不占导轨位数</i>
      </div>
      {view.weak.length ? (
        view.weak.map((it) => <WeakRow key={it.dev.id} it={it} sel={sel} pick={pick} />)
      ) : (
        <div className="gv-cab-empty">本项目弱电箱暂无设备（网桥 / 云主机都归这里）。</div>
      )}

      {view.outside.length > 0 && (
        <>
          <div className={"gv-cab-sec" + (focus === "outside" ? " gv-cab-focus" : "")} ref={outSec}>
            不在箱内<i>吊顶 · 嵌入 · 底盒</i>
          </div>
          {view.outside.map((it) => (
            <div className={"gv-cab-row" + hi(it.dev.id)} key={it.dev.id} onClick={pick(it.dev.id)}>
              <div>
                <div className="gv-cab-nm">{it.dev.name || it.dev.type}</div>
                <div className="gv-cab-bs">{it.info.basis}</div>
              </div>
              <div className="gv-cab-tag">箱外</div>
            </div>
          ))}
        </>
      )}

      <div className="gv-cab-sec gv-cab-secwire">
        <span>总线接线图</span>
        <span className="gv-cab-seg">
          <button className={wireMode === "diagram" ? "on" : ""} onClick={() => setWireMode("diagram")}>
            示意
          </button>
          <button className={wireMode === "list" ? "on" : ""} onClick={() => setWireMode("list")}>
            清单
          </button>
        </span>
      </div>
      {wireMode === "diagram" ? (
        <WiringSvg view={view} wiring={wiring} sel={sel} pick={pick} />
      ) : (
        <div className="gv-cab-wires">
          {wiring.rows.map((r) => {
            const via = VIA_LABEL[r.via];
            const linked = sel && r.devId === sel;
            return (
              <div
                className={"gv-cab-wire" + (linked ? " gv-cab-on" : "")}
                key={r.id}
                style={{ borderColor: via.color }}
                onClick={r.devId ? pick(r.devId) : undefined}
              >
                <div className="gv-cab-wline">
                  <b>{r.from}</b>
                  <i style={{ borderTopColor: via.color, borderTopStyle: via.dash ? "dashed" : "solid" }} />
                  <b>{r.to}</b>
                </div>
                {r.note && <div className="gv-cabwnote">{r.note}</div>}
              </div>
            );
          })}
        </div>
      )}
      <div className="gv-cab-legend">
        {Object.values(VIA_LABEL).map((v) => (
          <span key={v.name}>
            <i style={{ borderTopColor: v.color, borderTopStyle: v.dash ? "dashed" : "solid" }} />
            {v.name}
          </span>
        ))}
      </div>

      <div className="gv-cab-src">
        位数取自知识库产品库（{view.items.filter((v) => v.info.known).length}/{view.items.length} 台命中型号表）、
        外观图取自知识库配图索引（{view.items.filter((v) => v.info.img).length}/{view.items.length} 台有正面照）；
        标「判」＝知识库只记尺寸没记安装方式、按品类判的。表里没有的型号一律进「位数待填」，不猜位数。
      </div>
    </div>
  );
}

/** 选中设备的外观卡：实拍正面照 + 型号/位数/尺寸/判据——窄模块在导轨上认不清时看这里。 */
function AppearanceCard({ it, onJump }: { it: BoxItem; onJump?: (id: string, box: string) => void }) {
  const url = imgOf(it.info.img);
  const p = it.info.p;
  return (
    <div className="gv-cab-card">
      <div className="gv-cab-cardimg">
        {url ? <img src={url} alt={`${it.info.name} 外观`} /> : <div className="gv-cab-noimg">知识库没这张外观图</div>}
      </div>
      <div className="gv-cab-cardinfo">
        <div className="gv-cab-nm">{it.dev.name || it.info.name}</div>
        <div className="gv-cab-bs">
          型号 {it.dev.model || it.info.model || "未填"} ·{" "}
          {p ? `${fmtP(p)}P（${Math.round(p * MM_PER_P)}mm 宽）` : it.info.mm ? `${it.info.mm}mm 宽` : "位数待填"}
        </div>
        <div className="gv-cab-bs">{it.info.basis}</div>
        {onJump && (
          <button className="gv-cab-jump" onClick={() => onJump(it.dev.id, boxOf(it))}>
            打开这台设备的属性
          </button>
        )}
      </div>
    </div>
  );
}

function WeakRow({ it, sel, pick }: { it: BoxItem; sel: string; pick: (id?: string) => () => void }) {
  const url = imgOf(it.info.img);
  return (
    <div
      className={"gv-cab-row gv-cab-rowimg" + (sel && it.dev.id === sel ? " gv-cab-on" : "")}
      onClick={pick(it.dev.id)}
    >
      <span className="gv-cab-thumb">{url ? <img src={url} alt="" /> : <i />}</span>
      <div className="gv-cab-rowmain">
        <div className="gv-cab-nm">
          {it.dev.name || it.dev.type}
          <em>弱电箱</em>
        </div>
        <div className="gv-cab-bs">{it.info.basis}</div>
      </div>
      <div className="gv-cab-p">{it.info.mm ? `${it.info.mm}mm` : ""}</div>
    </div>
  );
}

/** 强电箱正视：黑框＋白底＋四角螺丝，每条轨一段（模块 → 标签 → 蓝色位数条），空位盖白板。 */
function BoxFront({ view, sel, pick }: { view: CabinetView; sel: string; pick: (id?: string) => () => void }) {
  const rails = view.strong.rails;
  const W = X0 * 2 + RAIL_W;
  const H = X0 * 2 + rails.length * BAND - GAP;
  return (
    <svg
      className="gv-cab-box"
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      role="img"
      aria-label={`强电箱正视，${rails.length} 条 ${RAIL_P}P 导轨，已用 ${view.strong.usedP}P`}
    >
      <rect x={0} y={0} width={W} height={H} rx={5} className="gv-cab-bezel" />
      <rect x={BEZEL} y={BEZEL} width={W - BEZEL * 2} height={H - BEZEL * 2} rx={2} className="gv-cab-liner" />
      {[
        [BEZEL / 2, BEZEL / 2],
        [W - BEZEL / 2, BEZEL / 2],
        [BEZEL / 2, H - BEZEL / 2],
        [W - BEZEL / 2, H - BEZEL / 2],
      ].map(([cx, cy], i) => (
        <g key={i} className="gv-cab-screw">
          <circle cx={cx} cy={cy} r={2.4} />
          <line x1={cx - 1.5} y1={cy} x2={cx + 1.5} y2={cy} />
        </g>
      ))}
      {rails.map((r) => (
        <RailBand key={r.index} rail={r} top={X0 + r.index * BAND} sel={sel} pick={pick} />
      ))}
    </svg>
  );
}

function RailBand({
  rail,
  top,
  sel,
  pick,
}: {
  rail: Rail;
  top: number;
  sel: string;
  pick: (id?: string) => () => void;
}) {
  const stripY = top + MOD_H + NAME_H + 2;
  const last = rail.slots.reduce((a, s) => Math.max(a, s.atP + (s.item.info.p || 0)), 0);
  const freeP = Math.max(RAIL_P - last, 0);
  const freeW = freeP * CELL;
  return (
    <g>
      {/* 导轨本体：模块压在轨上，只露出下沿一条金属边 */}
      <rect x={X0} y={top + MOD_H - 4} width={RAIL_W} height={4} className="gv-cab-din" />
      {freeW > 2 && (
        <g className="gv-cab-fill">
          <rect x={X0 + last * CELL} y={top} width={freeW} height={MOD_H - 4} rx={1} />
          {Array.from({ length: Math.floor(freeP) }, (_, i) => (
            <line
              key={i}
              x1={X0 + (last + i + 1) * CELL}
              y1={top + 4}
              x2={X0 + (last + i + 1) * CELL}
              y2={top + MOD_H - 8}
            />
          ))}
          {/* 空位太窄就整条不写字——位数在轨标「21/22.5P」里已经说了，塞半个词更难读 */}
          <text x={X0 + last * CELL + freeW / 2} y={top + MOD_H / 2} textAnchor="middle" className="gv-cab-filltx">
            {(() => {
              const t = fit(`空 ${fmtP(freeP)}P`, freeW - 3, 7.5);
              return t.includes("…") ? "" : t;
            })()}
          </text>
        </g>
      )}
      {rail.slots.map((s) => (
        <ModuleFace key={s.item.dev.id} slot={s} top={top} rail={rail} sel={sel} pick={pick} />
      ))}

      {Array.from({ length: Math.floor(RAIL_P) }, (_, i) => i + 1).map((n) => (
        <g key={n}>
          <rect x={X0 + (n - 1) * CELL} y={stripY} width={CELL} height={STRIP_H} className="gv-cab-cell" />
          <text x={X0 + (n - 1) * CELL + CELL / 2} y={stripY + STRIP_H - 3} textAnchor="middle" className="gv-cab-celltx">
            {n}
          </text>
        </g>
      ))}
      {/* 22.5P 的半格：实拍标记条最后一格就只有半格宽 */}
      {RAIL_P % 1 > 0 && (
        <rect
          x={X0 + Math.floor(RAIL_P) * CELL}
          y={stripY}
          width={(RAIL_P % 1) * CELL}
          height={STRIP_H}
          className="gv-cab-cell gv-cab-cellhalf"
        />
      )}
      <text x={X0} y={stripY + STRIP_H + 10} className="gv-cab-railtag">
        第 {rail.index + 1} 轨 · {fmtP(rail.usedP)}/{RAIL_P}P{rail.over ? " · 单台超一条轨宽" : ""}
      </text>
      <text x={X0 + RAIL_W} y={stripY + STRIP_H + 10} textAnchor="end" className="gv-cab-railtag">
        轨长 {Math.round(RAIL_P * MM_PER_P)}mm
      </text>
    </g>
  );
}

function ModuleFace({
  slot,
  top,
  rail,
  sel,
  pick,
}: {
  slot: Rail["slots"][number];
  top: number;
  rail: Rail;
  sel: string;
  pick: (id?: string) => () => void;
}) {
  const it = slot.item;
  const p = it.info.p || 0;
  const x = X0 + slot.atP * CELL;
  const w = Math.max(p * CELL, 6);
  const h = MOD_H - 4;
  const url = imgOf(it.info.img);
  const on = !!sel && it.dev.id === sel;
  const name = String(it.dev.name || it.dev.type || "");
  return (
    <g onClick={pick(it.dev.id)} style={{ cursor: "pointer" }}>
      <title>{`${name} · ${it.dev.model || "无型号"} · ${fmtP(p)}P（${it.info.basis}）· 第 ${rail.index + 1} 轨 ${fmtP(slot.atP + 1)}–${fmtP(slot.atP + p)} 位`}</title>
      {url ? (
        <image href={url} x={x} y={top} width={w} height={h} preserveAspectRatio="xMidYMid slice" />
      ) : (
        <g className="gv-cab-mod">
          <rect x={x} y={top} width={w} height={h} rx={1.5} />
          {Array.from({ length: Math.max(1, Math.floor(w / CELL)) }, (_, i) => {
            const n = Math.max(1, Math.floor(w / CELL));
            return <circle key={i} cx={x + ((i + 0.5) * w) / n} cy={top + 7} r={1.5} />;
          })}
          <rect x={x + 2} y={top + h - 14} width={Math.max(w - 4, 2)} height={3} className="gv-cab-led" />
        </g>
      )}
      {/* KNX 总线插头：实拍里每台导轨设备下沿都露一红一黑 */}
      <rect x={x + w - 5} y={top + h - 6} width={2.2} height={5} className="gv-cab-busr" />
      <rect x={x + w - 2.6} y={top + h - 6} width={2.2} height={5} className="gv-cab-busk" />
      <rect x={x} y={top} width={w} height={h} rx={1.5} className={"gv-cab-modhit" + (on ? " gv-cab-modhit-on" : "")} />
      <text x={x + w / 2} y={top + h + 9} textAnchor="middle" className={"gv-cab-modtx" + (on ? " gv-cab-modtx-on" : "")}>
        {fit(name, w - 2, 8)}
      </text>
      <text x={x + w / 2} y={top + h + NAME_H - 2} textAnchor="middle" className="gv-cab-modsub">
        {fit(p ? `${fmtP(p)}P${it.info.mountInferred ? "（判）" : ""}` : "待填", w - 2, 6.8)}
      </text>
    </g>
  );
}

type WNode = {
  id: string;
  label: string;
  sub?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  devId?: string;
};

/**
 * 接线示意：左侧三根市电母排（黄绿 PE / 棕 L / 蓝 N）＋红黑 KNX 主干，中间箱内设备，右边下游去向。
 * 线按 via 上色、正交走线、每根各占一条通道，不叠在一起——现场对线要的是「这根从哪来到哪去」。
 */
function WiringSvg({
  view,
  wiring,
  sel,
  pick,
}: {
  view: CabinetView;
  wiring: ReturnType<typeof busWiring>;
  sel: string;
  pick: (id?: string) => () => void;
}) {
  const rows = wiring.rows;
  const DEV_X = 78;
  const DEV_W = 104;
  const DST_X = 236;
  const DST_W = 92;
  const H0 = 30;
  const PITCH = 25;

  const dev: WNode[] = [];
  const push = (n: Omit<WNode, "x" | "y" | "w" | "h">) =>
    dev.push({ ...n, x: DEV_X, y: H0 + dev.length * PITCH, w: DEV_W, h: 21 });
  for (const r of view.strong.rails)
    for (const s of r.slots)
      push({
        id: "d" + s.item.dev.id,
        label: String(s.item.dev.name || s.item.dev.type || ""),
        sub: `${fmtP(s.item.info.p || 0)}P · 第 ${r.index + 1} 轨`,
        devId: s.item.dev.id,
      });
  for (const it of view.weak)
    push({ id: "d" + it.dev.id, label: String(it.dev.name || it.dev.type || ""), sub: "弱电箱", devId: it.dev.id });
  // 面板/传感器挂在总线上但不在箱里，接线图里要有它们，否则现场数总线取电对不上。
  for (const r of rows)
    if (r.id === "panel" || r.id === "sensor")
      push({ id: "x" + r.id, label: r.to, sub: r.id === "panel" ? "86 底盒 · 箱外" : "吊顶 · 箱外" });

  const dstKeys: { via: Via; to: string; note: string }[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (r.via === "mains" || r.via === "knx") continue;
    const key = r.via + "|" + r.to;
    if (seen.has(key)) continue;
    seen.add(key);
    dstKeys.push({ via: r.via, to: r.to, note: r.note });
  }
  const dst: WNode[] = dstKeys.map((k, i) => ({
    id: "t" + i,
    label: k.to,
    sub: k.note,
    x: DST_X,
    y: H0 + 4 + i * 30,
    w: DST_W,
    h: 25,
  }));

  const byDev = new Map(dev.map((n) => [n.devId, n]));
  const byTo = new Map(dst.map((n, i) => [dstKeys[i].to, n]));
  type Edge = { via: Via; a: WNode; b: WNode; chan: number };
  const edges: Edge[] = [];
  const busNode: WNode = { id: "bus", label: "", x: 60, y: H0, w: 0, h: 0 };
  let chan = 0;
  for (const r of rows) {
    if (r.via === "mains") continue;
    if (r.via === "knx") {
      const n = (r.devId && byDev.get(r.devId)) || dev.find((d) => d.label === r.to);
      if (n) edges.push({ via: r.via, a: busNode, b: n, chan: chan++ });
      continue;
    }
    const a = r.devId ? byDev.get(r.devId) : undefined;
    const b = byTo.get(r.to);
    if (a && b) edges.push({ via: r.via, a, b, chan: chan++ });
    else {
      // 「局域网 → 主机」这类从右侧回到箱内的行：按同一根线反向画。
      const back = byTo.get(r.from);
      const a2 = r.devId ? byDev.get(r.devId) : undefined;
      if (back && a2) edges.push({ via: r.via, a: a2, b: back, chan: chan++ });
    }
  }

  const W = 332;
  const H = Math.max(H0 + dev.length * PITCH + 10, H0 + dst.length * 30 + 16, 140);
  const mains = [
    { x: 12, c: "#b8a13f", t: "PE" },
    { x: 26, c: "#7a4a22", t: "L" },
    { x: 40, c: "#2f6fb5", t: "N" },
  ];
  return (
    <svg className="gv-cab-wsvg" viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="总线接线示意图">
      {mains.map((r) => (
        <g key={r.t}>
          <line x1={r.x} y1={18} x2={r.x} y2={H - 6} stroke={r.c} strokeWidth={1.5} />
          <text x={r.x} y={12} textAnchor="middle" className="gv-cab-wrail">
            {r.t}
          </text>
        </g>
      ))}
      <text x={0} y={H - 1} className="gv-cab-wfoot">
        220V 进线
      </text>
      {/* KNX 主干：红/黑一对竖线贯穿，每台箱内设备搭上去 */}
      <line x1={54} y1={18} x2={54} y2={H - 6} stroke="#c23b3b" strokeWidth={1.5} />
      <line x1={66} y1={18} x2={66} y2={H - 6} stroke="#2b2b30" strokeWidth={1.5} />
      <text x={60} y={12} textAnchor="middle" className="gv-cab-wrail">
        KNX
      </text>

      {edges
        .filter((e) => e.via === "knx")
        .map((e) => (
          <g key={"k" + e.b.id} className={sel && e.b.devId === sel ? "gv-cab-wlink" : ""}>
            <line x1={54} y1={e.b.y + 7} x2={e.b.x} y2={e.b.y + 7} stroke="#c23b3b" strokeWidth={1.1} />
            <line x1={66} y1={e.b.y + 14} x2={e.b.x} y2={e.b.y + 14} stroke="#2b2b30" strokeWidth={1.1} />
          </g>
        ))}
      {dev
        .filter((n) => n.devId)
        .map((n) => (
          <g key={"m" + n.id} className={sel === n.devId ? "gv-cab-wlink" : ""}>
            <line x1={26} y1={n.y + 3} x2={n.x} y2={n.y + 3} stroke="#7a4a22" strokeWidth={0.9} strokeOpacity={0.7} />
            <line x1={40} y1={n.y + 18} x2={n.x} y2={n.y + 18} stroke="#2f6fb5" strokeWidth={0.9} strokeOpacity={0.7} />
          </g>
        ))}
      {edges
        .filter((e) => e.via !== "knx")
        .map((e) => {
          const v = VIA_LABEL[e.via];
          const cx = e.b.x + 5 + (e.chan % 4) * 4;
          const ay = e.a.y + e.a.h / 2;
          const by = e.b.y + e.b.h / 2;
          return (
            <polyline
              key={e.a.id + ">" + e.b.id}
              className={sel && e.a.devId === sel ? "gv-cab-wlink" : ""}
              points={`${e.a.x},${ay} ${cx},${ay} ${cx},${by} ${e.b.x},${by}`}
              fill="none"
              stroke={v.color}
              strokeWidth={1.3}
              strokeDasharray={v.dash}
            />
          );
        })}

      {dev.map((n) => {
        const on = !!sel && n.devId === sel;
        return (
          <g key={n.id} onClick={n.devId ? pick(n.devId) : undefined} style={{ cursor: n.devId ? "pointer" : "default" }}>
            <title>{`${n.label}${n.sub ? " · " + n.sub : ""}`}</title>
            <rect
              x={n.x}
              y={n.y}
              width={n.w}
              height={n.h}
              rx={3}
              className={"gv-cab-wnode" + (on ? " gv-cab-wnode-on" : "")}
            />
            <text x={n.x + 4} y={n.y + 9} className="gv-cab-wlab">
              {fit(n.label, n.w - 8, 8)}
            </text>
            <text x={n.x + 4} y={n.y + 18} className="gv-cab-wsub">
              {fit(n.sub || "", n.w - 8, 6.8)}
            </text>
          </g>
        );
      })}
      {dst.map((n, i) => (
        <g key={n.id}>
          <rect
            x={n.x}
            y={n.y}
            width={n.w}
            height={n.h}
            rx={3}
            className="gv-cab-wdst"
            stroke={VIA_LABEL[dstKeys[i].via].color}
          />
          <title>{`${n.label}${n.sub ? " · " + n.sub : ""}`}</title>
          <text x={n.x + 4} y={n.y + 9} className="gv-cab-wlab">
            {fit(n.label, n.w - 8, 8)}
          </text>
          <text x={n.x + 4} y={n.y + 19} className="gv-cab-wsub">
            {fit(n.sub || "", n.w - 8, 6.8)}
          </text>
        </g>
      ))}
    </svg>
  );
}
