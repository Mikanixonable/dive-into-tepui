// 天体ごとの大気(基準楕円体・共回転・区分指数の密度モデル)と、その大気による高度・
// 対気速度・抗力加速度・焼失判定。固有名詞を持たず、大気の中身はすべて呼び出し側が渡す
// Atmosphere に載っている。THREE/DOM 非依存の純粋関数。
import { KinematicState } from './kinematic-state';
import { Vec3, cross, dot, len, scale, sub, v3 } from './vec3';

// 区分指数モデルの1層: [基準高度 h0 [m], 基準密度 ρ0 [kg/m^3], スケールハイト H [m]]。
// 基準高度の昇順に並べる。密度は H = R*T/(M·g) が層ごとに桁で違う(地球で 5.4〜268 km)
// ため単一の指数では表せず、層に区切って初めて成り立つ。
export type AtmosphereLayer = readonly [number, number, number];

// 天体の大気の静的な記述。基準楕円体は「平均海面」であり、衝突判定の外接球
// (Attractor.radius)とは別の理由で選ばれた別の量なので、別の宣言として持つ。
export type AtmosphereDef = {
  readonly equatorRadius: number; // 基準楕円体の赤道半径 [m]
  readonly polarRadius: number; // 基準楕円体の極半径 [m]
  readonly spinRate: number; // 自転角速度 [rad/s](大気は天体と共回転する)
  readonly layers: readonly AtmosphereLayer[];
};

// 実行時の大気。静的な記述に、時刻ごとに解決した自転軸を足したもの
// (Degree2GravityDef → Degree2Gravity と同じ二段構え)。
export type Atmosphere = AtmosphereDef & {
  readonly pole: Vec3; // 自転軸(単位ベクトル、ECI)
};

// 天体中心からの相対位置 rRel の、基準楕円体からの高度 [m]。地心緯度 φ における楕円体の
// 地心半径 R(φ) = a·b/√(a²sin²φ + b²cos²φ) を引く — 真の測地高度との差は法線と動径の
// ずれが2次で効くため高度 100 km で 1 m 未満に収まる。平均半径の真球で測ると、同じ真の
// 高度でも緯度によって高度が ±7〜−14 km ずれ、密度が赤道と極で 45 倍振れる。
export function ellipsoidAltitude(rRel: Vec3, atm: Atmosphere): number {
  const d = len(rRel);
  if (d < 1) return -atm.polarRadius;
  const sinPhi = dot(rRel, atm.pole) / d;
  const sin2 = sinPhi * sinPhi;
  const a2 = atm.equatorRadius * atm.equatorRadius;
  const b2 = atm.polarRadius * atm.polarRadius;
  return d - (atm.equatorRadius * atm.polarRadius) / Math.sqrt(a2 * sin2 + b2 * (1 - sin2));
}

// 高度 alt [m] における大気密度 [kg/m^3]。最上層より上も、その層の指数でそのまま外挿する。
export function atmosphericDensity(alt: number, atm: Atmosphere): number {
  const h = Math.max(0, alt);
  let row = atm.layers[0]!;
  for (let i = atm.layers.length - 1; i >= 0; i--) {
    if (h >= atm.layers[i]![0]) {
      row = atm.layers[i]!;
      break;
    }
  }
  return row[1] * Math.exp(-(h - row[0]) / row[2]);
}

// 共回転する大気に対する対気速度 v_rel − ω×r_rel。rRel/vRel は天体中心からの相対位置・速度。
export function airspeed(rRel: Vec3, vRel: Vec3, atm: Atmosphere): Vec3 {
  return sub(vRel, scale(cross(atm.pole, rRel), atm.spinRate));
}

// 大気抵抗の加速度。rRel/vRel はその大気を持つ天体の中心からの相対位置・速度、bcInv は
// 弾道係数の逆数 Cd·A/m(0 なら抵抗なし = ゼロベクトル)。
export function dragAccel(rRel: Vec3, vRel: Vec3, bcInv: number, atm: Atmosphere): Vec3 {
  if (bcInv <= 0) return v3();
  const rho = atmosphericDensity(ellipsoidAltitude(rRel, atm), atm);
  if (rho < 1e-15) return v3();
  const { x: vrx, y: vry, z: vrz } = airspeed(rRel, vRel, atm);
  const k = -0.5 * rho * Math.sqrt(vrx * vrx + vry * vry + vrz * vrz) * bcInv;
  return v3(vrx * k, vry * k, vrz * k);
}

// 位置 r が、大気を持つ天体の表面から margin 以内まで沈み込んでいれば、その天体。
export function burnUpBody<T extends {
  readonly radius: number;
  readonly state: KinematicState;
  readonly atmosphere: Atmosphere | null;
}>(
  r: Vec3,
  bodies: readonly T[],
  margin: number,
): T | null {
  for (const body of bodies) {
    if (body.atmosphere === null) continue;
    if (len(sub(r, body.state.r)) < body.radius + margin) return body;
  }
  return null;
}
