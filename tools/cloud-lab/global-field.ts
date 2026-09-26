// 雲の実験環境の2面が共有する全球の生成雲場。製品(earth-system.ts の earthCloudPresentation)
// と同じ組立て — ConvectiveCloudGlobalFieldSupply が導く全球質量場を
// MeteorologicalCloudField が正距円筒へ凝結して焼く — を1つ持ち、equirect に焼いた写しを
// 両面がそれぞれの投影の方向から読む。供給ジョブ・CPU 診断場は1回の呼び出しで終わらない
// 分割導出なので、drive で少しずつ進めて、届くまでは前回の場を使い続ける。
import * as THREE from 'three/webgpu';
import { texture } from 'three/tsl';
import climateTextureUrl from '../../src/assets/earth-climate.png';
import { AnnualClimateMap, type ClimateMap } from '../../src/render/cloud/climate-map';
import { AtmosphericWindField } from '../../src/render/cloud/atmospheric-wind';
import { MeteorologicalCloudField } from '../../src/render/cloud/meteorological-cloud-field';
import { cloudSampleFromTexel } from '../../src/render/cloud/cloud-field-sample';
import { equirectUvFromDirection, type FieldProjection } from '../../src/render/field-projection';
import {
  ConvectiveCloudGlobalFieldSupply, type CloudGlobalFieldSupplyResult,
} from '../../src/game/cloud/cloud-global-field-supply';
import { makeWindAt } from '../../src/game/cloud/cloud-local-field-supply';
import { earthGlobalEnvironmentAt } from '../../src/game/cloud/earth-global-environment';
import { weatherAtCpu } from '../../src/game/cloud/weather-model-cpu';
import { v3 } from '../../src/math/vec3';
import { R_EARTH, R_EARTH_EQ, SIDEREAL_DAY } from '../../src/game/celestial/solar-system/earth-system';
import type { WebGPURenderer } from 'three/webgpu';
import type { GlobalMassFieldJob, GlobalMassFieldSupply } from '../../src/render/cloud/global-mass-field';
import type { CloudSample } from '../../src/render/cloud/cloud-field-sample';
import type { FloatNode, Vec3Node, Vec4Node } from '../../src/render/tsl-types';

// earth-system.ts の私有定数(EARTH_CLOUD_GLOBAL_SEED・equirect 格子の寸法)と揃える —
// 私有なので値をここへ写す。ずれるとこの環境が製品とは別の場を出す。
const GLOBAL_SEED = 137;
const GRID_WIDTH = 128;
const GRID_HEIGHT = 64;

// CPU 診断場の equirect 格子の寸法 [texel]。質量格子より細かく取る — 気圧の谷や気団の
// 折り目はイベントセル(約450km)より細いので、診断場だけは質量格子の2倍で持つ。
const DIAG_WIDTH = 256;
const DIAG_HEIGHT = 128;

// drive 1回が供給ジョブへ出せる prepare の上限。pending のあいだ1回の prepare は
// 最大 jobStepTimeBudgetMs(6ms)の仕事をするので、これだけの束で画面が応答を失わない
// 刻みにする。
const PREPARE_STEPS_PER_DRIVE = 24;
// drive 1回が CPU 診断場へ焼く texel 数。1 texel は環境プロファイル1本分(実測で
// 0.1ms 前後)なので、質量場の駆動と合わせても1フレームに収まる刻み。
const DIAG_TEXELS_PER_DRIVE = 512;

// 単位方向で読んだ CPU 診断場。新経路が実際に読む総観規模の天気と環境プロファイルの量。
// weatherAtCpu と earthGlobalEnvironmentAt を equirect 格子で先に焼き、テクスチャとして読む。
export interface GlobalDiagnosticSample {
  readonly pressureHpa: FloatNode; // 気圧の平年からの偏差 [hPa]
  readonly liftMps: FloatNode; // 上昇流 [m/s]
  readonly compression: FloatNode; // 気団の境目の押し縮まり(1 で何も起きていない)
  readonly bandStrength: FloatNode; // 前線・雨帯の強さ 0..1
  readonly surfaceWindEastMps: FloatNode; // 地表付近の風の東向き成分 [m/s]
  readonly surfaceWindNorthMps: FloatNode; // 地表付近の風の北向き成分 [m/s]
  readonly warmthRad: FloatNode; // 暖気の流入(出身緯度との差)[rad]
  readonly anvil: FloatNode; // 金床(かなとこ)の濃さ 0..1
  readonly capeJPerKg: FloatNode; // パーセルの対流有効位置エネルギー [J/kg]
  readonly cloudBaseM: FloatNode; // 雲底(LCL、無ければ境界層の深さ)[m]
  readonly upperMoisture: FloatNode; // 上層の氷層帯の湿り(対飽和比)0..1
  readonly waterVaporKgM2: FloatNode; // 可降水量 [kg/m²]
  readonly latentFluxWPerM2: FloatNode; // 地表の潜熱フラックス [W/m²]
}

