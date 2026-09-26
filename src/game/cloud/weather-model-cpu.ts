// 天気のモデル。天体固定の単位方向と時刻から、気圧 → 風 → 上昇流 → 気団・渦の影響を
// CPU でその場で解く純関数の集まり。時刻の閉じた関数で、同じ方向・時刻・入力には同じ値が
// 返る。値はすべて見えのための調整値。循環ノイズの項と移流した湿度の場は畳まない近似を取る。
import * as THREE from 'three/webgpu';
import { AtmosphericWindField, SURFACE_HEIGHT, UPPER_CLOUD_HEIGHT } from '../../render/cloud/atmospheric-wind';
import {
  cycloneTroughsAtCpu, troughAnvilAtCpu, troughEyeAtCpu, troughPressureAtCpu,
} from './cyclones-cpu';
import { balancedWindCpu, FRICTION_RATE, isobarAtCpu, windStepCpu } from './wind-law-cpu';
import * as vec from '../../math/vec3';
import type { Vec3 } from '../../math/vec3';
import type { ClimateData } from '../../render/cloud/climate-map';
import type { BalancedWindCpu } from './wind-law-cpu';

// --- 球面フレーム ------------------------------------------------------------

// 自転軸。
const POLE_CPU = vec.v3(0, 1, 0);

// 単位方向の緯度 [rad]。latitudeOf の数値版。
export function latitudeAtCpu(direction: Vec3): number {
  return Math.asin(Math.min(1, Math.max(-1, direction.y)));
}

// 東向きの単位接ベクトル。eastAt の数値版。極では向きが決まらないので、長さに床を張って
// 発散を避ける。
export function eastAtCpu(direction: Vec3): Vec3 {
  const raw = vec.cross(POLE_CPU, direction);
  return vec.scale(raw, 1 / Math.max(vec.len(raw), 1e-6));
}

// 北向きの単位接ベクトル。northAt の数値版。
export function northAtCpu(direction: Vec3): Vec3 {
  return vec.cross(direction, eastAtCpu(direction));
}

// 端で立ち上がる滑らかな重み。TSL の smoothstep と同じ式の数値版。
function smoothstepValue(low: number, high: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - low) / (high - low)));
  return t * t * (3 - 2 * t);
}

// --- 気団 ---------------------------------------------------------------------
// 気団の出身地。各点から風上へ一定時間だけ遡り、遡った先の緯度がいまの緯度から
// どれだけ隔たっているかと、その点の追跡の風の速さを数値で答える。

// 風上へ遡る時間 [s]。腕の巻きは流れの角速度 × 追跡時間 — 並の低気圧(短軸の半径 1200 km、
// 24 hPa)の半径の所で、折り目は 36 h に 0.7〜0.8 rad 巻いて浅い弧に留まる。長く取るほど巻きが
// 深まって腕が芯へ絡み、windStepCpu の弦近似も破れるので、腕を伸ばすのは追跡ではなく低気圧の半径で行う。
const TRACE_SECONDS = 36 * 3600;

// 出身地の勾配を取る中心差分の刻み [rad]。**この刻みが前線帯の幅を決める** — 気団の境目は
// 折り畳まれて厚みを持たない面になるので、細かく取ると 1 texel の線しか残らない。実際の前線帯の
// 幅(150 km 前後)で均して、帯として読める太さにする。
const AIR_MASS_GRADIENT_STEP = 0.025;

// 圧縮を信じ始める追跡の風の速さと、そのまま信じる速さ [m/s]。前線の腕の明るい圧縮は 6 m/s 以上の
// 追跡の風の中にある(35〜60° の帯で、圧縮 3 を超える texel はほぼすべて 6 m/s 以上)。腕どうしが
// 出会って明るむ点は、低気圧を囲む閉じた流れの縁の、4 m/s 前後の淀んだ裾にある。風の淀む所では両側
// からの風上の追跡が同じ点へ畳み込まれ、圧縮を信じられない。1 を超える分を 3〜7 m/s で溶かすと、
// その点は 4 m/s で 0.16 に隠れ、腕は 6 m/s で 0.84 以上残る。
const CALM_SPEED = 3;
const WINDY_SPEED = 7;

// 単位方向における気団。compression は気団の境目の押し縮まり(何も起きていない所と、
// 追跡の風が淀んで境目を信じられない所で 1)、warmth はいまの緯度と出身の緯度の差 [rad]
// (正で暖気の流入、負で寒気の流入)。
export interface AirMassSampleCpu {
  readonly compression: number;
  readonly warmth: number;
}

