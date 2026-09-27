// 排出薬莢をゲーム本体と同じ表示部品・インスタンス描画で観察するケース。
import * as THREE from 'three/webgpu';
import { CasingPool, CasingView } from '../../src/render/dynamic/dynamic-entity/casing-view';
import { labCamera, type CaseBuilder, type LabCase } from './lab-case';

function ejectedCasing(): LabCase {
  const poolScene = new THREE.Scene();
  const pool = new CasingPool(poolScene, 1);
  const casing = new CasingView();
  casing.object.rotation.set(-0.24, 0.35, 0.14);
  casing.object.updateMatrixWorld(true);
  pool.beginFrame();
  pool.push(casing.object);
  pool.endFrame();

  const camera = labCamera();
  camera.position.set(3, 2.2, 5.5);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);

  return {
    objects: [poolScene.children[0]!],
    camera,
    viewTarget: new THREE.Vector3(),
    shots: {
      'casing-ejected-color': {
        view: {
          cameraAzimuthDeg: 28,
          cameraElevationDeg: 12,
          cameraDistanceLog: -0.35,
          sunAzimuthDeg: 55,
          sunElevationDeg: 35,
        },
      },
    },
    dispose: () => pool.dispose(),
  };
}

export const CASING_CASES = {
  'ejected-casing': ejectedCasing,
} as const satisfies Record<string, CaseBuilder>;
