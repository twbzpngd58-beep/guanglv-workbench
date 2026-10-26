/**
 * R5 / U5：回路检查。红色问题由 d 实时推出（编辑即刷新，不用保存）；
 * 「按回路看」给 D3 读数，「按网关看」标通道 / 地址重复。规则见 ./circuitRules。
 */
import { AlertCircle, ChevronRight } from "lucide-react";
import {
  circuitIssues,
  gatewayDuplicates,
  groups,
  reading,
  UNASSIGNED,
  type CircuitIssue,
} from "./circuitRules";

type Obj = Record<string, any>;

/** 红色问题清单：灯具清单、导出区共用；where 只区分无障碍标签。 */
export function CircuitIssueList({
  design,
  where,
  onLocate,
  blockedNote,
}: {
  design: Obj;
  where: string;
  onLocate: (f: Obj) => void;
  blockedNote?: boolean;
}) {
  const issues = circuitIssues(design);
  if (!issues.length) return null;
  const first = (x: CircuitIssue) => design.fixtures.find((f: Obj) => f.id === x.fixtureIds[0]);
  return (
    <div className="notice circuit-warn" role="alert" aria-label={"回路问题 · " + where}>
      <AlertCircle size={17} />
      <div>
        <b>回路问题 {issues.length} 条</b>
        {blockedNote && (
          <span>施工包、厂家包被 {issues.length} 条拦住；业主 HTML、图片能导，带此提示。全部改掉才放行。</span>
        )}
        <ul className="cct-warn-list">
          {issues.map((x) => (
            <li key={x.text}>
              <em>{x.text}</em>
              {first(x) && (
                <button className="text-link" onClick={() => onLocate(first(x))}>
                  定位 <ChevronRight size={13} />
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** U5「按回路看」+「按网关看」。 */
export function CircuitBoard({ design }: { design: Obj }) {
  const rooms = new Map<string, string>((design.rooms || []).map((r: Obj) => [r.id, r.name]));
  const bad = new Set(circuitIssues(design).map((x) => x.circuit));
  const dups = gatewayDuplicates(design);
  const list = [...groups(design)];
  if (!list.length) return null;
  return (
    <section className="circuit-board" aria-label="按回路看">
      <h3>按回路看</h3>
      <table>
        <thead>
          <tr>
            <th>回路</th>
            <th>灯具</th>
            <th>空间</th>
            <th>调光方式</th>
            <th>读数</th>
          </tr>
        </thead>
        <tbody>
          {list.map(([key, members]) => {
            const names = [...new Set(members.map((f) => f.space || rooms.get(f.roomId) || "未分配空间"))];
            const ctrls = [...new Set(members.map((f) => String(f.control || "").trim()).filter(Boolean))];
            return (
              <tr key={key} className={bad.has(key) ? "is-bad" : ""}>
                <td>{key}</td>
                <td>{members.length}</td>
                <td>{names.join("、")}</td>
                <td>{ctrls.join("、") || "—"}</td>
                <td>{key === UNASSIGNED ? "—" : reading(members)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <h3>按网关看</h3>
      {dups.length ? (
        <ul className="circuit-dups">
          {dups.map((x) => (
            <li key={x.gateway + x.kind + x.value}>
              {x.gateway} {x.kind} {x.value} 重复：{x.codes.join("、")}
            </li>
          ))}
        </ul>
      ) : (
        <p className="subtle">通道、地址没有重复。</p>
      )}
    </section>
  );
}