// 単位方向における気団を返す。traceWindAt は単位方向における追跡の風を答える口 — 焼き込んだ
// 写しを経由しないので、評価ごとに風をその場で解く。surfaceRadius は気団が流れる天体の半径 [m]。
export function airMassAtCpu(
  direction: Vec3,
  traceWindAt: (direction: Vec3) => BalancedWindCpu,
  surfaceRadius: number,
): AirMassSampleCpu {
  // 風上へ遡った先の緯度との差と、追跡の風の速さ。
  const driftAt = (point: Vec3): { readonly drift: number; readonly speed: number } => {
    const wind = traceWindAt(point);
    const origin = vec.norm(
      vec.addScaled(point, windStepCpu(wind, point, -TRACE_SECONDS), 1 / surfaceRadius));
    return { drift: latitudeAtCpu(origin) - latitudeAtCpu(point), speed: vec.len(wind.velocity) };
  };
  const center = driftAt(direction);
  // 隔たりの勾配は、東西・南北それぞれの中心差分。
  const east = vec.scale(eastAtCpu(direction), AIR_MASS_GRADIENT_STEP);
  const north = vec.scale(northAtCpu(direction), AIR_MASS_GRADIENT_STEP);
  const alongEast = (
    driftAt(vec.norm(vec.add(direction, east))).drift
      - driftAt(vec.norm(vec.sub(direction, east))).drift
  ) / (2 * AIR_MASS_GRADIENT_STEP);
  const alongNorth = (
    driftAt(vec.norm(vec.add(direction, north))).drift
      - driftAt(vec.norm(vec.sub(direction, north))).drift
  ) / (2 * AIR_MASS_GRADIENT_STEP);
  // 淀んだ所の押し縮まりは信じない。
  const trusted = smoothstepValue(CALM_SPEED, WINDY_SPEED, center.speed);
  // 出身の緯度の勾配は、隔たりの勾配へ緯度そのものの勾配(北向きの単位ベクトル)を足したもの。
  const latitude = latitudeAtCpu(direction);
  return {
    compression: (Math.hypot(alongEast, alongNorth + 1) - 1) * trusted + 1,
    warmth: Math.abs(latitude) - Math.abs(latitude + center.drift),
  };
}

// --- ロスビー波 ---------------------------------------------------------------
// 中緯度の上層偏西風の中を進む、低次元のロスビー波。表示時刻から位相を直接組み立て、
// 球面の流線関数を解析的に微分した風摂動を返す。

// 長波の東西波数。波長は赤道上で地球一周の 1/5、緯度45°で約5600 kmになる。
const WAVE_NUMBER = 5;
// 波の位相速度 [rad/s]。上層偏西風の速度とは別の、波の山・谷そのものの東向き移動速度。
const WAVE_PHASE_SPEED = (3 * Math.PI / 180) / 86400;
// 位相角の進む速さ [rad/s](波数 × 位相速度)。
const WAVE_PHASE_RATE = WAVE_NUMBER * WAVE_PHASE_SPEED;
// 流線関数から出る南北風の代表速度 [m/s]。中緯度の上層平均風より小さく、蛇行を読める振幅にする。
const MERIDIONAL_SPEED = 8;

// 半径 surfaceRadius [m] の天体で、代表速度を与える流線関数の振幅 [m²/s]。
function streamfunctionAmplitude(surfaceRadius: number): number {
  return (MERIDIONAL_SPEED * surfaceRadius * Math.cos(Math.PI / 4)) / WAVE_NUMBER;
}

// 包絡が立ち上がる緯度と落ちる緯度 [rad]。中緯度の上層帯(およそ ±45°)を包み、赤道と極へ
// 滑らかに消える。
const ENVELOPE_RISE_START = 10 * Math.PI / 180;
const ENVELOPE_RISE_END = 35 * Math.PI / 180;
const ENVELOPE_FALL_START = 55 * Math.PI / 180;
const ENVELOPE_FALL_END = 80 * Math.PI / 180;
// 南北風の 1/cos(緯度) で、cos に張る床。包絡の消える極の近くで発散を抑える。
const MIN_LONGITUDE_RADIUS = 0.25;

// 位相角 [rad] を 0..2π へ畳む。
function wrapAngle(angle: number): number {
  const turns = angle / (2 * Math.PI);
  return (turns - Math.floor(turns)) * 2 * Math.PI;
}

