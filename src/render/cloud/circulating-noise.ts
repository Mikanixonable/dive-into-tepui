// 球面で切った 3D フラクタルノイズの 1 段。大気の大循環に乗せて標本化するので、模様は緯度帯ごとに
// 違う向きへ流れながら形を変える。
import { mx_fractal_noise_float } from 'three/tsl';
import type { Circulation } from './circulation';
import type { FloatNode, Vec3Node } from '../tsl-types';

export class CirculatingNoise {
  // frequency は 1 rad あたりの山の数、octaves は段数、circulation はこの段を運ぶ流れ。
  public constructor(
    private readonly circulation: Circulation,
    private readonly frequency: number,
    private readonly octaves: number,
  ) {}

  // 単位方向 direction でのノイズ、おおむね −1..1。
  public at(direction: Vec3Node): FloatNode {
    return this.circulation.carry(
      direction, (position) => mx_fractal_noise_float(position.mul(this.frequency), this.octaves));
  }
}
