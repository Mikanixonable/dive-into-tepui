import * as THREE from 'three/webgpu';
import { Attitude } from '../../physics/attitude';
import { KinematicState } from '../../physics/kinematic-state';
import * as C from '../const';
import { buildAmmo } from '../../render/ships';
import { GameEntity } from './game-entity';
import { EntityIdAllocator } from './entity-id';
import { AmmoSaveData } from '../save-data';
import { v3 } from '../../physics/vec3';
import { kinematicState } from '../../physics/kinematic-state';

const idAllocator = new EntityIdAllocator('ammo-');

// 新規配置は state/att をそのまま使い、スナップショットからの再開は saved を simTime の
// epoch で展開する。
export type AmmoInit =
  | { readonly state: KinematicState; readonly att?: Attitude; readonly id?: string }
  | { readonly saved: AmmoSaveData; readonly simTime: number };

// 軌道上の補給(接近すると取り込んでベルトを延長できる)
export class Ammo extends GameEntity {
  protected readonly bcInv = C.SMALL_DEBRIS_BCINV;
  protected readonly srpCoeff = C.SMALL_DEBRIS_SRP_COEFF;
  readonly predictsFuture = true;

  // 補給メッシュを組み立て、質量と衝突半径を設定する。id 省略時はここで一意に発番する。
  constructor(init: AmmoInit, scene?: THREE.Scene) {
    const { state, att, id } = 'saved' in init
      ? {
        state: kinematicState(init.simTime, v3(init.saved.r.x, init.saved.r.y, init.saved.r.z), v3(init.saved.v.x, init.saved.v.y, init.saved.v.z)),
        att: { q: { ...init.saved.q }, w: v3(init.saved.w.x, init.saved.w.y, init.saved.w.z), inertia: v3(1, 1, 1) } as Attitude,
        id: init.saved.id || undefined,
      }
      : { state: init.state, att: init.att, id: init.id };
    super(state, buildAmmo(), scene, att, idAllocator.next(id));
    this.mass = 50;
    this.radius = C.AMMO_PHYS_RADIUS;
    this.collides = true;
  }

  // メッシュのマテリアルも解放する。
  dispose(): void {
    super.dispose();
    this.obj.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (Array.isArray(mesh.material)) mesh.material.forEach((m) => m.dispose());
      else mesh.material.dispose();
    });
  }

  // セーブデータへ変換する。
  serialize(): AmmoSaveData {
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
