// 天体1体ぶんの暦。**id を持たない** — 「どの天体のものか」は、この値を持っているのが誰かで
// 決まる。系全体の暦から構築時に切り出して天体へ配ることで、「自分が収録されているか」の
// 問いが「暦を貰えたか(null でないか)」に変わり、評価のたびの id 引きが消える。
import { KinematicState } from './kinematic-state';

export interface BodyEphemeris {
  // この天体を答えられる simTime の範囲。**系全体ではなくこの天体自身の範囲**で、
  // 形式は天体ごとに違う値を許す。
  readonly validStartSimTime: number;
  readonly validEndSimTime: number;

  // 太陽系重心中心・ゲーム ECI 軸の位置・速度。範囲外の simTime を渡すと例外。
  stateAt(simTime: number): KinematicState<'barycentric'>;
}
