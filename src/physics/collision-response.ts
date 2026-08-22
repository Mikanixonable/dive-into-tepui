// 2球の剛体接触の解決。掃引TOI(sphere-contact.ts の sweptSphereContact)を一次手段とし、
// 区間終端の重なり押し戻しは異常時(掃引で検出できない開始時点からの重なり等)の
// フォールバックとしてだけ使う。
//
// 幾何は両方の入口で共通で、分かれるのは補正の受け持ちだけ。不動な相手は質量ではなく型で
// 表され、質量を持つのは反作用を受ける側だけ。その質量は 0(試験粒子 — 相手に力を及ぼさず
// 自分だけが跳ね返る)から無限大(不動)までを取りうる。
import { Vec3, add, addScaled, dot, scale, sub } from './vec3';
import { KinematicState } from './kinematic-state';
import { sweptSphereContact } from './sphere-contact';

// 位置・速度と大きさだけを持つ球。
export interface Sphere {
  readonly state: KinematicState; // 区間終端の位置・速度
  readonly radius: number;
}

// 接触の反作用を受ける球。
export interface SphereView extends Sphere {
  readonly invMass: number; // 0 = 無限質量(動かない)、Infinity = 質量 0(試験粒子)
}

// 双方が動く接触の結果。
export interface CollisionResponse {
  readonly rA: Vec3; readonly rB: Vec3; // 補正後の位置
  readonly vA: Vec3; readonly vB: Vec3; // 反発後の速度(離反中なら元のまま)
  readonly normal: Vec3;                // a → b へ向く接触法線
  readonly bounced: boolean;            // 接近していて反発が起きたか
  readonly toi: number;                 // 接触時刻(prev→state 区間内の割合、0..1)。重なり
                                        // フォールバックでは検出できないので区間終端(1)固定
  // 各側が失う力学エネルギーを、その側の単位質量あたりで表した量 [J/kg]。質量 0 の側でも
  // 有限の値を持つ。
  readonly specificEnergyLossA: number;
  readonly specificEnergyLossB: number;
}

// 不動な相手との接触の結果。相手には書き込む先が無いので、動く側だけを返す。
export interface FixedContactResponse {
  readonly r: Vec3;                     // 補正後の位置
  readonly v: Vec3;                     // 反発後の速度(離反中なら元のまま)
  readonly normal: Vec3;                // 動く側 → 相手 へ向く接触法線
  readonly bounced: boolean;
  readonly toi: number;
  readonly specificEnergyLoss: number;  // 動く側が失う力学エネルギー [J/kg]
}

// 接触の幾何。掃引で解けたなら中心間を separation ちょうどへ揃え、区間終端の重なりを
// 見つけたなら pushOut だけ離す。normal は a → b、toi は区間内の割合。
export type ContactGeometry = { readonly normal: Vec3; readonly toi: number } & (
  | { readonly separation: number; readonly pushOut?: undefined }
  | { readonly pushOut: number; readonly separation?: undefined }
);

// 重なりを検出したときに、1回でめり込みのどれだけを解消するか。1 にすると接触が跳ねる。
const OVERLAP_RELAXATION = 0.8;

// 区間終端で2球が触れ合っているか。prev を両方渡せば掃引TOIを一次手段として試し、掃引で
// 検出できない場合(直前区間の状態が無い、区間開始時点で既に重なっている等)だけ区間終端の
// 重なりを見る。触れていなければ null。
export function sphereContactGeometry(
  a: Sphere, b: Sphere, prevA?: KinematicState, prevB?: KinematicState,
): ContactGeometry | null {
  const minD = a.radius + b.radius;
  const contact = prevA !== undefined && prevB !== undefined
    ? sweptSphereContact(prevA, a.state, prevB, b.state, minD)
    : null;
  const swept = contact !== null && !contact.startsInside ? contact.crossing : null;
  if (swept !== null) return { normal: swept.normal, toi: swept.toi, separation: minD };

  const d = sub(b.state.r, a.state.r);
  const distSq = dot(d, d);
  // 非有限値(NaN/Infinity)は比較で必ず false になるため、ガードしないと
  // 「常に接触している」と判定され、毎フレーム反発と衝突音が発生し、しかも
  // 相手側まで NaN に汚染してしまう。
  if (!(distSq > 0 && distSq < minD * minD)) return null;
  const dist = Math.sqrt(distSq);
  return {
    normal: scale(d, 1 / dist), toi: 1, pushOut: (minD - dist) * OVERLAP_RELAXATION,
  };
}

// a が受け持つ補正の割合。質量 0(逆質量 ∞)の側が全部を受け持ち、双方が質量 0 なら折半する。
function shareOfA(invA: number, invB: number): number {
  if (invA === Infinity) return invB === Infinity ? 0.5 : 1;
  if (invB === Infinity) return 0;
  return invA / (invA + invB);
}

