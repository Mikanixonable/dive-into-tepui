// マーカーの持ち主が共有する、ワールド座標から宣言の画面座標への写し。実在の点・方向・
// 画面外の方位・進行方向の向きの4通りを扱う。
import { addScaled, len, norm, sub, type Vec3 } from '../../math/vec3';
import { strongestAttractor } from '../../physics/attractor';
import type { CelestialBody } from '../../physics/celestial-body';
import type { Projected, ProjectFn, ScaleFn } from '../../math/projection';
import type { Viewport } from '../../render/viewport';

// 方向マーカーを投影する仮想距離 [m]。実在の位置ではなく方向のみを示す。
export const MARKER_DIR_DIST = 5e4;

// 画面外の対象を指す方位マーカーを置く円の半径(画面短辺の半分に対する比)。
const MARKER_BEARING_RING_RATIO = 0.8;

// マーカー1件を置く画面座標と、画面手前にあるか。
export interface ScreenPlacement {
  readonly x: number;
  readonly y: number;
  readonly front: boolean;
}

// 実在の点を投影する。cameraPos を渡すと、重なりの解決に使う視点からの距離も返す。
export function pointPlacement(
  worldPos: Vec3, project: ProjectFn, cameraPos?: Vec3,
): ScreenPlacement & { readonly dist: number | undefined } {
  const p = project(worldPos);
  return { x: p.x, y: p.y, front: p.front, dist: cameraPos === undefined ? undefined : len(sub(worldPos, cameraPos)) };
}

// 実在の位置を持たない方向を投影する。origin から dir の向きへ MARKER_DIR_DIST だけ離した
// 仮想点を置く。origin は自機位置で統一すること。
export function directionPlacement(origin: Vec3, dir: Vec3, project: ProjectFn): ScreenPlacement {
  const p = project(addScaled(origin, norm(dir), MARKER_DIR_DIST));
  return { x: p.x, y: p.y, front: p.front };
}

// 画面外(背面を含む)の対象 p を指す方位マーカーの置き場と、上向きの記号を回す角度 [deg]。
// p が画面内に入っていれば null。
export function bearingPlacement(
  p: Projected, viewport: Viewport,
): { readonly x: number; readonly y: number; readonly rotationDeg: number } | null {
  const w = viewport.width;
  const h = viewport.height;
  if (p.front && p.x >= 0 && p.x <= w && p.y >= 0 && p.y <= h) return null;
  const cx = w / 2;
  const cy = h / 2;
  // 背面の対象は投影が反転しているので、方位も反転させる。
  const sign = p.front ? 1 : -1;
  const ang = Math.atan2(sign * (p.y - cy), sign * (p.x - cx));
  const ring = Math.min(cx, cy) * MARKER_BEARING_RING_RATIO;
  return {
    x: cx + ring * Math.cos(ang),
    y: cy + ring * Math.sin(ang),
    // atan2 の 0° は右向きなので、上向きグリフには +90°。
    rotationDeg: (ang * 180) / Math.PI + 90,
  };
}

// worldPos にいる対象の進行方向(最も強く引く天体に対する相対速度)へ上向きグリフを向ける
// 角度 [deg]。速度が視線とほぼ平行で方位が定まらなければ undefined。
export function headingRotationDeg(
  worldPos: Vec3, vel: Vec3, project: ProjectFn, scale: ScaleFn,
  celestialBodies: readonly CelestialBody[], celestialBodiesPivot = 0,
): number | undefined {
  const center = celestialBodies.length > 0
    ? strongestAttractor(worldPos, celestialBodies, celestialBodiesPivot) : null;
  const relVel = center ? sub(vel, center.stateAt(celestialBodiesPivot).v) : vel;
  // 進行方向へ少し進めた点を投影し、画面上の2点の差から方位を読む。
  const probe = Math.max(1, scale(worldPos) * 2);
  const p0 = project(worldPos);
  const p1 = project(addScaled(worldPos, norm(relVel), probe));
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  if (Math.hypot(dx, dy) < 0.1) return undefined;
  return (Math.atan2(dy, dx) * 180) / Math.PI + 90;
}
