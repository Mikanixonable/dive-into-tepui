// 位置 r における日照率。天体暦(いつどこにいるか)ではなく、位置と各天体の現在位置・半径
// から求める幾何なので ephemeris.ts から独立させている。恒星・遮蔽天体をともに球とみなし、
// r から見た太陽円盤と遮蔽天体円盤の重なり面積比で減光率を出す — 本影(重なり=太陽円盤全体)・
// 金環(遮蔽円盤が太陽円盤に内包)・半影(部分的に重なる)・完全日照(重なり無し)が場合分け
// 無しに1つの閉じた式から出る。
import { Attractor } from './attractor';
import { Vec3, dot, len, scale, sub } from './vec3';

// 2円(半径 r1, r2、中心距離 d、すべて同じ角度単位)の交差面積。
function circleOverlapArea(r1: number, r2: number, d: number): number {
  if (d >= r1 + r2) return 0;
  if (d <= Math.abs(r1 - r2)) return Math.PI * Math.min(r1, r2) ** 2;
  const d1 = (d * d - r2 * r2 + r1 * r1) / (2 * d);
  const d2 = d - d1;
  const clampAcos = (x: number) => Math.acos(Math.min(1, Math.max(-1, x)));
  return (
    r1 * r1 * clampAcos(d1 / r1) - d1 * Math.sqrt(Math.max(0, r1 * r1 - d1 * d1)) +
    r2 * r2 * clampAcos(d2 / r2) - d2 * Math.sqrt(Math.max(0, r2 * r2 - d2 * d2))
  );
}

// r から見た太陽円盤のうち occluder に遮られていない面積比(0..1)。
function occludedFraction(r: Vec3, sunDir: Vec3, sunDist: number, sunAngRadius: number, occluder: Attractor): number {
  if (occluder.isStar || occluder.radius <= 0) return 1; // 恒星自身・半径0の天体は遮蔽器にしない
  const toOccluder = sub(occluder.state.r, r);
  const along = dot(toOccluder, sunDir);
  if (along <= 0 || along >= sunDist) return 1; // 艦より太陽から遠い側/背後にある天体は遮蔽しない
  const occluderDist = len(toOccluder);
  if (occluderDist <= occluder.radius) return 0; // 天体の内側なら太陽は見えない
  // LEO のように天体のすぐ近くでは R/d が 1 に近づくので、視半径は asin を取る
  // (小角近似のままだと地球の影の境界が数十度ずれる)。
  const occAngRadius = Math.asin(occluder.radius / occluderDist);
  const sep = Math.acos(Math.min(1, Math.max(-1, dot(sunDir, scale(toOccluder, 1 / occluderDist)))));
  const overlap = circleOverlapArea(sunAngRadius, occAngRadius, sep);
  return 1 - overlap / (Math.PI * sunAngRadius * sunAngRadius);
}

// 位置 r における日照率 0..1。attractors は遮蔽しうる全天体(恒星自身は無視する)。
// 複数天体による遮蔽は各々の減光率の積で合成する — 2天体が同時に太陽面へ重なって
// 掩蔽し合う状況は現実的に起きないため、重なり領域を厳密に扱うより素直な近似とした。
export function sunlitFactor(r: Vec3, star: Attractor, attractors: readonly Attractor[]): number {
  const toStar = sub(star.state.r, r);
  const sunDist = len(toStar);
  if (sunDist < 1) return 1; // 位置が恒星に一致(退化)
  const sunDir = scale(toStar, 1 / sunDist);
  const sunAngRadius = Math.asin(Math.min(1, star.radius / sunDist));

  let lit = 1;
  for (const occluder of attractors) {
    lit *= occludedFraction(r, sunDir, sunDist, sunAngRadius, occluder);
  }
  return Math.min(1, Math.max(0, lit));
}
