// 溝の梯子のケース。広い白い床に、幅と深さが公比 2 で並ぶ溝と、太さの違う寝かせた円柱を置く。1 枚の絵の中に
// 3 cm から 2 m までの構造のスケールと、手前から地平までの距離が並ぶので、近くの構造による遮りと照り返しが
// 構造の大きさと画面上の大きさのどちらにどう従うかを読む試験体。
import * as THREE from 'three/webgpu';
import { markLitOpaque } from '../../src/render/pipeline/lit-layer';
import { directionFromAngles, type EarthAngleKey, type LabViewAngles } from './view-angles';
import { EARTH_AWAY, labCamera, slab, white, WHITE_ROUGHNESS, type CaseBuilder, type LabCase } from './lab-case';

// 溝の幅(= 深さ)[m]。3 cm から公比 2 で 7 段。溝は z に沿って走り、x の向きへ並ぶ。
const GROOVE_WIDTHS = Array.from({ length: 7 }, (_, k) => 0.03 * 2 ** k);
// 溝と溝のあいだの床の幅と、溝の長さ [m]。溝は z = ±GROOVE_LENGTH/2。
const LAND_WIDTH = 1;
const GROOVE_LENGTH = 6;
// 床の板の厚み [m]。最も深い溝より厚い。
const FLOOR_THICKNESS = 2.5;
// 溝の区画の外へ広げる床の幅 [m]。地平の近くまで床が続き、画面の上で近傍の半径が数画素まで縮む受け手が並ぶ。
const FLOOR_EXTENT = 400;

// 寝かせた円柱の半径と、軸(x に沿う)の z [m]。溝の奥に、細いものから手前に並べる。円柱の長さ [m]。
const CYLINDERS = [
  { radius: 0.05, z: -5 },
  { radius: 0.2, z: -6.5 },
  { radius: 0.8, z: -9 },
];
const CYLINDER_LENGTH = 6;

// 光る帯。溝の奥の端に沿って溝の列を横切り、溝の中と円柱を照り返しだけで照らす。寸法 [m] と底面の中心、
// 自己発光の色と放射輝度(「1 天文単位で恒星に正対したアルベド 1 の面 = 1」の目盛り)。
const STRIP_SIZE = new THREE.Vector3(10, 0.15, 0.3);
const STRIP_BASE = new THREE.Vector3(0, 0, -GROOVE_LENGTH / 2 - 0.6);
const STRIP_COLOR = new THREE.Vector3(1, 0.8, 0.4);
const STRIP_RADIANCE = 1.5;

// 観察の中心と、既定のカメラの方位・仰角 [deg]・距離 [m]。溝に沿って斜め上から見下ろし、上端に地平が入る。
// 距離は、0.4 倍に寄せても画面の下端の床が近クリップ面より奥に残る値。
const VIEW_TARGET = new THREE.Vector3(0, 0, -1);
const CAMERA_AZIMUTH_DEG = 20;
const CAMERA_ELEVATION_DEG = 25;
const CAMERA_DISTANCE = 12;
// 確かめの撮影の、カメラの方位 [deg] と距離の倍率。
const CHECK_AZIMUTH_DEG = -35;
const CHECK_DISTANCE_SCALE = 1.6;

// 地球の置き方: 描画原点の高度を低軌道の 420 km にし、真上に置く。直下点は地表の色が読める陸(サハラ)。
const OVERHEAD_EARTH: Pick<LabViewAngles, EarthAngleKey> = {
  earthAzimuthDeg: 0,
  earthElevationDeg: 90,
  earthAltitudeLog: Math.log10(420e3),
  earthLatitudeDeg: 23,
  earthLongitudeDeg: 13,
};
// 恒星を床の真下に置く向き。見えている面はどれも直射を受けない。
const SUN_BELOW: Partial<LabViewAngles> = { sunAzimuthDeg: 0, sunElevationDeg: -90 };

// 観察の中心から、既定の方位・仰角のまま距離を scale 倍にしたカメラの、観察の向きの差分。
function cameraScaled(azimuthDeg: number, scale: number): Partial<LabViewAngles> {
  return { cameraAzimuthDeg: azimuthDeg, cameraElevationDeg: CAMERA_ELEVATION_DEG, cameraDistanceLog: Math.log10(scale) };
}

