// 動きベクトルを確かめるケース — 通常物体と薬莢を置く小さな部屋(casing-room)と、薬莢と飛散片を上限まで積む
// 大きな部屋(casing-pool)。実体の姿勢と積み順は論理フレームの番号と値の口だけで決まり、描く回数に依らない。
import * as THREE from 'three/webgpu';
import { ENTITY_CAP } from '../../src/game/dynamic/dynamic-entity/entity-kind';
import { mulberry32 } from '../../src/math/random';
import { CasingPool } from '../../src/render/dynamic/dynamic-entity/casing-view';
import { DebrisFragmentPools } from '../../src/render/dynamic/dynamic-entity/debris-fragment-view';
import { markLitOpaque, markShadowCaster } from '../../src/render/pipeline/lit-layer';
import { syncThermalState } from '../../src/render/thermal-emissive';
import { directionFromAngles } from './view-angles';
import {
  cornellRoomShell, labCamera, OVERHEAD_EARTH, standard, white, type CaseBuilder,
  type CornellRoomDimensions, type LabCase, type LabMotionEntity, type LabShot,
} from './lab-case';
import type { GraphicsSettingsData } from '../../src/render/graphics-settings';

// プールへ積む順。stable は毎フレーム同じ実体を同じ順に、shuffle は同じ実体をフレームごとに並べ替えて、churn は
// フレームごとに実体の約 1/5 を新しい identity へ入れ替えて積む。
type CasingRoomOrder = 'stable' | 'shuffle' | 'churn';
// 描画座標。world はケースの世界座標のまま描き、floating はカメラの位置を描画座標の原点へ置き直す。
type CasingRoomCoordinates = 'world' | 'floating';
type CasingRoomOrdinaryId = 'translating-box' | 'rotating-knot' | 'orbiting-sphere' | 'static-pedestal';

// 値の口(setValue)で差し替えられる値。
interface CasingRoomValues {
  readonly casingOrder: CasingRoomOrder;
  readonly coordinates: CasingRoomCoordinates;
  // 偽なら、どの論理フレームでもフレーム 0 の姿勢に置く。
  readonly motion: boolean;
  readonly casingCount: number;
  // 積む飛散片の数。飛散片は casing-pool だけが描く。
  readonly debrisCount: number;
  // 物が動くのをやめる論理フレーム。それより後のフレームは、このフレームの姿勢のまま止まる。-1 なら止めない。
  readonly motionStopFrame: number;
}

const CASING_ROOM_ORDINARY_IDS: readonly CasingRoomOrdinaryId[] = [
  'translating-box', 'rotating-knot', 'orbiting-sphere', 'static-pedestal',
];

const CASING_CAPACITY = ENTITY_CAP.casing;
// 薬莢の identity の範囲。上限の 2 倍あり、churn で積む実体が入れ替わる。
const CASING_ID_COUNT = 2 * CASING_CAPACITY;
// 床に寝かせた薬莢の軸の、床からの高さ [m]。
const CASING_AXIS_HEIGHT = 0.231;
// 小さい部屋の既定の薬莢の数と、そのうち床に置く数(残りは左右の壁際の空中)。
const ROOM_DEFAULT_COUNT = 20;
const ROOM_FLOOR_COUNT = 10;
// 大きい部屋の床群の数と列の数、空中群の 1 本(奥行きの層)の列と段の数。
const POOL_FLOOR_COUNT = 104;
const POOL_FLOOR_COLUMNS = 8;
const POOL_AIR_COLUMNS = 13;
const POOL_AIR_ROWS = 4;
const POOL_AIR_LANE_SIZE = POOL_AIR_COLUMNS * POOL_AIR_ROWS;
// 飛散片の上限と identity の範囲(薬莢と同じく上限の 2 倍)。
const DEBRIS_CAPACITY = 600;
const DEBRIS_ID_COUNT = 2 * DEBRIS_CAPACITY;
// 飛散片の形の数。DebrisFragmentPools の形の数と揃える。
const DEBRIS_VARIANT_COUNT = 7;
// shuffle の並べ替えの乱数の種へ混ぜる値。薬莢と飛散片で別の並びにする。
const CASING_SHUFFLE_SEED = 0x9e3779b9;
const DEBRIS_SHUFFLE_SEED = 0x85ebca6b;

