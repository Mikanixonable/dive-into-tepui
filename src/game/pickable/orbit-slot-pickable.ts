// 軌道標識の位相点の被選択物。マップ上の ⌾ 記号と軌道物体一覧の行、右クリックの
// プロパティウィンドウの裏側を提供する。実体を持たず、位置は標識の参照軌道から時刻で引く。
import { len, sub, type Vec3 } from '../../math/vec3';
import type { KinematicState } from '../../physics/kinematic-state';
import { strongestAttractor } from '../../physics/attractor';
import { fmtDist, fmtTime } from '../../hud/utils';
import type { CelestialBodies } from '../celestial/celestial-bodies';
import type { ControlSelection } from '../control-selection';
import type { OrbitingObject } from '../dynamic/dynamic-entity/orbiting-object';
import { ORBIT_POINT_GLYPH } from '../marker/marker-identity';
import type { MarkerVisibility } from '../../marker/marker-visibility';
import type { MenuItem } from '../hud/windows/context-menu';
import { MenuCommon, type MenuAction } from '../hud/windows/menu-actions';
import type { PropertyRow } from '../../hud/windows/property-window-content';
import type { MapVisibility, MapVisibilityPolicy } from '../map/visibility-policy';
import type { OrbitSlot } from '../navigation/orbit-slot';
import type { OrbitSlotRegistry } from '../navigation/orbit-slot-registry';
import type { OrbitSlotCatalogAccess } from '../navigation/orbit-slot-family';
import { orbitSlotPeriod, orbitSlotStateAt } from '../navigation/orbit-slot-state';
import type { PlanEditor } from '../plan/plan-editor';
import type { ObjectAuthoring } from './inspected-object';
import type { ObjectPickable } from './object-pickable';
import type { PropertyWindowOpener } from './property-window-opener';

export class OrbitSlotPickable implements ObjectPickable {
  public readonly glyph = ORBIT_POINT_GLYPH.orbitSlot;
  public readonly glyphSvg = null;
  public readonly listSection = 'orbitSlot' as const;
  public readonly pickerGenre = null;
  public readonly hiddenBehindBodies = true;
  public readonly onlyInFocusedSystem = false;
  public readonly onMapFocus = null;

  public constructor(
    private readonly registry: OrbitSlotRegistry,
    public readonly slot: OrbitSlot,
    private readonly celestialBodies: CelestialBodies,
    private readonly catalog: OrbitSlotCatalogAccess | null,
    private readonly simTimeOf: () => number,
  ) {}

  public get id(): string { return this.slot.id; }
  public get name(): string { return this.slot.name; }
  // 台帳から外れた標識は消滅として扱い、開いている窓も畳まれる。
  public get gone(): boolean { return this.registry.find(this.slot.id) === null; }
  // 軌道要素の導出に使う現在状態として、位相点のいまの状態を返す。参照軌道が
  // 解けない間は null。
  public get orbitState(): KinematicState | null {
    return orbitSlotStateAt(this.slot, this.simTimeOf(), this.celestialBodies, this.catalog);
  }

  public readonly rename = (name: string): void => { this.registry.rename(this.slot.id, name); };
  public readonly onMapSelect = (windows: PropertyWindowOpener, x: number, y: number): void => {
    windows.openProperties(this, x, y);
  };

  // 表示時刻の位相点の ECI 位置。参照軌道が解けないフレームは null。
  public posAt(displayTime: number): Vec3 | null {
    return orbitSlotStateAt(this.slot, displayTime, this.celestialBodies, this.catalog)?.r ?? null;
  }
  // 記号だけで示され、視線を通せる本体を持たない。
  public hitBodyByRay(): boolean { return false; }
  public mapVisibility(policy: MapVisibilityPolicy): MapVisibility { return policy.orbitSlot(); }
  public shownOnMap(markers: MarkerVisibility): boolean { return markers.shows(this.slot.id); }

  // メニューに出す操作項目。
  public menuItems(
    _bodies: CelestialBodies, _viewer: OrbitingObject | null, navTargetId: string | null,
  ): readonly MenuItem<MenuAction>[] {
    return [
      { type: 'header', label: this.slot.name, subLabel: '軌道標識' },
      MenuCommon.target(navTargetId === this.slot.id),
      MenuCommon.focus(),
      { label: '削除', act: 'delete' },
      MenuCommon.cancel(),
    ];
  }

  // 標識固有の操作。「削除」は台帳から外す。
  public runMenu(
    act: MenuAction, _selection: ControlSelection, _authoring: ObjectAuthoring | null,
    _planEditor: PlanEditor | null,
  ): void {
    if (act === 'delete') this.registry.remove(this.slot.id);
  }

  // プロパティウィンドウに出す行。
  public propertyRows(
    bodies: CelestialBodies, viewer: OrbitingObject | null, simTime: number,
  ): readonly PropertyRow[] {
    const orbit = this.slot.orbit;
    const period = orbitSlotPeriod(this.slot, this.celestialBodies, this.catalog);
    const rows: PropertyRow[] = [
      {
        key: 'kind', label: '種別',
        value: orbit.kind === 'elements' ? '軌道要素' : '周期軌道族', presentation: 'hero',
      },
      orbit.kind === 'elements'
        ? { key: 'body', label: '基準天体', value: bodies.nameOf(orbit.bodyId) }
        : {
          key: 'system', label: '系',
          value: `${bodies.nameOf(orbit.primaryId)} - ${bodies.nameOf(orbit.secondaryId)}`,
        },
    ];
    if (period !== null) rows.push({ key: 'period', label: '周期', value: fmtTime(period) });
    const pos = this.posAt(simTime);
    if (pos !== null && viewer !== null) {
      rows.push({ key: 'dist', label: '距離', value: fmtDist(len(sub(pos, viewer.motion.state.r))) });
    }
    return rows;
  }

  // 一覧の行へ添える補助表示。基準天体と周期。
  public listDetail(bodies: CelestialBodies, _viewer: OrbitingObject | null, displayTime: number): string {
    const pos = this.posAt(displayTime);
    const center = pos === null
      ? null : strongestAttractor(pos, bodies.celestialMotions, displayTime).id;
    return center === null ? '' : bodies.nameOf(center);
  }
  public listSearchText(bodies: CelestialBodies, viewer: OrbitingObject | null, displayTime: number): string {
    return `${this.slot.name} ${this.listDetail(bodies, viewer, displayTime)}`;
  }
  public listCounted(): boolean { return false; }
  public listPriority(): number { return 0; }
}