// 反発で失われる力学エネルギーのうち、受け持ちの割合 share を持つ側のぶんを、その側の単位
// 質量あたりで返す [J/kg]。vn は法線相対速度、restitution は反発係数。
//
// 系全体で失われるのは ½·μ·(1−e²)·vn²(μ は換算質量)で、これを両側で折半したものが
// m·q = ¼·μ·(1−e²)·vn²。share = μ/m なので、質量を持ち出さずに q だけが決まる — 相手を
// 押さない試験粒子(質量 0)でも有限の値になり、不動な相手でも動く側には熱が入る。
function specificEnergyLoss(vn: number, restitution: number, share: number): number {
  return 0.25 * (1 - restitution * restitution) * vn * vn * share;
}

// 幾何が定まった接触を、逆質量の比で両側へ分ける。球ではない形状を持つ相手は、自前で求めた
// 法線とめり込みを ContactGeometry に組んでこれを呼ぶ。
export function distributeSphereContact(
  a: SphereView, b: SphereView, restitution: number, geometry: ContactGeometry,
): CollisionResponse {
  const { normal, toi } = geometry;
  const wa = shareOfA(a.invMass, b.invMass);
  const wb = 1 - wa;

  let rA: Vec3, rB: Vec3;
  if (geometry.separation !== undefined) {
    // 位置は積分器が出した区間終端の値をそのまま保ち、法線方向だけ半径和ちょうどに揃える —
    // 重心を動かすと質量比の効かない並進が両者に乗り、軌道速度で進む重い側ではそれが1区間ぶんの
    // 可視の位置の飛びになる。
    const center = add(scale(a.state.r, wb), scale(b.state.r, wa));
    const offset = scale(normal, geometry.separation);
    rA = sub(center, scale(offset, wa));
    rB = add(center, scale(offset, wb));
  } else {
    rA = addScaled(a.state.r, normal, -geometry.pushOut * wa);
    rB = addScaled(b.state.r, normal, geometry.pushOut * wb);
  }

  const vn = dot(sub(b.state.v, a.state.v), normal);
  if (!(vn < 0)) {
    return {
      rA, rB, vA: a.state.v, vB: b.state.v, normal, bounced: false, toi,
      specificEnergyLossA: 0, specificEnergyLossB: 0,
    };
  }
  const exchange = (1 + restitution) * vn;
  return {
    rA, rB,
    vA: addScaled(a.state.v, normal, exchange * wa),
    vB: addScaled(b.state.v, normal, -exchange * wb),
    normal, bounced: true, toi,
    specificEnergyLossA: specificEnergyLoss(vn, restitution, wa),
    specificEnergyLossB: specificEnergyLoss(vn, restitution, wb),
  };
}

// 双方が動く2球の接触を解決する。触れていなければ null。
export function resolveSphereCollision(
  a: SphereView,
  b: SphereView,
  restitution: number,
  prevA?: KinematicState,
  prevB?: KinematicState,
): CollisionResponse | null {
  // 受け持ちの割合は逆質量の和を分母に取るので、非有限なら両側へ NaN が、0(両者とも
  // 無限質量)なら両側へ Infinity が広がる。距離ガードと同じ `!(x > 0)` 形で弾く —
  // `x <= 0` と書くと NaN に対する真偽が反転して非有限入力が通り抜ける。
  if (!(a.invMass + b.invMass > 0)) return null;
  const geometry = sphereContactGeometry(a, b, prevA, prevB);
  return geometry === null ? null : distributeSphereContact(a, b, restitution, geometry);
}

// 幾何が定まった接触を、不動な相手に対して動く側だけへ当てる。相手は状態を書き換えられない
// ので、動く側が補正を全部受け持つ — どちらの側の質量も要らない。既に幾何が手元にあるなら、
// 掃引を掛け直さずにこれを呼ぶ。
export function distributeFixedContact(
  moving: Sphere, fixed: Sphere, restitution: number, geometry: ContactGeometry,
): FixedContactResponse {
  const { normal, toi } = geometry;

  // 掃引で解けたなら中心間を半径和ちょうどへ揃え、区間終端の重なりを見つけただけなら
  // めり込みぶんを離す — 後者は跨いだ瞬間が分からないので、揃える先が無い。
  const r = geometry.separation !== undefined
    ? sub(fixed.state.r, scale(normal, geometry.separation))
    : addScaled(moving.state.r, normal, -geometry.pushOut);

  const vn = dot(sub(fixed.state.v, moving.state.v), normal);
  if (!(vn < 0)) {
    return { r, v: moving.state.v, normal, bounced: false, toi, specificEnergyLoss: 0 };
  }
  return {
    r,
    v: addScaled(moving.state.v, normal, (1 + restitution) * vn),
    normal, bounced: true, toi,
    // 動く側が補正を全部受け持つので、受け持ちの割合は 1。残る半分は相手が持ち去る。
    specificEnergyLoss: specificEnergyLoss(vn, restitution, 1),
  };
}
