"""Polygon rooms are the source of structure; CAD parsing is only the initial draft."""
import math

UNITS = 26.0


def room_points(room):
    if room.get("source") in ("fixture-code", "semantic-labels"):
        return []
    pts = room.get("points") or []
    if len(pts) >= 3:
        pts = [(float(p["x"]), float(p["y"])) for p in pts]
    elif float(room.get("width") or 0) > 1 and float(room.get("height") or 0) > 1:
        x, y, w, h = (float(room.get(k) or 0) for k in ("x", "y", "width", "height"))
        pts = [(x, y), (x + w, y), (x + w, y + h), (x, y + h)]
    else:
        return []
    if len(pts) > 3 and math.dist(pts[0], pts[-1]) < 1e-6:
        pts.pop()
    return pts


def design_geometry(project):
    design = project.get("design") or {}
    rooms, walls, openings = [], [], []
    all_points = []
    for room in design.get("rooms") or []:
        pts = room_points(room)
        if len(pts) < 3:
            continue
        poly = [[x / UNITS, y / UNITS] for x, y in pts]
        all_points.extend(poly)
        xs, zs = [p[0] for p in poly], [p[1] for p in poly]
        original = float(room.get("originalHeightM") or project.get("ceiling") or 3)
        h = float(room.get("heightM") or project.get("ceilingNet") or original)
        floor = room.get("floor") or 1
        rooms.append({"id": room["id"], "name": room.get("name") or "未命名空间", "floor": floor,
                      "poly": poly, "rects": [], "bbox": [min(xs), min(zs), max(xs), max(zs)],
                      "cx": (min(xs) + max(xs)) / 2, "cz": (min(zs) + max(zs)) / 2,
                      "area": abs(sum(a[0] * b[1] - b[0] * a[1]
                                      for a, b in zip(poly, poly[1:] + poly[:1]))) / 2,
                      "heightM": h, "originalHeightM": original})
        for index, (a, b) in enumerate(zip(poly, poly[1:] + poly[:1])):
            dx, dz = b[0] - a[0], b[1] - a[1]
            length = math.hypot(dx, dz)
            if length < 1e-6:
                continue
            cuts = []
            for opening in design.get("openings") or []:
                if opening.get("source") not in ("manual", "outsourcing-approved") or "edgeIndex" not in opening:
                    continue
                owner = next((r for r in design.get("rooms") or [] if r["id"] == opening.get("roomId")), None)
                if not owner or (owner.get("floor") or 1) != floor:
                    continue
                owner_pts = room_points(owner)
                edge = opening["edgeIndex"]
                if not isinstance(edge, int) or not 0 <= edge < len(owner_pts):
                    continue
                u, v = owner_pts[edge], owner_pts[(edge + 1) % len(owner_pts)]
                ends = [[(u[0] + (v[0] - u[0]) * opening[k]) / UNITS,
                         (u[1] + (v[1] - u[1]) * opening[k]) / UNITS] for k in ("start", "end")]
                if any(abs((p[0] - a[0]) * dz - (p[1] - a[1]) * dx) / length > .01 / UNITS for p in ends):
                    continue
                ts = [((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / (length * length) for p in ends]
                cuts.append({**opening, "start": max(0, min(ts)), "end": min(1, max(ts))})
            cuts.sort(key=lambda o: o["start"])

            def segment(start, end, bottom=0, top=h, opening_id=""):
                if end - start < 1e-6 or top - bottom < 1e-6:
                    return
                walls.append({"x0": a[0] + dx * start, "z0": a[1] + dz * start,
                              "x1": a[0] + dx * end, "z1": a[1] + dz * end,
                              "heightM": top - bottom, "bottomM": bottom, "t": .12,
                              "roomId": room["id"], "floor": floor, "openingId": opening_id})
            cursor = 0
            for opening in cuts:
                start, end = max(0, float(opening.get("start", 0))), min(1, float(opening.get("end", 0)))
                if not end > start or start < cursor - 1e-6:
                    continue
                segment(cursor, start)
                sill = 0 if opening.get("type") == "门" else max(0, min(h, float(opening.get("sillHeight") or 0)))
                top = min(h, sill + float(opening.get("heightM") or 2.1))
                segment(start, end, 0, sill, opening["id"])
                segment(start, end, top, h, opening["id"])
                if opening["roomId"] == room["id"]:
                    openings.append({"id": opening["id"], "type": opening.get("type"), "roomId": room["id"],
                                 "x0": a[0] + dx * start, "z0": a[1] + dz * start,
                                 "x1": a[0] + dx * end, "z1": a[1] + dz * end,
                                 "width": length * (end - start), "heightM": top - sill,
                                     "sillHeight": sill, "floor": floor})
                cursor = end
            segment(cursor, 1)
    box = [min(p[0] for p in all_points), min(p[1] for p in all_points),
           max(p[0] for p in all_points), max(p[1] for p in all_points)] if all_points else [0, 0, 10, 10]
    return {"rooms": rooms, "walls": walls, "openings": openings, "bbox": box,
            "geometry_source": "design-spaces"}
