import type { Obj } from "./types";

/** 能力表：单用户本机演示；?edition= 仅本机评审用，正式版由许可/签名决定。 */
let cache: Obj | null = null;

export async function getCapabilities(edition?: string): Promise<Obj> {
  const q = edition ? `?edition=${encodeURIComponent(edition)}` : "";
  const r = await fetch(`/api/capabilities${q}`);
  if (!r.ok) throw new Error(`capabilities ${r.status}`);
  const data = await r.json();
  cache = data;
  try { localStorage.setItem("gv.capabilities", JSON.stringify(data)); } catch {}
  return data;
}

/** 项目壳同步读取：由外壳首页的真实 API 结果落盘，不再只看演示版本号。 */
export function readCapabilities(): Obj | null {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem("gv.capabilities");
    if (raw) { cache = JSON.parse(raw); return cache; }
  } catch {}
  return null;
}
