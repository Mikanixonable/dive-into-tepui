// 天気図へ敷く気象場の面。本体と同じ工場で組んだ地球の生成雲場の天気モデルを、全球を張る
// 正距円筒(0.5° 刻み、行は北→南、列は西経 180° → 東経 180°)の画素が指す単位方向で評価し、
// Float32 のチャンネル面へ読み戻す。色への写像・トーンマップは通さない — 物理量をそのまま受け取る。
import { NoToneMapping, WebGPURenderer } from 'three/webgpu';
import { screenUV, vec4 } from 'three/tsl';
import { earthGeneratedCloudField } from '../../src/game/celestial/solar-system/earth-system';
import { EquirectProjection } from '../../src/render/field-projection';
import { DeferredTexture } from '../../src/render/deferred-texture';
import { FloatPlaneSet, awaitClimateMap } from './probe-common';
import type { GeneratedCloudField } from '../../src/render/earth-weather/cloud/generated-cloud-field';

// 全球の写しの高さ [texel]。幅はその 2 倍。
const EQUIRECT_HEIGHT = 512;
// 読み出す面の大きさ [px]。0.5° 刻みの正距円筒。
const FIELD_WIDTH = 720;
const FIELD_HEIGHT = 360;

// 全球の面。チャンネルごとの面(width × height の Float32)を名前で持つ。
// 単位と意味は天気のモデルの WeatherSample と同じ。読み出すのは地図が使う量だけ。
export interface SynopticFields {
  readonly width: number;
  readonly height: number;
  readonly pressure: Float32Array; // 平年からの偏差 [hPa]
  readonly surfaceWindEast: Float32Array; // 地表の風の東向き成分 [m/s]
  readonly surfaceWindNorth: Float32Array; // 地表の風の北向き成分 [m/s]
  readonly upperWindEast: Float32Array; // 上層の風の東向き成分 [m/s]
  readonly upperWindNorth: Float32Array; // 上層の風の北向き成分 [m/s]
  readonly compression: Float32Array; // 気団の境目の押し縮まり(1 で何も起きていない)
  readonly warmth: Float32Array; // 暖気の流入 = 出身地からの緯度の差 [rad](負で寒気)
}

export class SynopticField {
  private readonly planes: FloatPlaneSet;
  // 読み出す面の図法。場の写しの図法とは独立した、返す面の置き方。
  private readonly outProjection = new EquirectProjection(FIELD_HEIGHT);

  // 非同期の構築が要るので静的ファクトリからだけ組む。表示へ出さない器なので
  // canvas はページへぶら下げない。
  public static async create(): Promise<SynopticField> {
    const renderer = new WebGPURenderer({ canvas: document.createElement('canvas'), requiredLimits: { maxSampledTexturesPerShaderStage: 32 } });
    renderer.setSize(FIELD_WIDTH, FIELD_HEIGHT, false);
    renderer.toneMapping = NoToneMapping;
    await renderer.init();
    const source = new SynopticField(renderer, earthGeneratedCloudField(new EquirectProjection(EQUIRECT_HEIGHT)));
    await awaitClimateMap(renderer, [source.field.climateMap], 'synoptic field');
    return source;
  }

  private constructor(private readonly renderer: WebGPURenderer, private readonly field: GeneratedCloudField) {
    // 全球の面の画素が張る単位方向で、天気の量を RGBA へ 4 チャンネルずつ組む。
    // sample() が返す面の並びはここの並びに従う。
    const direction = this.outProjection.directionAt(screenUV);
    const weather = this.field.weatherModel.weatherAt(direction);
    this.planes = new FloatPlaneSet([
      vec4(weather.pressure, weather.surfaceWind.x, weather.surfaceWind.y, weather.upperWind.x),
      vec4(weather.upperWind.y, weather.compression, weather.warmth, 0),
    ], FIELD_WIDTH, FIELD_HEIGHT);
  }

  // 表示時刻 seconds [s] の場を焼き、画素ごとの物理量を面へ読み戻す。
  public async sample(seconds: number): Promise<SynopticFields> {
    DeferredTexture.publishOne(this.renderer);
    const model = this.field.weatherModel;
    model.syncTime(seconds);
    model.bake(this.renderer);
    const [
      pressure, surfaceWindEast, surfaceWindNorth, upperWindEast,
      upperWindNorth, compression, warmth,
    ] = await this.planes.read(this.renderer);
    return {
      width: FIELD_WIDTH, height: FIELD_HEIGHT,
      pressure: pressure!, surfaceWindEast: surfaceWindEast!, surfaceWindNorth: surfaceWindNorth!,
      upperWindEast: upperWindEast!, upperWindNorth: upperWindNorth!,
      compression: compression!, warmth: warmth!,
    };
  }
}
