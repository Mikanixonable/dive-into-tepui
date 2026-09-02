// Vec3 は不変。生成後に成分を書き換えてはならず、演算はすべて新しい Vec3 を返す。
// 参照を共有したまま中身を書き換えると、保持側(DynamicTrajectory など)が変化を検知
// できなくなるため、この不変性が整合性の前提になっている。
import { randSym } from './random';

export type Vec3 = {
  readonly x: number;
  readonly y: number;
  readonly z: number;
} & { readonly __tag: "Vec3" };

// Vec3 を構築する唯一の手段(オブジェクトリテラルを直接 Vec3 として扱わないこと)。
export function v3(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z } as Vec3;
}

// a + b
export function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z } as Vec3;
}

// a - b
export function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z } as Vec3;
}

// a を s 倍したベクトル
export function scale(a: Vec3, s: number): Vec3 {
  return { x: a.x * s, y: a.y * s, z: a.z * s } as Vec3;
}

// a + b * s
export function addScaled(a: Vec3, b: Vec3, s: number): Vec3 {
  return { x: a.x + b.x * s, y: a.y + b.y * s, z: a.z + b.z * s } as Vec3;
}

// 成分がすべて厳密に一致するか。近似ではなく「値が動いたか」を見るための判定。
export function sameVec(a: Vec3, b: Vec3): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z;
}

// 内積
export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

// 外積 a × b
export function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  } as Vec3;
}

// 長さの2乗
export function lenSq(a: Vec3): number {
  return a.x * a.x + a.y * a.y + a.z * a.z;
}

// 長さ
export function len(a: Vec3): number {
  return Math.sqrt(lenSq(a));
}

// ゼロベクトル安全な正規化
export function norm(a: Vec3): Vec3 {
  const l = len(a);
  if (l < 1e-12) return { x: 0, y: 0, z: 0 } as Vec3;
  return scale(a, 1 / l);
}

// 各成分が [-amp, amp] の一様乱数ベクトル。rand は [0, 1) を返す生成器(既定 Math.random)。
export function randVec(amp: number, rand: () => number = Math.random): Vec3 {
  return v3(randSym(amp, rand), randSym(amp, rand), randSym(amp, rand));
}

// fwd に直交するランダム単位ベクトル(散布界用)。rand は [0, 1) を返す生成器(既定 Math.random)。
// 【契約】fwd は単位ベクトルであること。射影 r - fwd(r·fwd) は |fwd| = 1 を前提にしており、
// 長いベクトル(位置ベクトル等)を渡すと第2項が第1項を飲み込んで、直交どころか ±fwd 方向が
// 返る。呼び出し側で norm() を通すこと(ここで norm() しないのは、全呼び出しが既に正規化済みの
// 方向ベクトルを渡しており、毎回の平方根が無駄になるため)。
export function randPerp(fwd: Vec3, rand: () => number = Math.random): Vec3 {
  for (;;) {
    const r = randVec(1, rand);
    const p = projectOntoPlane(r, fwd);
    if (lenSq(p) > 1e-6) return norm(p);
  }
}

// v から法線方向の成分を抜き、法線に垂直な平面へ落とす。planeNormal は単位ベクトルであること
// — 正規化しないのは、呼び出しがどれも正規化済みの法線を渡すため。
export function projectOntoPlane(v: Vec3, planeNormal: Vec3): Vec3 {
  return sub(v, scale(planeNormal, dot(v, planeNormal)));
}

// ロドリゲスの回転公式: v を単位軸 axis まわりに angle 回転
export function rotateAxis(v: Vec3, axis: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const k = axis;
  const kxv = cross(k, v);
  const kdv = dot(k, v);
  // v' = v·cosθ + (k×v)·sinθ + k(k·v)(1-cosθ)
  return {
    x: v.x * c + kxv.x * s + k.x * kdv * (1 - c),
    y: v.y * c + kxv.y * s + k.y * kdv * (1 - c),
    z: v.z * c + kxv.z * s + k.z * kdv * (1 - c),
  } as Vec3;
}

