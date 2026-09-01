// 右クリックの当たり判定にかける線(公転軌道・船の軌道・軌道ガイド・ターゲット相対の直線)の
// 共通形と、画面上でクリック位置に最も近いものを選ぶ処理。線分の列に対して最短距離で当てる。
// 運ぶのは ECI の点列だけで、基準となる重力源を伴わない。`kind` / `method` の値は
// 「何を描いた線か」のラベル。
import { Vec3 } from '../../math/vec3';
import { isOccluded } from '../../physics/occlusion';
import type { CelestialMotion } from '../../physics/celestial-motion';
import type { ProjectFn } from '../camera/camera-system';

type LinePickKind = 'orbit-body' | 'orbit-ship' | 'orbit-guide';
export type LineCalcMethod = 'analytic' | 'predicted' | 'guide';

export interface LinePickable {
  // lineWindows のキー。対象1つにつき高々1枚のウィンドウを保つのに使う。
  readonly key: string;
  readonly kind: LinePickKind;
  readonly method: LineCalcMethod;
  // 所属する対象を指す被選択物の id。プロパティウィンドウの関連項目は、これで現在の対象を
  // 引き直して組む。
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
// 圏外・視界の裏側・天体に遮られた点は候補にせず、そこで線分を切る(SPEC/MAP.md §11)。
// 遮蔽は celestialBodies を pivot の時刻で引いて判定するので、pivot には候補の点を求めた
// 表示時刻を渡す。
export function pickNearestLine(
  orbits: readonly LinePickable[], x: number, y: number, project: ProjectFn, radiusPxSq: number,
  cameraPos: Vec3, celestialBodies: readonly CelestialMotion[], pivot: number,
): LinePickable | null {
  let best: LinePickable | null = null;
  let bestDistSq = radiusPxSq;
  for (const orbit of orbits) {
    let prevX = 0, prevY = 0, hasPrev = false;
    for (const point of orbit.points) {
      const p = project(point);
      if (!p.front || isOccluded(cameraPos, point, celestialBodies, pivot)) {
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
