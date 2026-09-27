// Render Lab の組み立て型の敵ケース。枝分かれ型と結び目型の個体を異なる seed で並べ、
// 部品を失った個体も出す。
import * as THREE from 'three/webgpu';
import { generateAssemblyShape } from '../../src/render/assembly/assembly-shape';
import { FloatingOrigin } from '../../src/render/camera/floating-origin';
import {
  AssemblyEnemyView, type AssemblyVisualSource,
} from '../../src/render/dynamic/dynamic-entity/assembly-enemy-view';
import { InstancedPools } from '../../src/render/dynamic/instanced-pools';
import { DEFAULT_PROTEIN_DISPLAY } from '../../src/render/protein/protein-display';
import { SunLight } from '../../src/render/pipeline/sun-light';
import { BodyShadow } from '../../src/render/pipeline/shadow/body-shadow';
import { kinematicState } from '../../src/physics/kinematic-state';
import { qFromAxisAngle } from '../../src/math/quat';
import { norm, v3 } from '../../src/math/vec3';
import {
  FOV_DEG, labCamera, VIEW_HEIGHT, VIEW_WIDTH, type CaseBuilder, type LabCase,
} from './lab-case';
import type { DynamicViewFrame } from '../../src/render/dynamic/dynamic-view';
import type { Quat } from '../../src/math/quat';
import type { Vec3 } from '../../src/math/vec3';

// DynamicView.sync を通すための最小のフレーム。ケースの描画はケースのカメラが担うので、
// 同期が読まない項目は埋めるだけでよい。
function staticFrame(): DynamicViewFrame {
  const sunLight = new SunLight();
  return {
    displayTime: 0,
    camera: {
      camera: new THREE.PerspectiveCamera(),
      position: v3(),
      viewpoint: {
        position: v3(), lookTarget: v3(0, 0, -1), up: v3(0, 1, 0),
        fovDeg: FOV_DEG, aspect: VIEW_WIDTH / VIEW_HEIGHT,
      },
      viewport: { width: VIEW_WIDTH, height: VIEW_HEIGHT, pixelRatio: 1 },
      zoomed: false,
      floatingOrigin: new FloatingOrigin(v3(), v3()),
      project: () => ({ x: 0, y: 0, front: true }),
      scale: () => 1,
      radialScale: () => 1,
    },
    style: 'realistic',
    visual: { proteinVibration: false, thrustPlume: 'simple' },
    proteinDisplay: DEFAULT_PROTEIN_DISPLAY,
    sunLight,
    bodyShadow: new BodyShadow(sunLight),
    pools: new InstancedPools([]),
  };
}

// seed の個体を位置 position・姿勢 attitude で同期して返す。lostParts の番号の部品は失わせる。
function enemyAt(
  seed: number, accent: string | number, position: Vec3, attitude: Quat,
  lostParts: readonly number[] = [],
): AssemblyEnemyView {
  const shape = generateAssemblyShape(seed);
  const view = new AssemblyEnemyView(shape, accent);
  const source: AssemblyVisualSource = {
    id: `assembly-${seed}`,
    name: `assembly-${seed}`,
    alive: true,
    stateAt: (t) => kinematicState<'eci'>(t, position, v3()),
    attitude,
    thermal: null,
    aliveParts: shape.parts.map((_, i) => !lostParts.includes(i)),
  };
  view.sync(source, staticFrame());
  return view;
}

// 枝分かれ型(seed 4・16)と結び目型(seed 8・19)の個体を並べる。seed 8 を注視点の正面へ置き、
// seed 4 の個体は構造部と発射部を失った姿で出す。
function assemblyEnemies(): LabCase {
  const enemies = [
    enemyAt(8, 0x4f8fd0, v3(0, 5, -290), qFromAxisAngle(norm(v3(1, 0.3, -0.2)), 2.1)),
    enemyAt(16, 0x59c3a5, v3(-120, 35, -300), qFromAxisAngle(norm(v3(0.2, 1, 0.1)), 0.7)),
    enemyAt(19, 0xd85c4a, v3(115, -60, -300), qFromAxisAngle(norm(v3(0.5, -0.2, 1)), 2.8)),
    enemyAt(4, 0xd8c24a, v3(-75, -80, -300), qFromAxisAngle(norm(v3(-0.4, 0.8, 1)), 1.2), [1, 4]),
  ];
  return {
    objects: enemies.map((enemy) => enemy.object),
    camera: labCamera(),
    viewTarget: new THREE.Vector3(0, -20, -295),
    shots: {
      'assembly-enemy': { view: {} },
      // 結び目の個体へ寄る。管の継ぎ目と半球の端、プラスチックの照りを読む。
      'assembly-enemy-knot': { view: { cameraDistanceLog: -0.33 } },
    },
  };
}

export const ASSEMBLY_CASES = {
  'assembly-enemy': assemblyEnemies,
} as const satisfies Record<string, CaseBuilder>;
