// 描画テスト環境のケースが共有する取り決め。ケースが返す形と組む関数の型、描画の大きさ、既定の
// カメラ・恒星の向きと、ケースが物体を置く部品(試験球・円・実写テクスチャの天体・既定戦闘船)を持つ。
import * as THREE from 'three/webgpu';
import { CelestialSurface, type LightSourceMap } from '../../src/render/celestial/celestial-surface';
import { R_SUN } from '../../src/game/celestial/solar-system/sun';
import { shapeAxes, type PlanetDef } from '../../src/physics/celestial-body-def';
import { Curve } from '../../src/render/curve';
import { apparentSizePx, metersPerPixelAtDepth } from '../../src/math/projection';
import { createDefaultCombatPreset } from '../../src/game/ship/ship-presets';
import { shipPhysicsShape } from '../../src/game/ship/ship-physics-shape';
import { shipRenderAssembly } from '../../src/game/ship/ship-render-adapter';
import { ModularShipView } from '../../src/render/dynamic/ship/modular-ship-view';
import { buildShipModuleModel } from '../../src/render/dynamic/ship/ship-module-models';
import { anglesFromDirection, type LabViewAngles } from './view-angles';
import type { Albedo } from '../../src/render/celestial-albedo';
import type { RingMaterials } from '../../src/render/celestial/ring';
import type { StarSphere } from '../../src/render/celestial/star-sphere';
import type { ShadowBody } from '../../src/render/pipeline/shadow/body-shadow';
import type { RingBand } from '../../src/render/pipeline/shadow/ring-shadow';
import type { ShadowCumulus } from '../../src/render/pipeline/shadow/cloud-shadow-renderer';
import type { LineStyle } from '../../src/render/line-style';
import type { ShipAssembly } from '../../src/game/ship/ship-assembly';
import type { ProteinLabCaseMetadata } from './protein-cases';
import type { AtmosphereBody } from '../../src/render/atmosphere';
import type { RenderStyle } from '../../src/render/render-style';
import type { GraphicsSettingsData } from '../../src/render/graphics-settings';
import type { GpuTimingSink } from '../../src/render/gpu-timings';
import type { CelestialTexture } from '../../src/render/celestial-textures';
import type { ProteinMotionFrameSample } from '../../src/game/protein/protein-motion-metrics';
import type { WebGPURenderer } from 'three/webgpu';

// 描画は 960×540 固定(撮影した PNG の大きさを決め打ちにするため)。
export const VIEW_WIDTH = 960;
export const VIEW_HEIGHT = 540;
export const FOV_DEG = 50;

// カメラの距離を、ケース既定の距離の何桁ぶんまで伸縮できるか(倍率の常用対数の絶対値の上限)。
export const MAX_CAMERA_DISTANCE_LOG = 2;

// ケース既定の恒星方向(原点から見た単位ベクトル)。
export const SUN_DIR = new THREE.Vector3(1, 0.35, 0.5).normalize();

// 恒星の向き direction(長さは問わない)を、観察の向きの恒星の方位・仰角で表す。
export function sunAnglesOf(direction: THREE.Vector3): Pick<LabViewAngles, 'sunAzimuthDeg' | 'sunElevationDeg'> {
  const { azimuthDeg, elevationDeg } = anglesFromDirection(direction);
  return { sunAzimuthDeg: azimuthDeg, sunElevationDeg: elevationDeg };
}

export const SUN_DIR_ANGLES = sunAnglesOf(SUN_DIR);

// テスト用の球のアルベド。実在天体の値ではなく、線・陰影を読むための識別色。
export const GREY_SPHERE_ALBEDO: Albedo = [0.521, 0.4793, 0.4179];

// ケースのカメラの既定の位置と視線。near はゲーム本体と同じ 2 m(深度分解能の導出がこの値に乗る)。
const EYE = new THREE.Vector3(0, 0, 0);
export const AHEAD = new THREE.Vector3(0, 0, -1);
const NEAR = 2;