const ROOM_DIMENSIONS: CornellRoomDimensions = {
  halfWidth: 3, backZ: -3, frontZ: 3, height: 5.5, panelThickness: 0.2,
};
const POOL_DIMENSIONS: CornellRoomDimensions = {
  halfWidth: 7.5, backZ: -15, frontZ: 0, height: 9, panelThickness: 0.25,
};

// 通常物体は画面の四領域へ分け、動く範囲どうしも重ねない。
const BOX_CENTER = new THREE.Vector3(-1.6, 0.65, 0.55);
const KNOT_CENTER = new THREE.Vector3(1.45, 1.15, -1.45);
const ORBIT_CENTER = new THREE.Vector3(0, 3.15, -0.65);
const PEDESTAL_CENTER = new THREE.Vector3(0, 0.3, 0.8);
const ORBIT_RADIUS = 1.15;

const ROOM_VIEW_TARGET = new THREE.Vector3(0, 1.35, -0.25);
const POOL_VIEW_TARGET = new THREE.Vector3(0, 3.1, -7.6);
const ROOM_GRAPHICS: Partial<GraphicsSettingsData> = {
  exposureCompensation: 4, screenSpaceOcclusion: true, screenSpaceIndirect: true,
};
const POOL_GRAPHICS: Partial<GraphicsSettingsData> = {
  exposureCompensation: 2, screenSpaceOcclusion: true, screenSpaceIndirect: true,
};

// 行列を組む作業用の値。呼ぶたびに書き換える。
const MATRIX_POSITION = new THREE.Vector3();
const MATRIX_ROTATION = new THREE.Quaternion();
const MATRIX_SCALE = new THREE.Vector3(1, 1, 1);
const MATRIX_EULER = new THREE.Euler();
const REBASE_MATRIX = new THREE.Matrix4();
const ORBIT_OFFSET = new THREE.Vector3();

// 2 つの部屋の違い。hot* は hotStride 個おきの薬莢に与える温度 [K] と放射率、camera* と sun* は既定の観察の向き [deg] と
// 距離 [m]、ordinary は通常物体を置くか、casingMatrixAt は薬莢 identity の論理フレームの model 行列を target へ書いて返す。
interface CasingCaseConfiguration {
  readonly name: 'casing-room' | 'casing-pool';
  readonly dimensions: CornellRoomDimensions;
  readonly defaultCount: number;
  readonly hotStride: number;
  readonly hotTemperature: number;
  readonly hotEmissivity: number;
  readonly viewTarget: THREE.Vector3;
  readonly cameraAzimuthDeg: number;
  readonly cameraElevationDeg: number;
  readonly cameraDistance: number;
  readonly sunAzimuthDeg: number;
  readonly sunElevationDeg: number;
  readonly ordinary: boolean;
  readonly casingMatrixAt: (identity: number, frame: number, motion: boolean, target: THREE.Matrix4) => THREE.Matrix4;
  readonly shots: Readonly<Record<string, LabShot>>;
}

// period フレームで −1 → 1 → −1 と往復する値。同じ frame には同じ値を返す。
function triangleWave(frame: number, period: number): number {
  const phase = ((frame % period) + period) % period / period;
  return 1 - 4 * Math.abs(phase - 0.5);
}

