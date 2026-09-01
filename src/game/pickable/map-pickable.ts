// マップ上で右クリックの被選択対象になりうるものの共通形と、画面上で最も近い候補を選ぶ処理。
import type { Vec3 } from '../../math/vec3';
import type { ProjectFn } from '../camera/camera-system';
import type { KinematicState } from '../../physics/kinematic-state';
import type { CelestialSystem } from '../celestial/celestial-system';
import type { MapVisibility, MapVisibilityPolicy } from '../map/visibility-policy';
import type { MarkerManager } from '../marker/marker-manager';
import type { Player } from '../player/player';
import type { MapCommands } from './map-commands';
import type { MenuItem } from '../hud/windows/context-menu';
import type { MenuAction } from '../hud/windows/menu-actions';

export type MapPickKind = 'body' | 'enemy' | 'player' | 'apsis' | 'relnode' | 'ammo' | 'fuel' | 'empty-space' | 'eqnode' | 'base';

export interface MapPickable {
  readonly id: string;
  readonly name: string;
  readonly kind: MapPickKind;
  // 所属する軌道の持ち主の名前。軌道上の点マーカーだけが持ち、他は null。
  readonly ownerName: string | null;
  // 通過時刻 [s]。時刻を持たない対象は null。
  readonly mapTime: number | null;
  // 対象そのものが消滅したか。true ならプロパティウィンドウを閉じる。
  readonly gone: boolean;
  // 軌道要素の導出に使う現在状態。天体と、実体を持たないマーカーは null。
  readonly mapState: KinematicState | null;

  // 表示時刻の ECI 位置。求まらないフレームは null で、その回は候補に出ない。
  mapPosAt(displayTime: number): Vec3 | null;
  // 表示トグルによる可否。activePlayer は操作中の自艦を例外扱いする判定に使う。
  mapVisibility(policy: MapVisibilityPolicy, activePlayer: Player | null): MapVisibility;
  // 直前のフレームで画面にマーカーが出ていたか。出ていない対象はマップ上で掴めない。
  shownOnMap(markers: MarkerManager): boolean;

  // 軌道物体一覧の行へ添える補助表示。
  listDetail(celestialSystem: CelestialSystem, activePlayer: Player | null, displayTime: number): string;
  // 軌道物体一覧の検索が照合する文字列。行に出さない情報を含めてよい。
  listSearchText(celestialSystem: CelestialSystem, activePlayer: Player | null, displayTime: number): string;
  // 区画見出しの内訳(接近 N・回収可 N)に数えるか。
  listCounted(activePlayer: Player | null, displayTime: number): boolean;
  // 軌道物体一覧での表示順の優先度。小さいほど先に出る。
  listPriority(activePlayer: Player | null): number;

  // 右クリックメニュー・プロパティウィンドウに出す操作項目。先頭の header 項目は
  // ウィンドウのタイトル/サブタイトルへ抜き出される。
  mapMenuItems(
    commands: MapCommands, celestialSystem: CelestialSystem, simTime: number,
  ): readonly MenuItem<MenuAction>[];
  // 選ばれた操作を実行する。自分が出していない act では何もしない。
  runMapMenu(act: MenuAction, commands: MapCommands): void;
}

// items を project で画面へ射影し、(x, y) から半径 radiusPxSq [px^2] 以内で最も近いものを返す。
// posOf が null を返す項目は候補から外れる。圏外なら null。
export function pickNearest<T>(
  items: readonly T[],
  posOf: (item: T) => Vec3 | null,
  x: number,
  y: number,
  project: ProjectFn,
  radiusPxSq: number,
): T | null {
  let best: T | null = null;
  let bestDistSq = radiusPxSq;
  for (const item of items) {
    const pos = posOf(item);
    if (pos === null) continue;
    const p = project(pos);
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
