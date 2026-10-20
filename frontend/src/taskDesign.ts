import { type Design, type Obj } from "./types";
import { withSpaceShell } from "./spaceGeometry";

export const taskScale = (flow: Obj) => flow.fromDxf ? 26 : 1;
export function taskUnitsPerMeter(room: Obj, fromDxf = false): number {
  const pts = room.points?.length >= 3 ? room.points : [
    { x: room.x, y: room.y }, { x: room.x + room.w, y: room.y },
    { x: room.x + room.w, y: room.y + room.h }, { x: room.x, y: room.y + room.h },
  ];
  const area = Math.abs(pts.reduce((sum: number, p: Obj, i: number) => {
    const q = pts[(i + 1) % pts.length]; return sum + p.x * q.y - q.x * p.y;
  }, 0)) / 2;
  return room.area > 0 ? Math.sqrt(area / room.area) : fromDxf ? 1 : 26;
}
export function taskDesign(flow: Obj): Design {
  const scale = taskScale(flow);
  const rooms = (flow.rooms || []).map((r: Obj) => ({
    ...r, name: r.name || "未命名空间", type: r.name, source: r.source || "cad-preview",
    floor: r.floor || 1, x: r.x * scale, y: r.y * scale,
    width: r.w * scale, height: r.h * scale,
    heightM: r.heightM || 3, originalHeightM: r.originalHeightM || 3,
    points: r.points?.length >= 3 ? r.points.map((p: Obj) => ({ x: p.x * scale, y: p.y * scale })) : [
      { x: r.x * scale, y: r.y * scale }, { x: (r.x + r.w) * scale, y: r.y * scale },
      { x: (r.x + r.w) * scale, y: (r.y + r.h) * scale }, { x: r.x * scale, y: (r.y + r.h) * scale },
    ],
  }));
  const fixtures = (flow.lights || []).map((l: Obj) => ({
    ...l, name: l.type, x: l.x * scale, y: l.y * scale,
    floor: rooms.find((r: Obj) => r.id === l.roomId)?.floor || l.floor || 1,
    power: 12, price: 0, brightnessMax: 100, cctMin: l.cct, cctMax: l.cct,
    installHeight: rooms.find((r: Obj) => r.id === l.roomId)?.heightM || 3,
    beamAngle: l.beam, controller: (flow.panels || []).filter((p: Obj) => p.lights.includes(l.id)).map((p: Obj) => p.code).join("、"),
    stripPath: l.stripPath?.map((p: Obj) => ({ x: p.x * scale, y: p.y * scale })),
  }));
  return withSpaceShell({
    rooms, fixtures, walls: [], texts: [], scenes: [], palette: "natural", camera: {},
    openings: (flow.openings || []).map((o: Obj) => ({ ...o, x: o.x * scale, y: o.y * scale, width: o.width * scale })),
    furniture: (flow.furniture || []).map((f: Obj) => ({ ...f, x: f.x * scale, y: f.y * scale })),
    devices: [...(flow.panels || []).map((p: Obj) => ({ ...p, type: "面板", keyLabels: p.labels, keys: p.labels.length })),
      ...(flow.sensors || []).map((p: Obj) => ({ ...p, type: "传感器" }))].map((p: Obj) => ({
        ...p, x: p.x * scale, y: p.y * scale,
        floor: rooms.find((r: Obj) => r.id === p.roomId)?.floor || p.floor || 1,
      })),
    spaceDefinition: { status: flow.confirmed ? "confirmed" : "previewing",
      workflowStep: flow.confirmed ? "canvas" : flow.modelingPhase || "review",
      roomsConfirmedAt: flow.roomsReviewedAt || "", openingsConfirmedAt: flow.openingsReviewedAt || "",
      editingFloor: flow.editingFloor || 1 },
  });
}
