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

// 軌道上の補給(接近すると取り込んでベルトを延長できる)
export class Ammo extends GameEntity {
  protected readonly bcInv = C.SMALL_DEBRIS_BCINV;
  protected readonly srpCoeff = C.SMALL_DEBRIS_SRP_COEFF;
  readonly predictsFuture = true;

  // 補給メッシュを組み立て、質量と衝突半径を設定する。id 省略時はここで一意に発番する。
  constructor(state: KinematicState, att?: Attitude, scene?: THREE.Scene, id?: string) {
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

  // セーブデータから復元する。
  static restore(data: AmmoSaveData, simTime: number, scene?: THREE.Scene): Ammo {
    const state = kinematicState(simTime, v3(data.r.x, data.r.y, data.r.z), v3(data.v.x, data.v.y, data.v.z));
    const att: Attitude = { q: { ...data.q }, w: v3(data.w.x, data.w.y, data.w.z), inertia: v3(1, 1, 1) };
    const ammo = new Ammo(state, att, scene, data.id || undefined);
    return ammo;
  }
}
