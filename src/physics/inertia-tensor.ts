// 剛体の慣性テンソルの型と、その合成に要する代数。剛体を部分に分けて足し合わせるには、各部分の
// 慣性テンソルを共通の点まわり・共通の姿勢へ移してから足す必要があるので、平行軸の定理と回転を
// ここに持つ。

import { Vec3, dot, v3 } from './vec3';

// 重心まわりの慣性テンソル [kg·m²]。ixy/ixz/iyz は慣性乗積を負号込みで持つテンソルの非対角成分
// (−∫xy dm など)で、行列は [[ixx, ixy, ixz], [ixy, iyy, iyz], [ixz, iyz, izz]] になる。
export interface InertiaTensor {
  readonly ixx: number;
  readonly iyy: number;
  readonly izz: number;
  readonly ixy: number;
  readonly ixz: number;
  readonly iyz: number;
}

// 3軸とも 0 の慣性テンソル。合成の初期値に使う。
export const ZERO_INERTIA: InertiaTensor = { ixx: 0, iyy: 0, izz: 0, ixy: 0, ixz: 0, iyz: 0 };

// 同じ点まわり・同じ姿勢で測った2つの慣性テンソルの和。
export function addInertia(a: InertiaTensor, b: InertiaTensor): InertiaTensor {
  return {
    ixx: a.ixx + b.ixx,
    iyy: a.iyy + b.iyy,
    izz: a.izz + b.izz,
    ixy: a.ixy + b.ixy,
    ixz: a.ixz + b.ixz,
    iyz: a.iyz + b.iyz,
  };
}

// 慣性テンソルを s 倍する。
export function scaleInertia(inertia: InertiaTensor, s: number): InertiaTensor {
  return {
    ixx: inertia.ixx * s,
    iyy: inertia.iyy * s,
    izz: inertia.izz * s,
    ixy: inertia.ixy * s,
    ixz: inertia.ixz * s,
    iyz: inertia.iyz * s,
  };
}

// 質量 mass の剛体の、重心まわりの慣性テンソルを、重心から offset だけ離れた点まわりへ移す
// (平行軸の定理)。offset は移す先の点から見た重心の位置。逆向きへ戻すときは offset の符号ではなく
// mass の符号を反転させる — 平行軸の項が offset の2次だからである。
export function translateInertia(inertia: InertiaTensor, mass: number, offset: Vec3): InertiaTensor {
  const d2 = dot(offset, offset);
  return {
    ixx: inertia.ixx + mass * (d2 - offset.x * offset.x),
    iyy: inertia.iyy + mass * (d2 - offset.y * offset.y),
    izz: inertia.izz + mass * (d2 - offset.z * offset.z),
    ixy: inertia.ixy - mass * offset.x * offset.y,
    ixz: inertia.ixz - mass * offset.x * offset.z,
    iyz: inertia.iyz - mass * offset.y * offset.z,
  };
}

// 質量 mass の質点が offset の位置にあるときの、原点まわりの慣性テンソル。
export function pointMassInertia(mass: number, offset: Vec3): InertiaTensor {
  return translateInertia(ZERO_INERTIA, mass, offset);
}

// 慣性テンソルを、基底 (x, y, z) で表した座標系から元の座標系へ移す。x/y/z は正規直交でなければ
// ならず、その各列を並べた行列を R として I' = R·I·Rᵀ を返す。
export function rotateInertia(inertia: InertiaTensor, x: Vec3, y: Vec3, z: Vec3): InertiaTensor {
  const m = matrixOf(inertia);
  const basis = [x, y, z];
  // (R·I·Rᵀ)_ij = Σ_kl R_ik I_kl R_jl。R_ik は基底ベクトル k の i 成分なので、列ごとに畳む。
  const out = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      let sum = 0;
      for (let k = 0; k < 3; k++) {
        for (let l = 0; l < 3; l++) {
          sum += component(basis[k]!, i) * m[k]![l]! * component(basis[l]!, j);
        }
      }
      out[i]![j] = sum;
    }
  }
  return {
    ixx: out[0]![0]!,
    iyy: out[1]![1]!,
    izz: out[2]![2]!,
    ixy: out[0]![1]!,
    ixz: out[0]![2]!,
    iyz: out[1]![2]!,
  };
}

// 慣性テンソルの主慣性モーメント。対称行列の固有値を、3次方程式の三角関数解で求める。返す順序は
// 昇順。主軸の向きは返さない — 中間軸不安定性の判定に要るのは3つの値の大小だけである。
export function principalMoments(inertia: InertiaTensor): Vec3 {
  const { ixx, iyy, izz, ixy, ixz, iyz } = inertia;
  const trace = (ixx + iyy + izz) / 3;
  const dxx = ixx - trace;
  const dyy = iyy - trace;
  const dzz = izz - trace;
  // 偏差テンソルの第2・第3不変量。p は固有値の広がり、q は歪みを表す。
  const p = Math.sqrt((dxx * dxx + dyy * dyy + dzz * dzz + 2 * (ixy * ixy + ixz * ixz + iyz * iyz)) / 6);
  if (!(p > 0)) return v3(trace, trace, trace);
  const det =
    (dxx * (dyy * dzz - iyz * iyz) - ixy * (ixy * dzz - iyz * ixz) + ixz * (ixy * iyz - dyy * ixz)) /
    (p * p * p);
  const phi = Math.acos(Math.min(1, Math.max(-1, det / 2))) / 3;
  const values = [
    trace + 2 * p * Math.cos(phi),
    trace + 2 * p * Math.cos(phi + (2 * Math.PI) / 3),
    trace + 2 * p * Math.cos(phi + (4 * Math.PI) / 3),
  ].sort((a, b) => a - b);
  return v3(values[0]!, values[1]!, values[2]!);
}

function matrixOf(inertia: InertiaTensor): readonly (readonly number[])[] {
  return [
    [inertia.ixx, inertia.ixy, inertia.ixz],
    [inertia.ixy, inertia.iyy, inertia.iyz],
    [inertia.ixz, inertia.iyz, inertia.izz],
  ];
}

function component(vector: Vec3, index: number): number {
  return index === 0 ? vector.x : index === 1 ? vector.y : vector.z;
}
