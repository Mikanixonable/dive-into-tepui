// 右クリックの当たり判定にかける軌道線(公転軌道・船の軌道・軌道ガイド)の共通形と、
// 画面上でクリック位置に最も近い軌道線を選ぶ処理。MapPickable(点)と違い、線分の列に対して
// 最短距離で当たり判定する。
import { Vec3 } from '../physics/vec3';
import type { ProjectFn } from './camera/camera-system';

export type OrbitPickKind = 'orbit-body' | 'orbit-ship' | 'orbit-guide';
export type OrbitCalcMethod = 'analytic' | 'predicted' | 'guide';

export interface OrbitPickable {
  // orbitWindows のキー。対象1つにつき高々1枚のウィンドウを保つのに使う。
  readonly key: string;
  readonly kind: OrbitPickKind;
  readonly method: OrbitCalcMethod;
  // 所属する対象を指す MapPickable のキー(`${kind}:${id}`)。プロパティウィンドウの
  // 関連項目は、これで MapPickables.pickables から現在の対象を引き直して組む。
  readonly ownerKeys: readonly string[];
  // 当たり判定・描画に使う ECI 絶対座標のサンプル点列(t 昇順)。
  readonly points: readonly Vec3[];
}

// 点 (px, py) から線分 (ax,ay)-(bx,by) への最短距離の2乗(スクリーン座標)。
function distanceSqToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq <= 0) {
    const ex = px - ax, ey = py - ay;
    return ex * ex + ey * ey;
  }
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  const cx = ax + dx * t, cy = ay + dy * t;
  const ex = px - cx, ey = py - cy;
  return ex * ex + ey * ey;
}

// orbits を画面へ射影し、(x, y) から最短距離が radiusPxSq [px^2] 以内で最も近いものを返す。
// 圏外・視界の裏側の点は候補にしない。
export function pickNearestOrbit(
  orbits: readonly OrbitPickable[], x: number, y: number, project: ProjectFn, radiusPxSq: number,
): OrbitPickable | null {
  let best: OrbitPickable | null = null;
  let bestDistSq = radiusPxSq;
  for (const orbit of orbits) {
    let prevX = 0, prevY = 0, hasPrev = false;
    for (const point of orbit.points) {
      const p = project(point);
      if (!p.front) {
        hasPrev = false;
        continue;
      }
      if (hasPrev) {
        const d = distanceSqToSegment(x, y, prevX, prevY, p.x, p.y);
        if (d < bestDistSq) {
          bestDistSq = d;
          best = orbit;
        }
      }
      prevX = p.x;
      prevY = p.y;
      hasPrev = true;
    }
  }
  return best;
}
