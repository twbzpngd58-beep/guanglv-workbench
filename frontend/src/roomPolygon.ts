/** Pure polygon editing: never replace the ordered boundary with a bounding rectangle. */
export type Point = { x: number; y: number };
export function roomPoints(room: any): Point[] {
  const p = room.points?.length >= 3 ? room.points.map((v: Point) => ({ x: Number(v.x), y: Number(v.y) })) :
    [{ x: room.x, y: room.y }, { x: room.x + room.width, y: room.y },
     { x: room.x + room.width, y: room.y + room.height }, { x: room.x, y: room.y + room.height }];
  if (p.length > 3 && Math.hypot(p[0].x-p[p.length-1].x, p[0].y-p[p.length-1].y) < 1e-6) p.pop();
  return p;
}
export function projectToEdge(p: Point, a: Point, b: Point): Point {
  const dx=b.x-a.x, dy=b.y-a.y, d=dx*dx+dy*dy;
  const t=d ? Math.max(0, Math.min(1, ((p.x-a.x)*dx+(p.y-a.y)*dy)/d)) : 0;
  return { x:a.x+t*dx, y:a.y+t*dy };
}
export function withRoomPolygon(room: any, points: Point[]): any {
  if (points.length < 3) throw new Error("空间边界至少保留3个点");
  let sum=0;
  for (let i=0;i<points.length;i++) {
    const a=points[i],b=points[(i+1)%points.length];
    if (!Number.isFinite(a.x) || !Number.isFinite(a.y)) throw new Error("边界坐标无效");
    if (Math.hypot(a.x-b.x,a.y-b.y)<1e-6) throw new Error("边界点不能重合");
    sum+=a.x*b.y-b.x*a.y;
  }
  const cross=(a:Point,b:Point,c:Point)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
  for (let i=0;i<points.length;i++) for(let j=i+1;j<points.length;j++) {
    if(j===i+1 || (i===0 && j===points.length-1)) continue;
    const a=points[i],b=points[(i+1)%points.length],c=points[j],d=points[(j+1)%points.length];
    if(cross(a,b,c)*cross(a,b,d)<0 && cross(c,d,a)*cross(c,d,b)<0) throw new Error("边界不能交叉，请调整顶点");
  }
  if(Math.abs(sum)<1e-6) throw new Error("边界必须围成有效面积");
  const xs=points.map(p=>p.x),ys=points.map(p=>p.y),x=Math.min(...xs),y=Math.min(...ys);
  return {...room,points,x,y,width:Math.max(...xs)-x,height:Math.max(...ys)-y,
    area:Math.round(Math.abs(sum)/2/676*10)/10,source:"manual"};
}
export function insertRoomPoint(room: any, edge: number, point: Point): any {
  const points=roomPoints(room),a=points[edge],b=points[(edge+1)%points.length];
  if(!a || !b) throw new Error("请选择有效边界线");
  const p=projectToEdge(point,a,b);
  if(Math.min(Math.hypot(p.x-a.x,p.y-a.y),Math.hypot(p.x-b.x,p.y-b.y))<1e-5) throw new Error("请在边界线上、两个顶点之间增加点");
  points.splice(edge+1,0,p);return withRoomPolygon(room,points);
}
export function deleteRoomPoint(room: any, index: number): any {
  const points=roomPoints(room);
  if(points.length<=3) throw new Error("空间边界至少保留3个点，不能再删除");
  if(index<0 || index>=points.length) throw new Error("请选择有效顶点");
  points.splice(index,1);return withRoomPolygon(room,points);
}
