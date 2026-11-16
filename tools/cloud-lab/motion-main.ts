// 生成雲場の動きを測るための読み出しページ。全球を正距円筒で持つ生成雲場を表示時刻ごとに焼き、
// 緯度経度で指定した箱の面へ切り出す。雲は実写の赤外(輝度温度)に当たる「冷たい雲頂」の場へ
// 物理的に写して返し、風は雲を運ぶ風の写し(数百キロで均した地表付近・上層の成分)を返す。
// window.cloudMotion が tools/cloud-lab-motion-compare.mjs の駆動口。
import * as THREE from 'three/webgpu';
import { QuadMesh, WebGPURenderer } from 'three/webgpu';
import { clamp, exp, float, mix, mrt, sin, step, uniform, vec4 } from 'three/tsl';
import { earthGeneratedCloudField } from '../../src/game/celestial/solar-system/earth-system';
import { EquirectProjection } from '../../src/render/field-projection';
import { DeferredTexture } from '../../src/render/deferred-texture';
import { AtmosphericWindField, SURFACE_HEIGHT } from '../../src/render/earth-weather/atmospheric-wind';
import { Cyclones } from '../../src/render/earth-weather/cyclones';
import { Highs } from '../../src/render/earth-weather/anticyclones';
import { CirculatingNoise } from '../../src/render/earth-weather/circulating-noise';
import { Circulation } from '../../src/render/earth-weather/circulation';
import { WeatherTransport } from '../../src/render/earth-weather/weather-transport';
import { WeatherModel } from '../../src/render/earth-weather/weather-model';
import {
  cirrusColumnOpticalDepthNode, cirrusTopAltitudeNode, cumulusOpacityNode, cumulusTopAltitudeNode,
} from '../../src/render/earth-weather/cloud/cloud-kind-node';
import { latitudeOf } from '../../src/render/earth-weather/sphere-frame';
import {
  CloudMotionWind, awaitClimateMap, boxDirectionNode, renderTargetBase64,
} from './probe-common';
import type { GeneratedCloudField } from '../../src/render/earth-weather/cloud/generated-cloud-field';
import type { Vec3Node, Vec4Node } from '../../src/render/tsl-types';

declare global {
  interface Window {
    cloudMotion?: CloudMotionProbe;
  }
}

// 箱の指定。緯度経度 [deg] の四辺(実写の箱と同じ EPSG:4326 の面)。読み出す面は BOX_PX 画素。
interface BoxSpec {
  readonly north: number;
  readonly south: number;
  readonly west: number;
  readonly east: number;
}

interface CloudMotionProbe {
  // 表示時刻 hours [h] の場を焼く。以後の sampleBox / sampleWindBox はこの時刻を読む。
  readonly prepare: (hours: number) => Promise<void>;
  // 冷たい雲頂の場を箱の面で読む。戻り値は RGBA8 の生画素の base64
  // (R = 冷たさ 0..1、G = 積雲の量、B = 巻雲の量)。行は北から南へ、列は西から東へ並ぶ。
  readonly sampleBox: (spec: BoxSpec) => Promise<string>;
  // 雲を運ぶ風を箱の面で読む。RGBA8 の生画素の base64 (R・G = 地表付近の東・北成分、
  // B・A = 上層の東・北成分。いずれも ±WIND_SPAN_MS m/s を 0..1 へ写した値)。
  readonly sampleWindBox: (spec: BoxSpec) => Promise<string>;
}

// 全球の写しの高さ [texel]。幅は 2 倍で、赤道で 1 texel ≈ 19.6 km。
const EQUIRECT_HEIGHT = 1024;
// 切り出し面の大きさ [px]。
const BOX_PX = 250;

