import * as THREE from 'three/webgpu';
import { kinematicState } from '../../physics/kinematic-state';
import { v3 } from '../../physics/vec3';
import * as C from '../const';
import { buildAmmoPickup } from '../../render/ships';
import { GameEntity } from './game-entity';
import { EntityIdAllocator } from './entity-id';
import { EntityMarker } from '../marker/entity-marker';
import { ENTITY_GLYPH } from '../marker/marker-glyphs';
import type { Attitude } from '../../physics/attitude';
import type { KinematicState } from '../../physics/kinematic-state';
import type { MarkerManager } from '../marker/marker-manager';
import type { AmmoPickupSaveData } from '../save-data';

const idAllocator = new EntityIdAllocator('ammo-');

// 新規配置は state/att をそのまま使い、スナップショットからの再開は saved を simTime の
// epoch で展開する。
export type AmmoPickupInit =
  | { readonly state: KinematicState; readonly att?: Attitude; readonly id?: string }
  | { readonly saved: AmmoPickupSaveData; readonly simTime: number };

// 軌道上の補給(接近すると取り込んでベルトを延長できる)
export class AmmoPickup extends GameEntity {
  protected readonly bcInv = C.SMALL_DEBRIS_BCINV;
  protected readonly srpCoeff = C.SMALL_DEBRIS_SRP_COEFF;
  protected readonly predictedForDisplay = true;

  // 補給メッシュを組み立て、質量と衝突半径を設定する。id 省略時はここで一意に発番する。
  public constructor(init: AmmoPickupInit, scene: THREE.Scene, markerManager: MarkerManager) {
    const { state, att, id } = 'saved' in init
      ? {
        state: kinematicState(init.simTime, v3(init.saved.r.x, init.saved.r.y, init.saved.r.z), v3(init.saved.v.x, init.saved.v.y, init.saved.v.z)),
        att: { q: { ...init.saved.q }, w: v3(init.saved.w.x, init.saved.w.y, init.saved.w.z), inertia: v3(1, 1, 1) } as Attitude,
        id: init.saved.id || undefined,
      }
      : { state: init.state, att: init.att, id: init.id };
    super(state, buildAmmoPickup(), scene, att, idAllocator.next(id));
    this.name = '弾薬';
    this.mass = 50;
    this.radius = C.AMMO_PHYS_RADIUS;
    this.collides = true;
    this.marker = new EntityMarker(this, markerManager, 'mk-ammo', ENTITY_GLYPH.ammo, false);
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
}
