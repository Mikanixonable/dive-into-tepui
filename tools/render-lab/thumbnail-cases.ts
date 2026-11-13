// 建造カタログ用サムネイルのケース。カタログの modelId ごとにモジュールを1つ置き、長軸を立てた
// 姿を斜め上からの固定視点と固定照明で画面中央の正方形へ収めて撮る。背景はケースごとの単色板で、
// 書き出し側が黒・白の2枚の差からモジュールの覆い(α)を復元するので、-black と -white の対で登録する。
import * as THREE from 'three/webgpu';
import { SHIP_MODULE_CATALOG } from '../../src/game/ship/ship-module-catalog';
import { buildShipModuleModel, getShipModuleTemplates } from '../../src/render/dynamic/ship/ship-module-models';
import { FOV_DEG, labCamera, VIEW_HEIGHT, VIEW_WIDTH, type CaseBuilder, type LabCase } from './lab-case';
import { directionFromAngles } from './view-angles';

// カタログに並ぶモデルの id。複数の定義が同じモデルを引くものは1つに畳む。
const MODEL_IDS: readonly string[] = [
  ...new Set(SHIP_MODULE_CATALOG.all().map((definition) => definition.modelId)),
];

// 固定の斜め上の視点(方位・仰角 [deg])と、カメラの側からやや上へ回した固定の照明。
const CAMERA_AZIMUTH_DEG = -38;
const CAMERA_ELEVATION_DEG = 50;
const SUN_DIRECTION = directionFromAngles(-70, 50, new THREE.Vector3());

// モジュールを包む球が縦方向の画角へ写る割合。正方形の中央だけを切り出すので、横幅の
// 半分(56%)より細く収まる値に留める。
const FRAME_FILL = 0.78;

// 視線の奥に置く無照明の単色板。物体より遠くの画素を全部覆う大きさで、書き出し側が背景色を
// 隅から測れるようにする。
function backdrop(center: THREE.Vector3, cameraOffset: THREE.Vector3, distance: number, color: number): THREE.Mesh {
  const depth = distance * 2;
  const halfHeight = Math.tan(THREE.MathUtils.degToRad(FOV_DEG / 2)) * depth;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(halfHeight * 2 * (VIEW_WIDTH / VIEW_HEIGHT) * 1.2, halfHeight * 2 * 1.2),
    new THREE.MeshBasicMaterial({ color }),
  );
  mesh.position.copy(center).addScaledVector(cameraOffset, -distance);
  mesh.lookAt(new THREE.Vector3().copy(center).addScaledVector(cameraOffset, distance));
  mesh.userData.ownsGeometry = true;
  mesh.userData.ownsMaterial = true;
  return mesh;
}

// GLB の雛形が読み込み済みか。撮影はこれが真になるまで1フレームずつ描いて待つ。
function shipModuleTemplatesLoaded(): boolean {
  try {
    return getShipModuleTemplates().children.length > 0;
  } catch {
    return false;
  }
}

// モデルの包み箱の最も長い軸を上方向(+Y)へ向ける。サムネイルでは部品の長軸が画面の
// 上下方向へ並ぶ向きで撮る。
function standLongAxisUpright(model: THREE.Object3D): void {
  const bounds = new THREE.Box3().setFromObject(model);
  const size = bounds.getSize(new THREE.Vector3());
  const longAxis = size.x >= size.y && size.x >= size.z ? new THREE.Vector3(1, 0, 0)
    : size.z >= size.y ? new THREE.Vector3(0, 0, 1)
    : null;
  if (longAxis === null) return;
  model.applyQuaternion(
    new THREE.Quaternion().setFromUnitVectors(longAxis, new THREE.Vector3(0, 1, 0)),
  );
}

// modelId のモデルを1つ置き、背景色 backdropColor の板を挟んだケース。撮影名はケース名と同じ。
// レンズ効果は切る — 背景の滲みが画素ごとの差へ混ざると、覆いの復元が斜めへ狂う。
function thumbnail(modelId: string, backdropColor: number, backdropName: 'black' | 'white'): LabCase {
  const model = buildShipModuleModel(modelId);
  standLongAxisUpright(model);
  const bounds = new THREE.Box3().setFromObject(model);
  const center = bounds.getCenter(new THREE.Vector3());
  const radius = bounds.getBoundingSphere(new THREE.Sphere()).radius;
  const distance = radius / (FRAME_FILL * Math.tan(THREE.MathUtils.degToRad(FOV_DEG / 2)));
  const offset = directionFromAngles(CAMERA_AZIMUTH_DEG, CAMERA_ELEVATION_DEG, new THREE.Vector3());
  const camera = labCamera();
  // labCamera 既定の近クリップ(2 m)は、小型モジュールの寄りでは被写体を食う。
  camera.near = Math.max(0.01, (distance - radius * 1.2) * 0.5);
  camera.position.copy(center).addScaledVector(offset, distance);
  camera.lookAt(center);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  const name = `thumbnail-${modelId}-${backdropName}`;
  return {
    objects: [model, backdrop(center, offset, distance * 1.2, backdropColor)],
    camera,
    viewTarget: center,
    sunDirection: SUN_DIRECTION,
    ready: shipModuleTemplatesLoaded,
    shots: { [name]: { view: {}, graphics: { lens: false } } },
  };
}

export const THUMBNAIL_CASES: Readonly<Record<`thumbnail-${string}`, CaseBuilder>> = Object.fromEntries(
  MODEL_IDS.flatMap((modelId): readonly (readonly [string, CaseBuilder])[] => [
    [`thumbnail-${modelId}-black`, () => thumbnail(modelId, 0x000000, 'black')],
    [`thumbnail-${modelId}-white`, () => thumbnail(modelId, 0xffffff, 'white')],
  ]),
);