// 差し替え実験。URL のクエリで、雲場を組む前に風・低気圧・エポックの仕掛けだけを切る —
// 速さ・減衰時間・入れ替わりの指標のどれが動くかで、実写との差の原因を切り分ける。
// 本番のコードは触らず、プロトタイプをこのページの中だけで包む。
function applyAblations(): void {
  const params = new URLSearchParams(location.search);
  const windScale = Number(params.get('windScale') ?? '1');
  if (windScale !== 1) {
    // 大循環の平均風だけを割る。局所の釣り合い風・循環の帯・写しの移流へは同じ比率で効く。
    const sample = AtmosphericWindField.prototype.sample;
    AtmosphericWindField.prototype.sample = function (latitudeRad, heightM) {
      const wind = sample.call(this, latitudeRad, heightM);
      return { east: wind.east * windScale, north: wind.north * windScale };
    };
    const sampleNode = AtmosphericWindField.prototype.sampleNode;
    AtmosphericWindField.prototype.sampleNode = function (latitudeRad, heightM) {
      return sampleNode.call(this, latitudeRad, heightM).mul(windScale);
    };
  }
  if (params.get('noShear') === '1') {
    // 層間の風速差を潰す。どの高度でも地表付近のプロファイルを返す。
    const sample = AtmosphericWindField.prototype.sample;
    AtmosphericWindField.prototype.sample = function (latitudeRad, heightM) {
      return sample.call(this, latitudeRad, Math.min(heightM, SURFACE_HEIGHT));
    };
    const sampleNode = AtmosphericWindField.prototype.sampleNode;
    AtmosphericWindField.prototype.sampleNode = function (latitudeRad, heightM) {
      return sampleNode.call(this, latitudeRad, Math.min(heightM, SURFACE_HEIGHT));
    };
  }
  if (params.get('noCyclone') === '1') {
    // 低気圧の谷と高気圧の丘を気圧から除く — 低・高どちらの渦のまわりの釣り合い風も消え、
    // 眼と金床の形は残る。
    Cyclones.prototype.pressureAt = () => float(0);
    Highs.prototype.pressureAt = () => float(0);
  }
  if (params.get('noEpoch') === '1') {
    // 総観規模の段のその場での実現の混ぜ替えを止め、雲塊の発達・消滅を切る。
    CirculatingNoise.prototype.syncTime = () => undefined;
  }
  const epochScale = Number(params.get('epochScale') ?? '1');
  if (epochScale !== 1) {
    // 実現の混ぜ替えの進みを割る — syncTime へ届く時刻を係数ぶんだけ進めて、
    // 混ぜ替えが作る見かけの動きと発達・消滅の速さを同じ比で動かす。
    const syncTime = CirculatingNoise.prototype.syncTime;
    CirculatingNoise.prototype.syncTime = function (seconds) {
      syncTime.call(this, seconds * epochScale);
    };
  }
  if (params.get('noCirculation') === '1') {
    // 写しの源を運ぶ循環を止める — 源の模様の平行移動が消え、移流の遡りだけが残る。
    Circulation.prototype.syncTime = () => undefined;
  }
  if (params.get('noAdvection') === '1') {
    // 風上へ遡る2位相移流を外し、移流前の写しをそのまま出す — 遡りが運ぶ見かけの動きが消える。
    WeatherTransport.prototype.advectedAt = function (direction) {
      const humidity = this.humiditySourceAt(direction);
      return {
        surfaceHumidity: humidity.x, upperHumidity: humidity.y,
        convection: this.convectionSourceAt(direction),
      };
    };
  }
  const eddyScale = Number(params.get('eddyScale') ?? '1');
  if (eddyScale !== 1) {
    // 気圧場の偏差(勾配・曲がり)を割る — 釣り合い風がその比で細くなり、移流の遡りが運ぶ
    // 見かけの動きだけが遅くなる。気圧の深さと上昇流は変えない。
    const pressureFieldAt = WeatherModel.prototype['pressureFieldAt'];
    WeatherModel.prototype['pressureFieldAt'] = function (direction, east, north) {
      const field = pressureFieldAt.call(this, direction, east, north);
      return {
        ...field,
        gradient: field.gradient.mul(eddyScale),
        bend: field.bend.mul(eddyScale),
      };
    };
  }
}

