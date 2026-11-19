// 積雲の細部 — 雲場の texel より細かい尺度の起伏を張る共有評価器。32 km から 0.25 km まで
// 比 2 のオクターブの勾配ノイズを重ね、細かいオクターブの振幅を 1 つ粗いオクターブの実現値で
// 掛け合わせて、細部の強さを場所ごとに偏らせる(間欠性)。全体の振幅は評価点の場の量と
// その勾配で決まり、読み取り方向は低周波のノイズで歪ませて格子の並びを崩す。各段は風に乗って
// 流れ、段の寿命で湧いて崩れる(cloud-detail-clock.ts)。
import {
  If, clamp, cross, dot, exp, exp2, float, floor, greaterThan, int, length, max, min, mix,
  normalize, select, smoothstep, sqrt, step, uniform, uint, vec3,
} from 'three/tsl';
import { DetailClock } from './cloud-detail-clock';
import { gradientNoise } from '../gradient-noise';
import { eastAt, northAt } from '../sphere-frame';
import type { FloatNode, FloatUniform, UintNode, Vec2Node, Vec3Node } from '../../tsl-types';

// 細部のオクターブが張る波長 [m](粗→細、比 2)。粗い端は cap で場が担う最も細かい段(対流の
// 24 km、上層の湿度の 25 km)へ重なる 32 km まで — 場と細部のあいだに担い手のいない尺度を残さない。
// 細かい端は実写の放射の平滑化が折れ始める 0.25 km まで。
const DETAIL_WAVELENGTHS = [32000, 16000, 8000, 4000, 2000, 1000, 500, 250] as const;

// 最も細かいオクターブの波長 [m]。法線の差分幅はこの半分に取る。
export const FINEST_DETAIL_WAVELENGTH = DETAIL_WAVELENGTHS[DETAIL_WAVELENGTHS.length - 1]!;

// 細部が取りうる絶対値の上限。重なりと乗法で稀に越える値はここで切る — 越えても覆いと
// 雲頂の式は飽和するだけだが、切っておくと雲頂の不確かさが有限に定まる。
export const DETAIL_AMPLITUDE_MAX = 1;

// この量を下回る柱では細部を評価しない。覆いの利得が 0 へ落ちる量の範囲で、見えの差はない。
const DETAIL_PRESENT_AMOUNT = 0.001;

// オクターブごとの名目振幅の、波長に対する冪(帯域ごとの二乗平均振幅 ∝ 波長^冪)。**細部の尺度の
// 梯子の傾きを決める唯一のつまみ**で、cloud-detail:compare の尺度の梯子(生成 ÷ 実写のパワーが
// 帯によらず揃うか)へ結ぶ。輝度の k^−5/3 は冪 1/3 にあたるが、細部は覆いの二値化と雲頂の起伏を
// 通って輝度になるので、そのままでは細かい段が実写より強く出る(1/3 で 0.5〜1 km が実写の約 6 倍、
// 8〜64 km が約 0.2〜0.3 倍)。
const DETAIL_SPECTRAL_EXPONENT = 0.7;

// オクターブごとの名目振幅。波長の DETAIL_SPECTRAL_EXPONENT 乗に比例させ、和を 1 に正規化する。
const OCTAVE_WEIGHTS = (() => {
  const raw = DETAIL_WAVELENGTHS.map((wavelength) => wavelength ** DETAIL_SPECTRAL_EXPONENT);
  const total = raw.reduce((sum, weight) => sum + weight, 0);
  return raw.map((weight) => weight / total);
})();

// 名目振幅の二乗和の平方根。粒の細かさで傾けた重みをこの大きさへ割り戻す。
const OCTAVE_WEIGHT_NORM = Math.sqrt(OCTAVE_WEIGHTS.reduce((sum, weight) => sum + weight * weight, 0));

// 粒の細かさ(陸・対流で細かくなる)が名目振幅を細かい段へ傾ける強さ。
const GRAIN_TILT = 0.3;

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

