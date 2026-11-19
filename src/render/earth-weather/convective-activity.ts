// 対流の診断。場所と時刻から、対流がどれだけ立つかを 3 つの別々の量で答える — 浅い積雲の量へ足す
// 湿度(shallowForcing)、深い対流(塔・雷雨)の起こりやすさ(deepPotential)、粒か板かの形態を
// 決める活発度(activity)。陸は日射と地表の湿りに追随して日変化し、山地は比高のある斜面で強く
// 早く立ち、海は日変化が小さく暖かい海だけで深い対流が立つ(`DEVELOP/SPEC/RENDERING.md`「雲の描画」)。
// 値はすべて見えのための調整値。
import { clamp, cos, float, mix, pow, smoothstep } from 'three/tsl';
import { CLOUD_TUNING } from './cloud-tuning';
import { CirculatingNoise } from './circulating-noise';
import type { NoiseOctave } from './circulating-noise';
import type { Circulation } from './circulation';
import type { SolarClock } from './solar-clock';
import type { FieldProjection } from '../field-projection';
import type { FloatNode, Vec3Node } from '../tsl-types';

// 気団ノイズのオクターブ定義表と、その振幅。雲塊の配置(800 km)より粗い所から始めて、粒(48 km)の
// 約 5 倍の 250 km まで届かせる — 活発度が粒ごとではなく粒の群れごとに振れるので、粒は数百 km の
// 塊に群れ、塊のあいだは静かな隙間として晴れる(`DEVELOP/SPEC/RENDERING.md`「粒は数百キロの
// 塊に群れ、塊のあいだは晴れる」)。積雲の粒(48〜24 km)には届かせない — 粒より細かい所で
// 活発度が振れると、粒が消え残るのではなく 1 つ 1 つが薄まる。振れ幅は、気団だけでは活発度が
// 中間の階調に留まる高さに取る — 板と粒へ振り切るのは上昇流と気団の流入で、ノイズはその中間領域の
// 分布を担う。
const INSTABILITY_NOISE: readonly NoiseOctave[] = [
  { frequency: 6.4, amplitude: 1 }, // 1000 km
  { frequency: 12.8, amplitude: 0.65 }, // 500 km
  { frequency: 25, amplitude: 0.65 }, // 250 km
];
const INSTABILITY_AMPLITUDE = CLOUD_TUNING.instabilityAmplitude;
// 上昇流の対流活発度に対する伝達利得 [per m/s] と、無上昇流時の基準活発度。並の低気圧(0.02 m/s)で
// 気団に依らず 1 へ、高気圧の吹きおろし(−0.02 m/s)で床へ届く。
const LIFT_ACTIVITY = CLOUD_TUNING.liftActivity;
const ACTIVITY_BASE = CLOUD_TUNING.activityBase;
// 寒気流入の対流活発度に対する寄与ゲイン [per rad] と、活発度の下限値。並の寒気の吹き出し(−0.26 rad)で
// 活発度が半分ぶん上がる高さに取る。
const COLD_ACTIVITY = CLOUD_TUNING.coldActivity;
const ACTIVITY_MIN = CLOUD_TUNING.activityMin;
// 地表の駆動(深い対流の起こりやすさ 0..1)が活発度へ渡る利得。日射で温まった陸と山地、暖かい海が
// 粒へ千切れる。
const SURFACE_ACTIVITY = CLOUD_TUNING.surfaceActivity;
// 陸が基準として活発度へ足す分。陸の面は夜も細かく千切れる。
const LAND_ACTIVITY = CLOUD_TUNING.landActivity;
// 前線帯・雨帯が対流活発度へ寄与する伝達利得。帯の中の対流は活発で、粒立った塔が列をなす —
// 帯が飽和した所で活発度が半分ぶん上がる高さに取る。
const BAND_ACTIVITY = CLOUD_TUNING.bandActivity;

// 日射のピークから対流が立つまでの遅れ [時]。浅い積雲は正午過ぎ(Eastman & Warren 2014)、深い対流は
// 午後遅く(Dai 2001)にいちばん多い。山地では斜面の加熱で早く立つぶん遅れが縮む。
const SHALLOW_LAG_HOURS = CLOUD_TUNING.shallowLagHours;
const DEEP_LAG_HOURS = CLOUD_TUNING.deepLagHours;
const MOUNTAIN_PHASE_ADVANCE_HOURS = CLOUD_TUNING.mountainPhaseAdvanceHours;
// 陸の湿りを平年の雲量から読む S 字の裾と肩。乾いた陸は日射が強くても雲が立たない(LCL が境界層の
// 上へ出る)ので、湿りが駆動の門を担う。
const WETNESS_ONSET = CLOUD_TUNING.wetnessCloudinessOnset;
const WETNESS_FULL = CLOUD_TUNING.wetnessCloudinessFull;
// 山地と見なす比高 [m] の裾と肩。標高の高さではなく斜面の起伏に従い、最高峰の平らな頂上は含まない。
const RELIEF_ONSET = CLOUD_TUNING.reliefOnset;
const RELIEF_FULL = CLOUD_TUNING.reliefFull;
// 浅い積雲の駆動の基準(海の駆動で、湿った陸の日平均にほぼ等しい)と、海の日変化の振れ幅(基準比。
// 正午過ぎに最大)、駆動の基準からの偏りが湿度へ渡る利得。陸の駆動は日射の立方根(対流速度スケール
// w* が浮力フラックスの 1/3 乗に比例する: Deardorff 1970)で、夜は床まで下がる。
const SHALLOW_NIGHT_FLOOR = CLOUD_TUNING.shallowNightFloor;
const SHALLOW_DRIVE_MEAN = CLOUD_TUNING.shallowDriveMean;
const OCEAN_DIURNAL = CLOUD_TUNING.oceanDiurnal;
const SHALLOW_FORCING_GAIN = CLOUD_TUNING.shallowForcingGain;
// 深い対流の駆動の強さ。陸の平地は山地を 1 として何割か、暖かい海は何割か。暖かい海の門 [K] は、
// 海面水温がおよそ 26℃から 29.5℃へ向かって深い対流が増える(Zhang 1993)ことの平年気温での代用。
const LAND_DEEP_SCALE = CLOUD_TUNING.landDeepScale;
const OCEAN_DEEP_SCALE = CLOUD_TUNING.oceanDeepScale;
const OCEAN_DEEP_DIURNAL = CLOUD_TUNING.oceanDeepDiurnal;
const WARM_SEA_ONSET = CLOUD_TUNING.warmSeaTemperatureOnset;
const WARM_SEA_FULL = CLOUD_TUNING.warmSeaTemperatureFull;
// 地方太陽時の位相 [時]: 海の浅い積雲は正午過ぎ、海の深い対流は早朝に最大。
const OCEAN_SHALLOW_PEAK_HOUR = 13;
const OCEAN_DEEP_PEAK_HOUR = 5;

