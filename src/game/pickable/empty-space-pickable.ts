// 何にも当たらなかったクリックが指す「宇宙空間」の被選択物。実体を持たず、原点を位置とする。
import { v3, type Vec3 } from '../../math/vec3';
import { MARKER_VISIBILITY, type MapVisibility } from '../map/visibility-policy';
import { MenuCommon, type MenuAction } from '../hud/windows/menu-actions';
import type { ObjectCommands } from './object-commands';
import type { ObjectPickable } from './object-pickable';
import type { MenuItem } from '../hud/windows/context-menu';
import type { PropertyRow } from '../../hud/windows/property-window';
import type { MarkerManager } from '../marker/marker-manager';

const ORIGIN = v3(0, 0, 0); // ECI [m]

export class EmptySpacePickable implements ObjectPickable {
  public readonly id = 'empty';
  public readonly name = '宇宙空間';
  public readonly orbitState = null;
  public readonly gone = false;
  public readonly glyph = '·';
  public readonly glyphSvg = null;
  public readonly listSection = null;
  public readonly pickerGenre = null;
  public readonly hiddenBehindBodies = true;
  public readonly onlyInFocusedSystem = false;

  // 宇宙空間そのものを指すので、いつでも原点を返す。
  public posAt(): Vec3 { return ORIGIN; }
  // 宇宙空間そのものを指すので、視線を通せる本体を持たない。
  public hitBodyByRay(): boolean { return false; }

  public mapVisibility(): MapVisibility { return MARKER_VISIBILITY; }
  public shownOnMap(markers: MarkerManager): boolean { return markers.shows(this.id); }

  // メニューに出す操作項目。物体を置けるステージのマップ視点では、配置の項目が加わる。
  public menuItems(commands: ObjectCommands): readonly MenuItem<MenuAction>[] {
    const placeItem: readonly MenuItem<MenuAction>[] = commands.canAuthor && commands.view === 'map'
      ? [{ label: 'オブジェクトを配置する', act: 'openObjectPlacer', shortcut: 'Enter' }]
      : [];
    return [
      ...placeItem,
      { label: '設定メニューを開く', act: 'openSettings' },
      MenuCommon.cancel(),
    ];
  }

  // 選ばれた操作を実行する。物体配置パネルと設定メニューを開く操作を持つ。
  public runMenu(act: MenuAction, commands: ObjectCommands): void {
    if (act === 'openObjectPlacer') {
      commands.openObjectPlacer();
    } else if (act === 'openSettings') {
      commands.openSettings();
    }
  }

  // 宇宙空間そのものを指すので、示せる値は空になる。
  public propertyRows(): readonly PropertyRow[] { return []; }

  public readonly rename = null;
  public readonly onMapSelect = null;
  public readonly onMapFocus = null;

  public listDetail(): string { return ''; }
  public listSearchText(): string { return ''; }
  public listCounted(): boolean { return false; }
  public listPriority(): number { return 0; }
}