// 通常物体 id の、論理フレーム frame の小さい部屋の世界座標での model 行列を target へ書いて返す。motion が偽ならフレーム 0 の姿勢。
function casingRoomOrdinaryMatrixAt(
  id: CasingRoomOrdinaryId, frame: number, motion: boolean, target: THREE.Matrix4,
): THREE.Matrix4 {
  const k = motion ? frame : 0;
  MATRIX_SCALE.set(1, 1, 1);
  // 箱は横に往復、結び目はその場で回転、球は周回しながら回転、台座は静止。
  if (id === 'translating-box') {
    MATRIX_POSITION.copy(BOX_CENTER).setX(BOX_CENTER.x + 0.75 * triangleWave(k, 144));
    MATRIX_EULER.set(0, 0, 0);
  } else if (id === 'rotating-knot') {
    MATRIX_POSITION.copy(KNOT_CENTER);
    MATRIX_EULER.set(0.35, 0.014 * k, Math.PI / 2);
  } else if (id === 'orbiting-sphere') {
    const angle = 0.012 * k;
    ORBIT_OFFSET.set(
      ORBIT_RADIUS * Math.cos(angle), 0.32 * Math.sin(2 * angle), ORBIT_RADIUS * Math.sin(angle),
    );
    MATRIX_POSITION.copy(ORBIT_CENTER).add(ORBIT_OFFSET);
    MATRIX_EULER.set(0.009 * k, 0.017 * k, 0);
  } else {
    MATRIX_POSITION.copy(PEDESTAL_CENTER);
    MATRIX_EULER.set(0, 0, 0);
  }
  MATRIX_ROTATION.setFromEuler(MATRIX_EULER);
  return target.compose(MATRIX_POSITION, MATRIX_ROTATION, MATRIX_SCALE);
}

// 小さい部屋の薬莢 identity の、論理フレーム frame の model 行列を target へ書いて返す。motion が偽ならフレーム 0 の姿勢。
// 既定の 20 個は、通常物体の動く範囲を避けて床と左右の壁際へ置く。
function casingRoomCasingMatrixAt(
  identity: number, frame: number, motion: boolean, target: THREE.Matrix4,
): THREE.Matrix4 {
  const slot = identity % CASING_CAPACITY;
  const generation = Math.floor(identity / CASING_CAPACITY);
  const k = motion ? frame : 0;
  MATRIX_SCALE.set(1, 1, 1);
  // 床に寝かせて左右交互に並べ、向きだけを世代で変える。
  if (slot < ROOM_FLOOR_COUNT) {
    const side = slot % 2 === 0 ? -1 : 1;
    const along = Math.floor(slot / 2);
    MATRIX_POSITION.set(side * 2.55, CASING_AXIS_HEIGHT, -2.35 + along * 0.65);
    MATRIX_EULER.set(0, 0.12 * Math.sin(slot * 1.9) + generation * 0.04, Math.PI / 2);
  } else if (slot < ROOM_DEFAULT_COUNT) {
    // 左右の壁際の空中で揺らしながら回す。
    const local = slot - ROOM_FLOOR_COUNT;
    const side = local % 2 === 0 ? -1 : 1;
    const row = Math.floor(local / 2);
    const phase = identity * 1.61803398875;
    MATRIX_POSITION.set(
      side * (2.35 + 0.08 * Math.sin(0.019 * k + phase)),
      0.85 + row * 0.78 + 0.12 * triangleWave(k + identity * 3, 112),
      -2.2 + row * 0.35 + 0.1 * Math.cos(0.017 * k + phase),
    );
    MATRIX_EULER.set(0.32 + 0.011 * k, 0.46 + 0.016 * k + 0.15 * row, 0.21 + 0.013 * k);
  } else {
    // 既定の数を超えた分は、手前から奥へ 10 列 × 5 段の層で空中に並べる。
    const extra = slot - ROOM_DEFAULT_COUNT;
    const column = extra % 10;
    const row = Math.floor(extra / 10) % 5;
    const layer = Math.floor(extra / 50);
    const phase = identity * 1.41421356237;
    MATRIX_POSITION.set(
      (column - 4.5) * 0.52 + 0.08 * Math.sin(0.021 * k + phase),
      0.72 + row * 0.85 + 0.1 * triangleWave(k + identity, 96),
      2.15 - layer * 1.05 + 0.08 * Math.cos(0.017 * k + phase),
    );
    MATRIX_EULER.set(0.3 + 0.011 * k, 0.5 + 0.016 * k + 0.11 * column, 0.2 + 0.013 * k);
  }
  MATRIX_ROTATION.setFromEuler(MATRIX_EULER);
  return target.compose(MATRIX_POSITION, MATRIX_ROTATION, MATRIX_SCALE);
}

