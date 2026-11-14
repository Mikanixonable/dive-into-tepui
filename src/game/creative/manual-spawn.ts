// クリエイティブモードの手動スポーン。形・色から、自機の前方へ出す敵を組み立てる。
import { LOCAL_FORWARD, qRotate } from '../../math/quat';
import { addScaled } from '../../math/vec3';
import { kinematicState, type KinematicState } from '../../physics/kinematic-state';
import { EntityIdAllocator, type EntityIdAllocators } from '../dynamic/dynamic-entity/entity-id';
import {
  generateApproachingEnemy, generateAssemblyEnemy, generateDriftingEnemy,
} from '../stages/spawner/enemy-generator';
import { STAGE_CONTROL_ENEMY_SHAPES, type EnemySpawnShape } from './stage-controls-panel';
import type * as THREE from 'three/webgpu';
import type { CelestialBody } from '../../physics/celestial-body';
import type { Enemy } from '../dynamic/dynamic-entity/enemy';
import type { ModularShip } from '../ship/modular-ship';

// 敵を出す距離 [m] と、敵の名前の次に発番する連番。
export interface SerializedManualSpawn {
  readonly spawnDistance: number;
  readonly enemyNameAllocator: number;
}

// 敵を出す、自機前方の既定距離 [m]。
const DEFAULT_SPAWN_DISTANCE = 2000;

export class ManualSpawn {
  private readonly enemyNameAllocator: EntityIdAllocator;

  // _spawnDistance は自機前方の、敵を出す距離 [m]。enemyNameCounter は敵の名前の次に発番する
  // 連番で、省けば連番の初めから発番する。
  private constructor(
    private readonly scene: THREE.Scene,
    private readonly attractors: readonly CelestialBody[],
    private readonly idAllocators: EntityIdAllocators,
    private _spawnDistance = DEFAULT_SPAWN_DISTANCE,
    enemyNameCounter = 0,
  ) {
    this.enemyNameAllocator = new EntityIdAllocator('MANUAL-', enemyNameCounter);
  }

  // 新しいランの手動スポーンを、既定の距離と連番の初めから組む。
  public static create(
    scene: THREE.Scene, attractors: readonly CelestialBody[], idAllocators: EntityIdAllocators,
  ): ManualSpawn {
    return new ManualSpawn(scene, attractors, idAllocators);
  }

  // 直列化した距離と連番から復元する。
  public static deserialize(
    serialized: SerializedManualSpawn,
    scene: THREE.Scene, attractors: readonly CelestialBody[], idAllocators: EntityIdAllocators,
  ): ManualSpawn {
    const { spawnDistance, enemyNameAllocator } = serialized;
    return new ManualSpawn(scene, attractors, idAllocators, spawnDistance, enemyNameAllocator);
  }

  // 敵を出す距離と連番を直列化した形へ畳む。
  public serialize(): SerializedManualSpawn {
    return {
      spawnDistance: this._spawnDistance,
      enemyNameAllocator: this.enemyNameAllocator.serialize(),
    };
  }

  public get spawnDistance(): number { return this._spawnDistance; }

  // 敵を出す、自機前方の距離を distanceM [m] へ差し替える。
  public setSpawnDistance(distanceM: number): void {
    this._spawnDistance = distanceM;
  }

  // shape で選んだ形の敵を1体、自機の前方へ出す。知らない形なら null。
  public enemy(player: ModularShip, shape: EnemySpawnShape, colorValue: string): Enemy | null {
    const color = Number(colorValue);
    const state = this.frontOf(player);
    const name = this.enemyNameAllocator.next();
    // 形ごとに生成器が違う。
    const shapeDefinition = STAGE_CONTROL_ENEMY_SHAPES.find(({ id }) => id === shape);
    if (shapeDefinition === undefined) return null;
    if (shapeDefinition.kind === 'assembly') {
      // seed は出た個体の形を決めるだけなので、呼ぶたびに新しい乱数でよい。
      const seed = Math.floor(Math.random() * 2 ** 31);
      return generateAssemblyEnemy(name, state, seed, color, color, this.scene, this.idAllocators);
    }
    return shapeDefinition.kind === 'drifting'
      ? generateDriftingEnemy(name, state, color, color, this.scene, this.idAllocators)
      : generateApproachingEnemy(
        name, state, this.attractors, color, color, shapeDefinition.typeIndex, null,
        this.scene, this.idAllocators,
      );
  }

  // 自機の前方 spawnDistance [m]、自機と同じ速度の状態。
  private frontOf(player: ModularShip): KinematicState {
    const forward = qRotate(player.motion.att.q, LOCAL_FORWARD);
    const position = addScaled(player.motion.state.r, forward, this._spawnDistance);
    return kinematicState<'eci'>(player.motion.state.t, position, player.motion.state.v);
  }
}