// 全球質量場の列合計。層別は持たず、供給が届いたときの液水・氷の列質量 [kg/m²] だけを読む。
export interface GlobalMassSample {
  readonly liquidKgM2: FloatNode;
  readonly iceKgM2: FloatNode;
}

// 供給へ出したジョブの追跡。走っているジョブが残っているか(場がまだ届いていないか)と、
// 完了した場の中身 — 層別・相別の列質量は結果からしか読めない — をここで拾う。
class TrackedGlobalFieldSupply implements GlobalMassFieldSupply {
  // 未完了のジョブの数。0 のとき場は届いた(あるいは要求されなかった)状態。
  public outstandingJobs = 0;
  // 最後に完了したジョブの結果。層別質量のビューがここから場を写す。
  public lastResult: CloudGlobalFieldSupplyResult | null = null;

  public constructor(private readonly inner: ConvectiveCloudGlobalFieldSupply) {}

  public startJob(displayTimeSeconds: number): GlobalMassFieldJob {
    const job = this.inner.startJob(displayTimeSeconds);
    this.outstandingJobs += 1;
    let finished = false;
    const finish = (done: boolean): void => {
      if (!done || finished) return;
      finished = true;
      this.outstandingJobs -= 1;
      this.lastResult = job.result as CloudGlobalFieldSupplyResult | null;
    };
    return {
      step: (timeBudgetMs: number) => {
        const progress = job.step(timeBudgetMs);
        finish(progress.done);
        return progress;
      },
      get result() { return job.result; },
      cancel: () => {
        job.cancel?.();
        if (!finished) {
          finished = true;
          this.outstandingJobs -= 1;
        }
      },
    };
  }
}

export class CloudLabGlobalField {
  public readonly climate: AnnualClimateMap;
  // 輸送と「平均風」ビューが共有する大気風モデル。供給へ渡すものと同じ実体。
  public readonly windField = new AtmosphericWindField();
  private readonly supply: TrackedGlobalFieldSupply;
  private readonly field: MeteorologicalCloudField;
  // CPU 診断場。4枚の Float32 RGBA テクスチャへ equirect で焼く。
  private readonly diagWeather: THREE.DataTexture;
  private readonly diagWind: THREE.DataTexture;
  private readonly diagEnvironment: THREE.DataTexture;
  private readonly diagFlux: THREE.DataTexture;
  private diagCursor = 0;
  private diagSeconds: number | null = null;
  private diagClimateGeneration = -1;
  private diagFinished = false;
  // 層別質量の列合計(R 液水・G 氷 [kg/m²])。供給が届いたときだけ焼き直す。
  private readonly massData = new Float32Array(GRID_WIDTH * GRID_HEIGHT * 4);
  private readonly massTexture: THREE.DataTexture;
  private adoptedResult: CloudGlobalFieldSupplyResult | null = null;