// 大きい部屋の薬莢 identity の、論理フレーム frame の model 行列を target へ書いて返す。motion が偽ならフレーム 0 の
// 姿勢。床群と、奥行きの層ごとの空中群に分けて、すべてを動かす。
function casingPoolCasingMatrixAt(
  identity: number, frame: number, motion: boolean, target: THREE.Matrix4,
): THREE.Matrix4 {
  const slot = identity % CASING_CAPACITY;
  const generation = Math.floor(identity / CASING_CAPACITY);
  const k = motion ? frame : 0;
  MATRIX_SCALE.set(1, 1, 1);
  // 床群は床に寝かせて小さく揺らし、空中群は大きく揺らしながら回す。
  if (slot < POOL_FLOOR_COUNT) {
    const column = slot % POOL_FLOOR_COLUMNS;
    const row = Math.floor(slot / POOL_FLOOR_COLUMNS);
    const phase = identity * 1.17;
    MATRIX_POSITION.set(
      (column - 3.5) * 1.65 + 0.1 * Math.sin(0.018 * k + phase),
      CASING_AXIS_HEIGHT + 0.04 * (1 + Math.sin(0.024 * k + phase)),
      -1.6 - row * 1.03 + 0.08 * Math.cos(0.016 * k + phase),
    );
    MATRIX_EULER.set(0, 0.08 * Math.sin(slot * 2.17) + 0.009 * k + generation * 0.04, Math.PI / 2);
  } else {
    const air = slot - POOL_FLOOR_COUNT;
    const lane = Math.floor(air / POOL_AIR_LANE_SIZE);
    const inLane = air % POOL_AIR_LANE_SIZE;
    const column = inLane % POOL_AIR_COLUMNS;
    const row = Math.floor(inLane / POOL_AIR_COLUMNS);
    const phase = identity * 1.61803398875 + lane * 0.73;
    MATRIX_POSITION.set(
      (column - 6) * 0.85 + 0.34 * Math.sin(0.021 * k + phase),
      2.05 + row * 1.45 + 0.24 * triangleWave(k + identity * 3, 112),
      -4.35 - lane * 3.45 + 0.24 * Math.cos(0.017 * k + phase),
    );
    MATRIX_EULER.set(
      0.35 + 0.011 * k + 0.09 * row,
      0.52 + 0.016 * k + 0.13 * column,
      0.24 + 0.013 * k + generation * 0.18,
    );
  }
  MATRIX_ROTATION.setFromEuler(MATRIX_EULER);
  return target.compose(MATRIX_POSITION, MATRIX_ROTATION, MATRIX_SCALE);
}

// 大きい部屋の飛散片 identity の、論理フレーム frame の model 行列を target へ書いて返す。motion が偽ならフレーム 0 の
// 姿勢。
function debrisMatrixAt(identity: number, frame: number, motion: boolean, target: THREE.Matrix4): THREE.Matrix4 {
  const slot = identity % DEBRIS_CAPACITY;
  const generation = Math.floor(identity / DEBRIS_CAPACITY);
  // 奥行きの層ごとに 20 列 × 6 段へ並べ、それぞれを小さく揺らしながら回す。
  const column = slot % 20;
  const row = Math.floor(slot / 20) % 6;
  const layer = Math.floor(slot / 120);
  const k = motion ? frame : 0;
  const phase = identity * 1.61803398875;
  MATRIX_POSITION.set(
    -6.5 + column * (13 / 19) + 0.16 * Math.sin(0.027 * k + phase),
    0.55 + row * 1.25 + layer * 0.32 + generation * 0.08 + 0.16 * Math.sin(0.031 * k + phase),
    -14 + layer * 3.2 + 0.16 * Math.cos(0.023 * k + phase),
  );
  MATRIX_EULER.set(0.012 * k + identity * 0.13, 0.009 * k + identity * 0.17, identity * 0.11);
  MATRIX_ROTATION.setFromEuler(MATRIX_EULER);
  MATRIX_SCALE.setScalar(0.08 + (identity % 5) * 0.015);
  return target.compose(MATRIX_POSITION, MATRIX_ROTATION, MATRIX_SCALE);
}

