// コーネルボックスのケース。手前を開けた白い箱の左の壁を赤、右の壁を緑に塗り、床の手前を正弦波の波板にして、奥に
// 床に接する球・床から浮かせたトーラスノット・光る球を置く。法線が連続に変わる凹凸(波板の山と谷・球・結び目)の
// 上で、近くの構造による遮りと照り返しを読む試験体。
import * as THREE from 'three/webgpu';
import { markLitOpaque, markShadowCaster } from '../../src/render/pipeline/lit-layer';
import { directionFromAngles } from './view-angles';
import {
  cornellRoomShell, labCamera, OVERHEAD_EARTH, white, WHITE_ROUGHNESS, type CaseBuilder, type LabCase,
} from './lab-case';
import type { GraphicsSettingsData } from '../../src/render/graphics-settings';

// 箱の内寸 [m]。内面は x = ±HALF_WIDTH・z = BACK_Z・y = HEIGHT で、z = FRONT_Z で手前を開ける。床の上面は y = 0。
const HALF_WIDTH = 3;
const BACK_Z = -3;
const FRONT_Z = 3;
const HEIGHT = 5.5;
// 床・壁・天井の板の厚み [m]。
const PANEL_THICKNESS = 0.2;

// 波板の振幅と波長 [m]、波の数と、波長あたりの分割数。波板は床の z = WAVE_BACK_Z から開口までを壁から壁まで覆い、
// 山は x に沿って走る。谷底で床の上面に接し、奥と手前の端は谷底で終わる。
const WAVE_AMPLITUDE = 0.25;
const WAVELENGTH = 1;
const WAVE_COUNT = 4;
const SEGMENTS_PER_WAVELENGTH = 32;
const WAVE_BACK_Z = FRONT_Z - WAVE_COUNT * WAVELENGTH;

// 床に接する球の半径と中心 [m]。
const SPHERE_RADIUS = 0.7;
const SPHERE_CENTER = new THREE.Vector3(-1.6, SPHERE_RADIUS, -2);

// トーラスノットの半径と管の太さ [m](差し渡しは約 1.3 m)、床からの隙間と、中心の x・z [m]。結び目の面は立てて、
// 方位 KNOT_YAW_DEG [deg] へ向ける — 光る球の側へ振る。
const KNOT_RADIUS = 0.35;
const KNOT_TUBE = 0.12;
const KNOT_CLEARANCE = 0.1;
const KNOT_X = 1.5;
const KNOT_Z = -2;
const KNOT_YAW_DEG = -30;

// 光る球の半径と中心 [m]。球と結び目のあいだに、床から浮かせて置く。自己発光の色と放射輝度は「1 天文単位で
// 恒星に正対したアルベド 1 の面 = 1」の目盛り。
const GLOW_RADIUS = 0.3;
const GLOW_CENTER = new THREE.Vector3(0, 0.5, -1.9);
const GLOW_COLOR = new THREE.Vector3(0.25, 0.55, 1);
const GLOW_RADIANCE = 2;

// 観察の中心と、既定のカメラの方位・仰角 [deg]・距離 [m]。開口の右上から箱の中を見下ろす — カメラは開口の内側に
// 入り、画面はどこも箱の内面で埋まる。
const VIEW_TARGET = new THREE.Vector3(0, 0.3, -0.6);
const CAMERA_AZIMUTH_DEG = 25;
const CAMERA_ELEVATION_DEG = 45;
const CAMERA_DISTANCE = 5.2;
// 波板を掠める撮影の、カメラの方位・仰角 [deg]・距離 [m] と、画角を狭める倍率。開口の手前の低い位置から望遠で
// 撮る — 広角のままでは、近クリップ面より奥に波板が写る高さまで上げると、画面の下端が箱の外へ出る。
const GRAZING_AZIMUTH_DEG = 8;
const GRAZING_ELEVATION_DEG = 10;
const GRAZING_DISTANCE = 6.3;
const GRAZING_ZOOM = 2;

// 恒星の方位・仰角 [deg]。右手前から低く差し、開口から入って赤い壁の手前半分と波板の左手前を照らす — 照らされた
// 赤い壁が照り返しの源になる。仰角は真上の地球の縁(仰角 20°)より低くする — 高いと恒星が地球に隠れる。
const SUN_AZIMUTH_DEG = 60;
const SUN_ELEVATION_DEG = 12;
// 撮影の描画設定。箱の奥は開口から入る光と照り返しだけで照らされ、恒星の直射に合わせた露出では沈むので、露出を
// 2 段上げる。
const GRAPHICS: Partial<GraphicsSettingsData> = { exposureCompensation: 4 };

// geometry と material の Mesh。ジオメトリとマテリアルは Mesh が所有する。
function ownedMesh(geometry: THREE.BufferGeometry, material: THREE.Material): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.userData.ownsGeometry = true;
  mesh.userData.ownsMaterial = true;
  return mesh;
}

