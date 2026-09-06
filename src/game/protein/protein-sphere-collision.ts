// 主鎖を球の数珠つなぎで覆い、その列で静止球・掃引球との接触を判定する。表示形態に依らない
// 形なので、球列はアセットごとに1度組めば足りる。
import { add, addScaled, lenSq, norm, scale, sub, v3, type Vec3 } from '../../math/vec3';
import { qInvert, qRotate, type Quat } from '../../math/quat';
import { kinematicState, type KinematicState } from '../../physics/kinematic-state';
import { linearSphereContact } from '../../physics/sphere-contact';
import type { SphereHit } from '../../math/triangle-mesh';
import type { ProteinBackboneAsset } from '../../render/protein-enemy-ship';

// 主鎖の折れ線を覆うのに要る余裕 [Å]。表示リボンの断面(半幅 1.0・半厚 0.16)の半対角で、
// coil の管の半径 0.38 より大きいのでこれで両方を覆う。
const RIBBON_SECTION_HALF_DIAGONAL = Math.hypot(1.0, 0.16);

// これを超えて隣の残基へ飛ぶところは、主鎖が途切れているとみなす [Å]。
const CHAIN_BREAK_DISTANCE = 8;

// 球1個の半径の上限を、アセットの外接半径の何分の1に取るか。球の列は曲がった主鎖を覆う
// ぶんだけ輪郭の外へ膨らむので、この値がそのまま「見えている構造より外で弾が当たる距離」を
// 決める。1/4 での膨らみは中央 3.8〜10.0 m・最大 15.6 m。
const SPHERE_RADIUS_DIVISOR = 4;

/** 判定用の球1個。中心・半径とも敵ローカル座標(表示リボンと同じ単位)。 */
export interface ProteinCollisionSphere {
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
  readonly radius: number;
}

/**
 * 主鎖を球の数珠つなぎで覆う。隣り合う球は残基を1つ共有するので、球の和は主鎖の折れ線を
 * 切れ目なく含む。アセットごとに1度だけ呼ぶ。
 */
