// 金属の床・立方体・球・トーラスノットを粗さを振って置き、色のある壁と光る球の像の映り込みを読む試験体。
// プリセットの目視用。
import * as THREE from 'three/webgpu';
import { markLitOpaque, markShadowCaster } from '../../src/render/pipeline/lit-layer';
import { directionFromAngles } from './view-angles';
import {
  cornellRoomShell, flickerShots, labCamera, OVERHEAD_EARTH, slab, WHITE_ROUGHNESS, type CaseBuilder, type LabCase,
} from './lab-case';
import type { GraphicsSettingsData } from '../../src/render/graphics-settings';

// 箱の内寸 [m]。内面は x = ±HALF_WIDTH・z = BACK_Z・y = HEIGHT で、z = FRONT_Z で手前を開ける。床の上面は y = 0。
const HALF_WIDTH = 3;
const BACK_Z = -3;
const FRONT_Z = 3;
const HEIGHT = 5.5;
const PANEL_THICKNESS = 0.2;

// 金属の線形の灰色の値(金属度 1 なので鏡面反射率そのもの)。
const METAL_REFLECTANCE = 0.9;
// 金属の床の粗さ。粗い面の均しが広い範囲に出る。
const FLOOR_ROUGHNESS = 0.2;
// 金属の立方体の辺 [m]、中心 x・z [m]、方位 [deg]、粗さ。
const CUBE_SIZE = 1.6;
const CUBE_CENTER_X = -1.5;
const CUBE_CENTER_Z = -1.6;
const CUBE_YAW_DEG = 20;
const CUBE_ROUGHNESS = 0.05;
// 床に接する金属の球の半径と中心 x・z [m]、粗さ。
const SPHERE_RADIUS = 1.0;
const SPHERE_CENTER_X = 1.6;
const SPHERE_CENTER_Z = -1.7;
const SPHERE_ROUGHNESS = 0.15;
// 金属のトーラスノットの半径・管の太さ [m]、床からの隙間と中心 x・z [m]、方位 [deg]、粗さ。
const KNOT_RADIUS = 0.6;
const KNOT_TUBE = 0.22;
const KNOT_CLEARANCE = 0.1;
const KNOT_X = 0;
const KNOT_Z = -0.2;
const KNOT_YAW_DEG = -30;
const KNOT_ROUGHNESS = 0.25;

// 光る球の半径と中心 [m]。自己発光の色と放射輝度は「1 天文単位で恒星に正対したアルベド 1 の面 = 1」の目盛り。
const GLOW_RADIUS = 0.3;
const GLOW_CENTER = new THREE.Vector3(0, 2.2, -2.5);
const GLOW_COLOR = new THREE.Vector3(0.25, 0.55, 1);
const GLOW_RADIANCE = 2;

// 観察の中心と、既定のカメラの方位・仰角 [deg]・距離 [m]。
const VIEW_TARGET = new THREE.Vector3(0, 0.8, -1.2);
const CAMERA_AZIMUTH_DEG = 25;
const CAMERA_ELEVATION_DEG = 30;
const CAMERA_DISTANCE = 5.5;
// 近距離撮影の距離 [m] と仰角 [deg]。
const CLOSE_DISTANCE = 3.4;
const CLOSE_ELEVATION_DEG = 18;
const SUN_AZIMUTH_DEG = 60;
const SUN_ELEVATION_DEG = 12;
const GRAPHICS: Partial<GraphicsSettingsData> = { exposureCompensation: 4, screenSpaceSpecular: true };

// geometry と material の Mesh。ジオメトリとマテリアルは Mesh が所有する。
function ownedMesh(geometry: THREE.BufferGeometry, material: THREE.Material): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.userData.ownsGeometry = true;
  mesh.userData.ownsMaterial = true;
  return mesh;
}

// 天井・奥の壁と、赤い左の壁・緑の右の壁。
function walls(): THREE.Mesh[] {
  return cornellRoomShell({
    halfWidth: HALF_WIDTH, backZ: BACK_Z, frontZ: FRONT_Z, height: HEIGHT, panelThickness: PANEL_THICKNESS,
  }).slice(1);
}

// 金属の材質。
function metal(roughness: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color().setRGB(METAL_REFLECTANCE, METAL_REFLECTANCE, METAL_REFLECTANCE, THREE.LinearSRGBColorSpace),
    roughness,
    metalness: 1,
  });
}

// Cornell 箱の床板と同じ寸法の金属床。
function metalFloor(): THREE.Mesh {
  return slab(
    new THREE.Vector3(-HALF_WIDTH - PANEL_THICKNESS, -PANEL_THICKNESS, BACK_Z - PANEL_THICKNESS),
    new THREE.Vector3(HALF_WIDTH + PANEL_THICKNESS, 0, FRONT_Z),
    metal(FLOOR_ROUGHNESS),
  );
}

// 床に置いた立方体。
function metalCube(): THREE.Mesh {
  const mesh = ownedMesh(new THREE.BoxGeometry(CUBE_SIZE, CUBE_SIZE, CUBE_SIZE), metal(CUBE_ROUGHNESS));
  mesh.position.set(CUBE_CENTER_X, CUBE_SIZE / 2, CUBE_CENTER_Z);
  mesh.rotation.y = THREE.MathUtils.degToRad(CUBE_YAW_DEG);
  return mesh;
}

// 床に接する金属の球。
function metalSphere(): THREE.Mesh {
  const mesh = ownedMesh(new THREE.SphereGeometry(SPHERE_RADIUS, 64, 32), metal(SPHERE_ROUGHNESS));
  mesh.position.set(SPHERE_CENTER_X, SPHERE_RADIUS, SPHERE_CENTER_Z);
  return mesh;
}

// 床から隙間を空けた金属のトーラスノット。
function metalKnot(): THREE.Mesh {
  const geometry = new THREE.TorusKnotGeometry(KNOT_RADIUS, KNOT_TUBE, 256, 32);
  geometry.computeBoundingBox();
  const mesh = ownedMesh(geometry, metal(KNOT_ROUGHNESS));
  mesh.rotation.y = THREE.MathUtils.degToRad(KNOT_YAW_DEG);
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
  group.add(...walls(), metalFloor(), metalCube(), metalSphere(), metalKnot(), glowSphere());
  markLitOpaque(group);
  markShadowCaster(group);
  return group;
}

// 金属の部屋。恒星は右手前から低く差し、地球は真上に置く。
function metalRoom(): LabCase {
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
      'metal-room': { view: {}, graphics: GRAPHICS },
      'metal-room-close': {
        view: {
          cameraDistanceLog: Math.log10(CLOSE_DISTANCE / CAMERA_DISTANCE),
          cameraElevationDeg: CLOSE_ELEVATION_DEG,
        }, graphics: GRAPHICS,
      },
      ...flickerShots('metal-room', {}, { exposureCompensation: 4 }),
      ...flickerShots('metal-room-raw', {}, { exposureCompensation: 4, screenSpaceSpecularDenoise: false }),
    },
  };
}

export const METAL_ROOM_CASES = {
  'metal-room': metalRoom,
} as const satisfies Record<string, CaseBuilder>;
