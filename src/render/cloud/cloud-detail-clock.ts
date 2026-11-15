// 雲の細部の時間 — 細部の段ごとの寿命と、風に運ばれながら湧いて崩れる読み方。段の模様は、球面で
// 切った 3 次元ノイズを寿命あたり 1 格子ぶん半径方向へ滑らせて読むので、粒は場所ごとに独立に湧き、
// 育ち、崩れ、分かれる。生まれてから経った時間ぶん読む位置を風上へ戻すので、模様は風に乗って流れる。
// 戻す距離が溜まりすぎないよう段ごとの周期で読み直し、周期の継ぎ目の前後だけ次の周期と重ねて渡す。
import * as THREE from 'three/webgpu';
import { If, clamp, cos, float, greaterThan, normalize, sin, smoothstep, sqrt, uniform } from 'three/tsl';
import { gradientNoise } from './gradient-noise';
import type { FloatNode, FloatUniform, Vec3Node, Vec3Uniform } from '../tsl-types';

// 1 km の段の寿命 [s]。段の寿命は波長の 2/3 乗に比例する — 乱流の渦の回転時間は、エネルギー散逸率 ε を
// 一定として ε^(−1/3)・L^(2/3) で、雲の時空の尺度則(Lovejoy & Schertzer)もこの冪を示す。
// **細部の入れ替わりの速さを決める唯一のつまみ**で、時間の計測(cloud-detail:stability の τ、尺度ごとに相関が
// 1/e へ落ちる時間)へ結ぶ。勾配ノイズの相関は 1 格子滑らせる前に 1/e を切るので、ここで置く寿命は測った τ より
// 長い。値は、積雲の 2〜20 km 帯の τ が実写の可視時系列の目安(約 0.6 時間)へ近づく高さに取る。
const LIFETIME_AT_1KM = 2400;
const LIFETIME_EXPONENT = 2 / 3;
// 読み直しの周期は寿命のこの倍(上限 MAX_RECYCLE_PERIOD)。長いほど継ぎ目は稀で、風上へ戻す距離が溜まる。
const RECYCLE_LIFETIMES = 4;
// 読み直しの周期の上限 [s]。戻す距離の場所ごとの差が模様を歪めるので、均した風の勾配(数百キロで
// 10 m/s 程度)と掛けた歪みが 0.15 程度に収まる長さに取る。
const MAX_RECYCLE_PERIOD = 7200;
// 継ぎ目で次の周期と重ねる長さ(周期の割合)。重なりの間は 2 つのノイズを cos・sin の重みで足すので振れ幅は
// 保たれ、長いほど入れ替わりが緩やかになる。代わりに、重なりの間は 1 段あたり評価が 2 回になる。
const RECYCLE_BLEND = 0.4;
// 段ごとに周期の位相をずらす割合(黄金比の小数部の倍数)。ほぼ全段の周期が同じ 7200 s なので、そろえると全段が
// 同じ瞬間に別のパターンへ入れ替わり、一定の時間間隔で画面全体が急変して見える。ずらせば入れ替わりが時間に分散する。
const PHASE_STAGGER = 0.6180339887;
// 段の入れ替わり 1 回が実時間でこれより短い段は、時間加速の中では明滅にしか見えないので消す [s]。
// この 2 倍で満額。粒の個体性は失われるが、細部は場の濃さを配り直すだけなので、均した濃さは変わらない。
const MIN_VISIBLE_LIFETIME = 3;
// 読み直すたびに読む位置を飛ばす量(ノイズの格子の単位)。前の周期と相関しない遠さ。
const RESEED_SPAN = 97;
// 流れに沿って中心の両側に並べる点の数の上限。stretch が 2·FLOW_HALF_POINTS + 1 のとき全点が満額になる。
const FLOW_HALF_POINTS = 3;
// 流れに沿った点どうしの相関。添字は点の間隔の番号(段の波長の半分ずつ)で、勾配ノイズを格子で測った値。
// 重みの二乗和ではなく、この相関を含めた分散で割って和を単位分散に保つ。
const FLOW_CORRELATION = [1, 0.4, -0.06, -0.02];

// 波長 wavelength [m] の段の寿命 [s]。
function detailLifetime(wavelength: number): number {
  return LIFETIME_AT_1KM * (wavelength / 1000) ** LIFETIME_EXPONENT;
}

// 波長 wavelength [m] の段の読み直しの周期 [s]。
function recyclePeriod(wavelength: number): number {
  return Math.min(RECYCLE_LIFETIMES * detailLifetime(wavelength), MAX_RECYCLE_PERIOD);
}

// 周期の番号 cycle から、その周期に読むノイズの位置のずらしを out へ書く。
function writeReseed(cycle: number, out: THREE.Vector3): void {
  // 周期の番号を 0..1 の擬似乱数へ。k ごとに独立な列になる。
  const hash = (k: number): number => {
    const x = Math.sin(cycle * k) * 43758.5453;
    return x - Math.floor(x);
  };
  out.set(hash(12.9898), hash(78.233), hash(37.719)).multiplyScalar(RESEED_SPAN);
}

// 段ごとの時刻の uniform。表示時刻そのものはシェーダへ渡さず、段の周期で割った位相の端数と、いまと
// 次の周期に読む位置のずらしに分けて渡す — 長い走行の表示時刻は float の精度に収まらない。
export class DetailClock {
  private readonly ages: readonly FloatUniform[];
  private readonly seeds: readonly Vec3Uniform[];
  private readonly nextSeeds: readonly Vec3Uniform[];
  private readonly presences: readonly FloatUniform[];

