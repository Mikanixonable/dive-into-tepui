// クリエイティブステージへ外から出せる命令の口と、それを列へ積む実装(R3)。
import type { CommandQueue } from '../command-queue';
import type { EnemySpawnShape } from '../creative/stage-controls-panel';
import type { DynamicEntityKind } from '../dynamic/dynamic-entity/entity-kind';
import type { KinematicState } from '../../physics/kinematic-state';
import type { ProteinDisplaySettings } from '../../render/protein/protein-display';
import type { CreativeStage } from './creative-stage';

// クリエイティブステージの状態を外から変える命令。どれも受け付けるだけで、適用は次の進行の位相。
export interface CreativeStageCommands {
  // 弾薬の自動投入の可否を切り替える。
  setResupplyEnabled(on: boolean): void;
  // RCS燃料の自動投入の可否を切り替える。
  setFuelResupplyEnabled(on: boolean): void;
  // 敵の波状攻撃の可否を切り替える。
  setWaveAttackEnabled(on: boolean): void;
  // 操作艦の弾薬チェーンへマガジンを1つ追加する。
  addMagazineToShip(): void;
  // 操作艦の RCS 燃料を満タンにする。
  refillShipRcsFuel(): void;
  // 手動スポーンが使う距離 [m] を差し替える。
  setSpawnDistance(distanceM: number): void;
  // shape で選んだ形・色の敵を1体、自機の前方へ出す。
  spawnManualEnemy(shape: EnemySpawnShape, colorValue: string): void;
  // タンパク質陣形を自機の前方へ一括で出す。
  spawnProteinFormation(): void;
  // 以後のスポーンと、出ているタンパク質の敵へ渡す表示設定を差し替える。
  setProteinDisplay(display: ProteinDisplaySettings): void;
  // 検証を通った配置の指定から物体を作り、顔ぶれへ入れる。
  placeObject(name: string, entityKind: DynamicEntityKind, state: KinematicState): void;
}

// stage への命令を queue へ積むだけの口を組む。
export function creativeStageCommands(queue: CommandQueue, stage: CreativeStage): CreativeStageCommands {
  return {
    setResupplyEnabled: (on) => queue.submit(() => stage.setResupplyEnabled(on)),
    setFuelResupplyEnabled: (on) => queue.submit(() => stage.setFuelResupplyEnabled(on)),
    setWaveAttackEnabled: (on) => queue.submit(() => stage.setWaveAttackEnabled(on)),
    addMagazineToShip: () => queue.submit(() => stage.addMagazineToShip()),
    refillShipRcsFuel: () => queue.submit(() => stage.refillShipRcsFuel()),
    setSpawnDistance: (distanceM) => queue.submit(() => stage.setSpawnDistance(distanceM)),
    spawnManualEnemy: (shape, colorValue) => queue.submit(() => stage.spawnManualEnemy(shape, colorValue)),
    spawnProteinFormation: () => queue.submit(() => stage.spawnProteinFormation()),
    setProteinDisplay: (display) => queue.submit(() => stage.setProteinDisplay(display)),
    placeObject: (name, entityKind, state) => queue.submit(() => stage.placeObject(name, entityKind, state)),
  };
}
