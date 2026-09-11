// 見かけの大きさ [px] から詳細度(球の分割段・環の被覆率・球として描くか)を決める純関数群。

// 球の分割段。経度方向・緯度方向の分割数。
export interface SphereLodLevel {
  readonly widthSegments: number;
  readonly heightSegments: number;
}

// 分割数 4:3(横×縦)の固定3段。最上段は見かけ直径約 6 万 px までシルエット誤差 1px に収まる。
export const SPHERE_LOD_LADDER: readonly SphereLodLevel[] = [
  { widthSegments: 64, heightSegments: 48 },
  { widthSegments: 160, heightSegments: 120 },
  { widthSegments: 384, heightSegments: 288 },
];

// シルエットの許容誤差 [px]。
const SILHOUETTE_ERROR_PX = 1;
// 粗い段へ戻すのは、粗い段の誤差が許容誤差のこの割合まで下がってから。
const HYSTERESIS_EXIT_ERROR_FRACTION = 0.5;

// 分割数 widthSegments の球のシルエットのたるみ(弧と弦の最大差)[px]。半径 R のたるみ
// R·(π/N)²/2 に R/metersPerPixel = diameterPx/2 を入れて (π/N)²·diameterPx/4。
function silhouetteSagPx(widthSegments: number, apparentDiameterPx: number): number {
  const t = Math.PI / widthSegments;
  return (t * t * apparentDiameterPx) / 4;
}

// 分割数 widthSegments の球のシルエット誤差が errorPx に収まる見かけ直径の上限 [px]。
function diameterForSilhouetteError(widthSegments: number, errorPx: number): number {
  return (4 * errorPx) / ((Math.PI / widthSegments) ** 2);
}

// 隣り合う段の境界の見かけ直径 [px]。enter を超えたら細かい段へ、exit 以下で粗い段へ戻る。
export interface SphereLodTransitionThresholds {
  readonly enterDiameterPx: number;
  readonly exitDiameterPx: number;
}

// coarserIndex の段から次の細かい段へ移る境界。無効な境界は null で返す。
export function sphereLodTransitionThresholds(
  coarserIndex: number,
): SphereLodTransitionThresholds | null {
  if (!Number.isInteger(coarserIndex) || coarserIndex < 0 || coarserIndex >= SPHERE_LOD_LADDER.length - 1) {
    return null;
  }
  const coarser = SPHERE_LOD_LADDER[coarserIndex]!;
  return {
    // 近づくとき: 粗い段のシルエット誤差が1pxを超える直前まで粗い段を使う。
    enterDiameterPx: diameterForSilhouetteError(coarser.widthSegments, SILHOUETTE_ERROR_PX),
    // 遠ざかるとき: 粗い段の誤差が0.5px以下へ下がってから戻す。
    exitDiameterPx: diameterForSilhouetteError(
      coarser.widthSegments, SILHOUETTE_ERROR_PX * HYSTERESIS_EXIT_ERROR_FRACTION,
    ),
  };
}

/** 見かけ直径 [px] から、シルエット誤差が概ね1pxを超えない最小の球分割段を選ぶ。 */
export function sphereLodLevel(apparentDiameterPx: number): SphereLodLevel {
  // NaN は最も粗い段へ倒す(+Infinity は下の既定で最も細かい段になる)。
  if (Number.isNaN(apparentDiameterPx)) return SPHERE_LOD_LADDER[0]!;
  return (
    SPHERE_LOD_LADDER.find((level) => silhouetteSagPx(level.widthSegments, apparentDiameterPx) <= SILHOUETTE_ERROR_PX)
    // 最上段でも上限を満たせないほど寄られたときは、持っている中で最も細かい段を使う。
    ?? SPHERE_LOD_LADDER[SPHERE_LOD_LADDER.length - 1]!
  );
}

// 前回選んだ段 activeLevel(初回は null)から、境界にヒステリシスを掛けて次の段を選ぶ。
// enabled が false なら null を返し、次に有効にしたとき初期選択からやり直させる。
export function sphereLodLevelWithHysteresis(
  apparentDiameterPx: number,
  activeLevel: SphereLodLevel | null,
  enabled = true,
): SphereLodLevel | null {
  if (!enabled) return null;
  if (Number.isNaN(apparentDiameterPx)) return SPHERE_LOD_LADDER[0]!;
  if (activeLevel === null) return sphereLodLevel(apparentDiameterPx);

  // ラダーに無い段を渡されたら、ヒステリシス無しで選び直す。
  const activeIndex = SPHERE_LOD_LADDER.indexOf(activeLevel);
  if (activeIndex < 0) return sphereLodLevel(apparentDiameterPx);

  // 近づいたぶん細かい段へ進め、遠ざかったぶん粗い段へ戻す。
  let index = activeIndex;
  while (index < SPHERE_LOD_LADDER.length - 1) {
    const threshold = sphereLodTransitionThresholds(index)!;
    if (!(apparentDiameterPx > threshold.enterDiameterPx)) break;
    index++;
  }
  while (index > 0) {
    const threshold = sphereLodTransitionThresholds(index - 1)!;
    if (!(apparentDiameterPx <= threshold.exitDiameterPx)) break;
    index--;
  }
  return SPHERE_LOD_LADDER[index]!;
}

/** 環の帯が1画素の幅を覆う割合 [0,1](見かけ幅 [px] を 1 で頭打ち)。幅か換算が正でなければ 0。 */
export function ringPixelCoverage(widthMeters: number, metersPerPixel: number): number {
  if (!(widthMeters > 0) || !(metersPerPixel > 0)) return 0;
  return Math.max(0, Math.min(1, widthMeters / metersPerPixel));
}

// 天体を球体として描く見かけ直径の下限 [px]。
const PHYSICAL_DIAMETER_THRESHOLD_PX = 2;

/** 見かけ直径 [px] が、天体を球体として描くに値するか。 */
export function showsPhysicalSphere(apparentDiameterPx: number): boolean {
  return apparentDiameterPx >= PHYSICAL_DIAMETER_THRESHOLD_PX;
}
