// ラグランジュ点を指す、実体を持たない被選択物。生成元が解いた時刻の位置を持ち、天体と同じ
// 名前空間の id と、マップのマーカーへ出す二行表記を答える。
import { lagrangeId, type LagrangePointNumber } from '../celestial/lagrange-id';
import { len, sub, type Vec3 } from '../../math/vec3';
import type { MapVisibility, MapVisibilityPolicy } from '../map/visibility-policy';
import { bodySearchText } from '../pickable/body-search-text';
import { fmtDist } from '../../hud/utils';
import { MenuCommon, type MenuAction } from '../hud/windows/menu-actions';
import { ENTITY_GLYPH } from './marker-identity';
import { MARKER_PRIORITY } from './marker-manager';
import type { CelestialSystem } from '../celestial/celestial-system';
import type { MapListSection } from '../hud/panels/physical-object-list-panel';
import type { ObjectPickerGenre } from '../hud/object-groups';
import type { ObjectCommands } from '../pickable/object-commands';
import type { ObjectPickable } from '../pickable/object-pickable';
import type { MenuItem } from '../hud/windows/context-menu';
import type { Player } from '../player/player';
import type { PropertyRow } from '../../hud/windows/property-window';
import type { MarkerManager } from './marker-manager';

export class LagrangePointMarker implements ObjectPickable {
  public readonly id: string;
  public readonly name: string;
  // 地点名を上、所属天体を下の行に置く二行表記。
  public readonly markerLabel: string;
  // マーカーの CSS クラス。
  public readonly markerClass = 'mk-poi mk-lagrange';
  // ラベルが混雑したときに優先して残す度合い。大きいほど残る。
  public readonly labelPriority = MARKER_PRIORITY.LAGRANGE;
  public readonly orbitState = null;
  public readonly glyph = ENTITY_GLYPH.lagrange;
  public readonly glyphSvg = null;
  public readonly listSection: MapListSection = 'body';
  public readonly pickerGenre: ObjectPickerGenre = 'ラグランジュ点';
  public readonly hiddenBehindBodies = false;
  public readonly onlyInFocusedSystem = false;

  private pos: Vec3 | null = null;

  // 親天体と点番号で1つの地点が決まる。名前は所属天体を前に置き、一覧では親の直下に並ぶ。
  public constructor(
    public readonly parentId: string,
    parentName: string,
    public readonly point: LagrangePointNumber,
  ) {
    this.id = lagrangeId(parentId, point);
    this.name = `${parentName}-L${point}`;
    this.markerLabel = `L${point}\n${parentName}`;
  }

  // 今フレームの位置を記録する。求まらなかったフレームは null を渡す。
  public place(pos: Vec3 | null): void {
    this.pos = pos;
  }

  public get gone(): boolean { return this.pos === null; }

  // 生成元が解いた時刻の位置。
  public posAt(): Vec3 | null { return this.pos; }
  // アイコンだけで示され、視線を通せる本体を持たない。
  public hitBodyByRay(): boolean { return false; }

  // ラグランジュ点は天体と別の表示トグルを持つ。
  public mapVisibility(policy: MapVisibilityPolicy): MapVisibility { return policy.body(this.id); }
  public shownOnMap(markers: MarkerManager): boolean { return markers.shows(this.id); }

  // メニューに出す操作項目。ヘッダーの副題には、この地点を定める2天体の対を出す。
  public menuItems(
    commands: ObjectCommands, celestialSystem: CelestialSystem, simTime: number,
  ): readonly MenuItem<MenuAction>[] {
    const primaryId = celestialSystem.bodyParentId(this.parentId);
    const subLabel = primaryId === undefined || primaryId === null
      ? 'ラグランジュ点'
      : `${celestialSystem.nameOf(primaryId)}-${celestialSystem.nameOf(this.parentId)} ラグランジュ点`;
    return [
      { type: 'header', label: this.name, subLabel },
      MenuCommon.focus(),
      ...MenuCommon.targetItems(commands, this.id, simTime),
      MenuCommon.cancel(),
    ];
  }

  // 選ばれた操作を実行する。フォーカスの移動と航法ターゲットの設定・解除を持つ。
  public runMenu(act: MenuAction, commands: ObjectCommands): void {
    if (act === 'focus') {
      commands.focus(this.id, this.name);
    } else if (act === 'target') {
      commands.toggleNavTarget(this.id, this.name);
    }
  }

  // 自艦からの距離と種別。自艦がいない、あるいは位置が解けていないフレームは距離が落ちる。
  public propertyRows(commands: ObjectCommands): readonly PropertyRow[] {
    const viewer = commands.activePlayer;
    const pos = this.posAt();
    const rows: PropertyRow[] = [];
    if (viewer && pos) {
      rows.push({ key: 'dist', label: '自艦からの距離', value: fmtDist(len(sub(pos, viewer.state.r))) });
    }
    rows.push({ key: 'kind', label: '種別', value: 'ラグランジュ点' });
    return rows;
  }

  public readonly rename = null;
  public readonly onMapSelect = null;
  public readonly onMapFocus = null;

  public listDetail(): string { return ''; }

  // 一覧の検索が照合する、自艦からの距離と中心天体の名前。
  public listSearchText(
    celestialSystem: CelestialSystem, activePlayer: Player | null, displayTime: number,
  ): string {
    return this.pos === null ? '' : bodySearchText(celestialSystem, this.pos, activePlayer, displayTime);
  }

  public listCounted(): boolean { return false; }
  public listPriority(): number { return 0; }
}
