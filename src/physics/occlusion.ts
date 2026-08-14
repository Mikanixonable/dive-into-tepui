// カメラ視点からワールド座標への視線が、いずれかの天体の球体に遮られているかどうかの
// 純幾何判定(レイと球の交差)。マップビューでの軌道要素アイコンの表示可否とピック候補の
// 選出可否は、この1関数を両方が呼ぶことで揃える — 見えているのに押せない/見えないのに
// 押せる、という食い違いを防ぐ。
import { KinematicState } from './kinematic-state';
import { addScaled, dot, len, lenSq, sub, Vec3 } from './vec3';

// 手前側交点が対象点よりこの距離以上カメラ寄りのときだけ遮蔽と判定する余裕。対象点自身が
// その天体の表面上・近傍にある(その天体を回っている物体など)場合に、丸め誤差で
// 自己遮蔽と誤判定しないためのマージン。
const OCCLUSION_MARGIN = 1;
const OCCLUSION_FADE_START = 2;
const OCCLUSION_FADE_END = 1.5;

// 遮蔽中の天体マーカーを、手前の天体の近傍だけ段階的に減衰させる係数を返す。
// 手前の天体から対象点までの距離をその天体の半径で正規化し、1.5R をセーフゾーンの
// 内側(完全非表示)、2R をフェード開始点(完全表示)とする。複数の天体が遮る場合は
// 最も強く減衰する天体を採用する。
export function occlusionOpacity<T extends { readonly radius: number; readonly state: KinematicState }>(
  cameraPos: Vec3,
  point: Vec3,
  attractors: readonly T[],
): number {
  const toPoint = sub(point, cameraPos);
  const dist = len(toPoint);
  if (dist < 1e-6) return 1;
  const dir = { x: toPoint.x / dist, y: toPoint.y / dist, z: toPoint.z / dist } as Vec3;
  let opacity = 1;

  for (const attractor of attractors) {
    const fromAttractorToPoint = sub(point, attractor.state.r);
    const targetDistance = len(fromAttractorToPoint);
    if (targetDistance <= attractor.radius) continue;
    const oc = sub(attractor.state.r, cameraPos);
    const tca = dot(oc, dir);
    if (tca <= 0) continue;
    const perp = addScaled(oc, dir, -tca);
    const radiusSq = attractor.radius * attractor.radius;
    if (lenSq(perp) >= radiusSq) continue;
    const t0 = tca - Math.sqrt(radiusSq - lenSq(perp));
    if (t0 <= 0 || t0 >= dist - OCCLUSION_MARGIN) continue;

    const normalizedDistance = targetDistance / attractor.radius;
    const fade = Math.max(0, Math.min(1,
      (normalizedDistance - OCCLUSION_FADE_END) / (OCCLUSION_FADE_START - OCCLUSION_FADE_END)));
    opacity = Math.min(opacity, fade);
  }
  return opacity;
}

// cameraPos から point への視線が attractors のいずれかの球体に遮られていれば true。
export function isOccluded<T extends { readonly radius: number; readonly state: KinematicState }>(
  cameraPos: Vec3,
  point: Vec3,
  attractors: readonly T[],
): boolean {
  // 各天体についてレイと球の交差判定(判別式 d2 vs r2)を行い、手前側交点が
  // カメラと point の間に収まっていれば遮蔽とみなす。
  const toPoint = sub(point, cameraPos);
  const dist = Math.sqrt(dot(toPoint, toPoint));
  if (dist < 1e-6) return false;
  const dir = { x: toPoint.x / dist, y: toPoint.y / dist, z: toPoint.z / dist } as Vec3;

  for (const attractor of attractors) {
    const toCenter = sub(attractor.state.r, point);
    if (dot(toCenter, toCenter) <= attractor.radius * attractor.radius) continue; // 対象点自身がこの天体の内部/表面(その天体の中心ラベルなど)

    const oc = sub(attractor.state.r, cameraPos);
    const tca = dot(oc, dir);
    if (tca <= 0) continue; // 天体はカメラの後方
    // d2 = |oc|² − tca² ではなく、視線への垂線ベクトルを先に作ってから2乗する。天体が
    // カメラから遠いほど oc/tca は大きくなり(太陽系スケールで ~1e11)、2乗した後に引くと
    // 桁落ちで誤差が数千 m² 規模まで膨れ、半径が小さい天体の遮蔽判定を毎フレーム反転させる。
    const perp = addScaled(oc, dir, -tca);
    const d2 = lenSq(perp);
    const r2 = attractor.radius * attractor.radius;
    if (d2 >= r2) continue; // 視線が球を外れる
    const thc = Math.sqrt(r2 - d2);
    const t0 = tca - thc; // 球の手前側交点までの距離
    if (t0 > 0 && t0 < dist - OCCLUSION_MARGIN) return true;
  }
  return false;
}
