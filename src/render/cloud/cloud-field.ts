// 天気が凝結する雲を焼いた写し。焼くときと読むときの成分の割り当てを一手に持ち、
// 出入りをどちらも CloudSample で受け渡す。テクスチャの G は雲頂高度を CLOUD_TOP_SPAN で
// 正規化した値、CloudSample の cloudTop はメートルである。
import * as THREE from 'three/webgpu';
import { If, float, greaterThan, mix, texture, uniform, vec4 } from 'three/tsl';
import { BakedField } from './baked-field';
import { condense } from './condensation';
import { ClimateMap } from './climate-map';
import { CLOUD_TOP_SPAN, EMPTY_CLOUD_FIELD, fieldLodForWidth } from './cumulus-shape';
import { EquirectProjection, OrthographicCap } from './field-projection';
import { WeatherModel } from './weather-model';
import type { WebGPURenderer } from 'three/webgpu';
import type { CloudSample } from './condensation';
import type { FieldProjection } from './field-projection';
import type { FloatNode, Vec3Node, Vec4Node } from '../tsl-types';

// 遠景の全球場の高さ [texel]。遠景の分布を保ちつつ、近景の局所場へ費用を回す。
const GLOBAL_FIELD_HEIGHT = 256;
// 近景の局所場の一辺 [texel]。正射影 cap の中央付近へ全球場より細かい分布を置く。
const LOCAL_FIELD_SIZE = 512;
// 局所場が覆う中心からの角半径 [rad]。LEO の見える地球面の大半へ重なりを残す。
const LOCAL_CAP_RADIUS = THREE.MathUtils.degToRad(75);
// 見かけ直径 [px] に応じて局所場の重みを渡す区間。境目では両方を同時に読む。
const LOCAL_BLEND_START_PX = 240;
const LOCAL_BLEND_END_PX = 480;

export type CloudFieldLod = {
  readonly global: FloatNode;
  readonly local: FloatNode;
};

// 全球場と局所場の重みを滑らかに適用する共通処理。局所場は重みが 0 の遠景では分岐ごと
// 省略し、全球場だけを読む。
function blendCloudSamples(
  global: Vec4Node, localAt: () => Vec4Node, localWeight: FloatNode,
): Vec4Node {
  const sample = global.toVar();
  If(greaterThan(localWeight, 0), () => {
    sample.assign(mix(global, localAt(), localWeight));
  });
  return sample;
}

export class CloudField {
  private readonly field: BakedField;

  // model がいま指している時刻の雲を、projection の持ち方で焼く写し。
  public constructor(model: WeatherModel, projection: FieldProjection) {
    this.field = new BakedField('cloud', THREE.RGBAFormat, projection, 1, (direction) => {
      const cloud = condense(model.weatherAt(direction));
      return vec4(cloud.coverage, cloud.cloudTop.div(CLOUD_TOP_SPAN), cloud.translucent, 1);
    });
  }

  // いまの時刻の雲を写しへ描く。at() で読む前に必ず一度呼ぶ。
  public render(renderer: WebGPURenderer): void {
    this.field.render(renderer);
  }

  // 焼いた雲の場。テクスチャの所有権は BakedField に残す。
  public get texture(): THREE.Texture { return this.field.texture; }

  // 単位方向 direction での雲。
  public at(direction: Vec3Node): CloudSample {
    const texel = this.field.at(direction);
    return { coverage: texel.r, cloudTop: texel.g.mul(CLOUD_TOP_SPAN), translucent: texel.b };
  }

  // 保持している GPU 資源を解放する。
  public dispose(): void {
    this.field.dispose();
  }
}

// 気候から表示時刻の雲場を焼く所有者。気候・天気の中間場・出力場を同じ寿命で管理する。
export class GeneratedCloudField {
  private readonly globalProjection: EquirectProjection;
  private readonly localProjection: OrthographicCap;
  private readonly globalModel: WeatherModel;
  private readonly localModel: WeatherModel;
  private readonly globalField: CloudField;
  private readonly localField: CloudField;
  // 大気・影へ同じ投影と重みを渡す。値は syncLod で置き、bake 後も変えない。
  private readonly localWeight = uniform(0);
  private localAimRevision = 0;
  private lastGlobalBakedDisplayTime: number | null = null;
  private lastLocalBakedDisplayTime: number | null = null;
  private lastLocalBakedAimRevision = -1;

  // 気候を全球正距円筒へ投影する。
  public static global(climate: ClimateMap): GeneratedCloudField {
    return new GeneratedCloudField(climate);
  }

  // 全球場と局所場で気候・天気の式を共有し、出力だけをそれぞれの投影へ焼く。
  public constructor(private readonly climate: ClimateMap) {
    this.globalProjection = new EquirectProjection(GLOBAL_FIELD_HEIGHT);
    this.localProjection = new OrthographicCap(LOCAL_FIELD_SIZE, 0, 0, LOCAL_CAP_RADIUS);
    this.globalModel = new WeatherModel(climate, this.globalProjection);
    this.localModel = new WeatherModel(climate, this.localProjection);
    this.globalField = new CloudField(this.globalModel, this.globalProjection);
    this.localField = new CloudField(this.localModel, this.localProjection);
  }

