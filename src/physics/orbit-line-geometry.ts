import { Vec3, dot, lenSq, sub } from './vec3';

// 線分と球の交差・近接判定は描画層から切り離す。軌道の離心率や頂点密度に依存せず、
// 端点の角度だけでなく「線分の途中で天体を横切る」ケースを扱うための幾何プリミティブ。

export function distanceSqPointToSegment(point: Vec3, start: Vec3, end: Vec3): number {
  const segment = sub(end, start);
  const lengthSq = lenSq(segment);
  if (lengthSq <= 0) return lenSq(sub(point, start));
  const t = Math.max(0, Math.min(1, dot(sub(point, start), segment) / lengthSq));
  const closest = {
    x: start.x + segment.x * t,
    y: start.y + segment.y * t,
    z: start.z + segment.z * t,
  } as Vec3;
  return lenSq(sub(point, closest));
}

export function segmentIntersectsSphere(start: Vec3, end: Vec3, center: Vec3, radius: number): boolean {
  return radius > 0 && distanceSqPointToSegment(center, start, end) <= radius * radius;
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

// 球面の内側は完全透明、半径2倍以上は不透明。頂点の fade に使う値。
export function pointSphereFade(point: Vec3, center: Vec3, radius: number): number {
  if (!(radius > 0)) return 1;
  return smoothstep(radius, radius * 2, Math.sqrt(lenSq(sub(point, center))));
}
