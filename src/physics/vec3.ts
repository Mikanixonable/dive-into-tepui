// Vec3 は不変。生成後に成分を書き換えてはならず、演算はすべて新しい Vec3 を返す。
// 参照を共有したまま中身を書き換えると、保持側(OrbitEntity など)が変化を検知
// できなくなるため、この不変性が整合性の前提になっている。
export type Vec3 = {
  readonly x: number;
  readonly y: number;
  readonly z: number;
} & { readonly __tag: "Vec3" };

export function v3(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z } as Vec3;
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z } as Vec3;
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z } as Vec3;
}

export function scale(a: Vec3, s: number): Vec3 {
  return { x: a.x * s, y: a.y * s, z: a.z * s } as Vec3;
}

export function addScaled(a: Vec3, b: Vec3, s: number): Vec3 {
  return { x: a.x + b.x * s, y: a.y + b.y * s, z: a.z + b.z * s } as Vec3;
}

export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  } as Vec3;
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
  if (l < 1e-12) return { x: 0, y: 0, z: 0 } as Vec3;
  return scale(a, 1 / l);
}

// [-amp, amp] の一様乱数
export function randSym(amp: number): number {
  return (Math.random() * 2 - 1) * amp;
}

// 各成分が [-amp, amp] の一様乱数ベクトル
export function randVec(amp: number): Vec3 {
  return v3(randSym(amp), randSym(amp), randSym(amp));
}

// fwd に直交するランダム単位ベクトル(散布界用)
export function randPerp(fwd: Vec3): Vec3 {
  for (;;) {
    const r = randVec(1);
    const p = sub(r, scale(fwd, dot(r, fwd)));
    if (lenSq(p) > 1e-6) return norm(p);
  }
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
  } as Vec3;
}

