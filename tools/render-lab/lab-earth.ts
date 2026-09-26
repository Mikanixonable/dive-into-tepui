// 描画テスト環境の地球。実写の地表・積雲の殻・模式図の経緯度グリッドと海岸線を一度だけ組み、観察の
// つまみが決める置き方で描画座標へ置く。大気・天体照の光源・自身の影・積雲の影の源としての姿も持つ。
import * as THREE from 'three/webgpu';
import { CelestialSurface, type LightSourceMap } from '../../src/render/celestial/celestial-surface';
import { scaledToBondAlbedo, type Albedo } from '../../src/render/celestial-albedo';
import earthSmoothnessUrl from '../../src/assets/earth-smoothness.png';
import {
  EARTH, EARTH_ATMOSPHERE_OPTICS, EARTH_COASTLINE, earthCloudPresentation, R_EARTH, R_EARTH_EQ,
} from '../../src/game/celestial/solar-system/earth-system';
import { EARTH_TEXTURE } from '../../src/render/earth-surface-defaults';
import { shapeAxes, shapeSpheroidRadii } from '../../src/physics/celestial-body-def';
import { BodyGraticule } from '../../src/render/celestial/body-graticule';
import { LineOverlay } from '../../src/render/celestial/line-overlay';
import { CLOSE_UP_DIAMETER_PX } from './lab-case';
import { directionFromAngles, type EarthAngleKey, type LabViewAngles } from './view-angles';
import type { AtmosphereBody, AtmosphereClouds } from '../../src/render/atmosphere';
import type { ShadowBody } from '../../src/render/pipeline/shadow/body-shadow';
import type { ShadowCumulus } from '../../src/render/pipeline/shadow/cloud-shadow-renderer';
import type { GraphicsSettingsData } from '../../src/render/graphics-settings';
import type { RenderStyle } from '../../src/render/render-style';
import type { GpuTimingSink } from '../../src/render/gpu-timings';
import type { WebGPURenderer } from 'three/webgpu';

// 地球を光源として扱うときの色つきアルベド(ゲーム本体の Earth と同じ測光)。
export const EARTH_LIGHT_ALBEDO: Albedo = scaledToBondAlbedo(EARTH_TEXTURE.averageHue, EARTH_TEXTURE.bondAlbedo);

// 天体固定の極軸。
const BODY_POLE = new THREE.Vector3(0, 1, 0);

// 地球のつまみ angles が置く地球の中心(描画座標)。中心距離は平均半径に描画原点の高度を足したもの。
export function earthCenterOf(angles: Pick<LabViewAngles, EarthAngleKey>): THREE.Vector3 {
  return directionFromAngles(angles.earthAzimuthDeg, angles.earthElevationDeg, new THREE.Vector3())
    .multiplyScalar(R_EARTH + 10 ** angles.earthAltitudeLog);
}

// 地球のつまみ angles が置く自転姿勢(天体固定から描画座標への回転)を out へ書いて返す。直下点で
// 天体固定の東・北・上を、描画座標の東・北・上へ重ねる。**描画座標の北は、地球の向きを仰角について
// 微分した向き** — 仰角 −90° では方位がそのまま北の向きになる。
function earthSpinOf(angles: Pick<LabViewAngles, EarthAngleKey>, out: THREE.Quaternion): THREE.Quaternion {
  const azimuth = THREE.MathUtils.degToRad(angles.earthAzimuthDeg);
  const elevation = THREE.MathUtils.degToRad(angles.earthElevationDeg);
  const latitude = THREE.MathUtils.degToRad(angles.earthLatitudeDeg);
  const longitude = THREE.MathUtils.degToRad(angles.earthLongitudeDeg);
  // 描画座標の東・北・上。上は地球の中心から描画原点への向き。
  const up = directionFromAngles(angles.earthAzimuthDeg, angles.earthElevationDeg, new THREE.Vector3()).negate();
  const north = new THREE.Vector3(
    -Math.sin(azimuth) * Math.sin(elevation), Math.cos(elevation), -Math.cos(azimuth) * Math.sin(elevation),
  );
  const east = new THREE.Vector3().crossVectors(north, up);
  // 天体固定の東・北・上(正距円筒の取り決め: 経度 0 が +Z、東が +X、北極が +Y)。
  const bodyEast = new THREE.Vector3(Math.cos(longitude), 0, -Math.sin(longitude));
  const bodyNorth = new THREE.Vector3(
    -Math.sin(latitude) * Math.sin(longitude), Math.cos(latitude), -Math.sin(latitude) * Math.cos(longitude),
  );
  const bodyUp = new THREE.Vector3(
    Math.cos(latitude) * Math.sin(longitude), Math.sin(latitude), Math.cos(latitude) * Math.cos(longitude),
  );
  const world = new THREE.Matrix4().makeBasis(east, north, up);
  const body = new THREE.Matrix4().makeBasis(bodyEast, bodyNorth, bodyUp);
  return out.setFromRotationMatrix(world.multiply(body.transpose()));
}

