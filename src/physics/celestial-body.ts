// 天体1体を外から見たときの札と姿勢。運動をどう合成するかには関与しない。
import type { Vec3 } from '../math/vec3';

// 天体の分類。網羅的な分岐を書きたい呼び出し側のための札で、運動の合成そのものはクラスが担う。
export type CelestialKind = 'star' | 'planet' | 'satellite';

// 天体の自転軸(単位ベクトル、ECI)と、その軸まわりの自転位相 [rad]。
export interface BodyOrientation {
  readonly axis: Vec3;
  readonly spinAngle: number;
}
