// 給弾ベルトのリンク配置を本番 BeltView へ渡し、継手とケーブルの近接表示を組む。
import * as THREE from 'three/webgpu';
import { MAG_BELT_PITCH } from '../../src/physics/player-shape';
import { v3 } from '../../src/math/vec3';
import { BeltView, type BeltNodes } from '../../src/render/dynamic/player/belt-view';
import { labCamera, type CaseBuilder, type LabCase } from './lab-case';

const LINK_COUNT = 5;
const BELT_ANCHOR = v3(-LINK_COUNT * MAG_BELT_PITCH / 2, 0, 0);

// displayTime に応じた二方向のカーブをリンク節点へ与える。
function beltNodes(displayTime: number): BeltNodes {
  const amplitude = displayTime < 0.5 ? 0.55 : 1.05;
  const positions = Array.from({ length: LINK_COUNT }, (_, i) => {
    const fraction = (i + 1) / LINK_COUNT;
    return v3(
      BELT_ANCHOR.x + (i + 1) * MAG_BELT_PITCH,
      amplitude * Math.sin(fraction * Math.PI * 1.5),
      amplitude * 0.55 * Math.sin(fraction * Math.PI * 2),
    );
  });
  return { anchor: BELT_ANCHOR, positions, twists: positions.map(() => 0) };
}

// 本番 BeltView を近距離で撮り、箱の窓と節間の可動造形を見比べる。
function beltC2(): LabCase {
  const root = new THREE.Group();
  const belt = new BeltView(root, LINK_COUNT);
  const camera = labCamera();
  camera.position.set(0, 3, 10);
  camera.fov = 40;
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  const syncMotion = (displayTime: number): void => belt.sync(LINK_COUNT, beltNodes(displayTime));
  syncMotion(0);

  return {
    objects: [root],
    camera,
    viewTarget: new THREE.Vector3(0, 0, 0),
    syncMotion,
    shots: {
      'belt-c2': {
        view: { cameraAzimuthDeg: 0, cameraElevationDeg: 16, sunAzimuthDeg: 0, sunElevationDeg: 20 },
        displayTime: 0,
      },
      'belt-c2-articulation': {
        view: { cameraAzimuthDeg: 18, cameraElevationDeg: 27, cameraDistanceLog: 0.04,
          sunAzimuthDeg: 0, sunElevationDeg: 20 },
        displayTime: 1,
      },
    },
  };
}

export const BELT_CASES = { 'belt-c2': beltC2 } as const satisfies Record<string, CaseBuilder>;
