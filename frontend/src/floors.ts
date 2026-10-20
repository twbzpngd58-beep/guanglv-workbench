/**
 * 楼层模型（与后端 backend/floors.py 一致）。
 *
 * 项目里 floors = 总层数（地上 + 地下），basements = 其中地下层数。
 * 地下室不用负数：内部楼层号永远是 1..floors 的正整数，floor=1 是最底下的那一层，
 * 地下层就是编号最小的那几层，显示时转成「B1、B2」。
 * 这样校验、按层分页、按层底图、情景按层联动都继续用正整数。
 */
const CN_DIGIT = "零一二三四五六七八九";

export function cnNumber(n: number): string {
  if (n <= 0) return String(n);
  if (n < 10) return CN_DIGIT[n];
  if (n === 10) return "十";
  if (n < 20) return "十" + CN_DIGIT[n % 10];
  if (n % 10 === 0) return CN_DIGIT[Math.floor(n / 10)] + "十";
  return (
    CN_DIGIT[Math.floor(n / 10)] + "十" + CN_DIGIT[n % 10]
  );
}

/** 地下层数：0..floors-1（至少留一层地上）。 */
export function safeBasements(basements?: number, floors?: number): number {
  const b = Math.max(0, Math.floor(Number(basements) || 0));
  const total = Math.max(1, Math.floor(Number(floors) || 1));
  return Math.min(b, total - 1);
}

/** 地上层数。 */
export function aboveFloors(floors?: number, basements?: number): number {
  const total = Math.max(1, Math.floor(Number(floors) || 1));
  return Math.max(0, total - safeBasements(basements, total));
}

/** 短标签：地下层 → B1/B2，地上 → 1F/2F。 */
export function floorLabel(floor?: number, basements = 0): string {
  const f = Math.max(1, Math.floor(Number(floor) || 1));
  const b = Math.max(0, Math.floor(Number(basements) || 0));
  if (b && f <= b) return `B${b + 1 - f}`;
  return `${f - b}F`;
}

/** 中文层名：地下一层 / 一层 / 二层。 */
export function floorName(floor?: number, basements = 0): string {
  const f = Math.max(1, Math.floor(Number(floor) || 1));
  const b = Math.max(0, Math.floor(Number(basements) || 0));
  if (b && f <= b) return `地下${cnNumber(b + 1 - f)}层`;
  return `${cnNumber(f - b)}层`;
}

/** 下拉/按钮里用：「B1 · 地下一层」「2F · 二层」。 */
export function floorChoiceLabel(floor?: number, basements = 0): string {
  return `${floorLabel(floor, basements)} · ${floorName(floor, basements)}`;
}

export interface FloorLevel {
  value: number;
  label: string;
  name: string;
  choice: string;
  isBasement: boolean;
}

/** 全部楼层（从最底层往上）。 */
export function floorLevels(floors?: number, basements?: number): FloorLevel[] {
  const total = Math.max(1, Math.floor(Number(floors) || 1));
  const b = safeBasements(basements, total);
  return Array.from({ length: total }, (_, i) => {
    const value = i + 1;
    return {
      value,
      label: floorLabel(value, b),
      name: floorName(value, b),
      choice: floorChoiceLabel(value, b),
      isBasement: Boolean(b && value <= b),
    };
  });
}

/** 「地上 2 层 · 地下 1 层」；没有地下层时只说层数。 */
export function levelSummary(floors?: number, basements?: number): string {
  const total = Math.max(1, Math.floor(Number(floors) || 1));
  const b = safeBasements(basements, total);
  const above = aboveFloors(total, b);
  return b ? `地上 ${above} 层 · 地下 ${b} 层` : `地上 ${above} 层`;
}
