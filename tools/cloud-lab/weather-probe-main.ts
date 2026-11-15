// 生成器の気象状態を浮動小数で読み出すページ。全球を正距円筒で持つ生成雲場を表示時刻ごとに焼き、
// 天気のモデル(WeatherSample)と雲の量を色へ写す前の物理量のまま、RGBA32F の写しへ 4 チャンネル
// ずつ描いて読み戻す。全球を 720×360(0.5°、行は北→南、列は西経 180° → 東経 180°)で返す。
// window.weatherProbe が tools/cloud-regime-weather.mjs の駆動口。
import * as THREE from 'three/webgpu';
import { QuadMesh, WebGPURenderer } from 'three/webgpu';
import { mrt, screenUV, vec4 } from 'three/tsl';
import { earthGeneratedCloudField } from '../../src/game/celestial/solar-system/earth-system';
import { EquirectProjection } from '../../src/render/field-projection';
import { DeferredTexture } from '../../src/render/deferred-texture';
import { cumulusOpacityNode, cumulusTopAltitudeNode } from '../../src/render/cloud/cloud-kind-node';
import type { GeneratedCloudField } from '../../src/render/cloud/generated-cloud-field';

declare global {
  interface Window {
    weatherProbe?: WeatherProbe;
  }
}

interface WeatherProbe {
  readonly ready: () => boolean;
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
// 気候画像が届くのを待つ上限 [フレーム]。
const CLIMATE_WAIT_FRAMES = 600;

// 読み出すチャンネルの並び。物理量は天気のモデルの WeatherSample と同じ名前・単位で、
// cumulus・cirrus は雲の写しの量、cloudTop は積雲の雲頂高度 [m]、coverage は積雲の
// 不透明度(views.ts の coverage と同じ、量から不透明度へ写す式を掛けた値)。4 つずつ
// RGBA の写しへ割り当てるので、写しの序数 × 4 がここの添字に対応する。
const CHANNELS = [
  'pressure', 'lift', 'warmth', 'band',
  'compression', 'surfaceWindEast', 'surfaceWindNorth', 'upperWindEast',
  'upperWindNorth', 'surfaceHumidity', 'upperHumidity', 'convectiveActivity',
  'anvil', 'meanCloudiness', 'landFraction', 'cumulus',
  'cirrus', 'cloudTop', 'coverage',
] as const;
const TARGET_COUNT = Math.ceil(CHANNELS.length / 4);
// MRT の出力名。写しの texture.name に合わせる(全写しで同じ — 1 写しに 1 出力)。
const MRT_NAME = 'w';

class WeatherProbeCanvas {
  // 物理量をそのまま受ける写し。RGBA32F の 4 写し同時描きは
  // maxColorAttachmentBytesPerSample(既定 32 byte = RGBA32F 2 面ぶん)を超えるので、
  // 4 チャンネルずつ 1 面の写しへ順に描く。
  private readonly targets: THREE.RenderTarget[];
  private readonly quads: QuadMesh[];
  // 読み出す面の図法。場の写しの図法とは独立した、返す面の置き方(0.5° 刻みの正距円筒)。
  private readonly outProjection = new EquirectProjection(OUT_HEIGHT);

  public static async create(canvas: HTMLCanvasElement): Promise<WeatherProbeCanvas> {
    const renderer = new WebGPURenderer({ canvas });
    renderer.setSize(OUT_WIDTH, OUT_HEIGHT, false);
    renderer.toneMapping = THREE.NoToneMapping;
    await renderer.init();
    const field = earthGeneratedCloudField(new EquirectProjection(EQUIRECT_HEIGHT));
    const probe = new WeatherProbeCanvas(renderer, field);
    await probe.awaitClimate();
    return probe;
  }

  private constructor(private readonly renderer: WebGPURenderer, private readonly field: GeneratedCloudField) {
    // 全球の面の画素が張る単位方向で、天気と雲の量を CHANNELS の並びのまま 5 面の RGBA へ組む。
    // 色への写像・クランプ・トーンマップはどこにも通さない。読み出しの 4 成分目をアルファとして
    // 潰されないよう、出力は colorNode ではなく MRT で書く(motion-main.ts の同じ仕掛け)。
    const direction = this.outProjection.directionAt(screenUV);
    const weather = this.field.weatherModel.weatherAt(direction);
    const cloud = this.field.at(direction);
    const groups = [
      vec4(weather.pressure, weather.lift, weather.warmth, weather.band),
      vec4(weather.compression, weather.surfaceWind.x, weather.surfaceWind.y, weather.upperWind.x),
      vec4(weather.upperWind.y, weather.surfaceHumidity, weather.upperHumidity, weather.convectiveActivity),
      vec4(weather.anvil, weather.meanCloudiness, weather.landFraction, cloud.cumulus),
      vec4(cloud.cirrus, cumulusTopAltitudeNode(cloud.cumulus), cumulusOpacityNode(cloud.cumulus), 0),
    ];
    this.targets = groups.map(() => {
      const target = new THREE.RenderTarget(OUT_WIDTH, OUT_HEIGHT, {
        format: THREE.RGBAFormat, type: THREE.FloatType, depthBuffer: false, samples: 0,
      });
      target.texture.name = MRT_NAME;
      return target;
    });
    this.quads = groups.map((color) => {
      const material = new THREE.MeshBasicNodeMaterial({ depthTest: false, depthWrite: false });
      material.mrtNode = mrt({ [MRT_NAME]: color });
      return new QuadMesh(material);
    });
  }

  // 気候画像の取得を始め、GPU へ載るまで待つ。投入は本体と同じ待ち行列を通す。
  private async awaitClimate(): Promise<void> {
    this.field.climateMap.request();
    for (let frame = 0; frame < CLIMATE_WAIT_FRAMES; frame += 1) {
      if (this.field.climateMap.generation > 0) return;
      await new Promise<void>((resolve) => { requestAnimationFrame(() => resolve()); });
      DeferredTexture.publishOne(this.renderer);
    }
    throw new Error('weather probe: 気候画像が届かない');
  }

  public get ready(): boolean { return this.field.climateMap.generation > 0; }

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

  // 5 面の写しを描き、チャンネルごとの面へ並べ直して base64 で返す。
  public async readGlobal(): Promise<string> {
    const plane = OUT_WIDTH * OUT_HEIGHT;
    const planes = new Float32Array(CHANNELS.length * plane);
    for (let t = 0; t < TARGET_COUNT; t += 1) {
      this.renderer.setRenderTarget(this.targets[t]!);
      this.quads[t]!.render(this.renderer);
      this.renderer.setRenderTarget(null);
      // RGBA32F の 720 px の行は 256 byte に揃うので、読み戻しは詰まった Float32Array になる。
      const texels = await this.renderer.readRenderTargetPixelsAsync(
        this.targets[t]!, 0, 0, OUT_WIDTH, OUT_HEIGHT);
      for (let c = 0; c < 4; c += 1) {
        const channel = t * 4 + c;
        if (channel === CHANNELS.length) break;
        const dst = planes.subarray(channel * plane, (channel + 1) * plane);
        for (let i = 0; i < plane; i += 1) dst[i] = texels[i * 4 + c]!;
      }
    }
    // Float32 の生の値(リトルエンディアン)をそのまま base64 へ。
    const bytes = new Uint8Array(planes.buffer);
    let binary = '';
    const CHUNK = 8192;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }
}

async function init(): Promise<void> {
  const probe = await WeatherProbeCanvas.create(document.getElementById('view') as HTMLCanvasElement);
  window.weatherProbe = {
    ready: () => probe.ready,
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
