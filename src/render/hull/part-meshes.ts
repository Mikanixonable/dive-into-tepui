// 外装の搭載要素の見た目。取り付け位置と向きは呼び出し側が与え、ここは形だけを作る。
//
// 放熱板と太陽電池パドルは蛇腹の折り目 Group を入れ子にして返す。折り目の名前は
// radiator.ts / power.ts が getObjectByName で引くものであり、毎フレームの rotation.y だけで
// 蛇腹の伸縮を表せるようにするための構造である。
import * as THREE from 'three/webgpu';
import { RADIATOR_SEGMENT_LENGTH, radiatorFoldName, solarFoldName } from '../ships';

export type PanelSide = 'up' | 'down';

// 蛇腹の折り数。radiator.ts / power.ts が同じ数の折り目を探す。
const RADIATOR_FOLD_COUNT = 6;
const SOLAR_FOLD_COUNT = 6;

const RADIATOR_WIDTH = 2.3 / 4;
const SOLAR_SEGMENT_LENGTH = 2.4 / SOLAR_FOLD_COUNT;
const SOLAR_WIDTH = 1.5;
// 収納時に折り目同士が同一平面へ重なるときの Z ファイティングを避ける段差 [m]。
const STACK_NUDGE = 0.012;

function standard(color: number, metalness: number, roughness: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, metalness, roughness });
}

function owned(mesh: THREE.Mesh): THREE.Mesh {
  mesh.userData['ownsGeometry'] = true;
  mesh.userData['ownsMaterial'] = true;
  return mesh;
}

// 折り目 Group を入れ子にした蛇腹。1折りぶんの中身は build が作る。
function foldChain(
  hingeName: string,
  foldName: (index: number) => string,
  count: number,
  segment: number,
  sign: 1 | -1,
  build: (fold: THREE.Group, index: number) => void,
): THREE.Group {
  const hinge = new THREE.Group();
  hinge.name = hingeName;
  let parent: THREE.Group = hinge;
  for (let i = 0; i < count; i++) {
    const fold = new THREE.Group();
    fold.name = foldName(i);
    if (i > 0) fold.position.set(sign * segment, 0, 0);
    parent.add(fold);
    build(fold, i);
    parent = fold;
  }
  return hinge;
}

// 放熱板。展開方向はローカル +X(up)/-X(down)、放熱面の法線はローカル Z。
export function buildRadiatorPanel(side: PanelSide): THREE.Group {
  const sign = side === 'up' ? 1 : -1;
  const panelMat = standard(0xdde3ea, 0.15, 0.8);
  const rodMat = standard(0x3a4048, 0.5, 0.55);
  return foldChain(
    `radiator${side === 'up' ? 'Up' : 'Down'}`,
    (i) => radiatorFoldName(side, i),
    RADIATOR_FOLD_COUNT,
    RADIATOR_SEGMENT_LENGTH,
    sign,
    (fold, i) => {
      const panel = owned(new THREE.Mesh(
        new THREE.BoxGeometry(RADIATOR_SEGMENT_LENGTH, RADIATOR_WIDTH, 0.04), panelMat,
      ));
      panel.position.set((sign * RADIATOR_SEGMENT_LENGTH) / 2, 0, i * STACK_NUDGE);
      fold.add(panel);
      // 骨格は放熱面と逆位相へ張り出し、折り畳んだときに面同士が直に触れないようにする。
      const skeletonZ = (i % 2 === 0 ? 1 : -1) * 0.04;
      for (const wy of [-1, 1]) {
        const rod = owned(new THREE.Mesh(new THREE.BoxGeometry(RADIATOR_SEGMENT_LENGTH, 0.08, 0.08), rodMat));
        rod.position.set((sign * RADIATOR_SEGMENT_LENGTH) / 2, wy * (RADIATOR_WIDTH / 2 - 0.04), skeletonZ);
        fold.add(rod);
      }
    },
  );
}

// 太陽電池パドル。展開方向はローカル +X(up)/-X(down)、受光面の法線はローカル Y。
export function buildSolarPanel(side: PanelSide): THREE.Group {
  const sign = side === 'up' ? 1 : -1;
  const cellMat = standard(0x1a3a8c, 0.38, 0.52);
  const frameMat = standard(0x7a838f, 0.68, 0.33);
  return foldChain(
    `solar${side === 'up' ? 'Up' : 'Down'}`,
    (i) => solarFoldName(side, i),
    SOLAR_FOLD_COUNT,
    SOLAR_SEGMENT_LENGTH,
    sign,
    (fold, i) => {
      const panel = owned(new THREE.Mesh(
        new THREE.BoxGeometry(SOLAR_SEGMENT_LENGTH, 0.02, SOLAR_WIDTH - 0.1), cellMat,
      ));
      panel.position.set((sign * SOLAR_SEGMENT_LENGTH) / 2, 0, i * STACK_NUDGE);
      fold.add(panel);
      for (const fz of [-SOLAR_WIDTH / 2 + 0.05, SOLAR_WIDTH / 2 - 0.05]) {
        const bar = owned(new THREE.Mesh(new THREE.BoxGeometry(SOLAR_SEGMENT_LENGTH, 0.04, 0.1), frameMat));
        bar.position.set((sign * SOLAR_SEGMENT_LENGTH) / 2, 0, i * STACK_NUDGE + fz);
        fold.add(bar);
      }
    },
  );
}

// 取り付け位置に置く外装要素の造形。座標系は取り付け位置のもの(+Z が外向き)で、
// 要素の代表寸法 size [m] に対して作る。
export type FittingShape = 'nozzle' | 'barrel' | 'thruster' | 'dish' | 'shield' | 'block';

export function buildFitting(shape: FittingShape, size: number): THREE.Mesh {
  const metal = standard(0x9aa3ad, 0.6, 0.35);
  switch (shape) {
    case 'nozzle': {
      // ノズルは全長ぶん外向きへ突き出す(§F12)。
      const mesh = owned(new THREE.Mesh(new THREE.CylinderGeometry(size * 0.28, size * 0.5, size, 16, 1, true), metal));
      mesh.rotation.x = Math.PI / 2;
      mesh.position.z = size / 2;
      return mesh;
    }
    case 'barrel': {
      const mesh = owned(new THREE.Mesh(new THREE.CylinderGeometry(size * 0.15, size * 0.15, size, 10), metal));
      mesh.rotation.x = Math.PI / 2;
      mesh.position.z = size / 2;
      return mesh;
    }
    case 'thruster': {
      const mesh = owned(new THREE.Mesh(new THREE.ConeGeometry(size * 0.5, size, 8, 1, true), metal));
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.z = size / 2;
      return mesh;
    }
    case 'dish': {
      const mesh = owned(new THREE.Mesh(new THREE.SphereGeometry(size, 12, 8, 0, Math.PI * 2, 0, Math.PI / 3), metal));
      mesh.rotation.x = -Math.PI / 2;
      return mesh;
    }
    case 'shield': {
      const mesh = owned(new THREE.Mesh(new THREE.ConeGeometry(size, size * 0.35, 16), standard(0x4a3b32, 0.1, 0.9)));
      mesh.rotation.x = Math.PI / 2;
      mesh.position.z = size * 0.175;
      return mesh;
    }
    case 'block':
    default: {
      const mesh = owned(new THREE.Mesh(new THREE.BoxGeometry(size, size, size * 0.6), metal));
      mesh.position.z = size * 0.3;
      return mesh;
    }
  }
}
