// ステージの初期化・毎フレーム処理・勝敗判定は stage-data.ts の StageDefinition が直接実装する。
// ここは「ステージを跨いで持ち回す必要のあるランタイム状態」だけを保持するデータの入れ物であり、
// 振る舞い(メソッド)は持たない — game.ts は getStageDefinition(stage) を直接呼ぶ。
import * as THREE from 'three/webgpu';
import * as C from './const';
import { Enemy } from './enemy/enemy';
import { Player } from './player/player';
import { AmmoResupplySystem } from './combat/ammo-resupply';
import { Hud } from '../hud/hud';
import { Sfx } from '../audio/sfx';
import { ScoreAttackTimer } from './score-attack-timer';
import { WaveManager } from './wave-manager';

// StageDefinition の init/update に渡す、Game 側の現在状態のスナップショット(毎フレーム渡す)。
// enemies は読み取り参照(要素の alive 等はミューテートしてよいが、生成累計数の表示には
// totalEnemies を使う — enemies は撃破された個体から prune されるため配列長は「残存数」)。
// 敵の追加は addEnemy(game.ts 側で Simulator への登録と軌道線の生成まで行う)を通す。
// stageState はステージを跨いで持続する可変状態への参照(StageDirector 自身)。
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
  stageState: StageDirector;
}

// ステージ専用のランタイム状態(ウェーブ生成・タイマー・進行状態)。ページ再読み込みでしか
// Game を作り直さない前提で、単純なミュータブルフィールドとして持つ。
export class StageDirector {
  // 第零ステージ専用: 制限時間内の撃墜数を競うスコアアタックのタイマー
  scoreAttackTimer = new ScoreAttackTimer(C.STAGE0_TIME_LIMIT);
  // 第零零ステージ専用: 波状攻撃のフェーズ・ウェーブ数管理
  waveManager = new WaveManager();

  constructor(readonly stage: number) {}
}
