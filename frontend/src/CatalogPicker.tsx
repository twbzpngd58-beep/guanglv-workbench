// 选型目录级联：品牌 → 型号 → 参数（只出型号允许选的档位）。
// 型号锁死的参数（固定色温 / 固定光束角 / 功率 / 光通量）不在表单里出控件，只在卡片上列值。
import { useMemo } from "react";
import { Field } from "./ui";
import {
  catalogBeamText,
  catalogBrand,
  catalogCctText,
  catalogModel,
  catalogModelLabel,
  catalogPriceText,
  type Catalog,
  type CatalogModel,
  type CatalogParams,
  type CatalogSelection,
} from "./catalog";

export type CatalogPickerProps = {
  catalog: Catalog | null;
  brandId: string;
  modelId: string;
  selection: CatalogSelection;
  onBrand: (brandId: string) => void;
  onModel: (modelId: string) => void;
  onSelection: (sel: CatalogSelection) => void;
  /** 灯具配置里空间紧：卡片收窄、提示语减少。 */
  compact?: boolean;
};

function groupsOf(brandId: string, models: CatalogModel[]): [string, CatalogModel[]][] {
  const map = new Map<string, CatalogModel[]>();
  for (const m of models) {
    // FLOS 的 series 是货号串，按灯具类别分组才好找；飞利浦按 WiZ / Hue 分。
    const g = (brandId === "flos" ? m.type : m.series) || "其他";
    const arr = map.get(g) || [];
    arr.push(m);
    map.set(g, arr);
  }
  const entries = [...map.entries()];
  if (brandId === "philips") {
    const order = ["WiZ", "Hue"];
    entries.sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
  } else {
    entries.sort((a, b) => a[0].localeCompare(b[0], "zh-CN"));
  }
  return entries;
}

function fixedChips(m: CatalogModel): string[] {
  const p = m.params || {};
  const chips: string[] = [];
  if (p.power !== undefined && p.power !== null) chips.push(`功率 ${p.power}W`);
  if (p.lumen !== undefined && p.lumen !== null) chips.push(`光通量 ${p.lumen}lm`);
  if (p.cct) {
    chips.push(
      `色温 ${catalogCctText(p.cct)}${
        p.cct.kind === "range" ? "（区间可调）" : p.cct.kind === "options" ? "（单灯不可调）" : "（固定）"
      }`,
    );
  }
  if (p.beam) chips.push(`光束角 ${catalogBeamText(p.beam)}${p.beam.kind === "options" ? "" : "（不可改）"}`);
  if (p.cutout) chips.push(`开孔 ${p.cutout}`);
  if (p.size) chips.push(`尺寸 ${p.size}`);
  if (p.ip) chips.push(p.ip);
  if (p.ugr) chips.push(p.ugr);
  if (p.material) chips.push(p.material);
  if (p.finish?.fixed) chips.push(`饰面 ${p.finish.fixed}`);
  return chips;
}

