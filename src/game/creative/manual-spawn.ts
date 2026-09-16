// クリエイティブモードの手動スポーン。形・色・表示設定から、自機の前方へ出す敵の生成を
// 組み立てる。アセットの取得を待つ形があるので、実体ではなく gate と build の組で表す。
import { LOCAL_FORWARD, qRotate } from '../../math/quat';
import { addScaled } from '../../math/vec3';
import { kinematicState, type KinematicState } from '../../physics/kinematic-state';
import { isEnemy, type Enemy } from '../dynamic/dynamic-entity/enemy';
import { EntityIdAllocator, type EntityIdAllocators } from '../dynamic/dynamic-entity/entity-id';
import { proteinAssetGate } from '../protein/protein-asset-loader';
import {
  generateApproachingEnemy, generateDriftingEnemy, generateProteinEnemy, proteinFormationSpawns,
} from '../stages/spawner/enemy-generator';
import { STAGE_CONTROL_ENEMY_SHAPES, type EnemySpawnShape } from './stage-controls-panel';
import type * as THREE from 'three/webgpu';
import type { WorldSfx } from '../../audio/sfx/world-sfx';
import type { CelestialBody } from '../../physics/celestial-body';
import type { SpawnGate } from '../dynamic/entity-registry';
import type { EntityRoster } from '../dynamic/entity-roster';
import type { Player } from '../player/player';
import type { ProteinDisplaySettings } from '../../render/protein/protein-display';
import type { FlashEffects } from '../vfx/flash-effects';

// 敵1体の生成。gate が通ってから build を呼ぶ。待つものが無ければ gate は null。
export interface EnemySpawn {
  readonly gate: SpawnGate | null;
  readonly build: () => Enemy;
}

// 敵を出す、自機前方の既定距離 [m]。
const DEFAULT_SPAWN_DISTANCE = 2000;

export class ManualSpawn {
  // 自機前方の、敵を出す距離 [m]。
  public spawnDistance = DEFAULT_SPAWN_DISTANCE;
  private readonly enemyNameAllocator = new EntityIdAllocator('MANUAL-');
  private readonly formationIdAllocator = new EntityIdAllocator('FORMATION-');

  // 以後の手動スポーンが既存個体と衝突しないよう、復元済みの敵の名前と陣形 id を予約する。
  public constructor(
    private readonly worldSfx: WorldSfx,
    private readonly fx: FlashEffects,
    private readonly scene: THREE.Scene,
    private readonly attractors: readonly CelestialBody[],
    roster: EntityRoster,
    private readonly idAllocators: EntityIdAllocators,
    // 出すタンパク質の表示設定。アセットを待っている個体は、実体化した時点の値で出る。
    public display: ProteinDisplaySettings,
  ) {
    for (const enemy of roster.all().filter(isEnemy)) {
      this.enemyNameAllocator.next(enemy.name);
      if (enemy.formationId !== undefined) this.formationIdAllocator.next(enemy.formationId);
    }
  }

  // shape で選んだ形の敵を1体、自機の前方へ出す生成を返す。知らない形なら null。
  public enemy(player: Player, shape: EnemySpawnShape, colorValue: string): EnemySpawn | null {
    const color = Number(colorValue);
    const state = this.frontOf(player);
    const name = this.enemyNameAllocator.next();
    // 形ごとに生成器が違い、タンパク質はアセットが揃うのを待ってから出す。
    const shapeDefinition = STAGE_CONTROL_ENEMY_SHAPES.find(({ id }) => id === shape);
    if (shapeDefinition === undefined) return null;
    if (shapeDefinition.kind === 'drifting') {
      return {
        gate: null,
        build: () => generateDriftingEnemy(
          name, state, color, color, this.worldSfx, this.fx, this.scene, this.idAllocators,
        ),
      };
    }
    if (shapeDefinition.kind === 'protein') {
      return {
        gate: proteinAssetGate(shapeDefinition.assetId),
        build: () => generateProteinEnemy(
          name, state, shapeDefinition.assetId, this.display, this.worldSfx, this.fx, this.scene,
          this.idAllocators,
        ),
      };
    }
    return {
      gate: null,
      build: () => generateApproachingEnemy(
        name, state, this.attractors, color, color, shapeDefinition.typeIndex, undefined,
        this.worldSfx, this.fx, this.scene, this.idAllocators,
      ),
    };
  }

  // タンパク質陣形(SPEC COMBAT.md「タンパク質陣形」節)の 3 役を、自機の前方へ出す生成を返す。
  public proteinFormation(player: Player): readonly EnemySpawn[] {
    const state = this.frontOf(player);
    const formationId = this.formationIdAllocator.next();
    const spawns = proteinFormationSpawns(
      formationId, state, player.motion.state.r, this.display, formationId,
      this.worldSfx, this.fx, this.scene, this.idAllocators,
    );
    return spawns.map(({ assetId, build }) => ({ gate: proteinAssetGate(assetId), build }));
  }

  // 自機の前方 spawnDistance [m]、自機と同じ速度の状態。
  private frontOf(player: Player): KinematicState {
    const forward = qRotate(player.motion.att.q, LOCAL_FORWARD);
    const position = addScaled(player.motion.state.r, forward, this.spawnDistance);
    return kinematicState<'eci'>(player.motion.state.t, position, player.motion.state.v);
  }
}