// 中緯度の帯を包み、赤道と極へ滑らかに消える包絡。
function envelopeAtCpu(latitude: number): number {
  const absolute = Math.abs(latitude);
  return smoothstepValue(ENVELOPE_RISE_START, ENVELOPE_RISE_END, absolute)
    * (1 - smoothstepValue(ENVELOPE_FALL_START, ENVELOPE_FALL_END, absolute));
}

// 包絡の緯度方向の勾配。
function envelopeSlopeAtCpu(latitude: number): number {
  const absolute = Math.abs(latitude);
  const rising = smoothstepValue(ENVELOPE_RISE_START, ENVELOPE_RISE_END, absolute);
  const falling = smoothstepValue(ENVELOPE_FALL_START, ENVELOPE_FALL_END, absolute);
  const risingT = Math.min(1, Math.max(0,
    (absolute - ENVELOPE_RISE_START) / (ENVELOPE_RISE_END - ENVELOPE_RISE_START)));
  const fallingT = Math.min(1, Math.max(0,
    (absolute - ENVELOPE_FALL_START) / (ENVELOPE_FALL_END - ENVELOPE_FALL_START)));
  const risingSlope = risingT * (1 - risingT) * 6 / (ENVELOPE_RISE_END - ENVELOPE_RISE_START);
  const fallingSlope = fallingT * (1 - fallingT) * -6 / (ENVELOPE_FALL_END - ENVELOPE_FALL_START);
  return (risingSlope * (1 - falling) + rising * fallingSlope) * Math.sign(latitude);
}

// ロスビー波の風摂動を返す。seconds は表示時刻 [s]、surfaceRadius は天体の半径 [m]。
export function rossbyPerturbationAtCpu(
  direction: Vec3, seconds: number, surfaceRadius: number,
): Vec3 {
  const latitude = latitudeAtCpu(direction);
  const longitude = Math.atan2(direction.x, direction.z);
  const phase = longitude * WAVE_NUMBER - wrapAngle(WAVE_PHASE_RATE * seconds);
  const amplitudeOverRadius = streamfunctionAmplitude(surfaceRadius) / surfaceRadius;
  const eastWind = Math.sin(phase) * envelopeSlopeAtCpu(latitude) * -amplitudeOverRadius;
  const northWind = Math.cos(phase) * envelopeAtCpu(latitude)
    * amplitudeOverRadius * WAVE_NUMBER
    / Math.max(Math.cos(latitude), MIN_LONGITUDE_RADIUS);
  return vec.addScaled(
    vec.scale(eastAtCpu(direction), eastWind), northAtCpu(direction), northWind);
}

// --- 気候の勾配 ---------------------------------------------------------------

// 標高の勾配を取る中心差分の刻み [rad]。テクスチャの texel(2π/512)より大きく、山脈の幅より小さい。
const SLOPE_STEP = 0.02;

// 標高(陸の高さを足したもの)の水平勾配。気候値は valuesAtCpu で読み、読めない方向は高さ 0 として扱う。
export function climateSlopeAtCpu(
  climate: Pick<ClimateData, 'valuesAtCpu'>, direction: Vec3, landHeight: number,
  surfaceRadius: number,
): { readonly east: number; readonly north: number } {
  const east = vec.scale(eastAtCpu(direction), SLOPE_STEP);
  const north = vec.scale(northAtCpu(direction), SLOPE_STEP);
  const stepMeters = SLOPE_STEP * 2 * surfaceRadius;
  const heightAt = (d: Vec3): number => {
    const values = climate.valuesAtCpu(d);
    return values === null ? 0 : values.elevationM + landHeight * values.landFraction;
  };
  return {
    east: (heightAt(vec.add(direction, east)) - heightAt(vec.sub(direction, east))) / stepMeters,
    north: (heightAt(vec.add(direction, north)) - heightAt(vec.sub(direction, north))) / stepMeters,
  };
}

// --- 天気 ---------------------------------------------------------------------

