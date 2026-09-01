import * as THREE from 'three/webgpu';
import { kinematicState } from '../../../physics/kinematic-state';
import { len, sub, v3, type Vec3 } from '../../../math/vec3';
import { buildAmmoPickup } from '../../../render/ships';
import { DynamicEntity, SMALL_DEBRIS_BCINV, SMALL_DEBRIS_SRP_COEFF, SMALL_DEBRIS_BULK_DENSITY, SMALL_DEBRIS_SPECIFIC_HEAT, SMALL_DEBRIS_RADIATING_AREA_PER_MASS, SMALL_DEBRIS_MAX_TEMP } from './dynamic-entity';
import { EntityIdAllocator } from './entity-id';
import type { DynamicEntityKind } from './entity-kind';
import { DIRECTION_GLYPH, ENTITY_GLYPH } from '../../marker/marker-identity';
import { fmtDist, fmtMarkerDist } from '../../hud/utils';
import type { GroupedMarkerItem } from '../../marker/grouped-markers';
import type { Attitude } from '../../../physics/attitude';
import type { KinematicState } from '../../../physics/kinematic-state';
import type { AmmoPickupSaveData } from '../../save/save-data';
import { MARKER_PRIORITY, type MarkerManager } from '../../marker/marker-manager';
import { MenuCommon, type MenuAction } from '../../hud/windows/menu-actions';
import { orbitRows } from '../../pickable/orbit-rows';
import type { CelestialSystem } from '../../celestial/celestial-system';
import type { MapPickKind, MapPickable } from '../../pickable/map-pickable';
import type { MapCommands } from '../../pickable/map-commands';
import type { MenuItem } from '../../hud/windows/context-menu';
import type { PropertyRow } from '../../hud/windows/property-window';
import type { MapVisibility, MapVisibilityPolicy } from '../../map/visibility-policy';
import type { Player } from '../../player/player';

const AMMO_PHYS_RADIUS = 1.3; // 物理接触用の半径 [m](見た目に近い実寸)
// 取り込み距離 [m]。ゲームプレイ上の吸収判定で、物理サイズではない。
export const AMMO_PICKUP_RADIUS = 100;

const idAllocator = new EntityIdAllocator('ammo-');

// 新規配置は state/att をそのまま使い、スナップショットからの再開は saved を simTime 付きの
// 状態として展開する。
type AmmoPickupInit =
  | { readonly state: KinematicState; readonly att?: Attitude; readonly id?: string }
  | { readonly saved: AmmoPickupSaveData; readonly simTime: number };

// 軌道上の補給(接近すると取り込んでベルトを延長できる)
export class AmmoPickup extends DynamicEntity implements MapPickable {
  public readonly mapKind: DynamicEntityKind = 'ammo';

  override readonly bcInv = SMALL_DEBRIS_BCINV;
  protected readonly srpCoeff = SMALL_DEBRIS_SRP_COEFF;
  protected readonly specificHeat = SMALL_DEBRIS_SPECIFIC_HEAT;
  protected readonly bulkDensity = SMALL_DEBRIS_BULK_DENSITY;
  protected override get radiatingAreaPerMass(): number {
    return SMALL_DEBRIS_RADIATING_AREA_PER_MASS;
  }
  protected readonly maxTemperature = SMALL_DEBRIS_MAX_TEMP;
  protected readonly predictedForGhost = true;

  // 補給メッシュを組み立て、質量と衝突半径を設定する。id 省略時はここで一意に発番する。
  public constructor(init: AmmoPickupInit, scene: THREE.Scene) {
    const { state, att, id } = 'saved' in init
      ? {
        state: kinematicState<'eci'>(init.simTime, v3(init.saved.r.x, init.saved.r.y, init.saved.r.z), v3(init.saved.v.x, init.saved.v.y, init.saved.v.z)),
        att: { q: { ...init.saved.q }, w: v3(init.saved.w.x, init.saved.w.y, init.saved.w.z), inertia: v3(1, 1, 1) } as Attitude,
        id: init.saved.id || undefined,
      }
      : { state: init.state, att: init.att, id: init.id };
    super(state, buildAmmoPickup(), scene, att, idAllocator.next(id));
    this.name = '弾薬';
    this.mass = 0; // 試験粒子。回収しに近づいた艦を押さない
    this.radius = AMMO_PHYS_RADIUS;
    this.collides = true;
    this.contactDamageWeight = 0;
  }

