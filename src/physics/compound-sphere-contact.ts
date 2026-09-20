// 複数の局所球を、剛体の重心まわりの回転を含む保守的な球へ広げて掃引する。
// 円柱そのものの接触を確定するモジュールではなく、exact な形状判定へ進む必要が
// ある区間だけを選ぶための純粋な幾何を担当する。
import type { KinematicState } from './kinematic-state';
import { linearSphereContact, sweptSphereContact } from './sphere-contact';
import { len, type Vec3 } from '../math/vec3';

export interface CompoundSpherePrimitive {
  readonly moduleId: string;
  /** 重心基準の局所中心 [m]。回転を含む候補判定では距離を半径へ加える。 */
  readonly center: Vec3;
  readonly radius: number;
}

export interface CompoundSphereShape {
  readonly primitives: readonly CompoundSpherePrimitive[];
}

export interface SweptCompoundSphereContact {
  readonly toi: number;
  readonly moduleIdA: string;
}

function finiteVec(value: Vec3): boolean {
  return Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);
}

function finitePrimitive(primitive: CompoundSpherePrimitive): boolean {
  return primitive.moduleId.length > 0
    && finiteVec(primitive.center)
    && Number.isFinite(primitive.radius)
    && primitive.radius > 0;
}

function crossingToi(contact: ReturnType<typeof sweptSphereContact>): number | null {
  if (contact === null) return null;
  if (contact.startsInside) return 0;
  return contact.crossing?.toi ?? null;
}

// 線形経路で解けるときは二次解を先に使う。線形弦が外れていても、回転や加速度を含む
// 曲線経路が球を横切る可能性があるため、そこで判定を打ち切らず曲線解へ戻す。
function sphereProxyToi(
  objectStart: KinematicState,
  objectEnd: KinematicState,
  bodyStart: KinematicState,
  bodyEnd: KinematicState,
  radius: number,
): number | null {
  const linear = linearSphereContact(objectStart, objectEnd, bodyStart, bodyEnd, radius);
  const linearToi = crossingToi(linear);
  if (linearToi !== null) return linearToi;
  return crossingToi(sweptSphereContact(objectStart, objectEnd, bodyStart, bodyEnd, radius));
}

/**
 * surface proxy と天体球の最初の候補時刻を返す。
 * 各局所球は、重心から局所中心までの距離を半径へ加え、任意の姿勢の円柱を内包する。
 * そのためここで候補を落とすことはなく、返った候補は exact narrow phase で再確認する。
 */
export function sweptCompoundSphereContact(
  shape: CompoundSphereShape,
  objectStart: KinematicState,
  objectEnd: KinematicState,
  bodyStart: KinematicState,
  bodyEnd: KinematicState,
  bodyRadius: number,
): SweptCompoundSphereContact | null {
  if (!Number.isFinite(bodyRadius) || bodyRadius < 0 || shape.primitives.length === 0) return null;
  let result: SweptCompoundSphereContact | null = null;
  for (const primitive of shape.primitives) {
    if (!finitePrimitive(primitive)) return null;
    const proxyRadius = bodyRadius + primitive.radius + len(primitive.center);
    if (!Number.isFinite(proxyRadius) || !(proxyRadius > 0)) return null;
    const toi = sphereProxyToi(objectStart, objectEnd, bodyStart, bodyEnd, proxyRadius);
    if (toi === null) continue;
    if (result === null || toi < result.toi
      || (toi === result.toi && primitive.moduleId < result.moduleIdA)) {
      result = { toi, moduleIdA: primitive.moduleId };
    }
  }
  return result;
}
