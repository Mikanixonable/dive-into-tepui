// 模式図スタイルで、環・太陽など world パスで自己完結する物体の輪郭を線1本の円として描く
// 下請け。単位円(半径1)のジオメトリを全利用者で共有し、利用者ごとの姿勢は Object3D 側へ持つ。
import * as THREE from 'three/webgpu';
import { markOverlay } from './pipeline/lit-layer';
import { OUTLINE_CIRCLE_COLOR } from './schematic-style';

const SEGMENTS = 128;

let sharedGeometry: THREE.BufferGeometry | null = null;

// 半径1・XY平面上の単位円ジオメトリを遅延生成して使い回す。
function getSharedGeometry(): THREE.BufferGeometry {
  if (sharedGeometry !== null) return sharedGeometry;
  // 頂点座標を刻んで単位円を1周ぶん作る。
  const positions = new Float32Array((SEGMENTS + 1) * 3);
  for (let i = 0; i <= SEGMENTS; i++) {
    const a = (i / SEGMENTS) * Math.PI * 2;
    positions[i * 3] = Math.cos(a);
    positions[i * 3 + 1] = Math.sin(a);
    positions[i * 3 + 2] = 0;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  sharedGeometry = geo;
  return geo;
}

export type OutlineCircle = {
  readonly line: THREE.Line;
  // 自前の material だけを解放する。geometry は全利用者で共有しているため解放しない。
  readonly dispose: () => void;
};

// 単位円の輪郭線を1つ作る。呼び出し側は scale/position/quaternion で半径・位置・向きを与える。
export function createOutlineCircle(): OutlineCircle {
  const material = new THREE.LineBasicMaterial({ color: OUTLINE_CIRCLE_COLOR });
  const line = new THREE.Line(getSharedGeometry(), material);
  markOverlay(line);
  return { line, dispose: () => material.dispose() };
}
