// 生成器の気象状態を浮動小数で読み出すページ。全球を正距円筒で持つ生成雲場を表示時刻ごとに焼き、
// 天気のモデル(WeatherSample)と雲の量を色へ写す前の物理量のまま、Float32 のチャンネル面へ
// 読み戻す。全球を 720×360(0.5°、行は北→南、列は西経 180° → 東経 180°)で返す。
// window.weatherProbe が tools/cloud-regime-weather.mjs の駆動口。
import { NoToneMapping, WebGPURenderer } from 'three/webgpu';
import { screenUV, vec4 } from 'three/tsl';
import { earthGeneratedCloudField } from '../../src/game/celestial/solar-system/earth-system';
import { EquirectProjection } from '../../src/render/field-projection';
import { DeferredTexture } from '../../src/render/deferred-texture';
import {
  cirrusColumnOpticalDepthNode, cirrusTopAltitudeNode,
  cumulusInCloudOpticalDepthNode, cumulusOpacityNode, cumulusTopAltitudeNode,
} from '../../src/render/cloud/cloud-kind-node';
import { condense } from '../../src/render/cloud/condensation';
import { CUMULUS_BASE_ALTITUDE } from '../../src/render/cloud/cloud-kind';
import { FloatPlaneSet, awaitClimateMap, bytesToBase64 } from './probe-common';
import type { GeneratedCloudField } from '../../src/render/cloud/generated-cloud-field';

declare global {
  interface Window {
    weatherProbe?: WeatherProbe;
  }
}

interface WeatherProbe {
  readonly width: number;
  readonly height: number;
  // 返すチャンネルの並び。面はこの順に連なる。
  readonly channels: readonly string[];
  // 表示時刻 hours [h] の場を焼く。以後の readGlobal はこの時刻を読む。
  readonly prepare: (hours: number) => Promise<void>;
  // 全球の気象状態。チャンネルごとの面(width × height の Float32)を channels の順に並べた
  // 生の Float32(リトルエンディアン)の base64。
  readonly readGlobal: () => Promise<string>;
}

// 全球の写しの高さ [texel]。場を焼く投影の置き方は motion-main.ts と同じ。
const EQUIRECT_HEIGHT = 1024;
// 読み出す全球の面 [px]。0.5° 刻みの正距円筒。
const OUT_WIDTH = 720;
const OUT_HEIGHT = 360;

// 読み出すチャンネルの並び。物理量は天気のモデルの WeatherSample と同じ名前・単位で、
// cumulus・cirrus は雲の写しの量、cloudTop は積雲の雲頂高度 [m]、coverage は積雲の
// 不透明度(views.ts の coverage と同じ、量から不透明度へ写す式を掛けた値)。末尾の 4 つは
// 種類ごとの光学的厚みと雲頂高度 [m](cloud-kind-node の式そのまま。ISCCP 分類を
// 実写と同じ物差しで掛けるための物理量。cumulusTau は覆う割合でなく雲の中の
// 光学的厚み τ_in で、覆う割合は coverage チャンネルが持つ)。4 つずつ RGBA の写しへ割り当てるので、
// 写しの序数 × 4 がここの添字に対応する。
const CHANNELS = [
  'pressure', 'lift', 'warmth', 'cycloneFront',
  'compression', 'surfaceWindEast', 'surfaceWindNorth', 'upperWindEast',
  'upperWindNorth', 'surfaceHumidity', 'upperHumidity', 'convectiveActivity',
  'anvil', 'meanCloudiness', 'landFraction', 'cumulus',
  'cirrus', 'cloudTop', 'coverage',
  'cumulusTauIn', 'cirrusTau', 'cumulusTopM', 'cirrusTopM', 'coldSector',
] as const;

class WeatherProbeCanvas {
  private readonly planes: FloatPlaneSet;
  // 読み出す面の図法。場の写しの図法とは独立した、返す面の置き方(0.5° 刻みの正距円筒)。
  private readonly outProjection = new EquirectProjection(OUT_HEIGHT);