  // 全球場のテクスチャ。外部の直接参照は shared sampler の bind に限る。
  public get globalTexture(): THREE.Texture { return this.globalField.texture; }

  // 局所場のテクスチャ。外部の直接参照は shared sampler の bind に限る。
  public get localTexture(): THREE.Texture { return this.localField.texture; }

  // 局所場の現在の混合重み。
  public get localBlend(): number { return this.localWeight.value; }

  // 局所場の投影を別の読み手へコピーする。
  public copyLocalProjectionTo(target: OrthographicCap): void {
    target.copyAimFrom(this.localProjection);
  }

  // 雲の見かけ直径と、天体固定系で見たカメラ方向から必要な場を決める。カメラ方向は
  // PointEntity が運動と自転を解いたうえで渡すので、ここでは表示系の推測をしない。
  public syncLod(apparentDiameterPx: number, cameraDirection: THREE.Vector3): void {
    const localWeight = THREE.MathUtils.clamp(
      (apparentDiameterPx - LOCAL_BLEND_START_PX) / (LOCAL_BLEND_END_PX - LOCAL_BLEND_START_PX), 0, 1,
    );
    if (localWeight > 0 && this.localProjection.aimAt(cameraDirection, LOCAL_CAP_RADIUS)) {
      this.localAimRevision += 1;
    }
    this.localWeight.value = localWeight;
  }

  // 表示時刻の雲場を、天気の中間場から順に焼く。
  public bake(renderer: WebGPURenderer, displayTime: number): void {
    const needsGlobal = this.lastGlobalBakedDisplayTime !== displayTime;
    const needsLocal = this.localWeight.value > 0 && (
      this.lastLocalBakedDisplayTime !== displayTime
      || this.lastLocalBakedAimRevision !== this.localAimRevision
    );
    if (!needsGlobal && !needsLocal) return;
    this.climate.request();
    if (needsGlobal) {
      this.globalModel.syncTime(displayTime);
      this.globalModel.bake(renderer);
      this.globalField.render(renderer);
      this.lastGlobalBakedDisplayTime = displayTime;
    }
    if (needsLocal) {
      this.localModel.syncTime(displayTime);
      this.localModel.bake(renderer);
      this.localField.render(renderer);
      this.lastLocalBakedDisplayTime = displayTime;
      this.lastLocalBakedAimRevision = this.localAimRevision;
    }
  }

  // 保持している雲場を解放する。
  public dispose(): void {
    this.globalField.dispose();
    this.localField.dispose();
    this.globalModel.dispose();
    this.localModel.dispose();
    this.climate.dispose();
  }
}

// 大気・影パスのグラフへ、GeneratedCloudField の2つの出力場を結ぶ読み手。各パスは独自の
// uniform を持つが、投影・テクスチャ・重みは set() で同じ生成元から受け取る。
export class CloudFieldSampler {
  private readonly globalProjection = new EquirectProjection(GLOBAL_FIELD_HEIGHT);
  private readonly localProjection = new OrthographicCap(LOCAL_FIELD_SIZE, 0, 0, LOCAL_CAP_RADIUS);
  private readonly global = texture(EMPTY_CLOUD_FIELD);
  private readonly local = texture(EMPTY_CLOUD_FIELD);
  private readonly localWeight = uniform(0);

  public set(field: GeneratedCloudField | null): void {
    if (field === null) {
      this.global.value = EMPTY_CLOUD_FIELD;
      this.local.value = EMPTY_CLOUD_FIELD;
      this.localWeight.value = 0;
      return;
    }
    this.global.value = field.globalTexture;
    this.local.value = field.localTexture;
    this.localWeight.value = field.localBlend;
    field.copyLocalProjectionTo(this.localProjection);
  }

  // 光路の代表幅から全球場・局所場それぞれの明示 mip 段を組む。
  public lodForWidth(width: FloatNode, radius: FloatNode): CloudFieldLod {
    return {
      global: fieldLodForWidth(width, radius, float(this.globalProjection.width)),
      local: fieldLodForWidth(width, radius, float(this.localProjection.width)),
    };
  }

  // 天体固定方向の雲を読み、局所 cap の有効域だけを全球場へ混ぜる。
  public at(direction: Vec3Node, lod: CloudFieldLod | null = null): Vec4Node {
    const globalUv = this.globalProjection.uvAt(direction);
    const localUv = this.localProjection.uvAt(direction);
    const global = lod === null ? this.global.sample(globalUv) : this.global.sample(globalUv).level(lod.global);
    const localWeight = this.localWeight.mul(this.localProjection.fadeAt(localUv));
    return blendCloudSamples(
      global,
      () => lod === null ? this.local.sample(localUv) : this.local.sample(localUv).level(lod.local),
      localWeight,
    );
  }
}
