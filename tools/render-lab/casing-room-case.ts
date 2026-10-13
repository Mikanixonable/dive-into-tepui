// 通常物体を読む小さな部屋と、上限まで薬莢を積む大きな部屋。どちらも同じ CasingPool と論理フレームの
// 仕組みを使い、描く回数に依らず実体の姿勢と積み順を再現する。
import * as THREE from 'three/webgpu';
import { ENTITY_CAP } from '../../src/game/dynamic/dynamic-entity/entity-kind';
import { mulberry32 } from '../../src/math/random';
import { CasingPool } from '../../src/render/dynamic/dynamic-entity/casing-view';
import { markLitOpaque, markShadowCaster } from '../../src/render/pipeline/lit-layer';
import { syncThermalState } from '../../src/render/thermal-emissive';
import { directionFromAngles } from './view-angles';
import {
  cornellRoomShell, labCamera, OVERHEAD_EARTH, standard, white, type CaseBuilder,
  type CornellRoomDimensions, type LabCase, type LabMotionEntity, type LabShot,
} from './lab-case';
import type { GraphicsSettingsData } from '../../src/render/graphics-settings';

export type CasingRoomOrder = 'stable' | 'shuffle' | 'churn';
export type CasingRoomCoordinates = 'world' | 'floating';
export type CasingRoomOrdinaryId = 'translating-box' | 'rotating-knot' | 'orbiting-sphere' | 'static-pedestal';

export interface CasingRoomValues {
  readonly casingOrder: CasingRoomOrder;
  readonly coordinates: CasingRoomCoordinates;
  readonly motion: boolean;
  readonly casingCount: number;
}

export const CASING_ROOM_ORDINARY_IDS: readonly CasingRoomOrdinaryId[] = [
  'translating-box', 'rotating-knot', 'orbiting-sphere', 'static-pedestal',
];

const CASING_CAPACITY = ENTITY_CAP.casing;
const CASING_ID_COUNT = 2 * CASING_CAPACITY;
const CASING_AXIS_HEIGHT = 0.231;
const ROOM_DEFAULT_COUNT = 20;
const ROOM_FLOOR_COUNT = 10;
const POOL_FLOOR_COUNT = 104;
const POOL_FLOOR_COLUMNS = 8;
const POOL_AIR_COLUMNS = 13;
const POOL_AIR_ROWS = 4;
const POOL_AIR_LANE_SIZE = POOL_AIR_COLUMNS * POOL_AIR_ROWS;

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

const MATRIX_POSITION = new THREE.Vector3();
const MATRIX_ROTATION = new THREE.Quaternion();
const MATRIX_SCALE = new THREE.Vector3(1, 1, 1);
const MATRIX_EULER = new THREE.Euler();
const REBASE_MATRIX = new THREE.Matrix4();
const ORBIT_OFFSET = new THREE.Vector3();

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