export function CatalogPicker({
  catalog,
  brandId,
  modelId,
  selection,
  onBrand,
  onModel,
  onSelection,
  compact = false,
}: CatalogPickerProps) {
  const brand = catalogBrand(catalog, brandId);
  const model = catalogModel(catalog, modelId);
  const params: CatalogParams = model?.params || {};
  const groups = useMemo(
    () => (brand ? groupsOf(brand.id, brand.models) : []),
    [brand],
  );
  const chips = model ? fixedChips(model) : [];
  const cctOptions = params.cct?.kind === "options" ? params.cct : null;
  const beamOptions = params.beam?.kind === "options" ? params.beam : null;
  const glareOptions = params.glare?.options?.length ? params.glare.options : null;
  const finishOptions = params.finish?.options?.length ? params.finish.options : null;
  const hasChoices = !!(cctOptions || beamOptions || glareOptions || finishOptions);

  return (
    <div className="catalog-picker">
      <div className="two-fields">
        <Field label="品牌（选型目录）">
          <select
            value={brandId}
            aria-label="选型品牌"
            disabled={!catalog}
            onChange={(e) => onBrand(e.target.value)}
          >
            <option value="">{catalog ? "不指定 · 手动配置" : "选型目录未加载"}</option>
            {catalog?.brands.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}（{b.models.length} 款）
              </option>
            ))}
          </select>
        </Field>
        <Field label="型号">
          <select
            value={modelId}
            aria-label="选型型号"
            disabled={!brand}
            onChange={(e) => onModel(e.target.value)}
          >
            <option value="">{brand ? `请选择型号（${brand.models.length} 款）` : "先选品牌"}</option>
            {groups.map(([group, models]) => (
              <optgroup key={group} label={group}>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {catalogModelLabel(m)} · {catalogPriceText(m)}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </Field>
      </div>
      {model && (
        <>
          <div className="catalog-card">
            {model.image ? (
              <a
                className="catalog-shot"
                href={`/catalog-img/${model.image}`}
                target="_blank"
                rel="noreferrer"
                title="点开看大图"
              >
                <img src={`/catalog-img/${model.image}`} alt={`${model.brandLabel} ${model.model}`} loading="lazy" />
              </a>
            ) : (
              <div className="catalog-shot empty">暂无<br />产品图</div>
            )}
            <div className="catalog-meta">
              <div className="catalog-name">
                {model.name}
                {!compact && model.variant && model.variant !== model.name ? (
                  <span className="catalog-sub"> · {model.variant}</span>
                ) : null}
              </div>
              <div className="catalog-sub">
                {model.brandLabel} · {model.model}
                {model.type ? ` · ${model.type}` : ""}
              </div>
              <div className="catalog-price">
                {catalogPriceText(model)}
                {model.price?.basis ? <em>· {model.price.basis}</em> : null}
              </div>
              {chips.length > 0 && (
                <div className="catalog-chips">
                  {chips.map((c) => (
                    <span key={c} className="catalog-chip">
                      {c}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
          {hasChoices && (
            <div className="catalog-params">
              {cctOptions && (
                <Field label="色温 K（型号可选项）">
                  <select
                    value={selection.cct ?? cctOptions.default}
                    aria-label="型号色温"
                    onChange={(e) => onSelection({ ...selection, cct: +e.target.value })}
                  >
                    {cctOptions.options.map((k) => (
                      <option key={k} value={k}>
                        {k} K{k === cctOptions.default ? "（默认）" : ""}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              {beamOptions && (
                <Field label="光束角 °（型号可选项）">
                  <select
                    value={selection.beamAngle ?? beamOptions.default}
                    aria-label="型号光束角"
                    onChange={(e) => onSelection({ ...selection, beamAngle: +e.target.value })}
                  >
                    {beamOptions.options.map((b) => (
                      <option key={b} value={b}>
                        {b}°{b === beamOptions.default ? "（默认）" : ""}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              {glareOptions && (
                <Field label="防眩罩（型号可选项）">
                  <select
                    value={selection.glare ?? glareOptions[0]}
                    aria-label="型号防眩罩"
                    onChange={(e) => onSelection({ ...selection, glare: e.target.value })}
                  >
                    {glareOptions.map((g) => (
                      <option key={g} value={g}>
                        {g}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              {finishOptions && (
                <Field label="饰面（型号可选项）">
                  <select
                    value={selection.finish ?? finishOptions[0]}
                    aria-label="型号饰面"
                    onChange={(e) => onSelection({ ...selection, finish: e.target.value })}
                  >
                    {finishOptions.map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
            </div>
          )}
          {!compact && (
            <p className="catalog-note">
              只列该型号能选的参数：色温区间、固定光束角、功率与光通量按产品锁定，不出选择框；
              价格＝{model.price?.basis || "目录价"}，来源：知识库 15-产品库。
            </p>
          )}
        </>
      )}
    </div>
  );
}
