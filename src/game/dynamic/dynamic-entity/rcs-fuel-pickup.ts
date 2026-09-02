import * as THREE from 'three/webgpu';
import type { WorldView } from '../../world-view';
import { kinematicState } from '../../../physics/kinematic-state';
import { len, sub, v3, type Vec3 } from '../../../math/vec3';
import { buildRcsFuelPickup } from '../../../render/ships';
import { DynamicEntity, SMALL_DEBRIS_BCINV, SMALL_DEBRIS_SRP_COEFF, SMALL_DEBRIS_BULK_DENSITY, SMALL_DEBRIS_SPECIFIC_HEAT, SMALL_DEBRIS_RADIATING_AREA_PER_MASS, SMALL_DEBRIS_MAX_TEMP } from './dynamic-entity';
import { EntityIdAllocator } from './entity-id';
import type { DynamicEntityKind } from './entity-kind';
import { DIRECTION_GLYPH, ENTITY_GLYPH, COLOR_MARKER_FUEL } from '../../marker/marker-identity';
import { fmtDist, fmtMarkerDist } from '../../hud/utils';
import type { GroupedMarkerItem } from '../../marker/grouped-markers';
import type { Attitude } from '../../../physics/attitude';
import type { KinematicState } from '../../../physics/kinematic-state';
import type { RcsFuelPickupSaveData } from '../../save/save-data';
import { MARKER_PRIORITY, type MarkerManager } from '../../marker/marker-manager';
import { MenuCommon, type MenuAction } from '../../hud/windows/menu-actions';
import { orbitRows } from '../../pickable/orbit-rows';
import type { CelestialSystem } from '../../celestial/celestial-system';
import type { ObjectPickable } from '../../pickable/object-pickable';
import type { ObjectCommands } from '../../pickable/object-commands';
import type { MenuItem } from '../../hud/windows/context-menu';
import type { PropertyRow } from '../../hud/windows/property-window';
import type { MapListSection } from '../../hud/panels/physical-object-list-panel';
import type { ObjectPickerGenre } from '../../hud/object-groups';
import type { MapVisibility, MapVisibilityPolicy } from '../../map/visibility-policy';
import type { Player } from '../../player/player';

const RCS_FUEL_PHYS_RADIUS = 1.3; // 補給の物理接触用の半径 [m]
export const RCS_FUEL_PICKUP_RADIUS = 100; // 取り込み距離 [m]
export const RCS_FUEL_PICKUP_AMOUNT = 1000; // 1 個の取り込みで増える RCS 燃料 [kg]

const idAllocator = new EntityIdAllocator('rcs-fuel-');

type RcsFuelPickupInit =
  | { readonly state: KinematicState; readonly att?: Attitude; readonly id?: string }
  | { readonly saved: RcsFuelPickupSaveData; readonly simTime: number };

// 軌道上の RCS 燃料補給。接近すると燃料を艦のタンクへ移す。
export class RcsFuelPickup extends DynamicEntity implements ObjectPickable {
  public readonly mapKind: DynamicEntityKind = 'fuel';

  override readonly bcInv = SMALL_DEBRIS_BCINV;
  protected readonly srpCoeff = SMALL_DEBRIS_SRP_COEFF;
  protected readonly specificHeat = SMALL_DEBRIS_SPECIFIC_HEAT;
  protected readonly bulkDensity = SMALL_DEBRIS_BULK_DENSITY;
  protected override get radiatingAreaPerMass(): number {
    return SMALL_DEBRIS_RADIATING_AREA_PER_MASS;
  }
  protected readonly maxTemperature = SMALL_DEBRIS_MAX_TEMP;
  protected readonly predictedForGhost = true;

  public constructor(init: RcsFuelPickupInit, scene: THREE.Scene) {
    const { state, att, id } = 'saved' in init
      ? {
        state: kinematicState<'eci'>(init.simTime, v3(init.saved.r.x, init.saved.r.y, init.saved.r.z), v3(init.saved.v.x, init.saved.v.y, init.saved.v.z)),
        att: { q: { ...init.saved.q }, w: v3(init.saved.w.x, init.saved.w.y, init.saved.w.z), inertia: v3(1, 1, 1) } as Attitude,
        id: init.saved.id || undefined,
      }
      : { state: init.state, att: init.att, id: init.id };
    super(state, buildRcsFuelPickup(), scene, att, idAllocator.next(id));
    this.name = ('saved' in init && init.saved.name) ? init.saved.name : 'RCS燃料';
    this.mass = 0;
    this.radius = RCS_FUEL_PHYS_RADIUS;
    this.collides = true;
    this.contactDamageWeight = 0;
  }

  serialize(): RcsFuelPickupSaveData {
    return {
      id: this.id,
      ...(this.name !== 'RCS燃料' ? { name: this.name } : {}),
      kind: 'rcs-fuel',
      r: { ...this.state.r },
      v: { ...this.state.v },
      q: { ...this.att.q },
      w: { ...this.att.w },
    };
  }

