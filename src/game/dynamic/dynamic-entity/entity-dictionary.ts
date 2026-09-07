// セーブの種別タグから、その1体を組み立て直す手順を引く。種別を増やしたらここへ分岐を足す
// — 足し忘れは default の never 代入がコンパイルエラーにする。
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
import type { ProteinAssetId } from '../../protein/protein-asset-loader';
import type { EffectsSystem } from '../../vfx/effects-system';
import type { Hud } from '../../hud/hud';
import type { MarkerManager } from '../../marker/marker-manager';
import type { WorldSfx } from '../../../audio/sfx/world-sfx';

// 1体ぶんの復元手順。実体化(build)は、要るアセットが揃うまで遅らせてよい。
export interface EntityRestoration {
  // 組み立てる前に揃っている必要のあるタンパク質アセット。要らなければ null。
  readonly pendingAssetId: ProteinAssetId | null;
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
  effects: EffectsSystem,
): EntityRestoration | null {
  switch (data.kind) {
    case 'player':
      return {
        pendingAssetId: null,
        build: () => new Player(hud, worldSfx, scene, effects, markerManager, { saved: data, simTime }),
      };
    case 'metal-enemy':
    case 'protein-enemy': {
      const enemyClass = findEnemyClass(data.kind);
      if (enemyClass === null) return null;
      return {
        pendingAssetId: enemyClass.pendingAssetId(data),
        build: () => new enemyClass({ saved: data, simTime }, worldSfx, effects, scene),
      };
    }
    case 'ammo':
      return { pendingAssetId: null, build: () => new AmmoPickup({ saved: data, simTime }, scene) };
    case 'rcs-fuel':
      return { pendingAssetId: null, build: () => new RcsFuelPickup({ saved: data, simTime }, scene) };
    case 'booster':
      return { pendingAssetId: null, build: () => new DetachedBooster({ saved: data, simTime }, scene) };
    case 'base':
      return {
        pendingAssetId: null,
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
