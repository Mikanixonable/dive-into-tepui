// 何にも当たらなかったクリックが指す「宇宙空間」の被選択物。実体を持たず、原点を位置とする。
import { v3, type Vec3 } from '../../math/vec3';
import { MARKER_VISIBILITY, type MapVisibility } from '../map/visibility-policy';
import { MenuCommon, type MenuAction } from '../hud/windows/menu-actions';
import type { MapCommands } from './map-commands';
import type { MapPickable } from './map-pickable';
import type { MenuItem } from '../hud/windows/context-menu';
import type { PropertyRow } from '../hud/windows/property-window';
import type { MarkerManager } from '../marker/marker-manager';

const ORIGIN = v3(0, 0, 0); // ECI [m]

export class EmptySpacePickable implements MapPickable {
  public readonly id = 'empty';
  public readonly name = '宇宙空間';
  public readonly ownerName = null;
  public readonly mapTime = null;
  public readonly mapState = null;
  public readonly gone = false;
  public readonly mapGlyph = '·';
  public readonly mapGlyphSvg = null;
  public readonly listSection = null;
  public readonly pickerGenre = null;
  public readonly hiddenBehindBodies = true;
  public readonly onlyInFocusedSystem = false;

  // 宇宙空間そのものを指すので、いつでも原点を返す。
  public mapPosAt(): Vec3 { return ORIGIN; }
  // 宇宙空間そのものを指すので、視線を通せる本体を持たない。
  public hitBodyByRay(): boolean { return false; }

  public mapVisibility(): MapVisibility { return MARKER_VISIBILITY; }
  public shownOnMap(markers: MarkerManager): boolean { return markers.shows(this.id); }

  // メニューに出す操作項目。物体を置けるステージのマップ視点では、配置の項目が加わる。
  public mapMenuItems(commands: MapCommands): readonly MenuItem<MenuAction>[] {
    const placeItem: readonly MenuItem<MenuAction>[] = commands.canAuthor && commands.overviewMode
      ? [{ label: 'オブジェクトを配置する', act: 'openObjectPlacer', shortcut: 'Enter' }]
      : [];
    return [
      ...placeItem,
      { label: '設定メニューを開く', act: 'openSettings' },
      MenuCommon.cancel(),
    ];
  }

  // 選ばれた操作を実行する。物体配置パネルと設定メニューを開く操作を持つ。
  public runMapMenu(act: MenuAction, commands: MapCommands): void {
    if (act === 'openObjectPlacer') {
      commands.openObjectPlacer();
    } else if (act === 'openSettings') {
      commands.openSettings();
    }
  }

  // 宇宙空間そのものを指すので、示せる値は空になる。
  public mapPropertyRows(): readonly PropertyRow[] { return []; }

  public readonly mapRename = null;
  public readonly selectOnMap = null;
  public readonly onMapFocus = null;

  public listDetail(): string { return ''; }
  public listSearchText(): string { return ''; }
  public listCounted(): boolean { return false; }
  public listPriority(): number { return 0; }
}
