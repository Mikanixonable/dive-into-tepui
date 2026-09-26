// 球面で切った 3D フラクタルノイズ。大気の大循環に基づいて標本化するため、模様は緯度帯ごとに
// 違う向きへ流れながら形を変える。書き込み先の texel で標本化できないオクターブは除外するが、除外の境界となる 1 段は
// 端数分の振幅で重畳する — 解像度が連続的に変化しても、オクターブが急峻に出現・消失しない。
import { If, abs, clamp, float, greaterThan, log2, vec2 } from 'three/tsl';
import { gradientNoise } from './gradient-noise';
import type { Circulation } from './circulation';
import type { FloatNode, Vec2Node, Vec3Node } from '../tsl-types';

// 段が振幅 1 に達する、1 波長あたりの texel 数の逆数(0.25 = 4 texel)。ここから周波数 2 倍
// (= Nyquist の 2 texel)までのあいだで、オクターブの振幅を 1 から 0 へ減衰させる。
const OCTAVE_FADE_START = 0.25;

// ノイズのオクターブ(周波数階層) 1 つ。frequency は 1 rad あたりの山数(角波長 [km] = 6371 / frequency)、
// amplitude はそのオクターブの寄与度。各オクターブ間の比率は任意で、等比数列である必要はない。
export type NoiseOctave = {
  readonly frequency: number;
  readonly amplitude: number;
};

// 細胞状オクターブ = (CELL_ABSOLUTE_MEAN − |g|) × CELL_TO_NOISE_SCALE。零交差がセル壁となるため、格子に依存しない
// 不規則な網目構造が生成される。定数は gradientNoise を一様な位置で 60 万点標本化して得た |g| の平均(0.2164)と、
// 標準偏差の比 σ(g)/σ(|g|)(1.728)。前者がオクターブの平均を 0 に、後者がオクターブの強度を滑らかな成分と一致させる。
// どちらの波形もオクターブごとに平均 0・同一標準偏差となるため、解像度が粗く高周波オクターブが間引かれても場の平均や強度は変動しない。
const CELL_ABSOLUTE_MEAN = 0.2164;
const CELL_TO_NOISE_SCALE = 1.728;

export class CirculatingNoise {
  // オクターブごとの振幅(テーブルの寄与度 × サンプリング解像度に応じたフェード)。texelAngle から決まり標本化
  // 位置に依存しないため、位置ごとに再計算は不要。
  private readonly amplitudes: readonly FloatNode[];
  // 全オクターブの振幅の和の逆数。掛けると場の振れ幅がオクターブ数と各重みに依存しなくなる。
  private readonly normalization: number;

  // circulation はこのノイズを運ぶ流れ、octaves はオクターブ定義配列、texelAngle はベイク先の 1 texel が張る角 [rad]。
  public constructor(
    private readonly circulation: Circulation,
    private readonly octaves: readonly NoiseOctave[],
    texelAngle: FloatNode,
  ) {
    // 1 波長が OCTAVE_FADE_START の texel 数に届くオクターブは満額、その半分で 0。オクターブごとに独立に決定されるため、
    // 配列が等比数列でなくても境界の不連続は生じない。
    this.amplitudes = octaves.map((octave) =>
      clamp(log2(float(OCTAVE_FADE_START).div(texelAngle.mul(octave.frequency))).add(1), 0, 1)
        .mul(octave.amplitude));
    this.normalization = 1 / octaves.reduce((sum, octave) => sum + octave.amplitude, 0);
  }

  // 単位方向 direction での滑らかなノイズ、おおむね −1..1(オクターブを重ねても全体の振幅は正規化される)。
  public at(direction: Vec3Node): FloatNode {
    return this.pairAt(direction).x;
  }

  // 単位方向 direction での、滑らかなオクターブ成分(x)と細胞状の網目(y)の対。**2 つは同じ勾配ノイズから
  // 出るので、片方だけを取るのと同じ手数で済む。**
  public pairAt(direction: Vec3Node): Vec2Node {
    return this.circulation.carry(direction, (position) => this.fractalAt(position));
  }

  // 定義されたオクターブを合成し、全寄与の和で正規化した対(x が滑らか、y が網目)。振幅が 0 に落ちたオクターブは
  // 計算そのものをスキップする — 分岐の向きは texelAngle のみで決まり画面全域で揃うため、スレッド間の乖離は生じない。
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
