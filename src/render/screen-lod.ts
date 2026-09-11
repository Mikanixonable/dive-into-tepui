// 見かけの大きさ [px] から詳細度を決める純関数群。THREE にも game/・physics/ の座標型にも
// 依存しない(引数はスカラーのみ)。m → px の換算は math/projection.ts の apparentSizePx。

export interface SphereLodLevel {
  readonly widthSegments: number;
  readonly heightSegments: number;
}

// 4:3(横×縦)を保った固定3段。最上段の 384×288 は見かけ直径 6万px まで下記の誤差
// 上限を満たすので、天体が画面をはみ出して写る状況にも余裕がある。
export const SPHERE_LOD_LADDER: readonly SphereLodLevel[] = [
  { widthSegments: 64, heightSegments: 48 },
  { widthSegments: 160, heightSegments: 120 },
  { widthSegments: 384, heightSegments: 288 },
];

const SILHOUETTE_ERROR_PX = 1;
// 退出時は許容誤差の半分まで粗い段の誤差が下がってから戻す。1pxの許容境界を跨いだだけで
// 戻さないための帯だが、画面上で意味のない大きな固定マージンではなく、同じ誤差モデルから導く。
const HYSTERESIS_EXIT_ERROR_FRACTION = 0.5;

// 分割数 widthSegments の球を平面近似したときのシルエットのたるみ(弧と弦の最大差)
// ≈ R·(π/N)²/2 を、見かけ直径 diameterPx の下で px 換算する。R/metersPerPixel =
// diameterPx/2 の関係だけで metersPerPixel を経由せずに求まる: たるみ[px] = (π/N)²·diameterPx/4。
function silhouetteSagPx(widthSegments: number, apparentDiameterPx: number): number {
  const t = Math.PI / widthSegments;
  return (t * t * apparentDiameterPx) / 4;
}

// 指定したシルエット誤差へ収まる見かけ直径の上限 [px]。sphereLodLevel とヒステリシスが
// 同じ幾何式を使うため、段を追加しても境界の導出を個別に書き直さずに済む。
function diameterForSilhouetteError(widthSegments: number, errorPx: number): number {
  return (4 * errorPx) / ((Math.PI / widthSegments) ** 2);
}

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
  // 不正な射影値は最小の描画段へ倒す。+Infinityだけは「無限に寄った」と解釈して最細段へ送る。
  if (Number.isNaN(apparentDiameterPx)) return SPHERE_LOD_LADDER[0]!;
  return (
    SPHERE_LOD_LADDER.find((level) => silhouetteSagPx(level.widthSegments, apparentDiameterPx) <= SILHOUETTE_ERROR_PX)
    // 最上段でも上限を満たせないほど寄られたときは、持っている中で最も細かい段を使う。
    ?? SPHERE_LOD_LADDER[SPHERE_LOD_LADDER.length - 1]!
  );
}

// 前回選択した段を受け取り、境界にヒステリシスを適用して次の段を純粋に選ぶ。
// activeLevel は呼び出し側が所有する状態であり、この関数は隠れた可変状態を持たない。enabled=false
// は雲をオフにした状態で、表面rendererが次回の有効化時に null から初期選択をやり直せるようにする。
export function sphereLodLevelWithHysteresis(
  apparentDiameterPx: number,
  activeLevel: SphereLodLevel | null,
  enabled = true,
): SphereLodLevel | null {
  if (!enabled) return null;
  if (Number.isNaN(apparentDiameterPx)) return SPHERE_LOD_LADDER[0]!;
  if (activeLevel === null) return sphereLodLevel(apparentDiameterPx);

  const activeIndex = SPHERE_LOD_LADDER.indexOf(activeLevel);
  if (activeIndex < 0) return sphereLodLevel(apparentDiameterPx);

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

/** 環バンドの見かけ幅が1pxを下回る割合(画面被覆率)。1pxを下回っても総光量が増えないよう、線表示側の重みに使う。 */
export function ringPixelCoverage(widthMeters: number, metersPerPixel: number): number {
  if (!(widthMeters > 0) || !(metersPerPixel > 0)) return 0;
  return Math.max(0, Math.min(1, widthMeters / metersPerPixel));
}

// この px を下回ったら、天体を球体として描く価値がない(輝点表示を持つ天体はそちらへ、
// 持たない天体は非表示へ譲る)。
const PHYSICAL_DIAMETER_THRESHOLD_PX = 2;

/** 見かけ直径 [px] が、天体を球体として描くに値するか。 */
export function showsPhysicalSphere(apparentDiameterPx: number): boolean {
  return apparentDiameterPx >= PHYSICAL_DIAMETER_THRESHOLD_PX;
}
