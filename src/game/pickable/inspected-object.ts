// 右クリックメニューとプロパティウィンドウに中身を差し出す物体。何を出すか・固有の操作で何が
// 起きるかは対象自身が答え、出せるかどうかの絞り込みと窓の組み立ては窓側が持つ。
import type { CelestialBodies } from '../celestial/celestial-bodies';
import type { ControlSelection } from '../control-selection';
import type { Viewer } from '../dynamic/dynamic-entity/viewer';
import type { MenuItem } from '../hud/windows/context-menu';
import type { MenuAction } from '../hud/windows/menu-actions';
import type { PlanEditor } from '../plan/plan-editor';
import type { ObjectAuthoring } from '../stages/stage';
import type { PropertyRow } from '../../hud/windows/property-window-content';
import type { PickCandidate } from './pick-candidate';

export interface InspectedObject extends PickCandidate {
  // 右クリックメニュー・プロパティウィンドウに出す操作項目。先頭の header 項目は
  // ウィンドウのタイトル/サブタイトルへ抜き出される。出せない項目を自分で間引く必要はない
  // — 出せるかどうか(航法ターゲットの可否・物体の配置の可否)は窓側が絞る。
  menuItems(
    celestialBodies: CelestialBodies, viewer: Viewer | null, navTargetId: string | null,
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
    celestialBodies: CelestialBodies, viewer: Viewer | null, simTime: number, displayTime: number,
  ): readonly PropertyRow[];
  // 名前を書き換えられる対象だけが持つ。改名できない対象は null。
  readonly rename: ((name: string) => void) | null;
}
