import { Vec3, addScaled, scale } from '../../physics/vec3';

export interface BoosterSeparationVelocities {
  readonly player: Vec3;
  readonly booster: Vec3;
}

// 機首方向 forward に対しブースターが船尾へ relativeSpeed で離れるよう、
// 両者へ運動量を保存する速度差を配る。baseVelocity は分離直前の共通速度。
export function boosterSeparationVelocities(
  baseVelocity: Vec3,
  forward: Vec3,
  playerMass: number,
  boosterMass: number,
  relativeSpeed: number,
): BoosterSeparationVelocities {
  const totalMass = playerMass + boosterMass;
  if (totalMass <= 0 || relativeSpeed <= 0) {
    return { player: { ...baseVelocity }, booster: { ...baseVelocity } };
  }

  const playerDelta = relativeSpeed * boosterMass / totalMass;
  const boosterDelta = -relativeSpeed * playerMass / totalMass;
  return {
    player: addScaled(baseVelocity, forward, playerDelta),
    booster: addScaled(baseVelocity, forward, boosterDelta),
  };
}

// 分離後の相対速度を返すテスト/診断用ヘルパー。
export function boosterRelativeVelocity(
  velocities: BoosterSeparationVelocities,
): Vec3 {
  return addScaled(velocities.booster, velocities.player, -1);
}

// 分離前後の並進運動量を比較するテスト/診断用ヘルパー。
export function boosterSeparationMomentum(
  velocities: BoosterSeparationVelocities,
  playerMass: number,
  boosterMass: number,
): Vec3 {
  return addScaled(scale(velocities.player, playerMass), velocities.booster, boosterMass);
}
