// 球面で切った 3D フラクタルノイズ。大気の大循環に基づいて標本化するため、模様は緯度帯ごとに
// 違う向きへ流れながら形を変える。場の評価(オクターブの合成とエポックの混ぜ替え)は
// epoch-noise.ts が担い、ここは「どの位置で読むか」だけを担う。
import { EpochNoise } from './epoch-noise';
import type { NoiseOctave } from './epoch-noise';
import type { Circulation } from './circulation';
import type { FloatNode, Vec2Node, Vec3Node } from '../tsl-types';

export type { NoiseOctave } from './epoch-noise';

export class CirculatingNoise {
  private readonly noise: EpochNoise;

  // circulation はこのノイズを運ぶ流れ、octaves はオクターブ定義配列、texelAngle はベイク先の 1 texel が張る角 [rad]。
  // epochMaxFrequency を渡すと、その周波数以下の段だけがエポックの混ぜ替えに参加する (総観規模の
  // 段だけをその場で入れ替え、細い段は平行移動の足場として残す)。渡さなければ混ぜ替えは無い。
  public constructor(
    private readonly circulation: Circulation,
    octaves: readonly NoiseOctave[],
    texelAngle: FloatNode,
    epochMaxFrequency?: number,
  ) {
    this.noise = new EpochNoise(octaves, texelAngle, epochMaxFrequency);
    this.syncTime(0);
  }

  // 時刻 [s] を場の評価へ反映する。
  public syncTime(seconds: number): void {
    this.noise.syncTime(seconds);
  }

  // 単位方向 direction での滑らかなノイズ、おおむね −1..1(オクターブを重ねても全体の振幅は正規化される)。
  public at(direction: Vec3Node): FloatNode {
    return this.pairAt(direction).x;
  }

  // 単位方向 direction での、滑らかなオクターブ成分(x)と細胞状の網目(y)の対。**2 つは同じ勾配ノイズから
  // 出るので、片方だけを取るのと同じ手数で済む。**
  public pairAt(direction: Vec3Node): Vec2Node {
    return this.circulation.carry(direction, (position) => this.noise.pairAt(position));
  }
}
