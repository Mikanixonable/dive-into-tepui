// 画面上のスケール(metersPerPixel)から詳細度を決める純関数群。THREE にも
// game/・physics/ の座標型にも依存しない(引数はスカラーのみ)。

/** 世界空間の寸法 [m] が、その位置の metersPerPixel の下で画面上何 px になるか。 */
export function apparentSizePx(worldSize: number, metersPerPixel: number): number {
  if (!(metersPerPixel > 0)) return 0;
  return worldSize / metersPerPixel;
}

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

// 分割数 widthSegments の球を平面近似したときのシルエットのたるみ(弧と弦の最大差)
// ≈ R·(π/N)²/2 を、見かけ直径 diameterPx の下で px 換算する。R/metersPerPixel =
// diameterPx/2 の関係だけで metersPerPixel を経由せずに求まる: たるみ[px] = (π/N)²·diameterPx/4。
function silhouetteSagPx(widthSegments: number, apparentDiameterPx: number): number {
  const t = Math.PI / widthSegments;
  return (t * t * apparentDiameterPx) / 4;
}

/** 見かけ直径 [px] から、シルエット誤差が概ね1pxを超えない最小の球分割段を選ぶ。 */
export function sphereLodLevel(apparentDiameterPx: number): SphereLodLevel {
  return (
    SPHERE_LOD_LADDER.find((level) => silhouetteSagPx(level.widthSegments, apparentDiameterPx) <= SILHOUETTE_ERROR_PX)
    // 最上段でも上限を満たせないほど寄られたときは、持っている中で最も細かい段を使う。
    ?? SPHERE_LOD_LADDER[SPHERE_LOD_LADDER.length - 1]!
  );
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
