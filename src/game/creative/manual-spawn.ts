// クリエイティブモードの手動スポーン。形・色から、自機の前方へ出す敵を組み立てる。タンパク質の
// 敵はアセットの取得を待つ形があるので、実体ではなく要求で表す。
import { LOCAL_FORWARD, qRotate } from '../../math/quat';
import { addScaled } from '../../math/vec3';
import { kinematicState, type KinematicState } from '../../physics/kinematic-state';
import { EntityIdAllocator, type EntityIdAllocators } from '../dynamic/dynamic-entity/entity-id';
import {
  generateApproachingEnemy, generateDriftingEnemy, proteinFormationRequests,
} from '../stages/spawner/enemy-generator';
import { STAGE_CONTROL_ENEMY_SHAPES, type EnemySpawnShape } from './stage-controls-panel';
import type * as THREE from 'three/webgpu';
import type { CelestialBody } from '../../physics/celestial-body';
import type { Enemy } from '../dynamic/dynamic-entity/enemy';
import type { ProteinEnemyRequest } from '../dynamic/dynamic-entity/protein-enemy';
import type { Player } from '../player/player';

// 手動スポーンで出す敵1体。その場で組んだ敵か、アセットの取得を待つタンパク質の敵の要求。
export type ManualEnemySpawn =
  | { readonly kind: 'enemy'; readonly enemy: Enemy }
  | { readonly kind: 'protein-enemy'; readonly request: ProteinEnemyRequest };

// 敵を出す距離 [m] と、敵の名前・陣形 id の次に発番する連番。
export interface SerializedManualSpawn {
  readonly spawnDistance: number;
  readonly enemyNameAllocator: number;
  readonly formationIdAllocator: number;
}

// 敵を出す、自機前方の既定距離 [m]。
const DEFAULT_SPAWN_DISTANCE = 2000;

export class ManualSpawn {
  private readonly enemyNameAllocator: EntityIdAllocator;
  private readonly formationIdAllocator: EntityIdAllocator;

  // spawnDistance は自機前方の、敵を出す距離 [m]。enemyNameCounter・formationIdCounter は敵の名前と
  // 陣形 id の次に発番する連番で、省けば連番の初めから発番する。
  private constructor(
    private readonly scene: THREE.Scene,
    private readonly attractors: readonly CelestialBody[],
    private readonly idAllocators: EntityIdAllocators,
    public spawnDistance = DEFAULT_SPAWN_DISTANCE,
    enemyNameCounter = 0,
    formationIdCounter = 0,
  ) {
    this.enemyNameAllocator = new EntityIdAllocator('MANUAL-', enemyNameCounter);
    this.formationIdAllocator = new EntityIdAllocator('FORMATION-', formationIdCounter);
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
    const { spawnDistance, enemyNameAllocator, formationIdAllocator } = serialized;
    return new ManualSpawn(scene, attractors, idAllocators, spawnDistance, enemyNameAllocator, formationIdAllocator);
  }

  // 敵を出す距離と連番を直列化した形へ畳む。
  public serialize(): SerializedManualSpawn {
    return {
      spawnDistance: this.spawnDistance,
      enemyNameAllocator: this.enemyNameAllocator.serialize(),
      formationIdAllocator: this.formationIdAllocator.serialize(),
    };
  }

  // shape で選んだ形の敵を1体、自機の前方へ出す。知らない形なら null。
  public enemy(player: Player, shape: EnemySpawnShape, colorValue: string): ManualEnemySpawn | null {
    const color = Number(colorValue);
    const state = this.frontOf(player);
    const name = this.enemyNameAllocator.next();
    // 形ごとに生成器が違い、タンパク質はアセットが揃うのを待ってから出す。
    const shapeDefinition = STAGE_CONTROL_ENEMY_SHAPES.find(({ id }) => id === shape);
    if (shapeDefinition === undefined) return null;
    if (shapeDefinition.kind === 'protein') {
      return {
        kind: 'protein-enemy',
        request: { name, state, assetId: shapeDefinition.assetId, formationId: null, formationRole: null },
      };
    }
    const enemy = shapeDefinition.kind === 'drifting'
      ? generateDriftingEnemy(name, state, color, color, this.scene, this.idAllocators)
      : generateApproachingEnemy(
        name, state, this.attractors, color, color, shapeDefinition.typeIndex, undefined,
        this.scene, this.idAllocators,
      );
    return { kind: 'enemy', enemy };
  }

  // タンパク質陣形(SPEC COMBAT.md「タンパク質陣形」節)の 3 役を、自機の前方へ出す要求を返す。
  public proteinFormation(player: Player): readonly ProteinEnemyRequest[] {
    const formationId = this.formationIdAllocator.next();
    return proteinFormationRequests(formationId, this.frontOf(player), player.motion.state.r, formationId);
  }

  // 自機の前方 spawnDistance [m]、自機と同じ速度の状態。
  private frontOf(player: Player): KinematicState {
    const forward = qRotate(player.motion.att.q, LOCAL_FORWARD);
    const position = addScaled(player.motion.state.r, forward, this.spawnDistance);
    return kinematicState<'eci'>(player.motion.state.t, position, player.motion.state.v);
  }
}