export class LabEarth {
  // 地表・雲の殻・線を載せる群。位置は中心、姿勢は自転姿勢、拡大は半軸。
  public readonly object = new THREE.Group();
  // 中心(描画座標)と、描画座標のベクトルを天体固定の向きへ回す行列。place がその場で書き換え、
  // 大気・影・積雲の影は同じ実体を読む。
  public readonly center: THREE.Vector3 = this.object.position;
  public readonly bodyFromWorld = new THREE.Matrix4();
  public readonly atmosphere: AtmosphereBody;
  // 天体自身が落とす影。地表・雲頂・低い高度の大気が直射を失う境界はこれが決める。
  public readonly shadowBody: ShadowBody;
  public readonly cumulus: ShadowCumulus;
  private readonly surface = CelestialSurface.textured(EARTH_TEXTURE, earthSmoothnessUrl);
  private readonly clouds = earthCloudPresentation();
  private readonly graticule = new BodyGraticule();
  private readonly coastline = LineOverlay.of({ kind: 'latLonPolylines', polylines: EARTH_COASTLINE });

  // 地表を寄り切った分割段で組む。置き方は place で決める。
  public constructor() {
    const shape = shapeAxes(R_EARTH_EQ, EARTH.shape);
    const axes = new THREE.Vector3(shape.x, shape.y, shape.z);
    this.object.scale.copy(axes);
    this.surface.addTo(this.object);
    this.surface.syncLod(CLOSE_UP_DIAMETER_PX);
    this.clouds.addTo(this.object);
    this.graticule.addTo(this.object);
    this.coastline.addTo(this.object);
    const clouds = this.clouds;
    const bodyFromWorld = this.bodyFromWorld;
    // **組は毎フレーム取り直す** — 雲の分布を切り替えると写しが別のテクスチャになる。
    const atmosphereClouds: AtmosphereClouds = {
      get cloud() { return clouds.renderInput; }, bodyFromWorld,
    };
    // 大気の地表は地表メッシュと同じ楕円体に採る。**真球で渡すと**、極で地表と空のあいだに
    // 隙間が開く。
    const radii = shapeSpheroidRadii(R_EARTH_EQ, EARTH.shape);
    this.atmosphere = {
      center: this.center,
      surfaceRadius: radii.equatorRadius,
      polarAxis: BODY_POLE.clone(),
      polarRatio: radii.polarRadius / radii.equatorRadius,
      optics: EARTH_ATMOSPHERE_OPTICS,
      // 雲を描かない間は雲を持たない(ゲーム本体の大気の候補と同じ規則)。
      get clouds() { return clouds.cloudsVisible ? atmosphereClouds : null; },
    };
    this.shadowBody = { center: this.center, axes, bodyFromWorld };
    this.cumulus = {
      center: this.center,
      surfaceRadius: R_EARTH_EQ,
      axes,
      bodyFromWorld,
      get cloud() { return clouds.renderInput; },
    };
  }

  // 光源として焼く地表のテクスチャ。ベース色の画像が GPU へ届くまでは null。
  public get lightSourceMap(): LightSourceMap | null { return this.surface.lightSourceMap; }

  // 地表が読む画像(ベース色と滑らかさ)がすべて GPU へ届いたか。
  public get ready(): boolean { return this.surface.imagesReady; }

  // 地球のつまみ angles の置き方へ、中心・自転姿勢・天体固定への行列・大気の極軸を置き直す。
  public place(angles: Pick<LabViewAngles, EarthAngleKey>): void {
    this.center.copy(earthCenterOf(angles));
    const spin = earthSpinOf(angles, this.object.quaternion);
    this.bodyFromWorld.makeRotationFromQuaternion(spin.clone().invert());
    this.atmosphere.polarAxis.copy(BODY_POLE).applyQuaternion(spin);
  }

  // 描画品質設定 graphics のうち雲の項目と、表示スタイル style の線の出し入れを押し込み、雲場の cap を
  // camera の直下点へ合わせる。毎フレーム、カメラと地球を置いたあとに呼ぶ。
  public sync(camera: THREE.Camera, graphics: GraphicsSettingsData, style: RenderStyle): void {
    // 殻の分割段は寄り切った 1 段に固定する — カメラ距離は観察のつまみで動くが、絵の比較は最も
    // 細かい段で行う。
    this.clouds.syncGraphics(graphics, CLOSE_UP_DIAMETER_PX);
    if (graphics.clouds) this.clouds.aimFrom(camera.position, this.center, this.object.quaternion, this.cumulus.axes);
    this.graticule.setVisible(style === 'schematic');
    this.coastline.setVisible(style === 'schematic');
  }

  // 動的な雲場を表示時刻 displayTime [s] へ焼く。gpu を渡すと、焼いた GPU 時間をそこへ計上する。
  public bake(renderer: WebGPURenderer, displayTime: number, gpu?: GpuTimingSink): void {
    this.clouds.bake(renderer, displayTime, gpu);
  }
}
