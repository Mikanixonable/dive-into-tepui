// 敵を組み立て型へ統一する前のセーブにいる金属の敵機(kind 'metal-enemy')を、読み込み時に
// 組み立て型の敵へ置き換える入口(SPEC/SAVE.md)。旧い直列化の形はここへ閉じ込める。
import type * as THREE from 'three/webgpu';
import { generateAssemblyShape } from '../../../physics/assembly-shape';
import { AssemblyCombatState } from '../../enemy-assembly/assembly-combat-state';
import { AssemblyEnemy, type SerializedAssemblyEnemy } from './assembly-enemy';
import type { SerializedEnemy } from './enemy';
import type { EntityRegistry } from '../entity-registry';

// 旧セーブの金属の敵機の直列化。機体の型番と部品の記録は、組み立て型へ引き継がないので型に含めない。
export interface SerializedLegacyMetalEnemy extends Omit<SerializedEnemy, 'kind'> {
  readonly kind: 'metal-enemy';
}

// 旧セーブの金属の敵機を、位置・速度・姿勢・所属・生死・射撃の途中経過を保ったまま、
// 新しい形の組み立て型の敵(耐久は満タン)へ置き換える。
export class LegacyMetalEnemy {
  public static readonly kind = 'metal-enemy';
  public static spawnGate(): null { return null; }

  public static deserialize(
    serialized: SerializedLegacyMetalEnemy, registry: EntityRegistry, scene?: THREE.Scene,
  ): AssemblyEnemy {
    const seed = Math.floor(Math.random() * 2 ** 31);
    const converted: SerializedAssemblyEnemy = {
      ...serialized,
      kind: AssemblyEnemy.kind,
      seed,
      assembly: new AssemblyCombatState(generateAssemblyShape(seed)).serialize(),
    };
    return AssemblyEnemy.deserialize(converted, registry, scene);
  }
}
