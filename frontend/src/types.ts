import { SPACE_LIBRARY } from "./spaces";

export type Obj = Record<string, any>;
export interface Design {
  rooms: Obj[];
  walls: Obj[];
  openings: Obj[];
  texts: Obj[];
  /** 灯具。刀4·R4 回路表字段：controller 模块/网关、channel 通道、address 地址（DALI 短地址 / KNX 组地址），老数据缺省按空。 */
  fixtures: Obj[];
  devices: Obj[];
  scenes: Obj[];
  palette: string;
  camera: Obj;
  baseFileId?: string;
  /** 布灯完成前的灰色蒙版；导入图纸后显示，确定后消失。 */
  planMasked?: boolean;
  architecture?: Obj;
  spaceDefinition?: Obj;
  furniture?: Obj[];
  colorPlan?: Obj;
}
export interface Project {
  id: string;
  code: string;
  name: string;
  client: string;
  city: string;
  address: string;
  type: string;
  area: number;
  floors: number;
  /** 地下层数：地下室不用负数，最下面的这几层就是 B1、B2… */
  basements?: number;
  /** 智能方案：无线（默认全系 JOCO）/ KNX 总线 / 无（灯具按回路开闭）。 */
  smart?: string;
  /**
   * 建模方式：2D（底图+灯具+情景）/ 3D（三维空间）。
   * 建项目时定下来，之后不能改——3D 项目进「三维空间」，2D 项目走原来那一套。
   */
  mode?: "2D" | "3D";
  /** 原始层高（结构层高）m —— 3D 里算光锥/光斑要用。 */
  ceiling?: number;
  /** 吊顶后层高（净高）m。 */
  ceilingNet?: number;
  designer: string;
  relationshipType?: "direct_b2c" | "b2b" | "b2b_referral";
  channelId?: string;
  channelNameSnapshot?: string;
  channelContactSnapshot?: string;
  endCustomerName?: string;
  projectOwnerId?: string;
  firstOrder?: Obj;
  requirementsBaseline?: Obj;
  notes: string;
  status: string;
  version: number;
  revision: number;
  updatedAt: string;
  createdAt: string;
  design: Design;
  files: Obj[];
  reviews: Obj;
  // 分项失效记录：哪道复核因什么改动失效（重新签名后清除）
  invalidatedReviews?: Record<string, { at: string; reason: string; reviewer?: string }>;
  approved: boolean;
  frozen: boolean;
  isDemo: boolean;
  recognition: Obj | null;
  renders: Obj[];
  cooperation: Obj;
}
// Unlike randomUUID(), getRandomValues also works on a trusted LAN HTTP origin.
export const uid = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
/** 空间类型候选：来自 spaces.ts 空间库（管理界面按「分区」分组展示）。 */
export const roomTypes = SPACE_LIBRARY.map((s) => s.name);
export const lightTypes = [
  "射灯",
  "筒灯",
  "洗墙灯",
  "轨道射灯",
  "磁吸轨道",
  "线性灯",
  "灯带",
  "吊灯",
  "吸顶灯",
  "壁灯",
  "落地灯",
  "台灯",
  "镜前灯",
  "柜内灯",
  "地脚灯",
  "感应地脚灯",
  "踏步灯",
  "庭院灯",
  "水下灯",
  "其他灯具",
];
export const ADMIN_DENIED = "此操作仅限局域网或需管理口令";
const ADMIN_TOKEN_KEY = "gv.adminToken";
const adminHeaders = (): Record<string, string> => {
  const t = sessionStorage.getItem(ADMIN_TOKEN_KEY);
  return t ? { "X-Admin-Token": t } : {};
};
// 高危接口在外网返回 403 admin_required：提示一次口令（只存本标签页），带上口令重试一次。
export async function adminFetch(
  input: string,
  init: RequestInit = {},
): Promise<Response> {
  const send = () =>
    fetch(input, {
      ...init,
      headers: { ...adminHeaders(), ...(init.headers as any) },
    });
  let r = await send();
  if (r.status !== 403) return r;
  const j = await r
    .clone()
    .json()
    .catch(() => ({}));
  if (j?.code !== "admin_required") return r;
  const t = window.prompt(`${ADMIN_DENIED}。\n如有管理口令，请输入：`);
  if (!t) throw new Error(ADMIN_DENIED);
  sessionStorage.setItem(ADMIN_TOKEN_KEY, t);
  r = await send();
  if (r.status === 403) {
    sessionStorage.removeItem(ADMIN_TOKEN_KEY);
    throw new Error(ADMIN_DENIED);
  }
  return r;
}
export async function api<T = any>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const r = await adminFetch("/api" + path, {
    ...init,
    headers: {
      ...(!(init.body instanceof FormData)
        ? { "Content-Type": "application/json" }
        : {}),
      ...init.headers,
    },
  });
  if (!r.ok) {
    let j: any;
    try {
      j = await r.json();
    } catch {
      throw new Error(`请求失败 (${r.status})`);
    }
    throw new Error(
      typeof j.detail === "string"
        ? j.detail
        : JSON.stringify(j.detail || "操作失败"),
    );
  }
  return r.json();
}
export const post = (path: string, body?: any) =>
  api(path, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
// 灯具编号自带空间：编号形如「客厅-01」，前缀就是这盏灯所在的空间。
// 导入彩平图后不必先做空间分割，直接放灯、给编号即可。
export const spaceFromCode = (code: string): string => {
  const m = /^(.+?)[-_—][0-9]+$/.exec((code || "").trim());
  return m ? m[1].trim() : "";
};
export const fmtDate = (s: string) =>
  new Date(s).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
