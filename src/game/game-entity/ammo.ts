import * as THREE from 'three/webgpu';
import { Attitude } from '../../physics/attitude';
import { KinematicState } from '../../physics/kinematic-state';
import * as C from '../const';
import { buildAmmo } from '../../render/ships';
import { GameEntity } from './game-entity';
import { AmmoSaveData } from '../save-data';
import { v3 } from '../../physics/vec3';
import { kinematicState } from '../../physics/kinematic-state';

const ID_PREFIX = 'ammo-';
let _ammoIdCounter = 0;

// 復元された id がカウンタの発番済み連番を追い越していれば、以後の新規発番と衝突しないよう
// カウンタをその次まで進める。
function reserveRestoredId(id: string): void {
  if (!id.startsWith(ID_PREFIX)) return;
  const n = Number(id.slice(ID_PREFIX.length));
  if (Number.isFinite(n) && n >= _ammoIdCounter) _ammoIdCounter = n + 1;
}

// 軌道上の補給(接近すると取り込んでベルトを延長できる)
export class Ammo extends GameEntity {
  protected readonly bcInv = C.SMALL_DEBRIS_BCINV;
  protected readonly srpCoeff = C.SMALL_DEBRIS_SRP_COEFF;
  readonly predictsFuture = true;

  readonly id: string;

  // 補給メッシュを組み立て、質量と衝突半径を設定する。id 省略時はここで一意に発番し、
  // 復元 id を渡された場合はカウンタをその番号まで追い越させる — 新規発番との衝突は
  // どちらの経路から来た id かによらずこのクラス自身が防ぐ。
  constructor(state: KinematicState, att?: Attitude, scene?: THREE.Scene, id?: string) {
    super(state, buildAmmo(), scene, att);
    this.mass = 50;
    this.collideRadius = C.AMMO_PHYS_RADIUS;
    if (id !== undefined) reserveRestoredId(id);
    this.id = id ?? `${ID_PREFIX}${_ammoIdCounter++}`;
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