// 気圧の偏差から出る上昇流。利得 [m/s] が高気圧側の吹きおろしの上限、低気圧側は尺度 [hPa] ごとに
// e 倍に伸びる(上昇は狭く強く、下降は広く弱い)。尺度は並の低気圧の芯(24 hPa)で 0.03 m/s に
// なる長さ。利得を上げると低気圧が飽和した円盤になり、流入が巻き込んだ渦を塗り潰す。
const PRESSURE_LIFT_GAIN = 0.02;
const PRESSURE_LIFT_SCALE = 27;
// 上昇流の頭打ち [m/s]。急な斜面と深い谷の芯では上昇流が並の何倍にもなり、線形のままだと湿度が
// 0/1 で切れて硬い縁の白い塊になる。
const LIFT_LIMIT = 0.06;
// 前線帯の強度計算。気団の圧縮度が立ち上がり閾値から遷移幅に達する間に、帯の強度が 0 から 1 へ推移する。開始閾値は 35〜60° 緯度帯の
// 背景圧縮度（90パーセンタイルで 1.19〜1.28）の 2 割増に設定する。
// 遷移幅は圧縮の稜線が飽和する狭さに調整し、最も高密度の中心核に帯幅を確保する。
const FRONT_ONSET = 1.45;
const FRONT_WIDTH = 0.35;
// 雨帯。眼を持つ渦が周りの気団を巻き込んで折り畳んだ筋で、圧縮は前線より桁が大きい(腕の稜線で 5〜9)。
// 稜線の最も押し縮まった区間だけが飽和して腕の先へ連続に薄れる幅に取り、芯のまわりのシアの丘(2〜4)と
// 熱帯の背景(99.9 パーセンタイルで 3.2)を拾わない。狭めると腕が太い真っ白な帯になる
// (`DEVELOP/SPEC/RENDERING.md`「雨帯は、渦が周りの気団を巻き込んで折り畳んだ筋に沿う」)。
const RAINBAND_ONSET = 5;
const RAINBAND_WIDTH = 4;
// 帯が飽和した所で立つ上昇流 [m/s]。深い谷の芯と同じだけ持ち上げるよう、頭打ち(LIFT_LIMIT)に揃える。
const BAND_LIFT = 0.06;
// 温帯と熱帯の境界緯度。温帯では前線、熱帯では雨帯の伝達関数を使い、暖気流入の補正は温帯に
// 限定して適用する。
const FRONT_LATITUDE_START = THREE.MathUtils.degToRad(20);
const FRONT_LATITUDE_FULL = THREE.MathUtils.degToRad(35);
// 風が斜面を駆け上がる分の利得。等倍では偏西風や貿易風が山脈へ当たり続けるだけで上昇流が頭打ちに
// 達し、地形の縞が年中貼り付く — 慢性的な湿潤・乾燥は平年の雲量が持つ。
const TERRAIN_LIFT_GAIN = 0.35;
// 陸へ上乗せする高さ [m]。海と陸の比熱の差を、海岸へ吹き込む風が駆け上がる斜面として代用する。
const LAND_HEIGHT_BIAS = 800;

// 大循環の気圧帯 [hPa]: 赤道と ±60° が低く、±30° と極が高い。緯度の 6 倍の余弦なので、緯度に
// ついての微分は sin(6 φ) × 6 × 振幅 [hPa/rad]。
const PRESSURE_BAND_AMPLITUDE = 8;

// 気圧の勾配を取る中心差分の刻み [rad]。台風の芯の広がり(250 km ≈ 0.039 rad)より細かく、
// 気圧の写しの 1 texel より粗い。写しは視点中心の cap なので texel の角は視点の高さで変わるが、
// いちばん粗い置き方(半径 π/2)でも 2/512 ≈ 3.9e-3 rad で、この刻みを越えない。
const GRADIENT_STEP = 0.01;
// 等圧線方向の 2 階微分を取るサンプリング刻み [rad]。半精度テクスチャにおける 2 階差分の量子化ノイズは刻みの二乗で
// 増幅される。勾配と同じ刻みで取ると、帯とノイズだけの平らな所で曲がりが雑音に埋もれる。
const BEND_STEP = 0.02;
// 風が等圧線を横切る角の上限 [rad]。湿度の風は中緯度で摩擦が作る角(45° で 30°)そのものに取る。
// 熱帯では大きな流入角を切り、台風のまわりで粒が放射状の筋に引かれるのを止める。
const SURFACE_WIND_CROSSING_LIMIT = THREE.MathUtils.degToRad(30);

