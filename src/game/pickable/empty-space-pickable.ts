// 何にも当たらなかったクリックが指す「宇宙空間」の被選択物。実体を持たず、原点を位置とする。
import { v3, type Vec3 } from '../../math/vec3';
import { MARKER_VISIBILITY, type MapVisibility } from '../map/visibility-policy';
import { MenuCommon, type MenuAction } from '../hud/windows/menu-actions';
import type { ObjectPickable } from './object-pickable';
import type { MenuItem } from '../hud/windows/context-menu';
import type { PropertyRow } from '../../hud/windows/property-window-content';
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

  // メニューに出す操作項目。配置の項目を出せるかは窓側が決める。
  public menuItems(): readonly MenuItem<MenuAction>[] {
    return [
      { label: 'オブジェクトを配置する', act: 'openObjectPlacer', shortcut: 'Enter' },
      { label: '設定メニューを開く', act: 'openSettings' },
      MenuCommon.cancel(),
    ];
  }

  public readonly runMenu = null;

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
