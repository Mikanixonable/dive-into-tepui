// 全ステージ共通の骨格。撃破数による勝利判定(checkWin/onWin)・常時解放(isUnlocked)・
// HUD補助表示なし(hudSubStatus)を既定実装として持ち、必要なステージだけ override する。
// ステージ固有のランタイム状態(タイマー・ウェーブ管理など)は各派生クラス(stage00.ts等)が
// 自身のフィールドとして直接持つ — Game は STAGE_DEFINITIONS から得たこのインスタンス自身を
// activeStage として保持するだけでよく、状態の入れ物を別に用意する必要がない。
import * as THREE from 'three/webgpu';
import { Enemy } from '../enemy/enemy';
import { Player } from '../player/player';
import { AmmoResupplySystem } from '../combat/ammo-resupply';
import { Hud } from '../../hud/hud';
import { Sfx } from '../../audio/sfx';
import { showWinScreen } from '../result-screen';
import type { ClearCounts } from '../unlock-manager';

export type StageIndex = -1 | 0 | 1 | 2;

// StageDefinition の init/update に渡す、Game 側の現在状態のスナップショット(毎フレーム渡す)。
// enemies は読み取り参照(要素の alive 等はミューテートしてよいが、生成累計数の表示には
// totalEnemies を使う — enemies は撃破された個体から prune されるため配列長は「残存数」)。
// 敵の追加は addEnemy(game.ts 側で Simulator への登録と軌道線の生成まで行う)を通す。
export interface StageCtx {
  phase: string;
  player: Player;
  enemies: readonly Enemy[];
  totalEnemies: number;
  addEnemy(enemy: Enemy, orbitLineColor: number): void;
  scene: THREE.Scene;
  shots: number;
  hits: number;
  kills: number;
  magsLeft: number;
  roundsInMag: number;
  setPhase(phase: 'playing' | 'won' | 'lost' | 'timeup'): void;
  simTime: number;
  hud: Hud;
  sfx: Sfx;
  ammoResupply: AmmoResupplySystem;
}

export interface StageInitData {
  magsLeft: number;
  roundsInMag: number;
  briefingHtml: string;
}

// 撃破による勝利判定(checkWin/onWin)が必要とする最小の集計スナップショット。
export interface StageWinCtx {
  kills: number;
  losses: number;
  totalEnemies: number;
  shots: number;
  hits: number;
  simTime: number;
}

export abstract class StageDefinition {
  abstract readonly index: StageIndex;
  abstract readonly selectLabel: string;
  abstract readonly selectSub: string;
  readonly selectLockedSub?: string;
  abstract readonly selectKeys: string[];
  abstract readonly initialAmmo: Pick<StageInitData, 'magsLeft' | 'roundsInMag'>;

  // 省略時(既定実装)は常に解放。unlock-manager.ts が記録するクリア回数だけを条件式の引数
  // として渡す(localStorage 等の永続化には一切触れない)。
  isUnlocked(_clearCounts: ClearCounts): boolean {
    return true;
  }

  abstract briefingHtml(enemyCount: number): string;
  // ステージ開始時の処理(初期敵配置・初期補給投入)。戻り値は初期敵数(ブリーフィング表示用)。
  abstract init(ctx: StageCtx): number;
  // 毎フレームの処理(弾薬兵站・タイマー・ウェーブ生成など、このステージに必要な分だけ書く)。
  abstract update(dt: number, ctx: StageCtx): void;

  // 既定: 敵全機撃破で勝利(再突入等の自然損耗は losses を差し引くためだけに使う)。
  // 時間切れで終わるステージ(Stage0/Stage00)は false 固定・onWin no-op に override する。
  checkWin(ctx: StageWinCtx): boolean {
    return ctx.totalEnemies - ctx.kills - ctx.losses <= 0;
  }
  onWin(ctx: StageWinCtx, hud: Hud, sfx: Sfx): void {
    showWinScreen(hud, sfx, ctx);
  }

  // HUDステータスパネルの補助表示(サバイバル波数・残り時間など)。既定は非表示。
  hudSubStatus(): string | null {
    return null;
  }
}