// 単位方向における天気。焼き込んだ写しを経由せずその場で解く純関数 — 同じ方向・時刻・
// 入力には同じ値が返る。
export interface WeatherSampleCpu {
  readonly pressureDeviationHpa: number; // 平年からの偏差(帯と渦) [hPa]
  readonly cycloneDropHpa: number; // 渦だけの気圧の落ち込み(0 以下) [hPa]
  readonly surfaceWindEastMps: number; // 地表付近の風の東向き成分 [m/s]
  readonly surfaceWindNorthMps: number; // 地表付近の風の北向き成分 [m/s]
  readonly upperWindEastMps: number; // 上層の風の東向き成分 [m/s]
  readonly upperWindNorthMps: number; // 上層の風の北向き成分 [m/s]
  readonly liftMps: number; // 上昇流 [m/s](負なら下降)
  readonly compression: number; // 気団の境目の押し縮まり(1 で何も起きていない)
  readonly bandStrength: number; // 気団の折り目に立つ雲の帯(温帯で前線、眼を持つ渦のまわりで雨帯) 0..1
  readonly warmthRad: number; // 暖気の流入(出身緯度との差に温帯の重みを掛けたもの) [rad]
  readonly eyeStrength: number; // 眼の濃さ 0..1
  readonly anvilStrength: number; // 金床の濃さ 0..1
}

// 気圧の偏差 [hPa] が生む上昇流 [m/s]。低気圧で正、高気圧で負。
function liftFromPressureCpu(pressure: number): number {
  return (Math.exp(-pressure / PRESSURE_LIFT_SCALE) - 1) * PRESSURE_LIFT_GAIN;
}

// 上昇流を LIFT_LIMIT へ漸近させる。LIFT_LIMIT より十分弱い上昇流はほぼ素通しで、強いものだけが丸まる。
function limitLiftCpu(lift: number): number {
  return Math.tanh(lift / LIFT_LIMIT) * LIFT_LIMIT;
}

