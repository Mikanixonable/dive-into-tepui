// 直列化された実体の種別タグから、その具象クラスの静的側を引く。基底のモジュールから具象を
// 引くと、基底 → 具象 → 基底の実行時循環になるので、辞書は具象だけを import するここに置く。
import type * as THREE from 'three/webgpu';
import { Base, type SerializedBase } from './base';
import { DetachedBooster, type SerializedDetachedBooster } from './detached-booster';
import { AmmoPickup, RcsFuelPickup, type SerializedAmmoPickup, type SerializedRcsFuelPickup } from './pickup';
import { MetalEnemy, type SerializedMetalEnemy } from './metal-enemy';
import { ProteinEnemy, type SerializedProteinEnemy } from './protein-enemy';
import { Player, type SerializedPlayer } from '../../player/player';
import type { DynamicEntity } from './dynamic-entity';
import type { EntityRegistry, SpawnGate } from '../entity-registry';

// 顔ぶれ1体分の直列化した形。kind で具象を判別する。
export type SerializedDynamicEntity =
  | SerializedPlayer
  | SerializedMetalEnemy
  | SerializedProteinEnemy
  | SerializedAmmoPickup
  | SerializedRcsFuelPickup
  | SerializedDetachedBooster
  | SerializedBase;

// 実体クラスの静的側。直列化した実体の復元はここから引く。新しく作る引数は具象の create が持つ。
export interface DynamicEntityClass {
  // 直列化した形の具象タグ。
  readonly kind: SerializedDynamicEntity['kind'];
  // 復元に外部資源の取得が要るなら、それが揃ったかを答える述語。要らなければ null。
  spawnGate(serialized: SerializedDynamicEntity): SpawnGate | null;
  // serialized を、時刻 simTime の状態として復元する。id は registry の採番器から取り直す。gate が
  // あるなら、それが通ってから呼ぶこと。
  deserialize(
    serialized: SerializedDynamicEntity, simTime: number, registry: EntityRegistry, scene: THREE.Scene,
  ): DynamicEntity;
}

const ENTITY_CLASSES: readonly DynamicEntityClass[] = [
  Player, MetalEnemy, ProteinEnemy, AmmoPickup, RcsFuelPickup, DetachedBooster, Base,
];

// 直列化された種別タグは未検証の文字列なので、知らない種別なら null を返す。
export function findEntityClass(kind: string): DynamicEntityClass | null {
  return ENTITY_CLASSES.find((c) => c.kind === kind) ?? null;
}
