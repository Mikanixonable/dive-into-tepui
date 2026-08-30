// 球面で切った 3D フラクタルノイズ。大気の大循環に乗せて標本化するので、模様は緯度帯ごとに
// 違う向きへ流れながら形を変える。焼く先の texel で標本化できない段は落とすが、落ちる境目の 1 段は
// 端数の振幅で乗せる — 写しの解像度が連続に変われば、段が丸ごと現れたり消えたりしない。
import { If, Loop, clamp, exp2, float, floor, greaterThan, int, log2 } from 'three/tsl';
import { gradientNoise } from './gradient-noise';
import type { Circulation } from './circulation';
import type { FloatNode, IntNode, Vec3Node } from '../tsl-types';

// 段が振幅 1 に達する、1 波長あたりの texel 数の逆数(0.25 = 4 texel)。ここから周波数 2 倍
// (= Nyquist の 2 texel)までのあいだで、段の振幅を 1 から 0 へ渡す。
const OCTAVE_FADE_START = 0.25;

// frequency から始まる octaves 段が、どれも振幅 1 で乗る 1 texel の角 [rad] の上限。これより
// 細かく焼いても段は増えないので、写しをどこまで粗くしてよいかがここから決まる。
export function resolvableTexelAngle(frequency: number, octaves: number): number {
  return OCTAVE_FADE_START / (frequency * 2 ** (octaves - 1));
}

export class CirculatingNoise {
  // 振幅 1 で乗る段数と、その次の 1 段の周波数・振幅。texelAngle から出るだけで標本化する位置に
  // 依らないので、位置ごとに組み直さない。
  private readonly fullOctaves: IntNode;
  private readonly partialFrequency: FloatNode;
  private readonly partialAmplitude: FloatNode;

  // frequency は最初の段の 1 rad あたりの山の数、octaves は段数、circulation はこの段を運ぶ流れ、
  // texelAngle は焼く先の 1 texel が張る角 [rad]。
  public constructor(
    private readonly circulation: Circulation,
    private readonly frequency: number,
    octaves: number,
    texelAngle: FloatNode,
  ) {
    const level = clamp(log2(float(OCTAVE_FADE_START).div(texelAngle.mul(frequency))), -1, octaves - 1);
    const resolved = floor(level);
    this.fullOctaves = int(resolved.add(1));
    this.partialFrequency = exp2(resolved.add(1));
    this.partialAmplitude = exp2(resolved.add(1).negate()).mul(level.sub(resolved));
  }

  // 単位方向 direction でのノイズ、おおむね −1..1。
  public at(direction: Vec3Node): FloatNode {
    return this.circulation.carry(direction, (position) => this.fractalAt(position));
  }

  // 周波数 2 倍・振幅 1/2 で段を重ねた和。端数の段の振幅は、段数が 1 つ増える所で 1/2 段ぶんに
  // 達するので、和は段数の境目で跳ばない。端数の段の分岐は texelAngle だけで決まって写しの全域で
  // 揃うので、段数がクランプに張り付く場面ではこの段が丸ごと消える。
  private fractalAt(position: Vec3Node): FloatNode {
    const scaled = position.mul(this.frequency);
    const walking = scaled.toVar();
    const amplitude = float(1).toVar();
    const sum = float(0).toVar();
    Loop({ start: 0, end: this.fullOctaves }, () => {
      sum.addAssign(gradientNoise(walking).mul(amplitude));
      walking.mulAssign(2);
      amplitude.mulAssign(0.5);
    });
    If(greaterThan(this.partialAmplitude, 0), () => {
      sum.addAssign(gradientNoise(scaled.mul(this.partialFrequency)).mul(this.partialAmplitude));
    });
    return sum;
  }
}
