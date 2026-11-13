// 積雲の細部 — 雲場の texel より細かい尺度の起伏を張る共有評価器。8 km から 0.25 km まで
// 比 2 のオクターブの勾配ノイズを重ね、細かいオクターブの振幅を 1 つ粗いオクターブの実現値で
// 掛け合わせて、細部の強さを場所ごとに偏らせる(間欠性)。全体の振幅は評価点の場の量と
// その勾配で決まり、読み取り方向は低周波のノイズで歪ませて格子の並びを崩す。
import {
  If, clamp, dot, exp, float, greaterThan, length, max, min, normalize, select, smoothstep, sqrt, step,
  uniform, vec3,
} from 'three/tsl';
import { gradientNoise } from './gradient-noise';
import { eastAt, northAt } from './sphere-frame';
import type { FloatNode, FloatUniform, Vec2Node, Vec3Node } from '../tsl-types';

// 細部のオクターブが張る波長 [m](粗→細、比 2)。粗い端は場の texel(低軌道の cap で
// 約 10 km)のすぐ下、細かい端は実写の放射の平滑化が折れ始める 0.25 km まで。
export const DETAIL_WAVELENGTHS = [8000, 4000, 2000, 1000, 500, 250] as const;

// 最も細かいオクターブの波長 [m]。法線の差分幅はこの半分に取る。
export const FINEST_DETAIL_WAVELENGTH = DETAIL_WAVELENGTHS[DETAIL_WAVELENGTHS.length - 1]!;

// 細部が取りうる絶対値の上限。重なりと乗法で稀に越える値はここで切る — 越えても覆いと
// 雲頂の式は飽和するだけだが、切っておくと雲頂の不確かさが有限に定まる。
export const DETAIL_AMPLITUDE_MAX = 1;

// この量を下回る柱では細部を評価しない。覆いの利得が 0 へ落ちる量の範囲で、見えの差はない。
const DETAIL_PRESENT_AMOUNT = 0.001;

// オクターブごとの名目振幅。実写の雲の輝度が持つ 1 次元波数スペクトルの傾き k^−5/3 に
// 合わせ、帯域ごとの二乗平均振幅が波長の 1/3 乗に比例するよう取り、和を 1 に正規化する。
const OCTAVE_WEIGHTS = (() => {
  const raw = DETAIL_WAVELENGTHS.map((wavelength) => Math.cbrt(wavelength));
  const total = raw.reduce((sum, weight) => sum + weight, 0);
  return raw.map((weight) => weight / total);
})();

// オクターブの波長が画素・タップの張る実寸の何倍で振幅を満額にし、何倍で消すか。
// 解像できない細かさはモアレにしかならないので、Nyquist の 2 倍へ落ちるまでに 0 へ渡す。
const FADE_FULL_RATIO = 4;
const FADE_ZERO_RATIO = 2;

// 細かいオクターブの振幅へ掛ける、粗いオクターブの実現値の強さ。0 なら各オクターブは
// 独立に重なるだけ、大きいほど粗い起伏の芯へ細部が寄って間欠性が強くなる。
const OCTAVE_COUPLING = 1.8;

// 勾配ノイズの標準偏差の実測値(60 万点標本、circulating-noise.ts の CELL_* と同じ測り方)。
// 乗法の各因子の平均を 1 へ戻す補正項 exp(−k²σ²/2) に使う。
const NOISE_SIGMA = 0.265;
const COUPLING_SHIFT = OCTAVE_COUPLING * OCTAVE_COUPLING * NOISE_SIGMA * NOISE_SIGMA / 2;

// オクターブの重ね合わせで下がる分散を、標準偏差 0.25 程度の振れ幅へ戻す全体の振幅。
const DETAIL_GAIN = 2.2;

// 全体の振幅を場から決める項。gradient [1/km] を正規化した縁項、量が飽和した板の内部へ
// 残す振幅の割合、その飽和の目盛り(量 0..1)、量が少ない柱での底上げ。
const EDGE_GRADIENT_SCALE = 0.05;
const EDGE_GAIN = 1.2;
const EDGE_MAX = 2;
const DECK_AMPLITUDE = 0.25;
const DECK_SATURATION_LO = 0.25;
const DECK_SATURATION_HI = 0.6;
const SPARSE_GAIN = 0.6;

// 読み取り方向の歪み。全オクターブが共有する方向を低周波のノイズでずらし、格子の並びを
// 崩す。ずらす実寸 [m] と、ずらしが変化する波長 [m]。
const WARP_DISPLACEMENT = 4500;
const WARP_WAVELENGTH = 32000;
// 2 つ目の歪み成分の標本位置。第 1 成分と同じ場を別の場所で読んで独立にする。
const WARP_OFFSET = vec3(5.2, 1.3, 7.9);

