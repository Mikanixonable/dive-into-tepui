// カメラ視点からワールド座標への視線が、いずれかの天体の球体に遮られているかどうかの
// 純幾何判定(レイと球の交差)。マップビューでの軌道要素アイコンの表示可否とピック候補の
// 選出可否は、この1関数を両方が呼ぶことで揃える — 見えているのに押せない/見えないのに
// 押せる、という食い違いを防ぐ。
import { Attractor } from './attractor';
import { dot, sub, Vec3 } from './vec3';

// 手前側交点が対象点よりこの距離以上カメラ寄りのときだけ遮蔽と判定する余裕。対象点自身が
// その天体の表面上・近傍にある(その天体を回っている物体など)場合に、丸め誤差で
// 自己遮蔽と誤判定しないためのマージン。
const OCCLUSION_MARGIN = 1;

// cameraPos から point への視線が attractors のいずれかの球体に遮られていれば true。
export function isOccluded(cameraPos: Vec3, point: Vec3, attractors: readonly Attractor[]): boolean {
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
    const d2 = dot(oc, oc) - tca * tca;
    const r2 = attractor.radius * attractor.radius;
    if (d2 >= r2) continue; // 視線が球を外れる
    const thc = Math.sqrt(r2 - d2);
    const t0 = tca - thc; // 球の手前側交点までの距離
    if (t0 > 0 && t0 < dist - OCCLUSION_MARGIN) return true;
  }
  return false;
}
