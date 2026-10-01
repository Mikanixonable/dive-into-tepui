// 斜面の扇のケース。白い床に、床と 15°〜75° をなす斜面を 1 本の稜に沿って並べ、日の当たる壁 1 面と、寝かせた
// 半円柱を置く。法線が中間の角で隣り合う継ぎ目と、法線が連続に変わる曲面の上で、近くの構造による遮りと照り返しを
// 読む試験体。
import * as THREE from 'three/webgpu';
import { markLitOpaque, markShadowCaster } from '../../src/render/pipeline/lit-layer';
import { directionFromAngles } from './view-angles';
import { labCamera, OVERHEAD_EARTH, slab, white, type CaseBuilder, type LabCase } from './lab-case';

// 斜面が床となす角 [deg]。−X の端から +X へ、隙間なく並べる。
const SLOPE_ANGLES_DEG = [75, 60, 45, 30, 15];
// 斜面の稜に沿う幅と、稜から上端までの斜面の長さ [m]。稜は z = 0 で x に沿い、斜面は −Z へ上がる。
const SLOPE_WIDTH = 2.2;
const SLOPE_LENGTH = 2.8;
// 斜面の列の −X の端の x [m]。列の中心を原点に置く。
const ROW_START_X = -SLOPE_ANGLES_DEG.length * SLOPE_WIDTH / 2;
const ROW_END_X = -ROW_START_X;

// 壁。列の −X の端から隙間 WALL_GAP をあけて稜に直交して立ち、日の当たる面は +X を向く。稜の手前まで延ばし、斜面と
// その手前の床の両方へ照り返しを返す。寸法と、両端の z [m]。
const WALL_GAP = 1;
const WALL_HEIGHT = 3;
const WALL_THICKNESS = 0.2;
const WALL_BACK_Z = -5;
const WALL_FRONT_Z = 2;

// 寝かせた半円柱の半径・長さと、軸の z [m]。軸は x に沿い、列の +X の端から隙間 CYLINDER_GAP をあけて置く。稜より
// 奥へ下げて、低い恒星が落とす半円柱の影を斜面から外す。
const CYLINDER_RADIUS = 2;
const CYLINDER_LENGTH = 3.5;
const CYLINDER_GAP = 1;
const CYLINDER_AXIS_Z = -3.5;

// 床の、どの部品からも近傍の半径(4 m)より外まで広げる幅と、厚み [m]。上面は y = 0。
const FLOOR_MARGIN = 4.5;
const FLOOR_THICKNESS = 0.2;

// 観察の中心と、既定のカメラの方位・仰角 [deg]・距離 [m]。右手前から見下ろす — 壁の日の当たる面と斜面の両方が写る。
const VIEW_TARGET = new THREE.Vector3(2, 0.8, -1.2);
const CAMERA_AZIMUTH_DEG = 25;
const CAMERA_ELEVATION_DEG = 35;
const CAMERA_DISTANCE = 12.5;
// 確かめの撮影の、カメラの方位 [deg] と距離の倍率。左手前から少し引いて撮る。
const CHECK_AZIMUTH_DEG = -10;
const CHECK_DISTANCE_SCALE = 1.2;

// 恒星の方位・仰角 [deg]。右手前から低く差し、壁の日の当たる面と、斜面・床・半円柱の見えている面を照らす。仰角は
// 真上の地球の縁(仰角 20°)より低くする — 高いと恒星が地球に隠れる。
const SUN_AZIMUTH_DEG = 50;
const SUN_ELEVATION_DEG = 12;

