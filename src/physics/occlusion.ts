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
const OCCLUSION_FADE_START = 1.5;
const OCCLUSION_FADE_END = 1.0;

// 天体マーカーの遮蔽・近接フェード係数を返す。
// ここでいう R は実距離ではなく、カメラから見た手前の天体の見かけの角半径。マップ
// ビューはカメラ距離が大きく変わるため、天体から対象までの ECI 距離を使うと画面上の
// 惑星の大きさと閾値が一致しない。見かけの中心間角距離が 1.5R 以下をセーフゾーン
// (完全非表示)、1.5R〜2R をフェード、2R 以上を完全表示とする。
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
    if (lenSq(fromAttractorToPoint) <= attractor.radius * attractor.radius) continue;
    const oc = sub(attractor.state.r, cameraPos);
    const centerDistance = len(oc);
    if (centerDistance < 1e-6) continue;
    const tca = dot(oc, dir);
    if (tca <= 0) continue;
    // 手前の天体だけが背後の対象を隠す。tca は中心の視線方向距離なので、画面中心から
    // 外れた天体でも「対象より手前」にあるかを正しく判定できる。
    if (tca >= dist - OCCLUSION_MARGIN) continue;

    const centerDir = { x: oc.x / centerDistance, y: oc.y / centerDistance, z: oc.z / centerDistance } as Vec3;
    const separationCos = Math.max(-1, Math.min(1, dot(dir, centerDir)));
    const separation = Math.acos(separationCos);
    const apparentRadius = Math.asin(Math.min(1, attractor.radius / centerDistance));
    const normalizedSeparation = separation / Math.max(apparentRadius, 1e-12);
    const fade = Math.max(0, Math.min(1,
      (normalizedSeparation - OCCLUSION_FADE_END) / (OCCLUSION_FADE_START - OCCLUSION_FADE_END)));
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
