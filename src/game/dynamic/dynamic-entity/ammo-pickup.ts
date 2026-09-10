import type * as THREE from 'three/webgpu';
import { len, sub, v3, type Vec3 } from '../../../math/vec3';
import { DynamicEntity } from './dynamic-entity';
import { EntityIdAllocator } from './entity-id';
import type { DynamicEntityKind } from './entity-kind';
import { DIRECTION_GLYPH, ENTITY_GLYPH } from '../../marker/marker-identity';
import { fmtDist } from '../../../hud/utils';
import type { GroupedMarkerItem } from '../../marker/grouped-markers';
import type { Attitude } from '../../../physics/attitude';
import type { KinematicState } from '../../../physics/kinematic-state';
import { savedAttitude, savedKinematicState, type AmmoPickupSaveData } from '../../save/save-data';
import { MARKER_PRIORITY } from '../../marker/crowding';
import type { MarkerVisibility } from '../../marker/marker-visibility';
import { MenuCommon, type MenuAction } from '../../hud/windows/menu-actions';
import { orbitRows } from '../../pickable/orbit-rows';
import type { ObjectPickable } from '../../pickable/object-pickable';
import type { ControlSelection } from '../../control-selection';
import type { ObjectAuthoring } from '../../pickable/inspected-object';
import type { MenuItem } from '../../hud/windows/context-menu';
import type { PropertyRow } from '../../../hud/windows/property-window-content';
import type { MapListSection, ObjectPickerGenre } from '../../pickable/pickable-listing';
import type { CelestialBodies } from '../../celestial/celestial-bodies';
import type { OrbitingObject } from './orbiting-object';
import { AmmoPickupView } from './pickup-view';
import { PickupMotion } from './pickup-motion';

// 取り込み距離 [m]。ゲームプレイ上の吸収判定で、物理サイズではない。
export const AMMO_PICKUP_RADIUS = 100;

const idAllocator = new EntityIdAllocator('ammo-');

// 新規配置は state/att をそのまま使い、スナップショットからの再開は saved を simTime 付きの
// 状態として展開する。
type AmmoPickupInit =
  | { readonly state: KinematicState; readonly att?: Attitude; readonly id?: string }
  | { readonly saved: AmmoPickupSaveData; readonly simTime: number };

// 軌道上の補給(接近すると取り込んでベルトを延長できる)
export class AmmoPickup extends DynamicEntity implements ObjectPickable {
  public override readonly mapKind: DynamicEntityKind = 'ammo';
  public override readonly pickable = true;

  // 補給メッシュを組み立て、質量と衝突半径を設定する。id 省略時はここで一意に発番する。
  public constructor(init: AmmoPickupInit, scene: THREE.Scene) {
    const { state, att, id } = 'saved' in init
      ? {
        state: savedKinematicState(init.saved, init.simTime),
        att: savedAttitude(init.saved, v3(1, 1, 1)),
        id: init.saved.id || undefined,
      }
      : { state: init.state, att: init.att, id: init.id };
    super(
      state,
      new AmmoPickupView(scene),
      att,
      idAllocator.next(id),
      () => new PickupMotion(state, att, 'ammo'),
    );
    this.setName('弾薬');
  }

  // セーブデータへ変換する。
  public override serialize(): AmmoPickupSaveData {
    return {
      id: this.id,
      kind: 'ammo',
      r: { ...this.motion.state.r },
      v: { ...this.motion.state.v },
      q: { ...this.motion.att.q },
      w: { ...this.motion.att.w },
    };
  }

  // 画面マーカーと被選択判定が同じ個体を指すためのキー。
  private get markerKey(): string { return `ammo-${this.id}`; }

  // 画面マーカーに出すこの弾薬の項目。ターゲットにならないので優先度は固定値。
  markerItem(): GroupedMarkerItem {
    return {
      key: this.markerKey,
      kind: this.mapKind,
      cls: 'mk-ammo',
      sym: ENTITY_GLYPH.ammo,
      pos: this.motion.state.r,
      vel: this.motion.state.v,
      priority: MARKER_PRIORITY.AMMO,
      name: this.name,
      bearingColor: 'var(--color-primary-hover)',
      bearingSym: DIRECTION_GLYPH.bearing,
      bearingClass: 'mk-ammo mk-bearing-triangle',
      symMarkup: false,
    };
  }

  // 被選択物(ObjectPickable)としての振る舞い。
  public get gone(): boolean { return !this.motion.alive; }
  public get orbitState(): KinematicState { return this.motion.state; }
  public readonly glyph = ENTITY_GLYPH.ammo;
  public readonly glyphSvg = null;
  public readonly listSection: MapListSection = 'ammo';
  public readonly pickerGenre: ObjectPickerGenre = '弾薬';
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
    return d <= AMMO_PICKUP_RADIUS;
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

  // 削除は自分の alive を落とす。
  public runMenu(
    act: MenuAction, _controlSelection: ControlSelection, authoring: ObjectAuthoring | null,
  ): void {
    if (act === 'delete') this.motion.alive = false;
    else if (act === 'duplicate') authoring?.openObjectPlacerForDuplicate(this.mapKind, this.motion.state);
  }

  // プロパティウィンドウに出す行。自艦からの距離を主要行とし、軌道要素は「軌道」グループの
  // 下に畳む。viewer が null なら距離の行は落ちる。
  public propertyRows(
    celestialBodies: CelestialBodies, viewer: OrbitingObject | null, simTime: number,
  ): readonly PropertyRow[] {
    const rows: PropertyRow[] = [];
    if (viewer) rows.push({
      key: 'dist', label: '距離', value: fmtDist(len(sub(this.motion.state.r, viewer.motion.state.r))),
    });
    rows.push(...orbitRows(this, celestialBodies, simTime));
    return rows;
  }

  public readonly rename = null;
  public readonly onMapSelect = null;
  public readonly onMapFocus = null;
}

// この個体が弾薬補給か。顔ぶれから弾薬補給だけを絞るときに使う。
export function isAmmoPickup(entity: DynamicEntity): entity is AmmoPickup {
  return entity instanceof AmmoPickup;
}