// 論理フレーム frame のプールへ積む count 個の実体の identity(0 以上 identityCount 未満)を、push する順に返す。shuffle の
// 並びは frame と seed で決まる。
function identityOrderAt(
  frame: number, count: number, order: CasingRoomOrder, identityCount: number, seed: number,
): readonly number[] {
  const start = order === 'churn' ? (frame * Math.max(1, Math.ceil(count / 5))) % identityCount : 0;
  const identities = Array.from({ length: count }, (_, i) => (start + i) % identityCount);
  if (order !== 'shuffle') return identities;
  const random = mulberry32((frame ^ seed) >>> 0);
  for (let i = identities.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [identities[i], identities[j]] = [identities[j]!, identities[i]!];
  }
  return identities;
}

// geometry と material の所有権を持つ Mesh。
function ownedMesh(geometry: THREE.BufferGeometry, material: THREE.Material): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.userData.ownsGeometry = true;
  mesh.userData.ownsMaterial = true;
  return mesh;
}

// 小さい部屋の通常物体を id ごとに作る。形状と材質は各 Mesh が所有する。
function ordinaryObjects(): Readonly<Record<CasingRoomOrdinaryId, THREE.Mesh>> {
  // 色・粗さ・金属度を物ごとに変え、台座だけを白い面にする。
  const box = ownedMesh(
    new THREE.BoxGeometry(1, 1, 1), standard(new THREE.Vector3(0.25, 0.45, 0.9), 0.52, 0.08),
  );
  const knot = ownedMesh(
    new THREE.TorusKnotGeometry(0.48, 0.14, 192, 24), standard(new THREE.Vector3(0.9, 0.55, 0.12), 0.22, 0.72),
  );
  const sphere = ownedMesh(
    new THREE.SphereGeometry(0.5, 48, 24), standard(new THREE.Vector3(0.25, 0.8, 0.85), 0.35, 0.42),
  );
  const pedestal = ownedMesh(new THREE.BoxGeometry(1.35, 0.6, 1.35), white());
  return {
    'translating-box': box,
    'rotating-knot': knot,
    'orbiting-sphere': sphere,
    'static-pedestal': pedestal,
  };
}

// 部屋の殻と通常物体 objects(null なら殻だけ)を、光を受けて影を落とす不透明物として 1 つの Group に束ねる。
function structure(
  dimensions: CornellRoomDimensions, objects: Readonly<Record<CasingRoomOrdinaryId, THREE.Mesh>> | null,
): THREE.Group {
  const group = new THREE.Group();
  group.add(...cornellRoomShell(dimensions));
  if (objects !== null) group.add(...CASING_ROOM_ORDINARY_IDS.map((id) => objects[id]));
  markLitOpaque(group);
  markShadowCaster(group);
  return group;
}

// 薬莢のプールと、ケースの objects へ載せるその InstancedMesh(プールを組んだ一時の host から外したもの)。
function casingPool(): { readonly pool: CasingPool; readonly object: THREE.Object3D } {
  const host = new THREE.Scene();
  const pool = new CasingPool(host, CASING_CAPACITY);
  const object = host.children[0]!;
  host.remove(object);
  return { pool, object };
}

// values の name を value へ差し替えた値を返す。知らない名前、型や範囲の合わない値なら投げる。
function withCaseValue(
  caseName: string, values: CasingRoomValues, name: string, value: string | number | boolean,
): CasingRoomValues {
  // 名前ごとに、受け付ける値を検査する。
  if (name === 'casingOrder' && (value === 'stable' || value === 'shuffle' || value === 'churn')) {
    return { ...values, casingOrder: value };
  }
  if (name === 'coordinates' && (value === 'world' || value === 'floating')) {
    return { ...values, coordinates: value };
  }
  if (name === 'motion' && typeof value === 'boolean') return { ...values, motion: value };
  if (name === 'casingCount' && typeof value === 'number' && Number.isInteger(value)
    && value >= 0 && value <= CASING_CAPACITY) {
    return { ...values, casingCount: value };
  }
  if (name === 'debrisCount' && typeof value === 'number' && Number.isInteger(value)
    && value >= 0 && value <= DEBRIS_CAPACITY) {
    return { ...values, debrisCount: value };
  }
  if (name === 'motionStopFrame' && typeof value === 'number' && Number.isInteger(value) && value >= -1) {
    return { ...values, motionStopFrame: value };
  }
  throw new Error(`render-lab ${caseName}: invalid value ${name}=${String(value)}`);
}

