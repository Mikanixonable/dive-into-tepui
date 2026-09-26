// 描画テスト環境のケースが共有する取り決め。ケースが返す形と組む関数の型、描画の大きさ、既定の
// カメラ・恒星の向きと、ケースが物体を置く部品(試験球・円・実写テクスチャの天体・既定戦闘船・
// インスタンスの枝)を持つ。
import * as THREE from 'three/webgpu';
import { CelestialSurface } from '../../src/render/celestial/celestial-surface';
import { shapeAxes, type PlanetDef } from '../../src/physics/celestial-body-def';
import { Curve, type CurveSampler } from '../../src/render/curve';
import { createDefaultCombatPreset } from '../../src/game/ship/ship-presets';
import { shipPhysicsShape } from '../../src/game/ship/ship-physics-shape';
import { shipRenderAssembly } from '../../src/game/ship/ship-render-adapter';
import { ModularShipView } from '../../src/render/dynamic/ship/modular-ship-view';
import { buildShipModuleModel } from '../../src/render/dynamic/ship/ship-module-models';
import { anglesFromDirection, type EarthAngleKey, type LabViewAngles } from './view-angles';
import type { Albedo } from '../../src/render/celestial-albedo';
import type { RingMaterials } from '../../src/render/celestial/ring';
import type { ShadowBody } from '../../src/render/pipeline/shadow/body-shadow';
import type { RingBand } from '../../src/render/pipeline/shadow/ring-shadow';
import type { LineStyle } from '../../src/render/line-style';
import type { ShipAssembly } from '../../src/game/ship/ship-assembly';
import type { ProteinLabCaseMetadata } from './protein-cases';
import type { AtmosphereBody } from '../../src/render/atmosphere';
import type { RenderStyle } from '../../src/render/render-style';
import type { GraphicsSettingsData } from '../../src/render/graphics-settings';
import type { CelestialTexture } from '../../src/render/celestial-textures';
import type { ProteinMotionFrameSample } from '../../src/game/protein/protein-motion-metrics';

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

// ケースのカメラの既定の位置と視線、近クリップ距離 [m]。
const EYE = new THREE.Vector3(0, 0, 0);
export const AHEAD = new THREE.Vector3(0, 0, -1);
const NEAR = 2;

// 撮影 1 枚ぶんの差分。
export interface LabShot {
  // 可動部を止めて撮る表示時刻 [s]。省略時は 0。
  readonly displayTime?: number;
  // ケース既定の観察の向きへ重ねる差分。
  readonly view: Partial<LabViewAngles>;
  // 起動時の描画品質設定へ重ねる差分。省略すると起動時の設定のまま撮る。
  readonly graphics?: Partial<GraphicsSettingsData>;
  // 生成雲へ局所光学場の診断体積を差し込む。省略すると差し込まない。
  readonly cloudLocalFieldDiagnostic?: boolean;
  // 局所タイルの既知周期を撮る診断条件。省略すると診断タイルを外す。
  readonly cloudDetailDiagnostic?: {
    readonly wavelengthKm: number;
    readonly directionDeg: number;
    readonly phaseDeg?: number;
    readonly composition?: 'absolute' | 'coverage-residual';
  };
}

export interface LabCase {
  // 可動部を表示時刻 [s] の姿へ同期する。
  readonly syncMotion?: (displayTime: number) => void;
  // シーンへ載せる物体。ジオメトリとマテリアルは、userData の ownsGeometry / ownsMaterial を立てた
  // 物体のものがケースを外すときに解放される。
  readonly objects: readonly THREE.Object3D[];
  // 既定の観察の向き・距離・画角を与えるカメラ。描くたびに観察の向きへ動かされ、遠クリップ距離も
  // そのとき決まる。
  readonly camera: THREE.PerspectiveCamera;
  // 恒星の向き(原点から見た単位ベクトル)。省略すると SUN_DIR。
  readonly sunDirection?: THREE.Vector3;
  // 地球を置くケースの、地球のつまみの既定値。地球は大気・天体照・影・積雲の影の源になる。省略すると
  // 地球を置かない。
  readonly earth?: Pick<LabViewAngles, EarthAngleKey>;
  // カメラを周回させるときに中心へ据える点(描画座標)。省略するとケースの物体を包む箱の中心。
  readonly viewTarget?: THREE.Vector3;
  // 撮影。鍵は PNG の名前で全ケースを通して重ならないこと。省略するとケースの名前で既定の向きを
  // 1枚撮る。
  readonly shots?: Readonly<Record<string, LabShot>>;
  // 地球のほかに大気パスへ渡す天体。中心は描画座標。並べ替えと濃い表現の重みは、カメラの位置から
  // 引き直される。
  readonly atmospheres?: readonly AtmosphereBody[];
  // 地球のほかに影パスへ渡す球。中心は描画座標。
  readonly shadowBodies?: readonly ShadowBody[];
  // 影パスへ渡す環。中心と法線軸は描画座標。
  readonly rings?: {
    readonly center: THREE.Vector3;
    readonly axis: THREE.Vector3;
    readonly bands: readonly RingBand[];
  };
  // ケースの部品が揃い、絵として比べられる状態になったか。持たせると、撮影はこれが真になるまで
  // 1 フレームずつ描いて待つ。
  readonly ready?: () => boolean;
  // 描画品質設定のうち、ケースの部品が読む項目を押し込み、部品をこのフレームのカメラと地球へ合わせる口。
  // earthCenter は地球の中心(描画座標)で、地球を置かないケースでは null。毎フレーム、カメラと地球を
  // 置いたあとに呼ばれるので、同値なら何もしないこと。
  readonly sync?: (graphics: GraphicsSettingsData, earthCenter: THREE.Vector3 | null) => void;
  // 計測結果へ添える、タンパク質ケースの識別。
  readonly proteinMotion?: ProteinLabCaseMetadata;
  // 表示時刻 displayTime [s] まで残基 motion を進め、そのフレームの計測値を返す。
  readonly updateProteinMotion?: (displayTime: number) => ProteinMotionFrameSample;
  // 残基 motion が握る資源を解放する。
  readonly disposeProteinMotion?: () => void;
  // ケースが THREE のシーン資源所有走査で扱えない補助資源を解放する。
  readonly dispose?: () => void;
  // 実テクスチャやシェーダ出力を対象にした render-lab 専用GPU診断。Three backend の
  // texture readback 関数と renderer を受け取る。renderer は診断用の float レンダーターゲットへの
  // 描画と readRenderTargetPixelsAsync による生値の読み戻しに使う。
  readonly readGpuTextureDiagnostic?: (
    readLayer: (texture: THREE.Texture, width: number, height: number, layer: number) => Promise<{
      readonly data: ArrayBufferView;
      readonly format: string;
    }>,
    renderer: THREE.WebGPURenderer,
  ) => Promise<unknown>;
}

