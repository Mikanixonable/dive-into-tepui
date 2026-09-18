// 軌道上の補給物(接近した自艦が取り込む漂流物)と、その種別ごとの具象。
import { fmtDist } from '../../../hud/utils';
import { len, sub, v3, type Vec3 } from '../../../math/vec3';
import { AmmoPickupView, RcsFuelPickupView } from '../../../render/dynamic/dynamic-entity/pickup-view';
import { MenuCommon, type MenuAction } from '../../hud/windows/menu-actions';
import { MARKER_PRIORITY } from '../../marker/marker-priority';
import { COLOR_MARKER_FUEL, DIRECTION_GLYPH, ENTITY_GLYPH } from '../../marker/marker-identity';
import { orbitRows } from '../../pickable/orbit-rows';
import { DynamicEntity, type SerializedDynamicEntityFields } from './dynamic-entity';
import type { EntityIdAllocator, EntityIdAllocators } from './entity-id';
import { PickupMotion, type PickupKind } from './pickup-motion';
import type * as THREE from 'three/webgpu';
import type { PropertyRow } from '../../../hud/windows/property-window-content';
import { deserializeAttitude, type Attitude } from '../../../physics/attitude';
import { deserializeKinematicState, type KinematicState } from '../../../physics/kinematic-state';
import type { DynamicView } from '../../../render/dynamic/dynamic-view';
import type { CelestialBodies } from '../../celestial/celestial-bodies';
import type { ControlSelection } from '../../control-selection';
import type { MenuItem } from '../../hud/windows/context-menu';
import type { GroupedMarkerItem } from '../../marker/grouped-markers';
import type { MarkerVisibility } from '../../../marker/marker-visibility';
import type { ObjectAuthoring } from '../../pickable/inspected-object';
import type { ObjectPickable } from '../../pickable/object-pickable';
import type { MapListSection, ObjectPickerGenre } from '../../pickable/pickable-listing';
import type { DynamicEntityKind } from './entity-kind';
import type { OrbitingObject } from './orbiting-object';

// 弾薬補給を取り込む、ゲームプレイ上の吸収判定の距離 [m]。
export const AMMO_PICKUP_RADIUS = 100;
// RCS 燃料補給を取り込む、ゲームプレイ上の吸収判定の距離 [m]。
export const RCS_FUEL_PICKUP_RADIUS = 100;
// 1 個の取り込みで増える RCS 燃料 [kg]。
export const RCS_FUEL_PICKUP_AMOUNT = 1000;

export interface SerializedAmmoPickup extends SerializedDynamicEntityFields {
  readonly kind: 'ammo';
}

export interface SerializedRcsFuelPickup extends SerializedDynamicEntityFields {
  readonly kind: 'rcs-fuel';
}

type SerializedPickup = SerializedAmmoPickup | SerializedRcsFuelPickup;

// 新規配置の初期状態。state/att をそのまま使い、name を省略すると種別の既定名で名乗る。
interface PickupPlacement {
  readonly state: KinematicState;
  readonly att?: Attitude;
  readonly name?: string;
}

// 軌道上の補給物に共通するもの — 配置と復元、表示名、保存、画面マーカー、被選択物としての一覧・
// メニュー・プロパティ。何を補給するか(種別の識別・既定名・見た目・字形・取り込み距離)は具象が与える。
export abstract class Pickup extends DynamicEntity implements ObjectPickable {
  public abstract override readonly mapKind: DynamicEntityKind;
  public override readonly pickable = true;

  // 画面マーカーの CSS クラス。
  protected abstract readonly markerClass: string;
  // 画面外方位マーカーの色。
  protected abstract readonly bearingColor: string;
  // 自艦がこの補給物を取り込める距離 [m]。
  protected abstract readonly pickupRadius: number;

