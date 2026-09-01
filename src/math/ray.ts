// 視線そのものの幾何。始点から前方へ無限に伸びる半直線として扱い、探索距離の上限は持たない
// (上限が要る当たり判定は、その形を持つ側が自分で決める)。
import { Vec3, dot, lenSq, scale, sub } from './vec3';

// 視線。始点と単位方向ベクトルの組で、どちらも絶対 ECI。
export type Ray = { origin: Vec3; dir: Vec3 };

// 視線が中心 center・半径 radius の球に当たるか。始点が球の内側にあるときも、球が始点より
// 後方にあって当たらないときも正しく答える。
export function hitsSphere(ray: Ray, center: Vec3, radius: number): boolean {
  const toCenter = sub(center, ray.origin);
  const along = Math.max(0, dot(toCenter, ray.dir));
  return lenSq(sub(toCenter, scale(ray.dir, along))) <= radius * radius;
}