// ケースを組む関数。style の表示スタイルで組んだ姿を返し、環の帯は ringMaterials で描く。
export type CaseBuilder = (style: RenderStyle, ringMaterials: RingMaterials) => LabCase;

// 原点から -Z を見るケース共通のカメラ。
export function labCamera(): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(FOV_DEG, VIEW_WIDTH / VIEW_HEIGHT, NEAR);
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

// 実写テクスチャごとの天体表面。ケースを組み直すたびに画像を読み直さないよう、組んだ表面を
// 使い回す。
const texturedSurfaces = new Map<CelestialTexture, CelestialSurface>();

// 実写テクスチャを貼った天体を、定義 def の扁平のまま中心 center(描画座標)へ置く。極は描画座標の
// +Y。apparentDiameterPx は分割段を選ぶ見かけ直径で、寄れるケースでは寄り切った大きさを渡す。
// axes は半軸 [m]、ready は地表の画像がすべて GPU へ届いたか。同じ texture の天体は表面を共有するので、
// 1 つのケースに置けるのは 1 体まで。
export function texturedBody(
  texture: CelestialTexture, def: PlanetDef, center: THREE.Vector3, apparentDiameterPx: number,
): { readonly object: THREE.Object3D; readonly axes: THREE.Vector3; readonly ready: () => boolean } {
  const shape = shapeAxes(def.radius, def.shape);
  const axes = new THREE.Vector3(shape.x, shape.y, shape.z);
  const group = new THREE.Group();
  group.position.copy(center);
  group.scale.copy(axes);
  const surface = texturedSurfaces.get(texture) ?? CelestialSurface.textured(texture);
  texturedSurfaces.set(texture, surface);
  // 使い回しの表面は、前に置いた群からこの群へ付け替わる。
  surface.addTo(group);
  surface.syncLod(apparentDiameterPx);
  return { object: group, axes, ready: () => surface.imagesReady };
}

// 中心 center、半径 radius、平面 (u, v) の円を t∈[0,1] で一周する曲線。
export function circleSampler(
  center: THREE.Vector3, radius: number, u: THREE.Vector3, v: THREE.Vector3,
): CurveSampler {
  return (t, out) => {
    const theta = 2 * Math.PI * t;
    out.copy(center)
      .addScaledVector(u, radius * Math.cos(theta))
      .addScaledVector(v, radius * Math.sin(theta));
  };
}

// 中心 center、半径 radius、平面 (u, v) の円を1本。分割はカメラで決まるので、カメラを作った
// あとに呼ぶ。
export function circle(
  center: THREE.Vector3, radius: number, u: THREE.Vector3, v: THREE.Vector3,
  style: LineStyle, camera: THREE.Camera,
): THREE.Object3D {
  const curve = new Curve(style);
  curve.setAnalyticCurve(circleSampler(center, radius, u, v), camera, VIEW_HEIGHT);
  return curve.object;
}

// 組み立てを、ゲーム本体と同じ表示部品で1つの物体にする。原点は組み立ての重心。
export function shipObject(assembly: ShipAssembly): THREE.Object3D {
  const shape = shipPhysicsShape(assembly);
  if (shape === null) throw new Error('render-lab ship assembly is empty');
  const view = new ModularShipView(buildShipModuleModel, undefined, false);
  view.sync(shipRenderAssembly(assembly).modules, shape.centerOffset);
  return view.object;
}

// 既定戦闘船 1 隻を、組み立ての重心が描画座標の position に来るよう置く。rotation を渡すと機体の姿勢を回す。
export function shipAt(position: THREE.Vector3, rotation?: THREE.Euler): THREE.Object3D {
  const group = shipObject(createDefaultCombatPreset());
  group.position.copy(position);
  if (rotation !== undefined) group.rotation.copy(rotation);
  return group;
}

// 斜光の恒星の向き。カメラは −Z を見るので、左上手前から差す。
export const OBLIQUE_SUN_DIR = new THREE.Vector3(-0.70, 0.20, 0.68).normalize();
// 機軸の片端と側面の両方が見える機体の姿勢。
export const SHIP_ROTATION_PORT = new THREE.Euler(-0.5, 0.6, 0.12);

// 仮の親 host へ組んで個体を積み終えた InstancedPool の枝を、host から外してケースの物体にする。
// ジオメトリとマテリアルはケースが所有する。
export function detachPoolMesh(host: THREE.Scene): THREE.Object3D {
  const mesh = host.children[0]!;
  host.remove(mesh);
  mesh.userData.ownsGeometry = true;
  mesh.userData.ownsMaterial = true;
  return mesh;
}