// 溝の区画の床と溝の底、その外へ広がる床。床の上面は y = 0 で、溝の底は深さ = 幅。
function floor(): THREE.Mesh[] {
  const rowWidth = GROOVE_WIDTHS.reduce((sum, w) => sum + w, 0) + LAND_WIDTH * (GROOVE_WIDTHS.length - 1);
  const zBack = -GROOVE_LENGTH / 2;
  const zFront = GROOVE_LENGTH / 2;
  const bottom = -FLOOR_THICKNESS;
  const meshes: THREE.Mesh[] = [];
  // 溝の区画。左から、溝の底と溝のあいだの床を交互に置く。
  let x = -rowWidth / 2;
  for (const [k, width] of GROOVE_WIDTHS.entries()) {
    meshes.push(slab(new THREE.Vector3(x, bottom, zBack), new THREE.Vector3(x + width, -width, zFront)));
    x += width;
    if (k === GROOVE_WIDTHS.length - 1) break;
    meshes.push(slab(new THREE.Vector3(x, bottom, zBack), new THREE.Vector3(x + LAND_WIDTH, 0, zFront)));
    x += LAND_WIDTH;
  }
  // 区画の外の床。左右は奥行きいっぱい、奥と手前は区画の幅だけ。
  const e = FLOOR_EXTENT;
  const left = -rowWidth / 2;
  const right = rowWidth / 2;
  meshes.push(
    slab(new THREE.Vector3(-e, bottom, -e), new THREE.Vector3(left, 0, e)),
    slab(new THREE.Vector3(right, bottom, -e), new THREE.Vector3(e, 0, e)),
    slab(new THREE.Vector3(left, bottom, -e), new THREE.Vector3(right, 0, zBack)),
    slab(new THREE.Vector3(left, bottom, zFront), new THREE.Vector3(right, 0, e)),
  );
  return meshes;
}

// 床に寝かせた円柱。軸は x に沿う。
function cylinders(): THREE.Mesh[] {
  return CYLINDERS.map(({ radius, z }) => {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, CYLINDER_LENGTH, 64), white());
    mesh.rotation.z = Math.PI / 2;
    mesh.position.set(0, radius, z);
    mesh.userData.ownsGeometry = true;
    mesh.userData.ownsMaterial = true;
    return mesh;
  });
}

// 光る帯。ベース色は黒で、自己発光だけで光る。
function strip(): THREE.Mesh {
  const material = new THREE.MeshStandardMaterial({
    color: 0x000000,
    roughness: WHITE_ROUGHNESS,
    metalness: 0,
    emissive: new THREE.Color().setRGB(STRIP_COLOR.x, STRIP_COLOR.y, STRIP_COLOR.z, THREE.LinearSRGBColorSpace),
    emissiveIntensity: STRIP_RADIANCE,
  });
  const half = new THREE.Vector3(STRIP_SIZE.x / 2, 0, STRIP_SIZE.z / 2);
  return slab(STRIP_BASE.clone().sub(half), STRIP_BASE.clone().add(half).setY(STRIP_SIZE.y), material);
}

// 溝の梯子。撮影はどれも恒星を床の真下に置き、地球照と環境光、または光る帯の照り返しだけで照らす。
function grooveLadder(): LabCase {
  const group = new THREE.Group();
  group.add(...floor(), ...cylinders(), strip());
  markLitOpaque(group);
  const camera = labCamera();
  camera.position.copy(VIEW_TARGET).addScaledVector(
    directionFromAngles(CAMERA_AZIMUTH_DEG, CAMERA_ELEVATION_DEG, new THREE.Vector3()), CAMERA_DISTANCE,
  );
  camera.lookAt(VIEW_TARGET);
  camera.updateMatrixWorld();
  return {
    objects: [group],
    camera,
    viewTarget: VIEW_TARGET,
    earth: OVERHEAD_EARTH,
    shots: {
      // 遮り。地球を真上に置く。距離を 0.4 倍・2.5 倍にすると、同じ溝が画面の上で違う大きさに写る。
      'groove-ladder': { view: SUN_BELOW },
      'groove-ladder-near': { view: { ...SUN_BELOW, ...cameraScaled(CAMERA_AZIMUTH_DEG, 0.4) } },
      'groove-ladder-far': { view: { ...SUN_BELOW, ...cameraScaled(CAMERA_AZIMUTH_DEG, 2.5) } },
      // 照り返し。地球を遠ざけて天体照を切り、光る帯のそばの明るい照り返しと、遠くの暗い床を並べる。露出を上げて
      // 照り返しを読める明るさにする。
      'groove-ladder-bounce': {
        view: { ...SUN_BELOW, ...EARTH_AWAY }, graphics: { planetLightCount: 0, exposureCompensation: 4 },
      },
      // 確かめ。遮りを別の方位と距離から撮る。
      'groove-ladder-check': { view: { ...SUN_BELOW, ...cameraScaled(CHECK_AZIMUTH_DEG, CHECK_DISTANCE_SCALE) } },
    },
  };
}

export const GROOVE_LADDER_CASES = {
  'groove-ladder': grooveLadder,
} as const satisfies Record<string, CaseBuilder>;