  // 新規配置はそのまま、スナップショットからの再開は saved を simTime 付きの状態として展開する。
  // 表示名が与えられていなければ defaultName で名乗る。id は idAllocator が採る。pickupKind は
  // 接触の種別・マーカーキーの接頭辞・保存形の種別タグを兼ねる。
  protected constructor(
    init: PickupPlacement | { readonly saved: SerializedPickup; readonly simTime: number },
    view: DynamicView,
    idAllocator: EntityIdAllocator,
    defaultName: string,
    private readonly pickupKind: PickupKind,
  ) {
    // 復元と新規配置を同じ形へ均してから基底へ渡す。
    const { state, att, id, name } = 'saved' in init
      ? {
        state: deserializeKinematicState(init.saved, init.simTime),
        att: deserializeAttitude(init.saved, v3(1, 1, 1)),
        id: init.saved.id || undefined,
        name: init.saved.name || defaultName,
      }
      : { state: init.state, att: init.att, id: undefined, name: init.name ?? defaultName };
    super(() => new PickupMotion(state, att, pickupKind), view, idAllocator.next(id));
    this.setName(name);
  }

  // セーブデータへ変換する。
  public override serialize(): SerializedPickup {
    return {
      id: this.id,
      name: this.name,
      kind: this.pickupKind,
      r: { ...this.motion.state.r },
      v: { ...this.motion.state.v },
      q: { ...this.motion.att.q },
      w: { ...this.motion.att.w },
    };
  }

  // 画面マーカーと被選択判定が同じ個体を指すためのキー。
  private get markerKey(): string { return `${this.pickupKind}-${this.id}`; }

  // 画面マーカーに出すこの補給物の項目。ターゲットにならないので優先度は固定値。
  public markerItem(): GroupedMarkerItem {
    return {
      key: this.markerKey,
      kind: this.mapKind,
      cls: this.markerClass,
      sym: this.glyph,
      pos: this.motion.state.r,
      vel: this.motion.state.v,
      priority: MARKER_PRIORITY.AMMO,
      name: this.name,
      // 画面外では種別の色の三角で方位を指す。
      bearing: {
        cls: `${this.markerClass} mk-bearing-triangle`, sym: DIRECTION_GLYPH.bearing,
        color: this.bearingColor, visible: true, clustered: true,
      },
      symMarkup: false,
    };
  }

  // 被選択物(ObjectPickable)としての振る舞い。
  public get gone(): boolean { return !this.motion.alive; }
  public get orbitState(): KinematicState { return this.motion.state; }
  public abstract readonly glyph: string;
  public readonly glyphSvg = null;
  public abstract readonly listSection: MapListSection;
  public abstract readonly pickerGenre: ObjectPickerGenre;
  public readonly hiddenBehindBodies = true;
  public readonly onlyInFocusedSystem = false;
  public listPriority(): number { return 0; }

  // 表示時刻の ECI 位置。予測が届かない時刻では null。
  public posAt(displayTime: number): Vec3 | null {
    return this.motion.stateAt(displayTime)?.r ?? null;
  }

  public shownOnMap(markers: MarkerVisibility): boolean { return markers.shows(this.markerKey); }

  // 自艦からの距離と回収圏内かどうか。自艦がいなければ空。
  public listDetail(
    _celestialBodies: CelestialBodies, viewer: OrbitingObject | null, displayTime: number,
  ): string {
    if (viewer === null) return '';
    const d = len(sub(this.posAt(displayTime) ?? this.motion.state.r, viewer.motion.state.r));
    return `${fmtDist(d)}${this.listCounted(viewer, displayTime) ? ' · 回収可能' : ''}`;
  }

  // 検索が照合する文字列。行の補助表示と同じ。
  public listSearchText(
    celestialBodies: CelestialBodies, viewer: OrbitingObject | null, displayTime: number,
  ): string {
    return this.listDetail(celestialBodies, viewer, displayTime);
  }

  // 自艦が回収圏内に入っているか。
  public listCounted(viewer: OrbitingObject | null, displayTime: number): boolean {
    if (viewer === null) return false;
    const d = len(sub(this.posAt(displayTime) ?? this.motion.state.r, viewer.motion.state.r));
    return d <= this.pickupRadius;
  }

  // 右クリックメニュー・プロパティウィンドウに出す操作項目。
  public menuItems(
    _celestialBodies: CelestialBodies, _viewer: OrbitingObject | null, navTargetId: string | null,
  ): readonly MenuItem<MenuAction>[] {
    return [
      MenuCommon.focus(),
      MenuCommon.target(navTargetId === this.id),
      MenuCommon.duplicate(),
      { label: '削除', act: 'delete' },
      MenuCommon.cancel(),
    ];
  }