export class CloudDetailEvaluator {
  // 使う段数(粗い側から数える)。uniform なので、段数を変えてもシェーダのグラフは組み直さない。
  private readonly octaves: FloatUniform = uniform(0);

  // bodyRadius は雲を載せる天体の基準半径 [m](単位方向と波長・実寸の換算に使う)。
  public constructor(private readonly bodyRadius: FloatNode | number) {}

  // 使う段数を置く。幅で落ちる段は、この段数によらず評価しない。
  public setOctaves(count: number): void { this.octaves.value = count; }

  // 天体固定の単位方向 direction での細部、おおむね −1..1。width はその位置で読み手の
  // 1 画素・1 タップが張る実寸 [m]、amount はその場所の量。勾配は東と北へ width ぶん離した
  // 2 点を amountAt で読んで取る。
  public at(
    direction: Vec3Node, width: FloatNode, amount: FloatNode,
    amountAt: (direction: Vec3Node) => FloatNode,
  ): FloatNode {
    const radius = typeof this.bodyRadius === 'number' ? float(this.bodyRadius) : this.bodyRadius;
    const span = max(width, 1);
    const east = eastAt(direction);
    const north = northAt(direction);
    // 量のない柱は覆いへ届かない — 覆いは細部を不透明度の利得で掛けるので、その柱の寄与は 0 になる。
    // 勾配も歪みも段の和も評価せず、0 を返す。
    const detail = float(0).toVar();
    If(greaterThan(amount, DETAIL_PRESENT_AMOUNT), () => {
      const angle = span.div(radius);
      // 場の量の勾配 [1/km]。東と北へ 1 画素ぶん離した 2 点の量の差の大きさを、画素の実寸で割る。
      const eastStep = amountAt(normalize(direction.add(east.mul(angle)))).sub(amount);
      const northStep = amountAt(normalize(direction.add(north.mul(angle)))).sub(amount);
      const gradient = sqrt(eastStep.mul(eastStep).add(northStep.mul(northStep)))
        .mul(1000).div(span);

      // 全体の振幅 — 縁(勾配が大きい)と量の少ない柱で強く、量が飽和した板の内部で弱く。
      const edge = min(gradient.div(EDGE_GRADIENT_SCALE), EDGE_MAX).mul(EDGE_GAIN);
      const sparse = amount.oneMinus().mul(SPARSE_GAIN).add(1);
      const deck = smoothstep(DECK_SATURATION_LO, DECK_SATURATION_HI, amount)
        .mul(DECK_AMPLITUDE - 1).add(1);
      const strength = sparse.add(edge).mul(deck);

      // 全オクターブが共有する読み取り方向を低周波でずらす。乗法の整合は同じ方向を読む
      // ことで保たれる。
      const warp = direction.mul(radius.div(WARP_WAVELENGTH)).toVar();
      const warped = normalize(direction.add(
        east.mul(gradientNoise(warp)).add(north.mul(gradientNoise(warp.add(WARP_OFFSET))))
          .mul(float(WARP_DISPLACEMENT).div(radius)),
      ));

      const sum = float(0).toVar();
      const gate = float(1).toVar();
      for (const [index, wavelength] of DETAIL_WAVELENGTHS.entries()) {
        // 段数の上限の外と、幅で解像できない段は評価しない。消えた段は常に細い側なので、飛ばしても
        // 乗法の鎖は残る段で完結する。
        const live = fadeOf(wavelength, span).mul(step(float(index + 1), this.octaves)).toVar();
        If(greaterThan(live, 0), () => {
          const value = gradientNoise(warped.mul(radius).div(wavelength)).toVar();
          sum.addAssign(value.mul(OCTAVE_WEIGHTS[index]!).mul(live).mul(gate));
          gate.mulAssign(exp(value.mul(OCTAVE_COUPLING).sub(COUPLING_SHIFT).mul(live)));
        });
      }
      detail.assign(clamp(sum.mul(DETAIL_GAIN).mul(strength), -DETAIL_AMPLITUDE_MAX, DETAIL_AMPLITUDE_MAX));
    });
    return detail;
  }
}

// 1 オクターブの幅による振幅。波長が幅の FADE_FULL_RATIO 倍で満額、FADE_ZERO_RATIO 倍で 0。
function fadeOf(wavelength: number, span: FloatNode): FloatNode {
  return smoothstep(FADE_ZERO_RATIO, FADE_FULL_RATIO, float(wavelength).div(span));
}