// 論理フレームで動く通常物体 id の、小さい部屋の座標での model 行列を target へ書く。
export function casingRoomOrdinaryMatrixAt(
  id: CasingRoomOrdinaryId, frame: number, motion: boolean, target: THREE.Matrix4,
): THREE.Matrix4 {
  const k = motion ? frame : 0;
  MATRIX_SCALE.set(1, 1, 1);
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

// 小さい部屋の薬莢。既定の20個は通常物体の移動範囲を囲む床と左右の壁際へ分ける。
export function casingRoomCasingMatrixAt(
  identity: number, frame: number, motion: boolean, target: THREE.Matrix4,
): THREE.Matrix4 {
  const slot = identity % CASING_CAPACITY;
  const generation = Math.floor(identity / CASING_CAPACITY);
  const k = motion ? frame : 0;
  MATRIX_SCALE.set(1, 1, 1);
  if (slot < ROOM_FLOOR_COUNT) {
    const side = slot % 2 === 0 ? -1 : 1;
    const along = Math.floor(slot / 2);
    MATRIX_POSITION.set(side * 2.55, CASING_AXIS_HEIGHT, -2.35 + along * 0.65);
    MATRIX_EULER.set(0, 0.12 * Math.sin(slot * 1.9) + generation * 0.04, Math.PI / 2);
  } else if (slot < ROOM_DEFAULT_COUNT) {
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

// 大量薬莢の部屋。104個の床群と、奥行き3本 × 52個の空中群をすべて動かす。
export function casingPoolCasingMatrixAt(
  identity: number, frame: number, motion: boolean, target: THREE.Matrix4,
): THREE.Matrix4 {
  const slot = identity % CASING_CAPACITY;
  const generation = Math.floor(identity / CASING_CAPACITY);
  const k = motion ? frame : 0;
  MATRIX_SCALE.set(1, 1, 1);
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

// frame のプールへ積む実体の identity を、実際に push する順に返す。
export function casingRoomCasingOrderAt(
  frame: number, count: number, order: CasingRoomOrder,
): readonly number[] {
  const start = order === 'churn' ? (frame * Math.max(1, Math.ceil(count / 5))) % CASING_ID_COUNT : 0;
  const identities = Array.from({ length: count }, (_, i) => (start + i) % CASING_ID_COUNT);
  if (order !== 'shuffle') return identities;
  const random = mulberry32((frame ^ 0x9e3779b9) >>> 0);
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

function ordinaryObjects(): Readonly<Record<CasingRoomOrdinaryId, THREE.Mesh>> {
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

// CasingPool の共有資源を所有せず、プールの InstancedMesh だけを一時 host から外す。
function casingPool(): { readonly pool: CasingPool; readonly object: THREE.Object3D } {
  const host = new THREE.Scene();
  const pool = new CasingPool(host, CASING_CAPACITY);
  const object = host.children[0]!;
  host.remove(object);
  return { pool, object };
}

function withCaseValue(
  caseName: string, values: CasingRoomValues, name: string, value: string | number | boolean,
): CasingRoomValues {
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
  throw new Error(`render-lab ${caseName}: invalid value ${name}=${String(value)}`);
}

function casingCase(configuration: CasingCaseConfiguration): LabCase {
  const camera = labCamera();
  camera.position.copy(configuration.viewTarget).addScaledVector(
    directionFromAngles(configuration.cameraAzimuthDeg, configuration.cameraElevationDeg, new THREE.Vector3()),
    configuration.cameraDistance,
  );
  camera.lookAt(configuration.viewTarget);
  camera.updateMatrixWorld();

  const ordinary = configuration.ordinary ? ordinaryObjects() : null;
  const room = structure(configuration.dimensions, ordinary);
  const casings = casingPool();
  const casingObjects = Array.from({ length: CASING_ID_COUNT }, (_, identity) => {
    const object = new THREE.Object3D();
    object.matrixAutoUpdate = false;
    const hot = identity % configuration.hotStride === 0;
    syncThermalState(object, hot ? configuration.hotTemperature : 0, 0, hot ? configuration.hotEmissivity : 0);
    return object;
  });
  let values: CasingRoomValues = {
    casingOrder: 'stable', coordinates: 'world', motion: true, casingCount: configuration.defaultCount,
  };
  let frame = 0;
  let poolDirty = true;
  const lastPoolOrigin = new THREE.Vector3(Number.NaN, Number.NaN, Number.NaN);
  const worldMatrix = new THREE.Matrix4();
  const poolOrigin = new THREE.Vector3();

  const applyFrame = (): void => {
    if (ordinary !== null) {
      for (const id of CASING_ROOM_ORDINARY_IDS) {
        casingRoomOrdinaryMatrixAt(id, frame, values.motion, ordinary[id].matrix);
        ordinary[id].matrixAutoUpdate = false;
      }
    }
    poolDirty = true;
  };
  applyFrame();

  const rebuildPool = (): void => {
    REBASE_MATRIX.makeTranslation(-poolOrigin.x, -poolOrigin.y, -poolOrigin.z);
    casings.pool.beginFrame();
    for (const identity of casingRoomCasingOrderAt(frame, values.casingCount, values.casingOrder)) {
      const object = casingObjects[identity]!;
      configuration.casingMatrixAt(identity, frame, values.motion, worldMatrix);
      object.matrix.multiplyMatrices(REBASE_MATRIX, worldMatrix);
      object.matrixWorld.copy(object.matrix);
      casings.pool.push(object);
    }
    casings.pool.endFrame();
    lastPoolOrigin.copy(poolOrigin);
    poolDirty = false;
  };

  return {
    objects: [room, casings.object],
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
      const entities: LabMotionEntity[] = room.children.map((child, index) => {
        const ordinaryId = CASING_ROOM_ORDINARY_IDS.find((id) => ordinary?.[id] === child);
        return {
          key: ordinaryId === undefined ? `room:${index}` : `ordinary:${ordinaryId}`,
          kind: ordinaryId === undefined ? 'room' : 'ordinary',
          geometry: (child as THREE.Mesh).geometry,
          matrix: ordinaryId === undefined
            ? new THREE.Matrix4().compose(child.position, child.quaternion, child.scale)
            : casingRoomOrdinaryMatrixAt(ordinaryId, entityFrame, values.motion, new THREE.Matrix4()),
          slot: null,
        };
      });
      const order = casingRoomCasingOrderAt(entityFrame, values.casingCount, values.casingOrder);
      for (const [slot, identity] of order.entries()) {
        entities.push({
          key: `casing:${identity}`,
          kind: 'pool',
          geometry: (casings.object as THREE.InstancedMesh).geometry,
          matrix: configuration.casingMatrixAt(identity, entityFrame, values.motion, new THREE.Matrix4()),
          slot,
        });
      }
      return entities;
    },
    renderOrigin: () => poolOrigin.clone(),
    sync: () => {
      if (values.coordinates === 'floating') poolOrigin.copy(camera.position);
      else poolOrigin.set(0, 0, 0);
      room.position.copy(poolOrigin).multiplyScalar(-1);
      if (poolDirty || !lastPoolOrigin.equals(poolOrigin)) rebuildPool();
      if (values.coordinates === 'floating') {
        camera.position.set(0, 0, 0);
        camera.updateMatrixWorld(true);
      }
    },
    dispose: () => casings.pool.dispose(),
    shots: configuration.shots,
  };
}

function casingRoom(): LabCase {
  return casingCase({
    name: 'casing-room', dimensions: ROOM_DIMENSIONS, defaultCount: ROOM_DEFAULT_COUNT, hotStride: 19,
    hotTemperature: 1350, hotEmissivity: 0.4,
    viewTarget: ROOM_VIEW_TARGET, cameraAzimuthDeg: 23, cameraElevationDeg: 36, cameraDistance: 5.8,
    sunAzimuthDeg: -38, sunElevationDeg: 42, ordinary: true, casingMatrixAt: casingRoomCasingMatrixAt,
    shots: {
      'casing-room': { view: {}, graphics: ROOM_GRAPHICS },
      'casing-room-objects': {
        view: { cameraAzimuthDeg: 10, cameraElevationDeg: 45, cameraZoomLog: Math.log10(0.95) },
        graphics: ROOM_GRAPHICS,
      },
    },
  });
}

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
