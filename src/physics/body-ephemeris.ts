// 天体1体ぶんの暦。どの天体のものかは、この値を保持している側が決める。
import { KinematicState } from './kinematic-state';

export interface BodyEphemeris {
  // この天体を答えられる simTime の範囲。天体ごとに異なりうる。
  readonly validStartSimTime: number;
  readonly validEndSimTime: number;

  // 太陽系重心中心・ゲーム ECI 軸の位置・速度。範囲外の simTime を渡すと例外。
  stateAt(simTime: number): KinematicState<'packed'>;
}
