import type { Vec3 } from './bodies';

export type { Vec3 };

export function v3(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z };
}

export function clone(a: Vec3): Vec3 {
  return { x: a.x, y: a.y, z: a.z };
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function scale(a: Vec3, s: number): Vec3 {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}

export function addScaled(a: Vec3, b: Vec3, s: number): Vec3 {
  return { x: a.x + b.x * s, y: a.y + b.y * s, z: a.z + b.z * s };
}

export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

export function lenSq(a: Vec3): number {
  return a.x * a.x + a.y * a.y + a.z * a.z;
}

export function len(a: Vec3): number {
  return Math.sqrt(lenSq(a));
}

// ゼロベクトル安全な正規化
export function norm(a: Vec3): Vec3 {
  const l = len(a);
  if (l < 1e-12) return { x: 0, y: 0, z: 0 };
  return scale(a, 1 / l);
}

export function neg(a: Vec3): Vec3 {
  return { x: -a.x, y: -a.y, z: -a.z };
}

// ロドリゲスの回転公式: v を単位軸 axis まわりに angle 回転
export function rotateAxis(v: Vec3, axis: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const k = axis;
  const kxv = cross(k, v);
  const kdv = dot(k, v);
  return {
    x: v.x * c + kxv.x * s + k.x * kdv * (1 - c),
    y: v.y * c + kxv.y * s + k.y * kdv * (1 - c),
    z: v.z * c + kxv.z * s + k.z * kdv * (1 - c),
  };
}

export function distance(a: Vec3, b: Vec3): number {
  return len(sub(a, b));
}
