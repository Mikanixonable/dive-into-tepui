// 3D 位置で切ったフラクタルノイズの評価部。CirculatingNoise が運ぶ「どの位置で読むか」から
// 分けたもので、地表に固定した場や、移流の発射時刻でずらした時刻での評価にも使える。
// 書き込み先の texel で標本化できないオクターブは除外するが、除外の境界となる 1 段は
// 端数分の振幅で重畳する — 解像度が連続的に変化しても、オクターブが急峻に出現・消失しない。
import * as THREE from 'three/webgpu';
import { Fn, If, abs, clamp, float, floor, greaterThan, int, log2, mix, mod, uniform, uniformArray, vec2 } from 'three/tsl';
import { gradientNoise } from './cloud/gradient-noise';
import type { FloatNode, FloatUniform, Vec2Node, Vec3Node } from '../tsl-types';

// 段が振幅 1 に達する、1 波長あたりの texel 数の逆数(0.25 = 4 texel)。ここから周波数 2 倍
// (= Nyquist の 2 texel)までのあいだで、オクターブの振幅を 1 から 0 へ減衰させる。
const OCTAVE_FADE_START = 0.25;

// ノイズのオクターブ(周波数階層) 1 つ。frequency は 1 rad あたりの山数(角波長 [km] = 6371 / frequency)、
// amplitude はそのオクターブの寄与度。各オクターブ間の比率は任意で、等比数列である必要はない。
export interface NoiseOctave {
  readonly frequency: number;
  readonly amplitude: number;
}

// 細胞状オクターブ = (CELL_ABSOLUTE_MEAN − |g|) × CELL_TO_NOISE_SCALE。零交差がセル壁となるため、格子に依存しない
// 不規則な網目構造が生成される。定数は gradientNoise を一様な位置で 60 万点標本化して得た |g| の平均(0.2164)と、
// 標準偏差の比 σ(g)/σ(|g|)(1.728)。前者がオクターブの平均を 0 に、後者がオクターブの強度を滑らかな成分と一致させる。
// どちらの波形もオクターブごとに平均 0・同一標準偏差となるため、解像度が粗く高周波オクターブが間引かれても場の平均や強度は変動しない。
const CELL_ABSOLUTE_MEAN = 0.2164;
const CELL_TO_NOISE_SCALE = 1.728;

// エポック: ノイズの模様がその場で発達・衰退するための実現の混ぜ替え。ノイズ空間で大きく
// 離れた実現どうしを移行時間かけて混ぜると、模様は平行移動を保ったまま中身が入れ替わる。
// オフセットを連続に滑らせる方式は、周波数に比例して細い段から形が崩れ、移流の lag 相関を
// 壊すため取らない。実現は EPOCH_OFFSETS を一巡し、周期 (移行時間 × 個数) は計測窓 (64 h)
// より長く取る — 窓の中で同じ実現へ戻ると、相関が持ち直してしまう。第 0 の実現は
// オフセット無しで、時刻 0 の場は混ぜ替えの無い場と一致する。移行時間 18 h は実測で選んだ:
// 12 h では 8 h 遅れの移流ピークが中緯度で崩れ (速さ比 1.07、ピーク相関 0.42)、18 h では
// 保たれる (速さ比 0.81、相関 0.58) うえ、脱相関時間はむしろ短くなった。
const EPOCH_TRANSITION_SECONDS = 18 * 3600;
const EPOCH_OFFSETS: readonly (readonly [number, number, number])[] = [
  [0, 0, 0],
  [3.1, -1.7, 2.3],
  [-2.6, 2.9, -1.2],
  [1.8, 3.4, -2.7],
  [-3.3, -2.2, -3.0],
  [2.4, -3.1, 3.6],
];

export class EpochNoise {
  // オクターブごとの振幅(テーブルの寄与度 × サンプリング解像度に応じたフェード)。texelAngle から決まり標本化
  // 位置に依存しないため、位置ごとに再計算は不要。
  private readonly amplitudes: readonly FloatNode[];
  // 全オクターブの振幅の和の逆数。掛けると場の振れ幅がオクターブ数と各重みに依存しなくなる。
  private readonly normalization: number;
  // 実現のオフセット表。段の評価は評価時刻から求めた添字でここを引く。
  private readonly epochOffsets: THREE.UniformArrayNode<'vec3'> = uniformArray(
    EPOCH_OFFSETS.map((offset) => new THREE.Vector3(...offset)), 'vec3',
  );
  // seconds を省略した評価が使う現在時刻 [s]。書き換えるのはこちら。
  private readonly seconds: FloatUniform = uniform(0);

