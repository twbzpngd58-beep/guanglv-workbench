/**
 * 图纸文件名里的楼层识别（与后端 backend/app.py 的 detect_floor_from_name / parse_floor_name 一致）。
 *
 * 设计师导出图纸时常按楼层命名（「1F 平面图.png」「二层照明.dxf」「地下一层.pdf」），
 * 这里在导入前就按文件名判定楼层，判不出来才让设计师手选。
 * 地下层按项目的「地下层数」换算：内部楼层号 = 地下层数 + 1 - 地下室深度；
 * 地上 n 层 = 地下层数 + n。
 * 注意：正则不使用 lookbehind，避免旧版 Safari 解析整包失败。
 */
import { aboveFloors, floorLabel, safeBasements } from "./floors";

const CN_DIGIT: Record<string, number> = {
  零: 0,
  〇: 0,
  一: 1,
  壹: 1,
  二: 2,
  两: 2,
  贰: 2,
  三: 3,
  叁: 3,
  四: 4,
  肆: 4,
  五: 5,
  伍: 5,
  六: 6,
  陆: 6,
  七: 7,
  柒: 7,
  八: 8,
  捌: 8,
  九: 9,
  玖: 9,
  十: 10,
  拾: 10,
};
const CN_TOKEN = "[零〇一壹二两贰三叁四肆五伍六陆七柒八捌九玖十拾]{1,3}";

function cnNumber(text: string): number | null {
  if (!text) return null;
  const normalized = text.replace(/拾/g, "十");
  const cut = normalized.indexOf("十");
  if (cut < 0) {
    if ([...text].every((ch) => ch in CN_DIGIT))
      return Number([...text].map((ch) => CN_DIGIT[ch]).join(""));
    return null;
  }
  const head = normalized.slice(0, cut);
  const tail = normalized.slice(cut + 1);
  const tens = head ? cnNumber(head) : 1;
  const ones = tail ? cnNumber(tail) : 0;
  if (tens === null || ones === null) return null;
  return tens * 10 + ones;
}

const BASEMENT_RE = new RegExp(
  "地下|底下|负[一二三四五六七八九十0-9]" +
    "|(^|[^A-Za-z0-9])(BG|SB\\d{1,2}|B\\d{1,2})(?![0-9])" +
    "|(^|[^A-Za-z0-9])-\\s*\\d{1,2}\\s*(F|FL|FLOOR|层|樓|楼)",
  "i",
);
const BASEMENT_DEPTH_CN = /(地下|底下|负)\s*([一二三四五六七八九十0-9]{1,2})?/;
const BASEMENT_DEPTH_EN = /(^|[^A-Z0-9])(SB|B)\s*(\d{1,2})(?![0-9])/i;
const BASEMENT_DEPTH_SIGN = /(^|[^A-Z0-9])-\s*(\d{1,2})\s*(F|FL|FLOOR|层|樓|楼)/i;
const SUFFIX_RE = new RegExp(
  "(\\d+|" + CN_TOKEN + ")\\s*(F|FL|FLOOR|层|樓|楼)(?!号)",
  "i",
);
const PREFIX_RE = new RegExp(
  "(^|[^A-Z0-9])(F|FL|FLOOR|L)\\s*(\\d+|" + CN_TOKEN + ")(?![A-Z0-9])",
  "i",
);
const TOP_RE = new RegExp(
  "顶层|顶楼|屋顶|屋面|天台|阁楼|(^|[^A-Z0-9])(RF|ROOF)(?![A-Z0-9])",
  "i",
);
const GROUND_RE = new RegExp(
  "首层|底层|地面层|入户层|(^|[^A-Z0-9])(GF|G)(?![A-Z0-9])",
  "i",
);

export type FloorNameKind = "basement" | "above" | "top" | "ground" | "none";

export interface ParsedFloorName {
  kind: FloorNameKind;
  /** 地下几层（kind=basement 时有效）。 */
  depth?: number;
  /** 地上第几层（kind=above 时有效）。 */
  number?: number;
}

function stemOf(name: string): string {
  const stem = (name || "").replace(/\.[A-Za-z0-9]{1,6}$/, "");
  let text = stem;
  try {
    text = stem.normalize("NFKC");
  } catch {
    text = stem;
  }
  return text.toUpperCase().trim();
}

// 每个正则里数字所在的捕获组不同（前缀是捕获组），必须显式指认，
// 否则会取到后缀字母（-2F 被当成地下 1 层）。
const DEPTH_PATTERNS: Array<[RegExp, number]> = [
  [BASEMENT_DEPTH_EN, 3], // （前缀）(SB|B)(数字)
  [BASEMENT_DEPTH_SIGN, 2], // （前缀）-(数字)(F/层)
  [BASEMENT_DEPTH_CN, 2], // (地下|底下|负)(数字)
];

