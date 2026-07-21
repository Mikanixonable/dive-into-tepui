// 全ステージ共通の骨格。撃破数による勝利判定(checkWin/onWin)・常時解放(isUnlocked)・
// HUD補助表示なし(hudSubStatus)を既定実装として持ち、必要なステージだけ override する。
// ステージ固有のランタイム状態(タイマー・ウェーブ管理・撃破集計・弾薬兵站など)は各派生
// クラス(stage00.ts等)や基底クラス自身がフィールドとして直接持つ — Game は STAGE_DEFINITIONS
// から得たこのインスタンス自身を activeStage として保持するだけでよい。
import * as THREE from 'three/webgpu';
import { Enemy } from '../orbit-entity/enemy';
import { Player } from '../player/player';
import { Logistics } from './stage-utils/logistics';
import { ScoreCounter as scoreCounter } from './stage-utils/score-counter';
import { EffectsSystem } from '../effects-system';
import { Hud } from '../../hud/hud';
import { Sfx } from '../../audio/sfx';
import { showResultScreen, showWinScreen } from '../result-screen';
import type { ClearCounts, UnlockManager } from '../unlock-manager';
import type { Simulator } from '../orbit-entity/simulator';

export type StageIndex = -1 | 0 | 1 | 2;

// Stage の init/update に渡す、Game 側の現在状態のスナップショット(毎フレーム渡す)。
// enemies は読み取り参照(要素の alive 等はミューテートしてよい)。
// 敵の追加は addEnemy(Simulator への登録。軌道線は Enemy 自身がコンストラクタで生成済み)を通す。
// hud/sfx/scene は含めない — Stage 自身が setup() で受け取り私有する(_hud/_sfx/_scene)ので、
// 毎フレームの ctx 越しに受け渡す必要がない。
export interface StageCtx {
  phase: string;
  player: Player;
  enemies: readonly Enemy[];
  addEnemy(enemy: Enemy): void;
  setPhase(phase: 'playing' | 'won' | 'lost' | 'timeup'): void;
  simTime: number;
}

export interface StageInitData {
  magsLeft: number;
  roundsInMag: number;
  briefingHtml: string;
}

// Ship.attacked/checkLoss(被弾・自然喪失の判定)が必要とする、Game 側の現在状態の
// スナップショット。撃破・自機喪失の集計と勝敗判定への橋渡しは activeStage.recordEnemyDeath/
// recordPlayerLost(このファイル内)に委ねる。hud/sfx は含めない — Ship 実装(Player/Enemy)も
// Stage も、それぞれ自身の _hud/_sfx を私有する。
export interface CombatCtx {
  simTime: number;
  player: Player;
  activeStage: Stage;
  setPhase(phase: 'playing' | 'won' | 'lost' | 'timeup'): void;
  fx: EffectsSystem;
  unlockManager: UnlockManager;
}

export abstract class Stage {
  abstract readonly index: StageIndex;
  abstract readonly selectLabel: string;
  abstract readonly selectSub: string;
  readonly selectLockedSub?: string;
  abstract readonly selectKeys: string[];
  abstract readonly initialAmmo: Pick<StageInitData, 'magsLeft' | 'roundsInMag'>;

  // 発射・命中・撃破の集計(全ステージ共通)。増減は ScoreCounter 自身のメソッドで行う。
  readonly scoreCounter = new scoreCounter();
  // 補給マガジンの兵站(全ステージ共通)。Game 固有のリソース(hud/sfx/scene/simulator)を
  // 必要とするため、モジュール読み込み時ではなく setup() で構築する。
  protected logistics!: Logistics;

  // setup() で受け取り私有する hud/sfx/scene(STAGE_DEFINITIONS はモジュール読み込み時に
  // 生成される静的シングルトンなので、コンストラクタ注入ができず setup() が代わりを担う
  // — これは一度きりの注入であり、毎フレームの ctx 越しの受け渡しではない)。
  // 派生クラス(stage0/1/2/00.ts)は毎フレームの init/update からこれを直接使ってよい。
  protected _hud!: Hud;
  protected _sfx!: Sfx;
  protected _scene!: THREE.Scene;

  // Game がステージ開始前に一度だけ呼ぶ(STAGE_DEFINITIONS はモジュール読み込み時に生成される
  // 静的シングルトンなので、Game 固有のリソースはコンストラクタではなくここで受け取る)。
  setup(hud: Hud, sfx: Sfx, scene: THREE.Scene, simulator: Simulator): void {
    this._hud = hud;
    this._sfx = sfx;
    this._scene = scene;
    this.logistics = new Logistics(hud, sfx, scene, simulator.ammos, (ammo) => simulator.addAmmo(ammo));
  }

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
  checkWin(): boolean {
    return this.scoreCounter.totalEnemiesSpawned - this.scoreCounter.kills - this.scoreCounter.losses <= 0;
  }
  onWin(simTime: number): void {
    showWinScreen(this._hud, this._sfx, this.scoreCounter, this.scoreCounter.totalEnemiesSpawned, simTime);
  }

  // HUDステータスパネルの補助表示(サバイバル波数・残り時間など)。既定は非表示。
  hudSubStatus(): string | null {
    return null;
  }

  // 撃破(自然喪失を含む)を集計し、勝利条件判定・解放記録への橋渡しを行う(alive 遷移・
  // 撃破エフェクトは呼び出し元の Ship.attacked/checkLoss が既に済ませている — ここでは呼ばない)。
  // byPlayer: true = 弾丸命中による正式撃破(勝利判定を行う)
  //           false = 再突入・空力分解など物理的消滅(カウントのみ、勝利判定は起動しない)
  recordEnemyDeath(enemy: Enemy, ctx: CombatCtx, byPlayer = true): void {
    if (!byPlayer) {
      this.scoreCounter.recordEnemyLoss();
      this._hud.hint(`${enemy.name} 再突入により喪失`);
      return;
    }
    this.scoreCounter.recordKill();
    this._hud.hint(`${enemy.name} 撃破`);

    if (this.checkWin()) {
      ctx.setPhase('won');
      ctx.unlockManager.reportClear(this.index, this._hud);
      this.onWin(ctx.simTime);
    }
  }

  // 自機の被弾死・自然死(checkLoss)を集計する。原因ごとに文言が異なるため reason で
  // 明示的に渡す。
  recordPlayerLost(ctx: CombatCtx, reason: string): void {
    ctx.setPhase('lost');
    showResultScreen(this._hud, this._sfx, false, `${reason}<br>撃破 ${this.scoreCounter.kills}/${this.scoreCounter.totalEnemiesSpawned} 機`);
  }
}