// 積雲の細部を低層の風向きへ伸ばす倍率の上限。風速が CUMULUS_STREAK_WIND [m/s] で満額になる。
// 伸ばすのは DETAIL_WAVELENGTHS の添字 CUMULUS_STREAK_FIRST_OCTAVE〜CUMULUS_STREAK_LAST_OCTAVE の段(8 km と 4 km)
// だけ — 流れに沿った複数点を読むので 1 段あたり最大 3 倍の費用がかかり(標準で 3 パス計 +17%)、32・16 km の段は
// 風向きが見える尺度ではない。段数が CUMULUS_STREAK_MIN_OCTAVES 未満の精細さでは、伸ばさず費用を増やさない。
// 利得が費用に見合うまで、最も精細な設定(8 段)だけで伸ばす。
const CUMULUS_STREAK_MAX = 2;
const CUMULUS_STREAK_WIND = 10;
const CUMULUS_STREAK_FIRST_OCTAVE = 2;
const CUMULUS_STREAK_LAST_OCTAVE = 3;
const CUMULUS_STREAK_MIN_OCTAVES = 8;

// 段の波長がセルの径に収まるかの門。径の半分までは満額、径の 3 倍近くで 0 — セルより大きい構造は
// 細部の役目ではなく場(焼いた対流・湿度の段)が担うので畳む。畳み方は段の重みへの乗算だけで、読み取り
// 位置は動かさない — 読み取り位置へ場で変わる量を掛けると格子が歪み、勾配に沿って等値線が寄り集まる
// 木目になる。小さいセルの空では粗い段が畳まれて細かい粒だけが残り、大きいセルの空では梯子全体が
// 残る(基準の海洋セルでは畳まれる段がほぼ無いので、従来の見えと一致する)。
const CELL_FIT_LOG2 = Math.log2(0.5);
const CELL_EXCESS_LOG2 = Math.log2(2.8);

export class CloudDetailEvaluator {
  // 使う段数(粗い側から数える)。uniform なので、段数を変えてもシェーダのグラフは組み直さない。
  private readonly octaves: FloatUniform = uniform(0);
  private readonly clock = new DetailClock(DETAIL_WAVELENGTHS);

  // bodyRadius は雲を載せる天体の基準半径 [m](単位方向と波長・実寸の換算に使う)。
  public constructor(private readonly bodyRadius: FloatNode | number) {}

  // 使う段数を置く。幅で落ちる段は、この段数によらず評価しない。
  public setOctaves(count: number): void { this.octaves.value = count; }

  // 表示時刻 displayTime [s] と、実時間 1 秒あたりに進む表示時刻 rate を置く。
  public syncClock(displayTime: number, rate: number): void { this.clock.sync(displayTime, rate); }

