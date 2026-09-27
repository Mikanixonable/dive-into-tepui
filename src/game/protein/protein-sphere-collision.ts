// 主鎖を球の数珠つなぎで覆う球列を組む。表示形態に依らない形なので、球列はアセットごとに
// 1度組めば足りる。
import type { CollisionSphere } from '../dynamic/sphere-chain-collision';
import type { ProteinBackboneAsset } from '../../render/protein/protein-render-definition';

// 主鎖の折れ線を覆うのに要る余裕 [Å]。表示リボンの断面(半幅 1.0・半厚 0.16)の半対角で、
// coil の管の半径 0.38 より大きいのでこれで両方を覆う。
const RIBBON_SECTION_HALF_DIAGONAL = Math.hypot(1.0, 0.16);

// これを超えて隣の残基へ飛ぶところは、主鎖が途切れているとみなす [Å]。
const CHAIN_BREAK_DISTANCE = 8;

// 球1個の半径の上限を、アセットの外接半径の何分の1に取るか。球の列は曲がった主鎖を覆う
// ぶんだけ輪郭の外へ膨らむので、この値がそのまま「見えている構造より外で弾が当たる距離」を
// 決める。1/4 での膨らみは中央 3.8〜10.0 m・最大 15.6 m。
const SPHERE_RADIUS_DIVISOR = 4;


/**
 * 主鎖を球の数珠つなぎで覆う。隣り合う球は残基を1つ共有するので、球の和は主鎖の折れ線を
 * 切れ目なく含む。アセットごとに1度だけ呼ぶ。
 */
export function buildProteinCollisionSpheres(
  backbone: ProteinBackboneAsset,
  coordinateScale: number,
): readonly CollisionSphere[] {
  const coordinates = backbone.backboneCoordinates;
  // 半径の上限は球列より先に主鎖の座標だけから決める — 球列から外接半径を採ると循環する。
  const radiusLimit = backboneOuterRadius(backbone) / SPHERE_RADIUS_DIVISOR;
  const spheres: CollisionSphere[] = [];

  for (const run of backboneRuns(backbone)) {
    let first = run.begin;
    for (;;) {
      // 外接箱は残基を足すたびに更新する。球ごとに区間を舐め直すと残基数の2乗になる。
      const head = first * 3;
      let minX = coordinates[head]!;
      let minY = coordinates[head + 1]!;
      let minZ = coordinates[head + 2]!;
      let maxX = minX;
      let maxY = minY;
      let maxZ = minZ;
      let last = first;
      while (last + 1 < run.end) {
        const offset = (last + 1) * 3;
        const nextMinX = Math.min(minX, coordinates[offset]!);
        const nextMinY = Math.min(minY, coordinates[offset + 1]!);
        const nextMinZ = Math.min(minZ, coordinates[offset + 2]!);
        const nextMaxX = Math.max(maxX, coordinates[offset]!);
        const nextMaxY = Math.max(maxY, coordinates[offset + 1]!);
        const nextMaxZ = Math.max(maxZ, coordinates[offset + 2]!);
        const grown = boxSphereRadius(nextMaxX - nextMinX, nextMaxY - nextMinY, nextMaxZ - nextMinZ);
        // 上限を超えても、2残基目までは必ず含める — 1残基しか含まない球は隣と残基を共有できず、
        // 間の線分がどの球にも入らなくなる。
        if (last > first && grown > radiusLimit) break;
        minX = nextMinX;
        minY = nextMinY;
        minZ = nextMinZ;
        maxX = nextMaxX;
        maxY = nextMaxY;
        maxZ = nextMaxZ;
        last++;
      }
      spheres.push({
        cx: (minX + maxX) / 2 * coordinateScale,
        cy: (minY + maxY) / 2 * coordinateScale,
        cz: (minZ + maxZ) / 2 * coordinateScale,
        radius: boxSphereRadius(maxX - minX, maxY - minY, maxZ - minZ) * coordinateScale,
      });
      if (last + 1 >= run.end) break;
      // 次の球は前の球の最後の残基から始める。
      first = last;
    }
  }
  return spheres;
}

// 外接箱の半対角に、リボン断面ぶんの余裕を足した半径 [Å]。
function boxSphereRadius(width: number, height: number, depth: number): number {
  return Math.hypot(width, height, depth) / 2 + RIBBON_SECTION_HALF_DIAGONAL;
}

// 全残基からモデル原点までの最大距離 [Å]。
function backboneOuterRadius(backbone: ProteinBackboneAsset): number {
  // 座標は残基ごとに xyz の3つ組で並ぶ
  const coordinates = backbone.backboneCoordinates;
  let outerRadius = 0;
  for (let index = 0; index < backbone.backboneCount; index++) {
    const offset = index * 3;
    outerRadius = Math.max(
      outerRadius,
      Math.hypot(coordinates[offset]!, coordinates[offset + 1]!, coordinates[offset + 2]!),
    );
  }
  return outerRadius;
}

// 主鎖を、鎖が変わるところと隣の残基まで飛ぶところで区間 [begin, end) へ分ける。
function backboneRuns(
  backbone: ProteinBackboneAsset,
): readonly { readonly begin: number; readonly end: number }[] {
  const runs: { begin: number; end: number }[] = [];
  for (let index = 0; index < backbone.backboneCount; index++) {
    const current = runs[runs.length - 1];
    if (current !== undefined && continuesRun(backbone, index)) current.end = index + 1;
    else runs.push({ begin: index, end: index + 1 });
  }
  return runs;
}

// index の残基が直前の残基と同じ区間に属するか。
function continuesRun(backbone: ProteinBackboneAsset, index: number): boolean {
  if (backbone.backboneChains[index] !== backbone.backboneChains[index - 1]) return false;
  const coordinates = backbone.backboneCoordinates;
  const offset = index * 3;
  const step = Math.hypot(
    coordinates[offset]! - coordinates[offset - 3]!,
    coordinates[offset + 1]! - coordinates[offset - 2]!,
    coordinates[offset + 2]! - coordinates[offset - 1]!,
  );
  return step <= CHAIN_BREAK_DISTANCE;
}

