// マップ上で右クリックの被選択対象になりうるものの共通形と、画面上で最も近い候補を選ぶ処理。
import { Vec3 } from '../math/vec3';
import type { ProjectFn } from './camera/camera-system';

export type MapPickKind = 'body' | 'ship' | 'player' | 'apsis' | 'relnode' | 'ammo' | 'fuel' | 'empty-space' | 'eqnode' | 'base';

export interface MapPickable {
  readonly id: string;
  readonly name: string;
  readonly pos: Vec3;
  readonly kind: MapPickKind;
  readonly time?: number;
  // 一覧専用の軽量な補助表示。物理状態の再計算を UI に持ち込まない。
  readonly detail?: string;
  // 区画見出しの内訳を数えるための状態。detail の文言から読み取るのではなく、値として持つ
  // — 表示文字列を変えたときに数え上げが黙って壊れないようにする。
  // approaching は敵が接近中か、collectable は弾薬/RCS燃料が回収可能な距離にあるか。
  readonly approaching?: boolean;
  readonly collectable?: boolean;
  // 自機からの距離 [m]。近傍しぼり込みと距離順の並べ替えの基準。
  readonly distance?: number;
  // 恒星からの距離 [m]。太陽系順の並べ替えの基準。恒星の無いレジストリでは undefined。
  readonly distanceFromStar?: number;
  // 一覧での表示順の優先度。小さいほど先に出る。同値なら distance 順。
  readonly priority?: number;
  readonly inFocusedSystem?: boolean;
  // このノード/オブジェクトが属するエンティティ名 (例: "Ship-1", "Base-1")
  readonly ownerName?: string;
  // 表示上のラベル衝突で隠された対象は、ダブルクリックのフォーカス候補からも外す。
  // 他種別では未指定(true扱い)にする。
  readonly pickable?: boolean;
}

// items を project で画面へ射影し、(x, y) から半径 radiusPxSq [px^2] 以内で最も近いものを返す。
// 圏外なら null。ワールド座標さえ持てば何でも渡せる(`MapPickable` である必要はない)。
export function pickNearest<T extends { readonly pos: Vec3 }>(
  items: readonly T[],
  x: number,
  y: number,
  project: ProjectFn,
  radiusPxSq: number,
): T | null {
  let best: T | null = null;
  let bestDistSq = radiusPxSq;
  for (const item of items) {
    const p = project(item.pos);
    if (!p.front) continue;
    const dx = p.x - x;
    const dy = p.y - y;
    const distSq = dx * dx + dy * dy;
    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      best = item;
    }
  }
  return best;
}