// 地表の輝度温度 [K]。帯状平均の海面温度の推定(赤道 299 K、極 277 K で 60°N が約 9 ℃)を、
// 緯度の連続な関数として置く。実写の冷たさの閾値(0 ℃)より高い所を晴れと見なせる程度に暖かい。
const SURFACE_TEMP_EQUATOR_K = 299;
const SURFACE_TEMP_POLE_K = 277;
// 雲頂温度を出す気温減率 [K/m]。
const LAPSE_K_PER_M = 6.5e-3;
// 冷たさの写し方。実写側の cloud-motion-report の閾値・飽和と同じ(0 ℃ で 0、−70 ℃ で 1)。
const COLD_THRESHOLD_K = 273.15;
const COLD_SATURATION_K = 203.15;

class MotionProbeCanvas {
  private readonly coldQuad: QuadMesh;
  private readonly windQuad: QuadMesh;
  private readonly boxBounds = uniform(new THREE.Vector4(0, 0, 0, 0));
  private readonly motionWind: CloudMotionWind;
  private readonly coldTarget = new THREE.RenderTarget(BOX_PX, BOX_PX, {
    format: THREE.RGBAFormat, type: THREE.UnsignedByteType, depthBuffer: false, samples: 0,
  });
  private readonly windTarget = (() => {
    const target = new THREE.RenderTarget(BOX_PX, BOX_PX, {
      format: THREE.RGBAFormat, type: THREE.UnsignedByteType, depthBuffer: false, samples: 0,
    });
    target.textures[0]!.name = 'wind';
    return target;
  })();
  private readonly coldMaterial: THREE.MeshBasicNodeMaterial;
  private readonly windMaterial: THREE.MeshBasicNodeMaterial;

  public static async create(canvas: HTMLCanvasElement): Promise<MotionProbeCanvas> {
    applyAblations();
    const renderer = new WebGPURenderer({ canvas });
    renderer.setSize(BOX_PX, BOX_PX, false);
    renderer.toneMapping = THREE.NoToneMapping;
    await renderer.init();
    const field = earthGeneratedCloudField(new EquirectProjection(EQUIRECT_HEIGHT));
    const probe = new MotionProbeCanvas(renderer, field);
    await awaitClimateMap(renderer, [field.climateMap], 'cloud motion probe');
    return probe;
  }

  private constructor(private readonly renderer: WebGPURenderer, private readonly field: GeneratedCloudField) {
    this.motionWind = new CloudMotionWind(field);
    this.coldMaterial = new THREE.MeshBasicNodeMaterial({ depthTest: false, depthWrite: false });
    this.coldMaterial.colorNode = this.coldNode();
    this.windMaterial = new THREE.MeshBasicNodeMaterial({ depthTest: false, depthWrite: false });
    // 読み出しの 4 成分目をアルファとして捨てられないよう、MRT 経路で全成分を書く
    // (colorNode の vec4.w は不透明マテリアルでは 1 に潰れる)。
    this.windMaterial.mrtNode = mrt({ wind: this.windNode() });
    this.coldQuad = new QuadMesh(this.coldMaterial);
    this.windQuad = new QuadMesh(this.windMaterial);
  }

  // いまの boxBounds が指す箱の画素が張る単位方向。
  private directionNode(): Vec3Node {
    return boxDirectionNode(this.boxBounds);
  }