  // octaves はオクターブ定義配列、texelAngle はベイク先の 1 texel が張る角 [rad]。
  // epochMaxFrequency を渡すと、その周波数以下の段だけがエポックの混ぜ替えに参加する (総観規模の
  // 段だけをその場で入れ替え、細い段は平行移動の足場として残す)。渡さなければ混ぜ替えは無い。
  // transitionSeconds は混ぜ替えの移行時間 [s] — 模様が入れ替わる時間の尺度で、個々の源の寿命ではない。
  public constructor(
    private readonly octaves: readonly NoiseOctave[],
    texelAngle: FloatNode,
    private readonly epochMaxFrequency?: number,
    private readonly transitionSeconds: number = EPOCH_TRANSITION_SECONDS,
  ) {
    // 1 波長が OCTAVE_FADE_START の texel 数に届くオクターブは満額、その半分で 0。オクターブごとに独立に決定されるため、
    // 配列が等比数列でなくても境界の不連続は生じない。
    this.amplitudes = octaves.map((octave) =>
      clamp(log2(float(OCTAVE_FADE_START).div(texelAngle.mul(octave.frequency))).add(1), 0, 1)
        .mul(octave.amplitude));
    this.normalization = 1 / octaves.reduce((sum, octave) => sum + octave.amplitude, 0);
  }

  // 現在時刻 [s] を uniform へ反映する。seconds 引数を省略した評価はこの時刻を使う。
  public syncTime(seconds: number): void {
    this.seconds.value = seconds;
  }

  // 位置 position での滑らかなノイズ、おおむね −1..1(オクターブを重ねても全体の振幅は正規化される)。
  // seconds は評価時刻 [s] — 省略すると syncTime が反映した現在時刻。
  public at(position: Vec3Node, seconds: FloatNode = this.seconds): FloatNode {
    return this.pairAt(position, seconds).x;
  }

  // 位置 position での、滑らかなオクターブ成分(x)と細胞状の網目(y)の対。**2 つは同じ勾配ノイズから
  // 出るので、片方だけを取るのと同じ手数で済む。** seconds は評価時刻 [s]。
  public pairAt(position: Vec3Node, seconds: FloatNode = this.seconds): Vec2Node {
    // 評価は Fn の内側で行う — If を含む評価部はビルダのスタックを要り、移流の発射時刻での
    // 評価のように Fn を持たない式の中からでも呼べるようにするため。
    return Fn(() => {
      if (this.epochMaxFrequency === undefined) return this.fractalAt(position);
      // エポックの実現の両端と混ぜ率を評価時刻から求める — 添字で表を引くので、
      // 現在時刻だけでなく移流の発射時刻のような任意の時刻で評価できる。
      const phase = seconds.div(this.transitionSeconds);
      const step = floor(phase);
      const count = float(EPOCH_OFFSETS.length);
      const epochFrom = this.epochOffsets.element(int(mod(step, count)));
      const epochTo = this.epochOffsets.element(int(mod(step.add(1), count)));
      const epochMix = phase.sub(step);
      return this.fractalAt(position, epochFrom, epochTo, epochMix);
    })();
  }

  // 定義されたオクターブを合成し、全寄与の和で正規化した対(x が滑らか、y が網目)。振幅が 0 に落ちたオクターブは
  // 計算そのものをスキップする — 分岐の向きは texelAngle のみで決まり画面全域で揃うため、スレッド間の乖離は生じない。
  private fractalAt(position: Vec3Node, epochFrom?: Vec3Node, epochTo?: Vec3Node, epochMix?: FloatNode): Vec2Node {
    const sum = vec2(0, 0).toVar();
    for (const [index, octave] of this.octaves.entries()) {
      const amplitude = this.amplitudes[index]!;
      If(greaterThan(amplitude, 0), () => {
        sum.addAssign(this.octaveValueAt(position, octave, epochFrom, epochTo, epochMix).mul(amplitude));
      });
    }
    return sum.mul(this.normalization);
  }

  // 位置 position における 1 段の値の対。エポックに参加する段は、評価時刻の 2 つの実現を混ぜ率で
  // 混ぜた値になる。実現のオフセットは段の周波数を掛ける前の位置へ足すので、参加する段は
  // すべて同じ実現の組から読む。
  private octaveValueAt(
    position: Vec3Node, octave: NoiseOctave,
    epochFrom?: Vec3Node, epochTo?: Vec3Node, epochMix?: FloatNode,
  ): Vec2Node {
    if (
      this.epochMaxFrequency === undefined || octave.frequency > this.epochMaxFrequency
      || epochFrom === undefined || epochTo === undefined || epochMix === undefined
    ) {
      return octaveAt(position.mul(octave.frequency));
    }
    const from = octaveAt(position.add(epochFrom).mul(octave.frequency));
    const to = octaveAt(position.add(epochTo).mul(octave.frequency));
    return mix(from, to, epochMix);
  }
}

// 位置 position における 1 段の値の対(x が滑らかな段、y が細胞の網目)。どちらもおおむね −1..1。
function octaveAt(position: Vec3Node): Vec2Node {
  const raw = gradientNoise(position);
  return vec2(raw, float(CELL_ABSOLUTE_MEAN).sub(abs(raw)).mul(CELL_TO_NOISE_SCALE));
}