// 単位方向における天気を解く。気圧は大循環の帯と渦の谷だけで組む — 循環ノイズの項は CPU
// 評価では畳まない近似。また移流した湿度の場も畳まないので、
// 前線へ寄与するのは気団の圧縮と気圧の上昇流だけ(湿度の勾配の項は省く近似)。
export function weatherAtCpu(
  direction: Vec3,
  climateSource: Pick<ClimateData, 'valuesAtCpu'> | null,
  seconds: number,
  surfaceRadius: number,
  rotationPeriod: number,
): WeatherSampleCpu {
  const windField = new AtmosphericWindField();
  const troughs = cycloneTroughsAtCpu(seconds, surfaceRadius, rotationPeriod);
  const latitude = latitudeAtCpu(direction);
  const east = eastAtCpu(direction);
  const north = northAtCpu(direction);

  // 気圧の偏差 [hPa]: 大循環の帯 + 低気圧の谷。
  const pressureAt = (point: Vec3): number => {
    let pressure = -PRESSURE_BAND_AMPLITUDE * Math.cos(6 * latitudeAtCpu(point));
    for (const trough of troughs) pressure += troughPressureAtCpu(trough, point);
    return pressure;
  };

  // 気圧と、その勾配・等圧線方向の曲がり。曲がりは等圧線に沿って測る — 勾配の向きに測ると、
  // 谷の深さそのものを曲率として検出してしまう。
  interface PressureFieldCpu {
    readonly pressure: number;
    readonly gradient: Vec3;
    readonly bend: number;
  }
  const pressureFieldAt = (point: Vec3): PressureFieldCpu => {
    const eastVector = eastAtCpu(point);
    const northVector = northAtCpu(point);
    const pressure = pressureAt(point);
    const eastStep = vec.scale(eastVector, GRADIENT_STEP);
    const northStep = vec.scale(northVector, GRADIENT_STEP);
    const gradient = vec.scale(vec.add(
      vec.scale(eastVector, pressureAt(vec.norm(vec.add(point, eastStep)))
        - pressureAt(vec.norm(vec.sub(point, eastStep)))),
      vec.scale(northVector, pressureAt(vec.norm(vec.add(point, northStep)))
        - pressureAt(vec.norm(vec.sub(point, northStep))))), 1 / (2 * GRADIENT_STEP));
    const isobar = isobarAtCpu(point, gradient);
    const isobarStep = vec.scale(isobar, BEND_STEP);
    const bend = (pressureAt(vec.norm(vec.add(point, isobarStep)))
      + pressureAt(vec.norm(vec.sub(point, isobarStep))) - 2 * pressure) / (BEND_STEP ** 2);
    return { pressure, gradient, bend };
  };

  // 気団を風上へ遡らせる風。大循環の気圧帯を差し引いた気圧の勾配から解いた釣り合い風へ、
  // 大循環の平均風とロスビー波を重ねる。気圧帯を残すと、収束する緯度に緯線に沿った圧縮の環が立つ。
  const traceWindAt = (point: Vec3): BalancedWindCpu => {
    const field = pressureFieldAt(point);
    const pointLatitude = latitudeAtCpu(point);
    const eddy = vec.sub(field.gradient,
      vec.scale(northAtCpu(point), Math.sin(6 * pointLatitude) * 6 * PRESSURE_BAND_AMPLITUDE));
    const wind = balancedWindCpu(
      eddy, isobarAtCpu(point, eddy), field.bend, pointLatitude, FRICTION_RATE,
      SURFACE_WIND_CROSSING_LIMIT, surfaceRadius, rotationPeriod);
    const mean = windField.sample(pointLatitude, SURFACE_HEIGHT);
    return {
      velocity: vec.add(vec.add(
        wind.velocity,
        vec.scale(eastAtCpu(point), mean.east)),
        vec.add(
          vec.scale(northAtCpu(point), mean.north),
          rossbyPerturbationAtCpu(point, seconds, surfaceRadius))),
      turn: wind.turn,
    };
  };
  const airMass = airMassAtCpu(direction, traceWindAt, surfaceRadius);

  // 地表付近と上層の風: 帯を含む勾配の釣り合い風へ平均風とロスビー波を重ねる。
  const field = pressureFieldAt(direction);
  const localWind = balancedWindCpu(
    field.gradient, isobarAtCpu(direction, field.gradient), field.bend, latitude, FRICTION_RATE,
    SURFACE_WIND_CROSSING_LIMIT, surfaceRadius, rotationPeriod);
  const rossby = rossbyPerturbationAtCpu(direction, seconds, surfaceRadius);
  const meanSurface = windField.sample(latitude, SURFACE_HEIGHT);
  const meanUpper = windField.sample(latitude, UPPER_CLOUD_HEIGHT);
  const surfaceWind = vec.add(vec.add(
    localWind.velocity, vec.scale(east, meanSurface.east)),
    vec.add(vec.scale(north, meanSurface.north), rossby));
  const upperWind = vec.add(vec.add(
    localWind.velocity, vec.scale(east, meanUpper.east)),
    vec.add(vec.scale(north, meanUpper.north), rossby));
  const surfaceEast = vec.dot(surfaceWind, east);
  const surfaceNorth = vec.dot(surfaceWind, north);

  // 上昇流: 風が斜面を駆け上がる分と、気圧の谷が引き上げる分と、気団の境目が押し上げる分。
  const slope = climateSource === null
    ? { east: 0, north: 0 }
    : climateSlopeAtCpu(climateSource, direction, LAND_HEIGHT_BIAS, surfaceRadius);
  const terrainLift = (surfaceEast * slope.east + surfaceNorth * slope.north) * TERRAIN_LIFT_GAIN;
  const pressureLift = liftFromPressureCpu(field.pressure);
  const updraft = smoothstepValue(0.01, 0.04, Math.max(pressureLift, 0));
  const extratropical = smoothstepValue(
    FRONT_LATITUDE_START, FRONT_LATITUDE_FULL, Math.abs(latitude));
  const front = Math.min(
    smoothstepValue(FRONT_ONSET, FRONT_ONSET + FRONT_WIDTH, airMass.compression)
      + updraft * 0.15, 1) * extratropical;
  const rainband = smoothstepValue(
    RAINBAND_ONSET, RAINBAND_ONSET + RAINBAND_WIDTH, airMass.compression) * (1 - extratropical);
  const band = Math.min(front + rainband, 1);
  const lift = limitLiftCpu(terrainLift + pressureLift + band * BAND_LIFT);

  // 渦が表面へ貼る項(眼の乾きと金床の天蓋)と、渦だけの気圧の落ち込み。
  let cycloneDropHpa = 0;
  let eyeStrength = 0;
  let anvilStrength = 0;
  for (const trough of troughs) {
    cycloneDropHpa += troughPressureAtCpu(trough, direction);
    eyeStrength += troughEyeAtCpu(trough, direction);
    anvilStrength += troughAnvilAtCpu(trough, direction);
  }

  return {
    pressureDeviationHpa: field.pressure,
    cycloneDropHpa,
    surfaceWindEastMps: surfaceEast,
    surfaceWindNorthMps: surfaceNorth,
    upperWindEastMps: vec.dot(upperWind, east),
    upperWindNorthMps: vec.dot(upperWind, north),
    liftMps: lift,
    compression: airMass.compression,
    bandStrength: band,
    warmthRad: airMass.warmth * extratropical,
    eyeStrength,
    anvilStrength,
  };
}