  // wavelengths は段の波長 [m] の並び。添字が段の番号になる。
  public constructor(private readonly wavelengths: readonly number[]) {
    this.ages = wavelengths.map(() => uniform(0));
    this.seeds = wavelengths.map(() => uniform(new THREE.Vector3()));
    this.nextSeeds = wavelengths.map(() => uniform(new THREE.Vector3()));
    this.presences = wavelengths.map(() => uniform(1));
  }

  // 表示時刻 displayTime [s] と、実時間 1 秒あたりに進む表示時刻 simSpeed を置く。simSpeed 0(止まって
  // いる)では、どの段も消さない。
  public sync(displayTime: number, simSpeed: number): void {
    // 段ごとに、周期の中の経過・いまと次の周期の読み位置・時間加速の中で見えている割合を置く。
    for (const [index, wavelength] of this.wavelengths.entries()) {
      const elapsed = displayTime / recyclePeriod(wavelength) + (index * PHASE_STAGGER) % 1;
      const cycle = Math.floor(elapsed);
      this.ages[index]!.value = elapsed - cycle;
      writeReseed(cycle, this.seeds[index]!.value);
      writeReseed(cycle + 1, this.nextSeeds[index]!.value);
      const realLifetime = detailLifetime(wavelength) / Math.max(Math.abs(simSpeed), 1e-9);
      this.presences[index]!.value = THREE.MathUtils.smoothstep(
        realLifetime, MIN_VISIBLE_LIFETIME, 2 * MIN_VISIBLE_LIFETIME);
    }
  }

  // 段 index がいまの時間の進み方で見えている割合 0..1。
  public presence(index: number): FloatNode { return this.presences[index]!; }

  // 段 index の、天体固定の単位方向 direction での値。振れ幅は勾配ノイズ 1 回ぶんと同じ。radius は天体の
  // 基準半径 [m]、wind は局所の東・北を張る接ベクトルで表した風 [m/s]。wind は数百キロで均した流れで
  // なければならない — 場所ごとに大きく変わると、周期のあいだに戻す距離の差で模様がねじれる。
  public evolvingNoise(index: number, direction: Vec3Node, radius: FloatNode, wind: Vec3Node): FloatNode {
    const wavelength = this.wavelengths[index]!;
    const period = recyclePeriod(wavelength);
    const scale = radius.div(wavelength);
    // 周期 1 つぶんに風が運ぶ変位(単位方向)と、ノイズを半径方向へ滑らせる量(格子の単位)。
    const drift = wind.mul(float(period).div(radius));
    const slide = period / detailLifetime(wavelength);
    // 周期の中の経過 age(継ぎ目の後なら負)と、その周期に読む位置のずらし seed で読む値。
    const valueAt = (age: FloatNode, seed: Vec3Node): FloatNode => {
      const origin = normalize(direction.sub(drift.mul(age)));
      const position = origin.mul(scale.add(age.mul(slide)));
      return gradientNoise(position.add(seed));
    };
    const age = this.ages[index]!;
    const value = valueAt(age, this.seeds[index]!).toVar();
    // 継ぎ目の手前は、次の周期の始まりと重ねて渡す。重みは cos と sin なので振れ幅は変わらない。
    // age は全域で同じなので、この分岐は画面全体で揃う。
    const blend = smoothstep(1 - RECYCLE_BLEND, 1, age).mul(Math.PI / 2);
    If(greaterThan(blend, 0), () => {
      value.assign(value.mul(cos(blend)).add(valueAt(age.sub(1), this.nextSeeds[index]!).mul(sin(blend))));
    });
    return value;
  }

  // 段 index の、流れの向き axis に沿って平均した値。origin は読み位置の単位方向、axis は origin での単位接ベクトル、
  // stretch は伸ばす倍率(1 以上)。点は段の波長の半分ずつ流れに沿って並べ、中心の両側へ stretch に応じた重みで
  // 加えるので、stretch 1 では evolvingNoise と同じ値になり、伸ばすほど流れに沿って相関が延びる。
  // wind と radius は evolvingNoise と同じ。
  public flowNoise(
    index: number, origin: Vec3Node, radius: FloatNode, wind: Vec3Node, axis: Vec3Node, stretch: FloatNode,
  ): FloatNode {
    const spacing = this.wavelengths[index]! / 2;
    const half = stretch.sub(1).div(2);
    // 点 m(−H..H)の重み。中心は 1、外の点は伸ばし量から連続に 0 から 1 へ加わる。
    const weights = Array.from({ length: 2 * FLOW_HALF_POINTS + 1 }, (_, slot) => {
      const offset = Math.abs(slot - FLOW_HALF_POINTS);
      return offset === 0 ? float(1) : clamp(half.sub(offset - 1), 0, 1).toVar();
    });
    const sum = this.evolvingNoise(index, origin, radius, wind).toVar();
    for (let m = 1; m <= FLOW_HALF_POINTS; m++) {
      for (const sign of [1, -1]) {
        const weight = weights[FLOW_HALF_POINTS + sign * m]!;
        const point = normalize(origin.add(axis.mul(float(sign * m * spacing).div(radius))));
        If(greaterThan(weight, 0), () => {
          sum.addAssign(this.evolvingNoise(index, point, radius, wind).mul(weight));
        });
      }
    }
    // 重みの相関付きの二乗和で割り、重みを掛けた和の分散を 1 に保つ。
    const variance = float(0).toVar();
    for (let a = 0; a < weights.length; a++) {
      for (let b = 0; b < weights.length; b++) {
        const lag = Math.abs(a - b);
        if (lag < FLOW_CORRELATION.length) {
          variance.addAssign(weights[a]!.mul(weights[b]!).mul(FLOW_CORRELATION[lag]!));
        }
      }
    }
    return sum.div(sqrt(variance));
  }
}