// configuration の部屋のケース。論理フレーム(setFrame)と値の口(setValue)で、実体の姿勢・数・積み順・描画座標を
// 切り替え、実体の口(motionEntities)はそのフレームの実体をケースの世界座標で返す。
function casingCase(configuration: CasingCaseConfiguration): LabCase {
  // 既定の観察の向きのカメラ。
  const camera = labCamera();
  camera.position.copy(configuration.viewTarget).addScaledVector(
    directionFromAngles(configuration.cameraAzimuthDeg, configuration.cameraElevationDeg, new THREE.Vector3()),
    configuration.cameraDistance,
  );
  camera.lookAt(configuration.viewTarget);
  camera.updateMatrixWorld();

  // 部屋・薬莢のプール・飛散片のプール(casing-pool だけ)と、identity ごとの実体。
  const ordinary = configuration.ordinary ? ordinaryObjects() : null;
  const room = structure(configuration.dimensions, ordinary);
  const casings = casingPool();
  const debrisHost = new THREE.Scene();
  const debrisPools = configuration.name === 'casing-pool'
    ? new DebrisFragmentPools(debrisHost, DEBRIS_CAPACITY) : null;
  const debrisPoolMeshes = debrisHost.children.slice();
  debrisHost.clear();
  for (const object of debrisPoolMeshes) object.visible = false;
  const debrisObjects = Array.from({ length: DEBRIS_ID_COUNT }, () => new THREE.Object3D());
  for (const object of debrisObjects) object.matrixAutoUpdate = false;
  const debrisColors = debrisObjects.map((_, identity) => new THREE.Color(identity % 3 === 0 ? 0x69758b : 0xa8a187));
  const casingObjects = Array.from({ length: CASING_ID_COUNT }, (_, identity) => {
    const object = new THREE.Object3D();
    object.matrixAutoUpdate = false;
    const hot = identity % configuration.hotStride === 0;
    syncThermalState(object, hot ? configuration.hotTemperature : 0, 0, hot ? configuration.hotEmissivity : 0);
    return object;
  });

  // 値と論理フレーム、プールを最後に積んだときの描画座標の原点。
  let values: CasingRoomValues = {
    casingOrder: 'stable', coordinates: 'world', motion: true, casingCount: configuration.defaultCount,
    debrisCount: 0,
    motionStopFrame: -1,
  };
  let frame = 0;
  let poolDirty = true;
  const lastPoolOrigin = new THREE.Vector3(Number.NaN, Number.NaN, Number.NaN);
  const worldMatrix = new THREE.Matrix4();
  const poolOrigin = new THREE.Vector3();
  // 論理フレーム k で物を置く姿勢の番号。止めるフレームより後は止めたフレームの姿勢。
  const motionFrameAt = (k: number): number => (values.motionStopFrame < 0 ? k : Math.min(k, values.motionStopFrame));

  // 通常物体をいまの論理フレームの姿勢へ置き、プールを次に積み直させる。
  const applyFrame = (): void => {
    if (ordinary !== null) {
      for (const id of CASING_ROOM_ORDINARY_IDS) {
        casingRoomOrdinaryMatrixAt(id, motionFrameAt(frame), values.motion, ordinary[id].matrix);
        ordinary[id].matrixAutoUpdate = false;
      }
    }
    poolDirty = true;
  };
  applyFrame();

  // 描画座標の原点 poolOrigin を値の描画座標に合わせて置く。floating ならいまのカメラの位置。
  const placePoolOrigin = (): void => {
    if (values.coordinates === 'floating') poolOrigin.copy(camera.position);
    else poolOrigin.set(0, 0, 0);
  };

  // いまの論理フレームの薬莢と飛散片を、描画座標の原点 poolOrigin から見た行列でプールへ積み直す。
  const rebuildPool = (): void => {
    REBASE_MATRIX.makeTranslation(-poolOrigin.x, -poolOrigin.y, -poolOrigin.z);
    // 薬莢。
    casings.pool.beginFrame();
    const casingOrder = identityOrderAt(
      frame, values.casingCount, values.casingOrder, CASING_ID_COUNT, CASING_SHUFFLE_SEED,
    );
    for (const identity of casingOrder) {
      const object = casingObjects[identity]!;
      configuration.casingMatrixAt(identity, motionFrameAt(frame), values.motion, worldMatrix);
      object.matrix.multiplyMatrices(REBASE_MATRIX, worldMatrix);
      object.matrixWorld.copy(object.matrix);
      casings.pool.push(object);
    }
    casings.pool.endFrame();

    // 飛散片。1 つも積まないフレームでは形ごとのプールを隠す。
    if (debrisPools !== null) {
      debrisPools.beginFrame();
      const debrisOrder = identityOrderAt(
        frame, values.debrisCount, values.casingOrder, DEBRIS_ID_COUNT, DEBRIS_SHUFFLE_SEED,
      );
      for (const identity of debrisOrder) {
        const object = debrisObjects[identity]!;
        debrisMatrixAt(identity, motionFrameAt(frame), values.motion, worldMatrix);
        object.matrix.multiplyMatrices(REBASE_MATRIX, worldMatrix);
        object.matrixWorld.copy(object.matrix);
        debrisPools.push(identity % DEBRIS_VARIANT_COUNT, object, debrisColors[identity]!);
      }
      debrisPools.endFrame();
      for (const object of debrisPoolMeshes) object.visible = values.debrisCount > 0;
    }
    lastPoolOrigin.copy(poolOrigin);
    poolDirty = false;
  };

  return {
    objects: [room, casings.object, ...debrisPoolMeshes],
    camera,
    viewTarget: configuration.viewTarget,
    sunDirection: directionFromAngles(configuration.sunAzimuthDeg, configuration.sunElevationDeg, new THREE.Vector3()),
    earth: OVERHEAD_EARTH,
    setFrame: (nextFrame) => {
      if (!Number.isInteger(nextFrame) || nextFrame < 0) {
        throw new Error(`render-lab ${configuration.name}: invalid frame ${nextFrame}`);
      }
      frame = nextFrame;
      applyFrame();
    },
    setValue: (name, value) => {
      values = withCaseValue(configuration.name, values, name, value);
      applyFrame();
    },
    motionEntities: (entityFrame): readonly LabMotionEntity[] => {
      // 部屋の殻と通常物体。
      const entities: LabMotionEntity[] = room.children.map((child, index) => {
        const ordinaryId = CASING_ROOM_ORDINARY_IDS.find((id) => ordinary?.[id] === child);
        return {
          key: ordinaryId === undefined ? `room:${index}` : `ordinary:${ordinaryId}`,
          kind: ordinaryId === undefined ? 'room' : 'ordinary',
          geometry: (child as THREE.Mesh).geometry,
          matrix: ordinaryId === undefined
            ? new THREE.Matrix4().compose(child.position, child.quaternion, child.scale)
            : casingRoomOrdinaryMatrixAt(
              ordinaryId, motionFrameAt(entityFrame), values.motion, new THREE.Matrix4(),
            ),
          slot: null,
        };
      });
      // プールの実体。slot はプールへ push した順の番号で、飛散片は形ごとのプールで数える。
      const order = identityOrderAt(
        entityFrame, values.casingCount, values.casingOrder, CASING_ID_COUNT, CASING_SHUFFLE_SEED,
      );
      for (const [slot, identity] of order.entries()) {
        entities.push({
          key: `casing:${identity}`,
          kind: 'pool',
          geometry: (casings.object as THREE.InstancedMesh).geometry,
          matrix: configuration.casingMatrixAt(
            identity, motionFrameAt(entityFrame), values.motion, new THREE.Matrix4(),
          ),
          slot,
          poolId: 'casings',
        });
      }
      if (debrisPools !== null) {
        const slots = Array(DEBRIS_VARIANT_COUNT).fill(0) as number[];
        const debrisOrder = identityOrderAt(
          entityFrame, values.debrisCount, values.casingOrder, DEBRIS_ID_COUNT, DEBRIS_SHUFFLE_SEED,
        );
        for (const identity of debrisOrder) {
          const variant = identity % DEBRIS_VARIANT_COUNT;
          entities.push({
            key: `debris:${identity}`,
            kind: 'pool',
            geometry: (debrisPoolMeshes[variant] as THREE.InstancedMesh).geometry,
            matrix: debrisMatrixAt(identity, motionFrameAt(entityFrame), values.motion, new THREE.Matrix4()),
            slot: slots[variant]!,
            poolId: `debris:${variant}`,
          });
          slots[variant] = slots[variant]! + 1;
        }
      }
      return entities;
    },
    renderOrigin: () => poolOrigin.clone(),
    // 部屋を描画座標へ置き、フレームか原点が変わっていればプールを積み直す。floating ではカメラを原点へ移す。
    sync: () => {
      placePoolOrigin();
      room.position.copy(poolOrigin).multiplyScalar(-1);
      if (poolDirty || !lastPoolOrigin.equals(poolOrigin)) rebuildPool();
      if (values.coordinates === 'floating') {
        camera.position.set(0, 0, 0);
        camera.updateMatrixWorld(true);
      }
    },
    dispose: () => {
      casings.pool.dispose();
      debrisPools?.dispose();
    },
    // 論理フレーム 0 から iterations 個のフレームでプールを積み直し、1 回ごとの CPU 時間 [ms] を測る。論理フレームは
    // 最後に積んだフレームのまま残る。
    measurePoolRebuild: (iterations) => {
      const poolRebuildMs: number[] = [];
      for (let sample = 0; sample < iterations; sample++) {
        frame = sample;
        applyFrame();
        placePoolOrigin();
        const rebuildStarted = performance.now();
        rebuildPool();
        poolRebuildMs.push(performance.now() - rebuildStarted);
      }
      return { poolRebuildMs, previousMatricesMs: [] };
    },
    shots: configuration.shots,
  };
}

