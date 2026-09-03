// 点群 1 つぶんの軌道要素と、その位置評価。星系ごとの分布定義とは独立で、群がどう作られたかを
// 知らない。THREE 非依存に保つ(生成側・表示側の双方がここを読む)。
import { Q_ECLY_TO_ECI } from '../../physics/ecliptic';
import { positionFromOrbitalElements, trueAnomalyFromMean } from '../../physics/elements';
import { qRotate } from '../../math/quat';
import { Vec3 } from '../../math/vec3';

// 1点の軌道。平均運動を要素と一緒に持つのは、位置評価が毎フレーム全点に及ぶため
// (a から毎回 sqrt を引くのを避ける)。
export type PointElements = {
  readonly a: number; // 軌道長半径 [m]
  readonly e: number;
  readonly inc: number; // 黄道面に対する傾斜 [rad]
  readonly raan: number; // 昇交点黄経 [rad]
  readonly lonPeri: number; // 近点黄経 ϖ [rad]
  readonly l0: number; // t=0 の平均黄経 [rad]
  readonly meanMotion: number; // 平均黄経の変化率 [rad/s]
};

// 生成済みの点群 1 群。drawRadius と color は群ごとの見た目で、内側の群(メインベルト)と
// 外側の群(カイパーベルト)とでは見合う大きさ・色が一桁変わるため群ごとに持つ。
export type PointFieldGroup = {
  readonly id: string;
  readonly points: readonly PointElements[];
  readonly drawRadius: number; // [m]
  readonly color: number;
};

export type PointField = readonly PointFieldGroup[];

// 時刻 t の中心天体基準の位置 [m]。ECI 化(中心天体の ECI 位置を足す)は呼び出し側の仕事。
export function pointPositionAt(el: PointElements, t: number): Vec3 {
  const m = el.l0 + el.meanMotion * t - el.lonPeri;
  const nu = trueAnomalyFromMean(m, el.e);
  const p = positionFromOrbitalElements(el.a, el.e, el.inc, el.raan, el.lonPeri - el.raan, nu);
  return qRotate(Q_ECLY_TO_ECI, p);
}
