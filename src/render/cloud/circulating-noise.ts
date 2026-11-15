// 球面で切った 3D フラクタルノイズ。大気の大循環に基づいて標本化するため、模様は緯度帯ごとに
// 違う向きへ流れながら形を変える。書き込み先の texel で標本化できないオクターブは除外するが、除外の境界となる 1 段は
// 端数分の振幅で重畳する — 解像度が連続的に変化しても、オクターブが急峻に出現・消失しない。
import { If, abs, clamp, float, floor, fract, greaterThan, log2, mix, mod, uniform, vec2, vec3 } from 'three/tsl';
import { gateFactor, gradientNoise } from './gradient-noise';
import type { Circulation } from './circulation';
import type { FloatNode, FloatUniform, Vec2Node, Vec3Node } from '../tsl-types';

// 段が振幅 1 に達する、1 波長あたりの texel 数の逆数(0.25 = 4 texel)。ここから周波数 2 倍
// (= Nyquist の 2 texel)までのあいだで、オクターブの振幅を 1 から 0 へ減衰させる。
const OCTAVE_FADE_START = 0.25;

// ノイズのオクターブ(周波数階層) 1 つ。frequency は 1 rad あたりの山数(角波長 [km] = 6371 / frequency)、
// amplitude はそのオクターブの寄与度。各オクターブ間の比率は任意で、等比数列である必要はない。
// envelope は包絡への応答係数 — 段の振幅へ 1 + envelope × 係数 を掛ける(環境で段を強めたり
// 弱めたりする入口。符号を変えれば同じ包絡で太い段を足し細かい段を引ける)。
export interface NoiseOctave {
  readonly frequency: number;
  readonly amplitude: number;
  readonly envelope?: number;
}

// 細胞状オクターブ = (CELL_ABSOLUTE_MEAN − |g|) × CELL_TO_NOISE_SCALE。零交差がセル壁となるため、格子に依存しない
// 不規則な網目構造が生成される。定数は gradientNoise を一様な位置で 60 万点標本化して得た |g| の平均(0.2164)と、
// 標準偏差の比 σ(g)/σ(|g|)(1.728)。前者がオクターブの平均を 0 に、後者がオクターブの強度を滑らかな成分と一致させる。
// どちらの波形もオクターブごとに平均 0・同一標準偏差となるため、解像度が粗く高周波オクターブが間引かれても場の平均や強度は変動しない。
const CELL_ABSOLUTE_MEAN = 0.2164;
const CELL_TO_NOISE_SCALE = 1.728;

// 場へ掛ける変調。coupling は段間の乗法の鎖の強さ κ、envelope は包絡の場の値 — 評価は
// 書き込み先の方向で一度だけ行い、変調は緯度帯などの気候の型へ張り付く。
export interface NoiseModulation {
  readonly coupling?: FloatNode;
  readonly envelope?: FloatNode;
}

// エポック: 模様がその場で発達・衰退するための実現の混ぜ替え。ノイズ空間で大きく
// 離れた実現どうしを移行時間かけて混ぜると、模様は平行移動を保ったまま中身が入れ替わる —
// 混ぜる両実現は同じ循環で運ばれるので、見かけの運動は足されない。オフセットを連続に
// 滑らせる方式は、周波数に比例して細い段から形が崩れ、移流の lag 相関を壊すため取らない。
// 実現のオフセットは、ステップ番号を素数 EPOCH_COUNT で畳んで黄金比系の分数列へ通した
// 疑似乱数(37 個の実現の表を uniform 配列として持たずにシェーダ内で作る)。周期は
// 37 段で、いちばん短い移行時間(数時間)でも 48 h の計測窓より十分長く、同じ実現へ
// 戻らない。オフセットを無限に進める方式は、長い表示時刻でノイズ座標の桁が fp32 の
// 精度を食い潰すため取らない。オフセットの大きさは実現どうしの相関長(ノイズ空間で
// 0.3 程度)より大きく取る — たまに近い実現が並ぶとその遷移では混ぜ替えが休むが、
// 実際の雲の発達にも止まる時間があるのでそのままにする。第 0 の実現はオフセット
// 無しで、時刻 0 の場は混ぜ替えの無い場と一致する。移行時間は段ごとに呼び出し側の
// 表が決める — 細い段ほど実際の雲の寿命に合わせて短く、総観規模の段ほど長く
// (混ぜ替えが作る見かけの動きを抑える)。移行時間が短すぎると 8 h 遅れの移流ピークが
// 崩れることは実測済み(12 h で速さ比 1.07・ピーク相関 0.42、18 h で速さ比 0.81・相関 0.58)。
const EPOCH_COUNT = 37;
const EPOCH_REACH = 3.5;

// 段の移行時間 [s] を決める表。frequency 以下の段が seconds ごとに実現を混ぜ替える —
// 先に合った 1 件が効くので、混ぜ替えない段は transitionSeconds 0 の項目で拾う。
// 細い段ほど短い実際の雲の寿命(数十キロの細胞は数時間、総観規模は数日)に合わせる。
export interface EpochSchedule { readonly untilFrequency: number; readonly transitionSeconds: number }

export class CirculatingNoise {
  // オクターブごとの振幅(テーブルの寄与度 × サンプリング解像度に応じたフェード)。texelAngle から決まり標本化
  // 位置に依存しないため、位置ごとに再計算は不要。
  private readonly amplitudes: readonly FloatNode[];
  // 全オクターブの振幅の和の逆数。掛けると場の振れ幅がオクターブ数と各重みに依存しなくなる。
  private readonly normalization: number;
  // エポックの基準時刻 [s]。段ごとの移行時間で割った位相と、直線上の実現の位置は
  // シェーダの中で段ごとに計算する。
  private readonly epochTime: FloatUniform = uniform(0);
  // オクターブごとの移行時間 [s]。混ぜ替えに参加しない段は 0。
  private readonly epochTransitions: readonly number[];