export function buildProteinCollisionSpheres(
  backbone: ProteinBackboneAsset,
  coordinateScale: number,
): readonly ProteinCollisionSphere[] {
  const coordinates = backbone.backboneCoordinates;
  // 半径の上限は球列より先に主鎖の座標だけから決める — 球列から外接半径を採ると循環する。
  const radiusLimit = backboneOuterRadius(backbone) / SPHERE_RADIUS_DIVISOR;
  const spheres: ProteinCollisionSphere[] = [];

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
        // 上限を超えても、2残基目までは必ず飲む — 1残基しか含まない球は隣と残基を共有できず、
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

/** 球列を敵の位置・姿勢へ当てて接触を返す。個体ごとに作ってよい(球列は共有する)。 */
export class ProteinSphereCollisionGeometry {
  /** 全球を覆うワールド外接半径 [m]。ProteinEnemy の radius はこれを使う。 */
  public readonly outerRadius: number;

  // 敵ローカルの向きのまま [m] へ直した球列。姿勢だけを掛ければワールドと比べられるので、
  // 判定の中で長さを割り戻さない。
  private readonly spheres: readonly ProteinCollisionSphere[];

  /** 敵ローカルの球列と、そこからワールドへ掛かる一様倍率を受ける。 */
  public constructor(spheres: readonly ProteinCollisionSphere[], rootScale: number) {
    this.spheres = spheres.map((sphere) => ({
      cx: sphere.cx * rootScale,
      cy: sphere.cy * rootScale,
      cz: sphere.cz * rootScale,
      radius: sphere.radius * rootScale,
    }));
    let outerRadius = 0;
    for (const sphere of this.spheres) {
      outerRadius = Math.max(outerRadius, Math.hypot(sphere.cx, sphere.cy, sphere.cz) + sphere.radius);
    }
    this.outerRadius = outerRadius;
  }

  /** ECI 上の球と現在姿勢の球列の最深接触を返す。 */
  public testSphereCollision(
    sphereCenter: Vec3, sphereRadius: number, center: Vec3, att: Quat,
  ): SphereHit | null {
    const offset = sub(sphereCenter, center);
    const outerReach = this.outerRadius + sphereRadius;
    if (lenSq(offset) > outerReach * outerReach) return null;

    const local = qRotate(qInvert(att), offset);
    let deepest: ProteinCollisionSphere | null = null;
    let deepestDepth = 0;
    for (const sphere of this.spheres) {
      const dx = local.x - sphere.cx;
      const dy = local.y - sphere.cy;
      const dz = local.z - sphere.cz;
      const depth = sphere.radius + sphereRadius - Math.hypot(dx, dy, dz);
      if (!(depth > deepestDepth)) continue;
      deepest = sphere;
      deepestDepth = depth;
    }
    if (deepest === null) return null;

    // 法線は球の中心から相手へ向く。中心がちょうど重なった相手では向きが定まらないので、
    // norm がゼロを返して押し戻しも反発も起きない。
    const localNormal = norm(v3(local.x - deepest.cx, local.y - deepest.cy, local.z - deepest.cz));
    const localPoint = v3(
      deepest.cx + localNormal.x * deepest.radius,
      deepest.cy + localNormal.y * deepest.radius,
      deepest.cz + localNormal.z * deepest.radius,
    );
    return {
      point: add(center, qRotate(att, localPoint)),
      normal: qRotate(att, localNormal),
      depth: deepestDepth,
    };
  }

  /** 移動する球が球列を最初に横切る時刻を、球ごとの二次方程式から返す。 */
  public testSweptSphereCollision(
    previousSphereCenter: Vec3, sphereCenter: Vec3, sphereRadius: number,
    previousSelfState: KinematicState, selfState: KinematicState, att: Quat,
  ): { readonly hit: SphereHit; readonly toi: number } | null {
    const duration = selfState.t - previousSelfState.t;
    if (!(duration > 0)) return null;

    // 始点で既に重なっているなら、跨ぎは区間の内側に無い。
    const initial = this.testSphereCollision(
      previousSphereCenter, sphereRadius, previousSelfState.r, att,
    );
    if (initial !== null) return { hit: initial, toi: 0 };

    // 棄却は敵ローカルで済ませ、生き残った球だけを ECI へ持ち上げる。
    const inverse = qInvert(att);
    const localStart = qRotate(inverse, sub(previousSphereCenter, previousSelfState.r));
    const localEnd = qRotate(inverse, sub(sphereCenter, selfState.r));
    const selfVelocity = scale(sub(selfState.r, previousSelfState.r), 1 / duration);
    const sphereVelocity = scale(sub(sphereCenter, previousSphereCenter), 1 / duration);
    const sweepStart = kinematicState<'eci'>(previousSelfState.t, previousSphereCenter, sphereVelocity);
    const sweepEnd = kinematicState<'eci'>(selfState.t, sphereCenter, sphereVelocity);

    let nearest: { readonly hit: SphereHit; readonly toi: number } | null = null;
    for (const sphere of this.spheres) {
      const reach = sphere.radius + sphereRadius;
      if (!(segmentSphereDistanceSq(localStart, localEnd, sphere) < reach * reach)) continue;
      const offsetToCenter = qRotate(att, v3(sphere.cx, sphere.cy, sphere.cz));
      const centerStart = kinematicState<'eci'>(
        previousSelfState.t, add(previousSelfState.r, offsetToCenter), selfVelocity);
      const centerEnd = kinematicState<'eci'>(
        selfState.t, add(selfState.r, offsetToCenter), selfVelocity);
      const contact = linearSphereContact(centerStart, centerEnd, sweepStart, sweepEnd, reach);
      // 始点の重なりは上で除いてあるので、跨ぎは必ず外から内への1本。
      if (contact === null || contact.startsInside || contact.crossing === null) continue;
      const { toi, normal } = contact.crossing;
      if (nearest !== null && toi >= nearest.toi) continue;
      const center = addScaled(centerStart.r, sub(centerEnd.r, centerStart.r), toi);
      // TOI では2球が接するだけなので、押し戻し量は 0 になる。反発は法線と相対速度で決まる。
      nearest = { hit: { point: addScaled(center, normal, sphere.radius), normal, depth: 0 }, toi };
    }
    return nearest;
  }
}

// 外接箱の半対角に、リボン断面ぶんの余裕を足した半径 [Å]。
function boxSphereRadius(width: number, height: number, depth: number): number {
  return Math.hypot(width, height, depth) / 2 + RIBBON_SECTION_HALF_DIAGONAL;
}

// 全残基からモデル原点までの最大距離 [Å]。
function backboneOuterRadius(backbone: ProteinBackboneAsset): number {
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

// 主鎖を、鎖が変わるところと隣の残基まで飛ぶところで区間 [begin, end) へ分ける。二次構造の
// 境界では分けない — 断面が変わるのは表示の都合で、判定には要らない。
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

// 線分と球の中心の最短距離の2乗。棄却の判定にしか使わないので Vec3 を1つも作らない。
function segmentSphereDistanceSq(start: Vec3, end: Vec3, sphere: ProteinCollisionSphere): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const dz = end.z - start.z;
  const px = sphere.cx - start.x;
  const py = sphere.cy - start.y;
  const pz = sphere.cz - start.z;
  const lengthSq = dx * dx + dy * dy + dz * dz;
  const t = lengthSq > 0 ? Math.min(1, Math.max(0, (px * dx + py * dy + pz * dz) / lengthSq)) : 0;
  const qx = px - dx * t;
  const qy = py - dy * t;
  const qz = pz - dz * t;
  return qx * qx + qy * qy + qz * qz;
}