  // セーブデータへ変換する。
  serialize(): AmmoPickupSaveData {
    return {
      id: this.id,
      kind: 'ammo',
      r: { ...this.state.r },
      v: { ...this.state.v },
      q: { ...this.att.q },
      w: { ...this.att.w },
    };
  }

  // 画面マーカーと被選択判定が同じ個体を指すためのキー。
  private get markerKey(): string { return `ammo-${this.id}`; }

  // Targeter がクラスタ化・天体ラベル下サブ行の集合へ渡すためのマーカー情報。
  // 弾薬はターゲット化されないので役割・優先度は常に固定値。
  markerItem(viewerPos: Vec3, overviewMode: boolean): GroupedMarkerItem {
    const dist = len(sub(this.state.r, viewerPos));
    return {
      key: this.markerKey,
      cls: 'mk-ammo',
      sym: ENTITY_GLYPH.ammo,
      pos: this.state.r,
      vel: this.state.v,
      priority: MARKER_PRIORITY.AMMO,
      name: this.name,
      detail: overviewMode ? '' : fmtMarkerDist(dist),
      bearingColor: 'var(--color-primary-hover)',
      bearingSym: DIRECTION_GLYPH.bearing,
      bearingClass: 'mk-ammo mk-bearing-triangle',
      symMarkup: false,
    };
  }

  // マップ上の被選択物としての振る舞い。
  public readonly kind: MapPickKind = 'ammo';
  public readonly ownerName = null;
  public readonly mapTime = null;
  public get gone(): boolean { return !this.alive; }
  public get mapState(): KinematicState { return this.state; }
  public listPriority(): number { return 0; }

  // 表示時刻の ECI 位置。予測が届かない時刻では null。
  public mapPosAt(displayTime: number): Vec3 | null {
    return this.stateAt(displayTime)?.r ?? null;
  }

  // 弾薬カテゴリの表示トグルによる可否。
  public mapVisibility(policy: MapVisibilityPolicy): MapVisibility {
    return policy.entity(this.mapKind);
  }

  public shownOnMap(markers: MarkerManager): boolean { return markers.shows(this.markerKey); }

  // 自艦からの距離と回収圏内かどうか。自艦がいなければ空。
  public listDetail(
    _celestialSystem: CelestialSystem, activePlayer: Player | null, displayTime: number,
  ): string {
    if (activePlayer === null) return '';
    const d = len(sub(this.mapPosAt(displayTime) ?? this.state.r, activePlayer.state.r));
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
    const d = len(sub(this.mapPosAt(displayTime) ?? this.state.r, activePlayer.state.r));
    return d <= AMMO_PICKUP_RADIUS;
  }

  // 右クリックメニュー・プロパティウィンドウに出す操作項目。
  public mapMenuItems(
    commands: MapCommands, _celestialSystem: CelestialSystem, simTime: number,
  ): readonly MenuItem<MenuAction>[] {
    return [
      MenuCommon.focus(),
      ...MenuCommon.targetItems(commands, this.id, simTime),
      ...MenuCommon.duplicateItems(commands),
      { label: '削除', act: 'delete' },
      MenuCommon.cancel(),
    ];
  }

  // 選ばれた操作を実行する。自分が出していない act では何もしない。
  public runMapMenu(act: MenuAction, commands: MapCommands): void {
    if (act === 'delete') this.alive = false;
    else if (act === 'duplicate') commands.duplicate(this.mapKind, this.state);
    else if (act === 'focus') commands.focus(this.id, this.name);
    else if (act === 'target') commands.toggleNavTarget(this.id, this.name);
  }

  // プロパティウィンドウに出す行。自艦からの距離を主要行とし、軌道要素は「軌道」グループの
  // 下に畳む。viewer が null なら距離の行は落ちる。
  public mapPropertyRows(
    commands: MapCommands, celestialSystem: CelestialSystem, simTime: number,
  ): readonly PropertyRow[] {
    const viewer = commands.activePlayer;
    const rows: PropertyRow[] = [];
    if (viewer) rows.push({ key: 'dist', label: '距離', value: fmtDist(len(sub(this.state.r, viewer.state.r))) });
    rows.push(...orbitRows(this, celestialSystem, simTime));
    return rows;
  }

  public readonly mapRename = null;
}
