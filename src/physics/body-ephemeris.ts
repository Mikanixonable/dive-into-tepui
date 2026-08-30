// 天体1体ぶんの暦。どの天体のものかは、この値を保持している側が決める。
import { KinematicState } from './kinematic-state';

export interface BodyEphemeris {
  // この天体を答えられる simTime の範囲。天体ごとに異なりうる。
  readonly validStartSimTime: number;
  readonly validEndSimTime: number;

  // 太陽系重心中心・ゲーム ECI 軸の位置・速度。範囲外の simTime を渡すと例外。
  stateAt(simTime: number): KinematicState<'packed'>;
}

// 結ばれた暦が答える位置・速度。結ばれていない・有効期間の外では null。
export function boundStateAt(ephemeris: BodyEphemeris | null, t: number): KinematicState<'packed'> | null {
  if (ephemeris === null) return null;
  if (t < ephemeris.validStartSimTime || t > ephemeris.validEndSimTime) return null;
  return ephemeris.stateAt(t);
}
