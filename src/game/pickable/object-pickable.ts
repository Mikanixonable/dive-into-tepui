// 右クリック・一覧・選択ウィジェットから選べる物体の共通形と、画面上で最も近い候補を選ぶ処理。
// マップでしか通らない面だけ map / list を冠し、両ビューで通る面は無標にする。
import { lenSq, sub, type Vec3 } from '../../math/vec3';
import type { Ray } from '../../math/ray';
import type { Projected } from '../../math/projection';
import type { ProjectFn } from '../camera/camera-system';
import type { KinematicState } from '../../physics/kinematic-state';
import type { CelestialSystem } from '../celestial/celestial-system';
import type { MapVisibility, MapVisibilityPolicy } from '../map/visibility-policy';
import type { MarkerManager } from '../marker/marker-manager';
import type { Controllable } from '../dynamic/dynamic-entity/controllable';
import type { DynamicEntity } from '../dynamic/dynamic-entity/dynamic-entity';
import type { ObjectCommands } from './object-commands';
import type { MenuItem } from '../hud/windows/context-menu';
import type { MenuAction } from '../hud/windows/menu-actions';
import type { MapListSection } from '../hud/panels/physical-object-list-panel';
import type { ObjectPickerGenre } from '../hud/object-groups';
import type { PropertyRow } from '../../hud/windows/property-window';

export interface ObjectPickable {
  readonly id: string;
  readonly name: string;
  // 対象そのものが消滅したか。true ならプロパティウィンドウを閉じる。
  readonly gone: boolean;
  // 軌道要素の導出に使う現在状態。天体と、実体を持たないマーカーは null。
  readonly orbitState: KinematicState | null;
  // 一覧・プロパティウィンドウに添える形態記号。SVG を描ける場所は glyphSvg を優先する。
  readonly glyph: string;
  readonly glyphSvg: string | null;
  // 軌道物体一覧のどの区画へ出すか。一覧に出さない対象は null。
  readonly listSection: MapListSection | null;
  // 選択ウィジェット(ObjectPicker)のどのジャンルへ出すか。出さない対象は null。
  readonly pickerGenre: ObjectPickerGenre | null;
  // 天体に遮られている間は選べなくなるか。天体自身は遮蔽で候補から外さない
  // (公転・カメラ移動のたびに一覧の行が明滅するため)。
  readonly hiddenBehindBodies: boolean;
  // フォーカス中の惑星系に属するときだけ候補に出すか。
  readonly onlyInFocusedSystem: boolean;

  // 表示時刻の ECI 位置。求まらないフレームは null で、その回は候補に出ない。
  posAt(displayTime: number): Vec3 | null;
  // 表示トグルによる可否。viewer は操作中の対象を例外扱いする判定に使う。
  mapVisibility(policy: MapVisibilityPolicy, viewer: Controllable | null): MapVisibility;
  // 直前のフレームで画面にマーカーが出ていたか。出ていない対象はマップ上で掴めない。
  shownOnMap(markers: MarkerManager): boolean;

  // 軌道物体一覧の行へ添える補助表示。
  listDetail(celestialSystem: CelestialSystem, viewer: Controllable | null, displayTime: number): string;
  // 軌道物体一覧の検索が照合する文字列。行に出さない情報を含めてよい。
  listSearchText(celestialSystem: CelestialSystem, viewer: Controllable | null, displayTime: number): string;
  // 区画見出しの内訳(接近 N・回収可 N)に数えるか。
  listCounted(viewer: Controllable | null, displayTime: number): boolean;
  // 軌道物体一覧での表示順の優先度。小さいほど先に出る。
  listPriority(viewer: Controllable | null): number;

  // 右クリックメニュー・プロパティウィンドウに出す操作項目。先頭の header 項目は
  // ウィンドウのタイトル/サブタイトルへ抜き出される。出せない項目を自分で間引く必要はない
  // — 出せるかどうか(航法ターゲットの可否・物体の配置の可否)は窓側が絞る。
  menuItems(
    celestialSystem: CelestialSystem, viewer: Controllable | null, navTargetId: string | null,
  ): readonly MenuItem<MenuAction>[];
  // 自分に固有の操作を実行する。フォーカス・ターゲット・複製など、対象によらない操作は
  // 窓側が実行するのでここへは来ない。固有の操作を持たない対象は null。
  readonly runMenu: ((act: MenuAction, commands: ObjectCommands) => void) | null;

  // プロパティウィンドウに出す行。simTime は天体位置を厳密に引く時刻、displayTime は
  // 候補の位置を引き直す時刻。
  propertyRows(
    celestialSystem: CelestialSystem, viewer: Controllable | null, simTime: number, displayTime: number,
  ): readonly PropertyRow[];
  // 名前を書き換えられる対象だけが持つ。改名できない対象は null。
  readonly rename: ((name: string) => void) | null;

  // マップの左クリックで選ばれたときの振る舞い。左クリックで掴めない対象は null。
  readonly onMapSelect: ((commands: ObjectCommands, clientX: number, clientY: number) => void) | null;
  // マップの注視点が自分へ移ったときに、注視の移動に加えて起きること。何も起きない対象は null。
  readonly onMapFocus: ((commands: ObjectCommands) => void) | null;

  // 視線が、pos に描かれているこの対象の本体へ当たるか。pos は posAt が答えた、いま
  // 描かれている位置。本体を持たず、マーカーだけで示される対象は常に false。
  hitBodyByRay(ray: Ray, pos: Vec3): boolean;
}

// この個体が被選択物として公開されるか。顔ぶれから被選択物だけを絞るときに使う。
export function isObjectPickable(entity: DynamicEntity): entity is DynamicEntity & ObjectPickable {
  return entity.pickable;
}

// items を screenPosOf で画面へ射影し、(x, y) から半径 radiusPxSq [px^2] 以内で最も近いものを
// 返す。null を返す項目と視点の背後の項目は候補から外れる。圏外なら null。
export function pickNearest<T>(
  items: readonly T[],
  screenPosOf: (item: T) => Projected | null,
  x: number,
  y: number,
  radiusPxSq: number,
): T | null {
  let best: T | null = null;
  let bestDistSq = radiusPxSq;
  for (const item of items) {
    const p = screenPosOf(item);
    if (p === null || !p.front) continue;
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

// 表示時刻のマーカー位置を画面へ射影する。位置が求まらないフレームは null。
export function projectMarker(
  item: ObjectPickable, displayTime: number, project: ProjectFn,
): Projected | null {
  const pos = item.posAt(displayTime);
  return pos === null ? null : project(pos);
}

// 視線が本体に当たった候補のうち、視点(= 視線の始点)にもっとも近いものを返す。当たらなければ
// null。位置が求まらない候補は本体判定に掛けない。
export function pickFrontmostBody(
  items: readonly ObjectPickable[], ray: Ray, displayTime: number,
): ObjectPickable | null {
  let best: ObjectPickable | null = null;
  let bestDistSq = Infinity;
  for (const item of items) {
    const pos = item.posAt(displayTime);
    if (pos === null) continue;
    const distSq = lenSq(sub(pos, ray.origin));
    if (distSq >= bestDistSq || !item.hitBodyByRay(ray, pos)) continue;
    bestDistSq = distSq;
    best = item;
  }
  return best;
}
