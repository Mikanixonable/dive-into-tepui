// 右クリックの当たり判定にかける線(公転軌道・船の軌道・軌道ガイド・ターゲット相対の直線)の
// 共通形と、画面上でクリック位置に最も近いものを選ぶ処理。線分の列に対して最短距離で当てる。
import { Vec3 } from '../../math/vec3';
import { isOccluded } from '../../physics/occlusion';
import type { CelestialBody } from '../../physics/celestial-body';
import type { ProjectFn } from '../../math/projection';

type LinePickKind = 'orbit-body' | 'orbit-ship' | 'orbit-guide';
type LineCalcMethod = 'analytic' | 'numeric' | 'guide';

export interface LinePickable {
  // 線1本を、フレームを跨いで識別するキー。
  readonly key: string;
  // 何を描いた線か・どう求めた線かのラベル。
  readonly kind: LinePickKind;
  readonly method: LineCalcMethod;
  // この線が属する対象(被選択物の id)。
  readonly ownerKeys: readonly string[];
  // 当たり判定・描画に使う ECI 絶対座標のサンプル点列(t 昇順)。
  readonly points: readonly Vec3[];
}

// 点 (px, py) から線分 (ax,ay)-(bx,by) への最短距離の2乗(スクリーン座標)。
function distanceSqToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  // 長さ 0 の線分は端点までの距離。
  if (lenSq <= 0) {
    const ex = px - ax, ey = py - ay;
    return ex * ex + ey * ey;
  }
  // 線分上の最近点。
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  const cx = ax + dx * t, cy = ay + dy * t;
  const ex = px - cx, ey = py - cy;
  return ex * ex + ey * ey;
}

// orbits を画面へ射影し、(x, y) から radiusPxSq [px^2] 以内で最も近い線を返す。無ければ null。
// 視界の裏側・天体に遮られた点で線分を切る(SPEC/MAP.md §11)。pivot には点列を求めた表示時刻を
// 渡す — 遮る天体の位置をその時刻で引く。
export function pickNearestLine(
  orbits: readonly LinePickable[], x: number, y: number, project: ProjectFn, radiusPxSq: number,
  cameraPos: Vec3, celestialBodies: readonly CelestialBody[], pivot: number,
): LinePickable | null {
  let best: LinePickable | null = null;
  let bestDistSq = radiusPxSq;
  for (const orbit of orbits) {
    let prevX = 0, prevY = 0, hasPrev = false;
    for (const point of orbit.points) {
      // 写らない点・遮られた点で線を切る。
      const p = project(point);
      if (!p.front || isOccluded(cameraPos, point, celestialBodies, pivot)) {
        hasPrev = false;
        continue;
      }
      // 直前の点との線分で距離を測る。
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
