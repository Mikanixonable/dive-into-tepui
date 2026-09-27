// 太陽電池とラジエーターのパネル姿勢を、取付ヒンジを基準に計算する。
// 太陽電池は4列それぞれが2枚の鎖を持ち、ラジエーターは1列の鎖を持つ。
import {
  RADIATOR_DEPLOY_TILT,
  RADIATOR_FOLD_COUNT,
  RADIATOR_PANEL_THICKNESS,
  RADIATOR_SEGMENT_LENGTH,
  SOLAR_PANEL_COUNT,
  SOLAR_PANEL_COLUMNS,
  SOLAR_PANEL_SPAN,
  SOLAR_PANEL_THICKNESS,
  SOLAR_PANEL_LENGTH,
} from './player-shape';
import { qFromAxisAngle, qMul, type Quat } from '../math/quat';
import { v3, type Vec3 } from '../math/vec3';

export type DeployablePanelKind = 'solar_panel' | 'radiator';

// パネル1枚の姿勢。座標は取付面の中心を原点、接続面の外向きを +Z とするモジュール局所 [m]。
// パネル局所座標は、長手を +Z、厚み方向(おもて面の法線)を太陽電池なら +Y、ラジエーターなら +X に取り、
// 原点は根元の厚み中心に置く。
export interface PanelPose {
  readonly origin: Vec3;
  readonly rotation: Quat;
  readonly center: Vec3;
  readonly normal: Vec3;
}

interface ChainShape {
  readonly count: number;
  readonly length: number; // パネル1枚の長手 [m]
  readonly thickness: number; // [m]
  readonly foldAxis: Vec3; // 折り目の軸。正の角でパネルの長手が厚み方向の負側へ倒れる向き
  readonly normalAxis: Vec3; // 厚み方向
  readonly panelRoll: Quat; // パネル局所を鎖の展開姿勢へ合わせる固定ロール
  readonly halfFold: (deployed: number) => number; // 展開度 0..1 に対する ψ [rad]
}

const STOW_HALF_FOLD = Math.PI / 2;
const IDENTITY_ROLL: Quat = { x: 0, y: 0, z: 0, w: 1 };
// ラジエーターの面法線 +X を取付面の +Y へ合わせる。
const RADIATOR_PANEL_ROLL = qFromAxisAngle(v3(0, 0, 1), Math.PI / 2);

const CHAINS: Readonly<Record<DeployablePanelKind, ChainShape>> = {
  solar_panel: {
    count: SOLAR_PANEL_COUNT,
    length: SOLAR_PANEL_LENGTH,
    thickness: SOLAR_PANEL_THICKNESS,
    foldAxis: v3(1, 0, 0),
    normalAxis: v3(0, 1, 0),
    panelRoll: IDENTITY_ROLL,
    halfFold: deployed => (1 - deployed) * STOW_HALF_FOLD,
  },
  radiator: {
    count: RADIATOR_FOLD_COUNT,
    length: RADIATOR_SEGMENT_LENGTH,
    thickness: RADIATOR_PANEL_THICKNESS,
    foldAxis: v3(1, 0, 0),
    normalAxis: v3(0, 1, 0),
    panelRoll: RADIATOR_PANEL_ROLL,
    halfFold: deployed => STOW_HALF_FOLD + (RADIATOR_DEPLOY_TILT - STOW_HALF_FOLD) * deployed,
  },
};

// 厚み方向 u と長手方向 w の平面上の点を、取付面の高さ faceZ を足したモジュール局所へ戻す。
function lift(shape: ChainShape, u: number, w: number, faceZ: number): Vec3 {
  return v3(shape.normalAxis.x * u, shape.normalAxis.y * u, faceZ + w);
}

// kind のパネル列の姿勢を、根元側から順に返す。faceZ は取付面の Z [m]、deployed は展開度 0..1。
export function deployablePanelPoses(
  kind: DeployablePanelKind, faceZ: number, deployed: number,
): readonly PanelPose[] {
  const shape = CHAINS[kind];
  if (kind === 'solar_panel') return solarPanelPoses(shape, faceZ, deployed);
  return chainPoses(shape, faceZ, deployed);
}

// 太陽電池は4列それぞれに2枚の剛体鎖を持つ。列ごとに同じ展開姿勢を取り、全体を4×2へ並べる。
function solarPanelPoses(shape: ChainShape, faceZ: number, deployed: number): readonly PanelPose[] {
  const rows = shape.count / SOLAR_PANEL_COLUMNS;
  const tileSpan = SOLAR_PANEL_SPAN / SOLAR_PANEL_COLUMNS;
  const columnShape = { ...shape, count: rows };
  const result: PanelPose[] = [];
  // 各列を全体幅の中心から左右へ配置する。
  for (let column = 0; column < SOLAR_PANEL_COLUMNS; column++) {
    const x = (column - (SOLAR_PANEL_COLUMNS - 1) / 2) * tileSpan;
    for (const pose of chainPoses(columnShape, faceZ, deployed)) {
      result.push({
        origin: v3(pose.origin.x + x, pose.origin.y, pose.origin.z),
        rotation: pose.rotation,
        center: v3(pose.center.x + x, pose.center.y, pose.center.z),
        normal: pose.normal,
      });
    }
  }
  return result;
}

// 1列ぶんのパネル鎖を、根元から順に並べる。
function chainPoses(shape: ChainShape, faceZ: number, deployed: number): readonly PanelPose[] {
  const psi = shape.halfFold(Math.max(0, Math.min(1, deployed)));
  const halfThickness = shape.thickness / 2;
  const result: PanelPose[] = [];
  // 根元ヒンジの位置(u, w)。パネル i は面の側 side = (-1)^i にヒンジを持つ。
  let hingeU = 0;
  let hingeW = 0;
  for (let index = 0; index < shape.count; index++) {
    const side = index % 2 === 0 ? 1 : -1;
    const angle = side * psi;
    // 長手 d と法線 m の (u, w) 成分
    const du = -Math.sin(angle);
    const dw = Math.cos(angle);
    const mu = Math.cos(angle);
    const mw = Math.sin(angle);
    const originU = hingeU + side * mu * halfThickness;
    const originW = hingeW + side * mw * halfThickness;
    result.push({
      origin: lift(shape, originU, originW, faceZ),
      rotation: qMul(qFromAxisAngle(shape.foldAxis, angle), shape.panelRoll),
      center: lift(shape, originU + du * shape.length / 2, originW + dw * shape.length / 2, faceZ),
      normal: lift(shape, mu, mw, 0),
    });
    // 次のヒンジは先端の、このパネルの side 側の面にある
    hingeU = originU + du * shape.length + side * mu * halfThickness;
    hingeW = originW + dw * shape.length + side * mw * halfThickness;
  }
  return result;
}