  // circulation はこのノイズを運ぶ流れ、octaves はオクターブ定義配列、texelAngle はベイク先の 1 texel が張る角 [rad]。
  // epochSchedule を渡すと、表の frequency 以下の段が seconds ごとにその場で実現を混ぜ替える
  // (総観規模の段はゆっくり、細い段は早く)。渡さなければ混ぜ替えは無い。
  public constructor(
    private readonly circulation: Circulation,
    private readonly octaves: readonly NoiseOctave[],
    texelAngle: FloatNode,
    epochSchedule?: readonly EpochSchedule[],
  ) {
    // 1 波長が OCTAVE_FADE_START の texel 数に届くオクターブは満額、その半分で 0。オクターブごとに独立に決定されるため、
    // 配列が等比数列でなくても境界の不連続は生じない。
    this.amplitudes = octaves.map((octave) =>
      clamp(log2(float(OCTAVE_FADE_START).div(texelAngle.mul(octave.frequency))).add(1), 0, 1)
        .mul(octave.amplitude));
    this.normalization = 1 / octaves.reduce((sum, octave) => sum + octave.amplitude, 0);
    this.epochTransitions = octaves.map((octave) =>
      epochSchedule?.find((entry) => octave.frequency <= entry.untilFrequency)?.transitionSeconds ?? 0);
    this.syncTime(0);
  }

  // 時刻 [s] をエポックの基準 uniform へ反映する。混ぜ替えに参加しないノイズでは何もしない。
  public syncTime(seconds: number): void {
    if (this.epochTransitions.every((t) => t === 0)) return;
    this.epochTime.value = seconds;
  }

  // 単位方向 direction での滑らかなノイズ、おおむね −1..1(オクターブを重ねても全体の振幅は正規化される)。
  // modulation を渡すと、coupling(段間の乗法の鎖の強さ κ、0 なら各段は独立に重なる)と
  // envelope(包絡の場の値、0 で変わらない — 各段の振幅へ 1 + envelope × NoiseOctave.envelope)
  // を場へ掛ける。
  public at(direction: Vec3Node, modulation?: NoiseModulation): FloatNode {
    return this.pairAt(direction, modulation).x;
  }

  // 単位方向 direction での、滑らかなオクターブ成分(x)と細胞状の網目(y)の対。**2 つは同じ勾配ノイズから
  // 出るので、片方だけを取るのと同じ手数で済む。** modulation は at() と同じ。
  public pairAt(direction: Vec3Node, modulation?: NoiseModulation): Vec2Node {
    return this.circulation.carry(direction, (position) => this.fractalAt(position, modulation));
  }

  // 定義されたオクターブを合成し、全寄与の和で正規化した対(x が滑らか、y が網目)。振幅が 0 に落ちたオクターブは
  // 計算そのものをスキップする — 分岐の向きは texelAngle のみで決まり画面全域で揃うため、スレッド間の乖離は生じない。
  private fractalAt(position: Vec3Node, modulation?: NoiseModulation): Vec2Node {
    const sum = vec2(0, 0).toVar();
    // 乗法の鎖: 粗い段の実現値が高い所ほど、それより細かい段の振幅が膨らんで間欠的な場になる。
    const gate = float(1).toVar();
    for (const [index, octave] of this.octaves.entries()) {
      const amplitude = this.amplitudes[index]!;
      If(greaterThan(amplitude, 0), () => {
        const value = this.octaveValueAt(position, octave, index).toVar();
        const weight = modulation?.envelope !== undefined && octave.envelope !== undefined
          ? amplitude.mul(modulation.envelope.mul(octave.envelope).add(1)) : amplitude;
        sum.addAssign(value.mul(weight).mul(gate));
        const coupling = modulation?.coupling;
        if (coupling !== undefined) {
          gate.mulAssign(gateFactor(value.x, coupling));
        }
      });
    }
    return sum.mul(this.normalization);
  }

  // 位置 position における 1 段の値の対。エポックに参加する段は、その段の移行時間で進んだ
  // 位相の 2 つの実現を混ぜた値になる。実現のオフセットは段の周波数を掛ける前の位置へ足すので、
  // 同じ移行時間を持つ段はすべて同じ実現の組から読む。
  private octaveValueAt(position: Vec3Node, octave: NoiseOctave, index: number): Vec2Node {
    const transition = this.epochTransitions[index]!;
    if (transition === 0) {
      return octaveAt(position.mul(octave.frequency));
    }
    const phase = this.epochTime.div(transition);
    const step = floor(phase);
    const mixAmount = phase.sub(step);
    const offsetAt = (s: FloatNode): Vec3Node => {
      const i = mod(s, EPOCH_COUNT);
      return vec3(
        fract(i.mul(0.7548776662)).mul(2).sub(1),
        fract(i.mul(0.5698402909)).mul(2).sub(1),
        fract(i.mul(0.3221853546)).mul(2).sub(1),
      ).mul(EPOCH_REACH);
    };
    return mix(
      octaveAt(position.add(offsetAt(step)).mul(octave.frequency)),
      octaveAt(position.add(offsetAt(step.add(1))).mul(octave.frequency)),
      mixAmount,
    );
  }
}

// 位置 position における 1 段の値の対(x が滑らかな段、y が細胞の網目)。どちらもおおむね −1..1。
function octaveAt(position: Vec3Node): Vec2Node {
  const raw = gradientNoise(position);
  return vec2(raw, float(CELL_ABSOLUTE_MEAN).sub(abs(raw)).mul(CELL_TO_NOISE_SCALE));
}
