// 右クリックメニューとプロパティウィンドウへ情報を提示するオブジェクト。表示する操作項目・プロパティ行、
// 固有操作の実行処理、および名称変更のインターフェースを提供する。
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
  // trajectoryLineShown はこの対象の予測線・過去線を出しているか。
  menuItems(
    celestialBodies: CelestialBodies, viewer: OrbitingObject | null, navTargetId: string | null,
    trajectoryLineShown: boolean,
  ): readonly MenuItem<MenuAction>[];
  // 対象固有の操作を処理する。フォーカスやターゲットなど対象に依存しない操作は
  // ウィンドウ側で処理するため、ここには渡されない。固有操作を持たない対象は null。
  // authoring と planEditor はマップ画面でのみ提供されるため、戦闘ビューでは null。
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