// 巻雲の細部の段。粗は細部を足さず、標準と精細は段数の上限を 4・6 とする。値は保存された設定を
// 読む鍵なので、段を足すときも既存の値を動かさない。
export const CIRRUS_DETAIL = { coarse: 0, standard: 1, fine: 2 } as const;
export type CirrusDetail = (typeof CIRRUS_DETAIL)[keyof typeof CIRRUS_DETAIL];

const CIRRUS_OCTAVES: Readonly<Record<CirrusDetail, number>> = {
  [CIRRUS_DETAIL.coarse]: 0,
  [CIRRUS_DETAIL.standard]: 4,
  [CIRRUS_DETAIL.fine]: 6,
};

// 巻雲の細部の段数(粗い側から数える)。
export function cirrusOctavesOf(detail: CirrusDetail): number {
  return CIRRUS_OCTAVES[detail];
}

// 揃いの強い筋が流れ方向へ伸びる倍率の上限。揃い度 0 の場所は等方に読む。
const CIRRUS_STRETCH_MAX = 6;
// 光学深さの対数の標準偏差。筋の濃淡の強さで、平均を 1 に保つ補正と組で使う。
const CIRRUS_LOG_SIGMA = 0.5;
// この量を下回る巻雲の柱では細部を評価しない。乗数は 1 のままで、光学深さは 0 に近い。
export const CIRRUS_PRESENT_AMOUNT = 0.001;

export class CirrusDetailEvaluator {
  // 使う段数(粗い側から数える)。uniform なので、段数を変えてもシェーダのグラフは組み直さない。
  private readonly octaves: FloatUniform = uniform(0);

  // 使う段数を置く。0 のときは乗数が 1 になる。
  public setOctaves(count: number): void { this.octaves.value = count; }

  // 天体固定の単位方向 direction の光学深さに掛ける乗数(正で、平均は 1)。radius は天体の基準半径 [m]、
  // width は画素・タップが張る実寸 [m]、flow は場の倍角ベクトル(筋の向きと揃い度)。
  public multiplierAt(direction: Vec3Node, radius: FloatNode, width: FloatNode, flow: Vec2Node): FloatNode {
    const span = max(width, 1);
    const east = eastAt(direction);
    const north = northAt(direction);
    // 倍角ベクトルの単位方向から流れの東・北の成分を戻す。θ を −π/2 から π/2 に取るので cos θ は
    // 常に正で、sin θ は倍角の sin の符号を引き継ぐ。
    const coherence = clamp(length(flow), 0, 1);
    const axis = flow.div(max(length(flow), 1e-6));
    const cosTheta = sqrt(max(axis.x.add(1).mul(0.5), 0));
    const sinTheta = select(axis.y.lessThan(0), float(-1), float(1))
      .mul(sqrt(max(axis.x.oneMinus().mul(0.5), 0)));
    const flowDir = normalize(east.mul(cosTheta).add(north.mul(sinTheta)));
    // 流れ方向の成分を 1/stretch に縮めた位置で読む。同じ段の起伏が流れに沿って長く伸びて見える。
    const stretch = float(1).add(float(CIRRUS_STRETCH_MAX - 1).mul(coherence));
    const position = direction.mul(radius);
    const along = dot(position, flowDir);
    const stretched = position.sub(flowDir.mul(along.mul(float(1).sub(float(1).div(stretch)))));

    const sum = float(0).toVar();
    const energy = float(0).toVar();
    for (const [index, wavelength] of DETAIL_WAVELENGTHS.entries()) {
      const live = fadeOf(wavelength, span).mul(step(float(index + 1), this.octaves)).toVar();
      If(greaterThan(live, 0), () => {
        const weight = live.mul(OCTAVE_WEIGHTS[index]!);
        sum.addAssign(gradientNoise(stretched.div(wavelength)).mul(weight));
        energy.addAssign(weight.mul(weight));
      });
    }
    // 段の和を標準偏差 1 へ直す。段の数や幅で落ちた分は energy の平方根で割り戻す。
    const normal = sum.div(max(sqrt(energy).mul(NOISE_SIGMA), 1e-6));
    // 段が 1 つも生きていないときは、平均の補正を掛けずに乗数を 1 に保つ。
    const shift = step(float(1e-8), energy).mul(CIRRUS_LOG_SIGMA * CIRRUS_LOG_SIGMA / 2);
    return exp(normal.mul(CIRRUS_LOG_SIGMA).sub(shift));
  }
}