  // projection は全球の写しの持ち方(実験環境では正距円筒)。気候・種・格子は製品と同じ。
  public constructor(private readonly projection: FieldProjection) {
    this.climate = AnnualClimateMap.fromDeferredUrl(climateTextureUrl);
    this.supply = new TrackedGlobalFieldSupply(new ConvectiveCloudGlobalFieldSupply(
      (direction, timeSeconds) => earthGlobalEnvironmentAt(
        direction, this.climate, timeSeconds, R_EARTH, SIDEREAL_DAY),
      GLOBAL_SEED, R_EARTH_EQ, GRID_WIDTH, GRID_HEIGHT,
      makeWindAt(this.windField)));
    this.field = new MeteorologicalCloudField(this.supply, this.projection, this.climate);
    const makeDiagTexture = (): THREE.DataTexture => {
      const map = new THREE.DataTexture(
        new Float32Array(DIAG_WIDTH * DIAG_HEIGHT * 4), DIAG_WIDTH, DIAG_HEIGHT,
        THREE.RGBAFormat, THREE.FloatType);
      map.wrapS = THREE.RepeatWrapping;
      map.wrapT = THREE.ClampToEdgeWrapping;
      map.minFilter = THREE.LinearFilter;
      map.magFilter = THREE.LinearFilter;
      map.needsUpdate = true;
      return map;
    };
    this.diagWeather = makeDiagTexture();
    this.diagWind = makeDiagTexture();
    this.diagEnvironment = makeDiagTexture();
    this.diagFlux = makeDiagTexture();
    const massMap = new THREE.DataTexture(
      this.massData, GRID_WIDTH, GRID_HEIGHT, THREE.RGBAFormat, THREE.FloatType);
    massMap.wrapS = THREE.RepeatWrapping;
    massMap.wrapT = THREE.ClampToEdgeWrapping;
    massMap.minFilter = THREE.LinearFilter;
    massMap.magFilter = THREE.LinearFilter;
    massMap.needsUpdate = true;
    this.massTexture = massMap;
  }

  // この場が読む気候。画像が届くのを待つのに要る。
  public get climateMap(): ClimateMap { return this.climate; }

  // 表示時刻 seconds [s] の場が届き、診断場もその時刻で焼けていれば真。
  public settledFor(seconds: number): boolean {
    return this.supply.outstandingJobs === 0 && this.diagnosticsBakedFor(seconds);
  }

  private diagnosticsBakedFor(seconds: number): boolean {
    return this.diagFinished && this.diagSeconds === seconds
      && this.diagClimateGeneration === this.climate.generation;
  }

  // 場と診断場を1回ぶん進める。供給ジョブが残っていれば PREPARE_STEPS_PER_DRIVE 回まで
  // prepare で駆動し、届いていれば質量場の写しを更新し、CPU 診断場を1束焼く。
  // 返り値は「これ以上進めるものが無い」(settledFor と同じ判定)。
  public drive(renderer: WebGPURenderer, seconds: number): boolean {
    for (let step = 0; step < PREPARE_STEPS_PER_DRIVE; step += 1) {
      this.field.prepare(renderer, seconds);
      if (this.supply.outstandingJobs === 0) break;
    }
    this.adoptMassResult();
    this.bakeDiagnostics(seconds, DIAG_TEXELS_PER_DRIVE);
    return this.settledFor(seconds);
  }

  // 届いた層別質量を列合計して質量場の写しへ載せる。新しい結果が無ければ何もしない。
  private adoptMassResult(): void {
    const result = this.supply.lastResult;
    if (result === null || result === this.adoptedResult) return;
    const field = result.field;
    const layerCount = field.layerEdgesM.length - 1;
    const cellCount = field.width * field.height;
    for (let cell = 0; cell < cellCount; cell += 1) {
      let liquid = 0;
      let ice = 0;
      for (let layer = 0; layer < layerCount; layer += 1) {
        liquid += field.liquidKgM2[layer * cellCount + cell]!;
        ice += field.iceKgM2[layer * cellCount + cell]!;
      }
      this.massData[cell * 4] = liquid;
      this.massData[cell * 4 + 1] = ice;
    }
    this.massTexture.needsUpdate = true;
    this.adoptedResult = result;
  }

  // CPU 診断場を texelBudget 個ぶん先へ焼く。表示時刻か気候の世代が変わったら先頭から
  // 焼き直す。気候の画像が CPU から読めないあいだは環境が緯度近似へ落ちるので、
  // 読めるようになるまで焼き始めない。
  private bakeDiagnostics(seconds: number, texelBudget: number): void {
    const climateGeneration = this.climate.generation;
    if (this.diagSeconds !== seconds || this.diagClimateGeneration !== climateGeneration) {
      this.diagCursor = 0;
      this.diagSeconds = seconds;
      this.diagClimateGeneration = climateGeneration;
      this.diagFinished = false;
    }
    if (this.diagFinished) return;
    // 気候値が CPU から読めない場は緯度近似へ落ちる — 届いてから焼く。
    if (this.climate.valuesAtCpu(v3(0, 0, 1)) === null) return;
    const total = DIAG_WIDTH * DIAG_HEIGHT;
    const end = Math.min(total, this.diagCursor + texelBudget);
    for (let index = this.diagCursor; index < end; index += 1) {
      this.bakeDiagnosticTexel(index, seconds);
    }
    this.diagCursor = end;
    if (this.diagCursor >= total) this.diagFinished = true;
    for (const map of [this.diagWeather, this.diagWind, this.diagEnvironment, this.diagFlux]) {
      map.needsUpdate = true;
    }
  }

