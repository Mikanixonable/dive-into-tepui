// クリエイティブモードの手動スポーン。形・色・表示設定から、自機の前方へ出す敵の生成を
// 組み立てる。アセットの取得を待つ形があるので、実体ではなく gate と build の組で表す。
import { LOCAL_FORWARD, qRotate } from '../../math/quat';
import { addScaled } from '../../math/vec3';
import { kinematicState, type KinematicState } from '../../physics/kinematic-state';
import { proteinAssetGate } from '../protein/protein-asset-loader';
import {
  generateApproachingEnemy, generateDriftingEnemy, generateProteinEnemy, proteinFormationSpawns,
} from '../stages/spawner/enemy-generator';
import { STAGE_CONTROL_ENEMY_SHAPES, type EnemySpawnShape } from './stage-controls-panel';
import type * as THREE from 'three/webgpu';
import type { WorldSfx } from '../../audio/sfx/world-sfx';
import type { Enemy } from '../dynamic/dynamic-entity/enemy';
import type { SpawnGate } from '../dynamic/entity-registry';
import type { Player } from '../player/player';
import type { ProteinDisplaySettings } from '../protein/protein-display';
import type { FlashEffects } from '../vfx/flash-effects';

// 敵1体の生成。gate が通ってから build を呼ぶ。待つものが無ければ gate は null。
export type EnemySpawn = {
  readonly gate: SpawnGate | null;
  readonly build: () => Enemy;
};

// 敵を出す、自機前方の既定距離 [m]。
const DEFAULT_SPAWN_DISTANCE = 2000;

export class ManualSpawn {
  // 自機前方の、敵を出す距離 [m]。
  public spawnDistance = DEFAULT_SPAWN_DISTANCE;
  private enemyCount = 0;
  private formationCount = 0;

  public constructor(
    private readonly worldSfx: WorldSfx,
    private readonly fx: FlashEffects,
    private readonly scene: THREE.Scene,
    // 出すタンパク質の表示設定。アセットを待っている個体は、実体化した時点の値で出る。
    public display: ProteinDisplaySettings,
  ) {}

  // shape で選んだ形の敵を1体、自機の前方へ出す生成を返す。知らない形なら null。
  public enemy(player: Player, shape: EnemySpawnShape, colorValue: string): EnemySpawn | null {
    const color = Number(colorValue);
    const state = this.frontOf(player);
    const name = `MANUAL-${++this.enemyCount}`;
    // 形ごとに生成器が違い、タンパク質はアセットが揃うのを待ってから出す。
    const shapeDefinition = STAGE_CONTROL_ENEMY_SHAPES.find(({ id }) => id === shape);
    if (shapeDefinition === undefined) return null;
    if (shapeDefinition.kind === 'drifting') {
      return {
        gate: null,
        build: () => generateDriftingEnemy(name, state, color, color, this.worldSfx, this.fx, this.scene),
      };
    }
    if (shapeDefinition.kind === 'protein') {
      return {
        gate: proteinAssetGate(shapeDefinition.assetId),
        build: () => generateProteinEnemy(
          name, state, shapeDefinition.assetId, this.display, this.worldSfx, this.fx, this.scene,
        ),
      };
    }
    return {
      gate: null,
      build: () => generateApproachingEnemy(
        name, state, color, color, shapeDefinition.typeIndex, undefined, this.worldSfx, this.fx, this.scene,
      ),
    };
  }

  // タンパク質陣形(SPEC COMBAT.md「タンパク質陣形」節)の 3 役を、自機の前方へ出す生成を返す。
  public proteinFormation(player: Player): readonly EnemySpawn[] {
    const state = this.frontOf(player);
    const name = `FORMATION-${++this.formationCount}`;
    const spawns = proteinFormationSpawns(
      name, state, player.motion.state.r, this.display, name, this.worldSfx, this.fx, this.scene,
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
