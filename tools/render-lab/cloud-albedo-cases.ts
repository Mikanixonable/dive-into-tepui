// 雲の白さと光学的厚みの関係を測るための合成ケース。暗い海の上に、雲場の cap が届く限りの
// 一様な雲板を立て、直下点の真上から見下ろす(画像の中心で 4 km/px)。雲場は 1 texel の
// 一様な場を CloudFieldSource として実機の CloudPresentation へ差し込み、表示時刻を
// 雲板の種類の番号として受けて量と下地を切り替える(組は cloud-albedo-model.ts の VARIANTS)。
// 下地を拡散反射率 1 の面へ替えた板も同じ仕組みで持ち、同じ条件で撮ると反射率換算の基準になる。
import * as THREE from 'three/webgpu';
import { EARTH_ATMOSPHERE_OPTICS, R_EARTH } from '../../src/game/celestial/solar-system/earth-system';
import { CelestialSurface } from '../../src/render/celestial/celestial-surface';
import { CloudBlendState, type CloudFieldSlot } from '../../src/render/cloud/cloud-field-sample';
import { CloudPresentation, type CloudFieldSource } from '../../src/render/cloud/cloud-presentation';
import { CLOUD_CAP_MARGIN, CLOUD_CAP_SIZE } from '../../src/render/cloud/cloud-cap';
import { OrthographicCap } from '../../src/render/field-projection';
import { sphereShadowBody } from '../../src/render/pipeline/shadow/body-shadow';
import type { ShadowCloud } from '../../src/render/pipeline/shadow/cloud-shadow-renderer';
import { CLOSE_UP_DIAMETER_PX, labCamera, type LabCase } from './lab-case';
import { directionFromAngles } from './view-angles';
import { ALTITUDE_M, VARIANTS } from './cloud-albedo-model';
import type { Albedo } from '../../src/render/celestial-albedo';
import type { AtmosphereBody, AtmosphereClouds } from '../../src/render/atmosphere';
import type { GraphicsSettingsData } from '../../src/render/graphics-settings';

// 暗い海の拡散アルベド(線形 RGB)。実在の海の見積もりの粗い値。
const OCEAN_ALBEDO: Albedo = [0.03, 0.05, 0.07];

// 直下点の地表の中心(描画座標)。カメラは描画原点から −Z を見る。
const BODY_CENTER = new THREE.Vector3(0, 0, -(R_EARTH + ALTITUDE_M));

// cap の置き方に関わらず全方向で同じ量を返す 1 texel の雲場。2 枚の写しは同じ
// テクスチャを指すので、混ぜ比はどちらへ倒しても同じ値になる。板の量は set で書き換える。
class UniformCloudField implements CloudFieldSource {
  private readonly cloud = new THREE.DataTexture(new Uint8Array(4), 1, 1);
  private readonly empty = new THREE.DataTexture(new Uint8Array(4), 1, 1);
  public readonly slots: readonly [CloudFieldSlot, CloudFieldSlot];
  public readonly blend = new CloudBlendState();
  public readonly generation = 1;

  public constructor() {
    for (const texture of [this.cloud, this.empty]) {
      texture.colorSpace = THREE.NoColorSpace;
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.needsUpdate = true;
    }
    const slot: CloudFieldSlot = { cloud: this.cloud, motion: this.empty, environment: this.empty };
    this.slots = [slot, slot];
    const variant = VARIANTS[0]!;
    this.set(variant.cumulus, variant.cirrus);
  }

  // 一様場の量を置き直す。雲場の R = 積雲、G = 巻雲(cloud-field-sample.ts の配置)。
  public set(cumulus: number, cirrus: number): void {
    const data = this.cloud.image.data as Uint8Array;
    data[0] = Math.round(cumulus * 255);
    data[1] = Math.round(cirrus * 255);
    data[2] = 0;
    data[3] = 0;
    this.cloud.needsUpdate = true;
  }

  // 場は静的なので準備するものは無い。
  public prepare(): void {}

