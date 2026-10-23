/**
 * 灯具与设备库 —— 工作台自己的产品库
 *
 * 内容来自随源码分发的产品资料（各品牌产品清单），
 * 由后端 product_library.py 写进工作台的 `products` 表。
 * 口径：只带**市场零售价**（出厂价 / 运费 / 备注不进工作台）；价格与参数使用前逐项核实。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, ArrowUpRight, Lightbulb, Loader2, RefreshCw, Search } from "lucide-react";
import { api, type Obj } from "./types";
import { Button } from "./ui";

const PAGE = 48;

export function ProductLibrary({
  notify,
  goProjects,
}: {
  notify: (s: string) => void;
  goProjects: () => void;
}) {
  const [items, setItems] = useState<Obj[]>([]);
  const [status, setStatus] = useState<Obj | null>(null);
  const [q, setQ] = useState("");
  const [brand, setBrand] = useState("");
  const [category, setCategory] = useState("");
  const [scheme, setScheme] = useState("");
  const [shown, setShown] = useState(PAGE);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await api("/products/status"));
    } catch {
      /* 状态读不到不影响列表 */
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (category) params.set("category", category);
      if (brand) params.set("brand", brand);
      if (scheme) params.set("scheme", scheme);
      if (q.trim()) params.set("q", q.trim());
      params.set("limit", "600");
      setItems(await api(`/products?${params.toString()}`));
      setShown(PAGE);
    } catch (e: any) {
      notify("产品库读取失败：" + e.message);
    } finally {
      setLoading(false);
    }
  }, [category, brand, scheme, q, notify]);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    const t = setTimeout(load, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  const brands = useMemo(
    () => Object.keys(status?.by_brand || {}).filter((b) => b && b !== "未标品牌"),
    [status],
  );
  const schemes = ["缓亮缓灭", "无线", "总线", "开闭"];
  const lights = status?.by_category?.light || 0;
  const devices = status?.by_category?.device || 0;
  const total = status?.total || items.length;

  async function syncLibrary() {
    setSyncing(true);
    try {
      const r: Obj = await api("/products/sync", { method: "POST" });
      await Promise.all([load(), loadStatus()]);
      const extra = (r.warnings || []).length ? `，${r.warnings.length} 条待核对` : "";
      notify(`产品库已同步：${r.total} 件（灯具 ${r.by_category?.light || 0} / 设备 ${r.by_category?.device || 0}）${extra}`);
    } catch (e: any) {
      notify("同步失败：" + e.message);
    } finally {
      setSyncing(false);
    }
  }

  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">PRODUCT LIBRARY · 产品库</div>
          <h1>为每个空间，找到合适的光。</h1>
          <p>
            产品来自随源码分发的产品资料：统一灯具报价表 + 各品牌产品清单。
            只带市场零售价，出厂价与运费不进工作台；价格与参数使用前须逐项核实。
          </p>
        </div>
        <Button disabled={syncing} onClick={syncLibrary}>
          {syncing ? <Loader2 className="spin" size={16} /> : <RefreshCw size={16} />}
          {syncing ? "同步中…" : "同步产品资料"}
        </Button>
      </div>

      <div className="notice">
        <AlertCircle size={17} />
        <div>
          <b>
            共 {total} 件（灯具 {lights} · 设备 {devices}）
            {status?.synced_at ? ` · 同步于 ${status.synced_at}` : ""}
          </b>
          <span>
            {(status?.warnings || []).join("；") ||
              "关联产品后，可在项目灯具表中修改全部参数；产品资料里的零售价不会被标记为已核实价格。"}
          </span>
        </div>
      </div>

      <div className="product-toolbar">
        <label className="product-search">
          <Search size={15} />
          <input
            placeholder="搜产品名 / 型号 / 品牌，例：D15、射灯、世聪"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </label>
        <select
          aria-label="类别筛选"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        >
          <option value="">全部类别</option>
          <option value="light">灯具</option>
          <option value="device">设备与电气</option>
        </select>
        <select
          aria-label="方案筛选"
          value={scheme}
          onChange={(e) => setScheme(e.target.value)}
        >
          <option value="">全部方案</option>
          {schemes.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select aria-label="品牌筛选" value={brand} onChange={(e) => setBrand(e.target.value)}>
          <option value="">全部品牌</option>
          {brands.map((b) => (
            <option key={b} value={b}>
              {b}（{status?.by_brand?.[b]}）
            </option>
          ))}
        </select>
        {(q || brand || category || scheme) && (
          <button
            className="text-link"
            onClick={() => {
              setQ("");
              setBrand("");
              setCategory("");
              setScheme("");
            }}
          >
            清空筛选
          </button>
        )}
      </div>

      {loading && !items.length ? (
        <p className="subtle">
          <Loader2 className="spin" size={15} /> 正在读产品库…
        </p>
      ) : !items.length ? (
        <p className="subtle">
          没有匹配的产品。产品库来自产品资料，可点右上「同步产品资料」重新灌一次。
        </p>
      ) : (
        <div className="product-library">
          {items.slice(0, shown).map((p, i) => (
            <article key={p.id}>
              <div className={"product-visual product-" + (i % 4)}>
                <Lightbulb strokeWidth={0.8} size={80} />
                <span>
                  {(p.brand || "未标品牌").toUpperCase()} · {p.model || p.type}
                </span>
              </div>
              <small>
                {p.type}
                {p.model ? ` · ${p.model}` : ""}
                {p.scheme ? ` · ${p.scheme}` : ""}
              </small>
              <h3>{p.name}</h3>
              <p>
                {p.power ? `${p.power}W · ` : ""}
                {p.cct
                  ? p.cct
                  : // 产品没给色温 = 待核，不再用 2700–6500 冒充。
                    p.cctPending || !p.cctMin || !p.cctMax
                    ? "色温待核"
                    : `${p.cctMin}–${p.cctMax}K`}
                {p.control ? ` · ${p.control}` : ""}
                {p.unit && p.unit !== "个" ? ` · 按${p.unit}` : ""}
              </p>
              <div>
                <b>
                  {p.price != null ? `¥ ${p.price}` : "待补价"}{" "}
                  <small>{p.price != null ? "/ 产品资料零售价" : "/ 资料里没写"}</small>
                </b>
                <Button
                  onClick={() => {
                    goProjects();
                    notify("打开项目，在灯具配置中选择此产品");
                  }}
                >
                  用于项目 <ArrowUpRight size={14} />
                </Button>
              </div>
              <span className="product-source" title={p.sourcePath}>
                来源：{p.source}
              </span>
            </article>
          ))}
        </div>
      )}

      {items.length > shown && (
        <div className="product-more">
          <Button onClick={() => setShown(shown + PAGE)}>
            显示更多（还有 {items.length - shown} 件）
          </Button>
        </div>
      )}
    </>
  );
}
