// 位置 r における日照率。天体暦(いつどこにいるか)ではなく、pivot で引いた各天体の位置と
// 半径から求める幾何。恒星・遮蔽天体をともに球とみなし、
// r から見た太陽円盤と遮蔽天体円盤の重なり面積比で減光率を出す — 本影(重なり=太陽円盤全体)・
// 金環(遮蔽円盤が太陽円盤に内包)・半影(部分的に重なる)・完全日照(重なり無し)が場合分け
// 無しに1つの閉じた式から出る。
import type { CelestialMotion } from './celestial-motion';
import { Vec3 } from '../math/vec3';

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

// r から見た太陽円盤のうち occluder に遮られていない面積比(0..1)。sunDir は太陽方向の単位
// ベクトルを成分で、sinSunAng は sin(sunAngRadius)。毎ステップ全エンティティぶん、遮蔽体の
// 数だけ走る経路なので、中間の Vec3 を作らずスカラで畳む。
function occludedFraction(
  r: Vec3,
  sunDirX: number, sunDirY: number, sunDirZ: number,
  sunDist: number, sinSunAng: number, sunAngRadius: number,
  occluder: CelestialMotion, pivot: number,
): number {
  if (occluder.kind === 'star' || occluder.def.radius <= 0) return 1; // 恒星自身・半径0の天体は遮蔽器にしない
  const b = occluder.positionAt(pivot);
  const dx = b.x - r.x, dy = b.y - r.y, dz = b.z - r.z;
  const along = dx * sunDirX + dy * sunDirY + dz * sunDirZ;
  if (along <= 0 || along >= sunDist) return 1; // 艦より太陽から遠い側/背後にある天体は遮蔽しない
  const distSq = dx * dx + dy * dy + dz * dz;
  const dist = Math.sqrt(distSq);
  if (dist <= occluder.def.radius) return 0; // 天体の内側なら太陽は見えない
  // 太陽線からの垂直距離が両円盤の視半径の和を超えていれば、重なりようがない。sin は
  // [0, π/2] で劣加法的(sin(a+b) ≤ sin a + sin b)なので、sin で測ったまま比べれば
  // 逆三角関数を通さずに安全側で落とせる — along > 0 なので離角は π/2 未満。
  const reach = sinSunAng * dist + occluder.def.radius;
  if (distSq - along * along > reach * reach) return 1;
  // LEO のように天体のすぐ近くでは R/d が 1 に近づくので、視半径は asin を取る
  // (小角近似のままだと地球の影の境界が数十度ずれる)。
  const occAngRadius = Math.asin(occluder.def.radius / dist);
  const sep = Math.acos(Math.min(1, Math.max(-1, along / dist)));
  const overlap = circleOverlapArea(sunAngRadius, occAngRadius, sep);
  return 1 - overlap / (Math.PI * sunAngRadius * sunAngRadius);
}

// r のまわりへ body が落としうる影の濃さの上限 0..1。両円盤が最も都合よく重なったとき —
// すなわち視半径の比の二乗(遮蔽円盤が恒星円盤を覆いきるなら 1)— を返すので、**この値が
// 小さい天体は、r のまわりのどこにも絵に出るほどの影を落とせない。**
//
// 上限は r と body の距離だけで決まる。r から見て body が恒星の手前にあるかどうかで値が
// 変わると、body 自身の夜側のように影の落ちた先が見えている位置関係でも 0 になってしまう。
// 恒星自身と半径 0 の天体は遮蔽器にならず、天体の内側からは恒星が完全に隠れる。
export function maxOccludedFraction(
  r: Vec3, star: CelestialMotion, body: CelestialMotion, pivot: number,
): number {
  if (body.kind === 'star' || body.def.radius <= 0) return 0;
  const s = star.positionAt(pivot);
  const tx = s.x - r.x, ty = s.y - r.y, tz = s.z - r.z;
  const sunDist = Math.sqrt(tx * tx + ty * ty + tz * tz);
  if (sunDist < 1) return 0; // 位置が恒星に一致(退化)
  const b = body.positionAt(pivot);
  const dx = b.x - r.x, dy = b.y - r.y, dz = b.z - r.z;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (dist <= body.def.radius) return 1;
  const occAngRadius = Math.asin(body.def.radius / dist);
  const sunAngRadius = Math.asin(Math.min(1, star.def.radius / sunDist));
  return Math.min(1, (occAngRadius / sunAngRadius) ** 2);
}

// 位置 r における日照率 0..1。celestialBodies は遮蔽しうる全天体(恒星自身は無視する)。
// 複数天体による遮蔽は各々の減光率の積で合成する — 2天体が同時に太陽面へ重なって
// 掩蔽し合う状況は現実的に起きないため、重なり領域を厳密に扱うより素直な近似とした。
export function sunlitFactor(
  r: Vec3, star: CelestialMotion, celestialBodies: readonly CelestialMotion[], pivot: number,
): number {
  const s = star.positionAt(pivot);
  const tx = s.x - r.x, ty = s.y - r.y, tz = s.z - r.z;
  const sunDist = Math.sqrt(tx * tx + ty * ty + tz * tz);
  if (sunDist < 1) return 1; // 位置が恒星に一致(退化)
  const inv = 1 / sunDist;
  const sinSunAng = Math.min(1, star.def.radius / sunDist);
  const sunAngRadius = Math.asin(sinSunAng);

  let lit = 1;
  for (const occluder of celestialBodies) {
    lit *= occludedFraction(
      r, tx * inv, ty * inv, tz * inv, sunDist, sinSunAng, sunAngRadius, occluder, pivot);
    if (lit === 0) return 0; // 本影に入った時点で、以降の遮蔽体を見ても答えは変わらない
  }
  return Math.min(1, Math.max(0, lit));
}