export interface LabCase {
  // シーンへ載せる物体。ジオメトリとマテリアルは、userData の ownsGeometry / ownsMaterial を立てた
  // 物体のものがケースを外すときに解放される。
  readonly objects: readonly THREE.Object3D[];
  // 既定の観察の向き・距離・画角を与えるカメラ。描くたびに観察の向きへ動かされる。
  readonly camera: THREE.PerspectiveCamera;
  // 恒星の向き(原点から見た単位ベクトル)。省略すると SUN_DIR。
  readonly sunDirection?: THREE.Vector3;
  // 恒星の見た目。持たせると、恒星の向きと距離のつまみに合わせて毎フレーム同期される。
  readonly star?: StarSphere;
  // 天体照の光源として置く天体。中心は描画座標、albedo は輝度がボンドアルベドに一致する
  // 線形 RGB。省略すると天体照は無い。
  readonly planetLights?: readonly {
    readonly center: THREE.Vector3;
    readonly radius: number;
    readonly albedo: Albedo;
    // 光源として焼く全球の正距円筒テクスチャを返す口。画像が GPU へ届くまでは null を返す。
    readonly lightSourceMap?: () => LightSourceMap | null;
    // 描画座標のベクトルを天体固定の向きへ回す行列。省略すると単位行列。
    readonly bodyFromWorld?: THREE.Matrix4;
    // 光源として焼く大気と、その中に立つ雲。省略すると地表だけを焼く。
    readonly atmosphere?: AtmosphereBody;
  }[];
  // カメラを周回させるときに中心へ据える点(描画座標)。省略するとケースの物体を包む箱の中心。
  readonly viewTarget?: THREE.Vector3;
  // 撮影で写す向き。鍵は PNG の名前で全ケースを通して重ならないこと、値はケース既定の観察の向きへ
  // 重ねる差分。省略するとケースの名前で既定の向きを1枚撮る。
  readonly shots?: Readonly<Record<string, Partial<LabViewAngles>>>;
  // 大気パスへ渡す天体。中心は描画座標。並べ替えと濃い表現の重みは、カメラの位置から
  // 引き直される。
  readonly atmospheres?: readonly AtmosphereBody[];
  // 影パスへ渡す球。中心は描画座標。
  readonly shadowBodies?: readonly ShadowBody[];
  // 影パスへ渡す環。中心と法線軸は描画座標。
  readonly rings?: { readonly center: THREE.Vector3; readonly axis: THREE.Vector3; readonly bands: readonly RingBand[] };
  // 影パスへ渡す積雲の殻。
  readonly cumulus?: ShadowCumulus;
  // 動的な雲場を表示時刻へ焼く。gpu を渡すと、焼いた GPU 時間をそこへ計上する。
  readonly bakeClouds?: (renderer: WebGPURenderer, displayTime: number, gpu?: GpuTimingSink) => void;
  // 動的な雲場を解放する。
  readonly disposeClouds?: () => void;
  // ケースの部品が揃い、絵として比べられる状態になったか。持たせると、撮影はこれが真になるまで
  // 1 フレームずつ描いて待つ。
  readonly ready?: () => boolean;
  // 描画品質設定のうち、ケースの部品が読む項目を押し込み、部品をこのフレームのカメラへ合わせる口。
  // 毎フレーム、カメラを置いたあとに呼ばれるので、同値なら何もしないこと。
  readonly applyGraphics?: (graphics: GraphicsSettingsData) => void;
  // 計測結果へ添える、タンパク質ケースの識別。
  readonly proteinMotion?: ProteinLabCaseMetadata;
  // 表示時刻 displayTime [s] まで残基 motion を進め、そのフレームの計測値を返す。
  readonly updateProteinMotion?: (displayTime: number) => ProteinMotionFrameSample;
  // 残基 motion が握る資源を解放する。
  readonly disposeProteinMotion?: () => void;
}

// ケースを組む関数。style の表示スタイルで組んだ姿を返し、環の帯は ringMaterials で描く。
export type CaseBuilder = (style: RenderStyle, ringMaterials: RingMaterials) => LabCase;

// 原点から -Z を見るケース共通のカメラ。far [m] だけをケースが選ぶ。
export function labCamera(far: number): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(FOV_DEG, VIEW_WIDTH / VIEW_HEIGHT, NEAR, far);
  camera.position.copy(EYE);
  camera.lookAt(AHEAD);
  camera.updateMatrixWorld();
  return camera;
}