function basementDepth(text: string): number {
  for (const [re, group] of DEPTH_PATTERNS) {
    const m = re.exec(text);
    if (!m) continue;
    const raw = (m[group] || "").trim();
    if (!raw) continue;
    const depth = /^\d+$/.test(raw) ? Number(raw) : cnNumber(raw);
    if (depth && depth > 0) return Math.min(depth, 20);
  }
  return 1;
}

/** 从文件名里读出楼层线索。 */
export function parseFloorName(name: string): ParsedFloorName {
  const text = stemOf(name);
  if (!text) return { kind: "none" };
  if (BASEMENT_RE.test(text))
    return { kind: "basement", depth: basementDepth(text) };
  // 「2F / 二层」：数字在第 1 组；「F2 / L2」：数字在第 3 组（前缀是捕获组）。
  const suffix = SUFFIX_RE.exec(text);
  const prefix = suffix ? null : PREFIX_RE.exec(text);
  const raw = suffix ? suffix[1] : prefix ? prefix[3] : "";
  if (raw) {
    const number = /^\d+$/.test(raw) ? Number(raw) : cnNumber(raw);
    if (number && number > 0) return { kind: "above", number };
    return { kind: "none" };
  }
  if (TOP_RE.test(text)) return { kind: "top" };
  if (GROUND_RE.test(text)) return { kind: "ground" };
  return { kind: "none" };
}

export interface FloorGuess {
  /** 识别出的内部楼层号（1..floors，地下层是最小的几层）；判不出来为 null。 */
  floor: number | null;
  /** 给用户看的一句话说明。 */
  note: string;
  /** filename＝按文件名识别；none＝文件名里没有可用楼层。 */
  source: "filename" | "none";
}

export function detectFloorFromName(
  name: string,
  floors = 1,
  basements = 0,
): FloorGuess {
  const total = Math.max(1, Math.floor(floors || 1));
  const b = safeBasements(basements, total);
  const ground = aboveFloors(total, b);
  const info = parseFloorName(name);
  if (info.kind === "basement") {
    const depth = info.depth || 1;
    if (b <= 0)
      return {
        floor: null,
        note: "文件名是地下层，但本项目没有设置地下层（可在「楼层设置」里补上地下层数）",
        source: "none",
      };
    if (depth > b)
      return {
        floor: null,
        note: `文件名是地下 ${depth} 层，超出本项目地下层数（共 ${b} 层），请手动选择`,
        source: "none",
      };
    const floor = b + 1 - depth;
    return {
      floor,
      note: `已按文件名识别为 ${floorLabel(floor, b)}`,
      source: "filename",
    };
  }
  if (info.kind === "above") {
    const number = info.number || 1;
    if (number > ground)
      return {
        floor: null,
        note: `文件名是 ${number}F，超出本项目地上层数（共 ${ground} 层），请手动选择`,
        source: "none",
      };
    const floor = b + number;
    return {
      floor,
      note: `已按文件名识别为 ${floorLabel(floor, b)}`,
      source: "filename",
    };
  }
  if (info.kind === "top")
    return {
      floor: total,
      note: `文件名含顶层，已按 ${floorLabel(total, b)} 落层`,
      source: "filename",
    };
  if (info.kind === "ground")
    return {
      floor: b + 1,
      note: `文件名含首层/底层，已按 ${floorLabel(b + 1, b)} 落层`,
      source: "filename",
    };
  return { floor: null, note: "", source: "none" };
}

export interface LevelGuess {
  above: number;
  basements: number;
}

/** 创建项目时按图纸文件名猜「地上层数 / 地下层数」。 */
export function guessLevels(names: string[]): LevelGuess {
  let above = 0;
  let basements = 0;
  names.forEach((name) => {
    const info = parseFloorName(name);
    if (info.kind === "basement") basements = Math.max(basements, info.depth || 1);
    else if (info.kind === "above") above = Math.max(above, info.number || 1);
    else if (info.kind === "ground") above = Math.max(above, 1);
  });
  return { above: Math.max(1, above), basements };
}

/** 上传后给用户看的一句话：每张图纸去了哪一层。 */
export function floorSummary(
  items: { name?: string; floor?: number; floorSource?: string }[],
  multiFloor: boolean,
  basements = 0,
): string {
  if (!multiFloor || !items.length) return "";
  return items
    .map(
      (x) =>
        `${x.name || "图纸"}→${floorLabel(x.floor, basements)}${
          x.floorSource === "filename" ? "（按文件名）" : ""
        }`,
    )
    .join("、");
}
