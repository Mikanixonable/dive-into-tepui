// 球面で切った 3D フラクタルノイズ。大気の大循環に乗せて標本化するので、模様は緯度帯ごとに
// 違う向きへ流れながら形を変える。焼く先の texel で標本化できない段は落とすが、落ちる境目の 1 段は
// 端数の振幅で乗せる — 写しの解像度が連続に変われば、段が丸ごと現れたり消えたりしない。
import { If, abs, clamp, float, greaterThan, log2, vec2 } from 'three/tsl';
import { gradientNoise } from './gradient-noise';
import type { Circulation } from './circulation';
import type { FieldProjection } from './field-projection';
import type { FloatNode, Vec2Node, Vec3Node } from '../tsl-types';

// 段が振幅 1 に達する、1 波長あたりの texel 数の逆数(0.25 = 4 texel)。ここから周波数 2 倍
// (= Nyquist の 2 texel)までのあいだで、段の振幅を 1 から 0 へ渡す。
const OCTAVE_FADE_START = 0.25;

// ノイズの段 1 つ。frequency は 1 rad あたりの山の数(角波長 [km] = 6371 / frequency)、
// amplitude はその段の取り分。段どうしの比は自由で、等比列である必要はない。
export type NoiseOctave = {
  readonly frequency: number;
  readonly amplitude: number;
};

// 細胞の段 = (CELL_ABSOLUTE_MEAN − |g|) × CELL_TO_NOISE_SCALE。零交差が壁になるので、格子に依らない
// 曲がった網目が出る。定数は gradientNoise を一様な位置で 60 万点標本化して得た |g| の平均(0.2164)と、
// 標準偏差の比 σ(g)/σ(|g|)(1.728)。前者が段の平均を 0 に、後者が段の強さを滑らかな段と同じにする
// — どちらの形も段ごとに平均 0・同じ標準偏差なので、写しが粗くて段が落ちても場の平均も強さも動かない。
const CELL_ABSOLUTE_MEAN = 0.2164;
const CELL_TO_NOISE_SCALE = 1.728;

// 段の表がどれも振幅 1 で乗る範囲で、projection の何分の一の細かさまで粗く焼いてよいか。2 の冪で返す。
export function coarsenessFor(projection: FieldProjection, ...tables: readonly (readonly NoiseOctave[])[]): number {
  const finest = Math.max(...tables.flat().map((octave) => octave.frequency));
  return Math.max(1, 2 ** Math.floor(Math.log2(OCTAVE_FADE_START / (finest * projection.texelAngleValue))));
}

export class CirculatingNoise {
  // 段ごとの振幅(表の取り分 × 写しの細かさで決まるフェード)。texelAngle から出るだけで標本化する
  // 位置に依らないので、位置ごとに組み直さない。
  private readonly amplitudes: readonly FloatNode[];
  // 全段の振幅の和の逆数。掛けると場の振れ幅が段の数と取り分に依らなくなる。
  private readonly normalization: number;

  // circulation はこの段を運ぶ流れ、octaves は段の表、texelAngle は焼く先の 1 texel が張る角 [rad]。
  public constructor(
    private readonly circulation: Circulation,
    private readonly octaves: readonly NoiseOctave[],
    texelAngle: FloatNode,
  ) {
    // 1 波長が OCTAVE_FADE_START の texel 数に届く段は満額、その半分で 0。段ごとに独立に決まるので、
    // 表が等比列でなくても境目が跳ばない。
    this.amplitudes = octaves.map((octave) =>
      clamp(log2(float(OCTAVE_FADE_START).div(texelAngle.mul(octave.frequency))).add(1), 0, 1)
        .mul(octave.amplitude));
    this.normalization = 1 / octaves.reduce((sum, octave) => sum + octave.amplitude, 0);
  }

  // 単位方向 direction での滑らかなノイズ、おおむね −1..1(段を何段重ねても振れ幅は変わらない)。
  public at(direction: Vec3Node): FloatNode {
    return this.pairAt(direction).x;
  }

  // 単位方向 direction での、滑らかな段(x)と細胞の網目(y)の対。**2 つは同じ勾配ノイズから
  // 出るので、片方だけを取るのと同じ手数で済む。**
  public pairAt(direction: Vec3Node): Vec2Node {
    return this.circulation.carry(direction, (position) => this.fractalAt(position));
  }

  // 表の段を重ね、全段の取り分の和で割った対(x が滑らか、y が網目)。振幅が 0 に落ちた段は評価
  // そのものを飛ばす — 分岐の向きは texelAngle だけで決まって写しの全域で揃うので、画面がばらけない。
  private fractalAt(position: Vec3Node): Vec2Node {
    const sum = vec2(0, 0).toVar();
    for (const [index, octave] of this.octaves.entries()) {
      const amplitude = this.amplitudes[index]!;
      If(greaterThan(amplitude, 0), () => {
        sum.addAssign(octaveAt(position.mul(octave.frequency)).mul(amplitude));
      });
    }
    return sum.mul(this.normalization);
  }
}

// 位置 position における 1 段の値の対(x が滑らかな段、y が細胞の網目)。どちらもおおむね −1..1。
function octaveAt(position: Vec3Node): Vec2Node {
  const raw = gradientNoise(position);
  return vec2(raw, float(CELL_ABSOLUTE_MEAN).sub(abs(raw)).mul(CELL_TO_NOISE_SCALE));
}