// 通常物体と既定 20 個の薬莢を置く小さい部屋。
function casingRoom(): LabCase {
  return casingCase({
    name: 'casing-room', dimensions: ROOM_DIMENSIONS, defaultCount: ROOM_DEFAULT_COUNT, hotStride: 19,
    hotTemperature: 1350, hotEmissivity: 0.4,
    viewTarget: ROOM_VIEW_TARGET, cameraAzimuthDeg: 23, cameraElevationDeg: 36, cameraDistance: 5.8,
    sunAzimuthDeg: -38, sunElevationDeg: 42, ordinary: true, casingMatrixAt: casingRoomCasingMatrixAt,
    // 部屋の全体と、通常物体へ寄せた向き。
    shots: {
      'casing-room': { view: {}, graphics: ROOM_GRAPHICS },
      'casing-room-objects': {
        view: { cameraAzimuthDeg: 10, cameraElevationDeg: 45, cameraZoomLog: Math.log10(0.95) },
        graphics: ROOM_GRAPHICS,
      },
    },
  });
}

// 既定で薬莢を上限まで積み、値の口で飛散片も積める大きい部屋。
function casingPoolRoom(): LabCase {
  return casingCase({
    name: 'casing-pool', dimensions: POOL_DIMENSIONS, defaultCount: CASING_CAPACITY, hotStride: 23,
    hotTemperature: 1530, hotEmissivity: 0.78,
    viewTarget: POOL_VIEW_TARGET, cameraAzimuthDeg: 8, cameraElevationDeg: 17, cameraDistance: 19,
    sunAzimuthDeg: -38, sunElevationDeg: 42, ordinary: false, casingMatrixAt: casingPoolCasingMatrixAt,
    shots: { 'casing-pool': { view: {}, graphics: POOL_GRAPHICS } },
  });
}

export const CASING_ROOM_CASES = {
  'casing-room': casingRoom,
  'casing-pool': casingPoolRoom,
} as const satisfies Record<string, CaseBuilder>;