  public static async create(canvas: HTMLCanvasElement): Promise<WeatherProbeCanvas> {
    const renderer = new WebGPURenderer({ canvas });
    renderer.setSize(OUT_WIDTH, OUT_HEIGHT, false);
    renderer.toneMapping = NoToneMapping;
    await renderer.init();
    const field = earthGeneratedCloudField(new EquirectProjection(EQUIRECT_HEIGHT));
    const probe = new WeatherProbeCanvas(renderer, field);
    await awaitClimateMap(renderer, [field.climateMap], 'weather probe');
    return probe;
  }

  private constructor(private readonly renderer: WebGPURenderer, private readonly field: GeneratedCloudField) {
    // 全球の面の画素が張る単位方向で、天気と雲の量を CHANNELS の並びのまま RGBA へ 4 チャンネル
    // ずつ組む。色への写像・クランプはどこにも通さない。
    const direction = this.outProjection.directionAt(screenUV);
    const weather = this.field.weatherModel.weatherAt(direction);
    const cloud = this.field.at(direction);
    // ISCCP 分類へ渡す雲の中の光学的厚み・雲頂は、焼いた写しの量(被覆率へ潰れた texel 平均)ではなく
    // condense が組む雲要素そのものの雲頂から出す — 実写の分類が拾うのは画素内の要素の高さと τ で、
    // 覆う割合は coverage チャンネルが別に持つ。
    const condensed = condense(weather);
    const elementTop = condensed.cumulusElementTop;
    // 雲の中の光学的厚みは要素の幾何学的厚みから — 層状のデッキは雲頂まで柱全体を
    // 満たさないので、雲頂からの式へ厚みを仮の柱として渡す。
    const elementTau = cumulusInCloudOpticalDepthNode(
      condensed.cumulusElementThickness.add(CUMULUS_BASE_ALTITUDE));
    this.planes = new FloatPlaneSet([
      vec4(weather.pressure, weather.lift, weather.warmth, weather.cycloneFront),
      vec4(weather.compression, weather.surfaceWind.x, weather.surfaceWind.y, weather.upperWind.x),
      vec4(weather.upperWind.y, weather.surfaceHumidity, weather.upperHumidity, weather.convectiveActivity),
      vec4(weather.anvil, weather.meanCloudiness, weather.landFraction, cloud.cumulus),
      vec4(
        cloud.cirrus, cumulusTopAltitudeNode(cloud.cumulus), cumulusOpacityNode(cloud.cumulus),
        elementTau),
      // 端数の面。余った成分は読み出し側が CHANNELS の長さで打ち切る。
      vec4(
        cirrusColumnOpticalDepthNode(cloud.cirrus),
        elementTop,
        cirrusTopAltitudeNode(cloud.cirrus),
        weather.coldSector),
    ], OUT_WIDTH, OUT_HEIGHT);
  }

  // 表示時刻 hours [h] の場を焼く。
  public async prepare(hours: number): Promise<void> {
    DeferredTexture.publishOne(this.renderer);
    const seconds = hours * 3600;
    this.field.prepare(this.renderer, seconds);
    // 雲場は表示時刻の前後の 2 枚を補間で読むので、先の刻みへ焼き直した直後は天気のモデルの
    // 時刻が読み出す時刻より先へ進んでいることがある。中間場は読み出す時刻で焼き直して揃える。
    const model = this.field.weatherModel;
    model.syncTime(seconds);
    model.bake(this.renderer);
  }

  // 全チャンネルの面を描き、Float32 の生の値(リトルエンディアン)を base64 で返す。
  public async readGlobal(): Promise<string> {
    const planes = await this.planes.read(this.renderer);
    const flat = new Float32Array(CHANNELS.length * OUT_WIDTH * OUT_HEIGHT);
    planes.slice(0, CHANNELS.length).forEach((plane, c) => flat.set(plane, c * OUT_WIDTH * OUT_HEIGHT));
    return bytesToBase64(new Uint8Array(flat.buffer));
  }
}

async function init(): Promise<void> {
  const probe = await WeatherProbeCanvas.create(document.getElementById('view') as HTMLCanvasElement);
  window.weatherProbe = {
    width: OUT_WIDTH,
    height: OUT_HEIGHT,
    channels: CHANNELS,
    prepare: (hours) => probe.prepare(hours),
    readGlobal: () => probe.readGlobal(),
  };
}

init().catch((e: unknown) => {
  document.getElementById('error')!.textContent = String(e);
});