  // テクスチャを解放する。
  public dispose(): void {
    this.cloud.dispose();
    this.empty.dispose();
  }
}

function cloudAlbedo(): LabCase {
  const camera = labCamera();
  // 地表と雲の殻を載せる群。真球なので半軸はすべて平均半径。直下点が描画原点の真下に来る。
  const body = new THREE.Group();
  body.position.copy(BODY_CENTER);
  const axes = new THREE.Vector3(R_EARTH, R_EARTH, R_EARTH);
  body.scale.copy(axes);
  const ocean = CelestialSurface.solid(OCEAN_ALBEDO);
  ocean.addTo(body);
  ocean.syncLod(CLOSE_UP_DIAMETER_PX);
  // 反射率 1 の拡散の基準面。海と同じ球なので、出すのは 1 面ずつにする。
  const white = CelestialSurface.solid([1, 1, 1]);
  white.addTo(body);
  white.syncLod(CLOSE_UP_DIAMETER_PX);
  white.hide();
  const field = new UniformCloudField();
  const cap = new OrthographicCap(CLOUD_CAP_SIZE, 0, 0, CLOUD_CAP_MARGIN);
  const clouds = new CloudPresentation(field, field, cap, R_EARTH);
  clouds.addTo(body);
  const bodyFromWorld = new THREE.Matrix4();
  const atmosphereClouds: AtmosphereClouds = {
    get cloud() { return clouds.renderInput; },
    bodyFromWorld,
    get cumulusVisible() { return clouds.cumulusEnabled; },
    get cirrusVisible() { return clouds.cirrusEnabled; },
  };
  // 雲の影の源。大気へ渡す組と同じ雲場・同じ天体を指すので、白い下地へ落ちる影の濃さは
  // 見えている雲と同じ光学的厚みから決まる。
  const shadowCloud: ShadowCloud = {
    center: body.position,
    surfaceRadius: R_EARTH,
    axes,
    bodyFromWorld,
    get cloud() { return clouds.renderInput; },
  };
  const atmosphere: AtmosphereBody = {
    center: body.position,
    surfaceRadius: R_EARTH,
    polarAxis: new THREE.Vector3(0, 1, 0),
    polarRatio: 1,
    optics: EARTH_ATMOSPHERE_OPTICS,
    // 雲を描かない間は雲を持たない(ゲーム本体の大気の候補と同じ規則)。
    get clouds() { return clouds.cloudsVisible ? atmosphereClouds : null; },
  };
  // 表示時刻は雲板の番号。量と下地を表の組へ切り替える。
  const applyVariant = (index: number): void => {
    const variant = VARIANTS[Math.min(Math.max(Math.round(index), 0), VARIANTS.length - 1)]!;
    field.set(variant.cumulus, variant.cirrus);
    if (variant.ground === 'white') {
      ocean.hide();
      white.syncLod(CLOSE_UP_DIAMETER_PX);
    } else {
      white.hide();
      ocean.syncLod(CLOSE_UP_DIAMETER_PX);
    }
  };
  return {
    objects: [body],
    camera,
    viewTarget: new THREE.Vector3(0, 0, -ALTITUDE_M),
    // 直下点の天頂角 30° の向き(直下点の上は +Z なので、仰角は 90 − 30 = 60°)。
    sunDirection: directionFromAngles(0, 60, new THREE.Vector3()),
    atmospheres: [atmosphere],
    shadowBodies: [sphereShadowBody(BODY_CENTER, R_EARTH)],
    shadowCloud,
    syncMotion: (displayTime) => applyVariant(displayTime),
    sync: (graphics: GraphicsSettingsData) => {
      clouds.syncGraphics(graphics, CLOSE_UP_DIAMETER_PX);
      if (graphics.clouds) clouds.aimFrom(camera.position, body.position, body.quaternion, axes);
    },
    dispose: () => { clouds.dispose(); ocean.dispose(); white.dispose(); },
  };
}

export const CLOUD_ALBEDO_CASES = {
  'cloud-albedo': cloudAlbedo,
} as const;