  // 診断場の texel index(equirect の行優先)へ、総観規模の天気と環境プロファイルを書く。
  private bakeDiagnosticTexel(index: number, seconds: number): void {
    const column = index % DIAG_WIDTH;
    const row = Math.floor(index / DIAG_WIDTH);
    const longitude = ((column + 0.5) / DIAG_WIDTH - 0.5) * 2 * Math.PI;
    const latitude = (0.5 - (row + 0.5) / DIAG_HEIGHT) * Math.PI;
    const flat = Math.cos(latitude);
    const direction = v3(flat * Math.sin(longitude), Math.sin(latitude), flat * Math.cos(longitude));
    const weather = weatherAtCpu(direction, this.climate, seconds, R_EARTH, SIDEREAL_DAY);
    const environment = earthGlobalEnvironmentAt(direction, this.climate, seconds, R_EARTH, SIDEREAL_DAY);
    const at = index * 4;
    const [weatherData, windData, environmentData, fluxData] = [
      this.diagWeather.image.data as Float32Array,
      this.diagWind.image.data as Float32Array,
      this.diagEnvironment.image.data as Float32Array,
      this.diagFlux.image.data as Float32Array,
    ];
    weatherData[at] = weather.pressureDeviationHpa;
    weatherData[at + 1] = weather.liftMps;
    weatherData[at + 2] = weather.compression;
    weatherData[at + 3] = weather.bandStrength;
    windData[at] = weather.surfaceWindEastMps;
    windData[at + 1] = weather.surfaceWindNorthMps;
    windData[at + 2] = weather.warmthRad;
    windData[at + 3] = weather.anvilStrength;
    environmentData[at] = environment.parcel.capeJPerKg;
    // 雲底は供給と同じ取り決め — LCL が立たない柱では境界層の深さ。
    environmentData[at + 1] = environment.parcel.lclHeightM ?? environment.boundaryLayer.depthM;
    environmentData[at + 2] = environment.upperIceMoistureFactor;
    environmentData[at + 3] = environment.columnWaterVaporKgPerM2;
    fluxData[at] = environment.surfaceLatentHeatFluxWPerM2;
    fluxData[at + 1] = environment.boundaryLayer.depthM;
    fluxData[at + 2] = 0;
    fluxData[at + 3] = 1;
  }

  // 単位方向 direction での雲(被覆率・雲頂高度・薄い雲)。全球の写しを equirect の uv で読む。
  public cloudAt = (direction: Vec3Node): CloudSample =>
    cloudSampleFromTexel(
      texture(this.field.texture, equirectUvFromDirection(direction)) as Vec4Node);

  // 単位方向 direction での CPU 診断場(総観規模の天気と環境プロファイル)。
  public diagnosticAt = (direction: Vec3Node): GlobalDiagnosticSample => {
    const uv = equirectUvFromDirection(direction);
    const weather = texture(this.diagWeather, uv);
    const wind = texture(this.diagWind, uv);
    const environment = texture(this.diagEnvironment, uv);
    const flux = texture(this.diagFlux, uv);
    return {
      pressureHpa: weather.r,
      liftMps: weather.g,
      compression: weather.b,
      bandStrength: weather.a,
      surfaceWindEastMps: wind.r,
      surfaceWindNorthMps: wind.g,
      warmthRad: wind.b,
      anvil: wind.a,
      capeJPerKg: environment.r,
      cloudBaseM: environment.g,
      upperMoisture: environment.b,
      waterVaporKgM2: environment.a,
      latentFluxWPerM2: flux.r,
    };
  };

  // 単位方向 direction での層別質量の列合計。供給が届いたときだけ値を持つ。
  public massAt = (direction: Vec3Node): GlobalMassSample => {
    const texel = texture(this.massTexture, equirectUvFromDirection(direction));
    return { liquidKgM2: texel.r, iceKgM2: texel.g };
  };

  // 生成雲場の世代。供給が届いて焼き直されるたびに進む — 暖機の完了を見るために公開する。
  public get generation(): number { return this.field.generation; }
}
