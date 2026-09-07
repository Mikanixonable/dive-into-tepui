// セーブの種別タグから、その1体を組み立て直す手順を引く。
// 敵の具象は enemy-dictionary.ts 越しにしか触らない(直接 import すると
// enemy.ts → 具象 → enemy.ts の実行時循環に落ちる)。
import * as THREE from 'three/webgpu';
import { AmmoPickup } from './ammo-pickup';
import { Base } from './base';
import { DetachedBooster } from './detached-booster';
import { RcsFuelPickup } from './rcs-fuel-pickup';
import { findEnemyClass } from './enemy-dictionary';
import { Player } from '../../player/player';
import type { DynamicEntity } from './dynamic-entity';
import type { EntitySaveDataUnion } from '../../save/save-data';
import type { SpawnGate } from '../entity-registry';
import type { FlashEffects } from '../../vfx/flash-effects';
import type { Hud } from '../../hud/hud';
import type { MarkerManager } from '../../marker/marker-manager';
import type { WorldSfx } from '../../../audio/sfx/world-sfx';

// 1体ぶんの復元手順。実体化(build)は、要る外部資源が揃うまで遅らせてよい。
export interface EntityRestoration {
  // 組み立てる前に通っている必要のある関門。待つものが無ければ null。
  readonly gate: SpawnGate | null;
  build(): DynamicEntity;
}

// セーブ1体分から復元手順を引く。知らない種別なら null。
export function restorationFor(
  data: EntitySaveDataUnion,
  simTime: number,
  scene: THREE.Scene,
  hud: Hud,
  worldSfx: WorldSfx,
  markerManager: MarkerManager,
  effects: FlashEffects,
): EntityRestoration | null {
  switch (data.kind) {
    case 'player':
      return {
        gate: null,
        build: () => new Player(hud, worldSfx, scene, effects, markerManager, { saved: data, simTime }),
      };
    case 'metal-enemy':
    case 'protein-enemy': {
      const enemyClass = findEnemyClass(data.kind);
      if (enemyClass === null) return null;
      return {
        gate: enemyClass.spawnGate(data),
        build: () => new enemyClass({ saved: data, simTime }, worldSfx, effects, scene),
      };
    }
    case 'ammo':
      return { gate: null, build: () => new AmmoPickup({ saved: data, simTime }, scene) };
    case 'rcs-fuel':
      return { gate: null, build: () => new RcsFuelPickup({ saved: data, simTime }, scene) };
    case 'booster':
      return { gate: null, build: () => new DetachedBooster({ saved: data, simTime }, scene) };
    case 'base':
      return {
        gate: null,
        build: () => new Base({ saved: data, simTime }, scene, hud, worldSfx, markerManager),
      };
    default:
      return skipUnknownKind(data);
  }
}

// セーブ由来の種別タグは未検証の文字列なので、知らない種別は読み飛ばす。
function skipUnknownKind(_data: never): null {
  return null;
}
