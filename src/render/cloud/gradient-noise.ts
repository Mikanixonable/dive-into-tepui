// 3D の勾配ノイズ(改良 Perlin)1 段。格子点ごとに 12 方向のどれかを割り当て、格子の中の位置との
// 内積を五次のフェードで三重線形に混ぜる。値はおおむね −1..1 で、格子点では 0 になる。
import { Fn, floor, int, mix, or, select, uint } from 'three/tsl';
import type { FloatNode, UintNode, Vec3Node } from '../tsl-types';

// 軸ごとの種の乗数(xxhash32 の PRIME32_4・PRIME32_5 と Murmur3 の c2)。隣の格子点の種は定数を
// 足すだけで出るので、8 隅に要る乗算は軸あたり 1 回で済む。どれも 2^31 未満の奇数に取る。
const AXIS_X = 0x27d4eb2f;
const AXIS_Y = 0x165667b1;
const AXIS_Z = 0x1b873593;
// 軸の種を xor しただけでは 8 隅の値のあいだに線形の関係が残り、格子に沿った縞として見える。
// 2 回の乗算で撹拌してから上位 4 bit を勾配の番号に使う。
const MIX_A = 0x7feb352d;
const MIX_B = 0x2c1b3c6d;
// 12 方向の勾配で作った和を ±1 へ収める目盛り。
const AMPLITUDE = 0.982;

// 格子点の軸ごとの種から、勾配の番号に使う 32 bit。
const scramble = Fn(([seed]: readonly [UintNode]) => {
  const mixed = seed.bitXor(seed.shiftRight(15)).mul(uint(MIX_A)).toVar();
  return mixed.bitXor(mixed.shiftRight(13)).mul(uint(MIX_B));
}).setLayout({ name: 'cloudNoiseScramble', type: 'uint', inputs: [{ name: 'seed', type: 'uint' }] });

// 番号 hash が指す 12 方向と、格子点からの変位 (x, y, z) との内積。方向は立方体の辺の中点向きで、
// 成分が 0・±1 しかないので積が要らない。
const gradientDot = Fn(([hash, x, y, z]: readonly [UintNode, FloatNode, FloatNode, FloatNode]) => {
  const h = hash.bitAnd(uint(15)).toVar();
  const u = select(h.lessThan(uint(8)), x, y).toVar();
  const v = select(h.lessThan(uint(4)), y, select(or(h.equal(uint(12)), h.equal(uint(14))), x, z)).toVar();
  return select(h.bitAnd(uint(1)).equal(uint(0)), u, u.negate())
    .add(select(h.bitAnd(uint(2)).equal(uint(0)), v, v.negate()));
}).setLayout({
  name: 'cloudNoiseGradientDot',
  type: 'float',
  inputs: [{ name: 'hash', type: 'uint' }, { name: 'x', type: 'float' }, { name: 'y', type: 'float' },
    { name: 'z', type: 'float' }],
});

// 0/1 で 1 次と 2 次の微分が消えるフェード。格子の境目に筋が出ない。
const fade = (t: FloatNode): FloatNode => t.mul(t).mul(t).mul(t.mul(t.mul(6).sub(15)).add(10));

export const gradientNoise = Fn(([position]: readonly [Vec3Node]) => {
  const cell = floor(position).toVar();
  const near = position.sub(cell).toVar();
  const far = near.sub(1).toVar();
  const x0 = uint(int(cell.x)).mul(uint(AXIS_X)).toVar();
  const y0 = uint(int(cell.y)).mul(uint(AXIS_Y)).toVar();
  const z0 = uint(int(cell.z)).mul(uint(AXIS_Z)).toVar();
  const x1 = x0.add(uint(AXIS_X)).toVar();
  const y1 = y0.add(uint(AXIS_Y)).toVar();
  const z1 = z0.add(uint(AXIS_Z)).toVar();
  const corner = (sx: UintNode, sy: UintNode, sz: UintNode, dx: FloatNode, dy: FloatNode, dz: FloatNode): FloatNode =>
    gradientDot(scramble(sx.bitXor(sy).bitXor(sz)), dx, dy, dz);

  const u = fade(near.x).toVar();
  const v = fade(near.y).toVar();
  const w = fade(near.z).toVar();
  return mix(
    mix(
      mix(corner(x0, y0, z0, near.x, near.y, near.z), corner(x1, y0, z0, far.x, near.y, near.z), u),
      mix(corner(x0, y1, z0, near.x, far.y, near.z), corner(x1, y1, z0, far.x, far.y, near.z), u), v),
    mix(
      mix(corner(x0, y0, z1, near.x, near.y, far.z), corner(x1, y0, z1, far.x, near.y, far.z), u),
      mix(corner(x0, y1, z1, near.x, far.y, far.z), corner(x1, y1, z1, far.x, far.y, far.z), u), v),
    w).mul(AMPLITUDE);
}).setLayout({ name: 'cloudGradientNoise', type: 'float', inputs: [{ name: 'position', type: 'vec3' }] });
