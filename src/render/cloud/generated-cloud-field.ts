// 気候から表示時刻の雲場を焼く所有者。気候・天気の中間場・出力場を同じ寿命で管理する。
// 雲場は量子化したキー時刻 t_k = k·CLOUD_TIME_STEP と t_{k+1} の 2 枚を持ち、読み手が表示時刻の
// 端数で補間する。同じ表示時刻なら窓の選び方と補間係数が一意に決まり、場の中身はキー時刻だけで
// 決まるので、焼き直しの履歴は絵を変えない。
import { mix, uniform } from 'three/tsl';
import { CloudField } from './cloud-field';
import { WeatherModel } from './weather-model';
import type { WebGPURenderer } from 'three/webgpu';
import type { ClimateMap } from './climate-map';
import type { GpuTimingSink } from '../gpu-timings';
import type { FieldProjection } from '../field-projection';
import type { CloudSample } from './cloud-field-sample';
import type { CloudFieldSource } from './cloud-presentation';
import type { CloudFieldKeyframes } from './cloud-field-sampler';
import type { FloatUniform, Vec3Node } from '../tsl-types';

// キー時刻の間隔 [s]。雲を流すいちばん速い上層の風(ジェット級で 50 m/s 程度)がキーのあいだに動く
// 距離が、cap の 1 texel(低軌道 400 km で約 12 km)の半分を越えない長さに取る — 補間で生じる
// 二重像が texel の内側に収まる。等倍なら 2 分に 1 度、時間を加速した分だけ密に焼き直す。
const CLOUD_TIME_STEP = 120;

export class GeneratedCloudField implements CloudFieldSource {
  private readonly model: WeatherModel;
  // キー時刻に焼いた雲場 2 枚。実体は固定で、どちらが窓の先頭を持つかは first / last が追う。
  private readonly fields: [CloudField, CloudField];
  // いま窓の先頭(キー時刻 t_k)を持つ場。もう片方が末尾(t_{k+1})。
  private first: CloudField;
  private last: CloudField;
  // first が焼いた窓の番号 k。未焼成は null。
  private windowKey: number | null = null;
  // 最後に焼いたときの気候の世代と投影の版。どちらかが変われば両方の場を焼き直す。
  private bakedClimateGeneration: number | null = null;
  private bakedProjectionRevision: number | null = null;
  private generationValue = 0;
  // 直近の prepare の表示時刻が窓の中で進んだ割合 0..1。読み手はこれで a から b へ混ぜる。
  private blendValue = 0;
  // at() が読む補間係数。prepare のたびに写す。
  private readonly blendUniform: FloatUniform = uniform(0);

  // climate と、その中間場・出力場が共有する投影法を受け取る。surfaceRadius は雲を載せる天体の
  // 半径 [m]、rotationPeriod はその自転周期 [s]。
  public constructor(
    private readonly climate: ClimateMap, private readonly projection: FieldProjection,
    surfaceRadius: number, rotationPeriod: number,
  ) {
    this.model = new WeatherModel(climate, projection, surfaceRadius, rotationPeriod);
    this.fields = [
      new CloudField(this.model, projection),
      new CloudField(this.model, projection),
    ];
    this.first = this.fields[0];
    this.last = this.fields[1];
  }

  // 窓の先頭・末尾のキー時刻に焼いた雲場と、そのあいだの補間係数。場の所有権はこのクラスに残す。
  public get textures(): CloudFieldKeyframes {
    return { a: this.first.textures, b: this.last.textures, blend: this.blendValue };
  }
  public get generation(): number { return this.generationValue; }

  // 単位方向 direction での雲を、投影自身の uv で直に読む(cap の窓ぎめを通さない読み方)。
  // 2 キー時刻の読み値をいまの補間係数で混ぜる。
  public at(direction: Vec3Node): CloudSample {
    const a = this.first.at(direction);
    const b = this.last.at(direction);
    const w = this.blendUniform;
    return {
      coverage: mix(a.coverage, b.coverage, w),
      cloudTop: mix(a.cloudTop, b.cloudTop, w),
      cellularity: mix(a.cellularity, b.cellularity, w),
      vigor: mix(a.vigor, b.vigor, w),
      upperOpticalDepth: mix(a.upperOpticalDepth, b.upperOpticalDepth, w),
      upperAltitude: mix(a.upperAltitude, b.upperAltitude, w),
      fibrousness: mix(a.fibrousness, b.fibrousness, w),
      smoothness: mix(a.smoothness, b.smoothness, w),
    };
  }

  // この場を焼く天気のモデル・気候・投影。prepare で焼いた中間場を読むときに使い、寿命はこのクラスが持つ。
  public get weatherModel(): WeatherModel { return this.model; }
  public get climateMap(): ClimateMap { return this.climate; }
  public get fieldProjection(): FieldProjection { return this.projection; }

  // 表示時刻の雲場を、天気の中間場から順に焼く。
  public prepare(renderer: WebGPURenderer, displayTime: number, gpu?: GpuTimingSink): void {
    // 気候画像の取得を始める。
    this.climate.request();
    // 気候の入力か投影の置き方が変わったら、窓の同異によらず両方の場を焼き直す。
    const climateGeneration = this.climate.generation;
    const projectionRevision = this.projection.revision;
    const inputsChanged = climateGeneration !== this.bakedClimateGeneration
      || projectionRevision !== this.bakedProjectionRevision;
    // 表示時刻の窓番号。窓の選び方は表示時刻だけの関数なので、焼き直しの履歴で絵が変わることはない。
    const key = Math.floor(displayTime / CLOUD_TIME_STEP);
    if (this.windowKey === key && !inputsChanged) {
      // 同じ窓のまま — 場は持っているので焼き直さない。
    } else if (!inputsChanged && this.windowKey !== null && key === this.windowKey + 1) {
      // 窓が 1 つ進んだ — 末尾の場はそのまま先頭へ回せるので、新しい末尾だけ焼く。
      const retired = this.first;
      this.first = this.last;
      this.last = retired;
      this.bakeAt(retired, (key + 1) * CLOUD_TIME_STEP, renderer, gpu);
      this.windowKey = key;
      this.generationValue += 1;
    } else {
      // 時刻の跳躍・逆行・入力の変化 — 両方を焼き直す。
      this.bakeAt(this.first, key * CLOUD_TIME_STEP, renderer, gpu);
      this.bakeAt(this.last, (key + 1) * CLOUD_TIME_STEP, renderer, gpu);
      this.windowKey = key;
      this.generationValue += 1;
    }
    this.bakedClimateGeneration = climateGeneration;
    this.bakedProjectionRevision = projectionRevision;
    // 補間係数は表示時刻だけの関数 — 同じ表示時刻なら同じ係数になる。
    this.blendValue = (displayTime - key * CLOUD_TIME_STEP) / CLOUD_TIME_STEP;
    this.blendUniform.value = this.blendValue;
  }

  // 時刻 time [s] の雲場を field へ焼く。天気の中間場から順に焼く。
  private bakeAt(field: CloudField, time: number, renderer: WebGPURenderer, gpu?: GpuTimingSink): void {
    this.model.syncTime(time);
    this.model.bake(renderer, gpu);
    field.render(renderer, gpu);
  }

  // 保持している雲場を解放する。
  public dispose(): void {
    for (const field of this.fields) field.dispose();
    this.model.dispose();
    this.climate.dispose();
  }
}
