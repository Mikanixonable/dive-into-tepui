// 円制限三体問題のラグランジュ点。共線点 γ の求解と、回転系での5点の無次元座標。
import { Vec3 } from './vec3';

export type LagrangePoints = {
  readonly L1: Vec3;
  readonly L2: Vec3;
  readonly L3: Vec3;
  readonly L4: Vec3;
  readonly L5: Vec3;
};

// 共線点 L1/L2 の副天体からの距離(軌道半径比 gamma)。回転系での釣り合いは gamma の5次方程式
// になり、閉じた形では解けない。Hill 半径 (mu/3)^(1/3) を初期値に Newton 法で解く —
// 地球-月系では Hill 半径そのものが真の解から 5%(約 5,000 km)ずれるため、反復して詰める。
export function collinearGamma(mu: number, point: 'L1' | 'L2'): number {
  const sign = point === 'L1' ? -1 : 1;
  let g = Math.cbrt(mu / 3);
  for (let i = 0; i < 40; i++) {
    // L1: g^5 -(3-mu)g^4 +(3-2mu)g^3 -mu g^2 +2mu g -mu = 0
    // L2: g^5 +(3-mu)g^4 +(3-2mu)g^3 -mu g^2 -2mu g -mu = 0
    const f = g ** 5 + sign * (3 - mu) * g ** 4 + (3 - 2 * mu) * g ** 3
      - mu * g * g - sign * 2 * mu * g - mu;
    const df = 5 * g ** 4 + sign * 4 * (3 - mu) * g ** 3 + 3 * (3 - 2 * mu) * g * g
      - 2 * mu * g - sign * 2 * mu;
    const step = f / df;
    g -= step;
    if (Math.abs(step) < 1e-15) break;
  }
  return g;
}

// 円制限三体問題のラグランジュ点。5点はいずれも回転系(原点 = 主天体、x̂ = 副天体方向、
// ŷ = 副天体の公転前方)の固定点で、その無次元座標(軌道半径を 1 とする)は質量比
// mu = m2/(m1+m2) だけで決まる。それを ECI [m] へ移す写像 place を受け取って組み立てる。
export function lagrangePoints(mu: number, place: (x: number, y: number) => Vec3): LagrangePoints {
  const s60 = Math.sqrt(3) / 2;
  return {
    L1: place(1 - collinearGamma(mu, 'L1'), 0),
    L2: place(1 + collinearGamma(mu, 'L2'), 0),
    L3: place(-(1 + (5 / 12) * mu), 0),
    L4: place(0.5, s60),
    L5: place(0.5, -s60),
  };
}
