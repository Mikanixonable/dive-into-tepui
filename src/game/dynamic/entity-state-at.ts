// エンティティ・軌道の任意時刻 t における状態を、実測(過去)・保持区間(内挿)・ケプラー外挿の
// 3つを意識せず1呼び出しで答える。伝播そのものは physics/dynamic-trajectory.ts の
// DynamicTrajectory.at / extrapolatedAt を呼ぶだけで、新しい積分・外挿コードは書かない。
import { DynamicTrajectory } from '../../physics/dynamic-trajectory';
import type { CelestialMotion } from '../../physics/celestial-motion';
import { KinematicState } from '../../physics/kinematic-state';
import type { DynamicEntity } from './dynamic-entity/dynamic-entity';

// 外挿の中心天体。運動そのものは ECI を答えないので、ECI 状態を引く口を別に持つ
// (CelestialEntity がこの形を満たす)。
export type OrbitCenter = {
  readonly motion: CelestialMotion;
  stateAt(pivot: number, t: number): KinematicState;
};

// t <= trajectory の現在時刻なら保持区間の内挿(at)、それより先なら center が表す天体
// まわりの二体ケプラー外挿(extrapolatedAt)で答える。両者とも先端以前は内挿に落ちる
// (DynamicTrajectory.extrapolatedAt 自身の契約)ので、ここでは呼び分けを気にせず
// extrapolatedAt を呼ぶだけでよい。center は外挿が必要になったときにだけ引く。
function trajectoryStateAt(
  trajectory: DynamicTrajectory, t: number, center: OrbitCenter,
): KinematicState | null {
  if (t <= trajectory.state.t) return trajectory.at(t);
  return trajectory.extrapolatedAt(t, center.stateAt(t, t));
}

// エンティティ(艦・基地)の時刻 t の状態。predicted を持たない(＝未来を予測しない種別の)
// エンティティでは、t が現在時刻より先なら求まらない。
export function entityStateAt(
  entity: DynamicEntity, t: number, center: OrbitCenter,
): KinematicState | null {
  if (t <= entity.state.t) return entity.actual.at(t);
  const predicted = entity.predicted;
  if (predicted === null) return null;
  return trajectoryStateAt(predicted, t, center);
}
