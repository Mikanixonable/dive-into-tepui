// 影のスロットに要る細かさと、その枠を置く場所を、受け手の側から決める純関数群。THREE にも
// game/・physics/ の座標型にも依存しない(引数はスカラーのみ)。
//
// **粗が見えるのは受け手がカメラに近いときであって、遮蔽器が近いときではない。** 平行投影では
// 影の実寸は遮蔽器の実寸に等しいので、画面上の粗さは影が落ちる面までの距離だけで決まる。
// 遮蔽器も受け手も外接球で近似する — 偽陽性は「余分に細かい枠を作る」側へ倒れるので安全。
import { metersPerPixelAtDepth } from '../math/projection';

/**
 * 受け手が要求する texel の実寸 [m]。小さいほど厳しい。texelsPerPixel は画面 1 px あたり何 texel
 * を目標にするかで、1 なら「影の texel が画面 1 px を超えない」。surfaceDistance はカメラから
 * 受け手の表面までの**真の距離**で、カメラ前方への射影距離ではない — 射影距離だと背後や真横の
 * 受け手が 0 へ潰れ、要求が無限に厳しくなる。
 */
export function requiredTexel(
  surfaceDistance: number, cameraNear: number, fovDeg: number, viewportHeight: number,
  texelsPerPixel: number,
): number {
  const surface = Math.max(surfaceDistance, cameraNear);
  return metersPerPixelAtDepth(fovDeg, surface, Math.max(1, viewportHeight)) / texelsPerPixel;
}

/**
 * 半径 casterRadius の遮蔽器の影が、中心差 (dx, dy, dz) の位置にある半径 receiverRadius の
 * 受け手へ届くか。(lx, ly, lz) は遮蔽器の位置で光が進む向き(単位ベクトル)。
 * columnSpan は本影が消えるまでの距離を遮蔽器の差し渡しの何倍に取るか。
 *
 * **自分自身(差 0)にも真を返す** — 自己遮蔽がいちばん頻度の高い経路である。
 */
export function castsOnto(
  dx: number, dy: number, dz: number, casterRadius: number, receiverRadius: number,
  lx: number, ly: number, lz: number, columnSpan: number,
): boolean {
  const reach = casterRadius + receiverRadius;
  const along = dx * lx + dy * ly + dz * lz;
  if (along < -reach || along > columnSpan * 2 * casterRadius) return false;
  const perpSq = dx * dx + dy * dy + dz * dz - along * along;
  return perpSq <= reach * reach;
}

/** 要求 texel [m] を満たす枠の半径 [m]。平行投影なので深度は要らない。 */
export function extentForTexel(texel: number, slotSize: number): number {
  return (slotSize * texel) / 2;
}

/**
 * 点 (px, py, pz) が箱の内側にあるか。境界上は内側と数える。
 */
export function insideBox(
  px: number, py: number, pz: number,
  minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number,
): boolean {
  return px >= minX && px <= maxX && py >= minY && py <= maxY && pz >= minZ && pz <= maxZ;
}

/**
 * 窓の中心の 1 軸ぶん。retreat が真なら [min, max] の中点、偽なら p を [min, max] へ丸めた値。
 *
 * **カメラが箱の内側にあるときは retreat を立てる** — 丸めた値はカメラ位置そのものになるが、
 * そこに遮蔽器は無いので、窓の中心にすると必ず空を撮る。
 */
export function anchorAxis(p: number, min: number, max: number, retreat: boolean): number {
  if (retreat) return (min + max) / 2;
  return Math.min(Math.max(p, min), max);
}