// 識別色 albedo の球を、半径 radius [m] で center(描画座標)へ置く。
export function sphere(albedo: Albedo, radius: number, center: THREE.Vector3): THREE.Object3D {
  const group = new THREE.Group();
  group.position.copy(center);
  group.scale.setScalar(radius);
  const surface = CelestialSurface.solid(albedo);
  surface.addTo(group);
  // 見かけ直径は画面の高さぶんとみなす。
  surface.syncLod(VIEW_HEIGHT);
  return group;
}

// 寄り切ったときの見かけ直径 [px] として天体へ渡す値。分割段ラダーの最上段が選ばれる。
export const CLOSE_UP_DIAMETER_PX = 6e4;

// 実写テクスチャを貼った天体を、定義 def の扁平のまま中心 center(描画座標)へ置く。極は描画座標の
// +Y。apparentDiameterPx は分割段を選ぶ見かけ直径で、寄れるケースでは寄り切った大きさを渡す。
// axes は半軸 [m]、ready は地表の画像がすべて GPU へ届いたか。
export function texturedBody(
  texture: CelestialTexture, def: PlanetDef, center: THREE.Vector3, apparentDiameterPx: number,
): { readonly object: THREE.Object3D; readonly axes: THREE.Vector3; readonly ready: () => boolean } {
  const shape = shapeAxes(def.radius, def.shape);
  const axes = new THREE.Vector3(shape.x, shape.y, shape.z);
  const group = new THREE.Group();
  group.position.copy(center);
  group.scale.copy(axes);
  const surface = CelestialSurface.textured(texture);
  surface.addTo(group);
  surface.syncLod(apparentDiameterPx);
  return { object: group, axes, ready: () => surface.imagesReady };
}

// 中心 center、半径 radius、平面 (u, v) の円を1本。分割はカメラで決まるので、カメラを作った
// あとに呼ぶ。
export function circle(
  center: THREE.Vector3, radius: number, u: THREE.Vector3, v: THREE.Vector3,
  style: LineStyle, camera: THREE.Camera,
): THREE.Object3D {
  const curve = new Curve(style);
  curve.setAnalyticCurve((t, out) => {
    const theta = 2 * Math.PI * t;
    out.copy(center)
      .addScaledVector(u, radius * Math.cos(theta))
      .addScaledVector(v, radius * Math.sin(theta));
  }, camera, VIEW_HEIGHT);
  return curve.object;
}

// 組み立てを、ゲーム本体と同じ表示部品で1つの物体にする。原点は組み立ての重心。
export function shipObject(assembly: ShipAssembly): THREE.Object3D {
  const shape = shipPhysicsShape(assembly);
  if (shape === null) throw new Error('render-lab ship assembly is empty');
  const view = new ModularShipView(buildShipModuleModel, undefined, false);
  view.sync(shipRenderAssembly(assembly).modules, shape.centerOffset);
  // render-lab case の破棄時に view も解放できるよう所有者を紐付ける。
  view.object.userData.renderLabShipView = view;
  return view.object;
}

// 既定戦闘船のモデルを 1 つの物体で返す。原点は組み立ての重心。
function buildDefaultShipObject(): THREE.Object3D {
  return shipObject(createDefaultCombatPreset());
}

// 自機メッシュ 1 隻を、描画座標の position へ置く。rotation を渡すと機体の姿勢を回す。
export function shipAt(position: THREE.Vector3, rotation?: THREE.Euler): THREE.Object3D {
  const group = buildDefaultShipObject();
  group.position.copy(position);
  if (rotation !== undefined) group.rotation.copy(rotation);
  return group;
}

// 斜光の恒星の向き。カメラは −Z を見るので、左上手前から差す。
export const OBLIQUE_SUN_DIR = new THREE.Vector3(-0.70, 0.20, 0.68).normalize();
// 機軸の片端と側面の両方が見える機体の姿勢。
export const SHIP_ROTATION_PORT = new THREE.Euler(-0.5, 0.6, 0.12);

// 恒星までの距離 [m] と画角 [deg] に対する、画面上での太陽の見かけ直径 [px]。**LOD の閾値判定と
// 同じ換算を通す** — つまみの脇に出る数と、球/点像の切り替わる距離が食い違ってはならない。
export function sunDiameterPx(distance: number, fovDeg: number): number {
  return apparentSizePx(2 * R_SUN, metersPerPixelAtDepth(fovDeg, distance, VIEW_HEIGHT));
}
