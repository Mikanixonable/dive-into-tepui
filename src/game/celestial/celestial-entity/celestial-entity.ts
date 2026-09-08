// 天体1体のゲーム上の識別情報と、物理・表示の所有者を結び付ける。
import type { CelestialMotion } from '../../../physics/celestial-motion';
import { apsisAltitudes, orbitalElementsOf } from '../../../physics/elements';
import { len, sub } from '../../../math/vec3';
import { bodyEntityGlyph } from '../../marker/marker-identity';
import { MARKER_PRIORITY } from '../../marker/crowding';
import { bodySearchText } from '../../pickable/body-search-text';
import { fmtDist, fmtTime } from '../../../hud/utils';
import { getApsisLabelSpec, ORBIT_ELEMENT_LABELS } from '../../hud/orbit/orbit-labels';
import { MenuCommon, type MenuAction } from '../../hud/windows/menu-actions';
import { hitsSphere, type Ray } from '../../../math/ray';
import type { MarkerSlots } from '../../marker/marker-slots';
import type { CelestialClass } from './celestial-entity-def';
import type { Vec3 } from '../../../math/vec3';
import type { CelestialView } from './celestial-view';
import type { CelestialSystem } from '../celestial-system';
import type { ObjectPickable } from '../../pickable/object-pickable';
import type { MenuItem } from '../../hud/windows/context-menu';
import type { PropertyRow } from '../../../hud/windows/property-window-content';
import { BODY_PICKER_GENRES, type MapListSection, type ObjectPickerGenre } from '../../pickable/pickable-listing';
import type { MapVisibility, MapVisibilityPolicy } from '../../map/visibility-policy';
import type { OrbitingObject } from '../../dynamic/dynamic-entity/orbiting-object';

// 惑星 > 準惑星 > 衛星・小惑星・彗星。恒星は太陽系の基準点なので、惑星と同じ最上位に置く。
const BODY_LABEL_PRIORITY: Readonly<Record<CelestialClass, number>> = {
  star: MARKER_PRIORITY.STAR_PLANET,
  planet: MARKER_PRIORITY.STAR_PLANET,
  dwarf: MARKER_PRIORITY.DWARF_PLANET,
  satellite: MARKER_PRIORITY.SATELLITE_SMALL_BODY,
  smallBody: MARKER_PRIORITY.SATELLITE_SMALL_BODY,
};

export class CelestialEntity implements ObjectPickable {
  public readonly id: string;

  public constructor(
    public readonly motion: CelestialMotion,
    public readonly name: string,
    public readonly bodyClass: CelestialClass,
    public readonly view: CelestialView,
  ) {
    this.id = motion.id;
  }

  // 天体ラベルとしての振る舞い。
  // マップのマーカーへ描く表記。
  public get markerLabel(): string { return this.name; }
  // マーカーの CSS クラス。
  public readonly markerClass = 'mk-poi';
  // ラベルが混雑したときに優先して残す度合い。大きいほど残る。
  public get labelPriority(): number { return BODY_LABEL_PRIORITY[this.bodyClass]; }

  // 被選択物(ObjectPickable)としての振る舞い。
  public readonly gone = false;
  public readonly orbitState = null;
  public get glyph(): string { return bodyEntityGlyph(this.bodyClass); }
  public readonly glyphSvg = null;
  public readonly listSection: MapListSection = 'body';
  public get pickerGenre(): ObjectPickerGenre { return BODY_PICKER_GENRES[this.bodyClass]; }
  public readonly hiddenBehindBodies = false;
  public readonly onlyInFocusedSystem = false;
  public listPriority(): number { return 0; }
  public listCounted(): boolean { return false; }
  public listDetail(): string { return ''; }

  // 表示時刻の ECI 位置。
  public posAt(displayTime: number): Vec3 {
    return this.motion.stateAt(displayTime).r;
  }

  // 天体の本体は表面半径の球。
  public hitBodyByRay(ray: Ray, pos: Vec3): boolean {
    return hitsSphere(ray, pos, this.motion.def.radius);
  }

  // 分類・名前トグルによる可否。
  public mapVisibility(policy: MapVisibilityPolicy): MapVisibility {
    return policy.body(this.id);
  }

  public shownOnMap(markers: MarkerSlots): boolean { return markers.shows(this.id); }

  // 一覧の検索が照合する、自艦からの距離と中心天体の名前。
  public listSearchText(
    celestialSystem: CelestialSystem, viewer: OrbitingObject | null, displayTime: number,
  ): string {
    return bodySearchText(celestialSystem, this.posAt(displayTime), viewer, displayTime);
  }

  // 右クリックメニュー・プロパティウィンドウに出す操作項目。
  public menuItems(
    celestialSystem: CelestialSystem, _viewer: OrbitingObject | null, navTargetId: string | null,
  ): readonly MenuItem<MenuAction>[] {
    // 副題は星系の中での役どころ。
    const subLabel = this.id === celestialSystem.origin.id ? '母星 (中心天体)'
      : this.id === 'moon' ? '衛星 (月)'
        : this.id === celestialSystem.star?.id ? `恒星 (${this.name})`
          : '天体・ラグランジュ点';
    return [
      { type: 'header', label: this.name, subLabel },
      MenuCommon.focus(),
      MenuCommon.target(navTargetId === this.id),
      MenuCommon.cancel(),
    ];
  }

  public readonly runMenu = null;

  // プロパティウィンドウに出す行。種別・μ・半径を主要行とし、公転していれば軌道要素を
  // 「軌道」グループの下に畳む。viewer が null なら距離の行は落ちる。
  public propertyRows(
    _celestialSystem: CelestialSystem, viewer: OrbitingObject | null, simTime: number, displayTime: number,
  ): readonly PropertyRow[] {
    const motion = this.motion;
    const def = motion.def;
    const rows: PropertyRow[] = [];
    if (viewer !== null) {
      const dist = len(sub(this.posAt(displayTime), viewer.state.r));
      rows.push({ key: 'dist', label: '自艦からの距離', value: fmtDist(dist) });
    }
    const kindLabel = motion.kind === 'star' ? '恒星' : motion.kind === 'planet' ? '惑星' : '衛星';
    rows.push(
      { key: 'kind', label: '種別', value: kindLabel },
      { key: 'mu', label: 'μ', value: `${def.mu.toExponential(3)} m³/s²` },
      { key: 'radius', label: '半径', value: fmtDist(def.radius) },
    );
    // 軌道要素は公転天体だけが持つ。
    if (motion.kind === 'star') return rows;
    const primary = motion.primary;
    const el = primary !== null ? orbitalElementsOf(motion.stateAt(simTime), primary, simTime) : null;
    if (el === null) return rows;
    const apsis = apsisAltitudes(el);
    const apSpec = getApsisLabelSpec('ap', el.center.id);
    const peSpec = getApsisLabelSpec('pe', el.center.id);
    rows.push(
      { key: 'ap', label: apSpec.full, value: fmtDist(apsis.ap), group: '軌道' },
      { key: 'pe', label: peSpec.full, value: fmtDist(apsis.pe), group: '軌道' },
      { key: 'inc', label: ORBIT_ELEMENT_LABELS.inc.full, value: `${el.incDeg.toFixed(2)}°`, group: '軌道' },
      { key: 'prd', label: ORBIT_ELEMENT_LABELS.prd.full, value: fmtTime(el.period), group: '軌道' },
    );
    return rows;
  }

  public readonly rename = null;
  public readonly onMapSelect = null;
  public readonly onMapFocus = null;
}
