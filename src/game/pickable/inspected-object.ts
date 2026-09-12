// 右クリックメニューとプロパティウィンドウへ中身を差し出す物体。出す操作項目とプロパティ行、
// 固有の操作の実行、改名の受け口を答える。
import type { CelestialBodies } from '../celestial/celestial-bodies';
import type { ControlSelection } from '../control-selection';
import type { DynamicEntityKind } from '../dynamic/dynamic-entity/entity-kind';
import type { OrbitingObject } from '../dynamic/dynamic-entity/orbiting-object';
import type { MenuItem } from '../hud/windows/context-menu';
import type { MenuAction } from '../hud/windows/menu-actions';
import type { PlanEditor } from '../plan/plan-editor';
import type { PropertyRow } from '../../hud/windows/property-window-content';
import type { KinematicState } from '../../physics/kinematic-state';
import type { PickCandidate } from './pick-candidate';

// 軌道上へオブジェクトを配置・複製する編集機能。これを持つステージだけがマップの
// 「配置」「複製」項目を出す。focusId はマップの現在フォーカスで、基準天体の初期選択に使う。
export interface ObjectAuthoring {
  openObjectPlacer(focusId?: string): void;
  openObjectPlacerForDuplicate(entityKind: DynamicEntityKind, state: KinematicState): void;
}

export interface InspectedObject extends PickCandidate {
  // 右クリックメニュー・プロパティウィンドウに出す操作項目。先頭の header 項目は
  // ウィンドウのタイトル/サブタイトルへ抜き出される。出せない項目を自分で間引く必要はない
  // — 出せるかどうか(航法ターゲットの可否・物体の配置の可否)は窓側が絞る。
  menuItems(
    celestialBodies: CelestialBodies, viewer: OrbitingObject | null, navTargetId: string | null,
  ): readonly MenuItem<MenuAction>[];
  // 自分に固有の操作を実行する。フォーカス・ターゲットなど対象によらない操作は窓側が
  // 実行するのでここへは来ない。固有の操作を持たない対象は null。authoring と planEditor は
  // マップでしか差し出されないので、戦闘ビューでは null。
  readonly runMenu: ((
    act: MenuAction, controlSelection: ControlSelection, authoring: ObjectAuthoring | null,
    planEditor: PlanEditor | null,
  ) => void) | null;

  // プロパティウィンドウに出す行。simTime は天体位置を厳密に引く時刻、displayTime は
  // 候補の位置を引き直す時刻。
  propertyRows(
    celestialBodies: CelestialBodies, viewer: OrbitingObject | null, simTime: number, displayTime: number,
  ): readonly PropertyRow[];
  // 名前を書き換えられる対象だけが持つ。改名できない対象は null。
  readonly rename: ((name: string) => void) | null;
}
