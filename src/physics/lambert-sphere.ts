// ランバート球(一様な拡散反射率の球)の測光。ボンドアルベド A の球が放射照度 E を受けたとき、
// 位相角 α(球から見た恒星と観測者のなす角)の方向へ返す明るさを閉じた形で答える。
// 衝効果(opposition surge)は持たない。

// 幾何アルベド / ボンドアルベド。ランバート球は受けた光の 2/3 を満相の方向の基準円盤ぶんとして返す。
export const LAMBERT_SPHERE_GEOMETRIC_ALBEDO_RATIO = 2 / 3;

// 位相関数 Φ(α)。α [rad] は 0(満)で 1、π(新)で 0。
export function lambertPhase(alpha: number): number {
  return (Math.sin(alpha) + (Math.PI - alpha) * Math.cos(alpha)) / Math.PI;
}

// 半径 radius [m] の球から distance [m] 離れた観測者に届く放射照度(sunIrradiance と同じ単位)。
// (2/3)·A·E·(R/d)²·Φ(α) で、distance ≫ radius の遠方で成り立つ。
export function lambertSphereIrradiance(
  bondAlbedo: number, sunIrradiance: number, radius: number, distance: number, alpha: number,
): number {
  return LAMBERT_SPHERE_GEOMETRIC_ALBEDO_RATIO * bondAlbedo * sunIrradiance
    * (radius / distance) ** 2 * lambertPhase(alpha);
}