// 床と angleDeg [deg] をなす斜面を持つ楔。稜は z = 0 の x ∈ [xMin, xMin + SLOPE_WIDTH] で、斜面の上端から床へ
// 垂直な背面を下ろす。
function wedge(angleDeg: number, xMin: number): THREE.Mesh {
  const angle = THREE.MathUtils.degToRad(angleDeg);
  // 断面は (稜からの奥行き, 高さ) の直角三角形。
  const depth = SLOPE_LENGTH * Math.cos(angle);
  const height = SLOPE_LENGTH * Math.sin(angle);
  const section = new THREE.Shape([
    new THREE.Vector2(0, 0), new THREE.Vector2(depth, 0), new THREE.Vector2(depth, height),
  ]);
  const geometry = new THREE.ExtrudeGeometry(section, { depth: SLOPE_WIDTH, bevelEnabled: false });
  // 押し出しの向き(+Z)を稜に沿う +X へ、断面の奥行き(+X)を −Z へ回す。
  geometry.rotateY(Math.PI / 2);
  const mesh = new THREE.Mesh(geometry, white());
  mesh.position.x = xMin;
  mesh.userData.ownsGeometry = true;
  mesh.userData.ownsMaterial = true;
  return mesh;
}

// 寝かせた半円柱。平らな面を床に伏せる。
function halfCylinder(): THREE.Mesh {
  const geometry = new THREE.CylinderGeometry(
    CYLINDER_RADIUS, CYLINDER_RADIUS, CYLINDER_LENGTH, 64, 1, false, 0, Math.PI,
  );
  const mesh = new THREE.Mesh(geometry, white());
  // 軸を x へ倒すと、θ ∈ [0, π] の側面が床の上に来る。
  mesh.rotation.z = Math.PI / 2;
  mesh.position.set(ROW_END_X + CYLINDER_GAP + CYLINDER_LENGTH / 2, 0, CYLINDER_AXIS_Z);
  mesh.userData.ownsGeometry = true;
  mesh.userData.ownsMaterial = true;
  return mesh;
}

// 床・楔・壁・半円柱を 1 つの枝にまとめる — 影パスの枠が全体で 1 つになる。
function structure(): THREE.Object3D {
  const wallX = ROW_START_X - WALL_GAP;
  // 床は、壁から半円柱までの全体を FLOOR_MARGIN ずつ囲む。
  const floorMin = new THREE.Vector3(
    wallX - WALL_THICKNESS - FLOOR_MARGIN, -FLOOR_THICKNESS,
    Math.min(WALL_BACK_Z, CYLINDER_AXIS_Z - CYLINDER_RADIUS) - FLOOR_MARGIN,
  );
  const floorMax = new THREE.Vector3(
    ROW_END_X + CYLINDER_GAP + CYLINDER_LENGTH + FLOOR_MARGIN, 0, WALL_FRONT_Z + FLOOR_MARGIN,
  );
  const group = new THREE.Group();
  group.add(
    slab(floorMin, floorMax),
    ...SLOPE_ANGLES_DEG.map((angle, k) => wedge(angle, ROW_START_X + k * SLOPE_WIDTH)),
    slab(
      new THREE.Vector3(wallX - WALL_THICKNESS, 0, WALL_BACK_Z), new THREE.Vector3(wallX, WALL_HEIGHT, WALL_FRONT_Z),
    ),
    halfCylinder(),
  );
  markLitOpaque(group);
  markShadowCaster(group);
  return group;
}

// 斜面の扇。恒星は右手前から低く差し、地球は真上に置く — 天体照と環境光の遮りと、日の当たる面の照り返しが
// 同じ絵に入る。
function slopeFan(): LabCase {
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
      'slope-fan': { view: {} },
      // 確かめ。同じ場面を別の方位と距離から撮る。
      'slope-fan-check': {
        view: {
          cameraAzimuthDeg: CHECK_AZIMUTH_DEG,
          cameraElevationDeg: CAMERA_ELEVATION_DEG,
          cameraDistanceLog: Math.log10(CHECK_DISTANCE_SCALE),
        },
      },
    },
  };
}

export const SLOPE_FAN_CASES = {
  'slope-fan': slopeFan,
} as const satisfies Record<string, CaseBuilder>;
