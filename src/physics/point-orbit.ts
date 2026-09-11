// 点1つぶんの軌道要素と、その時刻での位置評価。要素を時間に対して固定した二体ケプラー軌道
// として評価するので、摂動による要素の永年変化は含まれない。
import { Q_ECLY_TO_ECI } from './ecliptic';
import { positionFromOrbitalElements, trueAnomalyFromMean } from './elements';
import { qRotate } from '../math/quat';
import { Vec3 } from '../math/vec3';

// 1点の軌道。平均運動を要素と一緒に持つのは、位置評価が毎フレーム全点に及ぶため
// (a から毎回 sqrt を引くのを避ける)。
export interface PointElements {
  readonly a: number; // 軌道長半径 [m]
  readonly e: number;
  readonly inc: number; // 黄道面に対する傾斜 [rad]
  readonly raan: number; // 昇交点黄経 [rad]
  readonly lonPeri: number; // 近点黄経 ϖ [rad]
  readonly l0: number; // t=0 の平均黄経 [rad]
  readonly meanMotion: number; // 平均黄経の変化率 [rad/s]
}

// 時刻 t [s] の、中心天体を原点とし ECI の軸をとった位置 [m]。
export function pointPositionAt(el: PointElements, t: number): Vec3 {
  const m = el.l0 + el.meanMotion * t - el.lonPeri;
  const nu = trueAnomalyFromMean(m, el.e);
  const p = positionFromOrbitalElements(el.a, el.e, el.inc, el.raan, el.lonPeri - el.raan, nu);
  return qRotate(Q_ECLY_TO_ECI, p);
}
