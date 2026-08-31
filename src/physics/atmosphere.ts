// 天体ごとの大気(基準楕円体・共回転・区分指数の密度モデル)と、その大気による高度・
// 対気速度・抗力加速度。固有名詞を持たず、大気の中身はすべて呼び出し側が渡す
// Atmosphere に載っている。THREE/DOM 非依存の純粋関数。

import { Vec3, cross, dot, len, scale, sub, v3 } from '../math/vec3';

// 区分指数モデルの1層: [基準高度 h0 [m], 基準密度 ρ0 [kg/m^3], スケールハイト H [m]]。
// 基準高度の昇順に並べる。密度は H = R*T/(M·g) が層ごとに桁で違う(地球で 5.4〜268 km)
// ため単一の指数では表せず、層に区切って初めて成り立つ。
export type AtmosphereLayer = readonly [number, number, number];

// 天体の大気の静的な記述。基準楕円体は「平均海面」であり、衝突判定の外接球
// (CelestialBody.radius)とは別の理由で選ばれた別の量なので、別の宣言として持つ。
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

// 高度 h [m](地表より下は 0 とみなす)を含む層。最上層より上も最上層を返す。
function layerAt(h: number, atm: Atmosphere): AtmosphereLayer {
  for (let i = atm.layers.length - 1; i >= 0; i--) {
    if (h >= atm.layers[i]![0]) return atm.layers[i]!;
  }
  return atm.layers[0]!;
}

// 高度 alt [m] における大気密度 [kg/m^3]。最上層より上も、その層の指数でそのまま外挿する。
export function atmosphericDensity(alt: number, atm: Atmosphere): number {
  const h = Math.max(0, alt);
  const row = layerAt(h, atm);
  return row[1] * Math.exp(-(h - row[0]) / row[2]);
}

// 高度 alt [m] における大気のスケールハイト [m]。その高度のまわりで密度が 1/e になる高度差で、
// atmosphericDensity が返す指数の勾配そのもの。
export function atmosphericScaleHeight(alt: number, atm: Atmosphere): number {
  return layerAt(Math.max(0, alt), atm)[2];
}

// 共回転する大気に対する対気速度 v_rel − ω×r_rel。rRel/vRel は天体中心からの相対位置・速度。
export function airspeed(rRel: Vec3, vRel: Vec3, atm: Atmosphere): Vec3 {
  return sub(vRel, scale(cross(atm.pole, rRel), atm.spinRate));
}

// その物体が浴びている流れ。rRel/vRel は天体中心からの相対位置・速度。抗力・動圧・空力加熱は
// どれもこの2つだけから決まる。
export function airflow(
  rRel: Vec3, vRel: Vec3, atm: Atmosphere,
): { readonly density: number; readonly speed: number } {
  return {
    density: atmosphericDensity(ellipsoidAltitude(rRel, atm), atm),
    speed: len(airspeed(rRel, vRel, atm)),
  };
}

// 大気抵抗の加速度。rRel/vRel はその大気を持つ天体の中心からの相対位置・速度、bcInv は
// 弾道係数の逆数 Cd·A/m(0 なら抵抗なし = ゼロベクトル)。dt はこの加速度が積分される刻み [s]。
// 抗力は対気速度を減らすだけで反転させることはできないので、dt のあいだに奪う量を対気速度
// そのもので頭打ちにする。頭打ちに触れるのは刻みが抗力に対して既に広すぎるときだけだが、
// 外すとそこで陽的な積分が段どうしで増幅し合い、1ステップで発散する。
export function dragAccel(rRel: Vec3, vRel: Vec3, bcInv: number, atm: Atmosphere, dt: number): Vec3 {
  if (bcInv <= 0) return v3();
  const rho = atmosphericDensity(ellipsoidAltitude(rRel, atm), atm);
  if (rho < 1e-15) return v3();
  const { x: vrx, y: vry, z: vrz } = airspeed(rRel, vRel, atm);
  // a = k·v_air なので、dt で奪う量が対気速度を超えない条件は |k|·dt ≤ 1。
  const k = Math.max(
    -0.5 * rho * Math.sqrt(vrx * vrx + vry * vry + vrz * vrz) * bcInv,
    dt > 0 ? -1 / dt : -Infinity);
  return v3(vrx * k, vry * k, vrz * k);
}

