// 天体の地表へ固定する錨と、その錨から各時刻の船体姿勢(組立原点の位置・速度と姿勢)を
// 解析的に導く計算。錨の値は天体固定系(自転に固定した子午線基準系)で持ち、相手の天体は
// id で指す — どの天体にも同じ形で使え、月は最初の適用先である(GAME.md 7.4)。
import { LOCAL_FORWARD, qFromBasis, qInvert, qMul, qRotate, type Quat } from '../../math/quat';
import { add, cross, scale, v3, type Vec3 } from '../../math/vec3';
import type { CelestialBody } from '../../physics/celestial-body';
import { kinematicState, type KinematicState } from '../../physics/kinematic-state';
import type { ShipAssembly } from './ship-assembly';

// 地表固定の錨。offset は天体中心から組立原点までの変位 [m]、orientation は組立原点の姿勢で、
// どちらも天体固定系の値。そのまま直列化できる JSON の素の値だけで組む。
export interface SurfaceAnchor {
  readonly bodyId: string;
  readonly offset: Vec3;
  readonly orientation: Quat;
}

// 錨から導いた、その時刻の船体の置かれ方。state は重心の運動状態、q と w は船体の姿勢と
// 船体座標系での角速度 [rad/s]。
export interface SurfaceAnchorPose {
  readonly state: KinematicState;
  readonly q: Quat;
  readonly w: Vec3;
}

// 緯度 latRad・経度 lonRad [rad] の地表に、船体の +Z(船首方向)を地表の外向き、+Y を北向きに
// 立てた錨。originHeight は組立原点の地表からの高さ [m]。天体固定系の軸は x が本初子午線、
// y が東、z が自転軸である(physics/body-orientation の子午線基準系)。
export function surfaceAnchorAtLatLon(
  bodyId: string, radius: number, latRad: number, lonRad: number, originHeight: number,
): SurfaceAnchor {
  const cosLat = Math.cos(latRad);
  // その地点の外向き(動径方向)と北向きを、天体固定系で表す。
  const radial = v3(cosLat * Math.cos(lonRad), cosLat * Math.sin(lonRad), Math.sin(latRad));
  const north = v3(-Math.sin(latRad) * Math.cos(lonRad), -Math.sin(latRad) * Math.sin(lonRad), Math.cos(latRad));
  return {
    bodyId,
    offset: scale(radial, radius + originHeight),
    orientation: qFromBasis(radial, north),
  };
}

// 組立原点の地表からの高さ [m]。船体を +Z を外向きに立てたとき、地表に接する最も低い
// module の下端までの距離で、module を円筒とみて軸の傾きから軸方向と直径方向へ配分する。
export function assemblyOriginHeight(assembly: ShipAssembly): number {
  let lowest = 0;
  for (const id of assembly.moduleIds) {
    const transform = assembly.worldTransformOf(id);
    const definition = assembly.definition(id);
    if (transform === null || definition === null) continue;
    // module の軸が船体の +Z となす角で、その module の下端の深さを求める。
    const axisZ = qRotate(transform.rotation, LOCAL_FORWARD);
    const halfDepth = Math.abs(axisZ.z) * definition.length / 2
      + Math.sqrt(Math.max(0, 1 - axisZ.z * axisZ.z)) * definition.diameter / 2;
    lowest = Math.min(lowest, transform.position.z - halfDepth);
  }
  return -lowest;
}

// 時刻 t における錨の姿勢。centerOffset は組立原点から重心までの変位 [m](船体座標系)。
// 天体が自転モデルを持たなければ、自転しないものとして扱う。
export function surfaceAnchorPose(
  anchor: SurfaceAnchor, body: CelestialBody, t: number, centerOffset: Vec3,
): SurfaceAnchorPose {
  const spin = body.spinRotationAt(t);
  const spinQ = spin?.q ?? { x: 0, y: 0, z: 0, w: 1 };
  const omega = spin?.omega ?? v3();
  const bodyState = body.stateAt(t);
  // 組立原点を天体の自転へ載せ、そこから重心までの変位を船体の回転で写す。
  const originOffset = qRotate(spinQ, anchor.offset);
  const q = qMul(spinQ, anchor.orientation);
  const centerOffsetEci = qRotate(q, centerOffset);
  const originPosition = add(bodyState.r, originOffset);
  const originVelocity = add(bodyState.v, cross(omega, originOffset));
  return {
    state: kinematicState<'eci'>(
      t,
      add(originPosition, centerOffsetEci),
      add(originVelocity, cross(omega, centerOffsetEci)),
    ),
    q,
    w: qRotate(qInvert(q), omega),
  };
}
