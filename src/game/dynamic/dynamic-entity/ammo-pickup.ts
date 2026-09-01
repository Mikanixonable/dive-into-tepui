import * as THREE from 'three/webgpu';
import { kinematicState } from '../../../physics/kinematic-state';
import { len, sub, v3, type Vec3 } from '../../../math/vec3';
import * as C from '../../const';
import { buildAmmoPickup } from '../../../render/ships';
import { DynamicEntity, SMALL_DEBRIS_BCINV, SMALL_DEBRIS_SRP_COEFF, SMALL_DEBRIS_BULK_DENSITY, SMALL_DEBRIS_SPECIFIC_HEAT, SMALL_DEBRIS_RADIATING_AREA_PER_MASS, SMALL_DEBRIS_MAX_TEMP } from './dynamic-entity';
import { EntityIdAllocator } from './entity-id';
import { DIRECTION_GLYPH, ENTITY_GLYPH } from '../../marker/marker-glyphs';
import { fmtMarkerDist } from '../../hud/utils';
import type { GroupedMarkerItem } from '../../marker/grouped-markers';
import type { Attitude } from '../../../physics/attitude';
import type { KinematicState } from '../../../physics/kinematic-state';
import type { AmmoPickupSaveData } from '../../save/save-data';

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
export class AmmoPickup extends DynamicEntity {
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

  // Targeter がクラスタ化・天体ラベル下サブ行の集合へ渡すためのマーカー情報。
  // 弾薬はターゲット化されないので役割・優先度は常に固定値。
  markerItem(viewerPos: Vec3, overviewMode: boolean): GroupedMarkerItem {
    const dist = len(sub(this.state.r, viewerPos));
    return {
      key: `ammo-${this.id}`,
      cls: 'mk-ammo',
      sym: ENTITY_GLYPH.ammo,
      pos: this.state.r,
      vel: this.state.v,
      priority: C.MARKER_PRIORITY.AMMO,
      name: this.name,
      detail: overviewMode ? '' : fmtMarkerDist(dist),
      bearingColor: 'var(--color-primary-hover)',
      bearingSym: DIRECTION_GLYPH.bearing,
      bearingClass: 'mk-ammo mk-bearing-triangle',
      symMarkup: false,
    };
  }
}
