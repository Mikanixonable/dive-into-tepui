// 球面で切った 3D フラクタルノイズの 1 段。ノイズ空間の中を円軌道で動かすので、模様は時刻とともに
// 変形して動き、どれだけ時刻が進んでも有界に留まる。
import { cos, mx_fractal_noise_float, sin, uniform, vec3 } from 'three/tsl';
import type { FloatNode, FloatUniform, Vec3Node } from '../tsl-types';

// 円軌道の半径(ノイズ空間の単位)。1 で、四半周期のあいだに模様が山 1 つぶん入れ替わる。
const DRIFT_RADIUS = 1;

export class DriftingNoise {
  // 円軌道の位相 [rad]。
  private readonly phase: FloatUniform = uniform(0);

  // frequency は球面 1 周あたりの山の数、octaves は段数、period は円軌道 1 周の時間 [s]。
  public constructor(
    private readonly frequency: number,
    private readonly octaves: number,
    private readonly period: number,
  ) {}

  // 時刻 [s] を位相へ写す。周期で畳んでから渡すので、大きな時刻でも精度が落ちない。
  public syncTime(seconds: number): void {
    const cycle = (seconds / this.period) % 1;
    this.phase.value = (cycle < 0 ? cycle + 1 : cycle) * 2 * Math.PI;
  }

  // 単位方向 direction でのノイズ、おおむね −1..1。
  public at(direction: Vec3Node): FloatNode {
    const offset = vec3(cos(this.phase), 0, sin(this.phase)).mul(DRIFT_RADIUS);
    return mx_fractal_noise_float(direction.mul(this.frequency).add(offset), this.octaves);
  }
}
