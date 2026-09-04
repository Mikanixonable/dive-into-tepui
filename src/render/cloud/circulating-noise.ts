// 球面で切った 3D フラクタルノイズ。大気の大循環に乗せて標本化するので、模様は緯度帯ごとに
// 違う向きへ流れながら形を変える。焼く先の texel で標本化できない段は落とすが、落ちる境目の 1 段は
// 端数の振幅で乗せる — 写しの解像度が連続に変われば、段が丸ごと現れたり消えたりしない。
import { If, Loop, abs, clamp, exp2, float, floor, greaterThan, int, log2 } from 'three/tsl';
import { gradientNoise } from './gradient-noise';
import type { Circulation } from './circulation';
import type { FieldProjection } from './field-projection';
import type { FloatNode, IntNode, Vec3Node } from '../tsl-types';

// 段が振幅 1 に達する、1 波長あたりの texel 数の逆数(0.25 = 4 texel)。ここから周波数 2 倍
// (= Nyquist の 2 texel)までのあいだで、段の振幅を 1 から 0 へ渡す。
const OCTAVE_FADE_START = 0.25;

// 段ごとの振幅比。1 に近いほど細かい段が強く出て、スペクトルの傾きが浅くなる。
const OCTAVE_PERSISTENCE = 0.65;

// 段の形。smooth は勾配ノイズそのまま、cellular は零交差を壁にした細胞の網目。**どちらも段ごとに
// 平均 0・同じ標準偏差**なので、写しが粗くて段が落ちても場の平均も強さも動かない。
export type NoiseShape = 'smooth' | 'cellular';

// 細胞の段 = (CELL_ABSOLUTE_MEAN − |g|) × CELL_TO_NOISE_SCALE。定数は gradientNoise を一様な位置で
// 60 万点標本化して得た |g| の平均(0.2164)と、標準偏差の比 σ(g)/σ(|g|)(1.728)。前者が段の平均を
// 0 に、後者が段の強さを smooth と同じにする。
const CELL_ABSOLUTE_MEAN = 0.2164;
const CELL_TO_NOISE_SCALE = 1.728;

// noises([周波数, 段数] の並び)がどれも振幅 1 で乗る範囲で、projection の何分の一の細かさまで
// 粗く焼いてよいか。2 の冪で返す。
export function coarsenessFor(projection: FieldProjection, ...noises: readonly (readonly [number, number])[]): number {
  const room = Math.min(...noises.map(([frequency, octaves]) => resolvableTexelAngle(frequency, octaves)))
    / projection.texelAngleValue;
  return Math.max(1, 2 ** Math.floor(Math.log2(room)));
}

// frequency から始まる octaves 段が、どれも振幅 1 で乗る 1 texel の角 [rad] の上限。
function resolvableTexelAngle(frequency: number, octaves: number): number {
  return OCTAVE_FADE_START / (frequency * 2 ** (octaves - 1));
}

export class CirculatingNoise {
  // 振幅 1 で乗る段数と、その次の 1 段の周波数・振幅。texelAngle から出るだけで標本化する位置に
  // 依らないので、位置ごとに組み直さない。
  private readonly fullOctaves: IntNode;
  private readonly partialFrequency: FloatNode;
  private readonly partialAmplitude: FloatNode;
  // 全段の振幅の和の逆数。掛けると場の振れ幅が段数と振幅比に依らなくなる。
  private readonly normalization: number;

  // frequency は最初の段の 1 rad あたりの山の数、octaves は段数、circulation はこの段を運ぶ流れ、
  // texelAngle は焼く先の 1 texel が張る角 [rad]、shape は段の形。
  public constructor(
    private readonly circulation: Circulation,
    private readonly frequency: number,
    octaves: number,
    texelAngle: FloatNode,
    private readonly shape: NoiseShape,
  ) {
    const level = clamp(log2(float(OCTAVE_FADE_START).div(texelAngle.mul(frequency))), -1, octaves - 1);
    const resolved = floor(level);
    this.fullOctaves = int(resolved.add(1));
    this.partialFrequency = exp2(resolved.add(1));
    this.partialAmplitude = exp2(resolved.add(1).mul(Math.log2(OCTAVE_PERSISTENCE))).mul(level.sub(resolved));
    this.normalization = (1 - OCTAVE_PERSISTENCE) / (1 - OCTAVE_PERSISTENCE ** octaves);
  }

  // 単位方向 direction でのノイズ、おおむね −1..1(段を何段重ねても振れ幅は変わらない)。
  public at(direction: Vec3Node): FloatNode {
    return this.circulation.carry(direction, (position) => this.fractalAt(position));
  }

  // 周波数 2 倍・振幅 OCTAVE_PERSISTENCE 倍で段を重ね、全段の振幅の和で割った値。端数の段の振幅は、
  // 段数が 1 つ増える所でちょうどその段ぶんに達するので、和は段数の境目で跳ばない。端数の段の分岐は
  // texelAngle だけで決まって写しの全域で揃うので、段数がクランプに張り付く場面ではこの段が丸ごと消える。
  private fractalAt(position: Vec3Node): FloatNode {
    const scaled = position.mul(this.frequency);
    const walking = scaled.toVar();
    const amplitude = float(1).toVar();
    const sum = float(0).toVar();
    Loop({ start: 0, end: this.fullOctaves }, () => {
      sum.addAssign(this.octaveAt(walking).mul(amplitude));
      walking.mulAssign(2);
      amplitude.mulAssign(OCTAVE_PERSISTENCE);
    });
    If(greaterThan(this.partialAmplitude, 0), () => {
      sum.addAssign(this.octaveAt(scaled.mul(this.partialFrequency)).mul(this.partialAmplitude));
    });
    return sum.mul(this.normalization);
  }

  // 1 段の値、おおむね −1..1。細胞の段は零交差が壁になるので、格子に依らない曲がった網目が出る。
  private octaveAt(position: Vec3Node): FloatNode {
    const raw = gradientNoise(position);
    if (this.shape === 'smooth') return raw;
    return float(CELL_ABSOLUTE_MEAN).sub(abs(raw)).mul(CELL_TO_NOISE_SCALE);
  }
}