// 対流の診断。
export interface ConvectiveDiagnosis {
  // 浅い積雲の量へ足す湿度(日射と湿りが駆動の基準を上回る昼の陸で正、夜と乾いた陸で負)。
  readonly shallowForcing: FloatNode;
  // 深い対流の起こりやすさ 0..1(日射・湿り・比高・海面水温から)。
  readonly deepPotential: FloatNode;
  // 対流の強弱がどれだけ強く現れるか(ACTIVITY_MIN..1)。
  readonly activity: FloatNode;
}

// 地表の状態。陸らしさ 0..1、地形の比高 [m]、平均気温 [K]、平年の雲量 0..1。
export interface ConvectiveSurface {
  readonly land: FloatNode;
  readonly reliefM: FloatNode;
  readonly temperatureK: FloatNode;
  readonly meanCloudiness: FloatNode;
}

export class ConvectiveActivity {
  // 気団の対流のしやすさのノイズ。読むのは at() の中の 1 点だけで写しへ焼いても償却できないので、
  // 評価ごとに組む。
  private readonly instability: CirculatingNoise;

  // circulation は気団を運ぶ流れ、projection は写しの持ち方、clock は日射を引く太陽の位置と時刻。
  public constructor(
    circulation: Circulation, projection: FieldProjection, private readonly clock: SolarClock,
  ) {
    this.instability = new CirculatingNoise(circulation, INSTABILITY_NOISE, projection.texelAngle);
  }

  // 単位方向 direction、上昇流 lift [m/s]、暖気の流入 warmth [rad](負で寒気)、気団の折り目の
  // 帯の強さ band 0..1、地表の状態 surface における対流の診断。
  public at(
    direction: Vec3Node, lift: FloatNode, warmth: FloatNode, band: FloatNode, surface: ConvectiveSurface,
  ): ConvectiveDiagnosis {
    const wet = smoothstep(WETNESS_ONSET, WETNESS_FULL, surface.meanCloudiness);
    const mountain = smoothstep(RELIEF_ONSET, RELIEF_FULL, surface.reliefM).mul(wet);
    const phaseAdvance = mountain.mul(MOUNTAIN_PHASE_ADVANCE_HOURS);
    const hour = this.clock.localHourNowAt(direction);

    // 浅い積雲の駆動: 陸は日射の立方根×湿り、海は基準のまわりを小さく日変化する。
    const landShallow = mix(
      SHALLOW_NIGHT_FLOOR, float(1),
      pow(this.clock.daylightAt(direction, float(SHALLOW_LAG_HOURS).sub(phaseAdvance)), 1 / 3)).mul(wet);
    const oceanShallow = cos(hour.sub(OCEAN_SHALLOW_PEAK_HOUR).mul(Math.PI / 12)).mul(OCEAN_DIURNAL)
      .add(1).mul(SHALLOW_DRIVE_MEAN);
    const shallowForcing = mix(oceanShallow, landShallow, surface.land)
      .sub(SHALLOW_DRIVE_MEAN).mul(SHALLOW_FORCING_GAIN);

    // 深い対流の駆動: 陸は午後遅くの日射×湿り(山地ほど強い)、海は暖かい所だけ。
    const landDeep = this.clock.daylightAt(direction, float(DEEP_LAG_HOURS).sub(phaseAdvance))
      .mul(wet).mul(mix(LAND_DEEP_SCALE, float(1), mountain));
    const oceanDeep = smoothstep(WARM_SEA_ONSET, WARM_SEA_FULL, surface.temperatureK)
      .mul(OCEAN_DEEP_SCALE)
      .mul(cos(hour.sub(OCEAN_DEEP_PEAK_HOUR).mul(Math.PI / 12)).mul(OCEAN_DEEP_DIURNAL).add(1));
    const deepPotential = clamp(mix(oceanDeep, landDeep, surface.land), 0, 1);

    const activity = clamp(
      this.instability.at(direction).mul(INSTABILITY_AMPLITUDE).add(lift.mul(LIFT_ACTIVITY))
        .sub(warmth.mul(COLD_ACTIVITY)).add(deepPotential.mul(SURFACE_ACTIVITY))
        .add(surface.land.mul(LAND_ACTIVITY))
        .add(band.mul(BAND_ACTIVITY)).add(ACTIVITY_BASE), ACTIVITY_MIN, 1);
    return { shallowForcing, deepPotential, activity };
  }
}