  // menuItems が出した操作 act を実行する。
  public runMenu(
    act: MenuAction, _controlSelection: ControlSelection, authoring: ObjectAuthoring | null,
  ): void {
    if (act === 'delete') this.motion.alive = false;
    else if (act === 'duplicate') authoring?.openObjectPlacerForDuplicate(this.mapKind, this.motion.state);
  }

  // プロパティウィンドウに出す行。viewer が null なら距離の行を省く。
  public propertyRows(
    celestialBodies: CelestialBodies, viewer: OrbitingObject | null, simTime: number,
  ): readonly PropertyRow[] {
    const rows: PropertyRow[] = [];
    if (viewer) rows.push({
      key: 'dist', label: '距離', value: fmtDist(len(sub(this.motion.state.r, viewer.motion.state.r))),
    });
    rows.push(...this.supplyRows());
    rows.push(...orbitRows(this, celestialBodies, simTime));
    return rows;
  }

  // プロパティウィンドウで距離と軌道要素のあいだに出す、補給の中身を示す行。
  protected supplyRows(): readonly PropertyRow[] {
    return [];
  }

  public readonly rename = null;
  public readonly onMapSelect = null;
  public readonly onMapFocus = null;
}

// 軌道上の弾薬補給(接近すると取り込んでベルトを延長できる)。
export class AmmoPickup extends Pickup {
  public override readonly mapKind: DynamicEntityKind = 'ammo';
  public override readonly glyph = ENTITY_GLYPH.ammo;
  public override readonly listSection: MapListSection = 'ammo';
  public override readonly pickerGenre: ObjectPickerGenre = '弾薬';
  protected override readonly markerClass = 'mk-ammo';
  protected override readonly bearingColor = 'var(--color-primary-hover)';
  protected override readonly pickupRadius = AMMO_PICKUP_RADIUS;

  // 弾薬補給の見た目・採番器・既定名で組む。
  public constructor(
    init: PickupPlacement | { readonly saved: SerializedAmmoPickup; readonly simTime: number },
    scene: THREE.Scene,
    idAllocators: EntityIdAllocators,
  ) {
    super(init, new AmmoPickupView(scene), idAllocators.ammoPickup, '弾薬', 'ammo');
  }
}

// 軌道上の RCS 燃料補給。接近すると燃料を艦のタンクへ移す。
export class RcsFuelPickup extends Pickup {
  public override readonly mapKind: DynamicEntityKind = 'fuel';
  public override readonly glyph = ENTITY_GLYPH.fuel;
  public override readonly listSection: MapListSection = 'fuel';
  public override readonly pickerGenre: ObjectPickerGenre = 'RCS燃料';
  protected override readonly markerClass = 'mk-fuel';
  protected override readonly bearingColor = COLOR_MARKER_FUEL;
  protected override readonly pickupRadius = RCS_FUEL_PICKUP_RADIUS;

  // RCS 燃料補給の見た目・採番器・既定名で組む。
  public constructor(
    init: PickupPlacement | { readonly saved: SerializedRcsFuelPickup; readonly simTime: number },
    scene: THREE.Scene,
    idAllocators: EntityIdAllocators,
  ) {
    super(init, new RcsFuelPickupView(scene), idAllocators.rcsFuelPickup, 'RCS燃料', 'rcs-fuel');
  }

  // 1 個の取り込みで増える燃料の量。
  protected override supplyRows(): readonly PropertyRow[] {
    return [{ key: 'amount', label: '補給量', value: `${RCS_FUEL_PICKUP_AMOUNT.toLocaleString()} kg` }];
  }
}

// entity を弾薬補給へ絞り込む型ガード。
export function isAmmoPickup(entity: DynamicEntity): entity is AmmoPickup {
  return entity instanceof AmmoPickup;
}

// entity を RCS 燃料補給へ絞り込む型ガード。
export function isRcsFuelPickup(entity: DynamicEntity): entity is RcsFuelPickup {
  return entity instanceof RcsFuelPickup;
}