  // 画面マーカーと被選択判定が同じ個体を指すためのキー。
  private get markerKey(): string { return `rcs-fuel-${this.id}`; }

  // 燃料補給のマーカー表示項目。viewerPos は距離ラベルを測る基準点。
  markerItem(viewerPos: Vec3, view: WorldView): GroupedMarkerItem {
    const dist = len(sub(this.state.r, viewerPos));
    return {
      key: this.markerKey,
      kind: this.mapKind,
      cls: 'mk-fuel',
      sym: ENTITY_GLYPH.fuel,
      pos: this.state.r,
      vel: this.state.v,
      priority: MARKER_PRIORITY.AMMO,
      name: this.name,
      detail: view === 'map' ? '' : fmtMarkerDist(dist),
      bearingColor: COLOR_MARKER_FUEL,
      bearingSym: DIRECTION_GLYPH.bearing,
      bearingClass: 'mk-fuel mk-bearing-triangle',
      symMarkup: false,
    };
  }

  // 被選択物(ObjectPickable)としての振る舞い。
  public get gone(): boolean { return !this.alive; }
  public get orbitState(): KinematicState { return this.state; }
  public readonly glyph = ENTITY_GLYPH.fuel;
  public readonly glyphSvg = null;
  public readonly listSection: MapListSection = 'fuel';
  public readonly pickerGenre: ObjectPickerGenre = 'RCS燃料';
  public readonly hiddenBehindBodies = true;
  public readonly onlyInFocusedSystem = false;
  public listPriority(): number { return 0; }

  // 表示時刻の ECI 位置。予測が届かない時刻では null。
  public posAt(displayTime: number): Vec3 | null {
    return this.stateAt(displayTime)?.r ?? null;
  }

  // 燃料カテゴリの表示トグルによる可否。
  public mapVisibility(policy: MapVisibilityPolicy): MapVisibility {
    return policy.entity(this.mapKind);
  }

  public shownOnMap(markers: MarkerManager): boolean { return markers.shows(this.markerKey); }

  // 自艦からの距離と回収圏内かどうか。自艦がいなければ空。
  public listDetail(
    _celestialSystem: CelestialSystem, activePlayer: Player | null, displayTime: number,
  ): string {
    if (activePlayer === null) return '';
    const d = len(sub(this.posAt(displayTime) ?? this.state.r, activePlayer.state.r));
    return `${fmtDist(d)}${this.listCounted(activePlayer, displayTime) ? ' · 回収可能' : ''}`;
  }

  // 検索が照合する文字列。行の補助表示と同じ。
  public listSearchText(
    celestialSystem: CelestialSystem, activePlayer: Player | null, displayTime: number,
  ): string {
    return this.listDetail(celestialSystem, activePlayer, displayTime);
  }

  // 自艦が回収圏内に入っているか。
  public listCounted(activePlayer: Player | null, displayTime: number): boolean {
    if (activePlayer === null) return false;
    const d = len(sub(this.posAt(displayTime) ?? this.state.r, activePlayer.state.r));
    return d <= RCS_FUEL_PICKUP_RADIUS;
  }

  // 右クリックメニュー・プロパティウィンドウに出す操作項目。
  public menuItems(
    commands: ObjectCommands, _celestialSystem: CelestialSystem, simTime: number,
  ): readonly MenuItem<MenuAction>[] {
    return [
      MenuCommon.focus(),
      ...MenuCommon.targetItems(commands, this.id, simTime),
      ...MenuCommon.duplicateItems(commands),
      { label: '削除', act: 'delete' },
      MenuCommon.cancel(),
    ];
  }

  // menuItems が出した操作を実行する。削除は自分の alive を落とし、残りは commands を通す。
  public runMenu(act: MenuAction, commands: ObjectCommands): void {
    if (act === 'delete') this.alive = false;
    else if (act === 'duplicate') commands.duplicate(this.mapKind, this.state);
    else if (act === 'focus') commands.focus(this.id, this.name);
    else if (act === 'target') commands.toggleNavTarget(this.id, this.name);
  }

  // プロパティウィンドウに出す行。自艦からの距離と補給量を主要行とし、軌道要素は「軌道」
  // グループの下に畳む。viewer が null なら距離の行は落ちる。
  public propertyRows(
    commands: ObjectCommands, celestialSystem: CelestialSystem, simTime: number,
  ): readonly PropertyRow[] {
    const viewer = commands.activePlayer;
    const rows: PropertyRow[] = [];
    if (viewer) rows.push({ key: 'dist', label: '距離', value: fmtDist(len(sub(this.state.r, viewer.state.r))) });
    rows.push({ key: 'amount', label: '補給量', value: `${RCS_FUEL_PICKUP_AMOUNT.toLocaleString()} kg` });
    rows.push(...orbitRows(this, celestialSystem, simTime));
    return rows;
  }

  public readonly rename = null;
  public readonly onMapSelect = null;
  public readonly onMapFocus = null;
}