  // 天体固定の単位方向 direction での細部、おおむね −1..1。width はその位置で読み手の
  // 1 画素・1 タップが張る実寸 [m]、amount はその場所の量、wind はそこで雲を運ぶ風の東・北の成分 [m/s]。
  // grain は粒の細かさ 0..1(0 が穏やかな海、1 が陸・対流の最も活発な所)、cell はその場所の対流
  // セルの径 log2(km) — 径に収まらない段の重みを畳む(読み取り位置は動かさない、CELL_FIT_LOG2 の説明)。
  // 勾配は東と北へ width ぶん離した 2 点を amountAt で読んで取る。
  public at(
    direction: Vec3Node, width: FloatNode, amount: FloatNode,
    amountAt: (direction: Vec3Node) => FloatNode, wind: Vec2Node, grain: FloatNode, cell: FloatNode,
  ): FloatNode {
    const radius = typeof this.bodyRadius === 'number' ? float(this.bodyRadius) : this.bodyRadius;
    const span = max(width, 1);
    // 段ごとの、セルの径へ収まる度合い。重みへ乗るだけで読み取り位置は動かさない(上の定数の説明)。
    const cellFits = DETAIL_WAVELENGTHS.map((wavelength) =>
      smoothstep(CELL_FIT_LOG2, CELL_EXCESS_LOG2, float(Math.log2(wavelength / 1000)).sub(cell)).oneMinus());
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
      const windVector = east.mul(wind.x).add(north.mul(wind.y));
      // 低層の風向きへ伸ばす。風が弱い所は等方に読む。東の接ベクトルを小さく足すのは、風速 0 でも向きを定めるため。
      const windDir = normalize(windVector.add(east.mul(1e-6)));
      const windCoherence = clamp(length(windVector).div(CUMULUS_STREAK_WIND), 0, 1);
      const streakTier = step(float(CUMULUS_STREAK_MIN_OCTAVES - 0.5), this.octaves);
      const streakStretch = float(1).add(float(CUMULUS_STREAK_MAX - 1).mul(windCoherence).mul(streakTier));

      // 粒の細かさに応じて名目振幅を細かい段へ傾ける(陸・対流で粒が細かくなる)。
      // 重みの二乗和を保つよう割り戻すので、傾けても細部の全体の振幅は変わらない。
      const tilt = DETAIL_WAVELENGTHS.map((wavelength) =>
        exp(grain.mul(-GRAIN_TILT * Math.log2(wavelength / 2000))));
      const tiltedNorm = tilt.reduce(
        (energy, weight, index) => {
          const weighted = weight.mul(OCTAVE_WEIGHTS[index]!).mul(cellFits[index]!);
          return energy.add(weighted.mul(weighted));
        },
        float(0));
      const weightScale = float(OCTAVE_WEIGHT_NORM).div(sqrt(tiltedNorm));

      const sum = float(0).toVar();
      const gate = float(1).toVar();
      for (const [index, wavelength] of DETAIL_WAVELENGTHS.entries()) {
        // 段数の上限の外と、幅で解像できない段は評価しない。消えた段は常に細い側なので、飛ばしても
        // 乗法の鎖は残る段で完結する。セルの径に収まらない段も畳んで評価を省く。
        const live = fadeOf(wavelength, span).mul(step(float(index + 1), this.octaves))
          .mul(this.clock.presence(index)).mul(cellFits[index]!).toVar();
        If(greaterThan(live, 0), () => {
          // 粗い段は風向きへ伸ばして読み、細かい段は等方に読む。
          const value = (index >= CUMULUS_STREAK_FIRST_OCTAVE && index <= CUMULUS_STREAK_LAST_OCTAVE
            ? this.clock.flowNoise(index, warped, radius, windVector, windDir, streakStretch)
            : this.clock.evolvingNoise(index, warped, radius, windVector)).toVar();
          sum.addAssign(value.mul(OCTAVE_WEIGHTS[index]!).mul(tilt[index]!).mul(weightScale).mul(live).mul(gate));
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

// 巻雲の細部の段。粗は細部を足さず、標準と精細は段数の上限を 4・6 とする(8 km から数えて、標準は 1 km まで、
// 精細は 0.25 km まで)。値は保存された設定を読む鍵なので、段を足すときも既存の値を動かさない。
export const CIRRUS_DETAIL = { coarse: 0, standard: 1, fine: 2 } as const;
export type CirrusDetail = (typeof CIRRUS_DETAIL)[keyof typeof CIRRUS_DETAIL];

const CIRRUS_OCTAVES: Readonly<Record<CirrusDetail, number>> = {
  [CIRRUS_DETAIL.coarse]: 0,
  [CIRRUS_DETAIL.standard]: 4,
  [CIRRUS_DETAIL.fine]: 6,
};

// 巻雲の細部の段数(巻雲の最も粗い段から数える)。
export function cirrusOctavesOf(detail: CirrusDetail): number {
  return CIRRUS_OCTAVES[detail];
}

// 巻雲の細部が使う最も粗い段の番号(DETAIL_WAVELENGTHS の添字)。巻雲は 32 km と 16 km の段を飛ばして
// 8 km から始める — 光学深さへの乗数は 16 km の起伏を 50 km の範囲で均しきれず、細部が数十キロで
// 均した濃さを変えてしまう。16〜50 km は上層の湿度の細かい段(雲場)が担う。
const CIRRUS_FIRST_OCTAVE = 2;

// 流れへの伸縮を掛ける最も細かい段(DETAIL_WAVELENGTHS の添字、ここでは 2 km)。より細かい段は等方に読む。
// 細かい段まで伸ばすと細帯が針状になるため。
const CIRRUS_STRETCH_LAST_OCTAVE = 4;

// 揃いの強い筋が流れ方向へ伸びる倍率の上限。揃い度 0 の場所は等方に読む。
const CIRRUS_STRETCH_MAX = 7;
// 巻雲の場の混ぜ方。筋状・鱗雲状・薄く広がるの各場の振れ幅(対数の標準偏差)。
const CIRRUS_STREAK_SIGMA = 0.3;
const CIRRUS_CELL_SIGMA = 0.3;
const CIRRUS_VEIL_SIGMA = 0.25;
// 薄く広がる場の段の重みの冪(波長の冪)と、その段の添字の上限(8 km と 4 km まで)。
const CIRRUS_VEIL_SPECTRAL_EXPONENT = 0.3;
const CIRRUS_VEIL_LAST_OCTAVE = 3;
// 筋状の細い段(添字 5・6)の重み。
const CIRRUS_THIN_STREAK_WEIGHT = 0.3;
// ジェットの風速の窓 [m/s]。筋状の重みはこの窓で 0 から 1 へ渡る。
const CIRRUS_JET_ONSET = 5;
const CIRRUS_JET_FULL = 16;
// 筋が流れの向きへ伸び始める風速の窓 [m/s]。ジェットの窓より広く取り、揃いはするが遅い流れでは
// 等方の濃淡へ戻す — 「流れが速く揃うほど強く引き延ばされ、弱まると向きを持たない濃淡へ戻る」
// (`DEVELOP/SPEC/RENDERING.md`)。
const CIRRUS_STRETCH_WIND_LO = 6;
const CIRRUS_STRETCH_WIND_HI = 26;
// 型の重みへの静的領域ノイズの揺らぎの強さと上下限。どの型の場を読むかは風・対流・陸の診断が担い、
// 領域ノイズは同じ条件でも場所で湧き方が違う揺らぎだけを残す(型を決めるのは診断)。
const CIRRUS_TYPE_JITTER = 0.4;
const CIRRUS_JITTER_MIN = 0.25;
const CIRRUS_JITTER_MAX = 2;
// 鱗雲状の重みへ効く対流活発度×陸の診断の利得。対流の活発な陸では筋・幕を上回る強さへ取る。
const CIRRUS_CELL_DIAG_GAIN = 2;
// 型の重みが、その型の場の評価を省く下限。
const CIRRUS_TYPE_MIN_WEIGHT = 0.02;
// 型の領域の静的な勾配ノイズ。波長 [m] と、勾配ノイズの標準偏差 0.265 を 1 寄りへ戻す倍率。
// 4 つの領域(筋状・鱗雲状と薄く広がる・鱗雲の粒の間隔の揺らぎ・列か塊か)は別の固定オフセットで読む。
const CIRRUS_REGIME_WAVELENGTH = 400000;
const CIRRUS_REGIME_GAIN = 3;
const CIRRUS_REGIME_OFFSETS = [
  vec3(11.3, 4.7, 9.1), vec3(2.9, 17.3, 5.6), vec3(23.1, 1.9, 14.4), vec3(7.7, 21.2, 3.3),
] as const;
// 鱗雲状の列に使う段の添字(DETAIL_WAVELENGTHS の 4 km)と、流れに直交する向きへ伸ばす倍率。
const CIRRUS_ROW_OCTAVE = 3;
const CIRRUS_ROW_STRETCH = 5;
// 塊の値の標準偏差へ直す平均と標準偏差(100 万点の CPU 標本、格子ハッシュと同じ写し)。
const CIRRUS_CELL_MEAN = 0.0174;
const CIRRUS_CELL_STD = 0.0872;
// 鱗雲状の格子ハッシュの乗数(cumulus-cells と同じ組)。
const CELL_AXIS_X = 0x27d4eb2f;
const CELL_AXIS_Y = 0x165667b1;
const CELL_AXIS_Z = 0x1b873593;
const CELL_MIX_A = 0x7feb352d;
const CELL_MIX_B = 0x2c1b3c6d;
// 量が少ない縁ほど濃淡を強める係数。
const CIRRUS_EDGE_SPREAD = 0.4;
// 金床の場の振れ幅。芯の分(0.15)に、量が少ないほど増える繊維の分を足す。繊維は流れの向きへ強く伸ばす。
const CIRRUS_ANVIL_SIGMA_CORE = 0.15;
const CIRRUS_ANVIL_SIGMA_FIBER = 0.6;
const CIRRUS_ANVIL_STRETCH = CIRRUS_STRETCH_MAX * 2;
// 乾燥度の目盛り(気候の雲量 0..1 の範囲)。この間で鱗雲状の重みを 0 から 1 へ渡す。
const CIRRUS_ARID_LO = 0.1;
const CIRRUS_ARID_HI = 0.35;
// 鱗雲の粒の間隔を揺らす領域ノイズの強さ。揺らぎの対数の幅 ±0.4 で、同じ大きさの空が
// 画一的な間隔で並ばないようにする。
const CIRRUS_PITCH_JITTER = 0.4;
// この量を下回る巻雲の柱では細部を評価しない。乗数は 1 のままで、光学深さは 0 に近い。
export const CIRRUS_PRESENT_AMOUNT = 0.001;

// 格子セルの整数座標から、塊の核を揺らす 32 bit のハッシュ(gradient-noise と同じ撹拌)。
function cellHash(base: Vec3Node): UintNode {
  const seed = uint(int(base.x)).mul(uint(CELL_AXIS_X))
    .bitXor(uint(int(base.y)).mul(uint(CELL_AXIS_Y)))
    .bitXor(uint(int(base.z)).mul(uint(CELL_AXIS_Z)));
  const mixed = seed.bitXor(seed.shiftRight(15)).mul(uint(CELL_MIX_A)).toVar();
  return mixed.bitXor(mixed.shiftRight(13)).mul(uint(CELL_MIX_B));
}

// 格子 q(格子単位)から最近の核までの距離 F1(格子単位)。周囲 27 セルの核を調べる。
function nearestCellDistance(q: Vec3Node): FloatNode {
  const cell = floor(q);
  const nearest = float(1e9).toVar();
  // セル境界をまたいでも最寄りの核を見落とさないよう、隣接セルまで候補に含める。
  for (const dx of [-1, 0, 1]) {
    for (const dy of [-1, 0, 1]) {
      for (const dz of [-1, 0, 1]) {
        const base = cell.add(vec3(dx, dy, dz));
        const h = cellHash(base);
        const jitter = vec3(
          float(h.bitAnd(uint(1023))),
          float(h.shiftRight(10).bitAnd(uint(1023))),
          float(h.shiftRight(20).bitAnd(uint(1023))),
        ).div(1024);
        const delta = q.sub(base.add(jitter));
        nearest.assign(min(nearest, dot(delta, delta)));
      }
    }
  }
  return sqrt(nearest);
}

// 雲標本の巻雲の量と環境の量と要素径を、巻雲の柱の入力へ写す。
export function cirrusColumnInputOf(sample: {
  readonly cirrus: FloatNode; readonly land: FloatNode; readonly convection: FloatNode;
  readonly climateCloudiness: FloatNode; readonly anvil: FloatNode;
  readonly cirrusCell: FloatNode;
}): CirrusColumnInput {
  return {
    amount: sample.cirrus, land: sample.land, convection: sample.convection,
    climateCloudiness: sample.climateCloudiness, anvil: sample.anvil,
    cellSize: sample.cirrusCell,
  };
}

// 巻雲の柱の入力。amount は巻雲の量、land・convection・climateCloudiness・anvil は環境の量(0..1)、
// cellSize は巻雲の要素径(繊維・鱗のピッチ) log2(km)。
export interface CirrusColumnInput {
  readonly amount: FloatNode;
  readonly land: FloatNode;
  readonly convection: FloatNode;
  readonly climateCloudiness: FloatNode;
  readonly anvil: FloatNode;
  readonly cellSize: FloatNode;
}

export class CirrusDetailEvaluator {
  // 使う段数(粗い側から数える)。uniform なので、段数を変えてもシェーダのグラフは組み直さない。
  private readonly octaves: FloatUniform = uniform(0);
  private readonly clock = new DetailClock(DETAIL_WAVELENGTHS);

  // 使う段数を置く。0 のときは乗数が 1 になる。
  public setOctaves(count: number): void { this.octaves.value = count; }

  // 表示時刻 displayTime [s] と、実時間 1 秒あたりに進む表示時刻 rate を置く。
  public syncClock(displayTime: number, rate: number): void { this.clock.sync(displayTime, rate); }

  // 天体固定の単位方向 direction の光学深さに掛ける乗数(正で、平均は 1)。radius は天体の基準半径 [m]、
  // width は画素・タップが張る実寸 [m]、flow は場の倍角ベクトル(筋の向きと揃い度)、wind は巻雲を運ぶ
  // 上層の風の東・北の成分 [m/s]。column は場所の巻雲の量と環境の量(0..1)と要素径 log2(km)。
  public multiplierAt(
    direction: Vec3Node, radius: FloatNode, width: FloatNode, flow: Vec2Node, wind: Vec2Node,
    column: CirrusColumnInput,
  ): FloatNode {
    const { amount, climateCloudiness, cellSize } = column;
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
    const windVector = east.mul(wind.x).add(north.mul(wind.y));
    const windSpeed = length(windVector);
    // 流れの向きへ伸ばす。揃いの弱い場所と、揃っても遅い流れは等方の濃淡へ戻る — 速く揃うほど強く引き延ばす。
    const stretch = float(1).add(float(CIRRUS_STRETCH_MAX - 1).mul(coherence)
      .mul(smoothstep(CIRRUS_STRETCH_WIND_LO, CIRRUS_STRETCH_WIND_HI, windSpeed)));

    // 型の領域。どの型の場を読むかは風・対流・陸の診断が決め、領域ノイズは同じ条件でも場所で
    // 湧き方が違う揺らぎ(重みへの乗算)だけを担う。
    const regimeAt = (offset: Vec3Node): FloatNode => gradientNoise(
      direction.mul(radius.div(CIRRUS_REGIME_WAVELENGTH)).add(offset)).mul(CIRRUS_REGIME_GAIN);
    const jitterAt = (offset: Vec3Node): FloatNode => clamp(
      float(1).add(regimeAt(offset).mul(CIRRUS_TYPE_JITTER)), CIRRUS_JITTER_MIN, CIRRUS_JITTER_MAX);
    const jet = smoothstep(CIRRUS_JET_ONSET, CIRRUS_JET_FULL, windSpeed);
    // 筋状 — 揃って速い流れの下で立つ。揃い度は半分だけ効かせて、揃わない強風にも筋を残す。
    const streakRaw = jet.mul(coherence.mul(0.5).add(0.5)).mul(jitterAt(CIRRUS_REGIME_OFFSETS[0]));
    // 鱗雲状 — 対流の活発な陸の下で立つ(cell-size.ts が鱗のピッチへ掛ける門と同じ診断 — ピッチの
    // 小ささと型の選択が同じ空で揃う)。塊の間隔が画素の実寸より細かいときと、乾いた空では 0 へ落とす。
    // ピッチの log2 [km]。格子へそのまま連続のピッチを掛けると、ピッチの勾配で格子が歪み等値線が
    // 寄り集まる木目になるので、格子は 2 の冪のピッチへ量子化し、隣接する 2 ピッチの場を端数で
    // 混ぜる(下の cellWeight の評価)。格子自身はどちらも歪まない。
    const pitchLog = cellSize
      .add(regimeAt(CIRRUS_REGIME_OFFSETS[2]).mul(CIRRUS_PITCH_JITTER)).toVar();
    const cellFade = smoothstep(2, 4, exp2(pitchLog).mul(1000).div(span));
    // 乾いた陸(気候の雲量の少ない所)では鱗雲状を抑える。筋状と薄く広がるは抑えない。
    const humid = smoothstep(CIRRUS_ARID_LO, CIRRUS_ARID_HI, climateCloudiness);
    const cellRaw = column.convection.mul(column.land).mul(CIRRUS_CELL_DIAG_GAIN)
      .mul(jitterAt(CIRRUS_REGIME_OFFSETS[1])).mul(cellFade).mul(humid);
    // 薄く広がる場は残余 — 筋でも鱗でもない静穏な空が幕を張る。
    const veilRaw = max(float(0.15), float(1).sub(streakRaw).sub(cellRaw));
    // 金床の重み。量が多く、金床の濃い所で大きい。他の型は残りを分け合う。金床は 8 km の段から読むので、
    // その段が使われないときは 0。
    const anvilWeight = column.anvil.mul(smoothstep(0.3, 0.7, amount)).mul(step(float(1), this.octaves)).toVar();
    const open = anvilWeight.oneMinus();
    const streakWeight = streakRaw.mul(open);
    const cellWeight = cellRaw.mul(open);
    const veilWeight = veilRaw.mul(open);

    const streakSum = float(0).toVar();
    const streakEnergy = float(0).toVar();
    // 各型の場の乗法の門 — 粗い段の実現値が細かい段の振幅を掛ける(積雲の細部と同じ間欠性)。
    // どの形態も一面へ均一には並ばず、筋には疎密、幕と鱗には疎な集まりが入る。
    const streakGate = float(1).toVar();
    const veilSum = float(0).toVar();
    const veilEnergy = float(0).toVar();
    const clumpGate = float(1).toVar();
    for (const [index, wavelength] of DETAIL_WAVELENGTHS.entries()) {
      if (index < CIRRUS_FIRST_OCTAVE) continue;
      const live = fadeOf(wavelength, span).mul(step(float(index - CIRRUS_FIRST_OCTAVE + 1), this.octaves))
        .mul(this.clock.presence(index)).toVar();
      If(greaterThan(live, 0), () => {
        const weight = live.mul(OCTAVE_WEIGHTS[index]!);
        // 薄く広がる場は 8 km と 4 km の段を等方に、波長の冪で重ねる。
        if (index <= CIRRUS_VEIL_LAST_OCTAVE) {
          const veilOf = live.mul(wavelength ** CIRRUS_VEIL_SPECTRAL_EXPONENT);
          const veil = this.clock.evolvingNoise(index, direction, radius, windVector);
          veilSum.addAssign(veil.mul(veilOf).mul(clumpGate));
          veilEnergy.addAssign(veilOf.mul(veilOf));
          clumpGate.mulAssign(exp(veil.mul(OCTAVE_COUPLING).sub(COUPLING_SHIFT).mul(live)));
        }
        If(greaterThan(streakWeight, CIRRUS_TYPE_MIN_WEIGHT), () => {
          // 粗い段は流れの向きへ伸ばして読み、細かい段は等方に読む。
          const along = index <= CIRRUS_STRETCH_LAST_OCTAVE
            ? this.clock.flowNoise(index, direction, radius, windVector, flowDir, stretch)
            : this.clock.evolvingNoise(index, direction, radius, windVector);
          // 細い筋はジェットの芯で立つ — 風が緩い所では筋状の場は粗いうねりへ戻る。
          const streakWeightOf = index <= CIRRUS_STRETCH_LAST_OCTAVE ? weight
            : weight.mul(CIRRUS_THIN_STREAK_WEIGHT).mul(jet);
          streakSum.addAssign(along.mul(streakWeightOf).mul(streakGate));
          streakEnergy.addAssign(streakWeightOf.mul(streakWeightOf));
          streakGate.mulAssign(exp(along.mul(OCTAVE_COUPLING).sub(COUPLING_SHIFT).mul(live)));
        });
      });
    }
    // 鱗雲状の場。丸い塊(格子の Voronoi の核からの距離)と列(流れに直交する波)を、領域で混ぜる。
    const cellsZ = float(0).toVar();
    If(greaterThan(cellWeight, CIRRUS_TYPE_MIN_WEIGHT), () => {
      // ピッチは 2 の冪の梯子へ量子化し、隣接する 2 ピッチの塊を log ピッチの端数で混ぜる —
      // 格子自身は常に一様なので、ピッチの場の勾配で歪むことはない。
      const pitchLo = floor(pitchLog);
      const pitchFrac = pitchLog.sub(pitchLo);
      const scaledAt = (pitch: FloatNode): Vec3Node =>
        direction.mul(radius.div(1000)).mul(exp2(pitch.negate()));
      const coreAt = (pitch: FloatNode): FloatNode =>
        float(1).sub(smoothstep(0, 0.55, nearestCellDistance(scaledAt(pitch)).mul(2)));
      const core = coreAt(pitchLo).toVar();
      If(greaterThan(pitchFrac, 0), () => {
        core.assign(mix(core, coreAt(pitchLo.add(1)), pitchFrac));
      });
      const cells = core.sub(CIRRUS_CELL_MEAN).div(CIRRUS_CELL_STD);
      // 列は、流れに直交する接ベクトルへ伸ばした 4 km の段で、流れに直交する波の筋になる。位置と接ベクトルの
      // 内積は 0 なので、正弦の位相を位置と流れから直には組めない。
      const rows = this.clock.flowNoise(
        CIRRUS_ROW_OCTAVE, direction, radius, windVector, normalize(cross(direction, flowDir)), float(CIRRUS_ROW_STRETCH));
      // 等方の粗い段の結合(clumpGate)を掛けて、塊が疎な集まりをなすようにする — 一面へ均一には並ばない。
      cellsZ.assign(mix(cells, rows, smoothstep(-0.3, 0.3, regimeAt(CIRRUS_REGIME_OFFSETS[3])))
        .mul(clumpGate));
    });

    // 金床の場。8 km の等方な芯と、風下へ強く伸びる繊維の和。量が少ないほど繊維の振れ幅を上げる。
    const anvilZ = float(0).toVar();
    If(greaterThan(anvilWeight, CIRRUS_TYPE_MIN_WEIGHT), () => {
      const core = this.clock.evolvingNoise(CIRRUS_FIRST_OCTAVE, direction, radius, windVector);
      const fiber = this.clock.flowNoise(
        CIRRUS_FIRST_OCTAVE, direction, radius, windVector, flowDir, float(CIRRUS_ANVIL_STRETCH));
      anvilZ.assign(core.add(fiber).div(Math.SQRT2 * NOISE_SIGMA));
    });
    const anvilSigma = float(CIRRUS_ANVIL_SIGMA_CORE).add(float(CIRRUS_ANVIL_SIGMA_FIBER).mul(amount.oneMinus()));

    // 各型の場を単位分散へ直す。段の数や幅で落ちた分は energy の平方根で割り戻す。
    const zStreak = streakSum.div(max(sqrt(streakEnergy).mul(NOISE_SIGMA), 1e-6));
    const zVeil = veilSum.div(max(sqrt(veilEnergy).mul(NOISE_SIGMA), 1e-6));
    // 型の和を重みの二乗和の平方根で割って、重みの大きさによらず分散を揃える。量が少ない縁ほど濃淡を強める。
    const norm2 = streakWeight.mul(streakWeight).add(cellWeight.mul(cellWeight))
      .add(veilWeight.mul(veilWeight)).add(anvilWeight.mul(anvilWeight));
    const norm = sqrt(norm2);
    const edge = float(1).add(float(CIRRUS_EDGE_SPREAD).mul(amount.oneMinus()));
    const logMean = streakWeight.mul(CIRRUS_STREAK_SIGMA).mul(zStreak)
      .add(cellWeight.mul(CIRRUS_CELL_SIGMA).mul(cellsZ))
      .add(veilWeight.mul(CIRRUS_VEIL_SIGMA).mul(zVeil))
      .add(anvilWeight.mul(anvilSigma).mul(anvilZ))
      .div(norm).mul(edge);
    const variance = streakWeight.mul(streakWeight).mul(CIRRUS_STREAK_SIGMA * CIRRUS_STREAK_SIGMA)
      .add(cellWeight.mul(cellWeight).mul(CIRRUS_CELL_SIGMA * CIRRUS_CELL_SIGMA))
      .add(veilWeight.mul(veilWeight).mul(CIRRUS_VEIL_SIGMA * CIRRUS_VEIL_SIGMA))
      .add(anvilWeight.mul(anvilWeight).mul(anvilSigma).mul(anvilSigma))
      .div(norm2).mul(edge).mul(edge);
    // 段が 1 つも生きていないときは、平均の補正を掛けずに乗数を 1 に保つ。
    const shift = step(float(1e-8), veilEnergy).mul(variance).mul(0.5);
    return exp(logMean.sub(shift));
  }
}
