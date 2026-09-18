// 直列化された実体の種別タグから、その1体を組み立て直す手順を引く。
// 敵の具象は enemy-dictionary.ts 越しにしか触らない(直接 import すると
// enemy.ts → 具象 → enemy.ts の実行時循環に落ちる)。
import * as THREE from 'three/webgpu';
import { Base, type SerializedBase } from './base';
import { DetachedBooster, type SerializedDetachedBooster } from './detached-booster';
import { AmmoPickup, RcsFuelPickup, type SerializedAmmoPickup, type SerializedRcsFuelPickup } from './pickup';
import { findEnemyClass } from './enemy-dictionary';
import { Player, type SerializedPlayer } from '../../player/player';
import type { DynamicEntity } from './dynamic-entity';
import type { SerializedMetalEnemy } from './metal-enemy';
import type { SerializedProteinEnemy } from './protein-enemy';
import type { SpawnGate } from '../entity-registry';
import type { EntityIdAllocators } from './entity-id';
import type { RunEventSink } from '../../run-events';

// 顔ぶれ1体分の直列化した形。kind で具象を判別する。
export type SerializedDynamicEntity =
  | SerializedPlayer
  | SerializedMetalEnemy
  | SerializedProteinEnemy
  | SerializedAmmoPickup
  | SerializedRcsFuelPickup
  | SerializedDetachedBooster
  | SerializedBase;

// 1体ぶんの復元手順。実体化(build)は、要る外部資源が揃うまで遅らせてよい。
export interface EntityRestoration {
  // 組み立てる前に通っている必要のある関門。待つものが無ければ null。
  readonly gate: SpawnGate | null;
  build(): DynamicEntity;
}

// 直列化された1体分から復元手順を引く。知らない種別なら null。
export function restorationFor(
  data: SerializedDynamicEntity,
  simTime: number,
  scene: THREE.Scene,
  events: RunEventSink,
  idAllocators: EntityIdAllocators,
): EntityRestoration | null {
  switch (data.kind) {
    case 'player':
      return {
        gate: null,
        build: () => Player.deserialize(data, simTime, events, idAllocators, scene),
      };
    case 'metal-enemy':
    case 'protein-enemy': {
      // 敵は具象クラスの示す関門を通ってから組む。
      const enemyClass = findEnemyClass(data.kind);
      if (enemyClass === null) return null;
      return {
        gate: enemyClass.spawnGate(data),
        build: () => enemyClass.deserialize(data, simTime, idAllocators, scene),
      };
    }
    case 'ammo':
      return { gate: null, build: () => new AmmoPickup({ saved: data, simTime }, scene, idAllocators) };
    case 'rcs-fuel':
      return { gate: null, build: () => new RcsFuelPickup({ saved: data, simTime }, scene, idAllocators) };
    case 'booster':
      return { gate: null, build: () => new DetachedBooster({ saved: data, simTime }, scene, idAllocators) };
    case 'base':
      return {
        gate: null,
        build: () => new Base({ saved: data, simTime }, scene, idAllocators),
      };
    default:
      return skipUnknownKind(data);
  }
}

// 直列化された種別タグは未検証の文字列なので、知らない種別は読み飛ばす。
function skipUnknownKind(_data: never): null {
  return null;
}