// 床・天井・奥の壁と、赤い左の壁・緑の右の壁。
function shell(): THREE.Mesh[] {
  return cornellRoomShell({
    halfWidth: HALF_WIDTH, backZ: BACK_Z, frontZ: FRONT_Z, height: HEIGHT, panelThickness: PANEL_THICKNESS,
  });
}

// 奥行き z [m] での波板の上面の高さ [m]。
function waveHeight(z: number): number {
  return WAVE_AMPLITUDE * (1 - Math.cos(2 * Math.PI * (z - WAVE_BACK_Z) / WAVELENGTH));
}

// 波板。床に重ねて置く。
function corrugatedSheet(): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry(
    2 * HALF_WIDTH, FRONT_Z - WAVE_BACK_Z, 1, WAVE_COUNT * SEGMENTS_PER_WAVELENGTH,
  );
  // 面を上へ向けて波板の範囲へ移してから、高さを付けて法線を引き直す。
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, 0, (WAVE_BACK_Z + FRONT_Z) / 2);
  const position = geometry.getAttribute('position');
  for (let i = 0; i < position.count; i++) position.setY(i, waveHeight(position.getZ(i)));
  geometry.computeVertexNormals();
  return ownedMesh(geometry, white());
}

// 床に接する白い球。
function restingSphere(): THREE.Mesh {
  const mesh = ownedMesh(new THREE.SphereGeometry(SPHERE_RADIUS, 64, 32), white());
  mesh.position.copy(SPHERE_CENTER);
  return mesh;
}

// 床から浮かせた白いトーラスノット。
function knot(): THREE.Mesh {
  const geometry = new THREE.TorusKnotGeometry(KNOT_RADIUS, KNOT_TUBE, 256, 32);
  geometry.computeBoundingBox();
  const mesh = ownedMesh(geometry, white());
  mesh.rotation.y = THREE.MathUtils.degToRad(KNOT_YAW_DEG);
  // 方位の回転は高さを変えないので、ジオメトリの下端から隙間を測る。
  mesh.position.set(KNOT_X, KNOT_CLEARANCE - geometry.boundingBox!.min.y, KNOT_Z);
  return mesh;
}

// 光る球。ベース色は黒で、自己発光だけで光る。
function glowSphere(): THREE.Mesh {
  const material = new THREE.MeshStandardMaterial({
    color: 0x000000,
    roughness: WHITE_ROUGHNESS,
    metalness: 0,
    emissive: new THREE.Color().setRGB(GLOW_COLOR.x, GLOW_COLOR.y, GLOW_COLOR.z, THREE.LinearSRGBColorSpace),
    emissiveIntensity: GLOW_RADIANCE,
  });
  const mesh = ownedMesh(new THREE.SphereGeometry(GLOW_RADIUS, 32, 16), material);
  mesh.position.copy(GLOW_CENTER);
  return mesh;
}

// 箱と中の部品を 1 つの枝にまとめる — 影パスの枠が全体で 1 つになる。
function structure(): THREE.Object3D {
  const group = new THREE.Group();
  group.add(...shell(), corrugatedSheet(), restingSphere(), knot(), glowSphere());
  markLitOpaque(group);
  markShadowCaster(group);
  return group;
}

// コーネルボックス。恒星は右手前から低く差し、地球は真上に置く — 恒星の直射も天体照も環境光も開口から入る。
function cornellBox(): LabCase {
  const camera = labCamera();
  camera.position.copy(VIEW_TARGET).addScaledVector(
    directionFromAngles(CAMERA_AZIMUTH_DEG, CAMERA_ELEVATION_DEG, new THREE.Vector3()), CAMERA_DISTANCE,
  );
  camera.lookAt(VIEW_TARGET);
  camera.updateMatrixWorld();
  return {
    objects: [structure()],
    camera,
    viewTarget: VIEW_TARGET,
    sunDirection: directionFromAngles(SUN_AZIMUTH_DEG, SUN_ELEVATION_DEG, new THREE.Vector3()),
    earth: OVERHEAD_EARTH,
    shots: {
      'cornell-box': { view: {}, graphics: GRAPHICS },
      // 波板を、山を横切る向きに浅い角度から見る。
      'cornell-box-grazing': {
        view: {
          cameraAzimuthDeg: GRAZING_AZIMUTH_DEG,
          cameraElevationDeg: GRAZING_ELEVATION_DEG,
          cameraDistanceLog: Math.log10(GRAZING_DISTANCE / CAMERA_DISTANCE),
          cameraZoomLog: Math.log10(GRAZING_ZOOM),
        },
        graphics: GRAPHICS,
      },
    },
  };
}

export const CORNELL_BOX_CASES = {
  'cornell-box': cornellBox,
} as const satisfies Record<string, CaseBuilder>;