  // 冷たい雲頂の場。雲頂高度から雲頂温度を引き、放射率(1 − e^−τ)で重み付けた 2 層の放射で
  // 視線上の輝度温度を組み、実写と同じ閾値・飽和の冷たさへ写す。高い層を先に通す。
  private coldNode(): Vec4Node {
    const direction = this.directionNode();
    const sample = this.field.at(direction);
    const cumulusTop = cumulusTopAltitudeNode(sample.cumulus);
    const cirrusTop = cirrusTopAltitudeNode(sample.cirrus);
    const cumulusEmissivity = cumulusOpacityNode(sample.cumulus);
    const cirrusEmissivity = exp(cirrusColumnOpticalDepthNode(sample.cirrus).negate()).oneMinus();
    const sinLat = sin(latitudeOf(direction));
    const surface = float(SURFACE_TEMP_EQUATOR_K)
      .sub(sinLat.mul(sinLat).mul(SURFACE_TEMP_EQUATOR_K - SURFACE_TEMP_POLE_K));
    const cumulusTemp = surface.sub(cumulusTop.mul(LAPSE_K_PER_M));
    const cirrusTemp = surface.sub(cirrusTop.mul(LAPSE_K_PER_M));
    const throughCumulus = cumulusEmissivity.mul(cumulusTemp)
      .add(cumulusEmissivity.oneMinus().mul(surface));
    const throughCirrus = cirrusEmissivity.mul(cirrusTemp)
      .add(cirrusEmissivity.oneMinus().mul(surface));
    // 高い層を先に通す: bt = ε_hi T_hi + (1 − ε_hi)(ε_lo T_lo + (1 − ε_lo) T_sfc)。
    const cirrusAbove = cirrusEmissivity.mul(cirrusTemp).add(cirrusEmissivity.oneMinus().mul(throughCumulus));
    const cumulusAbove = cumulusEmissivity.mul(cumulusTemp).add(cumulusEmissivity.oneMinus().mul(throughCirrus));
    const bt = mix(cumulusAbove, cirrusAbove, step(cumulusTop, cirrusTop));
    const coldness = clamp(float(COLD_THRESHOLD_K).sub(bt).div(COLD_THRESHOLD_K - COLD_SATURATION_K), 0, 1);
    return vec4(coldness, sample.cumulus, sample.cirrus, float(1));
  }

  // 雲を運ぶ風の写し(±WIND_SPAN_MS へ写した地表付近・上層の東・北成分)。
  private windNode(): Vec4Node {
    return this.motionWind.windNode(this.directionNode());
  }

  // 表示時刻 hours [h] の場を焼く。時刻が大きく跳ぶので 1 枚だけ焼き直される。
  public async prepare(hours: number): Promise<void> {
    DeferredTexture.publishOne(this.renderer);
    this.field.prepare(this.renderer, hours * 3600);
    this.motionWind.syncBlend();
  }

  // 画素を base64 で返す(行は北から南へ、列は西から東へ並ぶ)。
  private async sample(spec: BoxSpec, quad: QuadMesh, target: THREE.RenderTarget): Promise<string> {
    this.boxBounds.value.set(
      THREE.MathUtils.degToRad(spec.west), THREE.MathUtils.degToRad(spec.south),
      THREE.MathUtils.degToRad(spec.east), THREE.MathUtils.degToRad(spec.north));
    return renderTargetBase64(this.renderer, quad, target, BOX_PX);
  }

  public async sampleBox(spec: BoxSpec): Promise<string> {
    return this.sample(spec, this.coldQuad, this.coldTarget);
  }

  public async sampleWindBox(spec: BoxSpec): Promise<string> {
    return this.sample(spec, this.windQuad, this.windTarget);
  }
}

async function init(): Promise<void> {
  const probe = await MotionProbeCanvas.create(document.getElementById('view') as HTMLCanvasElement);
  window.cloudMotion = {
    prepare: (hours) => probe.prepare(hours),
    sampleBox: (spec) => probe.sampleBox(spec),
    sampleWindBox: (spec) => probe.sampleWindBox(spec),
  };
}

init().catch((e: unknown) => {
  document.getElementById('error')!.textContent = String(e);
});
